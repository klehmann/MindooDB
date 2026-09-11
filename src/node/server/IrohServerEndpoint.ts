import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { randomBytes } from "crypto";

import {
  listenForIrohPeers,
  type IrohRpcHandler,
} from "../../core/appendonlystores/network/IrohNetworkTransport";
import {
  MINDOODB_IROH_ALPN,
  wrapLengthPrefixedByteStream,
  type IrohByteStream,
  type IrohStreamIO,
} from "../../core/appendonlystores/network/IrohStreamIO";
import type { ServerIrohConfig } from "./types";

export interface IrohServerEndpointStatus {
  enabled: boolean;
  ticket?: string;
  endpointId?: string;
}

interface BoundIrohEndpoint {
  close(): Promise<void>;
  id(): { toString(): string };
  addr(): unknown;
}

/**
 * Optional native Iroh listen loop. `@number0/iroh` is loaded dynamically so
 * tests and HTTP-only installs do not need the N-API binary.
 */
export class IrohServerEndpoint {
  private stop: (() => Promise<void>) | null = null;
  private status: IrohServerEndpointStatus = { enabled: false };

  getStatus(): IrohServerEndpointStatus {
    return this.status;
  }

  async start(options: {
    dataDir: string;
    config: ServerIrohConfig;
    handler: IrohRpcHandler;
  }): Promise<IrohServerEndpointStatus> {
    await this.stopListening();
    if (!options.config.enabled) {
      this.status = { enabled: false };
      return this.status;
    }

    const io = await createNativeIrohStreamIO(options.dataDir, options.config);
    const abort = new AbortController();
    const listen = listenForIrohPeers(io, options.handler, { signal: abort.signal });
    this.stop = async () => {
      abort.abort();
      await io.close?.();
    };
    void listen.catch((error) => {
      console.error("[Iroh] listen loop failed:", error);
    });
    const ticket = await io.getLocalTicket();
    this.status = {
      enabled: true,
      ticket,
      endpointId: io.endpointId,
    };
    console.log(`[Iroh] Listening on ALPN ${MINDOODB_IROH_ALPN}`);
    console.log(`[Iroh] Endpoint id: ${this.status.endpointId ?? "(unknown)"}`);
    console.log(`[Iroh] Ticket: ${ticket}`);
    return this.status;
  }

  async stopListening(): Promise<void> {
    if (this.stop) {
      const stop = this.stop;
      this.stop = null;
      await stop().catch((error) => {
        console.error("[Iroh] stop failed:", error);
      });
    }
    this.status = { enabled: false };
  }
}

interface NativeIrohStreamIO extends IrohStreamIO {
  endpointId?: string;
  close?(): Promise<void>;
}

async function createNativeIrohStreamIO(
  dataDir: string,
  config: ServerIrohConfig,
): Promise<NativeIrohStreamIO> {
  let iroh: typeof import("@number0/iroh");
  try {
    iroh = await import("@number0/iroh");
  } catch (error) {
    throw new Error(
      "Iroh is enabled in config.json but @number0/iroh is missing from the server image. " +
        "Rebuild with ./serversetup.sh --update " +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const secretBytes = loadOrCreateIrohSecret(dataDir, config.secretKeyPath);
  const alpn = Array.from(Buffer.from(MINDOODB_IROH_ALPN));
  const secretKey = createSecretKey(iroh, secretBytes);
  const endpoint = (await iroh.Endpoint.bind({
    alpns: [alpn],
    secretKey,
  })) as BoundIrohEndpoint;

  const ticket = iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
  const endpointId = endpoint.id().toString();

  return {
    endpointId,
    async getLocalTicket() {
      return ticket;
    },
    async connect(peerTicket, protocolAlpn) {
      const addr = iroh.EndpointTicket.fromString(peerTicket).endpointAddr();
      const conn = await (endpoint as unknown as {
        connect(addr: unknown, alpn: number[]): Promise<IrohConnection>;
      }).connect(addr, protocolAlpn ? Array.from(Buffer.from(protocolAlpn)) : alpn);
      const bi = await conn.openBi();
      return wrapNativeBiStream(bi);
    },
    async *listen() {
      const acceptNext = (endpoint as unknown as { acceptNext(): Promise<IrohIncoming> }).acceptNext.bind(
        endpoint,
      );
      while (true) {
        const incoming = await acceptNext();
        const connecting = await incoming.accept();
        const conn = await connecting.connect();
        const bi = await conn.acceptBi();
        yield wrapNativeBiStream(bi);
      }
    },
    async close() {
      await endpoint.close();
    },
  };
}

interface IrohIncoming {
  accept(): Promise<{ connect(): Promise<IrohConnection> }>;
}

interface IrohConnection {
  openBi(): Promise<IrohBiStream>;
  acceptBi(): Promise<IrohBiStream>;
}

interface IrohBiStream {
  send: { writeAll(bytes: number[] | Uint8Array): Promise<void>; finish(): Promise<void> };
  recv: {
    readToEnd?(max: number): Promise<number[] | Uint8Array>;
    read?(max: number): Promise<number[] | Uint8Array | null>;
  };
}

function wrapNativeBiStream(bi: IrohBiStream): IrohByteStream {
  return wrapLengthPrefixedByteStream({
    async write(bytes) {
      await bi.send.writeAll(bytes);
    },
    async read(max) {
      if (typeof bi.recv.read === "function") {
        const chunk = await bi.recv.read(max);
        return chunk ? toUint8Array(chunk) : null;
      }
      const chunk = await bi.recv.readToEnd?.(max);
      return chunk ? toUint8Array(chunk) : null;
    },
    async close() {
      await bi.send.finish().catch(() => undefined);
    },
  });
}

function toUint8Array(value: number[] | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function createSecretKey(
  iroh: typeof import("@number0/iroh"),
  secretBytes: Uint8Array,
): unknown {
  const SecretKey = iroh.SecretKey as {
    fromBytes?(bytes: Uint8Array): unknown;
    fromString?(value: string): unknown;
  };
  if (typeof SecretKey?.fromBytes === "function") {
    return SecretKey.fromBytes(secretBytes);
  }
  if (typeof SecretKey?.fromString === "function") {
    return SecretKey.fromString(Buffer.from(secretBytes).toString("hex"));
  }
  throw new Error("@number0/iroh SecretKey.fromBytes is not available");
}

function loadOrCreateIrohSecret(dataDir: string, configuredPath?: string): Uint8Array {
  const filePath = configuredPath
    ? isAbsolute(configuredPath)
      ? configuredPath
      : join(dataDir, configuredPath)
    : join(dataDir, "iroh-secret.key");
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8").trim();
    const bytes = Buffer.from(raw, raw.length === 64 ? "hex" : "base64");
    if (bytes.length !== 32) {
      throw new Error(`Iroh secret key at ${filePath} must be 32 bytes`);
    }
    return new Uint8Array(bytes);
  }
  const bytes = randomBytes(32);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes.toString("hex"), { encoding: "utf-8", mode: 0o600 });
  console.log(`[Iroh] Wrote new secret key to ${filePath}`);
  return new Uint8Array(bytes);
}
