/**
 * One Durable Object per (tenant, database), named `<tenantId>/<dbId>`.
 *
 * Each object runs the platform-neutral server core for its database: the
 * docs and attachments stores live in the object's SQLite, and access control
 * runs locally with the same code as on Node. For that it needs the tenant's
 * directory, so every object other than `directory` keeps a read-only replica
 * of the directory store and pulls new entries from the tenant's directory
 * object before it serves a request (at most every few seconds, immediately
 * when the directory announces a change, and once more when a request was
 * denied — a grant may just have arrived).
 *
 * The `directory` object is also the tenant's hub: it answers the auth
 * handshake (challenges are kept in memory), proxies RFC 3161 requests, holds
 * the Server-Sent-Events streams and receives the change events of the other
 * databases, and knows which databases the tenant has.
 */

import {
  deserializeStoreEntry,
  serializeStoreEntry,
  type SerializedEntry,
} from "../core/appendonlystores/network/entryWireCodec";
import { StoreKind, type StoreScanCursor } from "../core/appendonlystores/types";
import type { ContentAddressedStore } from "../core/types";
import { base64ToBytes } from "../core/utils/base64";
import type { SqliteContentAddressedStore } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import {
  MindooDBServerCore,
  formatSyncChangeEvent,
  formatSyncHeartbeat,
  formatSyncHelloEvent,
  SYNC_EVENT_HEARTBEAT_MS,
} from "../server/http/MindooDBServerCore";
import { TenantManager } from "../server/TenantManager";
import { CapabilityMatcher } from "../server/CapabilityMatcher";
import { SystemAdminAuthService } from "../server/SystemAdminAuth";
import { DeviceDiscoveryService } from "../server/DeviceDiscoveryService";
import { SyncEventBus, type SyncChangeEvent } from "../server/SyncEventBus";
import { buildAuthRateLimitKey, buildSyncRateLimitKey, buildTimestampRateLimitKey } from "../server/rateLimits";
import { isEventStreamResponse, type ServerRequest, type SyncEventPublisher, type SyncEventStreamSpec } from "../server/http/types";
import type { TenantConfig, TrustedServer } from "../server/types";
import { PeerAuthService } from "../server/peer/PeerAuthService";
import { guardStoreAgainstPurgedDocuments } from "../core/appendonlystores/purgedDocumentGuard";
import { StoreRpcServer } from "../core/appendonlystores/rpc/StoreRpcServer";
import type { StoreRpcRequest } from "../core/appendonlystores/rpc/RpcContentAddressedStore";
import { StoreRpcBytes } from "./storeRpc";
import { createDurableObjectStore, DurableObjectServerDataStore } from "./DurableObjectSql";
import { WorkersCryptoAdapter } from "./WorkersCryptoAdapter";
import {
  INTERNAL_HEADER,
  INTERNAL_ORIGIN,
  isInternalCall,
  jsonResponse,
  matchRoute,
  toResponse,
  toServerRequest,
} from "./http";
import {
  createHostSettings,
  databaseObject,
  derivePeerJwtSecret,
  deriveTenantJwtSecret,
  OBJECT_HEADER,
  internalHeaders,
  rateLimited,
  seedServerIdentity,
  serverObject,
  type HostSettings,
} from "./host";
import type { DurableObjectState, MindooCloudflareEnv } from "./types";

const DIRECTORY_DB_ID = "directory";
/** How long tenant config and keys from the server object are trusted. */
const TENANT_STATE_TTL_MS = 60_000;
/** How often a database object asks the directory for new entries on its own. */
const DIRECTORY_POLL_INTERVAL_MS = 2_000;
const DIRECTORY_PAGE_SIZE = 200;
const REPLICA_CURSOR_KEY = "directory-replica-cursor.json";
const DATABASES_KEY = "databases.json";
const TRUSTED_SERVERS_KEY = "trusted-servers.json";

interface TenantState {
  exists: boolean;
  config?: TenantConfig;
  publicInfosKeys: Uint8Array[];
  /** `trusted-servers.json` of the server: peers may sync with their peer token. */
  trustedServers: TrustedServer[];
  /** Peer replication runs; accepted writes are reported to the server object. */
  clusterActive: boolean;
  loadedAt: number;
}

