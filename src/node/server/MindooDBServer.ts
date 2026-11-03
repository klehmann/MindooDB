/**
 * MindooDB Server - Express HTTP server implementing the sync API.
 *
 * The route handlers themselves are platform-neutral and live in
 * {@link MindooDBServerCore} (`src/server/http`); this class is the Node host:
 * it wires the server's components, mounts the handlers on Express and adds
 * what only a Node process provides — HTTP/2 + TLS, static files, Iroh, the
 * peer and cluster routers, and the middleware stack below.
 *
 * Security features:
 * - Capabilities-based system admin authorization via config.json
 * - Challenge/response (Ed25519) authentication for /system/* endpoints
 * - JWT-based session management for system admins
 * - Input validation on all identifiers (path traversal prevention)
 * - Rate limiting per endpoint tier
 * - Security headers (helmet) and CORS
 * - Error sanitization (no internal details leaked)
 * - Request size limits and timeouts
 */

import express, { Request, Response, NextFunction, Router } from "express";
import http2 from "http2";
import path from "path";
import { readFileSync, existsSync } from "fs";
import helmet from "helmet";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { jsonCompressionMiddleware } from "./compressionMiddleware";
import { SyncEventBus } from "../../server/SyncEventBus";
import { ClusterManager } from "./peer/ClusterManager";
import { createClusterRouter, createPeerRouter } from "./peer/routes";
import { StoreKind } from "../../core/appendonlystores/types";

import { TenantManager } from "./TenantManager";
import { CapabilityMatcher } from "../../server/CapabilityMatcher";
import { SystemAdminAuthService } from "../../server/SystemAdminAuth";
import { DeviceDiscoveryService } from "../../server/DeviceDiscoveryService";
import { FileServerConfigRepository } from "./config";
import {
  isSystemIpAllowListDisabled,
  readSystemIpAllowListFromEnv,
  systemIpAllowlistMiddleware,
} from "./SystemIpAllowlist";
import type { ServerConfig } from "../../server/types";
import { createMindooDBServerIrohHandler } from "./IrohServerRpc";
import { IrohServerEndpoint } from "./IrohServerEndpoint";
import { ENV_VARS } from "../../server/types";
import {
  MAX_TIMESTAMP_REQUEST_BYTES,
  parseTsaProviders,
  TIMESTAMP_QUERY_CONTENT_TYPE,
  type TsaProviderConfig,
} from "../../server/timestampProxy";
import {
  buildAuthRateLimitKey,
  buildSyncRateLimitKey,
  buildTimestampRateLimitKey,
  resolveServerRateLimits,
  TIMESTAMP_DAILY_WINDOW_MS,
  type ResolvedRateLimit,
} from "../../server/rateLimits";
import {
  formatSyncChangeEvent,
  formatSyncHeartbeat,
  formatSyncHelloEvent,
  MindooDBServerCore,
  SYNC_EVENT_HEARTBEAT_MS,
  SYNC_ROUTES,
  SYNC_STORE_KINDS,
} from "../../server/http/MindooDBServerCore";
import { guard, route, sendServerResponse, toServerRequest } from "./expressAdapter";
import { isEventStreamResponse, type SyncEventStreamSpec } from "../../server/http/types";

/**
 * Augment Express Request with fields populated by our middleware:
 * - tenantId: set by the tenant guard after validating the :tenantId URL param
 * - systemAdmin: set by the system admin guard after JWT verification
 * - jsonBodyBytes: raw byte count captured during JSON body parsing (for diagnostics)
 */
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      systemAdmin?: { username: string; publicsignkey: string };
      jsonBodyBytes?: number;
      /** Set by the timestamp auth guard; identifies the caller for per-identity throttling. */
      timestampPrincipal?: string;
      /** Set by the sync principal pass; identifies the caller for per-identity throttling. */
      syncPrincipal?: string;
    }
  }
}

const DEFAULT_SERVER_SOCKET_TIMEOUT_MS = 120_000;

export class MindooDBServer {
  private app: express.Application;
  /** In-process change feed backing the SSE endpoint (sync-v5, phase 5). */
  private syncEventBus: SyncEventBus;
  private tenantManager: TenantManager;
  private capabilityMatcher: CapabilityMatcher;
  private systemAdminAuth: SystemAdminAuthService;
  private deviceDiscovery: DeviceDiscoveryService;
  /** Peer sessions, replicators, cluster jobs and the audit log. */
  private cluster: ClusterManager;
  /** The platform-neutral route handlers. */
  private core: MindooDBServerCore;
  private readonly staticDir: string | undefined;
  private serverConfig: ServerConfig;
  private configPath: string;
  private readonly jsonBodyLimit: string;
  /**
   * Upstream TSAs the proxy may contact. Populated only from server env config —
   * a client names a provider by id, never by URL, so this list is the whole
   * SSRF boundary for the timestamp proxy.
   */
  private readonly tsaProviders: TsaProviderConfig[];
  private readonly irohEndpoint = new IrohServerEndpoint();

