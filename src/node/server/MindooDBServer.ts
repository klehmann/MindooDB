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
import https from "https";
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
import type {
} from "../../core/appendonlystores/types";
import type { NetworkSyncCapabilities } from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";

import { TenantManager } from "./TenantManager";
import { CapabilityMatcher } from "./CapabilityMatcher";
import { SystemAdminAuthService } from "./SystemAdminAuth";
import { validateServerConfig, backupConfig, writeConfig } from "./config";
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
  TrustedServer,
  NamedRemoteServerConfig,
} from "./types";
import {
  validateIdentifier,
  validateTenantId,
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

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      systemAdmin?: { username: string; publicsignkey: string };
    }
  }
}

interface SerializedEntryMetadata {
  entryType: StoreEntryType;
  id: string;
  contentHash: string;
  docId: string;
  dependencyIds: string[];
  createdAt: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  signature: string;
  originalSize: number;
  encryptedSize: number;
}

interface MaterializationPlanOptions {
  includeDiagnostics?: boolean;
}

interface DocumentMaterializationPlan {
  docId: string;
  snapshotEntryId: string | null;
  entryIdsToApply: string[];
}

interface DocumentMaterializationBatchPlan {
  plans: DocumentMaterializationPlan[];
}

interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string;
}

interface SerializedNetworkEncryptedEntry extends SerializedEntryMetadata {
  rsaEncryptedPayload: string;
}

export class MindooDBServer {
  private app: express.Application;
  private tenantManager: TenantManager;
  private capabilityMatcher: CapabilityMatcher;
  private systemAdminAuth: SystemAdminAuthService;
  private readonly staticDir: string | undefined;
  private serverConfig: ServerConfig;
  private configPath: string;

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

    this.serverConfig = config ?? { capabilities: {} };
    this.capabilityMatcher = new CapabilityMatcher(this.serverConfig);

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

  reloadConfig(newConfig: ServerConfig): void {
    this.serverConfig = newConfig;
    this.capabilityMatcher.reload(newConfig);
    this.systemAdminAuth.reloadPrincipals(newConfig);
  }

  listen(port: number): void {
    const server = this.app.listen(port, () => {
      console.log(`[MindooDBServer] Listening on port ${port}`);
    });

    server.setTimeout(30_000);
  }

  listenTls(port: number, certPath: string, keyPath: string): void {
    const tlsOptions = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
    const server = https.createServer(tlsOptions, this.app);
    server.listen(port, () => {
      console.log(`[MindooDBServer] Listening on HTTPS port ${port}`);
    });

    server.setTimeout(30_000);
  }