export class MindooDatabaseObject {
  private readonly settings: HostSettings;
  private readonly cryptoAdapter = new WorkersCryptoAdapter();
  private dataStore!: DurableObjectServerDataStore;
  private stores = new Map<string, SqliteContentAddressedStore>();
  private tenantId: string | null = null;
  private dbId: string | null = null;
  private tenantState: TenantState | null = null;
  private tenantStateLoad: Promise<TenantState> | null = null;
  private tenantManager: TenantManager | null = null;
  private core: MindooDBServerCore | null = null;
  /** Change events of the whole tenant; only used in the directory object. */
  private readonly eventBus = new SyncEventBus();
  private replicaCheckedAt = 0;
  private replicaRefresh: Promise<boolean> | null = null;
  /** Payload buffers of store RPC exchanges with the server object. */
  private readonly rpcBytes = new StoreRpcBytes();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: MindooCloudflareEnv,
  ) {
    this.settings = createHostSettings(env);
    this.openStorage();
  }

  private openStorage(): void {
    this.dataStore = new DurableObjectServerDataStore(this.ctx.storage.sql);
    seedServerIdentity(this.dataStore, this.env);
    this.stores = new Map();
  }

  private get isDirectory(): boolean {
    return this.dbId === DIRECTORY_DB_ID;
  }

  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get(OBJECT_HEADER.tenantId);
    const dbId = request.headers.get(OBJECT_HEADER.dbId);
    if (!tenantId || !dbId) {
      return jsonResponse(400, { error: "Missing object address" });
    }
    if (this.tenantId === null) {
      this.tenantId = tenantId;
      this.dbId = dbId;
    } else if (this.tenantId !== tenantId || this.dbId !== dbId) {
      return jsonResponse(400, { error: "Request addressed to another database object" });
    }

    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/internal/") && isInternalCall(request)) {
        return await this.internal(url.pathname, request);
      }
      return await this.public(request, url);
    } catch (error) {
      console.error(`[MindooDatabaseObject ${tenantId}/${dbId}] Request error:`, error);
      return jsonResponse(500, { error: "Internal server error" });
    }
  }

  // ==================== Stores ====================

  /** The object's own stores, and the directory (own or replica). */
  private store(dbId: string, storeKind: StoreKind): ContentAddressedStore {
    let prefix: string;
    if (dbId === this.dbId) {
      prefix = storeKind === StoreKind.docs ? "d_" : "a_";
    } else if (dbId === DIRECTORY_DB_ID) {
      prefix = storeKind === StoreKind.docs ? "rd_" : "ra_";
    } else {
      throw new Error(`Database ${dbId} is served by its own object`);
    }
    let store = this.stores.get(prefix);
    if (!store) {
      store = createDurableObjectStore(this.ctx.storage.sql, dbId, storeKind, prefix);
      this.stores.set(prefix, store);
    }
    return store;
  }

  // ==================== Tenant state ====================

  private async loadTenantState(): Promise<TenantState> {
    const current = this.tenantState;
    if (current && Date.now() - current.loadedAt < TENANT_STATE_TTL_MS) {
      return current;
    }
    if (!this.tenantStateLoad) {
      this.tenantStateLoad = this.fetchTenantState().finally(() => {
        this.tenantStateLoad = null;
      });
    }
    return this.tenantStateLoad;
  }

  private async fetchTenantState(): Promise<TenantState> {
    const tenantId = this.tenantId!;
    const response = await serverObject(this.env).fetch(
      `${INTERNAL_ORIGIN}/internal/tenants/${encodeURIComponent(tenantId)}`,
      { headers: internalHeaders() },
    );
    if (!response.ok) {
      throw new Error(`Tenant state of ${tenantId} unavailable: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      exists: boolean;
      config?: TenantConfig;
      publicInfosKeys?: string[];
      trustedServers?: TrustedServer[];
      clusterActive?: boolean;
    };
    const state: TenantState = {
      exists: body.exists,
      config: body.config,
      publicInfosKeys: (body.publicInfosKeys ?? []).map((key) => base64ToBytes(key)),
      trustedServers: body.trustedServers ?? [],
      clusterActive: body.clusterActive === true,
      loadedAt: Date.now(),
    };

    const configKey = `${tenantId}/config.json`;
    const configJson = state.config ? JSON.stringify(state.config, null, 2) : null;
    const trustedJson = JSON.stringify(state.trustedServers, null, 2);
    const changed =
      !this.tenantState ||
      this.dataStore.readText(configKey) !== configJson ||
      this.dataStore.readText(TRUSTED_SERVERS_KEY) !== trustedJson ||
      this.tenantState.publicInfosKeys.map(String).join() !== state.publicInfosKeys.map(String).join();
    if (configJson === null) {
      this.dataStore.deleteTree(configKey);
    } else if (changed) {
      this.dataStore.writeText(configKey, configJson);
    }
    // The tenant manager reads trusted servers when it is created: they count
    // as directory members (peer pushes) and as trusted witnesses.
    if (changed) {
      this.dataStore.writeText(TRUSTED_SERVERS_KEY, trustedJson);
    }
    this.tenantState = state;
    if (changed || !this.core) {
      this.createCore();
    }
    if (state.exists && !this.isDirectory) {
      await this.registerWithDirectory();
    }
    return state;
  }

  /** Tell the tenant's directory object that this database exists. */
  private async registerWithDirectory(): Promise<void> {
    if (this.dataStore.readText("registered") === "1") return;
    const response = await this.directoryObject().fetch(`${INTERNAL_ORIGIN}/internal/databases/register`, {
      method: "POST",
      headers: internalHeaders(this.tenantId!, DIRECTORY_DB_ID),
      body: JSON.stringify({ dbId: this.dbId }),
    });
    if (response.ok) {
      this.dataStore.writeText("registered", "1");
    }
  }

  private createCore(): void {
    const tenantId = this.tenantId!;
    const env = this.env;
    this.tenantManager = new TenantManager({
      dataStore: this.dataStore,
      cryptoAdapter: this.cryptoAdapter,
      serverPassword: env.MINDOODB_SERVER_PASSWORD,
      storeProvider: {
        createTenantStores: () => ({
          getStore: (dbId, storeKind) => this.store(dbId, storeKind),
        }),
        listDatabases: () => (this.isDirectory ? this.registeredDatabases() : [this.dbId!]),
      },
      jwtSecretForTenant: (id) => deriveTenantJwtSecret(env, id),
      publicInfosKeysResolver: async () => this.tenantState?.publicInfosKeys ?? [],
    });

    // Peers replicate through the ordinary sync routes with a peer token from
    // the server object (same key derivation), as on the Node server.
    const trustedServers = () => this.tenantState?.trustedServers ?? [];
    let peerAuth: Promise<PeerAuthService> | null = null;
    const getPeerAuth = () =>
      (peerAuth ??= derivePeerJwtSecret(env).then(
        (jwtSecret) => new PeerAuthService(this.cryptoAdapter, trustedServers, { jwtSecret }),
      ));
    this.tenantManager.setPeerAccessControl({
      peerTokenResolver: async (token) => {
        const auth = await getPeerAuth();
        const payload = await auth.validateToken(token);
        const trusted = payload ? auth.findTrustedServerByKey(payload.publicsignkey) : null;
        return trusted
          ? {
              name: trusted.name,
              signingPublicKey: trusted.signingPublicKey,
              encryptionPublicKey: trusted.encryptionPublicKey,
            }
          : null;
      },
      trustedWitnessResolver: (receivedByPublicKey) =>
        trustedServers().some(
          (server) => server.signingPublicKey.replace(/\s+/g, "") === receivedByPublicKey.replace(/\s+/g, ""),
        ),
    });

    const config = { capabilities: {} };
    const syncEvents: SyncEventPublisher = {
      listenerCount: 1,
      publish: (event) => {
        if (this.isDirectory) {
          this.eventBus.publish(event);
        } else {
          this.ctx.waitUntil(this.forwardEvent(event));
        }
        if (this.tenantState?.clusterActive) {
          this.ctx.waitUntil(this.reportToCluster(event));
        }
      },
    };
    this.core = new MindooDBServerCore({
      tenantManager: this.tenantManager,
      // System administration runs in the server object; these are inert here.
      systemAdminAuth: new SystemAdminAuthService(this.cryptoAdapter, config),
      capabilityMatcher: new CapabilityMatcher(config),
      deviceDiscovery: new DeviceDiscoveryService(this.tenantManager, this.cryptoAdapter),
      configRepository: {
        listBackups: () => [],
        loadBackup: (file) => {
          throw new Error(`Config backup not found: ${file}`);
        },
        replace: () => null,
      },
      getServerConfig: () => config,
      reloadConfig: () => undefined,
      syncEvents,
      tsaProviders: this.settings.tsaProviders,
      jsonBodyLimit: this.settings.jsonBodyLimit,
      allowInsecureSyncUrls: this.settings.allowInsecureSyncUrls,
      runInBackground: (task) => this.ctx.waitUntil(task),
      cluster: {
        mirrorsForTenant: () => [],
        syncReplicators: () => undefined,
        resolvePeerName: async (token) => (await (await getPeerAuth()).validateToken(token))?.sub,
      },
      onDirectoryWrite: async (id) => {
        this.notifyDatabasesOfDirectoryChange(id);
      },
    });
  }

  private directoryObject() {
    return databaseObject(this.env, this.tenantId!, DIRECTORY_DB_ID);
  }

  /** Let the server object push an accepted write on to the peers. */
  private async reportToCluster(event: SyncChangeEvent): Promise<void> {
    try {
      await serverObject(this.env).fetch(`${INTERNAL_ORIGIN}/internal/cluster/change`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify(event),
      });
    } catch (error) {
      console.warn("[MindooDatabaseObject] Could not report change to the cluster:", error);
    }
  }

  private async forwardEvent(event: SyncChangeEvent): Promise<void> {
    try {
      await this.directoryObject().fetch(`${INTERNAL_ORIGIN}/internal/events/publish`, {
        method: "POST",
        headers: internalHeaders(this.tenantId!, DIRECTORY_DB_ID),
        body: JSON.stringify(event),
      });
    } catch (error) {
      console.warn("[MindooDatabaseObject] Could not forward change event:", error);
    }
  }

  // ==================== Directory replica ====================

  private registeredDatabases(): string[] {
    const raw = this.dataStore.readText(DATABASES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  /** Directory object: let every database pull the directory and run its purges. */
  private notifyDatabasesOfDirectoryChange(tenantId: string): void {
    for (const dbId of this.registeredDatabases()) {
      this.ctx.waitUntil(
        databaseObject(this.env, tenantId, dbId)
          .fetch(`${INTERNAL_ORIGIN}/internal/directory/changed`, {
            method: "POST",
            headers: internalHeaders(tenantId, dbId),
          })
          .catch((error) => console.warn(`[MindooDatabaseObject] Notifying ${dbId} failed:`, error)),
      );
    }
  }

  /**
   * Pull new directory entries into the replica. Returns whether anything
   * arrived. Concurrent callers share one pull.
   */
  private async refreshDirectoryReplica(force: boolean): Promise<boolean> {
    if (this.isDirectory) return false;
    if (!force && Date.now() - this.replicaCheckedAt < DIRECTORY_POLL_INTERVAL_MS) return false;
    if (this.replicaRefresh) return this.replicaRefresh;
    this.replicaRefresh = this.pullDirectory().finally(() => {
      this.replicaRefresh = null;
    });
    return this.replicaRefresh;
  }

  private async pullDirectory(): Promise<boolean> {
    const replica = this.store(DIRECTORY_DB_ID, StoreKind.docs);
    const storedCursor = this.dataStore.readText(REPLICA_CURSOR_KEY);
    let cursor: StoreScanCursor | null = storedCursor ? JSON.parse(storedCursor) : null;
    let received = false;
    for (;;) {
      const response = await this.directoryObject().fetch(`${INTERNAL_ORIGIN}/internal/directory/changes`, {
        method: "POST",
        headers: internalHeaders(this.tenantId!, DIRECTORY_DB_ID),
        body: JSON.stringify({ cursor }),
      });
      if (!response.ok) {
        throw new Error(`Directory pull failed: HTTP ${response.status}`);
      }
      const page = (await response.json()) as {
        entries: SerializedEntry[];
        nextCursor: StoreScanCursor | null;
        hasMore: boolean;
      };
      if (page.entries.length > 0) {
        const entries = page.entries.map((entry) => deserializeStoreEntry(entry));
        await replica.putEntries(entries);
        // Receipts of entries the replica already had arrive as metadata updates.
        await replica.applyWitnessReceipts?.(entries);
        received = true;
      }
      cursor = page.nextCursor ?? cursor;
      if (cursor) this.dataStore.writeText(REPLICA_CURSOR_KEY, JSON.stringify(cursor));
      if (!page.hasMore) break;
    }
    this.replicaCheckedAt = Date.now();
    if (received && this.tenantManager) {
      // Purge requests arrive through the directory (docs/accesscontrol.md §13).
      this.ctx.waitUntil(
        this.tenantManager
          .executePendingPurges(this.tenantId!, { dbIds: new Set([this.dbId!]) })
          .catch((error) => console.error("[MindooDatabaseObject] executePendingPurges failed:", error)),
      );
    }
    return received;
  }

  /** Directory object: one page of directory entries after `cursor`. */
  private async directoryChanges(request: Request): Promise<Response> {
    const { cursor } = (await request.json()) as { cursor: StoreScanCursor | null };
    const store = this.store(DIRECTORY_DB_ID, StoreKind.docs);
    const page = await store.scanEntriesSince!(cursor, DIRECTORY_PAGE_SIZE);
    const entries = await store.getEntries(page.entries.map((entry) => entry.id));
    return jsonResponse(200, {
      entries: entries.map((entry) => serializeStoreEntry(entry)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  }

  // ==================== Internal routes ====================

  private async internal(path: string, request: Request): Promise<Response> {
    const bytes = await this.rpcBytes.handle(path, request);
    if (bytes) return bytes;
    switch (path) {
      case "/internal/store-rpc":
        return this.storeRpc(request);
      case "/internal/databases":
        if (!this.isDirectory) break;
        return jsonResponse(200, { databases: [DIRECTORY_DB_ID, ...this.registeredDatabases()] });
      case "/internal/directory/announce":
        // Directory entries arrived by peer replication.
        if (!this.isDirectory) break;
        this.notifyDatabasesOfDirectoryChange(this.tenantId!);
        return jsonResponse(200, { ok: true });
      case "/internal/wipe":
        return this.wipe();
      case "/internal/directory/changed":
        await this.loadTenantState();
        await this.refreshDirectoryReplica(true);
        return jsonResponse(200, { ok: true });
      case "/internal/directory/changes":
        if (!this.isDirectory) break;
        return this.directoryChanges(request);
      case "/internal/events/publish":
        if (!this.isDirectory) break;
        this.eventBus.publish((await request.json()) as SyncChangeEvent);
        return jsonResponse(200, { ok: true });
      case "/internal/databases/register": {
        if (!this.isDirectory) break;
        const { dbId } = (await request.json()) as { dbId: string };
        const databases = new Set(this.registeredDatabases());
        databases.add(dbId);
        this.dataStore.writeText(DATABASES_KEY, JSON.stringify([...databases].sort()));
        return jsonResponse(200, { ok: true });
      }
    }
    return jsonResponse(404, { error: "Not found" });
  }

  /**
   * This object's stores for peer replication in the server object. Pulled
   * entries of purged documents are refused, as on Node.
   */
  private async storeRpc(request: Request): Promise<Response> {
    const state = await this.loadTenantState();
    if (!state.exists) {
      return jsonResponse(404, { error: "Tenant not found" });
    }
    const tenantId = this.tenantId!;
    const dbId = this.dbId!;
    const server = new StoreRpcServer({
      bytes: this.rpcBytes,
      createFactory: (scope) => ({
        createStore: (requestedDbId) => {
          if (scope !== tenantId || requestedDbId !== dbId) {
            throw new Error(`Store RPC for ${scope}/${requestedDbId} reached ${tenantId}/${dbId}`);
          }
          const guard = (store: ContentAddressedStore) =>
            dbId === DIRECTORY_DB_ID || !this.tenantManager
              ? store
              : guardStoreAgainstPurgedDocuments(store, async () =>
                  this.tenantManager!.getPurgedDocIds(tenantId, dbId),
                );
          return {
            docStore: guard(this.store(dbId, StoreKind.docs)),
            attachmentStore: guard(this.store(dbId, StoreKind.attachments)),
          };
        },
      }),
    });
    try {
      const result = await server.handle((await request.json()) as StoreRpcRequest);
      if (dbId !== DIRECTORY_DB_ID) {
        await this.registerWithDirectory();
      }
      return jsonResponse(200, { result });
    } catch (error) {
      return jsonResponse(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Delete everything of a removed tenant (the directory object first wipes the others). */
  private async wipe(): Promise<Response> {
    if (this.isDirectory) {
      for (const dbId of this.registeredDatabases()) {
        const response = await databaseObject(this.env, this.tenantId!, dbId).fetch(
          `${INTERNAL_ORIGIN}/internal/wipe`,
          { method: "POST", headers: internalHeaders(this.tenantId!, dbId) },
        );
        if (!response.ok) {
          return jsonResponse(500, { error: `Wiping ${dbId} failed` });
        }
      }
    }
    await this.ctx.storage.deleteAll();
    this.tenantState = null;
    this.tenantManager = null;
    this.core = null;
    this.replicaCheckedAt = 0;
    this.openStorage();
    return jsonResponse(200, { ok: true });
  }

  // ==================== Public routes ====================

  private async public(request: Request, url: URL): Promise<Response> {
    const route = matchRoute(request.method, url.pathname);
    if (
      route.kind !== "tenantAuth" &&
      route.kind !== "timestamp" &&
      route.kind !== "sync" &&
      route.kind !== "tenantNotFound"
    ) {
      return jsonResponse(404, { error: "Not found" });
    }

    await this.loadTenantState();
    const core = this.core!;
    const parsed = await toServerRequest(request, {
      params: { tenantId: route.tenantId },
      jsonBodyLimitBytes: this.settings.jsonBodyLimitBytes,
    });
    if (parsed instanceof Response) return parsed;
    const req = parsed;

    const rejection = core.tenantGuard(req);
    if (rejection) return toResponse(rejection);
    const clientIp = req.clientIp ?? "unknown";

    switch (route.kind) {
      case "tenantNotFound":
        return jsonResponse(404, { error: "Not found" });

      case "tenantAuth": {
        const limited = await rateLimited(
          this.env.MINDOODB_RATE_LIMIT_AUTH,
          buildAuthRateLimitKey("tenant", route.phase, req.tenantId, clientIp, req.body),
          "Too many authentication attempts, please try again later",
        );
        if (limited) return limited;
        return toResponse(
          route.phase === "challenge" ? await core.challenge(req) : await core.authenticate(req),
        );
      }

      case "timestamp": {
        const denied = await core.timestampAuthGuard(req);
        if (denied) return toResponse(denied);
        const limited = await rateLimited(
          this.env.MINDOODB_RATE_LIMIT_TIMESTAMP,
          buildTimestampRateLimitKey("burst", req.tenantId, req.timestampPrincipal, clientIp),
          "Too many timestamp requests, please try again shortly",
        );
        if (limited) return limited;
        return toResponse(await core.timestampRequest(req));
      }

      case "sync":
        return this.sync(request, req, route.storeKind, route.name);
    }
  }

  private async sync(
    request: Request,
    req: ServerRequest,
    storeKind: StoreKind,
    name: Parameters<MindooDBServerCore["sync"]>[0],
  ): Promise<Response> {
    const core = this.core!;
    await this.refreshDirectoryReplica(false);
    await core.resolveSyncPrincipal(req);
    const limited = await rateLimited(
      this.env.MINDOODB_RATE_LIMIT_SYNC,
      buildSyncRateLimitKey(req.tenantId, req.syncPrincipal, req.clientIp ?? "unknown"),
      "Too many sync requests, please try again later",
    );
    if (limited) return limited;

    if (name === "events") {
      if (request.headers.get(INTERNAL_HEADER.eventsGatePassed) === "1") {
        return this.openEventStream({ tenantId: req.tenantId!, storeKind });
      }
      const response = await core.sync("events", req, storeKind);
      return isEventStreamResponse(response)
        ? this.openEventStream(response.events)
        : toResponse(response);
    }

    let response = await core.sync(name, req, storeKind);
    // A grant or a new device key may have reached the directory a moment
    // ago: refresh the replica once and retry a denied request.
    if (
      !this.isDirectory &&
      (response.status === 401 || response.status === 403 || response.status === 404) &&
      (await this.refreshDirectoryReplica(true))
    ) {
      response = await core.sync(name, req, storeKind);
    }
    return toResponse(response);
  }

  /** Server-Sent-Events stream on the tenant's event bus (directory object only). */
  private openEventStream(subscription: SyncEventStreamSpec): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      writer.close().catch(() => undefined);
    };
    const write = (frame: string) => {
      if (closed) return;
      writer.write(encoder.encode(frame)).catch(cleanup);
    };

    write(formatSyncHelloEvent());
    const unsubscribe = this.eventBus.subscribe((event) => {
      const frame = formatSyncChangeEvent(subscription, event);
      if (frame) write(frame);
    });
    const heartbeat = setInterval(() => write(formatSyncHeartbeat(Date.now())), SYNC_EVENT_HEARTBEAT_MS);
    console.log(
      `[MindooDatabaseObject] SSE subscriber connected tenant=${subscription.tenantId} storeKind=${subscription.storeKind} subscribers=${this.eventBus.listenerCount}`,
    );

    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }
}
