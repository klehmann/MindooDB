/**
 * MindooDB Example Server - Express HTTP server implementing the sync API.
 *
 * Features:
 * - Client-to-server sync via authenticated endpoints
 * - Server-to-server sync via global server identity + trusted servers
 * - Tiered admin auth: full admin key, delegated tenant creation keys
 * - Runtime management of trusted servers and tenant creation keys
 */

import express, { Request, Response, NextFunction, Router } from "express";
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

export class MindooDBServer {
  private app: express.Application;
  private tenantManager: TenantManager;
  private adminApiKey: string | undefined;

  constructor(dataDir: string, serverPassword?: string) {
    this.app = express();
    this.tenantManager = new TenantManager(dataDir, serverPassword);
    this.adminApiKey = process.env.MINDOODB_ADMIN_API_KEY;

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
    this.app.use(express.json({ limit: "50mb" }));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: Date.now() });
    });

    // Admin routes with tiered auth
    const adminRouter = Router();
    this.setupAdminRoutes(adminRouter);
    this.app.use("/admin", adminRouter);

    // Tenant-scoped routes
    this.app.use("/:tenantId", this.tenantMiddleware.bind(this), this.createTenantRouter());

    this.app.use(this.errorHandler.bind(this));
  }

  // ==================== Auth Middleware ====================

  /**
   * Requires the full admin API key. Used for trusted servers, tenant
   * creation keys, listing/deleting tenants.
   */
  private adminOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.adminApiKey) {
      return next();
    }

    const providedKey = req.headers["x-api-key"] as string | undefined;
    if (providedKey !== this.adminApiKey) {
      res.status(401).json({ error: "Invalid or missing admin API key" });
      return;
    }

    next();
  }

  /**
   * Accepts EITHER the admin API key OR a valid tenant creation key.
   * When a tenant creation key is used, the tenantId in the request body
   * is validated against the key's prefix constraint.
   */
  private tenantCreationMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.adminApiKey) {
      return next();
    }

    const providedKey = req.headers["x-api-key"] as string | undefined;
    if (!providedKey) {
      res.status(401).json({ error: "API key required" });
      return;
    }

    // Full admin key: allow everything
    if (providedKey === this.adminApiKey) {
      return next();
    }

    // Check tenant creation keys
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

  // ==================== Admin Routes ====================

  private setupAdminRoutes(router: Router): void {
    // Tenant registration uses tenantCreationMiddleware (admin key OR tenant creation key)
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
          if (!request.adminSigningPublicKey) {
            res.status(400).json({ error: "adminSigningPublicKey is required" });
            return;
          }
          if (!request.adminEncryptionPublicKey) {
            res.status(400).json({ error: "adminEncryptionPublicKey is required" });
            return;
          }

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
      },
    );

    // All other admin endpoints require the full admin API key
    const adminOnly = this.adminOnlyMiddleware.bind(this);

    // Tenant listing and removal
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

        const server: TrustedServer = { name, signingPublicKey, encryptionPublicKey };
        this.tenantManager.addTrustedServer(server);

        res.status(201).json({ success: true, message: `Trusted server "${name}" added` });
      } catch (error) {
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
        const removed = this.tenantManager.removeTrustedServer(serverName);

        if (!removed) {
          res.status(404).json({ error: `Trusted server "${serverName}" not found` });
          return;
        }

        res.json({ success: true, message: `Trusted server "${serverName}" removed` });
      } catch (error) {
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

        const key = this.tenantManager.addTenantCreationKey(name, tenantIdPrefix);

        res.status(201).json({
          success: true,
          name: key.name,
          apiKey: key.apiKey,
          tenantIdPrefix: key.tenantIdPrefix,
          createdAt: key.createdAt,
        });
      } catch (error) {
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
        const removed = this.tenantManager.removeTenantCreationKey(name);

        if (!removed) {
          res.status(404).json({ error: `Tenant creation key "${name}" not found` });
          return;
        }

        res.json({ success: true, message: `Tenant creation key "${name}" removed` });
      } catch (error) {
        console.error("[MindooDBServer] Error removing tenant creation key:", error);
        res.status(500).json({ error: "Failed to remove tenant creation key" });
      }
    });
  }

  // ==================== Tenant Routes ====================

  private createTenantRouter(): Router {
    const router = Router({ mergeParams: true });

    router.post("/auth/challenge", this.handleChallenge.bind(this));
    router.post("/auth/authenticate", this.handleAuthenticate.bind(this));

    router.post("/sync/findNewEntries", this.handleFindNewEntries.bind(this));
    router.post("/sync/findNewEntriesForDoc", this.handleFindNewEntriesForDoc.bind(this));
    router.post("/sync/findEntries", this.handleFindEntries.bind(this));
    router.post("/sync/scanEntriesSince", this.handleScanEntriesSince.bind(this));
    router.post("/sync/getIdBloomSummary", this.handleGetIdBloomSummary.bind(this));
    router.post("/sync/getCompactionStatus", this.handleGetCompactionStatus.bind(this));
    router.get("/sync/capabilities", this.handleGetCapabilities.bind(this));
    router.post("/sync/getEntries", this.handleGetEntries.bind(this));
    router.post("/sync/putEntries", this.handlePutEntries.bind(this));
    router.post("/sync/hasEntries", this.handleHasEntries.bind(this));
    router.get("/sync/getAllIds", this.handleGetAllIds.bind(this));
    router.post("/sync/resolveDependencies", this.handleResolveDependencies.bind(this));

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

      const authService = await this.tenantManager.getAuthService(req.tenantId!);
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

      const authService = await this.tenantManager.getAuthService(req.tenantId!);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
      const entries = await serverStore.handleFindNewEntriesForDoc(token, haveIds || [], docId);

      res.json({
        entries: entries.map((e: StoreEntryMetadata) => this.serializeEntryMetadata(e)),
      });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleFindEntries(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId, type, creationDateFrom, creationDateUntil } = req.body;

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
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
      this.handleNetworkError(error, res);
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

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
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
      this.handleNetworkError(error, res);
    }
  }

  private async handleGetIdBloomSummary(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
      const summary = await serverStore.handleGetIdBloomSummary(token);
      res.json({ summary: summary as StoreIdBloomSummary });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleGetCapabilities(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const dbId = (req.query.dbId as string) || "directory";
      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
      const capabilities = await serverStore.handleGetCapabilities(token);
      res.json({ capabilities: capabilities as NetworkSyncCapabilities });
    } catch (error) {
      this.handleNetworkError(error, res);
    }
  }

  private async handleGetCompactionStatus(req: Request, res: Response): Promise<void> {
    try {
      const token = this.extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      if (!dbId) {
        res.status(400).json({ error: "dbId is required" });
        return;
      }

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
      const status = await serverStore.handleGetCompactionStatus(token);
      res.json({ status: status as StoreCompactionStatus });
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
      const deserializedEntries = (entries || []).map((e: SerializedEntry) =>
        this.deserializeEntry(e),
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
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

      const serverStore = await this.tenantManager.getServerStore(req.tenantId!, dbId);
      const ids = await serverStore.handleResolveDependencies(token, startId, options);

      res.json({ ids });
    } catch (error) {
      this.handleNetworkError(error, res);
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
