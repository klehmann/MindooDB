import type {
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../../types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  ContentAddressedStore,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
  PutEntriesAck,
  StoreHead,
} from "../types";
import type { NetworkTransport, NetworkTransportConfig } from "./NetworkTransport";
import type {
  AuthResult,
  NetworkEncryptedEntry,
  NetworkSyncCapabilities,
  SessionEncryptedEntriesBatch,
  StoreChangeEvent,
} from "./types";
import { NetworkError, NetworkErrorType } from "./types";
import {
  decodeIrohFrame,
  encodeIrohFrame,
  MINDOODB_IROH_ALPN,
  type IrohByteStream,
  type IrohRpcRequest,
  type IrohRpcResponse,
  type IrohStreamIO,
  type IrohRpcContext,
} from "./IrohStreamIO";

export type { IrohRpcContext };

async function rpcCall(
  stream: IrohByteStream,
  method: string,
  args: unknown[],
  id: number,
  ctx?: IrohRpcContext,
): Promise<unknown> {
  const request: IrohRpcRequest = { id, method, args, ctx };
  await stream.send(encodeIrohFrame(request));
  const bytes = await stream.recv();
  if (!bytes) {
    throw new NetworkError(NetworkErrorType.NETWORK_ERROR, "Iroh stream closed");
  }
  const response = decodeIrohFrame(bytes) as IrohRpcResponse;
  if (!response.ok) {
    throw new NetworkError(NetworkErrorType.NETWORK_ERROR, response.error ?? "Iroh RPC failed");
  }
  return response.result;
}

/**
 * NetworkTransport over Iroh QUIC streams (ALPN {@link MINDOODB_IROH_ALPN}).
 * Each method is one framed request/response. Pairing uses Iroh tickets.
 */
export class IrohNetworkTransport implements NetworkTransport {
  private nextId = 1;
  private stream: IrohByteStream | null = null;

  constructor(
    private readonly io: IrohStreamIO,
    private readonly peerTicket: string,
    private readonly config: NetworkTransportConfig,
  ) {}

  getIdentity(): string {
    return `iroh:${this.peerTicket}`;
  }

  private rpcContext(): IrohRpcContext {
    return {
      tenantId: this.config.tenantId,
      dbId: this.config.dbId,
      storeKind: this.config.storeKind,
    };
  }

  private async session(): Promise<IrohByteStream> {
    if (!this.stream) {
      this.stream = await this.io.connect(this.peerTicket, MINDOODB_IROH_ALPN);
    }
    return this.stream;
  }

  private async call(method: string, args: unknown[]): Promise<unknown> {
    return rpcCall(await this.session(), method, args, this.nextId++, this.rpcContext());
  }

  getServerInfo(): Promise<unknown> {
    return this.call("getServerInfo", []);
  }

  getTenantPublicInfosFingerprints(tenantId: string): Promise<{ tenantId: string; fingerprints: string[] }> {
    return this.call("getTenantPublicInfosFingerprints", [tenantId]) as Promise<{
      tenantId: string;
      fingerprints: string[];
    }>;
  }

  requestChallenge(username?: string, options?: { signingPublicKey?: string }): Promise<string> {
    return this.call("requestChallenge", [username, options]) as Promise<string>;
  }

  authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    return this.call("authenticate", [challenge, signature]) as Promise<AuthResult>;
  }

  getCapabilities(token: string): Promise<NetworkSyncCapabilities> {
    return this.call("getCapabilities", [token]) as Promise<NetworkSyncCapabilities>;
  }

  findNewEntries(token: string, haveIds: string[]): Promise<StoreEntryMetadata[]> {
    return this.call("findNewEntries", [token, haveIds]) as Promise<StoreEntryMetadata[]>;
  }

  findNewEntriesForDoc(token: string, haveIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    return this.call("findNewEntriesForDoc", [token, haveIds, docId]) as Promise<StoreEntryMetadata[]>;
  }

  findEntries(
    token: string,
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null,
  ): Promise<StoreEntryMetadata[]> {
    return this.call("findEntries", [token, type, creationDateFrom, creationDateUntil]) as Promise<StoreEntryMetadata[]>;
  }

  scanEntriesSince(
    token: string,
    cursor: StoreScanCursor | null,
    limit?: number,
    filters?: StoreScanFilters,
  ): Promise<StoreScanResult> {
    return this.call("scanEntriesSince", [token, cursor, limit, filters]) as Promise<StoreScanResult>;
  }

  getIdBloomSummary(token: string): Promise<StoreIdBloomSummary> {
    return this.call("getIdBloomSummary", [token]) as Promise<StoreIdBloomSummary>;
  }

  getStoreHead(token: string): Promise<StoreHead> {
    return this.call("getStoreHead", [token]) as Promise<StoreHead>;
  }

  getCompactionStatus(token: string): Promise<StoreCompactionStatus> {
    return this.call("getCompactionStatus", [token]) as Promise<StoreCompactionStatus>;
  }

  planDocumentMaterialization(
    token: string,
    docId: string,
    options?: MaterializationPlanOptions,
  ): Promise<DocumentMaterializationPlan> {
    return this.call("planDocumentMaterialization", [token, docId, options]) as Promise<DocumentMaterializationPlan>;
  }

  planDocumentMaterializationBatch(
    token: string,
    docIds: string[],
    options?: MaterializationPlanOptions,
  ): Promise<DocumentMaterializationBatchPlan> {
    return this.call("planDocumentMaterializationBatch", [token, docIds, options]) as Promise<DocumentMaterializationBatchPlan>;
  }

  planAttachmentReadByWalkingMetadata(
    token: string,
    lastChunkId: string,
    attachmentSize: number,
    options: AttachmentReadPlanOptions,
  ): Promise<AttachmentReadPlan> {
    return this.call("planAttachmentReadByWalkingMetadata", [token, lastChunkId, attachmentSize, options]) as Promise<AttachmentReadPlan>;
  }

  getEntries(token: string, ids: string[]): Promise<NetworkEncryptedEntry[]> {
    return this.call("getEntries", [token, ids]) as Promise<NetworkEncryptedEntry[]>;
  }

  getEntriesSessionWrapped(token: string, ids: string[]): Promise<SessionEncryptedEntriesBatch> {
    return this.call("getEntriesSessionWrapped", [token, ids]) as Promise<SessionEncryptedEntriesBatch>;
  }

  getEntryMetadata(token: string, id: string): Promise<StoreEntryMetadata | null> {
    return this.call("getEntryMetadata", [token, id]) as Promise<StoreEntryMetadata | null>;
  }

  putEntries(token: string, entries: StoreEntry[]): Promise<PutEntriesAck> {
    return this.call("putEntries", [token, entries]) as Promise<PutEntriesAck>;
  }

  hasEntries(token: string, ids: string[]): Promise<string[]> {
    return this.call("hasEntries", [token, ids]) as Promise<string[]>;
  }

  getAllIds(token: string): Promise<string[]> {
    return this.call("getAllIds", [token]) as Promise<string[]>;
  }

  resolveDependencies(
    token: string,
    startId: string,
    options?: Record<string, unknown>,
  ): Promise<string[]> {
    return this.call("resolveDependencies", [token, startId, options]) as Promise<string[]>;
  }

  async subscribeToChanges(
    token: string,
    onEvent: (event: StoreChangeEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const stream = await this.session();
    await stream.send(encodeIrohFrame({ id: this.nextId++, method: "subscribeToChanges", args: [token] }));
    while (!options?.signal?.aborted) {
      const bytes = await stream.recv();
      if (!bytes) {
        return;
      }
      const frame = decodeIrohFrame(bytes) as IrohRpcResponse | StoreChangeEvent;
      if ("dbId" in frame && "storeKind" in frame) {
        onEvent(frame as StoreChangeEvent);
      }
    }
  }
}

/**
 * ContentAddressedStore proxy over Iroh. Entries stay E2E-encrypted; no extra
 * RSA wrap. Use with `pullChangesFrom` / `pushChangesTo` between devices.
 */
export class IrohPeerStore implements ContentAddressedStore {
  private nextId = 1;
  private stream: IrohByteStream | null = null;

  constructor(
    private readonly io: IrohStreamIO,
    private readonly peerTicket: string,
    private readonly dbId: string,
    private readonly storeKind: ReturnType<ContentAddressedStore["getStoreKind"]>,
  ) {}

  getId(): string {
    return this.dbId;
  }

  getStoreKind() {
    return this.storeKind;
  }

  getCacheIdentity(): string {
    return `iroh:${this.peerTicket}:${this.dbId}:${this.storeKind}`;
  }

  private async session(): Promise<IrohByteStream> {
    if (!this.stream) {
      this.stream = await this.io.connect(this.peerTicket, MINDOODB_IROH_ALPN);
    }
    return this.stream;
  }

