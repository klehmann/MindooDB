/**
 * MindooDB Example Server - Express HTTP server implementing the sync API.
 */

import express, { Request, Response, NextFunction, Router } from "express";
import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../../../src/core/types";
import { NetworkError, NetworkErrorType } from "../../../src/core/appendonlystores/network/types";

import { TenantManager } from "./TenantManager";
import type {
  RegisterTenantRequest,
  RegisterTenantResponse,
  ListTenantsResponse,
  ENV_VARS,
} from "./types";

// Extend Express Request to include tenant context
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

/**
 * Serialized entry metadata for JSON transport (Uint8Array -> base64).
 */
interface SerializedEntryMetadata {
  entryType: StoreEntryType;
  id: string;
  contentHash: string;
  docId: string;
  dependencyIds: string[];
  createdAt: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  signature: string; // base64
  originalSize: number;
  encryptedSize: number;
}

/**
 * Serialized full entry for JSON transport.
 */
interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string; // base64
}

/**
 * Serialized network encrypted entry.
 */
interface SerializedNetworkEncryptedEntry extends SerializedEntryMetadata {
  rsaEncryptedPayload: string; // base64
}

/**
 * MindooDBServer is the main Express server that implements
 * the HTTP endpoints for client-to-server and server-to-server sync.
 */
export class MindooDBServer {
  private app: express.Application;
  private tenantManager: TenantManager;
  private adminApiKey: string | undefined;