  private setupMiddleware(): void {
    this.app.use(helmet());

    const corsOrigin = process.env.MINDOODB_CORS_ORIGIN;
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

    this.app.use(express.json({ limit: "5mb" }));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Root redirect
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

    this.app.get("/.well-known/mindoodb-server-info", (req, res) => {
      const info = this.tenantManager.getServerPublicInfo();
      if (!info) {
        res.status(503).json({ error: "Server identity not initialized" });
        return;
      }
      res.json(info);
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

    // System admin routes (replaces former /admin/*)
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

    // Tenant-scoped routes
    this.app.use("/:tenantId", this.tenantMiddleware.bind(this), this.createTenantRouter());

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
      validateIdentifier(rawTenantId, "tenantId");
    } catch {
      res.status(400).json({ error: "Invalid tenant ID format" });
      return;
    }

    if (!this.tenantManager.tenantExists(rawTenantId)) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    req.tenantId = rawTenantId;
    next();
  }

  // ==================== System Routes ====================

  private setupSystemRoutes(router: Router): void {
    // Auth endpoints — no JWT required (these *produce* JWTs)
    const authRateLimit = rateLimit({
      windowMs: 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many authentication attempts, please try again later" },
    });

    router.post("/auth/challenge", authRateLimit, this.handleSystemChallenge.bind(this));
    router.post("/auth/authenticate", authRateLimit, this.handleSystemAuthenticate.bind(this));

    // All other /system/* routes require JWT + capability check
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

    router.post("/tenants/:tenantId", authMiddleware, (req: Request, res: Response) => {
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

        if (this.tenantManager.tenantExists(tenantId)) {
          res.status(409).json({ error: `Tenant ${tenantId} already exists` });
          return;
        }

        const context = this.tenantManager.registerTenant(request);

        const response: RegisterTenantResponse = {
          success: true,
          tenantId: context.tenantId,
          message: `Tenant ${context.tenantId} registered successfully`,
        };

        res.status(201).json(response);
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
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
          validateIdentifier(tenantId, "tenantId");
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

    router.delete("/tenants/:tenantId", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();

        try {
          validateIdentifier(tenantId, "tenantId");
        } catch {
          res.status(400).json({ error: "Invalid tenantId format" });
          return;
        }

        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: "Tenant not found" });
          return;
        }

        this.tenantManager.removeTenant(tenantId);
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

    // Tenant creation key management
    router.get("/tenant-api-keys", authMiddleware, (req: Request, res: Response) => {
      try {
        const keys = this.tenantManager.listTenantCreationKeys().map((k) => ({
          name: k.name,
          tenantIdPrefix: k.tenantIdPrefix,
          createdAt: k.createdAt,
          apiKeyPreview: k.apiKey.substring(0, 12) + "...",
        }));
        res.json({ keys });
      } catch (error) {
        console.error("[MindooDBServer] Error listing tenant creation keys:", error);
        res.status(500).json({ error: "Failed to list tenant creation keys" });
      }
    });

    router.post("/tenant-api-keys", authMiddleware, (req: Request, res: Response) => {
      try {
        const { name, tenantIdPrefix } = req.body;

        if (!name) {
          res.status(400).json({ error: "name is required" });
          return;
        }

        validateStringLength(name, 64, "name");
        if (tenantIdPrefix) {
          validateStringLength(tenantIdPrefix, 64, "tenantIdPrefix");
        }

        const key = this.tenantManager.addTenantCreationKey(name, tenantIdPrefix);

        res.status(201).json({
          success: true,
          name: key.name,
          apiKey: key.apiKey,
          tenantIdPrefix: key.tenantIdPrefix,
          createdAt: key.createdAt,
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof Error && error.message.includes("already exists")) {
          res.status(409).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error creating tenant creation key:", error);
        res.status(500).json({ error: "Failed to create tenant creation key" });
      }
    });

    router.delete("/tenant-api-keys/:name", authMiddleware, (req: Request, res: Response) => {
      try {
        const name = req.params.name;
        validateStringLength(name, 64, "name");

        const removed = this.tenantManager.removeTenantCreationKey(name);
        if (!removed) {
          res.status(404).json({ error: "Tenant creation key not found" });
          return;
        }

        res.json({ success: true, message: `Tenant creation key "${name}" removed` });
      } catch (error) {
        if (error instanceof ValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        console.error("[MindooDBServer] Error removing tenant creation key:", error);
        res.status(500).json({ error: "Failed to remove tenant creation key" });
      }
    });

    // Per-tenant sync server management
    router.get("/tenants/:tenantId/sync-servers", authMiddleware, (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();
        try { validateIdentifier(tenantId, "tenantId"); } catch {
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
        try { validateIdentifier(tenantId, "tenantId"); } catch {
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
        try { validateIdentifier(tenantId, "tenantId"); } catch {
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

      // Self-lockout protection: verify the calling admin retains PUT /system/config access
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

  private createTenantRouter(): Router {
    const router = Router({ mergeParams: true });

    // Auth endpoints get stricter rate limiting
    const authRateLimit = rateLimit({
      windowMs: 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many authentication attempts, please try again later" },
    });

    // Sync endpoints get a higher limit
    const syncRateLimit = rateLimit({
      windowMs: 60_000,
      max: 200,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many sync requests, please try again later" },
    });

    router.post("/auth/challenge", authRateLimit, this.handleChallenge.bind(this));
    router.post("/auth/authenticate", authRateLimit, this.handleAuthenticate.bind(this));

    router.post("/sync/findNewEntries", syncRateLimit, this.handleFindNewEntries.bind(this));
    router.post("/sync/findNewEntriesForDoc", syncRateLimit, this.handleFindNewEntriesForDoc.bind(this));
    router.post("/sync/findEntries", syncRateLimit, this.handleFindEntries.bind(this));
    router.post("/sync/scanEntriesSince", syncRateLimit, this.handleScanEntriesSince.bind(this));
    router.post("/sync/getIdBloomSummary", syncRateLimit, this.handleGetIdBloomSummary.bind(this));
    router.post("/sync/getCompactionStatus", syncRateLimit, this.handleGetCompactionStatus.bind(this));
    router.get("/sync/capabilities", syncRateLimit, this.handleGetCapabilities.bind(this));
    router.post("/sync/getEntries", syncRateLimit, this.handleGetEntries.bind(this));
    router.post("/sync/putEntries", syncRateLimit, this.handlePutEntries.bind(this));
    router.post("/sync/hasEntries", syncRateLimit, this.handleHasEntries.bind(this));
    router.get("/sync/getAllIds", syncRateLimit, this.handleGetAllIds.bind(this));
    router.post("/sync/resolveDependencies", syncRateLimit, this.handleResolveDependencies.bind(this));
    router.post("/sync/planDocumentMaterialization", syncRateLimit, this.handlePlanDocumentMaterialization.bind(this));
    router.post("/sync/planDocumentMaterializationBatch", syncRateLimit, this.handlePlanDocumentMaterializationBatch.bind(this));

    return router;
  }

  // ==================== Validation Helpers ====================

  private validateDbId(dbId: unknown): string {
    return validateIdentifier(dbId, "dbId");
  }

  // ==================== Tenant Auth Handlers ====================

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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

  private async handlePutEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, entries } = req.body;

      const validDbId = this.validateDbId(dbId);
      validateArraySize(entries, MAX_PUT_ENTRIES, "entries");

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
      const deserializedEntries = (entries || []).map((e: SerializedEntry) =>
        this.deserializeEntry(e),
      );

      await serverStore.handlePutEntries(token, deserializedEntries);

      res.json({ success: true });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  private async handleHasEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, ids } = req.body;

      const validDbId = this.validateDbId(dbId);
      validateArraySize(ids, MAX_ENTRY_IDS, "ids");

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
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
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, validDbId);
      const batchPlan = await (serverStore as any).handlePlanDocumentMaterializationBatch(token, docIds || [], options);
      res.json({ batchPlan: batchPlan as DocumentMaterializationBatchPlan });
    } catch (error) {
      this.handleRequestError(error, res);
    }
  }

  // ==================== Management Handlers ====================

  private async handleTriggerSync(req: Request, res: Response): Promise<void> {
    res.json({ success: true, message: "Sync triggered (not yet implemented)" });
  }

  // ==================== Helper Methods ====================

  private extractToken(req: Request): string {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new NetworkError("INVALID_TOKEN" as any, "Missing or invalid Authorization header");
    }
    return auth.substring(7);
  }

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

  private errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
    console.error("[MindooDBServer] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }

  // ==================== Serialization ====================

  private serializeEntryMetadata(metadata: StoreEntryMetadata): SerializedEntryMetadata {
    return {
      entryType: metadata.entryType,
      id: metadata.id,
      contentHash: metadata.contentHash,
      docId: metadata.docId,
      dependencyIds: metadata.dependencyIds,
      createdAt: metadata.createdAt,
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
