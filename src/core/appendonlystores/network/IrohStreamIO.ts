/**
 * Byte-stream IO used by {@link IrohNetworkTransport}.
 *
 * `react-native-iroh` implements this with `endpoint.streams` (ALPN
 * `mindoodb/sync-v5`). The Node server uses `@number0/iroh`. Tests use
 * {@link createLoopbackIrohPair}.
 */
import { normalizeIrohEndpointId } from "./irohLocator";

export const MINDOODB_IROH_ALPN = "mindoodb/sync-v5";

/**
 * One bidirectional QUIC/byte stream between two Iroh endpoints.
 * {@link IrohNetworkTransport} sends one framed RPC request and reads one
 * response on the same stream.
 */
export interface IrohByteStream {
  /**
   * Write one complete message. Native QUIC adapters should wrap this with
   * {@link wrapLengthPrefixedByteStream} so `recv` can reassemble frames.
   *
   * @param bytes Encoded frame, typically from {@link encodeIrohFrame}
   */
  send(bytes: Uint8Array): Promise<void>;
  /**
   * Read the next complete message, or `null` when the peer closed the stream.
   *
   * @returns The next frame, or `null` on clean close
   */
  recv(): Promise<Uint8Array | null>;
  /** Finish the send side and release the stream. */
  close(): Promise<void>;
  /**
   * Endpoint id of the peer on the other end, when the adapter can report it.
   *
   * On an inbound stream this is proof of identity: QUIC only completes the
   * handshake if the peer holds the secret key behind that id. Authorization
   * (is this peer a member of the tenant?) still has to be looked up
   * separately — see {@link IrohListenOptions.authorize}.
   *
   * Loopback and older adapters leave this undefined, which must be treated as
   * "unknown peer", never as "trusted".
   */
  readonly remoteEndpointId?: string;
}

/**
 * One QUIC connection that can open many bidirectional streams.
 * Native adapters implement this; WASM / React Native may omit it and keep
 * using {@link IrohStreamIO.connect} (one stream per handshake).
 */
export interface IrohConnectionHandle {
  /** Open another bi-stream on this connection. */
  openStream(): Promise<IrohByteStream>;
  /** Close the connection and every stream on it. */
  close(): Promise<void>;
}

/**
 * Local Iroh endpoint: publish a ticket, dial a peer, and optionally accept
 * inbound streams on {@link MINDOODB_IROH_ALPN}.
 */
export interface IrohStreamIO {
  /**
   * Stable 64-char lowercase hex id of the local endpoint, derived from its
   * secret key. Unlike a ticket this never goes stale: peers dial it and the
   * pkarr/DNS address lookup resolves the current relay. Adapters that cannot
   * report it (loopback) leave it undefined.
   */
  readonly endpointId?: string;
  /**
   * Return the stable local ticket (or endpoint id) other peers can dial.
   * Native bindings usually return an `endpoint…` ticket; loopback uses
   * `loopback:a` / `loopback:b`.
   */
  getLocalTicket(): Promise<string>;
  /**
   * Open an outbound stream to `peerTicket`.
   *
   * Convenience for one stream. Adapters that implement
   * {@link IrohStreamIO.openConnection} should treat this as
   * `openConnection().openStream()` and close the connection when the
   * stream closes. WASM / RN adapters that omit `openConnection` open a
   * new QUIC connection per call.
   *
   * @param peerTicket Remote Iroh ticket or loopback id
   * @param alpn Protocol, defaults to {@link MINDOODB_IROH_ALPN}
   */
  connect(peerTicket: string, alpn?: string): Promise<IrohByteStream>;
  /**
   * Open a QUIC connection that can carry many bi-streams (RPC + change
   * feed, or several in-flight RPCs). Optional — {@link IrohNetworkTransport}
   * falls back to {@link IrohStreamIO.connect} when this is missing.
   *
   * @param peerTicket Remote Iroh ticket or loopback id
   * @param alpn Protocol, defaults to {@link MINDOODB_IROH_ALPN}
   */
  openConnection?(peerTicket: string, alpn?: string): Promise<IrohConnectionHandle>;
  /**
   * Yield inbound streams. Required on the server / listener side; a
   * client-only IO may omit it. Native adapters yield every `acceptBi()`
   * on each incoming connection (one connection, many streams).
   *
   * @param alpn Protocol, defaults to {@link MINDOODB_IROH_ALPN}
   */
  listen?(alpn?: string): AsyncIterable<IrohByteStream>;
}

/**
 * Tenant / store scope sent with every Iroh RPC. HTTP puts the same values
 * in the URL (`/t/:tenantId/d/:dbId/…`).
 */
export interface IrohRpcContext {
  tenantId?: string;
  dbId?: string;
  storeKind?: string;
}

/** One JSON-RPC-style request written as a single {@link IrohByteStream} frame. */
export interface IrohRpcRequest {
  /** Correlation id; the response echoes the same value. */
  id: number;
  method: string;
  args: unknown[];
  ctx?: IrohRpcContext;
}

/** Matching response for {@link IrohRpcRequest.id}. */
export interface IrohRpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Serialize an RPC request or response to UTF-8 JSON. `Uint8Array` fields
 * become `{ $bytes: "<base64>" }` so they survive `JSON.stringify`.
 *
 * @param payload {@link IrohRpcRequest} or {@link IrohRpcResponse}
 */
export function encodeIrohFrame(payload: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(payload, replacer));
}

/** Peer closed the QUIC stream or endpoint. Not an application error. */
export function isBenignIrohClose(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ApplicationClosed|ConnectionLost|ConnectionReset/.test(message);
}