  /**
   * @param dataDir      Root directory for on-disk tenant data and server identity
   * @param serverPassword  Password used to decrypt the server identity private keys
   *                        and per-tenant key bags at startup
   * @param staticDir    Optional directory served at /statics/ (e.g. the Haven web UI)
   * @param config       Pre-loaded ServerConfig; when omitted, an empty config
   *                     is used (all /system/* endpoints locked down)
   * @param configPath   Explicit path to config.json; defaults to `<dataDir>/config.json`
   */
  constructor(
    dataDir: string,
    serverPassword?: string,
    staticDir?: string,
    config?: ServerConfig,
    configPath?: string,
  ) {
    this.app = express();
    this.syncEventBus = new SyncEventBus();
    this.tenantManager = new TenantManager(dataDir, serverPassword);
    this.staticDir = staticDir;
    this.configPath = configPath ?? path.join(dataDir, "config.json");
    this.jsonBodyLimit = process.env.MINDOODB_JSON_BODY_LIMIT?.trim() || "5mb";
    const allowInsecureSyncUrls = /^(1|true)$/i.test(
      process.env[ENV_VARS.ALLOW_INSECURE_SYNC_URLS] ?? "",
    );

    this.tsaProviders = parseTsaProviders(process.env[ENV_VARS.TSA_PROVIDERS], {
      allowInsecureUrls: allowInsecureSyncUrls,
    });
    if (this.tsaProviders.length > 0) {
      console.log(
        `[MindooDBServer] RFC 3161 timestamp proxy enabled with providers: ${this.tsaProviders
          .map((provider) => provider.id)
          .join(", ")}`,
      );
    }

    this.serverConfig = config ?? { capabilities: {} };
    this.capabilityMatcher = new CapabilityMatcher(this.serverConfig);

    // SystemAdminAuthService generates a random HMAC-SHA256 secret for JWTs
    // on each server start — existing tokens become invalid after restart.
    const cryptoAdapter = this.tenantManager.getCryptoAdapter();
    this.systemAdminAuth = new SystemAdminAuthService(
      cryptoAdapter,
      this.serverConfig,
      {
        isTenantAdminSigningKey: (publicsignkey) =>
          this.tenantManager.isRegisteredTenantAdminSigningKey(publicsignkey),
      },
    );
    this.deviceDiscovery = new DeviceDiscoveryService(
      this.tenantManager,
      cryptoAdapter,
    );
    this.cluster = new ClusterManager({
      cryptoAdapter,
      dataDir,
      eventBus: this.syncEventBus,
      listTrustedServers: () => this.tenantManager.listTrustedServers(),
      localServerName: () => this.tenantManager.getServerPublicInfo()?.name ?? null,
      localSigningPublicKey: () =>
        this.tenantManager.getServerPublicInfo()?.signingPublicKey ?? null,
      getSigningKey: async () => (await this.tenantManager.getWitnessSigner())?.signingPrivateKey,
      getEncryptionKey: () => this.tenantManager.getServerEncryptionPrivateKey(),
      listTenants: () => this.tenantManager.listTenants(),
      listDatabases: (tenantId) => this.tenantManager.listDatabases(tenantId),
      getLocalStore: (tenantId, dbId, storeKind) =>
        this.tenantManager.getStore(tenantId, dbId, storeKind),
      getPurgedDocIds: (tenantId, dbId) =>
        this.tenantManager.getPurgedDocIds(tenantId, dbId),
      onDirectoryPulled: (tenantId) => this.tenantManager.executePendingPurges(tenantId),
      localRole: this.serverConfig.cluster?.role,
      getIrohStreamIO: () => this.irohEndpoint.getStreamIO(),
    });
    // Peer tokens are accepted by the tenant sync routes so a peer can mirror
    // the encrypted stores through the ordinary protocol; the store bypasses
    // per-user access control for them (see ServerNetworkContentAddressedStore).
    this.tenantManager.setPeerAccessControl({
      peerTokenResolver: async (token) => {
        const payload = await this.cluster.auth.validateToken(token);
        if (!payload) return null;
        const trusted = this.cluster.auth.findTrustedServerByKey(payload.publicsignkey);
        if (!trusted) return null;
        return {
          name: trusted.name,
          signingPublicKey: trusted.signingPublicKey,
          encryptionPublicKey: trusted.encryptionPublicKey,
        };
      },
      trustedWitnessResolver: (receivedByPublicKey) =>
        this.cluster.auth.findTrustedServerByKey(receivedByPublicKey) !== null,
    });

    this.core = new MindooDBServerCore({
      tenantManager: this.tenantManager,
      systemAdminAuth: this.systemAdminAuth,
      capabilityMatcher: this.capabilityMatcher,
      deviceDiscovery: this.deviceDiscovery,
      syncEvents: this.syncEventBus,
      configRepository: new FileServerConfigRepository(this.configPath),
      getServerConfig: () => this.serverConfig,
      reloadConfig: (newConfig) => this.reloadConfig(newConfig),
      tsaProviders: this.tsaProviders,
      jsonBodyLimit: this.jsonBodyLimit,
      allowInsecureSyncUrls,
      cluster: {
        mirrorsForTenant: (tenantId) => this.cluster.mirrorsForTenant(tenantId),
        syncReplicators: () => this.cluster.syncReplicators(),
        resolvePeerName: (token) =>
          this.cluster.auth.validateToken(token).then((payload) => payload?.sub),
      },
    });

    const principalCount = Object.values(this.serverConfig.capabilities).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    if (principalCount === 0) {
      console.log(`[MindooDBServer] WARNING: No system admin principals configured. All /system/* endpoints are locked down.`);
    } else {
      console.log(`[MindooDBServer] System admin auth configured with ${principalCount} principal(s)`);
    }

    this.setupMiddleware();
    this.setupRoutes();
  }

