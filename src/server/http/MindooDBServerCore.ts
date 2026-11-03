/**
 * Platform-neutral route handlers of the MindooDB server.
 *
 * Every endpoint of the HTTP API that does not depend on the host runtime —
 * discovery, device discovery, system administration, tenant auth, the sync
 * protocol and the RFC 3161 proxy — is implemented here against
 * {@link ServerRequest}/{@link ServerResponse}. Hosts own the transport: the
 * Node server mounts these handlers on Express with its middleware stack, a
 * serverless host calls them from its `fetch` handler.
 *
 * This module must stay free of Node built-ins; a test bundles it for a
 * neutral platform to keep it that way.
 */

import { isMissingDependencyError } from "../../core/errors";
import {
  BINARY_ENTRIES_CONTENT_TYPE,
  BINARY_GET_ENTRIES_FORMAT,
  BINARY_PUT_ENTRIES_FORMAT,
  decodeBinaryEntryMessage,
  encodeBinaryEntryMessage,
} from "../../core/appendonlystores/network/binaryEntryFraming";
import {
  deserializeEntryMetadata,
  deserializeStoreEntry,
  serializeEntryMetadata,
  type SerializedEntry,
  type SerializedEntryMetadata,
} from "../../core/appendonlystores/network/entryWireCodec";
import type {
  StoreEntryMetadata,
  StoreScanCursor,
  StoreScanFilters,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../../core/types";
import { StoreKind } from "../../core/appendonlystores/types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
} from "../../core/appendonlystores/types";
import type { NetworkSyncCapabilities } from "../../core/appendonlystores/network/types";
import { NetworkError } from "../../core/appendonlystores/network/types";
import { assertSafeSyncUrl, UnsafeUrlError } from "../../core/utils/urlSafety";
import { base64ToBytes, bytesToBase64 } from "../../core/utils/base64";

import type { TenantManager } from "../TenantManager";
import { CapabilityMatcher, parseSystemTenantItemPath } from "../CapabilityMatcher";
import type { SystemAdminAuthService } from "../SystemAdminAuth";
import { DeviceDiscoveryAuthError, type DeviceDiscoveryService } from "../DeviceDiscoveryService";
import { isConfigBackupFilename, validateServerConfig, type ServerConfigRepository } from "../serverConfig";
import type { SyncChangeEvent } from "../SyncEventBus";
import { isPeerAttachmentMode, isPeerRole, isPeerSyncDirection } from "../peer/types";
import type {
  ListTenantsResponse,
  RegisterTenantRequest,
  RegisterTenantResponse,
  ServerConfig,
  TenantPublicInfosFingerprintsResponse,
  TrustedServer,
} from "../types";
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
} from "../validation";
import {
  requestTimestampToken,
  toPublicTsaProviders,
  TimestampProxyError,
  TIMESTAMP_QUERY_CONTENT_TYPE,
  TIMESTAMP_REPLY_CONTENT_TYPE,
  type TsaProviderConfig,
} from "../timestampProxy";
import {
  jsonResponse,
  type BackgroundTaskScheduler,
  type ServerRequest,
  type ServerResponse,
  type SyncEventPublisher,
} from "./types";

/** Parse a human-readable size string ("5mb", "1024", "100kb") into bytes. */
export function parseBodySizeLimitToBytes(limit: string): number | null {
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

/**
 * The parts of peer replication the tenant routes touch. Optional: a host
 * without clustering serves the same API minus mirrors and loop labels.
 */
export interface ServerClusterHooks {
  /** Mirrors of one tenant, for `/.well-known/mindoodb-cluster`. */
  mirrorsForTenant(tenantId: string): unknown[];
  /** Re-read trusted servers and start/stop replicators accordingly. */
  syncReplicators(): void;
  /**
   * Name of the trusted peer a sync token belongs to, or undefined for a
   * client token. Labels change events so a write that came from a peer is not
   * pushed straight back to it.
   */
  resolvePeerName(token: string): Promise<string | undefined>;
}

export interface MindooDBServerCoreOptions {
  tenantManager: TenantManager;
  systemAdminAuth: SystemAdminAuthService;
  capabilityMatcher: CapabilityMatcher;
  deviceDiscovery: DeviceDiscoveryService;
  syncEvents: SyncEventPublisher;
  configRepository: ServerConfigRepository;
  /** Current `config.json`; read on every request so hot reloads take effect. */
  getServerConfig(): ServerConfig;
  /** Hot-swap the config after `PUT /system/config` persisted it. */
  reloadConfig(config: ServerConfig): void;
  /** Upstream TSAs; empty when the timestamp proxy is disabled. */
  tsaProviders: TsaProviderConfig[];
  /** JSON body limit as configured (e.g. "5mb"), advertised to clients. */
  jsonBodyLimit: string;
  /** Allow plain-http and private trusted-server URLs (development). */
  allowInsecureSyncUrls: boolean;
  cluster?: ServerClusterHooks;
  /** Where post-response work goes; defaults to fire-and-forget. */
  runInBackground?: BackgroundTaskScheduler;
  /**
   * Runs after a write to a tenant's `directory` database was accepted.
   * Defaults to executing the purge requests it may carry. A host that keeps
   * other databases elsewhere passes the change on to them instead.
   */
  onDirectoryWrite?: (tenantId: string) => Promise<void>;
}

/** HTTP status of each {@link NetworkError} type. */
function getStatusForErrorType(type: string): number {
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
    case "ACCESS_DENIED":
      return 403;
    default:
      return 500;
  }
}

/** Map domain errors to HTTP responses; unknown errors become 500. */
export function errorResponse(error: unknown): ServerResponse {
  if (error instanceof ValidationError) {
    return jsonResponse(400, { error: error.message });
  }

  if (error instanceof Error && error.name === "NetworkError") {
    const networkError = error as NetworkError;
    const status = getStatusForErrorType(networkError.type);
    // The status alone loses the distinction the client needs: several
    // NetworkErrorTypes map onto the same code (USER_REVOKED and
    // ACCESS_DENIED both become 403), and a client that has to guess falls
    // back to matching on the message text. Carry the type so it does not
    // have to.
    return jsonResponse(status, { error: networkError.message, type: networkError.type });
  }

  if (isMissingDependencyError(error)) {
    // Not a server fault: the requested chain is incomplete in this store.
    // Pass the details on so the caller can tell what is missing.
    return jsonResponse(409, { error: (error as Error).message, type: "MISSING_DEPENDENCY" });
  }

  console.error("[MindooDBServer] Request error:", error);
  return jsonResponse(500, { error: "Internal server error" });
}

function extractToken(req: ServerRequest): string {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new NetworkError("INVALID_TOKEN" as any, "Missing or invalid Authorization header");
  }
  return auth.substring(7);
}