/**
 * Length-prefix a message-oriented {@link IrohByteStream} on top of a raw
 * QUIC/byte stream. Each `send` writes a big-endian uint32 length plus the
 * payload; `recv` reads that header and then exactly that many bytes.
 * Frames larger than 32 MiB are rejected. Loopback tests stay
 * message-oriented and do not use this.
 *
 * @param raw Unframed write/read/close used by `@number0/iroh` (and similar)
 * @param remoteEndpointId Peer id from the QUIC handshake, forwarded onto the
 *   wrapped stream so listeners can authorize it
 */
export function wrapLengthPrefixedByteStream(
  raw: {
    write(bytes: Uint8Array): Promise<void>;
    read(max: number): Promise<Uint8Array | null>;
    close(): Promise<void>;
  },
  remoteEndpointId?: string,
): IrohByteStream {
  let pending = new Uint8Array(0);

  const readExact = async (need: number): Promise<Uint8Array | null> => {
    while (pending.length < need) {
      const chunk = await raw.read(64 * 1024);
      if (!chunk || chunk.length === 0) {
        return null;
      }
      const next = new Uint8Array(pending.length + chunk.length);
      next.set(pending);
      next.set(chunk, pending.length);
      pending = next;
    }
    const out = pending.subarray(0, need);
    pending = pending.subarray(need);
    return out;
  };

  return {
    remoteEndpointId,
    async send(bytes: Uint8Array) {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, bytes.length);
      const framed = new Uint8Array(4 + bytes.length);
      framed.set(header);
      framed.set(bytes, 4);
      await raw.write(framed);
    },
    async recv() {
      const header = await readExact(4);
      if (!header) {
        return null;
      }
      const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
      if (length > 32 * 1024 * 1024) {
        throw new Error(`Iroh frame too large: ${length}`);
      }
      return readExact(length);
    },
    close: () => raw.close(),
  };
}

/**
 * Inverse of {@link encodeIrohFrame}: parse UTF-8 JSON and restore
 * `{ $bytes }` objects to `Uint8Array`.
 *
 * @param bytes One complete frame from {@link IrohByteStream.recv}
 */
export function decodeIrohFrame(bytes: Uint8Array): unknown {
  return JSON.parse(textDecoder.decode(bytes), reviver);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: bytesToBase64(value) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$bytes" in (value as Record<string, unknown>)) {
    return base64ToBytes(String((value as { $bytes: string }).$bytes));
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

class LoopbackStream implements IrohByteStream {
  private readonly inbound: Uint8Array[] = [];
  private waiter: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;
  peer: LoopbackStream | null = null;

  constructor(readonly remoteEndpointId?: string) {}

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.peer || this.peer.closed) {
      throw new Error('ConnectionLost(ApplicationClosed)');
    }
    this.peer.push(bytes);
  }

  push(bytes: Uint8Array): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(bytes);
      return;
    }
    this.inbound.push(bytes);
  }

  async recv(): Promise<Uint8Array | null> {
    if (this.inbound.length > 0) {
      return this.inbound.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
    const peer = this.peer;
    if (peer && !peer.closed) {
      await peer.close();
    }
  }
}

/**
 * Two {@link IrohStreamIO} instances that dial each other in-process
 * (`loopback:a` ↔ `loopback:b`). Used by unit tests and the Expo two-peer
 * spike without native Iroh. Streams are already message-oriented; do not
 * wrap them with {@link wrapLengthPrefixedByteStream}.
 *
 * Each side also reports a synthetic {@link IrohStreamIO.endpointId} and stamps
 * inbound streams with the dialer's id, so listener authorization can be tested
 * without native Iroh. `connect` accepts either the peer's loopback ticket or
 * its endpoint id, mirroring the real adapters.
 *
 * @returns Pair whose `connect` only accepts the other side's locator
 */
export function createLoopbackIrohPair(options?: {
  endpointIdA?: string;
  endpointIdB?: string;
}): { a: IrohStreamIO; b: IrohStreamIO } {
  const listenersA: Array<(stream: IrohByteStream) => void> = [];
  const listenersB: Array<(stream: IrohByteStream) => void> = [];
  const endpointIdA = options?.endpointIdA ?? "a".repeat(64);
  const endpointIdB = options?.endpointIdB ?? "b".repeat(64);

  const makeIo = (
    ticket: string,
    peerTicket: string,
    endpointId: string,
    peerEndpointId: string,
    localListeners: Array<(stream: IrohByteStream) => void>,
    remoteListeners: Array<(stream: IrohByteStream) => void>,
  ): IrohStreamIO => ({
    endpointId,
    async getLocalTicket() {
      return ticket;
    },
    async openConnection(target) {
      const normalized = normalizeIrohEndpointId(target);
      if (target !== peerTicket && normalized !== peerEndpointId) {
        throw new Error(`Unknown loopback peer ${target}`);
      }
      return {
        async openStream() {
          // The dialer sees the listener's id and vice versa.
          const local = new LoopbackStream(peerEndpointId);
          const remote = new LoopbackStream(endpointId);
          local.peer = remote;
          remote.peer = local;
          for (const listener of remoteListeners) {
            listener(remote);
          }
          return local;
        },
        async close() {
          // Streams close independently; loopback has no shared socket.
        },
      };
    },
    async connect(target) {
      const connection = await this.openConnection!(target);
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
    async *listen() {
      const pending: IrohByteStream[] = [];
      let notify: (() => void) | null = null;
      localListeners.push((stream) => {
        pending.push(stream);
        notify?.();
      });
      while (true) {
        if (pending.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        const next = pending.shift();
        if (next) {
          yield next;
        }
      }
    },
  });

  return {
    a: makeIo("loopback:a", "loopback:b", endpointIdA, endpointIdB, listenersA, listenersB),
    b: makeIo("loopback:b", "loopback:a", endpointIdB, endpointIdA, listenersB, listenersA),
  };
}