  getApp(): express.Application {
    return this.app;
  }

  getTenantManager(): TenantManager {
    return this.tenantManager;
  }

  getSystemAdminAuth(): SystemAdminAuthService {
    return this.systemAdminAuth;
  }

  getClusterManager(): ClusterManager {
    return this.cluster;
  }

  /**
   * Begin replicating with every trusted server that has a `url`.
   *
   * Separate from the constructor so a server can serve the peer and cluster
   * endpoints — answering handshakes, status and admin actions — without
   * dialling out itself. That is what `--auto-sync` toggles, and it is what
   * makes a passive mirror or a test harness possible.
   */
  startCluster(): void {
    this.cluster.start();
  }

  async stopCluster(): Promise<void> {
    await this.cluster.stop();
  }

  getServerConfig(): ServerConfig {
    return this.serverConfig;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Hot-swap the server config without restarting. In-flight JWTs remain
   * valid (same HMAC secret), but removed principals will fail the
   * CapabilityMatcher check on their next request.
   */
  reloadConfig(newConfig: ServerConfig): void {
    this.serverConfig = newConfig;
    this.capabilityMatcher.reload(newConfig);
    this.systemAdminAuth.reloadPrincipals(newConfig);
  }

  listen(port: number, host = "0.0.0.0"): void {
    const server = this.app.listen(port, host, () => {
      console.log(`[MindooDBServer] Listening on ${host}:${port}`);
    });

    server.setTimeout(DEFAULT_SERVER_SOCKET_TIMEOUT_MS);
    void this.startIrohIfEnabled();
  }

  /**
   * Start the server with TLS using HTTP/2 (with automatic HTTP/1.1 ALPN
   * fallback for clients that don't support h2). Express is mounted as the
   * raw handler because http2.createSecureServer doesn't natively integrate
   * with Express; the `as unknown` casts bridge the type gap.
   */
  listenTls(port: number, certPath: string, keyPath: string): void {
    const tlsOptions = {
      allowHTTP1: true,
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
    const server = http2.createSecureServer(tlsOptions, (req, res) => {
      this.app(req as unknown as express.Request, res as unknown as express.Response);
    });
    server.listen(port, "0.0.0.0", () => {
      console.log(`[MindooDBServer] Listening on HTTPS 0.0.0.0:${port} with HTTP/2 enabled (HTTP/1 fallback active)`);
    });

    server.setTimeout(DEFAULT_SERVER_SOCKET_TIMEOUT_MS);
    void this.startIrohIfEnabled();
  }

  getIrohStatus() {
    return this.irohEndpoint.getStatus();
  }

  getIrohStreamIO() {
    return this.irohEndpoint.getStreamIO();
  }

  async stopIroh(): Promise<void> {
    await this.irohEndpoint.stopListening();
  }

  getSyncEventListenerCount(): number {
    return this.syncEventBus.listenerCount;
  }

  async startIrohIfEnabled(): Promise<void> {
    const irohConfig = this.serverConfig.iroh;
    if (!irohConfig?.enabled) {
      return;
    }
    try {
      await this.irohEndpoint.start({
        dataDir: this.tenantManager.getDataDir(),
        config: irohConfig,
        handler: createMindooDBServerIrohHandler({
          getServerPublicInfo: () => this.tenantManager.getServerPublicInfo(),
          getJsonBodyLimit: () => this.core.getJsonBodyLimit(),
          getClusterRole: () => this.serverConfig.cluster?.role ?? "peer",
          listTenantPublicInfosFingerprints: (tenantId) =>
            this.tenantManager.listTenantPublicInfosFingerprints(tenantId),
          getAuthService: (tenantId) => this.tenantManager.getAuthService(tenantId),
          getServerStore: (tenantId, dbId, storeKind) =>
            this.tenantManager.getServerStore(tenantId, dbId, storeKind),
          systemAdmin: {
            generateChallenge: (username, publicsignkey) =>
              this.systemAdminAuth.generateChallenge(username, publicsignkey),
            authenticate: (challenge, signature) =>
              this.systemAdminAuth.authenticate(challenge, signature),
            validateToken: (token) => this.systemAdminAuth.validateToken(token),
            isAuthorized: (method, path, username, publicsignkey) =>
              this.capabilityMatcher.isAuthorized(method, path, username, publicsignkey),
            registerTenant: (request) => this.tenantManager.registerTenant(request),
          },
          syncEventBus: this.syncEventBus,
          peerAuth: {
            generateChallenge: (publicsignkey) => this.cluster.auth.generateChallenge(publicsignkey),
            authenticate: (challenge, signature) => this.cluster.auth.authenticate(challenge, signature),
            validateToken: (token) => this.cluster.auth.validateToken(token),
          },
          peerCluster: {
            recordPeerIntersection: (peerName, tenantIds) =>
              this.cluster.recordPeerIntersection(peerName, tenantIds),
            peerMaySeeTenant: (peerName, tenantId) => this.cluster.peerMaySeeTenant(peerName, tenantId),
            listTenants: () => this.tenantManager.listTenants(),
            listDatabases: (tenantId) => this.tenantManager.listDatabases(tenantId),
            requestSync: (peerName, scope) => {
              const replicator = this.cluster.getReplicator(peerName);
              if (!replicator) {
                throw new Error(
                  `No outbound session configured for peer ${peerName} (missing url in trusted-servers.json)`,
                );
              }
              void replicator.syncNow(scope).catch(() => undefined);
            },
          },
        }),
      });
    } catch (error) {
      console.error("[MindooDBServer] Failed to start Iroh listener:", error);
    }
  }

  /** Every limiter tier, resolved against the current config.json. */
  private rateLimitPolicy() {
    return resolveServerRateLimits(this.serverConfig.rateLimits);
  }

  /**
   * Global middleware stack applied to every request, in order:
   * 1. helmet — security headers (CSP, X-Frame-Options, etc.)
   * 2. cors — controlled cross-origin access for web clients (e.g. Haven)
   * 3. global rate limit — coarse IP-based throttle as a safety net;
   *    individual route tiers (auth, sync, system) provide finer control
   * 4. JSON body parser — captures raw byte size for diagnostics
   * 5. request logger
   */
  private setupMiddleware(): void {
    this.applyTrustProxySetting();
    this.app.use(helmet());

    const corsOrigin = this.readCorsOriginsFromEnv();
    this.app.use(cors({
      origin: corsOrigin || false,
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }));

    const globalRateLimitConfig = this.getGlobalRateLimitConfig();
    console.log(
      `[MindooDBServer] Global rate limit configured windowMs=${globalRateLimitConfig.windowMs} max=${globalRateLimitConfig.max}`,
    );
    this.app.use(rateLimit({
      windowMs: globalRateLimitConfig.windowMs,
      max: globalRateLimitConfig.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later" },
    }));

    // Response compression (sync-v5, phase 3): brotli/gzip for JSON bodies
    // >= 1 KB. Metadata-heavy sync responses shrink 5-10x.
    this.app.use(jsonCompressionMiddleware);

    this.app.use(express.json({
      limit: this.jsonBodyLimit,
      verify: (req, _res, buf) => {
        (req as Request).jsonBodyBytes = buf.length;
      },
    }));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const contentType = req.headers["content-type"] ?? "-";
      const contentLength = req.headers["content-length"] ?? "-";
      console.log(
        `[${new Date().toISOString()}] HTTP/${req.httpVersion} ${req.method} ${req.path} content-type=${contentType} content-length=${contentLength}`,
      );
      next();
    });
  }

