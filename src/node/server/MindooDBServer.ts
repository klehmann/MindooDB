/**
 * MindooDB Server - Express HTTP server implementing the sync API.
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
import rateLimit from "express-rate-limit";
import type {
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../../core/types";
import {
  StoreKind,
} from "../../core/appendonlystores/types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
} from "../../core/appendonlystores/types";
import type { NetworkSyncCapabilities } from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";

import { TenantManager } from "./TenantManager";
import { CapabilityMatcher } from "./CapabilityMatcher";
import { SystemAdminAuthService } from "./SystemAdminAuth";
import {
  validateServerConfig,
  backupConfig,
  writeConfig,
  isConfigBackupFilename,
  listConfigBackups,
  loadConfigBackup,
} from "./config";
import {
  isSystemIpAllowListDisabled,
  readSystemIpAllowListFromEnv,
  systemIpAllowlistMiddleware,
} from "./SystemIpAllowlist";
import type { ServerConfig } from "./types";
import type {
  RegisterTenantRequest,
  RegisterTenantResponse,
  ListTenantsResponse,
  TenantPublicInfosFingerprintsResponse,
  TrustedServer,
  NamedRemoteServerConfig,
} from "./types";
import {
  validateIdentifier,
  validateTenantId,
  validateTenantIdFormat,
  validateUsername,
  validateArraySize,
  validateStringLength,
  ValidationError,
  MAX_HAVE_IDS,
  MAX_ENTRY_IDS,
  MAX_PUT_ENTRIES,
  MAX_PEM_KEY_LENGTH,
  MAX_SIGNATURE_LENGTH,
  MAX_CHALLENGE_LENGTH,
} from "./validation";

/**
 * Augment Express Request with fields populated by our middleware:
 * - tenantId: set by tenantMiddleware after validating the :tenantId URL param
 * - systemAdmin: set by systemAdminMiddleware after JWT verification
 * - jsonBodyBytes: raw byte count captured during JSON body parsing (for diagnostics)
 */
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      systemAdmin?: { username: string; publicsignkey: string };
      jsonBodyBytes?: number;
    }
  }
}

/**
 * Wire-format types for the sync HTTP API.
 *
 * Binary fields (signature, encryptedData, rsaEncryptedPayload) are base64-
 * encoded strings in transit and converted to Uint8Array on deserialization.
 */
interface SerializedEntryMetadata {
  entryType: StoreEntryType;
  id: string;
  contentHash: string;
  docId: string;
  dependencyIds: string[];
  createdAt: number;
  receiptOrder?: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  signature: string;
  originalSize: number;
  encryptedSize: number;
}

interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string;
}

interface SerializedNetworkEncryptedEntry extends SerializedEntryMetadata {
  rsaEncryptedPayload: string;
}

/**
 * Rate-limit defaults. Auth and sync have separate tiers because a single
 * challenge/authenticate handshake is two requests; with multiple tenants,
 * store kinds, and token renewals the auth budget exhausts quickly if set
 * too low. These can be overridden in config.json under `rateLimits.auth`
 * and `rateLimits.sync`.
 */
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 120;
const DEFAULT_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_SYNC_RATE_LIMIT_MAX = 1_000;

const DEFAULT_SERVER_SOCKET_TIMEOUT_MS = 120_000;

/** Parse a human-readable size string ("5mb", "1024", "100kb") into bytes. */
function parseBodySizeLimitToBytes(limit: string): number | null {
  const normalized = limit.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "b"
    ? 1
    : unit === "kb"
      ? 1024
      : unit === "mb"
        ? 1024 * 1024
        : 1024 * 1024 * 1024;
  return Math.round(value * multiplier);
}

export class MindooDBServer {
  private app: express.Application;
  private tenantManager: TenantManager;
  private capabilityMatcher: CapabilityMatcher;
  private systemAdminAuth: SystemAdminAuthService;
  private readonly staticDir: string | undefined;
  private serverConfig: ServerConfig;
  private configPath: string;
  private readonly jsonBodyLimit: string;
  private readonly jsonBodyLimitBytes: number | null;

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
    this.tenantManager = new TenantManager(dataDir, serverPassword);
    this.staticDir = staticDir;
    this.configPath = configPath ?? path.join(dataDir, "config.json");
    this.jsonBodyLimit = process.env.MINDOODB_JSON_BODY_LIMIT?.trim() || "5mb";
    this.jsonBodyLimitBytes = parseBodySizeLimitToBytes(this.jsonBodyLimit);

    this.serverConfig = config ?? { capabilities: {} };
    this.capabilityMatcher = new CapabilityMatcher(this.serverConfig);

    // SystemAdminAuthService generates a random HMAC-SHA256 secret for JWTs
    // on each server start — existing tokens become invalid after restart.
    const cryptoAdapter = this.tenantManager.getCryptoAdapter();
    this.systemAdminAuth = new SystemAdminAuthService(
      cryptoAdapter,
      this.serverConfig,
    );

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

