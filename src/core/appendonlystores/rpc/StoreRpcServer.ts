/**
 * Answers {@link RpcContentAddressedStore} requests against real stores, e.g.
 * SQLite stores in a React Native host app. Stores are opened on first use per
 * (scope, dbId) and kept for the life of the server.
 */
import type { StoreEntry, StoreEntryMetadata } from "../../types";
import type { ContentAddressedStore, ContentAddressedStoreFactory, CreateStoreResult } from "../types";
import { StoreKind } from "../types";
import { generateRandomUuid } from "../../utils/idGeneration";
import type { StoreRpcGetEntriesResult, StoreRpcRequest } from "./RpcContentAddressedStore";
import { concatBytes, decodeRpcValue, encodeRpcValue, splitBytes } from "./storeRpcCodec";

/** The server's side of the binary channel. */
export interface StoreRpcServerBytes {
  /** Bytes the client sent under `blobId` (removed once taken). */
  take(blobId: string): Promise<Uint8Array | null>;
  /** Makes `bytes` fetchable by the client under `blobId` (once). */
  offer(blobId: string, bytes: Uint8Array): Promise<void>;
}

export interface StoreRpcServerOptions {
  /** Store factory for a scope (e.g. one SQLite file set per Haven tenant namespace). */
  createFactory(scope: string): ContentAddressedStoreFactory;
  bytes: StoreRpcServerBytes;
}

/** Methods a client may call besides putEntries/getEntries (which need the binary channel). */
const FORWARDED_METHODS = new Set([
  "getEntryMetadata",
  "hasEntries",
  "findNewEntries",
  "findNewEntriesForDoc",
  "findEntries",
  "getAllIds",
  "planDocumentMaterialization",
  "planDocumentMaterializationBatch",
  "resolveDependencies",
  "purgeDocHistory",
  "applyWitnessReceipts",
  "planAttachmentReadByWalkingMetadata",
  "scanEntriesSince",
  "getIdBloomSummary",
  "getStoreHead",
  "deleteEntriesForAttachment",
  "deleteEntriesById",
  "clearAllLocalData",
  "awaitIndexReady",
  "getCompactionStatus",
]);

/** Scope and db id are opaque keys (hosts map them to files themselves); keep them sane. */
function isValidKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f]/.test(value);
}

export class StoreRpcServer {
  private readonly factories = new Map<string, ContentAddressedStoreFactory>();
  private readonly stores = new Map<string, CreateStoreResult>();

  constructor(private readonly options: StoreRpcServerOptions) {}

  private store(request: StoreRpcRequest): ContentAddressedStore {
    const { scope, dbId, kind, options } = request.target;
    if (!isValidKey(scope) || !isValidKey(dbId)) {
      throw new Error("Store RPC: invalid scope or database id");
    }
    if (kind !== StoreKind.docs && kind !== StoreKind.attachments) {
      throw new Error("Store RPC: invalid store kind");
    }
    const key = `${scope}\u0000${dbId}`;
    let pair = this.stores.get(key);
    if (!pair) {
      let factory = this.factories.get(scope);
      if (!factory) {
        factory = this.options.createFactory(scope);
        this.factories.set(scope, factory);
      }
      pair = factory.createStore(dbId, options);
      this.stores.set(key, pair);
    }
    return kind === StoreKind.docs ? pair.docStore : pair.attachmentStore;
  }

  /** Handles one request; the result is encoded for the transport. */
  async handle(request: StoreRpcRequest): Promise<unknown> {
    const store = this.store(request);
    const args = decodeRpcValue(request.args) as unknown[];
    if (request.method === "putEntries") {
      if (!request.blobId) {
        throw new Error("Store RPC: putEntries without payload");
      }
      const bytes = await this.options.bytes.take(request.blobId);
      if (!bytes) {
        throw new Error("Store RPC: payload not found");
      }
      const metas = args[0] as Array<{ meta: StoreEntryMetadata; length: number }>;
      const payloads = splitBytes(bytes, metas.map((item) => item.length));
      const entries: StoreEntry[] = metas.map((item, index) => ({ ...item.meta, encryptedData: payloads[index] }));
      return encodeRpcValue(await store.putEntries(entries));
    }
    if (request.method === "getEntries") {
      const entries = await store.getEntries(args[0] as string[]);
      const result: StoreRpcGetEntriesResult = { blobId: null, entries: [] };
      if (entries.length > 0) {
        result.blobId = generateRandomUuid();
        await this.options.bytes.offer(result.blobId, concatBytes(entries.map((entry) => entry.encryptedData)));
        result.entries = entries.map(({ encryptedData, ...meta }) => ({
          meta: encodeRpcValue(meta),
          length: encryptedData.byteLength,
        }));
      }
      return result;
    }
    if (!FORWARDED_METHODS.has(request.method)) {
      throw new Error(`Store RPC: unknown method ${request.method}`);
    }
    const method = (store as unknown as Record<string, unknown>)[request.method];
    if (typeof method !== "function") {
      throw new Error(`Store RPC: ${request.method} is not supported by this store`);
    }
    return encodeRpcValue(await (method as (...a: unknown[]) => Promise<unknown>).apply(store, args));
  }
}