function validateDbId(dbId: unknown): string {
  return validateIdentifier(dbId, "dbId");
}

/** `event: hello` frame that opens every sync event stream. */
export function formatSyncHelloEvent(): string {
  return `event: hello\ndata: ${JSON.stringify({ protocolVersion: "sync-v5" })}\n\n`;
}

/**
 * `event: change` frame for a subscriber of `tenantId`/`storeKind`, or null
 * when the event belongs to someone else. Events carry only metadata.
 */
export function formatSyncChangeEvent(
  subscription: { tenantId: string; storeKind: string },
  event: SyncChangeEvent,
): string | null {
  if (event.tenantId !== subscription.tenantId || event.storeKind !== subscription.storeKind) {
    return null;
  }
  return `event: change\ndata: ${JSON.stringify({
    dbId: event.dbId,
    storeKind: event.storeKind,
    epoch: event.epoch,
    maxReceiptOrder: event.maxReceiptOrder,
  })}\n\n`;
}

/** Comment frame that keeps proxies from closing an idle stream. */
export function formatSyncHeartbeat(now: number): string {
  return `: heartbeat ${now}\n\n`;
}

/** Interval of {@link formatSyncHeartbeat} frames. */
export const SYNC_EVENT_HEARTBEAT_MS = 30_000;

/** Sync endpoints mounted under `/:tenantId/sync/{docs,attachments}/`. */
export const SYNC_ROUTES = [
  { method: "POST", name: "findNewEntries" },
  { method: "POST", name: "findNewEntriesForDoc" },
  { method: "POST", name: "findEntries" },
  { method: "POST", name: "scanEntriesSince" },
  { method: "POST", name: "getStoreHead" },
  { method: "POST", name: "getIdBloomSummary" },
  { method: "POST", name: "getCompactionStatus" },
  { method: "GET", name: "capabilities" },
  // SSE live change feed (sync-v5, phase 5): one long-lived GET per
  // subscriber; putEntries publishes into the event bus.
  { method: "GET", name: "events" },
  { method: "POST", name: "getEntries" },
  // Binary wire format v2 (sync-v5, phase 3): octet-stream framing for the
  // two payload-heavy endpoints. putEntriesBinary takes a raw body.
  { method: "POST", name: "getEntriesBinary" },
  { method: "POST", name: "putEntriesBinary", rawBodyType: BINARY_ENTRIES_CONTENT_TYPE },
  { method: "POST", name: "getEntryMetadata" },
  { method: "POST", name: "putEntries" },
  { method: "POST", name: "hasEntries" },
  { method: "GET", name: "getAllIds" },
  { method: "POST", name: "resolveDependencies" },
  { method: "POST", name: "planDocumentMaterialization" },
  { method: "POST", name: "planDocumentMaterializationBatch" },
  { method: "POST", name: "planAttachmentReadByWalkingMetadata" },
] as const;

export type SyncRouteName = (typeof SYNC_ROUTES)[number]["name"];

export const SYNC_STORE_KINDS = [StoreKind.docs, StoreKind.attachments] as const;

export class MindooDBServerCore {
  private readonly options: MindooDBServerCoreOptions;
  private readonly jsonBodyLimitBytes: number | null;

  constructor(options: MindooDBServerCoreOptions) {
    this.options = options;
    this.jsonBodyLimitBytes = parseBodySizeLimitToBytes(options.jsonBodyLimit);
  }

  private get tenantManager(): TenantManager {
    return this.options.tenantManager;
  }

  private runInBackground(task: Promise<unknown>): void {
    if (this.options.runInBackground) {
      this.options.runInBackground(task);
    } else {
      void task;
    }
  }

  getJsonBodyLimit(): { limit: string; bytes: number | null } {
    return { limit: this.options.jsonBodyLimit, bytes: this.jsonBodyLimitBytes };
  }

  // ==================== Discovery ====================

  health(): ServerResponse {
    return jsonResponse(200, { status: "ok", timestamp: Date.now() });
  }

  serverInfo(): ServerResponse {
    const info = this.tenantManager.getServerPublicInfo();
    if (!info) {
      return jsonResponse(503, { error: "Server identity not initialized" });
    }
    return jsonResponse(200, {
      ...info,
      // Its own mesh role, so `add-to-network` can propagate it into the
      // other side's trusted-servers entry instead of asking the operator to
      // repeat it on every node.
      clusterRole: this.options.getServerConfig().cluster?.role ?? "peer",
      maxJsonRequestBodyLimit: this.options.jsonBodyLimit,
      maxJsonRequestBodyBytes: this.jsonBodyLimitBytes ?? undefined,
      // Lets a client decide between calling a browser-reachable TSA directly
      // and routing through this server, per tenant and without a probe.
      timestamping: {
        enabled: this.options.tsaProviders.length > 0,
        providers: toPublicTsaProviders(this.options.tsaProviders),
      },
    });
  }

  /**
   * Mirrors of one tenant, for client failover.
   *
   * Scoped to the tenant in the query on purpose: a client asking about
   * tenant A must not learn which other tenants this server replicates, or
   * to whom. Unauthenticated like the other discovery endpoints — a client
   * needs it precisely when it cannot reach a server to authenticate with.
   */
  clusterMirrors(req: ServerRequest): ServerResponse {
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId.toLowerCase() : "";
    if (!tenantId) {
      return jsonResponse(400, { error: "tenantId query parameter is required" });
    }
    try {
      validateTenantId(tenantId);
    } catch {
      return jsonResponse(400, { error: "Invalid tenantId format" });
    }
    if (!this.tenantManager.tenantExists(tenantId)) {
      return jsonResponse(404, { error: "Tenant not found on server" });
    }
    return jsonResponse(200, {
      tenantId,
      mirrors: this.options.cluster?.mirrorsForTenant(tenantId) ?? [],
    });
  }