  /**
   * Teach Express which upstream hops to trust for `X-Forwarded-For`, so
   * `req.ip` is the client rather than the proxy. Every rate limiter keys on
   * `req.ip`; without this, a deployment behind Cloudflare or nginx puts all
   * of its users in one bucket and the first busy client locks out the rest.
   *
   * `MINDOODB_TRUST_PROXY` takes the Express `trust proxy` values: a hop count
   * (`1` for Cloudflare only, `2` when nginx also fronts the origin), a
   * comma-separated list of trusted addresses/CIDRs, or `loopback`. Off by
   * default, because trusting a header nobody strips lets a client spoof its
   * own address and mint unlimited budgets. Prefer a hop count or an address
   * list over `true`, which trusts the whole chain.
   */
  private applyTrustProxySetting(): void {
    const raw = process.env[ENV_VARS.TRUST_PROXY]?.trim();
    if (!raw || /^(0|false)$/i.test(raw)) {
      return;
    }

    const hops = Number(raw);
    const value: number | boolean | string[] = Number.isInteger(hops) && hops >= 0
      ? hops
      : /^true$/i.test(raw)
        ? true
        : raw.split(",").map((entry) => entry.trim()).filter(Boolean);

    this.app.set("trust proxy", value);
    if (value === true) {
      console.warn(
        "[MindooDBServer] MINDOODB_TRUST_PROXY=true trusts the entire forwarding chain; " +
        "a client can then spoof X-Forwarded-For and bypass per-IP rate limits. " +
        "Set a hop count (e.g. 1 behind Cloudflare) or a trusted address list instead.",
      );
    } else {
      console.log(`[MindooDBServer] trust proxy set to ${JSON.stringify(value)}`);
    }
  }

