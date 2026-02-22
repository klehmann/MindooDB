/**
 * MindooDB Example Server - Express HTTP server implementing the sync API.
 *
 * Security features:
 * - Input validation on all identifiers (path traversal prevention)
 * - Tiered admin auth with constant-time key comparison
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
import { timingSafeEqual } from "crypto";
import type {
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "mindoodb/core/types";
import type { NetworkSyncCapabilities } from "mindoodb/core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "mindoodb/core/appendonlystores/network/types";

import { TenantManager } from "./TenantManager";
import type {
  RegisterTenantRequest,
  RegisterTenantResponse,
  ListTenantsResponse,
  TrustedServer,
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

interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string;
}

interface SerializedNetworkEncryptedEntry extends SerializedEntryMetadata {
  rsaEncryptedPayload: string;
}

// ==================== Helpers ====================

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class MindooDBServer {
  private app: express.Application;
  private tenantManager: TenantManager;
  private adminApiKey: string | undefined;
  private readonly staticDir: string | undefined;

  constructor(dataDir: string, serverPassword?: string, staticDir?: string) {
    this.app = express();
    this.tenantManager = new TenantManager(dataDir, serverPassword);
    this.adminApiKey = process.env.MINDOODB_ADMIN_API_KEY;
    this.staticDir = staticDir;

    if (!this.adminApiKey) {
      console.log(`[MindooDBServer] WARNING: MINDOODB_ADMIN_API_KEY not set. Admin endpoints are UNPROTECTED.`);
      console.log(`[MindooDBServer] WARNING: Set MINDOODB_ADMIN_API_KEY environment variable for production use.`);
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

  listen(port: number): void {
    const server = this.app.listen(port, () => {
      console.log(`[MindooDBServer] Listening on port ${port}`);
      this.logAdminKeyStatus();
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
      this.logAdminKeyStatus();
    });

    server.setTimeout(30_000);
  }

  private logAdminKeyStatus(): void {
    if (this.adminApiKey) {
      console.log(`[MindooDBServer] Admin endpoints protected by API key`);
    } else {
      console.log(`[MindooDBServer] Admin endpoints OPEN (no API key set)`);
    }
  }

  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet());

    // CORS
    const corsOrigin = process.env.MINDOODB_CORS_ORIGIN;
    this.app.use(cors({
      origin: corsOrigin || false,
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    }));

    // Global rate limit
    this.app.use(rateLimit({
      windowMs: 60_000,
      max: 500,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later" },
    }));

    // JSON body parsing with reduced size limit
    this.app.use(express.json({ limit: "5mb" }));

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Root redirect: forward GET / to /statics/index.html if available
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

    // Static file serving (if configured)
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

    // Admin routes with tiered auth and rate limiting
    const adminRateLimit = rateLimit({
      windowMs: 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many admin requests, please try again later" },
    });

    const adminRouter = Router();
    this.setupAdminRoutes(adminRouter);
    this.app.use("/admin", adminRateLimit, adminRouter);

    // Tenant-scoped routes
    this.app.use("/:tenantId", this.tenantMiddleware.bind(this), this.createTenantRouter());

    this.app.use(this.errorHandler.bind(this));
  }

  // ==================== Auth Middleware ====================

  private adminOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.adminApiKey) {
      return next();
    }

    const providedKey = req.headers["x-api-key"] as string | undefined;
    if (!providedKey || !safeCompare(providedKey, this.adminApiKey)) {
      res.status(401).json({ error: "Invalid or missing admin API key" });
      return;
    }

    next();
  }

  private tenantCreationMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.adminApiKey) {
      return next();
    }

    const providedKey = req.headers["x-api-key"] as string | undefined;
    if (!providedKey) {
      res.status(401).json({ error: "API key required" });
      return;
    }

    if (safeCompare(providedKey, this.adminApiKey)) {
      return next();
    }

    const tenantId = req.body?.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    if (this.tenantManager.validateTenantCreationKey(providedKey, tenantId)) {
      return next();
    }

    res.status(403).json({ error: "API key not authorized for this tenant ID" });
  }

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

  // ==================== Admin Routes ====================

  private setupAdminRoutes(router: Router): void {
    router.post(
      "/register-tenant",
      this.tenantCreationMiddleware.bind(this),
      (req: Request, res: Response) => {
        try {
          const request: RegisterTenantRequest = req.body;

          if (!request.tenantId) {
            res.status(400).json({ error: "tenantId is required" });
            return;
          }

          try {
            validateTenantId(request.tenantId.toLowerCase());
          } catch (validationError) {
            res.status(400).json({ error: validationError instanceof ValidationError ? validationError.message : "Invalid tenantId format" });
            return;
          }

          if (!request.adminSigningPublicKey) {
            res.status(400).json({ error: "adminSigningPublicKey is required" });
            return;
          }
          if (!request.adminEncryptionPublicKey) {
            res.status(400).json({ error: "adminEncryptionPublicKey is required" });
            return;
          }

          validateStringLength(request.adminSigningPublicKey, MAX_PEM_KEY_LENGTH, "adminSigningPublicKey");
          validateStringLength(request.adminEncryptionPublicKey, MAX_PEM_KEY_LENGTH, "adminEncryptionPublicKey");

          if (this.tenantManager.tenantExists(request.tenantId)) {
            res.status(409).json({ error: `Tenant ${request.tenantId} already exists` });
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
      },
    );

    const adminOnly = this.adminOnlyMiddleware.bind(this);

    router.get("/tenants", adminOnly, (req: Request, res: Response) => {
      try {
        const tenants = this.tenantManager.listTenants();
        const response: ListTenantsResponse = { tenants };
        res.json(response);
      } catch (error) {
        console.error("[MindooDBServer] Error listing tenants:", error);
        res.status(500).json({ error: "Failed to list tenants" });
      }
    });

    router.delete("/tenants/:tenantId", adminOnly, (req: Request, res: Response) => {
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
    router.get("/trusted-servers", adminOnly, (req: Request, res: Response) => {
      try {
        res.json({ servers: this.tenantManager.listTrustedServers() });
      } catch (error) {
        console.error("[MindooDBServer] Error listing trusted servers:", error);
        res.status(500).json({ error: "Failed to list trusted servers" });
      }
    });

    router.post("/trusted-servers", adminOnly, (req: Request, res: Response) => {
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

    router.delete("/trusted-servers/:serverName", adminOnly, (req: Request, res: Response) => {
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
    router.get("/tenant-api-keys", adminOnly, (req: Request, res: Response) => {
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

    router.post("/tenant-api-keys", adminOnly, (req: Request, res: Response) => {
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

    router.delete("/tenant-api-keys/:name", adminOnly, (req: Request, res: Response) => {
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

    router.post("/admin/trigger-sync", this.handleTriggerSync.bind(this));

    return router;
  }

  // ==================== Validation Helpers ====================

  private validateDbId(dbId: unknown): string {
    return validateIdentifier(dbId, "dbId");
  }

  // ==================== Auth Handlers ====================

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

  /**
   * Unified error handler. Returns known auth/validation errors with their
   * messages; everything else gets a generic "Internal server error" to
   * prevent leaking implementation details.
   */
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