  private async call(method: string, args: unknown[]): Promise<unknown> {
    return rpcCall(await this.session(), method, args, this.nextId++);
  }

  putEntries(entries: StoreEntry[]) {
    return this.call("store.putEntries", [entries]) as Promise<void>;
  }

  applyWitnessReceipts(receipts: StoreEntryMetadata[]) {
    return this.call("store.applyWitnessReceipts", [receipts]) as Promise<void>;
  }

  getEntries(ids: string[]) {
    return this.call("store.getEntries", [ids]) as Promise<StoreEntry[]>;
  }

  getEntryMetadata(id: string) {
    return this.call("store.getEntryMetadata", [id]) as Promise<StoreEntryMetadata | null>;
  }

  hasEntries(ids: string[]) {
    return this.call("store.hasEntries", [ids]) as Promise<string[]>;
  }

  findNewEntries(knownIds: string[]) {
    return this.call("store.findNewEntries", [knownIds]) as Promise<StoreEntryMetadata[]>;
  }

  findNewEntriesForDoc(knownIds: string[], docId: string) {
    return this.call("store.findNewEntriesForDoc", [knownIds, docId]) as Promise<StoreEntryMetadata[]>;
  }

  findEntries(type: StoreEntry["entryType"], from: number | null, until: number | null) {
    return this.call("store.findEntries", [type, from, until]) as Promise<StoreEntryMetadata[]>;
  }

  getAllIds() {
    return this.call("store.getAllIds", []) as Promise<string[]>;
  }

  scanEntriesSince(cursor: StoreScanCursor | null, limit?: number, filters?: StoreScanFilters) {
    return this.call("store.scanEntriesSince", [cursor, limit, filters]) as Promise<StoreScanResult>;
  }

  getIdBloomSummary() {
    return this.call("store.getIdBloomSummary", []) as Promise<StoreIdBloomSummary>;
  }

  getStoreHead() {
    return this.call("store.getStoreHead", []) as Promise<StoreHead>;
  }

  planDocumentMaterialization(docId: string, options?: MaterializationPlanOptions) {
    return this.call("store.planDocumentMaterialization", [docId, options]) as Promise<DocumentMaterializationPlan>;
  }

  planDocumentMaterializationBatch(docIds: string[], options?: MaterializationPlanOptions) {
    return this.call("store.planDocumentMaterializationBatch", [docIds, options]) as Promise<DocumentMaterializationBatchPlan>;
  }

  resolveDependencies(startId: string, options?: Record<string, unknown>) {
    return this.call("store.resolveDependencies", [startId, options]) as Promise<string[]>;
  }

  purgeDocHistory(docId: string) {
    return this.call("store.purgeDocHistory", [docId]) as Promise<void>;
  }
}

export type IrohRpcHandler = (
  method: string,
  args: unknown[],
  ctx?: IrohRpcContext,
) => Promise<unknown>;

export function createStoreIrohHandler(store: ContentAddressedStore): IrohRpcHandler {
  return async (method, args) => {
    const name = method.startsWith("store.") ? method.slice(6) : method;
    const fn = (store as unknown as Record<string, (...inner: unknown[]) => Promise<unknown>>)[name];
    if (typeof fn !== "function") {
      throw new Error(`Unknown Iroh store method ${method}`);
    }
    return fn.apply(store, args);
  };
}

export async function serveIrohRpc(stream: IrohByteStream, handler: IrohRpcHandler): Promise<void> {
  while (true) {
    const bytes = await stream.recv();
    if (!bytes) {
      return;
    }
    const request = decodeIrohFrame(bytes) as IrohRpcRequest;
    try {
      const result = await handler(request.method, request.args, request.ctx);
      const response: IrohRpcResponse = { id: request.id, ok: true, result };
      await stream.send(encodeIrohFrame(response));
    } catch (error) {
      const response: IrohRpcResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await stream.send(encodeIrohFrame(response));
    }
  }
}

export async function listenForIrohPeers(
  io: IrohStreamIO,
  handler: IrohRpcHandler,
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (!io.listen) {
    throw new Error("IrohStreamIO.listen is required to accept peers");
  }
  for await (const stream of io.listen(MINDOODB_IROH_ALPN)) {
    if (options?.signal?.aborted) {
      await stream.close();
      return;
    }
    void serveIrohRpc(stream, handler);
  }
}