  /** Parse MINDOODB_CORS_ORIGIN env var; supports comma-separated multiple origins. */
  private readCorsOriginsFromEnv(): string | string[] | undefined {
    const raw = process.env.MINDOODB_CORS_ORIGIN?.trim();
    if (!raw) {
      return undefined;
    }
    const origins = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (origins.length <= 1) {
      return origins[0];
    }
    return origins;
  }

  /**
   * Route hierarchy:
   *  /                         — redirect to static UI (if present)
   *  /health                   — unauthenticated health probe
   *  /.well-known/*            — public discovery endpoints (server info, tenant fingerprints)
   *  /statics/*                — optional static file serving (Haven web UI)
   *  /system/*                 — admin API: IP-allowlisted, JWT-authenticated, capability-checked
   *  /:tenantId/*              — per-tenant sync & auth API
   */
  private setupRoutes(): void {
    const core = this.core;

    this.app.get("/", (req: Request, res: Response) => {
      if (this.staticDir && existsSync(path.join(this.staticDir, "index.html"))) {
        res.redirect(302, "/statics/index.html");
      } else {
        res.status(404).json({ error: "Not found" });
      }
    });

    this.app.get("/health", route(() => core.health()));

    // Server-wide device discovery (before /:tenantId so "device" is not a tenant id).
    // Aggressive rate limit: challenge+discover scans every local tenant.
    const deviceLimit = this.rateLimitPolicy().device;
    const deviceDiscoveryRateLimit = rateLimit({
      windowMs: deviceLimit.windowMs,
      max: deviceLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many device discovery requests, please try again later" },
    });
    this.app.post(
      "/device/challenge",
      deviceDiscoveryRateLimit,
      route((req) => core.deviceChallenge(req)),
    );
    this.app.post(
      "/device/discover",
      deviceDiscoveryRateLimit,
      route((req) => core.deviceDiscover(req)),
    );

    // .well-known endpoints are unauthenticated so clients can discover
    // server identity and tenant availability before attempting to authenticate.
    this.app.get("/.well-known/mindoodb-server-info", route(() => core.serverInfo()));
    this.app.get("/.well-known/mindoodb-cluster", route((req) => core.clusterMirrors(req)));
    this.app.get(
      "/.well-known/mindoodb-tenants/:tenantId/publicinfos-fingerprints",
      route((req) => core.publicInfosFingerprints(req)),
    );

    // Static file serving
    if (this.staticDir) {
      const resolvedStaticDir = path.resolve(this.staticDir);
      this.app.use("/statics", (req: Request, res: Response, next: NextFunction) => {
        if (req.path.includes("..")) {
          res.status(400).json({ error: "Invalid path" });
          return;
        }
        next();
      }, express.static(resolvedStaticDir, { dotfiles: "deny", etag: true }));
      console.log(`[MindooDBServer] Serving static files from ${resolvedStaticDir} at /statics/`);
    }

    // /system/* admin routes are protected by three layers (applied in order):
    //  1. IP allowlist — optional whitelist via MINDOODB_ADMIN_ALLOWED_IPS env var
    //  2. Rate limit  — aggressive per-IP throttle (30 req/min)
    //  3. JWT auth    — applied per-route (auth endpoints exempt; they *produce* JWTs)
    const systemIpRaw = readSystemIpAllowListFromEnv();
    if (!isSystemIpAllowListDisabled(systemIpRaw)) {
      console.log(
        `[MindooDBServer] MINDOODB_ADMIN_ALLOWED_IPS is set — /system/* limited to: ${systemIpRaw}`,
      );
    }

    const systemLimit = this.rateLimitPolicy().system;
    const systemRateLimit = rateLimit({
      windowMs: systemLimit.windowMs,
      max: systemLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many system requests, please try again later" },
    });

    // Peer routes are mounted before the /system chain on purpose. They are
    // server-to-server traffic, not administration: the admin IP allowlist
    // would lock out the operator's own cluster, and 30 req/min would throttle
    // replication to a crawl. They are protected by the peer JWT, which is only
    // issued to a key in trusted-servers.json.
    const peerLimit = this.rateLimitPolicy().peer;
    this.app.use(
      "/system/peer",
      rateLimit({
        windowMs: peerLimit.windowMs,
        max: peerLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many peer requests, please try again later" },
      }),
      createPeerRouter({
        cluster: this.cluster,
        eventBus: this.syncEventBus,
        listTenants: () => this.tenantManager.listTenants(),
        listDatabases: (tenantId) => this.tenantManager.listDatabases(tenantId),
      }),
    );

    const systemRouter = Router();
    this.setupSystemRoutes(systemRouter);
    this.app.use(
      "/system",
      systemIpAllowlistMiddleware,
      systemRateLimit,
      systemRouter,
    );

    // Tenant-scoped routes: the tenant guard validates the :tenantId param
    // and rejects unknown tenants before any handler runs.
    this.app.use(
      "/:tenantId",
      guard((req) => core.tenantGuard(req)),
      this.createTenantRouter(),
    );

    // Express error handler — must be registered last and have the 4-arg signature
    this.app.use(this.errorHandler.bind(this));
  }

