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
import {
  NetworkError,
  NetworkErrorType,
  isNetworkError,
  parseNetworkErrorType,
} from "./types";
import {
  decodeIrohFrame,
  encodeIrohFrame,
  isBenignIrohClose,
  MINDOODB_IROH_ALPN,
  type IrohByteStream,
  type IrohConnectionHandle,
  type IrohRpcRequest,
  type IrohRpcResponse,
  type IrohStreamIO,
  type IrohRpcContext,
} from "./IrohStreamIO";
import { resolveIrohEndpointId } from "./irohLocator";

export type { IrohRpcContext };

/** One request / one response on a single stream. Exported so tests can force an id mismatch. */
export async function rpcCall(
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
  if (response.id !== id) {
    throw new NetworkError(
      NetworkErrorType.NETWORK_ERROR,
      `Iroh response id mismatch: expected ${id}, got ${response.id}`,
    );
  }
  if (!response.ok) {
    // Keep the far side's own classification when it sent one: over Iroh every
    // failure used to arrive as NETWORK_ERROR, which made a refused write look
    // like a broken link and left callers matching on message text.
    throw new NetworkError(
      parseNetworkErrorType(response.errorType) ?? NetworkErrorType.NETWORK_ERROR,
      response.error ?? "Iroh RPC failed",
    );
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
  private connection: Promise<IrohConnectionHandle> | null = null;
  private sessionTail: Promise<unknown> = Promise.resolve();

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

  private async sharedConnection(): Promise<IrohConnectionHandle | null> {
    if (!this.io.openConnection) {
      return null;
    }
    if (!this.connection) {
      this.connection = this.io.openConnection(this.peerTicket, MINDOODB_IROH_ALPN);
    }
    return this.connection;
  }

  private async session(): Promise<IrohByteStream> {
    if (!this.stream) {
      this.stream = await this.io.connect(this.peerTicket, MINDOODB_IROH_ALPN);
    }
    return this.stream;
  }

  private enqueueSession<T>(work: () => Promise<T>): Promise<T> {
    const run = this.sessionTail.then(work, work);
    this.sessionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async call(method: string, args: unknown[]): Promise<unknown> {
    const connection = await this.sharedConnection();
    if (connection) {
      const stream = await connection.openStream();
      try {
        return await rpcCall(stream, method, args, this.nextId++, this.rpcContext());
      } finally {
        await stream.close();
      }
    }
    return this.enqueueSession(async () =>
      rpcCall(await this.session(), method, args, this.nextId++, this.rpcContext()),
    );
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

  /**
   * System-admin challenge (`POST /system/auth/challenge`). No tenant scope.
   */
  requestSystemChallenge(username: string, publicsignkey: string): Promise<{ challenge: string }> {
    return this.call("system.requestChallenge", [username, publicsignkey]) as Promise<{
      challenge: string;
    }>;
  }

  /**
   * System-admin authenticate (`POST /system/auth/authenticate`).
   */
  authenticateSystem(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    return this.call("system.authenticate", [challenge, signature]) as Promise<AuthResult>;
  }

  /**
   * Register a tenant (`POST /system/tenants/:tenantId`) with a system JWT.
   */
  registerTenant(
    token: string,
    tenantId: string,
    body: Record<string, unknown>,
  ): Promise<{ success: boolean; tenantId: string; created?: boolean; message?: string }> {
    return this.call("system.registerTenant", [token, tenantId, body]) as Promise<{
      success: boolean;
      tenantId: string;
      created?: boolean;
      message?: string;
    }>;
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
    // Dedicated stream so the RPC session stays usable. When openConnection
    // exists this is a second bi-stream on the shared QUIC connection;
    // otherwise it is a second connect() (WASM / RN adapters).
    const connection = await this.sharedConnection();
    const stream = connection
      ? await connection.openStream()
      : await this.io.connect(this.peerTicket, MINDOODB_IROH_ALPN);
    const onAbort = () => {
      void stream.close();
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        await stream.close();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      await stream.send(
        encodeIrohFrame({
          id: this.nextId++,
          method: "subscribeToChanges",
          args: [token],
          ctx: this.rpcContext(),
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
      while (!options?.signal?.aborted) {
        const bytes = await stream.recv();
        if (!bytes) {
          return;
        }
        const frame = decodeIrohFrame(bytes);
        if (isStoreChangeEvent(frame)) {
          onEvent(frame);
        }
      }
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
      await stream.close();
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
  private connection: Promise<IrohConnectionHandle> | null = null;
  private sessionTail: Promise<unknown> = Promise.resolve();
  private readonly tenantId?: string;
  private readonly peerKey: string;

  constructor(
    private readonly io: IrohStreamIO,
    private readonly peerTicket: string,
    private readonly dbId: string,
    private readonly storeKind: ReturnType<ContentAddressedStore["getStoreKind"]>,
    options?: {
      /** Sent as `ctx.tenantId` so a listener can route to the right replica. */
      tenantId?: string;
      /**
       * Stable endpoint id of the peer. Only needed when dialing by ticket —
       * dialing by id already yields a stable key.
       */
      peerEndpointId?: string;
    },
  ) {
    this.tenantId = options?.tenantId;
    // The scan cursor is keyed by this string (see `syncScanCursorKey`). A
    // ticket embeds the peer's current relay and addresses, so keying on it
    // would invalidate the cursor whenever the peer's network changes and
    // force a full metadata rescan. The endpoint id never changes.
    this.peerKey =
      resolveIrohEndpointId(options?.peerEndpointId) ??
      resolveIrohEndpointId(peerTicket) ??
      peerTicket;
  }

  getId(): string {
    return this.dbId;
  }

  getStoreKind() {
    return this.storeKind;
  }

  getCacheIdentity(): string {
    return `iroh:${this.peerKey}:${this.dbId}:${this.storeKind}`;
  }

  private rpcContext(): IrohRpcContext {
    return {
      tenantId: this.tenantId,
      dbId: this.dbId,
      storeKind: this.storeKind,
    };
  }

  private async sharedConnection(): Promise<IrohConnectionHandle | null> {
    if (!this.io.openConnection) {
      return null;
    }
    if (!this.connection) {
      this.connection = this.io.openConnection(this.peerTicket, MINDOODB_IROH_ALPN);
    }
    return this.connection;
  }

  private async session(): Promise<IrohByteStream> {
    if (!this.stream) {
      this.stream = await this.io.connect(this.peerTicket, MINDOODB_IROH_ALPN);
    }
    return this.stream;
  }

  private enqueueSession<T>(work: () => Promise<T>): Promise<T> {
    const run = this.sessionTail.then(work, work);
    this.sessionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async call(method: string, args: unknown[]): Promise<unknown> {
    const connection = await this.sharedConnection();
    if (connection) {
      const stream = await connection.openStream();
      try {
        return await rpcCall(stream, method, args, this.nextId++, this.rpcContext());
      } finally {
        await stream.close();
      }
    }
    return this.enqueueSession(async () =>
      rpcCall(await this.session(), method, args, this.nextId++, this.rpcContext()),
    );
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
  /**
   * Endpoint id of the caller, proven by the QUIC handshake. Undefined when
   * the adapter cannot report it — treat that as an unknown peer.
   */
  peerEndpointId?: string,
) => Promise<unknown>;

/**
 * Store methods a sync peer legitimately needs: compare (Bloom + head), scan,
 * fetch, and hand over entries.
 *
 * Everything else a {@link ContentAddressedStore} happens to expose stays out,
 * because {@link createStoreIrohHandler} resolves methods by name off the store
 * object. Without this list a peer could call `purgeDocHistory` and destroy
 * history on the listening device.
 */
export const IROH_SYNC_STORE_METHODS: readonly string[] = [
  "getIdBloomSummary",
  "getStoreHead",
  "scanEntriesSince",
  "hasEntries",
  "findNewEntries",
  "findNewEntriesForDoc",
  "findEntries",
  "getEntries",
  "getEntryMetadata",
  "getAllIds",
  "putEntries",
  "applyWitnessReceipts",
  "resolveDependencies",
  "planDocumentMaterialization",
  "planDocumentMaterializationBatch",
];

export function createStoreIrohHandler(
  store: ContentAddressedStore,
  options?: {
    /**
     * Methods this handler will dispatch. Defaults to
     * {@link IROH_SYNC_STORE_METHODS}; pass an explicit list to narrow further
     * (for example read-only mirrors that must reject `putEntries`).
     */
    allowedMethods?: readonly string[];
  },
): IrohRpcHandler {
  const allowed = new Set(options?.allowedMethods ?? IROH_SYNC_STORE_METHODS);
  return async (method, args) => {
    const name = method.startsWith("store.") ? method.slice(6) : method;
    if (!allowed.has(name)) {
      throw new Error(`Iroh store method ${method} is not allowed`);
    }
    const fn = (store as unknown as Record<string, (...inner: unknown[]) => Promise<unknown>>)[name];
    if (typeof fn !== "function") {
      throw new Error(`Unknown Iroh store method ${method}`);
    }
    return fn.apply(store, args);
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in (value as object));
}

function isStoreChangeEvent(value: unknown): value is StoreChangeEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as StoreChangeEvent;
  return typeof event.dbId === "string" && typeof event.storeKind === "string";
}

export async function serveIrohRpc(stream: IrohByteStream, handler: IrohRpcHandler): Promise<void> {
  try {
    while (true) {
      const bytes = await stream.recv();
      if (!bytes) {
        return;
      }
      const request = decodeIrohFrame(bytes) as IrohRpcRequest;
      try {
        const result = await handler(
          request.method,
          request.args,
          request.ctx,
          stream.remoteEndpointId,
        );
        if (isAsyncIterable(result)) {
          await streamHandlerIterable(stream, request, result);
          return;
        }
        const response: IrohRpcResponse = { id: request.id, ok: true, result };
        await stream.send(encodeIrohFrame(response));
      } catch (error) {
        const response: IrohRpcResponse = {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(isNetworkError(error) ? { errorType: error.type } : {}),
        };
        await stream.send(encodeIrohFrame(response));
      }
    }
  } catch (error) {
    if (isBenignIrohClose(error)) {
      return;
    }
    throw error;
  }
}

async function streamHandlerIterable(
  stream: IrohByteStream,
  request: IrohRpcRequest,
  result: AsyncIterable<unknown>,
): Promise<void> {
  await stream.send(encodeIrohFrame({ id: request.id, ok: true, result: { subscribed: true } }));
  const iterator = result[Symbol.asyncIterator]();
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await iterator.return?.();
  };
  const watchClose = (async () => {
    try {
      while (true) {
        const next = await stream.recv();
        if (!next) {
          break;
        }
      }
    } finally {
      await stop();
    }
  })();
  try {
    while (!stopped) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      await stream.send(encodeIrohFrame(next.value));
    }
  } catch (error) {
    if (!isBenignIrohClose(error)) {
      throw error;
    }
  } finally {
    await stop();
    await watchClose.catch(() => undefined);
  }
}

export interface IrohListenOptions {
  signal?: AbortSignal;
  /**
   * Connection-level gate, run once per inbound stream before any RPC is
   * served. Return false to drop the stream immediately.
   *
   * `peerEndpointId` is authenticated (QUIC proved key possession) but not
   * authorized — that is what this callback decides, typically by looking the
   * id up in the tenant directory. It is undefined when the adapter cannot
   * report the peer, which an authorizing listener should reject.
   *
   * Per-request scope (`ctx.tenantId` / `ctx.dbId`) still has to be checked in
   * the handler; this gate only sees the connection.
   */
  authorize?(peerEndpointId: string | undefined): boolean | Promise<boolean>;
  /**
   * Maximum RPC sessions served at once. Further inbound streams are closed
   * without being served, so an unauthorized peer cannot pin resources by
   * opening streams in a loop. Defaults to 32.
   */
  maxConcurrentSessions?: number;
}

const DEFAULT_MAX_CONCURRENT_IROH_SESSIONS = 32;

export async function listenForIrohPeers(
  io: IrohStreamIO,
  handler: IrohRpcHandler,
  options?: IrohListenOptions,
): Promise<void> {
  if (!io.listen) {
    throw new Error("IrohStreamIO.listen is required to accept peers");
  }
  const maxSessions = options?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_IROH_SESSIONS;
  const sessions = new Set<Promise<void>>();
  for await (const stream of io.listen(MINDOODB_IROH_ALPN)) {
    if (options?.signal?.aborted) {
      await stream.close();
      return;
    }
    if (sessions.size >= maxSessions) {
      await stream.close();
      continue;
    }
    if (options?.authorize) {
      let allowed = false;
      try {
        allowed = await options.authorize(stream.remoteEndpointId);
      } catch (error) {
        console.error("[Iroh] peer authorization failed:", error);
      }
      if (!allowed) {
        await stream.close();
        continue;
      }
    }
    const session = serveIrohRpc(stream, handler).catch((error) => {
      if (!isBenignIrohClose(error)) {
        console.error("[Iroh] RPC session failed:", error);
      }
    });
    sessions.add(session);
    void session.finally(() => sessions.delete(session));
  }
}
