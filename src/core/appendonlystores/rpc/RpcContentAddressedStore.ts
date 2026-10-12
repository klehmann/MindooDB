/**
 * A {@link ContentAddressedStore} whose data lives somewhere else, reached by
 * request/response messages: e.g. Haven's WebView talking to a SQLite store
 * in the React Native host app. {@link StoreRpcServer} answers on the other
 * side and keeps the real stores.
 *
 * Metadata and arguments travel as JSON ({@link encodeRpcValue}); entry
 * payloads travel as one raw byte buffer per batch over the transport's
 * binary channel, so large attachments are not base64-encoded.
 */
import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../../types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  AwaitIndexReadyOptions,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
  OpenStoreOptions,
  PutEntriesAck,
  StoreCompactionStatus,
  StoreHead,
  StoreIdBloomSummary,
  StoreIndexBuildStatus,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
} from "../types";
import { StoreKind } from "../types";
import { generateRandomUuid } from "../../utils/idGeneration";
import { concatBytes, decodeRpcValue, encodeRpcValue, splitBytes } from "./storeRpcCodec";

/** Which store a request is about. The server opens it on first use. */
export interface StoreRpcTarget {
  /** Groups stores like a factory instance does (e.g. one per Haven tenant namespace). */
  scope: string;
  dbId: string;
  kind: StoreKind;
  options?: OpenStoreOptions;
}

export interface StoreRpcRequest {
  target: StoreRpcTarget;
  method: string;
  /** Arguments, encoded with {@link encodeRpcValue}. */
  args: unknown[];
  /** putEntries: id of the payload buffer already sent with `sendBytes`. */
  blobId?: string;
}

/** Response of `getEntries`: metadata here, payloads in one buffer to fetch. */
export interface StoreRpcGetEntriesResult {
  blobId: string | null;
  entries: Array<{ meta: unknown; length: number }>;
}

/** The client's way to reach the server. */
export interface StoreRpcClientTransport {
  /** Sends a request and resolves with the server's (encoded) result. */
  call(request: StoreRpcRequest): Promise<unknown>;
  /** Hands `bytes` to the server side under `blobId` (before the call that uses them). */
  sendBytes(blobId: string, bytes: Uint8Array): Promise<void>;
  /** Fetches a buffer the server offered under `blobId` (once). */
  receiveBytes(blobId: string): Promise<Uint8Array>;
}

/** Optional {@link ContentAddressedStore} methods the server's stores implement. */
export type StoreRpcOptionalMethod =
  | "applyWitnessReceipts"
  | "planAttachmentReadByWalkingMetadata"
  | "scanEntriesSince"
  | "getIdBloomSummary"
  | "getStoreHead"
  | "deleteEntriesForAttachment"
  | "deleteEntriesById"
  | "clearAllLocalData"
  | "awaitIndexReady"
  | "getCompactionStatus";

/** What {@link SqliteContentAddressedStore} implements. */
export const SQLITE_STORE_RPC_METHODS: StoreRpcOptionalMethod[] = [
  "applyWitnessReceipts",
  "planAttachmentReadByWalkingMetadata",
  "scanEntriesSince",
  "getIdBloomSummary",
  "getStoreHead",
  "deleteEntriesById",
  "clearAllLocalData",
  "awaitIndexReady",
];

export interface RpcContentAddressedStoreFactoryOptions {
  scope: string;
  /** Optional methods to expose; defaults to {@link SQLITE_STORE_RPC_METHODS}. */
  optionalMethods?: StoreRpcOptionalMethod[];
}

type Callable = (...args: unknown[]) => Promise<unknown>;

export class RpcContentAddressedStore implements ContentAddressedStore {
  private indexStatus: StoreIndexBuildStatus = { phase: "ready", indexingEnabled: true, progress01: 1 };

  applyWitnessReceipts?: (receipts: StoreEntryMetadata[]) => Promise<void>;
  planAttachmentReadByWalkingMetadata?: (
    lastChunkId: string,
    attachmentSize: number,
    options: AttachmentReadPlanOptions,
  ) => Promise<AttachmentReadPlan>;
  scanEntriesSince?: (
    cursor: StoreScanCursor | null,
    limit?: number,
    filters?: StoreScanFilters,
  ) => Promise<StoreScanResult>;
  getIdBloomSummary?: () => Promise<StoreIdBloomSummary>;
  getStoreHead?: () => Promise<StoreHead>;
  deleteEntriesForAttachment?: (docId: string, attachmentId: string) => Promise<number>;
  deleteEntriesById?: (entryIds: string[]) => Promise<number>;
  clearAllLocalData?: () => Promise<void>;
  awaitIndexReady?: (options?: AwaitIndexReadyOptions) => Promise<StoreIndexBuildStatus>;
  getCompactionStatus?: () => Promise<StoreCompactionStatus>;