  constructor(dataDir: string) {
    this.app = express();
    this.tenantManager = new TenantManager(dataDir);
    this.adminApiKey = process.env.MINDOODB_ADMIN_API_KEY;

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Get the Express application for testing or custom configuration.
   */
  getApp(): express.Application {
    return this.app;
  }

  /**
   * Get the tenant manager for direct access.
   */
  getTenantManager(): TenantManager {
    return this.tenantManager;
  }

  /**
   * Start listening on the specified port.
   */
  listen(port: number): void {
    this.app.listen(port, () => {
      console.log(`[MindooDBServer] Listening on port ${port}`);
      if (this.adminApiKey) {
        console.log(`[MindooDBServer] Admin endpoints protected by API key`);
      } else {
        console.log(`[MindooDBServer] Admin endpoints OPEN (no API key set)`);
      }
    });
  }

  private setupMiddleware(): void {
    // Parse JSON bodies up to 50MB (for sync payloads)
    this.app.use(express.json({ limit: "50mb" }));

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check (must be before tenant routes to avoid being caught by /:tenantId)
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: Date.now() });
    });

    // Admin routes (optional API key protection)
    const adminRouter = Router();
    this.setupAdminRoutes(adminRouter);
    this.app.use("/admin", this.adminAuthMiddleware.bind(this), adminRouter);

    // Tenant-scoped routes
    this.app.use("/:tenantId", this.tenantMiddleware.bind(this), this.createTenantRouter());

    // Error handler
    this.app.use(this.errorHandler.bind(this));
  }

  /**
   * Middleware to check admin API key (if configured).
   */
  private adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.adminApiKey) {
      // No API key configured - endpoints are open
      return next();
    }

    const providedKey = req.headers["x-api-key"];
    if (providedKey !== this.adminApiKey) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    next();
  }

  /**
   * Middleware to validate and normalize tenant ID.
   */
  private tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
    const tenantId = req.params.tenantId?.toLowerCase();

    if (!tenantId) {
      res.status(400).json({ error: "Tenant ID required" });
      return;
    }

    if (!this.tenantManager.tenantExists(tenantId)) {
      res.status(404).json({ error: `Tenant ${tenantId} not found` });
      return;
    }

    req.tenantId = tenantId;
    next();
  }

  /**
   * Setup admin routes.
   */
  private setupAdminRoutes(router: Router): void {
    // Register a new tenant
    router.post("/register-tenant", (req: Request, res: Response) => {
      try {
        const request: RegisterTenantRequest = req.body;

        // Validate required fields
        if (!request.tenantId) {
          res.status(400).json({ error: "tenantId is required" });
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

        // Check if tenant already exists
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
        console.error("[MindooDBServer] Error registering tenant:", error);
        res.status(500).json({ error: "Failed to register tenant" });
      }
    });

    // List all tenants
    router.get("/tenants", (req: Request, res: Response) => {
      try {
        const tenants = this.tenantManager.listTenants();
        const response: ListTenantsResponse = { tenants };
        res.json(response);
      } catch (error) {
        console.error("[MindooDBServer] Error listing tenants:", error);
        res.status(500).json({ error: "Failed to list tenants" });
      }
    });

    // Remove a tenant
    router.delete("/tenants/:tenantId", (req: Request, res: Response) => {
      try {
        const tenantId = req.params.tenantId.toLowerCase();

        if (!this.tenantManager.tenantExists(tenantId)) {
          res.status(404).json({ error: `Tenant ${tenantId} not found` });
          return;
        }

        this.tenantManager.removeTenant(tenantId);
        res.json({ success: true, message: `Tenant ${tenantId} removed` });
      } catch (error) {
        console.error("[MindooDBServer] Error removing tenant:", error);
        res.status(500).json({ error: "Failed to remove tenant" });
      }
    });
  }

  /**
   * Create router for tenant-scoped routes.
   */
  private createTenantRouter(): Router {
    const router = Router({ mergeParams: true });

    // Auth routes
    router.post("/auth/challenge", this.handleChallenge.bind(this));
    router.post("/auth/authenticate", this.handleAuthenticate.bind(this));

    // Sync routes
    router.post("/sync/findNewEntries", this.handleFindNewEntries.bind(this));
    router.post("/sync/findNewEntriesForDoc", this.handleFindNewEntriesForDoc.bind(this));
    router.post("/sync/getEntries", this.handleGetEntries.bind(this));
    router.post("/sync/putEntries", this.handlePutEntries.bind(this));
    router.post("/sync/hasEntries", this.handleHasEntries.bind(this));
    router.get("/sync/getAllIds", this.handleGetAllIds.bind(this));
    router.post("/sync/resolveDependencies", this.handleResolveDependencies.bind(this));

    // Management routes
    router.post("/admin/trigger-sync", this.handleTriggerSync.bind(this));

    return router;
  }

  // ==================== Auth Handlers ====================

  private async handleChallenge(req: Request, res: Response): Promise<void> {
    try {
      const { username } = req.body;

      if (!username) {
        res.status(400).json({ error: "username is required" });
        return;
      }

      const authService = this.tenantManager.getAuthService(req.tenantId!);
      const challenge = await authService.generateChallenge(username);

      res.json({ challenge });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleAuthenticate(req: Request, res: Response): Promise<void> {
    try {
      const { challenge, signature } = req.body;

      if (!challenge || !signature) {
        res.status(400).json({ error: "challenge and signature are required" });
        return;
      }

      const authService = this.tenantManager.getAuthService(req.tenantId!);
      const signatureBytes = this.base64ToUint8Array(signature);
      const result = await authService.authenticate(challenge, signatureBytes);

      res.json(result);
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  // ==================== Sync Handlers ====================

  private async handleFindNewEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, haveIds } = req.body;

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const entries = await serverStore.handleFindNewEntries(token, haveIds || []);

      res.json({
        entries: entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
      });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleFindNewEntriesForDoc(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, haveIds, docId } = req.body;

      if (!dbId || !docId) {
        res.status(400).json({ error: "dbId and docId are required" });
        return;
      }

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const entries = await serverStore.handleFindNewEntriesForDoc(token, haveIds || [], docId);

      res.json({
        entries: entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
      });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleGetEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, ids } = req.body;

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const entries = await serverStore.handleGetEntries(token, ids || []);

      res.json({
        entries: entries.map((e: { rsaEncryptedPayload: Uint8Array } & StoreEntryMetadata) => ({
          ...this.serializeEntryMetadata(e),
          rsaEncryptedPayload: this.uint8ArrayToBase64(e.rsaEncryptedPayload),
        })),
      });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handlePutEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, entries } = req.body;

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const deserializedEntries = (entries || []).map((e: SerializedEntry) =>
        this.deserializeEntry(e)
      );

      await serverStore.handlePutEntries(token, deserializedEntries);

      res.json({ success: true });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleHasEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, ids } = req.body;

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const existingIds = await serverStore.handleHasEntries(token, ids || []);

      res.json({ ids: existingIds });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleGetAllIds(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const dbId = (req.query.dbId as string) || "directory";

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const ids = await serverStore.handleGetAllIds(token);

      res.json({ ids });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleResolveDependencies(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, startId, options } = req.body;

      if (!dbId || !startId) {
        res.status(400).json({ error: "dbId and startId are required" });
        return;
      }

      const serverStore = this.tenantManager.getServerStore(req.tenantId!, dbId);
      const ids = await serverStore.handleResolveDependencies(token, startId, options);

      res.json({ ids });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  // ==================== Management Handlers ====================

  private async handleTriggerSync(req: Request, res: Response): Promise<void> {
    // TODO: Implement server-to-server sync trigger
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

  private handleNetworkError(error: unknown, res: Response): void {
    console.error("[MindooDBServer] Request error:", error);

    if (error instanceof Error && error.name === "NetworkError") {
      const networkError = error as NetworkError;
      const status = this.getStatusForErrorType(networkError.type);
      res.status(status).json({ error: networkError.message });
    } else if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
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