  async publicInfosFingerprints(req: ServerRequest): Promise<ServerResponse> {
    const tenantId = (req.params.tenantId ?? "").toLowerCase();
    try {
      validateTenantId(tenantId);
      const fingerprints = await this.tenantManager.listTenantPublicInfosFingerprints(tenantId);
      if (fingerprints.length === 0) {
        return jsonResponse(404, { error: "Tenant not found on server" });
      }
      const response: TenantPublicInfosFingerprintsResponse = {
        tenantId,
        fingerprints,
      };
      return jsonResponse(200, response);
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof Error && error.message.includes("not found")) {
        return jsonResponse(404, { error: "Tenant not found on server" });
      }
      console.error("[MindooDBServer] Error reading tenant publicInfos fingerprints:", error);
      return jsonResponse(500, { error: "Failed to read tenant publicInfos fingerprints" });
    }
  }

  // ==================== Device Discovery (server-wide) ====================

  async deviceChallenge(req: ServerRequest): Promise<ServerResponse> {
    try {
      const { signingPublicKey } = req.body ?? {};
      if (typeof signingPublicKey !== "string" || !signingPublicKey.trim()) {
        return jsonResponse(400, { error: "signingPublicKey is required" });
      }
      validateStringLength(signingPublicKey, MAX_PEM_KEY_LENGTH, "signingPublicKey");
      const challenge = this.options.deviceDiscovery.createChallenge(signingPublicKey);
      return jsonResponse(200, { challenge });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async deviceDiscover(req: ServerRequest): Promise<ServerResponse> {
    try {
      const { challenge, signature } = req.body ?? {};
      if (typeof challenge !== "string" || !challenge.trim()) {
        return jsonResponse(400, { error: "challenge is required" });
      }
      if (typeof signature !== "string" || !signature.trim()) {
        return jsonResponse(400, { error: "signature is required" });
      }
      validateStringLength(challenge, MAX_CHALLENGE_LENGTH, "challenge");
      validateStringLength(signature, MAX_SIGNATURE_LENGTH, "signature");
      const result = await this.options.deviceDiscovery.discover(challenge, base64ToBytes(signature));
      return jsonResponse(200, result);
    } catch (error) {
      if (error instanceof DeviceDiscoveryAuthError) {
        return jsonResponse(401, { error: error.message });
      }
      return errorResponse(error);
    }
  }

  // ==================== System Admin Auth ====================

  /**
   * JWT check for /system/* routes (excluding /system/auth/*). Validates the
   * bearer token, then checks capabilities for (method, fullPath, username,
   * publicsignkey). Returns the rejection, or null and sets `req.systemAdmin`.
   *
   * `DELETE /system/tenants/:tenantId` is also allowed when the JWT signing
   * key is that tenant's registered `adminSigningPublicKey` (own-tenant
   * delete). Sub-resources and other tenants stay capability-gated.
   */
  async systemAdminGuard(req: ServerRequest, fullPath: string): Promise<ServerResponse | null> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return jsonResponse(401, { error: "Missing or invalid Authorization header" });
    }

    const token = auth.substring(7);
    const payload = await this.options.systemAdminAuth.validateToken(token);
    if (!payload) {
      return jsonResponse(401, { error: "Invalid or expired token" });
    }

    const method = req.method.toUpperCase();
    const capabilityAuthorized = this.options.capabilityMatcher.isAuthorized(
      method,
      fullPath,
      payload.sub,
      payload.publicsignkey,
    );
    const ownerDeleteAuthorized =
      !capabilityAuthorized &&
      this.isOwnTenantDeleteAuthorized(method, fullPath, payload.publicsignkey);

    if (!capabilityAuthorized && !ownerDeleteAuthorized) {
      return jsonResponse(403, { error: "Forbidden: insufficient capabilities" });
    }

    req.systemAdmin = {
      username: payload.sub,
      publicsignkey: payload.publicsignkey,
    };
    return null;
  }

  /**
   * Owner bypass for deleting the caller's own tenant. Matches only
   * `DELETE /system/tenants/:tenantId` (no sub-resource) and requires the
   * JWT public key to equal that tenant's stored admin signing key.
   */
  private isOwnTenantDeleteAuthorized(
    method: string,
    fullPath: string,
    publicsignkey: string,
  ): boolean {
    if (method !== "DELETE") {
      return false;
    }
    const tenantId = parseSystemTenantItemPath(fullPath);
    if (!tenantId) {
      return false;
    }
    try {
      validateTenantIdFormat(tenantId);
    } catch {
      return false;
    }
    return this.tenantManager.isTenantAdminSigningKeyFor(tenantId, publicsignkey);
  }

  async systemChallenge(req: ServerRequest): Promise<ServerResponse> {
    try {
      const { username, publicsignkey } = req.body;

      if (!username || typeof username !== "string") {
        return jsonResponse(400, { error: "username is required" });
      }
      if (!publicsignkey || typeof publicsignkey !== "string") {
        return jsonResponse(400, { error: "publicsignkey is required" });
      }

      validateUsername(username);
      validateStringLength(publicsignkey, MAX_PEM_KEY_LENGTH, "publicsignkey");

      const challenge = await this.options.systemAdminAuth.generateChallenge(
        username,
        publicsignkey,
      );
      return jsonResponse(200, { challenge });
    } catch (error) {
      if (error instanceof Error && error.message === "Unknown system admin principal") {
        return jsonResponse(404, { error: "System admin principal not found" });
      }
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      console.error("[MindooDBServer] System challenge error:", error);
      return jsonResponse(500, { error: "Internal server error" });
    }
  }

  async systemAuthenticate(req: ServerRequest): Promise<ServerResponse> {
    try {
      const { challenge, signature } = req.body;

      if (!challenge || !signature) {
        return jsonResponse(400, { error: "challenge and signature are required" });
      }

      validateStringLength(challenge, MAX_CHALLENGE_LENGTH, "challenge");
      validateStringLength(signature, MAX_SIGNATURE_LENGTH, "signature");

      const result = await this.options.systemAdminAuth.authenticate(challenge, base64ToBytes(signature));
      // Return 401 on a failed authentication instead of 200 (audit, Low).
      return jsonResponse(result.success ? 200 : 401, result);
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      console.error("[MindooDBServer] System authenticate error:", error);
      return jsonResponse(500, { error: "Internal server error" });
    }
  }

  // ==================== System: Tenants ====================

  listTenants(): ServerResponse {
    try {
      const tenants = this.tenantManager.listTenants();
      const response: ListTenantsResponse = { tenants };
      return jsonResponse(200, response);
    } catch (error) {
      console.error("[MindooDBServer] Error listing tenants:", error);
      return jsonResponse(500, { error: "Failed to list tenants" });
    }
  }

  /**
   * Tenant registration is idempotent: re-POSTing with the same tenantId
   * and matching $publicinfos key returns 200 instead of 409.
   */
  async registerTenant(req: ServerRequest): Promise<ServerResponse> {
    try {
      const tenantId = (req.params.tenantId ?? "").toLowerCase();

      try {
        validateTenantId(tenantId);
      } catch (validationError) {
        return jsonResponse(400, {
          error: validationError instanceof ValidationError
            ? validationError.message
            : "Invalid tenantId format",
        });
      }

      const request: RegisterTenantRequest = {
        ...req.body,
        tenantId,
      };

      if (!request.adminSigningPublicKey) {
        return jsonResponse(400, { error: "adminSigningPublicKey is required" });
      }
      if (!request.adminEncryptionPublicKey) {
        return jsonResponse(400, { error: "adminEncryptionPublicKey is required" });
      }
      if (request.adminUsername !== undefined) {
        validateUsername(request.adminUsername);
      }

      validateStringLength(request.adminSigningPublicKey, MAX_PEM_KEY_LENGTH, "adminSigningPublicKey");
      validateStringLength(request.adminEncryptionPublicKey, MAX_PEM_KEY_LENGTH, "adminEncryptionPublicKey");
      if (!request.encryptedPublicInfosKey && !request.publicInfosKey) {
        return jsonResponse(400, { error: "encryptedPublicInfosKey or publicInfosKey is required" });
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

      return jsonResponse(result.created ? 201 : 200, response);
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof Error && error.message.includes("different $publicinfos key")) {
        return jsonResponse(409, { error: error.message });
      }
      console.error("[MindooDBServer] Error registering tenant:", error);
      return jsonResponse(500, { error: "Failed to register tenant" });
    }
  }

  updateTenant(req: ServerRequest): ServerResponse {
    try {
      const tenantId = (req.params.tenantId ?? "").toLowerCase();
      try {
        validateTenantId(tenantId);
      } catch {
        return jsonResponse(400, { error: "Invalid tenantId format" });
      }

      if (!this.tenantManager.tenantExists(tenantId)) {
        return jsonResponse(404, { error: "Tenant not found" });
      }

      this.tenantManager.updateTenantConfig(tenantId, req.body);
      return jsonResponse(200, { success: true, message: `Tenant ${tenantId} updated` });
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      console.error("[MindooDBServer] Error updating tenant:", error);
      return jsonResponse(500, { error: "Failed to update tenant" });
    }
  }

  async deleteTenant(req: ServerRequest): Promise<ServerResponse> {
    try {
      const tenantId = (req.params.tenantId ?? "").toLowerCase();

      try {
        validateTenantId(tenantId);
      } catch {
        return jsonResponse(400, { error: "Invalid tenantId format" });
      }

      if (!this.tenantManager.tenantExists(tenantId)) {
        return jsonResponse(404, { error: "Tenant not found" });
      }

      await this.tenantManager.removeTenant(tenantId);
      return jsonResponse(200, { success: true, message: `Tenant ${tenantId} removed` });
    } catch (error) {
      console.error("[MindooDBServer] Error removing tenant:", error);
      return jsonResponse(500, { error: "Failed to remove tenant" });
    }
  }

  // ==================== System: Trusted Servers ====================

  listTrustedServers(): ServerResponse {
    try {
      return jsonResponse(200, { servers: this.tenantManager.listTrustedServers() });
    } catch (error) {
      console.error("[MindooDBServer] Error listing trusted servers:", error);
      return jsonResponse(500, { error: "Failed to list trusted servers" });
    }
  }

  addTrustedServer(req: ServerRequest): ServerResponse {
    try {
      const { name, signingPublicKey, encryptionPublicKey, url, direction, role, attachments } =
        req.body;

      if (!name || !signingPublicKey || !encryptionPublicKey) {
        return jsonResponse(400, { error: "name, signingPublicKey, and encryptionPublicKey are required" });
      }

      validateStringLength(name, 256, "name");
      validateStringLength(signingPublicKey, MAX_PEM_KEY_LENGTH, "signingPublicKey");
      validateStringLength(encryptionPublicKey, MAX_PEM_KEY_LENGTH, "encryptionPublicKey");

      const server: TrustedServer = { name, signingPublicKey, encryptionPublicKey };

      // Replication settings are optional: an entry without a url is a trust
      // relationship only (inbound peers may authenticate, we never dial).
      if (url !== undefined) {
        validateStringLength(url, 2048, "url");
        const allowInsecure = this.options.allowInsecureSyncUrls;
        try {
          assertSafeSyncUrl(url, {
            requireHttps: !allowInsecure,
            allowPrivate: allowInsecure,
          });
        } catch (e) {
          if (e instanceof UnsafeUrlError) {
            return jsonResponse(400, { error: e.message });
          }
          throw e;
        }
        server.url = url;
      }
      for (const [field, value, guard] of [
        ["direction", direction, isPeerSyncDirection],
        ["role", role, isPeerRole],
        ["attachments", attachments, isPeerAttachmentMode],
      ] as const) {
        if (value === undefined) continue;
        if (!guard(value)) {
          return jsonResponse(400, { error: `Invalid ${field}: ${String(value)}` });
        }
        Object.assign(server, { [field]: value });
      }

      this.tenantManager.addTrustedServer(server);
      this.options.cluster?.syncReplicators();

      return jsonResponse(201, { success: true, message: `Trusted server "${name}" added` });
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof Error && error.message.includes("already exists")) {
        return jsonResponse(409, { error: error.message });
      }
      console.error("[MindooDBServer] Error adding trusted server:", error);
      return jsonResponse(500, { error: "Failed to add trusted server" });
    }
  }

  removeTrustedServer(req: ServerRequest): ServerResponse {
    try {
      const serverName = req.params.serverName;
      validateStringLength(serverName, 256, "serverName");

      const removed = this.tenantManager.removeTrustedServer(serverName!);
      if (!removed) {
        return jsonResponse(404, { error: "Trusted server not found" });
      }
      // Revoking trust must also stop replicating with that server.
      this.options.cluster?.syncReplicators();

      return jsonResponse(200, { success: true, message: `Trusted server "${serverName}" removed` });
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(400, { error: error.message });
      }
      console.error("[MindooDBServer] Error removing trusted server:", error);
      return jsonResponse(500, { error: "Failed to remove trusted server" });
    }
  }

  // ==================== System: Runtime Config ====================

  listConfigBackups(): ServerResponse {
    try {
      return jsonResponse(200, { backups: this.options.configRepository.listBackups() });
    } catch (error) {
      console.error("[MindooDBServer] Error listing config backups:", error);
      return jsonResponse(500, { error: "Failed to list config backups" });
    }
  }

  /**
   * `req.params.backupFile` as the host's router decoded it; it is decoded
   * once more here, as the Express server always did.
   */
  getConfigBackup(req: ServerRequest): ServerResponse {
    try {
      const backupFile = decodeURIComponent(req.params.backupFile ?? "");
      if (!isConfigBackupFilename(backupFile)) {
        return jsonResponse(400, { error: "Invalid config backup filename" });
      }

      const config = this.options.configRepository.loadBackup(backupFile);
      return jsonResponse(200, { file: backupFile, config });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Config backup not found:")) {
        return jsonResponse(404, { error: "Config backup not found" });
      }
      if (error instanceof Error && error.message.startsWith("Invalid config backup filename:")) {
        return jsonResponse(400, { error: "Invalid config backup filename" });
      }
      console.error("[MindooDBServer] Error reading config backup:", error);
      return jsonResponse(500, { error: "Failed to read config backup" });
    }
  }

  getConfig(): ServerResponse {
    return jsonResponse(200, this.options.getServerConfig());
  }

  async updateConfig(req: ServerRequest): Promise<ServerResponse> {
    try {
      let newConfig: ServerConfig;
      try {
        newConfig = validateServerConfig(req.body, "request body");
      } catch (err) {
        return jsonResponse(400, {
          error: err instanceof Error ? err.message : "Invalid config format",
        });
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
        return jsonResponse(400, {
          error: "This change would remove your own access to PUT /system/config",
        });
      }

      // Back up the current config, then persist the new one.
      const backupFile = this.options.configRepository.replace(newConfig);

      // Hot-swap in-memory state
      this.options.reloadConfig(newConfig);

      console.log(
        `[MindooDBServer] Config updated by ${callingAdmin.username}` +
          (backupFile ? ` (backup: ${backupFile})` : ""),
      );

      return jsonResponse(200, {
        success: true,
        ...(backupFile ? { backupFile } : {}),
      });
    } catch (error) {
      console.error("[MindooDBServer] Error updating config:", error);
      return jsonResponse(500, { error: "Failed to update config" });
    }
  }

  // ==================== Tenant Guards ====================

  /** Validate the `:tenantId` parameter and reject unknown tenants; sets `req.tenantId`. */
  tenantGuard(req: ServerRequest): ServerResponse | null {
    const rawTenantId = req.params.tenantId?.toLowerCase();

    if (!rawTenantId) {
      return jsonResponse(400, { error: "Tenant ID required" });
    }

    try {
      validateTenantIdFormat(rawTenantId);
    } catch {
      return jsonResponse(400, { error: "Invalid tenant ID format" });
    }

    if (!this.tenantManager.tenantExists(rawTenantId)) {
      return jsonResponse(404, { error: this.formatTenantNotFoundOnServerError(rawTenantId) });
    }

    req.tenantId = rawTenantId;
    return null;
  }

  private formatTenantNotFoundOnServerError(tenantId: string): string {
    const serverName = this.tenantManager.getServerPublicInfo()?.name ?? "unknown";
    return `Tenant ${tenantId} not found on server ${serverName}`;
  }

  /**
   * Resolve the caller of a sync request so the sync limiter can bucket per
   * identity instead of per address.
   *
   * Unlike {@link timestampAuthGuard} this never rejects: the route handlers
   * do their own token validation and own the 401, and this pass only needs
   * to know whose budget to spend. An unverifiable token simply falls back to
   * address-only bucketing — a forged one must not be able to conjure a fresh
   * budget, which is why the token is verified rather than decoded.
   */
  async resolveSyncPrincipal(req: ServerRequest): Promise<void> {
    try {
      const token = extractToken(req);
      const authService = await this.tenantManager.getAuthService(req.tenantId!);
      const payload = await authService.validateToken(token);
      if (payload && payload.tenantId === req.tenantId) {
        req.syncPrincipal = payload.deviceSigningKey ?? payload.sub;
      }
    } catch {
      // No usable token; fall through to address-only bucketing.
    }
  }

  /**
   * Authenticate a timestamp request with the tenant's existing bearer token
   * and record the principal for rate-limit bucketing.
   *
   * The proxy makes outbound requests on the caller's behalf, so it must never
   * be open: unauthenticated it would be a free relay to third-party services.
   */
  async timestampAuthGuard(req: ServerRequest): Promise<ServerResponse | null> {
    try {
      const token = extractToken(req);
      const authService = await this.tenantManager.getAuthService(req.tenantId!);
      const payload = await authService.validateToken(token);
      if (!payload || payload.tenantId !== req.tenantId) {
        return jsonResponse(401, { error: "Invalid or expired token" });
      }
      req.timestampPrincipal = payload.deviceSigningKey ?? payload.sub;
      return null;
    } catch (error) {
      return errorResponse(error);
    }
  }

  /**
   * Forward a DER TimeStampReq to a configured TSA and return the DER
   * TimeStampResp verbatim.
   *
   * The server neither parses nor validates the ASN.1: the client checks that
   * the returned token's `messageImprint` matches the digest it sent and that
   * the token chains to a trusted root. That is what reduces a hostile proxy —
   * ours or anyone's — from a forgery risk to a denial-of-service risk.
   */
  async timestampRequest(req: ServerRequest): Promise<ServerResponse> {
    const providers = this.options.tsaProviders;
    if (providers.length === 0) {
      return jsonResponse(503, { error: "Timestamping is not enabled on this server" });
    }

    const body = req.rawBody;
    if (!body) {
      return jsonResponse(415, {
        error: `Timestamp requests must be sent as ${TIMESTAMP_QUERY_CONTENT_TYPE}`,
      });
    }

    // The provider is named by id and resolved against the env allowlist; a
    // client-supplied URL would make this an SSRF gadget.
    const requestedProvider = req.query.provider;
    let preferredProviderId: string | undefined;
    if (typeof requestedProvider === "string" && requestedProvider.length > 0) {
      preferredProviderId = requestedProvider.toLowerCase();
    } else if (requestedProvider !== undefined) {
      return jsonResponse(400, { error: "provider must be a single string value" });
    }

    try {
      const result = await requestTimestampToken({
        providers,
        request: body,
        preferredProviderId,
      });

      return {
        status: 200,
        bytes: result.response,
        headers: {
          "content-type": TIMESTAMP_REPLY_CONTENT_TYPE,
          "x-mindoodb-tsa-provider": result.providerId,
        },
      };
    } catch (error) {
      if (error instanceof TimestampProxyError) {
        if (error.attempts.length > 0) {
          console.warn(
            `[MindooDBServer] Timestamp request failed for tenant ${req.tenantId}: ${error.attempts
              .map((attempt) => `${attempt.providerId}=${attempt.error ?? "ok"}`)
              .join("; ")}`,
          );
        }
        return jsonResponse(error.status, { error: error.message });
      }
      console.error("[MindooDBServer] Unexpected timestamp proxy error:", error);
      return jsonResponse(500, { error: "Failed to obtain a timestamp" });
    }
  }

  // ==================== Tenant Auth ====================
  // Two-step challenge-response flow:
  //  1. POST /auth/challenge  → client sends username, server returns a random nonce
  //  2. POST /auth/authenticate → client signs the nonce with its Ed25519 private key,
  //     server verifies the signature and returns a JWT for subsequent sync calls

  async challenge(req: ServerRequest): Promise<ServerResponse> {
    try {
      const { username, signingPublicKey } = req.body;

      // The username is optional: a client may identify itself by its device
      // signing public key instead, so the server never needs the cleartext
      // name. Validate whichever was supplied.
      if (username !== undefined && username !== null) {
        validateUsername(username);
      }
      if (signingPublicKey !== undefined && signingPublicKey !== null) {
        validateStringLength(signingPublicKey, MAX_SIGNATURE_LENGTH, "signingPublicKey");
      }

      const authService = await this.tenantManager.getAuthService(req.tenantId!);
      const challenge = await authService.generateChallenge(
        typeof username === "string" ? username : undefined,
        typeof signingPublicKey === "string" ? { signingPublicKey } : undefined,
      );

      return jsonResponse(200, { challenge });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async authenticate(req: ServerRequest): Promise<ServerResponse> {
    try {
      const { challenge, signature } = req.body;

      if (!challenge || !signature) {
        return jsonResponse(400, { error: "challenge and signature are required" });
      }

      validateStringLength(challenge, MAX_CHALLENGE_LENGTH, "challenge");
      validateStringLength(signature, MAX_SIGNATURE_LENGTH, "signature");

      const authService = await this.tenantManager.getAuthService(req.tenantId!);
      const result = await authService.authenticate(challenge, base64ToBytes(signature));

      // Return 401 on a failed authentication instead of 200 (audit, Low): a
      // failed credential check must not look like a success at the HTTP layer.
      return jsonResponse(result.success ? 200 : 401, result);
    } catch (error) {
      return errorResponse(error);
    }
  }

  // ==================== Sync ====================

  /** Dispatch one of {@link SYNC_ROUTES} for a store kind. */
  sync(name: SyncRouteName, req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    switch (name) {
      case "findNewEntries": return this.findNewEntries(req, storeKind);
      case "findNewEntriesForDoc": return this.findNewEntriesForDoc(req, storeKind);
      case "findEntries": return this.findEntries(req, storeKind);
      case "scanEntriesSince": return this.scanEntriesSince(req, storeKind);
      case "getStoreHead": return this.getStoreHead(req, storeKind);
      case "getIdBloomSummary": return this.getIdBloomSummary(req, storeKind);
      case "getCompactionStatus": return this.getCompactionStatus(req, storeKind);
      case "capabilities": return this.getCapabilities(req, storeKind);
      case "events": return this.syncEvents(req, storeKind);
      case "getEntries": return this.getEntries(req, storeKind);
      case "getEntriesBinary": return this.getEntriesBinary(req, storeKind);
      case "putEntriesBinary": return this.putEntriesBinary(req, storeKind);
      case "getEntryMetadata": return this.getEntryMetadata(req, storeKind);
      case "putEntries": return this.putEntries(req, storeKind);
      case "hasEntries": return this.hasEntries(req, storeKind);
      case "getAllIds": return this.getAllIds(req, storeKind);
      case "resolveDependencies": return this.resolveDependencies(req, storeKind);
      case "planDocumentMaterialization": return this.planDocumentMaterialization(req, storeKind);
      case "planDocumentMaterializationBatch": return this.planDocumentMaterializationBatch(req, storeKind);
      case "planAttachmentReadByWalkingMetadata": return this.planAttachmentReadByWalkingMetadata(req, storeKind);
    }
  }

  private serverStore(req: ServerRequest, dbId: string, storeKind: StoreKind) {
    return this.tenantManager.getServerStore(req.tenantId!, dbId, storeKind);
  }

  async findNewEntries(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, haveIds } = req.body;

      const validDbId = validateDbId(dbId);
      validateArraySize(haveIds, MAX_HAVE_IDS, "haveIds");

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const entries = await serverStore.handleFindNewEntries(token, haveIds || []);

      return jsonResponse(200, {
        entries: entries.map((e: StoreEntryMetadata) => serializeEntryMetadata(e)),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async findNewEntriesForDoc(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, haveIds, docId } = req.body;

      const validDbId = validateDbId(dbId);
      if (!docId) {
        return jsonResponse(400, { error: "docId is required" });
      }
      validateArraySize(haveIds, MAX_HAVE_IDS, "haveIds");

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const entries = await serverStore.handleFindNewEntriesForDoc(token, haveIds || [], docId);

      return jsonResponse(200, {
        entries: entries.map((e: StoreEntryMetadata) => serializeEntryMetadata(e)),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async findEntries(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, type, creationDateFrom, creationDateUntil } = req.body;

      const validDbId = validateDbId(dbId);

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const entries = await serverStore.handleFindEntries(
        token,
        type,
        creationDateFrom ?? null,
        creationDateUntil ?? null,
      );

      return jsonResponse(200, {
        entries: entries.map((e: StoreEntryMetadata) => serializeEntryMetadata(e)),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async scanEntriesSince(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, cursor, limit, filters } = req.body as {
        dbId?: string;
        cursor?: StoreScanCursor | null;
        limit?: number;
        filters?: StoreScanFilters;
      };

      const validDbId = validateDbId(dbId);

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const result = await serverStore.handleScanEntriesSince(
        token,
        cursor ?? null,
        limit,
        filters,
      );

      return jsonResponse(200, {
        entries: result.entries.map((e: StoreEntryMetadata) => serializeEntryMetadata(e)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async getStoreHead(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      const validDbId = validateDbId(dbId);

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const head = await serverStore.handleGetStoreHead(token);
      return jsonResponse(200, { head });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async getIdBloomSummary(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      const validDbId = validateDbId(dbId);

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const summary = await serverStore.handleGetIdBloomSummary(token);
      return jsonResponse(200, { summary: summary as StoreIdBloomSummary });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async getCapabilities(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const validDbId = validateDbId(req.query.dbId);
      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const capabilities = await serverStore.handleGetCapabilities(token);
      // HTTP-layer features on top of the transport-agnostic capability set:
      // binary octet-stream framing routes (phase 3) and the SSE change feed
      // (phase 5) exist only over HTTP.
      return jsonResponse(200, {
        capabilities: {
          ...(capabilities as NetworkSyncCapabilities),
          supportsBinaryEntries: true,
          supportsPayloadOnlyEntries: true,
          supportsChangeEvents: true,
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  /**
   * SSE live change feed (sync-v5, phase 5).
   *
   * `GET /:tenantId/sync/:storeKind/events` — Bearer-authenticated like every
   * other sync route (fetch-streaming clients can set headers; native
   * EventSource cannot, which is why the SDK uses a fetch reader).
   *
   * The subscribe-time read gate runs via `handleGetCapabilities` against the
   * database given in `?dbId=` (default `directory`, which every tenant member
   * can read): it validates the token and runs the database-open gate. Events
   * carry only `{dbId, storeKind, epoch, maxReceiptOrder}` — metadata, never
   * content. The host keeps the stream open with a heartbeat every 30 s. Token
   * expiry does not tear down an open stream; the events are non-sensitive
   * change hints and a reconnect re-authenticates.
   */
  async syncEvents(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const tenantId = req.tenantId!;
      const gateDbId = validateDbId(
        typeof req.query.dbId === "string" && req.query.dbId ? req.query.dbId : "directory",
      );

      // Validates the token and runs the database-open/read gate before any
      // event is delivered.
      const serverStore = await this.serverStore(req, gateDbId, storeKind);
      await serverStore.handleGetCapabilities(token);

      return { status: 200, events: { tenantId, storeKind } };
    } catch (error) {
      return errorResponse(error);
    }
  }

  /**
   * Publish a change event after an accepted putEntries write (sync-v5,
   * phase 5). Fire-and-forget: head lookup failures must never affect the
   * write path.
   */
  private publishSyncChangeEvent(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
    serverStore: { handleGetStoreHead(token: string): Promise<{ epoch: string; maxReceiptOrder: number }> },
    token: string,
  ): void {
    const events = this.options.syncEvents;
    if (events.listenerCount === 0) {
      return;
    }
    // Peer replicators subscribe to this bus, so a write that arrived from a
    // peer has to be labelled: without the label it would be pushed straight
    // back to its origin, and two bidirectional peers would ping-pong.
    const originPeer = this.options.cluster
      ? this.options.cluster.resolvePeerName(token)
      : Promise.resolve(undefined);

    this.runInBackground(
      Promise.all([serverStore.handleGetStoreHead(token).catch(() => null), originPeer]).then(
        ([head, peerName]) => {
          events.publish({
            tenantId,
            dbId,
            storeKind,
            epoch: head?.epoch,
            maxReceiptOrder: head?.maxReceiptOrder,
            originPeer: peerName,
          });
        },
      ),
    );
  }

  /**
   * Work that follows an accepted write: the change event, and for a
   * directory push the purge requests it may carry (docs/accesscontrol.md
   * §13), which physically remove purged history from this server's stores
   * and arm the re-push denylist. Both are fire-and-forget; purge failures
   * are logged and retried on the next directory push.
   */
  private afterAcceptedWrite(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
    serverStore: { handleGetStoreHead(token: string): Promise<{ epoch: string; maxReceiptOrder: number }> },
    token: string,
    receiptCount: number,
  ): void {
    // Announce the accepted write to SSE subscribers (sync-v5, phase 5).
    if (receiptCount > 0) {
      this.publishSyncChangeEvent(tenantId, dbId, storeKind, serverStore, token);
    }
    if (dbId === "directory") {
      const onDirectoryWrite =
        this.options.onDirectoryWrite ?? ((id: string) => this.tenantManager.executePendingPurges(id));
      this.runInBackground(
        onDirectoryWrite(tenantId).catch((error) => {
          console.error(`[MindooDBServer] executePendingPurges failed for ${tenantId}:`, error);
        }),
      );
    }
  }

  async getCompactionStatus(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId } = req.body as { dbId?: string };

      const validDbId = validateDbId(dbId);

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const status = await serverStore.handleGetCompactionStatus(token);
      return jsonResponse(200, { status: status as StoreCompactionStatus });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async getEntries(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, ids, sessionKeyWrap } = req.body;

      const validDbId = validateDbId(dbId);
      validateArraySize(ids, MAX_ENTRY_IDS, "ids");

      const serverStore = await this.serverStore(req, validDbId, storeKind);

      // Session-key transport format (sync-v5, phase 2): one RSA-wrapped
      // AES-256-GCM key per response instead of per-entry RSA. Negotiated via
      // the `sessionKeyWrap` request flag; legacy clients get the old format.
      if (sessionKeyWrap === true) {
        const batch = await serverStore.handleGetEntriesSessionWrapped(token, ids || []);
        return jsonResponse(200, {
          wrappedSessionKey: bytesToBase64(batch.wrappedSessionKey),
          entries: batch.entries.map((e) => ({
            ...serializeEntryMetadata(e),
            iv: bytesToBase64(e.iv),
            sessionEncryptedPayload: bytesToBase64(e.sessionEncryptedPayload),
          })),
        });
      }

      const entries = await serverStore.handleGetEntries(token, ids || []);

      return jsonResponse(200, {
        entries: entries.map((e: { rsaEncryptedPayload: Uint8Array } & StoreEntryMetadata) => ({
          ...serializeEntryMetadata(e),
          rsaEncryptedPayload: bytesToBase64(e.rsaEncryptedPayload),
        })),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  /**
   * Binary variant of getEntries (sync-v5, phase 3): always session-key
   * encrypted, response framed as `application/octet-stream` (see
   * binaryEntryFraming.ts). The request stays JSON (small).
   */
  async getEntriesBinary(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, ids, payloadOnly } = req.body;

      const validDbId = validateDbId(dbId);
      validateArraySize(ids, MAX_ENTRY_IDS, "ids");

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const batch = await serverStore.handleGetEntriesSessionWrapped(token, ids || []);

      // `payloadOnly` (capability supportsPayloadOnlyEntries): the client
      // already holds the metadata from its scan, so each frame carries only
      // what it cannot have yet. Same entries, same session-key encryption.
      const body = encodeBinaryEntryMessage({
        header: {
          format: BINARY_GET_ENTRIES_FORMAT,
          wrappedSessionKey: bytesToBase64(batch.wrappedSessionKey),
          ...(payloadOnly === true ? { payloadOnly: true } : {}),
        },
        entries: batch.entries.map((e) => ({
          meta:
            payloadOnly === true
              ? { id: e.id, iv: bytesToBase64(e.iv) }
              : { ...serializeEntryMetadata(e), iv: bytesToBase64(e.iv) },
          payload: e.sessionEncryptedPayload,
        })),
      });
      const payloadBytes = batch.entries.reduce(
        (sum, e) => sum + e.sessionEncryptedPayload.byteLength,
        0,
      );

      return {
        status: 200,
        bytes: body,
        headers: { "content-type": BINARY_ENTRIES_CONTENT_TYPE },
        binaryEntryFrameBytes: body.byteLength - payloadBytes,
      };
    } catch (error) {
      return errorResponse(error);
    }
  }

  async getEntryMetadata(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, id } = req.body as { dbId?: string; id?: string };

      const validDbId = validateDbId(dbId);
      if (!id) {
        return jsonResponse(400, { error: "id is required" });
      }

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const entry = await serverStore.handleGetEntryMetadata(token, id);

      return jsonResponse(200, {
        entry: entry ? serializeEntryMetadata(entry) : null,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  /**
   * Ingest encrypted entries from a client. The `stage` variable tracks
   * progress through the pipeline so that error logs pinpoint the failing
   * step (token extraction → body parsing → deserialization → storage).
   */
  async putEntries(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    let stage = "extract-token";
    try {
      const token = extractToken(req);
      stage = "read-body";
      const { dbId, entries } = req.body;

      const validDbId = validateDbId(dbId);
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
      const serverStore = await this.serverStore(req, validDbId, storeKind);
      stage = "deserialize-entries";
      const deserializedEntries = serializedEntries.map((entry, index) => {
        try {
          return deserializeStoreEntry(entry);
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
      const ack = await serverStore.handlePutEntries(token, deserializedEntries);
      stage = "respond-success";

      this.afterAcceptedWrite(req.tenantId!, validDbId, storeKind, serverStore, token, ack.receipts.length);

      // Return witness receipts for accepted entries so the pushing client (and
      // every replica it later syncs with) can persist the attestation
      // (docs/accesscontrol.md §5.3), plus per-entry rejections for
      // signature-class failures the server skipped. Older clients ignore the
      // extra fields.
      return jsonResponse(200, {
        success: true,
        receipts: ack.receipts.map((e) => serializeEntryMetadata(e)),
        rejected: ack.rejected,
      });
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
      return errorResponse(error);
    }
  }

  /**
   * Binary variant of putEntries (sync-v5, phase 3). The request body is
   * octet-stream framing; `dbId` travels in the message header JSON because
   * there is no JSON body. Receipts are returned as JSON like putEntries.
   */
  async putEntriesBinary(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    let stage = "extract-token";
    try {
      const token = extractToken(req);
      stage = "decode-body";
      if (!req.rawBody) {
        return jsonResponse(400, { error: `putEntriesBinary requires a ${BINARY_ENTRIES_CONTENT_TYPE} body` });
      }
      const message = decodeBinaryEntryMessage(req.rawBody);
      if (message.header.format !== BINARY_PUT_ENTRIES_FORMAT) {
        return jsonResponse(400, { error: `Unsupported binary entry format: ${String(message.header.format)}` });
      }

      const validDbId = validateDbId(message.header.dbId);
      validateArraySize(message.entries, MAX_PUT_ENTRIES, "entries");
      console.log(
        `[MindooDBServer] putEntriesBinary request tenant=${req.tenantId ?? "-"} db=${validDbId} entries=${message.entries.length} content-length=${req.headers["content-length"] ?? "-"}`,
      );

      stage = "load-server-store";
      const serverStore = await this.serverStore(req, validDbId, storeKind);

      stage = "deserialize-entries";
      const deserializedEntries = message.entries.map((frame, index) => {
        const meta = frame.meta as unknown as SerializedEntryMetadata;
        try {
          return {
            ...deserializeEntryMetadata(meta),
            encryptedData: frame.payload,
          };
        } catch (error) {
          console.error("[MindooDBServer] putEntriesBinary failed while deserializing entry", {
            index,
            id: meta?.id ?? "-",
            type: meta?.entryType ?? "-",
            docId: meta?.docId ?? "-",
            payloadLength: frame.payload?.byteLength ?? "-",
            error,
          });
          throw error;
        }
      });

      stage = "store-entries";
      const ack = await serverStore.handlePutEntries(token, deserializedEntries);
      stage = "respond-success";

      // Same post-response hooks as the JSON putEntries path.
      this.afterAcceptedWrite(req.tenantId!, validDbId, storeKind, serverStore, token, ack.receipts.length);

      return jsonResponse(200, {
        success: true,
        receipts: ack.receipts.map((e) => serializeEntryMetadata(e)),
        rejected: ack.rejected,
      });
    } catch (error) {
      console.error("[MindooDBServer] putEntriesBinary failed", {
        stage,
        tenantId: req.tenantId ?? "-",
        contentLength: req.headers["content-length"] ?? "-",
        error,
      });
      return errorResponse(error);
    }
  }

  async hasEntries(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, ids } = req.body;

      const validDbId = validateDbId(dbId);
      validateArraySize(ids, MAX_ENTRY_IDS, "ids");

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const existingIds = await serverStore.handleHasEntries(token, ids || []);

      return jsonResponse(200, { ids: existingIds });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async getAllIds(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const validDbId = validateDbId(req.query.dbId);

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const ids = await serverStore.handleGetAllIds(token);

      return jsonResponse(200, { ids });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async resolveDependencies(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, startId, options } = req.body;

      const validDbId = validateDbId(dbId);
      if (!startId) {
        return jsonResponse(400, { error: "startId is required" });
      }

      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const ids = await serverStore.handleResolveDependencies(token, startId, options);

      return jsonResponse(200, { ids });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async planDocumentMaterialization(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, docId, options } = req.body as {
        dbId?: string;
        docId?: string;
        options?: MaterializationPlanOptions;
      };
      const validDbId = validateDbId(dbId);
      if (!docId) {
        return jsonResponse(400, { error: "docId is required" });
      }
      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const plan = await (serverStore as any).handlePlanDocumentMaterialization(token, docId, options);
      return jsonResponse(200, { plan: plan as DocumentMaterializationPlan });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async planDocumentMaterializationBatch(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, docIds, options } = req.body as {
        dbId?: string;
        docIds?: string[];
        options?: MaterializationPlanOptions;
      };
      const validDbId = validateDbId(dbId);
      validateArraySize(docIds, MAX_HAVE_IDS, "docIds");
      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const batchPlan = await (serverStore as any).handlePlanDocumentMaterializationBatch(token, docIds || [], options);
      return jsonResponse(200, { batchPlan: batchPlan as DocumentMaterializationBatchPlan });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async planAttachmentReadByWalkingMetadata(req: ServerRequest, storeKind: StoreKind): Promise<ServerResponse> {
    try {
      const token = extractToken(req);
      const { dbId, lastChunkId, attachmentSize, options } = req.body as {
        dbId?: string;
        lastChunkId?: string;
        attachmentSize?: number;
        options?: AttachmentReadPlanOptions;
      };
      const validDbId = validateDbId(dbId);
      if (!lastChunkId) {
        return jsonResponse(400, { error: "lastChunkId is required" });
      }
      if (typeof attachmentSize !== "number" || !Number.isFinite(attachmentSize)) {
        return jsonResponse(400, { error: "attachmentSize is required" });
      }
      if (!options || typeof options.startByte !== "number") {
        return jsonResponse(400, { error: "options.startByte is required" });
      }
      const serverStore = await this.serverStore(req, validDbId, storeKind);
      const plan = await (serverStore as any).handlePlanAttachmentReadByWalkingMetadata(
        token,
        lastChunkId,
        attachmentSize,
        options,
      );
      return jsonResponse(200, { plan: plan as AttachmentReadPlan });
    } catch (error) {
      return errorResponse(error);
    }
  }
}
