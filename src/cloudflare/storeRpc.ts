/**
 * Entry stores of a database object, reached from another object.
 *
 * Peer replication runs in the server object but the stores live in the
 * database objects. The existing store RPC ({@link RpcContentAddressedStore} /
 * {@link StoreRpcServer}) carries the calls: JSON for metadata, raw bytes for
 * entry payloads, over internal requests between the objects.
 */

import {
  RpcContentAddressedStore,
  SQLITE_STORE_RPC_METHODS,
  type StoreRpcClientTransport,
  type StoreRpcRequest,
} from "../core/appendonlystores/rpc/RpcContentAddressedStore";
import type { StoreKind } from "../core/appendonlystores/types";
import type { ContentAddressedStore } from "../core/types";
import { INTERNAL_ORIGIN, jsonResponse } from "./http";
import type { DurableObjectStub } from "./types";

const RPC_PATH = "/internal/store-rpc";

class DurableObjectStoreRpcTransport implements StoreRpcClientTransport {
  constructor(
    private readonly stub: DurableObjectStub,
    private readonly headers: Record<string, string>,
  ) {}

  async call(request: StoreRpcRequest): Promise<unknown> {
    const response = await this.stub.fetch(`${INTERNAL_ORIGIN}${RPC_PATH}`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? `Store RPC ${request.method} failed: HTTP ${response.status}`);
    }
    return body.result;
  }

  async sendBytes(blobId: string, bytes: Uint8Array): Promise<void> {
    const response = await this.stub.fetch(`${INTERNAL_ORIGIN}${RPC_PATH}/bytes/${encodeURIComponent(blobId)}`, {
      method: "PUT",
      headers: this.headers,
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(`Store RPC upload failed: HTTP ${response.status}`);
  }

  async receiveBytes(blobId: string): Promise<Uint8Array> {
    const response = await this.stub.fetch(`${INTERNAL_ORIGIN}${RPC_PATH}/bytes/${encodeURIComponent(blobId)}`, {
      headers: this.headers,
    });
    if (!response.ok) throw new Error(`Store RPC download failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** A store of `dbId` in the object `stub`; `headers` address and authorize the call. */
export function remoteObjectStore(
  stub: DurableObjectStub,
  headers: Record<string, string>,
  tenantId: string,
  dbId: string,
  kind: StoreKind,
): ContentAddressedStore {
  return new RpcContentAddressedStore(
    new DurableObjectStoreRpcTransport(stub, headers),
    { scope: tenantId, dbId, kind },
    SQLITE_STORE_RPC_METHODS,
  );
}

/** Payload buffers between the calls of one store RPC exchange. */
export class StoreRpcBytes {
  private readonly buffers = new Map<string, Uint8Array>();

  async take(blobId: string): Promise<Uint8Array | null> {
    const bytes = this.buffers.get(blobId) ?? null;
    this.buffers.delete(blobId);
    return bytes;
  }

  async offer(blobId: string, bytes: Uint8Array): Promise<void> {
    this.buffers.set(blobId, bytes);
  }

  /** Serve the byte routes under {@link RPC_PATH}; null for anything else. */
  async handle(path: string, request: Request): Promise<Response | null> {
    const match = /^\/internal\/store-rpc\/bytes\/([^/]+)$/.exec(path);
    if (!match) return null;
    const blobId = decodeURIComponent(match[1]);
    if (request.method === "PUT") {
      this.buffers.set(blobId, new Uint8Array(await request.arrayBuffer()));
      return jsonResponse(200, { ok: true });
    }
    const bytes = await this.take(blobId);
    return bytes
      ? new Response(bytes as unknown as BodyInit, { headers: { "content-type": "application/octet-stream" } })
      : jsonResponse(404, { error: "Unknown buffer" });
  }
}