  // ==================== System Routes ====================

  /**
   * Wire up all /system/* routes. Auth endpoints sit outside the JWT
   * middleware because they implement the challenge-response handshake
   * that *produces* the JWT. Every other route requires a valid JWT and
   * passes through the CapabilityMatcher for fine-grained authorization.
   */
  private setupSystemRoutes(router: Router): void {
    const core = this.core;
    const challengeRateLimit = this.createAuthRateLimit("system", "challenge");
    const authenticateRateLimit = this.createAuthRateLimit("system", "authenticate");

    router.post("/auth/challenge", challengeRateLimit, route((req) => core.systemChallenge(req)));
    router.post("/auth/authenticate", authenticateRateLimit, route((req) => core.systemAuthenticate(req)));

    // Capabilities are matched against "/system" + the path relative to the
    // mount the middleware runs under (req.path).
    const authMiddleware = (req: Request, res: Response, next: NextFunction) =>
      guard((serverRequest) => core.systemAdminGuard(serverRequest, `/system${req.path}`))(
        req,
        res,
        next,
      );

    // Cluster administration. Behind the same JWT + capability middleware as
    // the rest of /system, so config.json can grant an auditor principal the
    // GET routes without granting the POST/PATCH/DELETE ones.
    router.use(
      "/cluster",
      authMiddleware,
      createClusterRouter({
        cluster: this.cluster,
        listTrustedServers: () => this.tenantManager.listTrustedServers(),
        saveTrustedServer: (peer) => this.tenantManager.saveTrustedServer(peer),
        removeTrustedServer: (name) => this.tenantManager.removeTrustedServer(name),
      }),
    );

    // Tenant CRUD
    router.get("/tenants", authMiddleware, route(() => core.listTenants()));
    router.post("/tenants/:tenantId", authMiddleware, route((req) => core.registerTenant(req)));
    router.put("/tenants/:tenantId", authMiddleware, route((req) => core.updateTenant(req)));
    router.delete("/tenants/:tenantId", authMiddleware, route((req) => core.deleteTenant(req)));

    // Trusted server management
    router.get("/trusted-servers", authMiddleware, route(() => core.listTrustedServers()));
    router.post("/trusted-servers", authMiddleware, route((req) => core.addTrustedServer(req)));
    router.delete(
      "/trusted-servers/:serverName",
      authMiddleware,
      route((req) => core.removeTrustedServer(req)),
    );

    // Runtime config management
    router.get("/config/backups", authMiddleware, route(() => core.listConfigBackups()));
    router.get(
      "/config/backups/:backupFile",
      authMiddleware,
      route((req) => core.getConfigBackup(req)),
    );
    router.get("/config", authMiddleware, route(() => core.getConfig()));
    router.put("/config", authMiddleware, route((req) => core.updateConfig(req)));
  }

  // ==================== Tenant Routes ====================

  /**
   * Build the per-tenant router. Rate limiters are scoped: auth and sync
   * endpoints both use a per-user composite key (see createAuthRateLimit and
   * createSyncRateLimit), sync with a much higher ceiling.
   *
   * Both "docs" and "attachments" store kinds expose the same set of sync
   * operations (SYNC_ROUTES), mounted at /sync/docs/* and /sync/attachments/*.
   */
  private createTenantRouter(): Router {
    const core = this.core;
    const router = Router({ mergeParams: true });
    const authRateLimitConfig = this.getAuthRateLimitConfig();

    const challengeRateLimit = this.createAuthRateLimit("tenant", "challenge");
    const authenticateRateLimit = this.createAuthRateLimit("tenant", "authenticate");

    // Identity resolution precedes the limiter so it can key on the caller.
    const syncGuards = [
      guard(async (req) => {
        await core.resolveSyncPrincipal(req);
        return null;
      }),
      this.createSyncRateLimit(),
    ];

    console.log(
      `[MindooDBServer] Tenant auth rate limit configured windowMs=${authRateLimitConfig.windowMs} max=${authRateLimitConfig.max}`,
    );

    router.post("/auth/challenge", challengeRateLimit, route((req) => core.challenge(req)));
    router.post("/auth/authenticate", authenticateRateLimit, route((req) => core.authenticate(req)));

    // RFC 3161 proxy. Authentication runs *before* the limiters so they can key
    // on the identity rather than only the IP — otherwise everyone behind one
    // NAT shares a budget, and a single tenant can lock out the rest.
    router.post(
      "/timestamps/rfc3161",
      guard((req) => core.timestampAuthGuard(req)),
      this.createTimestampRateLimit("burst"),
      this.createTimestampRateLimit("daily"),
      express.raw({ type: TIMESTAMP_QUERY_CONTENT_TYPE, limit: MAX_TIMESTAMP_REQUEST_BYTES }),
      route((req) => core.timestampRequest(req)),
    );

    for (const storeKind of SYNC_STORE_KINDS) {
      for (const syncRoute of SYNC_ROUTES) {
        const routePath = `/sync/${storeKind}/${syncRoute.name}`;
        const handlers = [...syncGuards];
        if ("rawBodyType" in syncRoute) {
          // The global JSON parser only handles application/json.
          handlers.push(express.raw({ type: syncRoute.rawBodyType, limit: this.jsonBodyLimit }));
        }
        handlers.push(
          syncRoute.name === "events"
            ? (req: Request, res: Response, next: NextFunction) =>
                this.handleSyncEvents(storeKind, req, res).catch(next)
            : route((req) => core.sync(syncRoute.name, req, storeKind)),
        );
        if (syncRoute.method === "GET") {
          router.get(routePath, handlers);
        } else {
          router.post(routePath, handlers);
        }
      }
    }

    return router;
  }