  constructor(
    private readonly transport: StoreRpcClientTransport,
    private readonly target: StoreRpcTarget,
    optionalMethods: StoreRpcOptionalMethod[],
  ) {
    for (const method of optionalMethods) {
      // No async arrow with rest parameters here: React Native's Babel setup
      // (Metro, Hermes profile) fails to compile one that uses `this`.
      const forward: Callable =
        method === "awaitIndexReady"
          ? (...args) =>
              this.invoke(method, args).then((status) => {
                this.indexStatus = status as StoreIndexBuildStatus;
                return this.indexStatus;
              })
          : (...args) => this.invoke(method, args);
      (this as unknown as Record<string, Callable>)[method] = forward;
    }
  }

  private async invoke(method: string, args: unknown[], blobId?: string): Promise<unknown> {
    const result = await this.transport.call({
      target: this.target,
      method,
      args: encodeRpcValue(args) as unknown[],
      blobId,
    });
    return decodeRpcValue(result);
  }

  getId(): string {
    return this.target.dbId;
  }

  getStoreKind(): StoreKind {
    return this.target.kind;
  }

  getCacheIdentity(): string {
    return `rpc:${this.target.scope}:${this.target.dbId}:${this.target.kind}`;
  }

  getIndexBuildStatus(): StoreIndexBuildStatus {
    return this.indexStatus;
  }

  async putEntries(entries: StoreEntry[]): Promise<void | StoreEntryMetadata[] | PutEntriesAck> {
    if (entries.length === 0) {
      return;
    }
    const blobId = generateRandomUuid();
    await this.transport.sendBytes(blobId, concatBytes(entries.map((entry) => entry.encryptedData)));
    const metas = entries.map(({ encryptedData, ...meta }) => ({ meta, length: encryptedData.byteLength }));
    return (await this.invoke("putEntries", [metas], blobId)) as void | StoreEntryMetadata[] | PutEntriesAck;
  }

  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    if (ids.length === 0) {
      return [];
    }
    const result = (await this.invoke("getEntries", [ids])) as StoreRpcGetEntriesResult;
    if (!result.blobId || result.entries.length === 0) {
      return [];
    }
    const bytes = await this.transport.receiveBytes(result.blobId);
    const payloads = splitBytes(bytes, result.entries.map((entry) => entry.length));
    return result.entries.map((entry, index) => ({
      ...(entry.meta as StoreEntryMetadata),
      encryptedData: payloads[index],
    }));
  }

  getEntryMetadata(id: string): Promise<StoreEntryMetadata | null> {
    return this.invoke("getEntryMetadata", [id]) as Promise<StoreEntryMetadata | null>;
  }

  hasEntries(ids: string[]): Promise<string[]> {
    return this.invoke("hasEntries", [ids]) as Promise<string[]>;
  }

  findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    return this.invoke("findNewEntries", [knownIds]) as Promise<StoreEntryMetadata[]>;
  }

  findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    return this.invoke("findNewEntriesForDoc", [knownIds, docId]) as Promise<StoreEntryMetadata[]>;
  }

  findEntries(
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null,
  ): Promise<StoreEntryMetadata[]> {
    return this.invoke("findEntries", [type, creationDateFrom, creationDateUntil]) as Promise<StoreEntryMetadata[]>;
  }

  getAllIds(): Promise<string[]> {
    return this.invoke("getAllIds", []) as Promise<string[]>;
  }

  planDocumentMaterialization(docId: string, options?: MaterializationPlanOptions): Promise<DocumentMaterializationPlan> {
    return this.invoke("planDocumentMaterialization", [docId, options]) as Promise<DocumentMaterializationPlan>;
  }

  planDocumentMaterializationBatch(
    docIds: string[],
    options?: MaterializationPlanOptions,
  ): Promise<DocumentMaterializationBatchPlan> {
    return this.invoke("planDocumentMaterializationBatch", [docIds, options]) as Promise<DocumentMaterializationBatchPlan>;
  }

  resolveDependencies(startId: string, options?: Record<string, unknown>): Promise<string[]> {
    return this.invoke("resolveDependencies", [startId, options]) as Promise<string[]>;
  }

  async purgeDocHistory(docId: string): Promise<void> {
    await this.invoke("purgeDocHistory", [docId]);
  }
}

/** Factory over a transport; `createStore` is synchronous, the server opens lazily. */
export class RpcContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  private readonly optionalMethods: StoreRpcOptionalMethod[];

  constructor(
    private readonly transport: StoreRpcClientTransport,
    private readonly options: RpcContentAddressedStoreFactoryOptions,
  ) {
    this.optionalMethods = options.optionalMethods ?? SQLITE_STORE_RPC_METHODS;
  }

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    const target = (kind: StoreKind): StoreRpcTarget => ({ scope: this.options.scope, dbId, kind, options });
    return {
      docStore: new RpcContentAddressedStore(this.transport, target(StoreKind.docs), this.optionalMethods),
      attachmentStore: new RpcContentAddressedStore(this.transport, target(StoreKind.attachments), this.optionalMethods),
    };
  }
}
