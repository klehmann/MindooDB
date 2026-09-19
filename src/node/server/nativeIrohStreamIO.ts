import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { randomBytes } from "crypto";

import {
  isBenignIrohClose,
  MINDOODB_IROH_ALPN,
  wrapLengthPrefixedByteStream,
  type IrohByteStream,
  type IrohConnectionHandle,
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
  close(errorCode: bigint, reason: number[]): void;
  /** Peer endpoint id, proven by the QUIC handshake. */
  remoteId?(): { toString(): string };
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
      "@number0/iroh is not installed. Add it with `pnpm add @number0/iroh` " +
        "(or rebuild the server image with ./serversetup.sh --update).",
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
  const connectEndpoint = (
    endpoint as unknown as { connect(addr: unknown, alpn: number[]): Promise<IrohConnection> }
  ).connect.bind(endpoint);
  const acceptNext = (
    endpoint as unknown as { acceptNext(): Promise<IrohIncoming | null> }
  ).acceptNext.bind(endpoint);

  let listenClosed = false;
  let listenWake: (() => void) | null = null;

  const openConnection = async (
    peerTicket: string,
    protocolAlpn?: string,
  ): Promise<IrohConnectionHandle> => {
    const raw = peerTicket.trim().replace(/^iroh:/, "");
    const addr = iroh.EndpointTicket.fromString(raw).endpointAddr();
    const conn = await connectEndpoint(
      addr,
      protocolAlpn ? Array.from(Buffer.from(protocolAlpn)) : alpn,
    );
    return wrapNativeConnection(conn);
  };

  return {
    endpointId,
    async getLocalTicket() {
      return iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
    },
    openConnection,
    async connect(peerTicket, protocolAlpn) {
      const connection = await openConnection(peerTicket, protocolAlpn);
      const stream = await connection.openStream();
      return {
        remoteEndpointId: stream.remoteEndpointId,
        send: (bytes) => stream.send(bytes),
        recv: () => stream.recv(),
        close: async () => {
          await stream.close();
          await connection.close();
        },
      };
    },
    listen: () =>
      acceptIncomingStreams(acceptNext, () => listenClosed, (wake) => {
        listenWake = wake;
      }),
    async close() {
      listenClosed = true;
      listenWake?.();
      listenWake = null;
      await endpoint.close();
    },
  };
}

const MAX_PENDING_INBOUND_STREAMS = 16;

function remoteEndpointIdOf(conn: IrohConnection): string | undefined {
  try {
    return conn.remoteId?.()?.toString();
  } catch {
    // Older bindings do not expose it; the listener then treats the peer as
    // unknown rather than trusted.
    return undefined;
  }
}

function wrapNativeConnection(conn: IrohConnection): IrohConnectionHandle {
  let closed = false;
  const remoteEndpointId = remoteEndpointIdOf(conn);
  return {
    async openStream() {
      if (closed) {
        throw new Error("ConnectionLost");
      }
      return wrapNativeBiStream(await conn.openBi(), remoteEndpointId);
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        conn.close(0n, []);
      } catch {
        // already closed
      }
    },
  };
}

async function* acceptIncomingStreams(
  acceptNext: () => Promise<IrohIncoming | null>,
  isClosed: () => boolean,
  setWake: (wake: (() => void) | null) => void,
): AsyncGenerator<IrohByteStream> {
  const pending: IrohByteStream[] = [];
  const wake = {
    space: null as (() => void) | null,
    notify: null as (() => void) | null,
  };
  const flushWake = (key: "space" | "notify") => {
    const fn = wake[key];
    wake[key] = null;
    fn?.();
  };
  const producers = new Set<Promise<void>>();
  // Keep JS refs so N-API Drop does not close the QUIC connection mid-accept.
  const inboundConnections = new Set<IrohConnection>();

  const pushStream = async (stream: IrohByteStream): Promise<void> => {
    while (pending.length >= MAX_PENDING_INBOUND_STREAMS && !isClosed()) {
      await new Promise<void>((resolve) => {
        wake.space = () => resolve();
      });
    }
    if (isClosed()) {
      await stream.close();
      return;
    }
    pending.push(stream);
    flushWake("notify");
  };

  const runProducer = async (conn: IrohConnection): Promise<void> => {
    const remoteEndpointId = remoteEndpointIdOf(conn);
    try {
      while (!isClosed()) {
        const bi = await conn.acceptBi();
        await pushStream(wrapNativeBiStream(bi, remoteEndpointId));
      }
    } catch (error) {
      if (!isClosed() && !isBenignIrohClose(error)) {
        console.error("[Iroh] acceptBi loop ended:", error);
      }
    }
  };

  const acceptLoop = (async () => {
    while (!isClosed()) {
      let incoming: IrohIncoming | null;
      try {
        incoming = await acceptNext();
      } catch (error) {
        if (!isClosed()) {
          console.error("[Iroh] acceptNext failed:", error);
        }
        return;
      }
      if (!incoming) {
        return;
      }
      try {
        const connecting = await incoming.accept();
        const conn = await connecting.connect();
        inboundConnections.add(conn);
        const producer = runProducer(conn);
        producers.add(producer);
        void producer.finally(() => {
          producers.delete(producer);
          inboundConnections.delete(conn);
        });
      } catch (error) {
        console.error("[Iroh] incoming connection failed:", error);
      }
    }
  })();

  void acceptLoop.finally(() => {
    flushWake("notify");
    flushWake("space");
  });

  try {
    while (!isClosed()) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          wake.notify = () => resolve();
          setWake(() => resolve());
        });
        if (isClosed() && pending.length === 0) {
          break;
        }
      }
      const next = pending.shift();
      flushWake("space");
      if (next) {
        yield next;
      }
    }
  } finally {
    flushWake("notify");
    flushWake("space");
    await acceptLoop.catch(() => undefined);
    await Promise.allSettled(producers);
  }
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

function wrapNativeBiStream(bi: IrohBiStream, remoteEndpointId?: string): IrohByteStream {
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
  }, remoteEndpointId);
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
