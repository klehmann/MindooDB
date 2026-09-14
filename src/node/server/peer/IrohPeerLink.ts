/**
 * One QUIC connection to a trusted Iroh peer: control-plane RPCs and the
 * change feed share the handshake; each in-flight call still owns its stream.
 */

import {
  decodeIrohFrame,
  encodeIrohFrame,
  MINDOODB_IROH_ALPN,
  type IrohByteStream,
  type IrohConnectionHandle,
  type IrohRpcContext,
  type IrohRpcResponse,
  type IrohStreamIO,
} from "../../../core/appendonlystores/network/IrohStreamIO";
import { rpcCall } from "../../../core/appendonlystores/network/IrohNetworkTransport";
import { NetworkError, NetworkErrorType } from "../../../core/appendonlystores/network/types";
import { IROH_CHANGE_FEED_HEARTBEAT } from "../IrohServerRpc";
import type { SyncChangeEvent } from "../SyncEventBus";

export class IrohPeerLink {
  private connection: Promise<IrohConnectionHandle> | null = null;
  private nextId = 1;

  constructor(
    private readonly io: IrohStreamIO,
    private readonly ticket: string,
  ) {}

  private async ensureConnection(): Promise<IrohConnectionHandle> {
    if (!this.io.openConnection) {
      throw new Error("Iroh peer mesh requires IrohStreamIO.openConnection()");
    }
    if (!this.connection) {
      this.connection = this.io.openConnection(this.ticket, MINDOODB_IROH_ALPN);
    }
    return this.connection;
  }

  async rpc(method: string, args: unknown[], ctx?: IrohRpcContext): Promise<unknown> {
    const connection = await this.ensureConnection();
    const stream = await connection.openStream();
    try {
      return await rpcCall(stream, method, args, this.nextId++, ctx);
    } finally {
      await stream.close();
    }
  }

  /**
   * IO view that reuses this link's connection so
   * {@link IrohNetworkTransport} does not open a second handshake.
   */
  asStreamIO(): IrohStreamIO {
    return {
      getLocalTicket: () => this.io.getLocalTicket(),
      connect: async () => {
        const connection = await this.ensureConnection();
        return connection.openStream();
      },
      openConnection: () => this.ensureConnection(),
    };
  }

  async subscribeEvents(
    token: string,
    onEvent: (event: SyncChangeEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const connection = await this.ensureConnection();
    const stream = await connection.openStream();
    const onAbort = () => {
      void stream.close();
    };
    if (signal.aborted) {
      await stream.close();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await stream.send(
        encodeIrohFrame({
          id: this.nextId++,
          method: "peer.subscribeEvents",
          args: [token],
        }),
      );
      const ackBytes = await stream.recv();
      if (!ackBytes) {
        throw new NetworkError(NetworkErrorType.NETWORK_ERROR, "Iroh stream closed");
      }
      const ack = decodeIrohFrame(ackBytes) as IrohRpcResponse;
      if (!ack.ok) {
        throw new NetworkError(NetworkErrorType.NETWORK_ERROR, ack.error ?? "Iroh RPC failed");
      }
      while (!signal.aborted) {
        const bytes = await stream.recv();
        if (!bytes) {
          return;
        }
        const frame = decodeIrohFrame(bytes);
        if (isHeartbeat(frame) || !isPeerChangeEvent(frame)) {
          continue;
        }
        onEvent(frame);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await stream.close();
    }
  }

  async close(): Promise<void> {
    const pending = this.connection;
    this.connection = null;
    if (pending) {
      await (await pending).close();
    }
  }
}

function isHeartbeat(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: string }).type === IROH_CHANGE_FEED_HEARTBEAT.type,
  );
}

function isPeerChangeEvent(value: unknown): value is SyncChangeEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as SyncChangeEvent;
  return typeof event.tenantId === "string" && typeof event.dbId === "string";
}

export type { IrohByteStream };
