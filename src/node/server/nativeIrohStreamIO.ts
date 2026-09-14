import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { randomBytes } from "crypto";

import {
  isBenignIrohClose,
  MINDOODB_IROH_ALPN,
  wrapLengthPrefixedByteStream,
  type IrohByteStream,
  type IrohStreamIO,
} from "../../core/appendonlystores/network/IrohStreamIO";
import type { ServerIrohConfig } from "./types";

export interface NativeIrohStreamIO extends IrohStreamIO {
  endpointId?: string;
  close?(): Promise<void>;
}

interface BoundIrohEndpoint {
  close(): Promise<void>;
  id(): { toString(): string };
  addr(): unknown;
  online?(): Promise<void>;
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

export async function tryImportNumber0Iroh(): Promise<typeof import("@number0/iroh") | null> {
  try {
    return await import("@number0/iroh");
  } catch {
    return null;
  }
}

/**
 * Bind a native `@number0/iroh` endpoint. Waits until the endpoint is online
 * (home relay) before advertising a ticket so browser/WASM peers can dial.
 */
export async function createNativeIrohStreamIO(
  dataDir: string,
  config: ServerIrohConfig,
): Promise<NativeIrohStreamIO> {
  const iroh = await tryImportNumber0Iroh();
  if (!iroh) {
    throw new Error(
      "Iroh is enabled in config.json but @number0/iroh is missing from the server image. " +
        "Rebuild with ./serversetup.sh --update.",
    );
  }

  const secretBytes = loadOrCreateIrohSecret(dataDir, config.secretKeyPath);
  const alpn = Array.from(Buffer.from(MINDOODB_IROH_ALPN));
  const endpoint = (await iroh.Endpoint.bind({
    alpns: [alpn],
    secretKey: Array.from(secretBytes),
  })) as BoundIrohEndpoint;

  await waitUntilOnline(endpoint);

  const endpointId = endpoint.id().toString();

  return {
    endpointId,
    async getLocalTicket() {
      return iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
    },
    async connect(peerTicket, protocolAlpn) {
      const raw = peerTicket.trim().replace(/^iroh:/, "");
      const addr = iroh.EndpointTicket.fromString(raw).endpointAddr();
      const conn = await (endpoint as unknown as {
        connect(addr: unknown, alpn: number[]): Promise<IrohConnection>;
      }).connect(addr, protocolAlpn ? Array.from(Buffer.from(protocolAlpn)) : alpn);
      const bi = await conn.openBi();
      return wrapNativeBiStream(bi);
    },
    async *listen() {
      const acceptNext = (
        endpoint as unknown as { acceptNext(): Promise<IrohIncoming | null> }
      ).acceptNext.bind(endpoint);
      while (true) {
        let incoming: IrohIncoming | null;
        try {
          incoming = await acceptNext();
        } catch (error) {
          console.error("[Iroh] acceptNext failed:", error);
          return;
        }
        if (!incoming) {
          return;
        }
        try {
          const connecting = await incoming.accept();
          const conn = await connecting.connect();
          // One bi-stream per incoming connection. A second openBi() on the
          // same connection is never accepted — clients must connect() again
          // for the change-feed stream.
          const bi = await conn.acceptBi();
          yield wrapNativeBiStream(bi);
        } catch (error) {
          console.error("[Iroh] incoming connection failed:", error);
        }
      }
    },
    async close() {
      await endpoint.close();
    },
  };
}

async function waitUntilOnline(endpoint: BoundIrohEndpoint, timeoutMs = 30_000): Promise<void> {
  if (typeof endpoint.online !== "function") {
    return;
  }
  await Promise.race([
    endpoint.online(),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Iroh endpoint did not come online (no home relay)")), timeoutMs);
    }),
  ]);
}

function wrapNativeBiStream(bi: IrohBiStream): IrohByteStream {
  return wrapLengthPrefixedByteStream({
    async write(bytes) {
      // @number0/iroh N-API rejects Uint8Array (`Failed to get Array length`).
      await bi.send.writeAll(Array.from(bytes));
    },
    async read(max) {
      try {
        if (typeof bi.recv.read === "function") {
          const chunk = await bi.recv.read(max);
          return chunk && chunk.length > 0 ? toUint8Array(chunk) : null;
        }
        const chunk = await bi.recv.readToEnd?.(max);
        return chunk && chunk.length > 0 ? toUint8Array(chunk) : null;
      } catch (error) {
        if (isBenignIrohClose(error)) {
          return null;
        }
        throw error;
      }
    },
    async close() {
      await bi.send.finish().catch(() => undefined);
    },
  });
}

function toUint8Array(value: number[] | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
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