  /**
   * Resolved global rate-limit config. The default leaves room for the sync
   * and auth tiers to spend their full budgets inside the global window, so
   * the net catches only traffic no tier claims.
   */
  private getGlobalRateLimitConfig(): ResolvedRateLimit {
    const resolved = this.rateLimitPolicy().global;
    if (resolved.shadowsTiers) {
      console.warn(
        `[MindooDBServer] rateLimits.global.max=${resolved.max} is below the ${resolved.tierFloor} ` +
        "requests the sync and auth tiers may spend in the same window; the global limiter " +
        "will reject requests those tiers still allow.",
      );
    }
    return { windowMs: resolved.windowMs, max: resolved.max };
  }

  /** Resolved auth rate-limit config; falls back to defaults when not set in config.json. */
  private getAuthRateLimitConfig(): ResolvedRateLimit {
    return this.rateLimitPolicy().auth;
  }

  /**
   * Two limiters guard the timestamp proxy: a short burst window that keeps a
   * misbehaving client from hammering an upstream, and a daily cap that bounds
   * total consumption of a shared (often free) upstream allowance.
   *
   * Both key on tenant + principal + IP. The principal is present because the
   * timestamp auth guard runs first.
   */
  private createTimestampRateLimit(tier: "burst" | "daily") {
    const config = this.rateLimitPolicy().timestamp;
    const windowMs = tier === "burst" ? config.windowMs : TIMESTAMP_DAILY_WINDOW_MS;
    const max = tier === "burst" ? config.max : config.dailyMax;
    return rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) =>
        buildTimestampRateLimitKey(
          tier,
          req.tenantId,
          req.timestampPrincipal,
          this.getClientIpForRateLimit(req),
        ),
      handler: (req, res, _next, options) => {
        console.warn(
          `[MindooDBServer] Timestamp rate limit hit (${tier}) tenant=${req.tenantId} ip=${req.ip}`,
        );
        res.status(options.statusCode).json(options.message);
      },
      message: {
        error:
          tier === "burst"
            ? "Too many timestamp requests, please try again shortly"
            : "Daily timestamp quota exhausted for this server",
      },
    });
  }

  /**
   * Sync budget, keyed on tenant + principal + IP like the auth and timestamp
   * tiers. Address-only keying would put every user behind one NAT or reverse
   * proxy in a single bucket, so one client opening several databases would
   * throttle everyone else on that address.
   */
  private createSyncRateLimit() {
    const config = this.rateLimitPolicy().sync;
    console.log(
      `[MindooDBServer] Tenant sync rate limit configured windowMs=${config.windowMs} max=${config.max}`,
    );
    return rateLimit({
      windowMs: config.windowMs,
      max: config.max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) =>
        buildSyncRateLimitKey(
          req.tenantId,
          req.syncPrincipal,
          this.getClientIpForRateLimit(req),
        ),
      handler: (req, res, _next, options) => {
        console.warn(
          `[MindooDBServer] Sync rate limit hit tenant=${req.tenantId} ` +
          `principal=${req.syncPrincipal ?? "anonymous"} ip=${req.ip} path=${req.path}`,
        );
        res.status(options.statusCode).json(options.message);
      },
      message: { error: "Too many sync requests, please try again later" },
    });
  }

  /**
   * Create a rate-limiter for authentication endpoints. Challenge and
   * authenticate get separate limiters so that one phase can't starve the
   * other. The key buckets by (scope, tenant, phase, IP, username) — this
   * prevents users behind a shared IP (NAT / reverse proxy) from exhausting
   * each other's budgets.
   */
  private createAuthRateLimit(
    scope: "system" | "tenant",
    phase: "challenge" | "authenticate",
  ) {
    const authRateLimitConfig = this.getAuthRateLimitConfig();
    return rateLimit({
      windowMs: authRateLimitConfig.windowMs,
      max: authRateLimitConfig.max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) =>
        buildAuthRateLimitKey(
          scope,
          phase,
          req.tenantId ?? req.params.tenantId?.toLowerCase(),
          this.getClientIpForRateLimit(req),
          req.body,
        ),
      handler: (req, res, _next, options) => {
        this.logAuthRateLimitHit(req, scope, phase);
        res.status(options.statusCode).json(options.message);
      },
      message: { error: "Too many authentication attempts, please try again later" },
    });
  }

  /**
   * Emit a structured warning when an auth rate limit is triggered.
   * The forwarded-for header is logged to help diagnose situations where
   * a reverse proxy collapses many clients onto a single visible IP.
   */
  private logAuthRateLimitHit(
    req: Request,
    scope: "system" | "tenant",
    phase: "challenge" | "authenticate",
  ): void {
    const forwardedForHeader = req.headers["x-forwarded-for"];
    const forwardedFor = Array.isArray(forwardedForHeader)
      ? forwardedForHeader.join(", ")
      : forwardedForHeader;
    const username = typeof req.body?.username === "string" ? req.body.username : "-";

    console.warn(
      `[MindooDBServer] Auth rate limit exceeded scope=${scope} phase=${phase} tenant=${req.tenantId ?? req.params.tenantId?.toLowerCase() ?? "-"} ip=${this.getClientIpForRateLimit(req)} forwarded-for=${forwardedFor ?? "-"} username=${username} path=${req.path}`,
    );
  }

  /**
   * Best-effort client IP for bucketing. Express populates `req.ip` from the
   * trust-proxy setting; fall back to the raw socket address when it's
   * unavailable.
   *
   * IPv6 addresses collapse to their /56 prefix. A single IPv6 client is
   * routinely handed far more than one address, so keying on the full address
   * would let it mint a fresh budget per request. Non-IPv6 values, including
   * the "unknown" fallback, pass through unchanged.
   */
  private getClientIpForRateLimit(req: Request): string {
    const raw =
      (typeof req.ip === "string" && req.ip.length > 0
        ? req.ip
        : req.socket?.remoteAddress) ?? "unknown";
    return ipKeyGenerator(raw);
  }

  // ==================== Sync Event Stream ====================

  /**
   * SSE transport for the change feed: the core runs the subscribe-time read
   * gate, this keeps the stream open on the in-process event bus with a
   * heartbeat every 30 s.
   */
  private async handleSyncEvents(storeKind: StoreKind, req: Request, res: Response): Promise<void> {
    const response = await this.core.sync("events", toServerRequest(req), storeKind);
    if (!isEventStreamResponse(response)) {
      await sendServerResponse(req, res, response);
      return;
    }
    this.openSyncEventStream(req, res, response.events);
  }

  private openSyncEventStream(req: Request, res: Response, subscription: SyncEventStreamSpec): void {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    if (!req.httpVersion.startsWith("2")) {
      // Forbidden (and unnecessary) on HTTP/2 streams.
      res.setHeader("Connection", "keep-alive");
    }
    res.flushHeaders();
    res.write(formatSyncHelloEvent());

    const unsubscribe = this.syncEventBus.subscribe((event) => {
      const frame = formatSyncChangeEvent(subscription, event);
      if (frame) {
        res.write(frame);
      }
    });

    const heartbeat = setInterval(() => {
      res.write(formatSyncHeartbeat(Date.now()));
    }, SYNC_EVENT_HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    console.log(
      `[MindooDBServer] SSE subscriber connected tenant=${subscription.tenantId} storeKind=${subscription.storeKind} subscribers=${this.syncEventBus.listenerCount}`,
    );
  }

  /**
   * Express error handler (4-arg signature). Handles body-parser errors
   * (413 entity too large, 400 parse failed) with structured JSON responses;
   * everything else is logged and returned as a generic 500.
   */
  private errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
    const parserError = err as Error & {
      status?: number;
      statusCode?: number;
      type?: string;
      limit?: number;
      length?: number;
      body?: unknown;
    };
    const status = parserError.statusCode ?? parserError.status;
    if (status === 413 || parserError.type === "entity.too.large") {
      console.error("[MindooDBServer] Request body too large", {
        method: req.method,
        path: req.path,
        contentLength: req.headers["content-length"] ?? "-",
        parsedBytes: req.jsonBodyBytes ?? "-",
        limit: parserError.limit ?? this.jsonBodyLimit,
      });
      res.status(413).json({ error: "Request body too large" });
      return;
    }
    if (status === 400 && parserError.type === "entity.parse.failed") {
      console.error("[MindooDBServer] Invalid JSON body", {
        method: req.method,
        path: req.path,
        contentLength: req.headers["content-length"] ?? "-",
        parsedBytes: req.jsonBodyBytes ?? "-",
        error: err,
      });
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    console.error("[MindooDBServer] Unhandled error", {
      method: req.method,
      path: req.path,
      contentLength: req.headers["content-length"] ?? "-",
      parsedBytes: req.jsonBodyBytes ?? "-",
      error: err,
    });
    res.status(500).json({ error: "Internal server error" });
  }
}
