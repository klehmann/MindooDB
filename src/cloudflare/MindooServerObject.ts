/**
 * The server-wide Durable Object (one instance, named "server").
 *
 * It plays the role of the Node server's data directory minus the entry
 * stores: `config.json` and its backups, the trusted-servers list, the server
 * key bag with every tenant's `$publicinfos` key, and the tenant configs. It
 * serves `/system/*` and the discovery endpoints, and hands each tenant's
 * state (config + keys) to the database objects that serve the tenant.
 */

import { bytesToBase64 } from "../core/utils/base64";
import { MindooDBServerCore } from "../server/http/MindooDBServerCore";
import { TenantManager } from "../server/TenantManager";
import { CapabilityMatcher } from "../server/CapabilityMatcher";
import { SystemAdminAuthService } from "../server/SystemAdminAuth";
import { DeviceDiscoveryService } from "../server/DeviceDiscoveryService";
import { SyncEventBus } from "../server/SyncEventBus";
import {
  isConfigBackupFilename,
  parseConfigBackupTimestamp,
  validateServerConfig,
  type ConfigBackupInfo,
  type ServerConfigRepository,
} from "../server/serverConfig";
import { validateTenantIdFormat } from "../server/validation";
import { buildAuthRateLimitKey } from "../server/rateLimits";
import type { ServerConfig } from "../server/types";
import type { ServerRequest, ServerResponse } from "../server/http/types";
import { ClusterManager } from "../server/peer/ClusterManager";
import type { ClusterAuditStorage } from "../server/peer/ClusterAuditLog";
import { ClusterAdminHandlers, formatPeerChangeEvent, PeerHttpHandlers } from "../server/peer/clusterHttp";
import type { SyncChangeEvent } from "../server/SyncEventBus";
import { StoreKind } from "../core/appendonlystores/types";
import type { ContentAddressedStore } from "../core/types";
import {
  formatSyncHeartbeat,
  formatSyncHelloEvent,
  SYNC_EVENT_HEARTBEAT_MS,
} from "../server/http/MindooDBServerCore";
import { remoteObjectStore } from "./storeRpc";
import type { SqlStorage } from "./types";
import { DurableObjectServerDataStore } from "./DurableObjectSql";
import { WorkersCryptoAdapter } from "./WorkersCryptoAdapter";
import {
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
  internalHeaders,
  rateLimited,
  seedServerIdentity,
  type HostSettings,
} from "./host";
import type { DurableObjectState, MindooCloudflareEnv } from "./types";

const CONFIG_KEY = "config.json";
const CONFIG_BACKUP_DIR = "config-backups";

/** `config.json` and its backups as documents of the server object. */
class StoredServerConfigRepository implements ServerConfigRepository {
  constructor(private readonly dataStore: DurableObjectServerDataStore) {}

  listBackups(): ConfigBackupInfo[] {
    const rows = this.dataStore.listFiles(CONFIG_BACKUP_DIR);
    return rows
      .filter((file) => isConfigBackupFilename(file))
      .map((file) => ({ file, createdAt: parseConfigBackupTimestamp(file)! }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  loadBackup(backupFile: string): ServerConfig {
    if (!isConfigBackupFilename(backupFile)) {
      throw new Error(`Invalid config backup filename: ${backupFile}`);
    }
    const raw = this.dataStore.readText(`${CONFIG_BACKUP_DIR}/${backupFile}`);
    if (raw === null) {
      throw new Error(`Config backup not found: ${backupFile}`);
    }
    return validateServerConfig(JSON.parse(raw), backupFile);
  }

  replace(config: ServerConfig): string | null {
    const current = this.dataStore.readText(CONFIG_KEY);
    let backupFile: string | null = null;
    if (current !== null) {
      backupFile = `config.${new Date().toISOString().replace(/:/g, "-")}.json`;
      this.dataStore.writeText(`${CONFIG_BACKUP_DIR}/${backupFile}`, current);
    }
    this.dataStore.writeText(CONFIG_KEY, JSON.stringify(config, null, 2));
    return backupFile;
  }
}

/**
 * Wall-time budget of one cron tick's replication pass. Each pass starts new
 * store pairs only within it; cron invocations may run 15 minutes, and the
 * CPU limit is raised to 5 minutes in wrangler.jsonc (`limits.cpu_ms`).
 */
const CLUSTER_TICK_BUDGET_MS = 4 * 60 * 1000;

/** Most recent audit records kept; older ones are dropped. */
const MAX_AUDIT_RECORDS = 10_000;

/** The cluster audit log as rows of the server object's SQLite. */
class SqlClusterAuditStorage implements ClusterAuditStorage {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mindoo_cluster_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL)",
    );
  }