  listen(port: number): void {
    const server = this.app.listen(port, () => {
      console.log(`[MindooDBServer] Listening on port ${port}`);
    });

    server.setTimeout(DEFAULT_SERVER_SOCKET_TIMEOUT_MS);
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
    server.listen(port, () => {
      console.log(`[MindooDBServer] Listening on HTTPS port ${port} with HTTP/2 enabled (HTTP/1 fallback active)`);
    });

    server.setTimeout(DEFAULT_SERVER_SOCKET_TIMEOUT_MS);
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
    this.app.use(helmet());

    const corsOrigin = this.readCorsOriginsFromEnv();
    this.app.use(cors({
      origin: corsOrigin || false,
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }));

    this.app.use(rateLimit({
      windowMs: 60_000,
      max: 500,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later" },
    }));

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
    this.app.get("/", (req: Request, res: Response) => {
      if (this.staticDir && existsSync(path.join(this.staticDir, "index.html"))) {
        res.redirect(302, "/statics/index.html");
      } else {
        res.status(404).json({ error: "Not found" });
      }
    });

    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: Date.now() });
    });

    // .well-known endpoints are unauthenticated so clients can discover
    // server identity and tenant availability before attempting to authenticate.
    this.app.get("/.well-known/mindoodb-server-info", (req, res) => {
      const info = this.tenantManager.getServerPublicInfo();
      if (!info) {
        res.status(503).json({ error: "Server identity not initialized" });
        return;
      }
      res.json({
        ...info,
        maxJsonRequestBodyLimit: this.jsonBodyLimit,
        maxJsonRequestBodyBytes: this.jsonBodyLimitBytes ?? undefined,
      });
    });
    this.app.get("/.well-known/mindoodb-tenants/:tenantId/publicinfos-fingerprints", async (req, res) => {
      const tenantId = req.params.tenantId.toLowerCase();
      try {
        validateTenantId(tenantId);
        const fingerprints = await this.tenantManager.listTenantPublicInfosFingerprints(tenantId);
        if (fingerprints.length === 0) {
          res.status(404).json({ error: "Tenant not found on server" });
          return;
        }
        const response: TenantPublicInfosFingerprintsResponse = {
          tenantId,
          fingerprints,
        };
        res.json(response);
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof Error && error.message.includes("not found")) {
          res.status(404).json({ error: "Tenant not found on server" });
          return;
        }
        console.error("[MindooDBServer] Error reading tenant publicInfos fingerprints:", error);
        res.status(500).json({ error: "Failed to read tenant publicInfos fingerprints" });
      }
    });

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

    const systemRateLimit = rateLimit({
      windowMs: 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many system requests, please try again later" },
    });

    const systemRouter = Router();
    this.setupSystemRoutes(systemRouter);
    this.app.use(
      "/system",
      systemIpAllowlistMiddleware,
      systemRateLimit,
      systemRouter,
    );

    // Tenant-scoped routes: tenantMiddleware validates the :tenantId param
    // and rejects unknown tenants before any handler runs.
    this.app.use("/:tenantId", this.tenantMiddleware.bind(this), this.createTenantRouter());

    // Express error handler — must be registered last and have the 4-arg signature
    this.app.use(this.errorHandler.bind(this));
  }

  // ==================== System Admin Auth Middleware ====================

  /**
   * JWT-based middleware for /system/* routes (excluding /system/auth/*).
   * Extracts and validates the bearer token, then checks capabilities
   * for the current (method, path, username, publicsignkey).
   */
  private async systemAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = auth.substring(7);
    const payload = await this.systemAdminAuth.validateToken(token);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    // The original request path relative to the /system mount is in req.path,
    // but we need the full path for capability matching.
    const fullPath = `/system${req.path}`;
    const method = req.method.toUpperCase();

    if (
      !this.capabilityMatcher.isAuthorized(
        method,
        fullPath,
        payload.sub,
        payload.publicsignkey,
      )
    ) {
      res.status(403).json({ error: "Forbidden: insufficient capabilities" });
      return;
    }

    req.systemAdmin = {
      username: payload.sub,
      publicsignkey: payload.publicsignkey,
    };
    next();
  }

  // ==================== Tenant Middleware ====================

  private tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
    const rawTenantId = req.params.tenantId?.toLowerCase();

    if (!rawTenantId) {
      res.status(400).json({ error: "Tenant ID required" });
      return;
    }

    try {
      validateTenantIdFormat(rawTenantId);
    } catch {
      res.status(400).json({ error: "Invalid tenant ID format" });
      return;
    }

    if (!this.tenantManager.tenantExists(rawTenantId)) {
      res.status(404).json({ error: this.formatTenantNotFoundOnServerError(rawTenantId) });
      return;
    }

    req.tenantId = rawTenantId;
    next();
  }

  // ==================== System Routes ====================

  /**
   * Wire up all /system/* routes. Auth endpoints sit outside the JWT
   * middleware because they implement the challenge-response handshake
   * that *produces* the JWT. Every other route requires a valid JWT and
   * passes through the CapabilityMatcher for fine-grained authorization.
   */
  private setupSystemRoutes(router: Router): void {
    const challengeRateLimit = this.createAuthRateLimit("system", "challenge");
    const authenticateRateLimit = this.createAuthRateLimit("system", "authenticate");

    router.post("/auth/challenge", challengeRateLimit, this.handleSystemChallenge.bind(this));
    router.post("/auth/authenticate", authenticateRateLimit, this.handleSystemAuthenticate.bind(this));

    const authMiddleware = this.systemAdminMiddleware.bind(this);

    // Tenant CRUD
    router.get("/tenants", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenants = this.tenantManager.listTenants();
        const response: ListTenantsResponse = { tenants };
        res.json(response);
      } catch (error) {
        console.error("[MindooDBServer] Error listing tenants:", error);
        res.status(500).json({ error: "Failed to list tenants" });
      }
    });

    // Tenant registration is idempotent: re-POSTing with the same tenantId
    // and matching $publicinfos key returns 200 instead of 409.
    router.post("/tenants/:tenantId", authMiddleware, async (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();

        try {
          validateTenantId(tenantId);
        } catch (validationError) {
          res.status(400).json({
            error: validationError instanceof ValidationError
              ? validationError.message
              : "Invalid tenantId format",
          });
          return;
        }

        const request: RegisterTenantRequest = {
          ...req.body,
          tenantId,
        };

        if (!request.adminSigningPublicKey) {
          res.status(400).json({ error: "adminSigningPublicKey is required" });
          return;
        }
        if (!request.adminEncryptionPublicKey) {
          res.status(400).json({ error: "adminEncryptionPublicKey is required" });
          return;
        }
        if (request.adminUsername !== undefined) {
          validateUsername(request.adminUsername);
        }

        validateStringLength(request.adminSigningPublicKey, MAX_PEM_KEY_LENGTH, "adminSigningPublicKey");
        validateStringLength(request.adminEncryptionPublicKey, MAX_PEM_KEY_LENGTH, "adminEncryptionPublicKey");
        if (!request.encryptedPublicInfosKey && !request.publicInfosKey) {
          res.status(400).json({ error: "encryptedPublicInfosKey or publicInfosKey is required" });
          return;
        }
        if (request.publicInfosKey !== undefined) {
          validateStringLength(request.publicInfosKey, MAX_PEM_KEY_LENGTH, "publicInfosKey");
        }
        if (request.encryptedPublicInfosKey !== undefined) {
          validateStringLength(request.encryptedPublicInfosKey, MAX_PEM_KEY_LENGTH, "encryptedPublicInfosKey");
        }

        const result = await this.tenantManager.registerTenant(request);

        const response: RegisterTenantResponse = {
          success: true,
          tenantId: result.context.tenantId,
          created: result.created,
          message: result.created
            ? `Tenant ${result.context.tenantId} registered successfully`
            : `Tenant ${result.context.tenantId} already exists with matching $publicinfos key`,
        };

        res.status(result.created ? 201 : 200).json(response);
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof Error && error.message.includes("different $publicinfos key")) {
          res.status(409).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error registering tenant:", error);
        res.status(500).json({ error: "Failed to register tenant" });
      }
    });

    router.put("/tenants/:tenantId", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();
        try {
          validateTenantId(tenantId);
        } catch {
          res.status(400).json({ error: "Invalid tenantId format" });
          return;
        }

        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }

        this.tenantManager.updateTenantConfig(tenantId, req.body);
        res.json({ success: true, message: `Tenant ${tenantId} updated` });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error updating tenant:", error);
        res.status(500).json({ error: "Failed to update tenant" });
      }
    });

    router.delete("/tenants/:tenantId", authMiddleware, async (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();

        try {
          validateTenantId(tenantId);
        } catch {
          res.status(400).json({ error: "Invalid tenantId format" });
          return;
        }

        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }

        await this.tenantManager.removeTenant(tenantId);
        res.json({ success: true, message: `Tenant ${tenantId} removed` });
      } catch (error) {
        console.error("[MindooDBServer] Error removing tenant:", error);
        res.status(500).json({ error: "Failed to remove tenant" });
      }
    });

    // Trusted server management
    router.get("/trusted-servers", authMiddleware, (req: Request, res: Response) => {
      try {
        res.json({ servers: this.tenantManager.listTrustedServers() });
      } catch (error) {
        console.error("[MindooDBServer] Error listing trusted servers:", error);
        res.status(500).json({ error: "Failed to list trusted servers" });
      }
    });

    router.post("/trusted-servers", authMiddleware, (req: Request, res: Response) => {
      try {
        const { name, signingPublicKey, encryptionPublicKey } = req.body;

        if (!name || !signingPublicKey || !encryptionPublicKey) {
          res.status(400).json({ error: "name, signingPublicKey, and encryptionPublicKey are required" });
          return;
        }

        validateStringLength(name, 256, "name");
        validateStringLength(signingPublicKey, MAX_PEM_KEY_LENGTH, "signingPublicKey");
        validateStringLength(encryptionPublicKey, MAX_PEM_KEY_LENGTH, "encryptionPublicKey");

        const server: TrustedServer = { name, signingPublicKey, encryptionPublicKey };
        this.tenantManager.addTrustedServer(server);

        res.status(201).json({ success: true, message: `Trusted server "${name}" added` });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof Error && error.message.includes("already exists")) {
          res.status(409).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error adding trusted server:", error);
        res.status(500).json({ error: "Failed to add trusted server" });
      }
    });

    router.delete("/trusted-servers/:serverName", authMiddleware, (req: Request, res: Response) => {
      try {
        const serverName = req.params.serverName;
        validateStringLength(serverName, 256, "serverName");

        const removed = this.tenantManager.removeTrustedServer(serverName);
        if (!removed) {
          res.status(404).json({ error: "Trusted server not found" });
          return;
        }

        res.json({ success: true, message: `Trusted server "${serverName}" removed` });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error removing trusted server:", error);
        res.status(500).json({ error: "Failed to remove trusted server" });
      }
    });

    // Per-tenant sync server management
    router.get("/tenants/:tenantId/sync-servers", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();
        try { validateTenantId(tenantId); } catch {
          res.status(400).json({ error: "Invalid tenantId format" });
          return;
        }
        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }
        const servers = this.tenantManager.getTenantSyncServers(tenantId);
        res.json({ servers });
      } catch (error) {
        console.error("[MindooDBServer] Error listing sync servers:", error);
        res.status(500).json({ error: "Failed to list sync servers" });
      }
    });

    router.post("/tenants/:tenantId/sync-servers", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();
        try { validateTenantId(tenantId); } catch {
          res.status(400).json({ error: "Invalid tenantId format" });
          return;
        }
        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }

        const { name, url, syncIntervalMs, databases } = req.body;
        if (!name || !url) {
          res.status(400).json({ error: "name and url are required" });
          return;
        }
        if (!databases || !Array.isArray(databases) || databases.length === 0) {
          res.status(400).json({ error: "databases array is required and must not be empty" });
          return;
        }

        validateStringLength(name, 256, "name");
        validateStringLength(url, 2048, "url");

        const config: NamedRemoteServerConfig = { name, url, databases };
        if (syncIntervalMs !== undefined) {
          config.syncIntervalMs = syncIntervalMs;
        }

        this.tenantManager.addTenantSyncServer(tenantId, config);
        res.status(201).json({ success: true, message: `Sync server "${name}" configured for tenant ${tenantId}` });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error adding sync server:", error);
        res.status(500).json({ error: "Failed to add sync server" });
      }
    });

    router.delete("/tenants/:tenantId/sync-servers/:serverName", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();
        try { validateTenantId(tenantId); } catch {
          res.status(400).json({ error: "Invalid tenantId format" });
          return;
        }
        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }

        const serverName = decodeURIComponent(req.params.serverName);
        validateStringLength(serverName, 256, "serverName");

        const removed = this.tenantManager.removeTenantSyncServer(tenantId, serverName);
        if (!removed) {
          res.status(404).json({ error: "Sync server not found" });
          return;
        }
        res.json({ success: true, message: `Sync server "${serverName}" removed from tenant ${tenantId}` });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error removing sync server:", error);
        res.status(500).json({ error: "Failed to remove sync server" });
      }
    });

    // Per-tenant trigger-sync (moved from /:tenantId/admin/trigger-sync)
    router.post("/tenants/:tenantId/trigger-sync", authMiddleware, this.handleTriggerSync.bind(this));

    // Runtime config management
    router.get("/config/backups", authMiddleware, (req: Request, res: Response) => {
      try {
        res.json({ backups: listConfigBackups(this.configPath) });
      } catch (error) {
        console.error("[MindooDBServer] Error listing config backups:", error);
        res.status(500).json({ error: "Failed to list config backups" });
      }
    });

    router.get("/config/backups/:backupFile", authMiddleware, (req: Request, res: Response) => {
      try {
        const backupFile = decodeURIComponent(req.params.backupFile);
        if (!isConfigBackupFilename(backupFile)) {
          res.status(400).json({ error: "Invalid config backup filename" });
          return;
        }

        const config = loadConfigBackup(this.configPath, backupFile);
        res.json({ file: backupFile, config });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Config backup not found:")) {
          res.status(404).json({ error: "Config backup not found" });
          return;
        }
        if (error instanceof Error && error.message.startsWith("Invalid config backup filename:")) {
          res.status(400).json({ error: "Invalid config backup filename" });
          return;
        }
        console.error("[MindooDBServer] Error reading config backup:", error);
        res.status(500).json({ error: "Failed to read config backup" });
      }
    });

    router.get("/config", authMiddleware, (req: Request, res: Response) => {
      res.json(this.serverConfig);
    });

    router.put("/config", authMiddleware, this.handleUpdateConfig.bind(this));
  }

  // ==================== System Auth Handlers ====================

  private async handleSystemChallenge(req: Request, res: Response): Promise<void> {
    try {
      const { username, publicsignkey } = req.body;

      if (!username || typeof username !== "string") {
        res.status(400).json({ error: "username is required" });
        return;
      }
      if (!publicsignkey || typeof publicsignkey !== "string") {
        res.status(400).json({ error: "publicsignkey is required" });
        return;
      }

      validateUsername(username);
      validateStringLength(publicsignkey, MAX_PEM_KEY_LENGTH, "publicsignkey");

      const challenge = await this.systemAdminAuth.generateChallenge(
        username,
        publicsignkey,
      );
      res.json({ challenge });
    } catch (error) {
      if (error instanceof Error && error.message === "Unknown system admin principal") {
        res.status(404).json({ error: "System admin principal not found" });
        return;
      }
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[MindooDBServer] System challenge error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  private async handleSystemAuthenticate(req: Request, res: Response): Promise<void> {
    try {
      const { challenge, signature } = req.body;

      if (!challenge || !signature) {
        res.status(400).json({ error: "challenge and signature are required" });
        return;
      }

      validateStringLength(challenge, MAX_CHALLENGE_LENGTH, "challenge");
      validateStringLength(signature, MAX_SIGNATURE_LENGTH, "signature");

      const signatureBytes = this.base64ToUint8Array(signature);
      const result = await this.systemAdminAuth.authenticate(challenge, signatureBytes);
      res.json(result);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[MindooDBServer] System authenticate error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // ==================== Config Update Handler ====================

  private async handleUpdateConfig(req: Request, res: Response): Promise<void> {
    try {
      let newConfig: ServerConfig;
      try {
        newConfig = validateServerConfig(req.body, "request body");
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Invalid config format",
        });
        return;
      }

      // Self-lockout protection: simulate the proposed config against the calling
      // admin's identity — reject if they would lose their own config access.
      const callingAdmin = req.systemAdmin!;
      const proposedMatcher = new CapabilityMatcher(newConfig);
      if (
        !proposedMatcher.isAuthorized(
          "PUT",
          "/system/config",
          callingAdmin.username,
          callingAdmin.publicsignkey,
        )
      ) {
        res.status(400).json({
          error: "This change would remove your own access to PUT /system/config",
        });
        return;
      }

      // Backup the current config before overwriting
      const { existsSync: fsExists } = await import("fs");
      let backupFile: string | null = null;
      if (fsExists(this.configPath)) {
        backupFile = backupConfig(this.configPath);
      }

      // Persist new config to disk
      writeConfig(this.configPath, newConfig);

      // Hot-swap in-memory state
      this.reloadConfig(newConfig);

      console.log(
        `[MindooDBServer] Config updated by ${callingAdmin.username}` +
          (backupFile ? ` (backup: ${backupFile})` : ""),
      );

      res.json({
        success: true,
        ...(backupFile ? { backupFile } : {}),
      });
    } catch (error) {
      console.error("[MindooDBServer] Error updating config:", error);
      res.status(500).json({ error: "Failed to update config" });
    }
  }

  // ==================== Tenant Routes ====================

  /**
   * Build the per-tenant router. Rate limiters are scoped: auth endpoints
   * use a per-user composite key (see createAuthRateLimit) while sync
   * endpoints use a plain IP-based bucket with a higher ceiling.
   *
   * Both "docs" and "attachments" store kinds expose the same set of sync
   * operations, mounted at /sync/docs/* and /sync/attachments/*.
   */
  private createTenantRouter(): Router {
    const router = Router({ mergeParams: true });
    const authRateLimitConfig = this.getAuthRateLimitConfig();
    const syncRateLimitConfig = this.getSyncRateLimitConfig();

    const challengeRateLimit = this.createAuthRateLimit("tenant", "challenge");
    const authenticateRateLimit = this.createAuthRateLimit("tenant", "authenticate");

    const syncRateLimit = rateLimit({
      windowMs: syncRateLimitConfig.windowMs,
      max: syncRateLimitConfig.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many sync requests, please try again later" },
    });

    console.log(
      `[MindooDBServer] Tenant auth rate limit configured windowMs=${authRateLimitConfig.windowMs} max=${authRateLimitConfig.max}`,
    );

    router.post("/auth/challenge", challengeRateLimit, this.handleChallenge.bind(this));
    router.post("/auth/authenticate", authenticateRateLimit, this.handleAuthenticate.bind(this));

    for (const storeKind of ["docs", "attachments"] as const) {
      const syncBase = `/sync/${storeKind}`;
      router.post(`${syncBase}/findNewEntries`, syncRateLimit, this.handleFindNewEntries.bind(this));
      router.post(`${syncBase}/findNewEntriesForDoc`, syncRateLimit, this.handleFindNewEntriesForDoc.bind(this));
      router.post(`${syncBase}/findEntries`, syncRateLimit, this.handleFindEntries.bind(this));
      router.post(`${syncBase}/scanEntriesSince`, syncRateLimit, this.handleScanEntriesSince.bind(this));
      router.post(`${syncBase}/getIdBloomSummary`, syncRateLimit, this.handleGetIdBloomSummary.bind(this));
      router.post(`${syncBase}/getCompactionStatus`, syncRateLimit, this.handleGetCompactionStatus.bind(this));
      router.get(`${syncBase}/capabilities`, syncRateLimit, this.handleGetCapabilities.bind(this));
      router.post(`${syncBase}/getEntries`, syncRateLimit, this.handleGetEntries.bind(this));
      router.post(`${syncBase}/getEntryMetadata`, syncRateLimit, this.handleGetEntryMetadata.bind(this));
      router.post(`${syncBase}/putEntries`, syncRateLimit, this.handlePutEntries.bind(this));
      router.post(`${syncBase}/hasEntries`, syncRateLimit, this.handleHasEntries.bind(this));
      router.get(`${syncBase}/getAllIds`, syncRateLimit, this.handleGetAllIds.bind(this));
      router.post(`${syncBase}/resolveDependencies`, syncRateLimit, this.handleResolveDependencies.bind(this));
      router.post(`${syncBase}/planDocumentMaterialization`, syncRateLimit, this.handlePlanDocumentMaterialization.bind(this));
      router.post(`${syncBase}/planDocumentMaterializationBatch`, syncRateLimit, this.handlePlanDocumentMaterializationBatch.bind(this));
      router.post(`${syncBase}/planAttachmentReadByWalkingMetadata`, syncRateLimit, this.handlePlanAttachmentReadByWalkingMetadata.bind(this));
    }

    return router;
  }

  /** Resolved auth rate-limit config; falls back to defaults when not set in config.json. */
  private getAuthRateLimitConfig(): { windowMs: number; max: number } {
    return {
      windowMs: this.serverConfig.rateLimits?.auth?.windowMs ?? DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
      max: this.serverConfig.rateLimits?.auth?.max ?? DEFAULT_AUTH_RATE_LIMIT_MAX,
    };
  }

  /** Resolved sync rate-limit config; falls back to defaults when not set in config.json. */
  private getSyncRateLimitConfig(): { windowMs: number; max: number } {
    return {
      windowMs: this.serverConfig.rateLimits?.sync?.windowMs ?? DEFAULT_SYNC_RATE_LIMIT_WINDOW_MS,
      max: this.serverConfig.rateLimits?.sync?.max ?? DEFAULT_SYNC_RATE_LIMIT_MAX,
    };
  }

  /**
   * Create a rate-limiter for authentication endpoints. Challenge and
   * authenticate get separate limiters so that one phase can't starve the
   * other. The custom keyGenerator buckets by (scope, tenant, phase, IP,
   * username) — this prevents users behind a shared IP (NAT / reverse
   * proxy) from exhausting each other's budgets.
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
      keyGenerator: (req: Request) => this.getAuthRateLimitKey(req, scope, phase),
      handler: (req, res, _next, options) => {
        this.logAuthRateLimitHit(req, scope, phase);
        res.status(options.statusCode).json(options.message);
      },
      message: { error: "Too many authentication attempts, please try again later" },
    });
  }

  /**
   * Composite rate-limit key. Challenge requests include the username so
   * that brute-forcing one account doesn't block legitimate users on the
   * same IP. Authenticate requests omit username because the challenge
   * token is already scoped to a single principal.
   */
  private getAuthRateLimitKey(
    req: Request,
    scope: "system" | "tenant",
    phase: "challenge" | "authenticate",
  ): string {
    const tenantId = scope === "tenant"
      ? req.tenantId ?? req.params.tenantId?.toLowerCase() ?? "-"
      : "system";
    const clientIp = this.getClientIpForRateLimit(req);

    if (phase === "challenge") {
      const username = typeof req.body?.username === "string"
        ? req.body.username.trim().toLowerCase()
        : "-";
      return `${scope}:${tenantId}:${phase}:${clientIp}:${username}`;
    }

    return `${scope}:${tenantId}:${phase}:${clientIp}`;
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
   * Best-effort client IP. Express populates `req.ip` from the trust-proxy
   * setting; fall back to the raw socket address when it's unavailable.
   */
  private getClientIpForRateLimit(req: Request): string {
    return (
      (typeof req.ip === "string" && req.ip.length > 0
        ? req.ip
        : req.socket?.remoteAddress) ?? "unknown"
    );
  }

  // ==================== Validation Helpers ====================

  private validateDbId(dbId: unknown): string {
    return validateIdentifier(dbId, "dbId");
  }

  private formatTenantNotFoundOnServerError(tenantId: string): string {
    const serverName = this.tenantManager.getServerPublicInfo()?.name ?? "unknown";
    return `Tenant ${tenantId} not found on server ${serverName}`;
  }

  // ==================== Tenant Auth Handlers ====================
  // Two-step challenge-response flow:
  //  1. POST /auth/challenge  → client sends username, server returns a random nonce
  //  2. POST /auth/authenticate → client signs the nonce with its Ed25519 private key,
  //     server verifies the signature and returns a JWT for subsequent sync calls

  private async handleChallenge(req: Request, res: Response): Promise<void> {
    try {
      const { username } = req.body;

      validateUsername(username);

      const authService = await this.tenantManager.getAuthService(req.tenantId!);
      const challenge = await authService.generateChallenge(username);

      res.json({ challenge });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleAuthenticate(req: Request, res: Response): Promise<void> {
    try {
      const { challenge, signature } = req.body;

      if (!challenge || !signature) {
        res.status(400).json({ error: "challenge and signature are required" });
        return;
      }

      validateStringLength(challenge, MAX_CHALLENGE_LENGTH, "challenge");
      validateStringLength(signature, MAX_SIGNATURE_LENGTH, "signature");

      const authService = await this.tenantManager.getAuthService(req.tenantId!);
      const signatureBytes = this.base64ToUint8Array(signature);
      const result = await authService.authenticate(challenge, signatureBytes);

      res.json(result);
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  // ==================== Sync Handlers ====================

  private async handleFindNewEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, haveIds } = req.body;

      const validDbId = this.validateDbId(dbId);
      validateArraySize(haveIds, MAX_HAVE_IDS, "haveIds");

      const serverStore = await this.tenantManager.getServerStore(
        req.tenantId!,
        validDbId,
        this.getStoreKindFromRequest(req),
      );
      const entries = await serverStore.handleFindNewEntries(token, haveIds || []);

      res.json({
        entries: entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
      });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleFindNewEntriesForDoc(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, haveIds, docId } = req.body;

      const validDbId = this.validateDbId(dbId);
      if (!docId) {
        res.status(400).json({ error: "docId is required" });
        return;
      }
      validateArraySize(haveIds, MAX_HAVE_IDS, "haveIds");

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const entries = await serverStore.handleFindNewEntriesForDoc(token, haveIds || [], docId);

      res.json({
        entries: entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
      });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleFindEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, type, creationDateFrom, creationDateUntil } = req.body;

      const validDbId = this.validateDbId(dbId);

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const entries = await serverStore.handleFindEntries(
        token,
        type,
        creationDateFrom ?? null,
        creationDateUntil ?? null,
      );

      res.json({
        entries: entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
      });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleScanEntriesSince(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, cursor, limit, filters } = req.body as {
        dbId?: string;
        cursor?: StoreScanCursor | null;
        limit?: number;
        filters?: StoreScanFilters;
      };

      const validDbId = this.validateDbId(dbId);

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const result = await serverStore.handleScanEntriesSince(
        token,
        cursor ?? null,
        limit,
        filters,
      );

      res.json({
        entries: result.entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleGetIdBloomSummary(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      const validDbId = this.validateDbId(dbId);

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const summary = await serverStore.handleGetIdBloomSummary(token);
      res.json({ summary: summary as StoreIdBloomSummary });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleGetCapabilities(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const rawDbId = (req.query.dbId as string) || "directory";
      const validDbId = this.validateDbId(rawDbId);
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const capabilities = await serverStore.handleGetCapabilities(token);
      res.json({ capabilities: capabilities as NetworkSyncCapabilities });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleGetCompactionStatus(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      const validDbId = this.validateDbId(dbId);

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const status = await serverStore.handleGetCompactionStatus(token);
      res.json({ status: status as StoreCompactionStatus });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleGetEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, ids } = req.body;

      const validDbId = this.validateDbId(dbId);
      validateArraySize(ids, MAX_ENTRY_IDS, "ids");

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const entries = await serverStore.handleGetEntries(token, ids || []);

      res.json({
        entries: entries.map((e: { rsaEncryptedPayload: Uint8Array } & StoreEntryMetadata) => ({
          ...this.serializeEntryMetadata(e),
          rsaEncryptedPayload: this.uint8ArrayToBase64(e.rsaEncryptedPayload),
        })),
      });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleGetEntryMetadata(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, id } = req.body as { dbId?: string; id?: string };

      const validDbId = this.validateDbId(dbId);
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const entry = await serverStore.handleGetEntryMetadata(token, id);

      res.json({
        entry: entry ? this.serializeEntryMetadata(entry) : null,
      });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  /**
   * Ingest encrypted entries from a client. The `stage` variable tracks
   * progress through the pipeline so that error logs pinpoint the failing
   * step (token extraction → body parsing → deserialization → storage).
   */
  private async handlePutEntries(req: Request, res: Response): Promise<void> {
    let stage = "extract-token";
    try {
      const token = this.extractToken(req);
      stage = "read-body";
      const { dbId, entries } = req.body;

      const validDbId = this.validateDbId(dbId);
      validateArraySize(entries, MAX_PUT_ENTRIES, "entries");
      const serializedEntries = Array.isArray(entries) ? entries as SerializedEntry[] : [];
      const serializedEntryTypeCounts = serializedEntries.reduce<Record<string, number>>((acc, entry) => {
        const key = entry?.entryType ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `[MindooDBServer] putEntries request tenant=${req.tenantId ?? "-"} db=${validDbId} entries=${serializedEntries.length} parsed-bytes=${req.jsonBodyBytes ?? "-"} content-length=${req.headers["content-length"] ?? "-"} types=${JSON.stringify(serializedEntryTypeCounts)}`,
      );

      stage = "load-server-store";
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      stage = "deserialize-entries";
      const deserializedEntries = serializedEntries.map((entry, index) => {
        try {
          return this.deserializeEntry(entry);
        } catch (error) {
          console.error("[MindooDBServer] putEntries failed while deserializing entry", {
            index,
            id: entry?.id ?? "-",
            type: entry?.entryType ?? "-",
            docId: entry?.docId ?? "-",
            encryptedSize: entry?.encryptedSize ?? "-",
            originalSize: entry?.originalSize ?? "-",
            signatureLength: entry?.signature?.length ?? "-",
            encryptedDataLength: entry?.encryptedData?.length ?? "-",
            error,
          });
          throw error;
        }
      });
      const totalEncryptedBytes = deserializedEntries.reduce((sum, entry) => sum + entry.encryptedData.byteLength, 0);
      const totalOriginalBytes = deserializedEntries.reduce((sum, entry) => sum + entry.originalSize, 0);
      console.log(
        `[MindooDBServer] putEntries deserialized tenant=${req.tenantId ?? "-"} db=${validDbId} entries=${deserializedEntries.length} totalEncryptedBytes=${totalEncryptedBytes} totalOriginalBytes=${totalOriginalBytes}`,
      );

      stage = "store-entries";
      await serverStore.handlePutEntries(token, deserializedEntries);
      stage = "respond-success";

      res.json({ success: true });
    } catch (error) {
      console.error("[MindooDBServer] putEntries failed", {
        stage,
        tenantId: req.tenantId ?? "-",
        dbId: req.body?.dbId ?? "-",
        parsedBytes: req.jsonBodyBytes ?? "-",
        contentLength: req.headers["content-length"] ?? "-",
        entryCount: Array.isArray(req.body?.entries) ? req.body.entries.length : "-",
        error,
      });
      this.handleRequestError(error, res);
    }
  }

  private async handleHasEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, ids } = req.body;

      const validDbId = this.validateDbId(dbId);
      validateArraySize(ids, MAX_ENTRY_IDS, "ids");

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const existingIds = await serverStore.handleHasEntries(token, ids || []);

      res.json({ ids: existingIds });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleGetAllIds(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const rawDbId = (req.query.dbId as string) || "directory";
      const validDbId = this.validateDbId(rawDbId);

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const ids = await serverStore.handleGetAllIds(token);

      res.json({ ids });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleResolveDependencies(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, startId, options } = req.body;

      const validDbId = this.validateDbId(dbId);
      if (!startId) {
        res.status(400).json({ error: "startId is required" });
        return;
      }

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const ids = await serverStore.handleResolveDependencies(token, startId, options);

      res.json({ ids });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handlePlanDocumentMaterialization(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, docId, options } = req.body as {
        dbId?: string;
        docId?: string;
        options?: MaterializationPlanOptions;
      };
      const validDbId = this.validateDbId(dbId);
      if (!docId) {
        res.status(400).json({ error: "docId is required" });
        return;
      }
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const plan = await (serverStore as any).handlePlanDocumentMaterialization(token, docId, options);
      res.json({ plan: plan as DocumentMaterializationPlan });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handlePlanDocumentMaterializationBatch(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, docIds, options } = req.body as {
        dbId?: string;
        docIds?: string[];
        options?: MaterializationPlanOptions;
      };
      const validDbId = this.validateDbId(dbId);
      validateArraySize(docIds, MAX_HAVE_IDS, "docIds");
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const batchPlan = await (serverStore as any).handlePlanDocumentMaterializationBatch(token, docIds || [], options);
      res.json({ batchPlan: batchPlan as DocumentMaterializationBatchPlan });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handlePlanAttachmentReadByWalkingMetadata(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, lastChunkId, attachmentSize, options } = req.body as {
        dbId?: string;
        lastChunkId?: string;
        attachmentSize?: number;
        options?: AttachmentReadPlanOptions;
      };
      const validDbId = this.validateDbId(dbId);
      if (!lastChunkId) {
        res.status(400).json({ error: "lastChunkId is required" });
        return;
      }
      if (typeof attachmentSize !== "number" || !Number.isFinite(attachmentSize)) {
        res.status(400).json({ error: "attachmentSize is required" });
        return;
      }
      if (!options || typeof options.startByte !== "number") {
        res.status(400).json({ error: "options.startByte is required" });
        return;
      }
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId, this.getStoreKindFromRequest(req));
      const plan = await (serverStore as any).handlePlanAttachmentReadByWalkingMetadata(
        token,
        lastChunkId,
        attachmentSize,
        options,
      );
      res.json({ plan: plan as AttachmentReadPlan });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  // ==================== Management Handlers ====================

  private async handleTriggerSync(req: Request, res: Response): Promise<void> {
    res.json({ success: true, message: "Sync triggered (not yet implemented)" });
  }

  // ==================== Helper Methods ====================

  /**
   * Derive the StoreKind from the request path. Both "docs" and
   * "attachments" share the same handler implementations; the store kind
   * selects which on-disk append-only store to operate against.
   */
  private getStoreKindFromRequest(req: Request): StoreKind {
    const trimmedPath = req.path.replace(/\/$/, "");
    if (trimmedPath.startsWith("/sync/docs/") || trimmedPath === "/sync/docs/capabilities" || trimmedPath === "/sync/docs/getAllIds") {
      return StoreKind.docs;
    }
    if (trimmedPath.startsWith("/sync/attachments/") || trimmedPath === "/sync/attachments/capabilities" || trimmedPath === "/sync/attachments/getAllIds") {
      return StoreKind.attachments;
    }
    throw new Error(`Unsupported sync store kind for path: ${req.path}`);
  }

  private extractToken(req: Request): string {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new NetworkError("INVALID_TOKEN" as any, "Missing or invalid Authorization header");
    }
    return auth.substring(7);
  }

  /** Map domain errors to HTTP status codes; unknown errors become 500. */
  private handleRequestError(error: unknown, res: Response): void {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof Error && error.name === "NetworkError") {
      const networkError = error as NetworkError;
      const status = this.getStatusForErrorType(networkError.type);
      res.status(status).json({ error: networkError.message });
      return;
    }

    console.error("[MindooDBServer] Request error:", error);
    res.status(500).json({ error: "Internal server error" });
  }

  private getStatusForErrorType(type: string): number {
    switch (type) {
      case "INVALID_TOKEN":
        return 401;
      case "USER_REVOKED":
        return 403;
      case "USER_NOT_FOUND":
        return 404;
      case "INVALID_SIGNATURE":
        return 403;
      case "CHALLENGE_EXPIRED":
        return 401;
      default:
        return 500;
    }
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

  // ==================== Serialization ====================
  // Entries are stored with binary fields (Uint8Array) internally but
  // transmitted as base64 strings over JSON. These methods handle the
  // conversion in both directions.

  private serializeEntryMetadata(metadata: StoreEntryMetadata): SerializedEntryMetadata {
    return {
      entryType: metadata.entryType,
      id: metadata.id,
      contentHash: metadata.contentHash,
      docId: metadata.docId,
      dependencyIds: metadata.dependencyIds,
      createdAt: metadata.createdAt,
      receiptOrder: metadata.receiptOrder,
      createdByPublicKey: metadata.createdByPublicKey,
      decryptionKeyId: metadata.decryptionKeyId,
      signature: this.uint8ArrayToBase64(metadata.signature),
      originalSize: metadata.originalSize,
      encryptedSize: metadata.encryptedSize,
    };
  }

  private deserializeEntry(serialized: SerializedEntry): StoreEntry {
    return {
      entryType: serialized.entryType,
      id: serialized.id,
      contentHash: serialized.contentHash,
      docId: serialized.docId,
      dependencyIds: serialized.dependencyIds,
      createdAt: serialized.createdAt,
      receiptOrder: serialized.receiptOrder,
      createdByPublicKey: serialized.createdByPublicKey,
      decryptionKeyId: serialized.decryptionKeyId,
      signature: this.base64ToUint8Array(serialized.signature),
      originalSize: serialized.originalSize,
      encryptedSize: serialized.encryptedSize,
      encryptedData: this.base64ToUint8Array(serialized.encryptedData),
    };
  }

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
}
