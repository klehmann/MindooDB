import {
  listenForIrohPeers,
  type IrohRpcHandler,
} from "../../core/appendonlystores/network/IrohNetworkTransport";
import { MINDOODB_IROH_ALPN } from "../../core/appendonlystores/network/IrohStreamIO";
import type { ServerIrohConfig } from "./types";
import { createNativeIrohStreamIO, type NativeIrohStreamIO } from "./nativeIrohStreamIO";

export interface IrohServerEndpointStatus {
  enabled: boolean;
  ticket?: string;
  endpointId?: string;
}

/**
 * Optional native Iroh listen loop. `@number0/iroh` is loaded dynamically so
 * tests and HTTP-only installs do not need the N-API binary.
 */
export class IrohServerEndpoint {
  private stop: (() => Promise<void>) | null = null;
  private io: NativeIrohStreamIO | null = null;
  private status: IrohServerEndpointStatus = { enabled: false };

  getStatus(): IrohServerEndpointStatus {
    return this.status;
  }

  /** The bound native endpoint, or `null` until listen succeeds. */
  getStreamIO(): NativeIrohStreamIO | null {
    return this.io;
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
    this.io = io;
    const abort = new AbortController();
    const listenDone = listenForIrohPeers(io, options.handler, { signal: abort.signal }).catch(
      (error) => {
        console.error("[Iroh] listen loop failed:", error);
      },
    );
    this.stop = async () => {
      abort.abort();
      this.io = null;
      await io.close?.();
      await listenDone;
    };
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
    this.io = null;
    this.status = { enabled: false };
  }
}

export type { NativeIrohStreamIO };