  appendLine(line: string): void {
    this.sql.exec("INSERT INTO mindoo_cluster_audit(line) VALUES(?)", line);
    this.sql.exec(
      "DELETE FROM mindoo_cluster_audit WHERE seq <= (SELECT MAX(seq) FROM mindoo_cluster_audit) - ?",
      MAX_AUDIT_RECORDS,
    );
  }

  readLines(): string[] {
    return this.sql
      .exec<{ line: string }>("SELECT line FROM mindoo_cluster_audit ORDER BY seq")
      .toArray()
      .map((row) => row.line);
  }
}

export class MindooServerObject {
  private readonly settings: HostSettings;
  private readonly dataStore: DurableObjectServerDataStore;
  private readonly tenantManager: TenantManager;
  private readonly capabilityMatcher: CapabilityMatcher;
  private readonly systemAdminAuth: SystemAdminAuthService;
  private readonly core: MindooDBServerCore;
  private serverConfig: ServerConfig;
  /** Change events of all tenants: peer replication and the peer event feed listen. */
  private readonly eventBus = new SyncEventBus();
  private cluster: ClusterManager | null = null;
  private clusterInit: Promise<ClusterManager> | null = null;
  private readonly localStores = new Map<string, ContentAddressedStore>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: MindooCloudflareEnv,
  ) {
    this.settings = createHostSettings(env);
    this.dataStore = new DurableObjectServerDataStore(ctx.storage.sql);
    seedServerIdentity(this.dataStore, env);

    const storedConfig = this.dataStore.readText(CONFIG_KEY);
    this.serverConfig = storedConfig !== null
      ? validateServerConfig(JSON.parse(storedConfig), CONFIG_KEY)
      : env.MINDOODB_SERVER_CONFIG
        ? validateServerConfig(JSON.parse(env.MINDOODB_SERVER_CONFIG), "MINDOODB_SERVER_CONFIG")
        : { capabilities: {} };

    const cryptoAdapter = new WorkersCryptoAdapter();
    this.tenantManager = new TenantManager({
      dataStore: this.dataStore,
      cryptoAdapter,
      serverPassword: env.MINDOODB_SERVER_PASSWORD,
      storeProvider: {
        createTenantStores: () => ({
          getStore: () => {
            throw new Error("The server object holds no entry stores");
          },
        }),
        listDatabases: () => [],
        // The tenant's databases live in their own objects; the tenant's
        // directory object knows them and wipes them.
        removeTenantStores: async (tenantId) => {
          const response = await databaseObject(env, tenantId, "directory").fetch(
            `${INTERNAL_ORIGIN}/internal/wipe`,
            { method: "POST", headers: internalHeaders(tenantId, "directory") },
          );
          if (!response.ok) {
            throw new Error(`Wiping tenant ${tenantId} failed with HTTP ${response.status}`);
          }
        },
      },
    });
    this.capabilityMatcher = new CapabilityMatcher(this.serverConfig);
    this.systemAdminAuth = new SystemAdminAuthService(cryptoAdapter, this.serverConfig, {
      isTenantAdminSigningKey: (publicsignkey) =>
        this.tenantManager.isRegisteredTenantAdminSigningKey(publicsignkey),
    });
    this.core = new MindooDBServerCore({
      tenantManager: this.tenantManager,
      systemAdminAuth: this.systemAdminAuth,
      capabilityMatcher: this.capabilityMatcher,
      deviceDiscovery: new DeviceDiscoveryService(this.tenantManager, cryptoAdapter),
      syncEvents: new SyncEventBus(),
      configRepository: new StoredServerConfigRepository(this.dataStore),
      getServerConfig: () => this.serverConfig,
      reloadConfig: (config) => {
        this.serverConfig = config;
        this.capabilityMatcher.reload(config);
        this.systemAdminAuth.reloadPrincipals(config);
      },
      tsaProviders: this.settings.tsaProviders,
      jsonBodyLimit: this.settings.jsonBodyLimit,
      allowInsecureSyncUrls: this.settings.allowInsecureSyncUrls,
      runInBackground: (task) => ctx.waitUntil(task),
      cluster: {
        mirrorsForTenant: (tenantId) => this.cluster?.mirrorsForTenant(tenantId) ?? [],
        syncReplicators: () => this.cluster?.syncReplicators(),
        resolvePeerName: async (token) => (await this.getCluster()).auth.validateToken(token).then((p) => p?.sub),
      },
    });
  }

  // ==================== Peer replication ====================

  private get autoSync(): boolean {
    return this.serverConfig.cluster?.autoSync === true;
  }

  /**
   * The cluster of this server: peer sessions and replicators, as on Node.
   * Local stores are the database objects' stores, reached by store RPC.
   * Replication runs on the cron tick and on reported writes instead of on a
   * long-lived event stream to each peer.
   */
  private getCluster(): Promise<ClusterManager> {
    if (this.cluster) return Promise.resolve(this.cluster);
    this.clusterInit ??= derivePeerJwtSecret(this.env).then((peerJwtSecret) => {
      const env = this.env;
      const tenantManager = this.tenantManager;
      this.cluster = new ClusterManager({
        cryptoAdapter: tenantManager.getCryptoAdapter(),
        auditStorage: new SqlClusterAuditStorage(this.ctx.storage.sql),
        eventBus: this.eventBus,
        peerJwtSecret,
        liveEventStream: false,
        // 128 MB per isolate: one small batch in flight (attachment chunks are
        // up to 256 KB, so a batch holds at most ~4 MB plus its copies).
        transferLimits: { maxConcurrentBatches: 1, docsBatchSize: 100, attachmentsBatchSize: 16 },
        localRole: this.serverConfig.cluster?.role,
        listTrustedServers: () => tenantManager.listTrustedServers(),
        localServerName: () => tenantManager.getServerPublicInfo()?.name ?? null,
        localSigningPublicKey: () => tenantManager.getServerPublicInfo()?.signingPublicKey ?? null,
        getSigningKey: async () => (await tenantManager.getWitnessSigner())?.signingPrivateKey,
        getEncryptionKey: () => tenantManager.getServerEncryptionPrivateKey(),
        listTenants: () => tenantManager.listTenants(),
        listDatabases: async (tenantId) => {
          const response = await databaseObject(env, tenantId, "directory").fetch(
            `${INTERNAL_ORIGIN}/internal/databases`,
            { headers: internalHeaders(tenantId, "directory") },
          );
          if (!response.ok) return ["directory"];
          return ((await response.json()) as { databases: string[] }).databases;
        },
        getLocalStore: async (tenantId, dbId, storeKind) => this.localStore(tenantId, dbId, storeKind),
        onDirectoryPulled: async (tenantId) => {
          await databaseObject(env, tenantId, "directory").fetch(
            `${INTERNAL_ORIGIN}/internal/directory/announce`,
            { method: "POST", headers: internalHeaders(tenantId, "directory") },
          );
        },
      });
      return this.cluster;
    });
    return this.clusterInit;
  }

  private localStore(tenantId: string, dbId: string, storeKind: StoreKind): ContentAddressedStore {
    const key = `${tenantId}\u0000${dbId}\u0000${storeKind}`;
    let store = this.localStores.get(key);
    if (!store) {
      store = remoteObjectStore(
        databaseObject(this.env, tenantId, dbId),
        internalHeaders(tenantId, dbId),
        tenantId,
        dbId,
        storeKind,
      );
      this.localStores.set(key, store);
    }
    return store;
  }

  /** Start replication when `config.json` enables it (`cluster.autoSync`). */
  private async startClusterIfEnabled(): Promise<ClusterManager> {
    const cluster = await this.getCluster();
    if (this.autoSync && !cluster.autoSyncEnabled) {
      cluster.start();
    }
    return cluster;
  }

  /**
   * Cron tick: one replication pass with every peer, within a time budget so
   * that a large first mirror stays inside the per-request CPU and subrequest
   * limits. What the budget does not cover continues on the next tick.
   */
  private async tick(): Promise<Response> {
    const cluster = await this.startClusterIfEnabled();
    let deferred = false;
    if (cluster.autoSyncEnabled) {
      ({ deferred } = await cluster.syncAll({ deadline: Date.now() + CLUSTER_TICK_BUDGET_MS }));
    }
    return jsonResponse(200, {
      autoSync: cluster.autoSyncEnabled,
      peers: cluster.status().peers.length,
      deferred,
    });
  }

  /** A database object accepted a write: tell peers (feed) and push to them. */
  private async localChange(request: Request): Promise<Response> {
    const event = (await request.json()) as SyncChangeEvent;
    this.eventBus.publish(event);
    const cluster = await this.startClusterIfEnabled();
    if (cluster.autoSyncEnabled) {
      await cluster.replicateLocalChange(event);
    }
    return jsonResponse(200, { ok: true });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof ParsedRejection) return error.response;
      console.error("[MindooServerObject] Request error:", error);
      return jsonResponse(500, { error: "Internal server error" });
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (isInternalCall(request)) {
      const internal = /^\/internal\/tenants\/([^/]+)$/.exec(url.pathname);
      if (internal) return this.tenantState(decodeURIComponent(internal[1]));
      if (url.pathname === "/internal/cluster/tick") return this.tick();
      if (url.pathname === "/internal/cluster/change") return this.localChange(request);
    }

    const route = matchRoute(request.method, url.pathname);
    switch (route.kind) {
      case "serverInfo":
        return toResponse(this.core.serverInfo());
      case "clusterMirrors":
        await this.startClusterIfEnabled();
        return toResponse(this.core.clusterMirrors(await this.parse(request, {})));
      case "peer":
        return this.peer(request, route.path);
      case "publicInfosFingerprints":
        return toResponse(
          await this.core.publicInfosFingerprints(await this.parse(request, { tenantId: route.tenantId })),
        );
      case "system":
        return this.system(request, route.path);
      default:
        return jsonResponse(404, { error: "Not found" });
    }
  }

  private async parse(request: Request, params: Record<string, string>): Promise<ServerRequest> {
    const parsed = await toServerRequest(request, {
      params,
      jsonBodyLimitBytes: this.settings.jsonBodyLimitBytes,
    });
    if (parsed instanceof Response) {
      throw new ParsedRejection(parsed);
    }
    return parsed;
  }

  /**
   * Config and `$publicinfos` keys of one tenant, for the objects serving its
   * databases. Only reachable from inside the Worker.
   */
  private async tenantState(rawTenantId: string): Promise<Response> {
    const tenantId = rawTenantId.toLowerCase();
    try {
      validateTenantIdFormat(tenantId);
    } catch {
      return jsonResponse(400, { error: "Invalid tenant ID format" });
    }
    if (!this.tenantManager.tenantExists(tenantId)) {
      return jsonResponse(200, { exists: false });
    }
    const config = JSON.parse(this.dataStore.readText(`${tenantId}/config.json`)!);
    const keys = await this.tenantManager.getPublicInfosKeysForTenant(tenantId);
    const trustedServers = this.tenantManager.listTrustedServers();
    return jsonResponse(200, {
      exists: true,
      config,
      publicInfosKeys: keys.map((key) => bytesToBase64(key)),
      trustedServers,
      clusterActive: this.autoSync && trustedServers.some((server) => Boolean(server.url)),
    });
  }

  /** `/system/*` with the routing and guards of the Node server's system router. */
  private async system(request: Request, path: string): Promise<Response> {
    {
      const method = request.method.toUpperCase();
      const segments = path.split("/").slice(2).map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
      const lower = segments.map((segment) => segment.toLowerCase());
      const clientIp = request.headers.get("x-mindoodb-client-ip") ?? "unknown";

      if (method === "POST" && lower.length === 2 && lower[0] === "auth") {
        const phase = lower[1] === "challenge" ? "challenge" : lower[1] === "authenticate" ? "authenticate" : null;
        if (phase) {
          const req = await this.parse(request, {});
          const limited = await rateLimited(
            this.env.MINDOODB_RATE_LIMIT_AUTH,
            buildAuthRateLimitKey("system", phase, undefined, clientIp, req.body),
            "Too many authentication attempts, please try again later",
          );
          if (limited) return limited;
          return toResponse(
            phase === "challenge"
              ? await this.core.systemChallenge(req)
              : await this.core.systemAuthenticate(req),
          );
        }
      }

      const cluster = lower[0] === "cluster";
      const handler = cluster
        ? this.clusterHandler(method, segments.slice(1), lower.slice(1), await this.startClusterIfEnabled())
        : this.systemHandler(method, segments, lower);
      if (!handler) {
        return jsonResponse(404, { error: "Not found" });
      }
      const req = await this.parse(request, handler.params);
      const rejection = await this.core.systemAdminGuard(req, path);
      if (rejection) return toResponse(rejection);
      return toResponse(await handler.run(req));
    }
  }

  private clusterHandler(
    method: string,
    segments: string[],
    lower: string[],
    cluster: ClusterManager,
  ): { params: Record<string, string>; run: (req: ServerRequest) => ServerResponse | Promise<ServerResponse> } | null {
    const handlers = new ClusterAdminHandlers({
      cluster,
      listTrustedServers: () => this.tenantManager.listTrustedServers(),
      saveTrustedServer: (peer) => this.tenantManager.saveTrustedServer(peer),
      removeTrustedServer: (name) => this.tenantManager.removeTrustedServer(name),
    });
    const [first, second, third] = lower;
    if (method === "GET" && lower.length === 1 && first === "topology") return { params: {}, run: () => handlers.topology() };
    if (method === "GET" && lower.length === 1 && first === "status") return { params: {}, run: () => handlers.status() };
    if (method === "GET" && lower.length === 3 && first === "status" && second === "tenants") {
      return { params: { tenantId: segments[2] }, run: (req) => handlers.tenantStatus(req) };
    }
    if (method === "GET" && lower.length === 1 && first === "jobs") return { params: {}, run: (req) => handlers.jobs(req) };
    if (method === "GET" && lower.length === 2 && first === "jobs") {
      return { params: { jobId: segments[1] }, run: (req) => handlers.job(req) };
    }
    if (method === "GET" && lower.length === 1 && first === "audit") return { params: {}, run: (req) => handlers.audit(req) };
    if (method === "POST" && lower.length === 2 && first === "actions") {
      return { params: { action: segments[1] }, run: (req) => handlers.action(req) };
    }
    if (lower.length === 1 && first === "peers" && method === "GET") return { params: {}, run: () => handlers.peers() };
    if (lower.length === 2 && first === "peers") {
      const params = { name: segments[1] };
      if (method === "POST") return { params, run: (req) => handlers.createPeer(req) };
      if (method === "PATCH") return { params, run: (req) => handlers.updatePeer(req) };
      if (method === "DELETE") return { params, run: (req) => handlers.deletePeer(req) };
    }
    void third;
    return null;
  }

  /** `/system/peer/*`: the server-to-server protocol, authenticated by peer tokens. */
  private async peer(request: Request, path: string): Promise<Response> {
    const cluster = await this.startClusterIfEnabled();
    const handlers = new PeerHttpHandlers({
      cluster,
      listTenants: () => this.tenantManager.listTenants(),
      listDatabases: async (tenantId) => {
        const response = await databaseObject(this.env, tenantId, "directory").fetch(
          `${INTERNAL_ORIGIN}/internal/databases`,
          { headers: internalHeaders(tenantId, "directory") },
        );
        return response.ok ? ((await response.json()) as { databases: string[] }).databases : [];
      },
    });
    const method = request.method.toUpperCase();
    const name = path.split("/")[3]?.toLowerCase() ?? "";
    const req = await this.parse(request, {});

    if (method === "POST" && name === "challenge") return toResponse(await handlers.challenge(req));
    if (method === "POST" && name === "authenticate") return toResponse(await handlers.authenticate(req));

    const known =
      (method === "POST" && (name === "tenant-bloom" || name === "sync")) ||
      (method === "GET" && (name === "databases" || name === "events"));
    if (!known) return jsonResponse(404, { error: "Not found" });
    const rejection = await handlers.peerGuard(req);
    if (rejection) return toResponse(rejection);

    switch (name) {
      case "tenant-bloom":
        return toResponse(handlers.tenantBloom(req));
      case "databases":
        return toResponse(await handlers.databases(req));
      case "sync":
        return toResponse(handlers.sync(req, (task) => this.ctx.waitUntil(task)));
      default:
        return this.peerEventStream(cluster, req.peerName!);
    }
  }

  /** Change feed for a peer (Node peers keep it open to pull our writes promptly). */
  private peerEventStream(cluster: ClusterManager, peerName: string): Response {
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
      if (!closed) writer.write(encoder.encode(frame)).catch(cleanup);
    };
    write(formatSyncHelloEvent());
    const unsubscribe = this.eventBus.subscribe((event) => {
      const frame = formatPeerChangeEvent(cluster, peerName, event);
      if (frame) write(frame);
    });
    const heartbeat = setInterval(() => write(formatSyncHeartbeat(Date.now())), SYNC_EVENT_HEARTBEAT_MS);
    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  private systemHandler(
    method: string,
    segments: string[],
    lower: string[],
  ): { params: Record<string, string>; run: (req: ServerRequest) => ServerResponse | Promise<ServerResponse> } | null {
    const core = this.core;
    if (lower[0] === "tenants") {
      if (lower.length === 1 && method === "GET") return { params: {}, run: () => core.listTenants() };
      if (lower.length === 2) {
        const params = { tenantId: segments[1] };
        if (method === "POST") return { params, run: (req) => core.registerTenant(req) };
        if (method === "PUT") return { params, run: (req) => core.updateTenant(req) };
        if (method === "DELETE") return { params, run: (req) => core.deleteTenant(req) };
      }
    }
    if (lower[0] === "trusted-servers") {
      if (lower.length === 1 && method === "GET") return { params: {}, run: () => core.listTrustedServers() };
      if (lower.length === 1 && method === "POST") return { params: {}, run: (req) => core.addTrustedServer(req) };
      if (lower.length === 2 && method === "DELETE") {
        return { params: { serverName: segments[1] }, run: (req) => core.removeTrustedServer(req) };
      }
    }
    if (lower[0] === "config") {
      if (lower.length === 1 && method === "GET") return { params: {}, run: () => core.getConfig() };
      if (lower.length === 1 && method === "PUT") return { params: {}, run: (req) => core.updateConfig(req) };
      if (lower.length === 2 && lower[1] === "backups" && method === "GET") {
        return { params: {}, run: () => core.listConfigBackups() };
      }
      if (lower.length === 3 && lower[1] === "backups" && method === "GET") {
        return { params: { backupFile: segments[2] }, run: (req) => core.getConfigBackup(req) };
      }
    }
    return null;
  }
}

/** A request the body parser refused; carries the response to send. */
class ParsedRejection extends Error {
  constructor(readonly response: Response) {
    super("request rejected while parsing");
  }
}
