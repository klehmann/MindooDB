import { StoreKind, type StoreIdBloomSummary } from "../../core/appendonlystores/types";
import { bloomMightContainId } from "../../core/appendonlystores/bloom";
import type { IrohRpcHandler } from "../../core/appendonlystores/network/IrohNetworkTransport";
import type { IrohRpcContext } from "../../core/appendonlystores/network/IrohStreamIO";
import type { MindooDBServerInfo } from "../../core/types";
import {
  MAX_CHALLENGE_LENGTH,
  MAX_PEM_KEY_LENGTH,
  validateStringLength,
  validateTenantId,
  validateUsername,
  ValidationError,
} from "./validation";
import type { RegisterTenantRequest } from "./types";
import type { SyncEventBus } from "./SyncEventBus";
import type { PeerTokenPayload } from "./peer/PeerAuthService";
import type { SystemAdminTokenPayload } from "./SystemAdminAuth";

/** QUIC idle timeout is ~30s; keep the feed alive below that. */
export const IROH_CHANGE_FEED_HEARTBEAT_MS = 20_000;

export const IROH_CHANGE_FEED_HEARTBEAT = { type: "heartbeat" } as const;

/** Unauthenticated `peer.challenge` / `peer.authenticate` window. */
export const IROH_PEER_UNAUTH_WINDOW_MS = 60_000;
export const IROH_PEER_UNAUTH_MAX = 30;

const MAX_BLOOM_BITS = 1 << 22;

export interface IrohServerAuthService {
  generateChallenge(
    username?: string,
    options?: { signingPublicKey?: string },
  ): Promise<string>;
  authenticate(
    challenge: string,
    signature: Uint8Array,
  ): Promise<{ success: boolean; token?: string; error?: string }>;
}

export interface IrohServerStore {
  handleFindNewEntries(token: string, haveIds: string[]): Promise<unknown>;
  handleFindNewEntriesForDoc(token: string, haveIds: string[], docId: string): Promise<unknown>;
  handleFindEntries(
    token: string,
    type: unknown,
    creationDateFrom: number | null,
    creationDateUntil: number | null,
  ): Promise<unknown>;
  handleScanEntriesSince(
    token: string,
    cursor: unknown,
    limit?: number,
    filters?: unknown,
  ): Promise<unknown>;
  handleGetIdBloomSummary(token: string): Promise<unknown>;
  handleGetStoreHead(token: string): Promise<unknown>;
  handleGetCompactionStatus(token: string): Promise<unknown>;
  handleGetCapabilities(token: string): Promise<unknown>;
  handleGetEntries(token: string, ids: string[]): Promise<unknown>;
  handleGetEntriesSessionWrapped(token: string, ids: string[]): Promise<unknown>;
  handleGetEntryMetadata(token: string, id: string): Promise<unknown>;
  handlePutEntries(token: string, entries: unknown[]): Promise<unknown>;
  handleHasEntries(token: string, ids: string[]): Promise<unknown>;
  handleGetAllIds(token: string): Promise<unknown>;
  handleResolveDependencies(
    token: string,
    startId: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  handlePlanDocumentMaterialization(
    token: string,
    docId: string,
    options?: unknown,
  ): Promise<unknown>;
  handlePlanDocumentMaterializationBatch(
    token: string,
    docIds: string[],
    options?: unknown,
  ): Promise<unknown>;
  handlePlanAttachmentReadByWalkingMetadata(
    token: string,
    lastChunkId: string,
    attachmentSize: number,
    options: unknown,
  ): Promise<unknown>;
}

export interface IrohPeerAuthHost {
  generateChallenge(publicsignkey: string): Promise<string>;
  authenticate(
    challenge: string,
    signature: Uint8Array,
  ): Promise<{ success: boolean; token?: string; error?: string }>;
  validateToken(token: string): Promise<PeerTokenPayload | null>;
}

export interface IrohPeerClusterHost {
  recordPeerIntersection(peerName: string, tenantIds: string[]): void;
  peerMaySeeTenant(peerName: string, tenantId: string): boolean;
  listTenants(): string[];
  listDatabases(tenantId: string): string[];
  requestSync(peerName: string, scope?: { tenantId?: string; dbId?: string }): void;
}

export interface IrohSystemAdminHost {
  generateChallenge(username: string, publicsignkey: string): Promise<string>;
  authenticate(
    challenge: string,
    signature: Uint8Array,
  ): Promise<{ success: boolean; token?: string; error?: string }>;
  validateToken(token: string): Promise<SystemAdminTokenPayload | null>;
  isAuthorized(method: string, path: string, username: string, publicsignkey: string): boolean;
  registerTenant(request: RegisterTenantRequest): Promise<{
    created: boolean;
    context: { tenantId: string };
  }>;
}

export interface IrohServerRpcHost {
  getServerPublicInfo(): MindooDBServerInfo | null;
  getJsonBodyLimit?: () => { limit: string; bytes: number | null };
  getClusterRole?: () => string;
  listTenantPublicInfosFingerprints(tenantId: string): Promise<string[]>;
  getAuthService(tenantId: string): Promise<IrohServerAuthService>;
  getServerStore(tenantId: string, dbId: string, storeKind: StoreKind): Promise<IrohServerStore>;
  syncEventBus?: SyncEventBus;
  peerAuth?: IrohPeerAuthHost;
  peerCluster?: IrohPeerClusterHost;
  systemAdmin?: IrohSystemAdminHost;
  getPeerUnauthRateLimit?: () => { windowMs: number; max: number };
}

function requireTenant(ctx?: IrohRpcContext): string {
  const tenantId = ctx?.tenantId?.trim().toLowerCase();
  if (!tenantId) {
    throw new Error("Iroh RPC requires ctx.tenantId");
  }
  validateTenantId(tenantId);
  return tenantId;
}

function requireStoreScope(ctx?: IrohRpcContext): {
  tenantId: string;
  dbId: string;
  storeKind: StoreKind;
} {
  const tenantId = requireTenant(ctx);
  const dbId = ctx?.dbId?.trim();
  if (!dbId) {
    throw new Error("Iroh RPC requires ctx.dbId");
  }
  const storeKind = ctx?.storeKind === StoreKind.attachments ? StoreKind.attachments : StoreKind.docs;
  return { tenantId, dbId, storeKind };
}

/**
 * Inverse of {@link IrohNetworkTransport}: same method names, same args.
 * Discovery methods are unauthenticated, matching `/.well-known/*`.
 */
export function createMindooDBServerIrohHandler(host: IrohServerRpcHost): IrohRpcHandler {
  return async (method, args, ctx) => {
    switch (method) {
      case "getServerInfo": {
        const info = host.getServerPublicInfo();
        if (!info) {
          throw new Error("Server identity not initialized");
        }
        const limit = host.getJsonBodyLimit?.();
        return {
          ...info,
          clusterRole: host.getClusterRole?.() ?? "peer",
          maxJsonRequestBodyLimit: limit?.limit,
          maxJsonRequestBodyBytes: limit?.bytes ?? undefined,
          supportsSystemAdmin: Boolean(host.systemAdmin),
        };
      }
      case "getTenantPublicInfosFingerprints": {
        const tenantId = String(args[0] ?? "").trim().toLowerCase();
        validateTenantId(tenantId);
        const fingerprints = await host.listTenantPublicInfosFingerprints(tenantId);
        if (fingerprints.length === 0) {
          throw new Error("Tenant not found on server");
        }
        return { tenantId, fingerprints };
      }
      case "requestChallenge": {
        const tenantId = requireTenant(ctx);
        const auth = await host.getAuthService(tenantId);
        return auth.generateChallenge(
          typeof args[0] === "string" ? args[0] : undefined,
          args[1] as { signingPublicKey?: string } | undefined,
        );
      }
      case "authenticate": {
        const tenantId = requireTenant(ctx);
        const auth = await host.getAuthService(tenantId);
        const challenge = String(args[0] ?? "");
        const signature = args[1] as Uint8Array;
        return auth.authenticate(challenge, signature);
      }
      case "peer.challenge":
      case "peer.authenticate":
      case "peer.tenantBloom":
      case "peer.listDatabases":
      case "peer.subscribeEvents":
      case "peer.sync":
        return dispatchPeerMethod(host, method, args);
      case "system.requestChallenge":
      case "system.authenticate":
      case "system.registerTenant":
        return dispatchSystemMethod(host, method, args);
      default:
        return dispatchStoreMethod(host, method, args, ctx);
    }
  };
}

const unauthPeerHits = new Map<string, number[]>();

function allowUnauthPeerCall(
  key: string,
  limit: { windowMs: number; max: number },
): boolean {
  const now = Date.now();
  const recent = (unauthPeerHits.get(key) ?? []).filter((at) => now - at < limit.windowMs);
  if (recent.length >= limit.max) {
    unauthPeerHits.set(key, recent);
    return false;
  }
  recent.push(now);
  unauthPeerHits.set(key, recent);
  return true;
}

/** Test hook: drop recorded unauthenticated peer hits. */
export function resetIrohPeerUnauthLimiter(): void {
  unauthPeerHits.clear();
}

async function requirePeerPayload(
  host: IrohServerRpcHost,
  token: string,
): Promise<PeerTokenPayload> {
  if (!host.peerAuth) {
    throw new Error("Iroh peer mesh is not configured");
  }
  const payload = await host.peerAuth.validateToken(token);
  if (!payload) {
    throw new Error("Invalid or expired peer token");
  }
  return payload;
}

async function dispatchPeerMethod(
  host: IrohServerRpcHost,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!host.peerAuth || !host.peerCluster) {
    throw new Error("Iroh peer mesh is not configured");
  }

  if (method === "peer.challenge" || method === "peer.authenticate") {
    const limit = host.getPeerUnauthRateLimit?.() ?? {
      windowMs: IROH_PEER_UNAUTH_WINDOW_MS,
      max: IROH_PEER_UNAUTH_MAX,
    };
    const key = method === "peer.challenge" ? `challenge:${String(args[0] ?? "")}` : `auth:${String(args[0] ?? "")}`;
    if (!allowUnauthPeerCall(key, limit)) {
      throw new Error("Too many peer requests, please try again later");
    }
  }

  switch (method) {
    case "peer.challenge": {
      const publicsignkey = String(args[0] ?? "");
      if (!publicsignkey) {
        throw new Error("publicsignkey is required");
      }
      try {
        return { challenge: await host.peerAuth.generateChallenge(publicsignkey) };
      } catch {
        throw new Error("Unknown peer");
      }
    }
    case "peer.authenticate": {
      const challenge = String(args[0] ?? "");
      const signature = args[1];
      if (!challenge || !(signature instanceof Uint8Array)) {
        throw new Error("challenge and signature (Uint8Array) are required");
      }
      const result = await host.peerAuth.authenticate(challenge, signature);
      if (!result.success || !result.token) {
        throw new Error(result.error ?? "Authentication failed");
      }
      return { success: true, token: result.token };
    }
    case "peer.tenantBloom": {
      const payload = await requirePeerPayload(host, String(args[0] ?? ""));
      const bloom = args[1] as StoreIdBloomSummary | undefined;
      if (!bloom || typeof bloom !== "object") {
        throw new Error("bloom summary is required");
      }
      if (typeof bloom.bitCount !== "number" || bloom.bitCount <= 0 || bloom.bitCount > MAX_BLOOM_BITS) {
        throw new Error("Invalid bloom summary");
      }
      const candidates = host.peerCluster
        .listTenants()
        .filter((tenantId) => bloomMightContainId(bloom, tenantId));
      host.peerCluster.recordPeerIntersection(payload.sub, candidates);
      return { tenantIds: candidates };
    }
    case "peer.listDatabases": {
      const payload = await requirePeerPayload(host, String(args[0] ?? ""));
      const tenantId = String(args[1] ?? "").trim().toLowerCase();
      if (!tenantId) {
        throw new Error("tenantId is required");
      }
      if (!host.peerCluster.peerMaySeeTenant(payload.sub, tenantId)) {
        throw new Error("Tenant not found");
      }
      return { databases: host.peerCluster.listDatabases(tenantId) };
    }
    case "peer.subscribeEvents": {
      const payload = await requirePeerPayload(host, String(args[0] ?? ""));
      if (!host.syncEventBus) {
        throw new Error("Iroh peer event feed is not configured");
      }
      return createIrohPeerEventFeed(host.syncEventBus, host.peerCluster, payload.sub);
    }
    case "peer.sync": {
      const payload = await requirePeerPayload(host, String(args[0] ?? ""));
      const scope = (args[1] ?? {}) as { tenantId?: string; dbId?: string };
      host.peerCluster.requestSync(payload.sub, scope);
      return { accepted: true };
    }
    default:
      throw new Error(`Unknown Iroh RPC method ${method}`);
  }
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function requireSystemAdminPayload(
  host: IrohServerRpcHost,
  token: string,
): Promise<SystemAdminTokenPayload> {
  if (!host.systemAdmin) {
    throw new Error("Iroh system admin is not configured");
  }
  const payload = await host.systemAdmin.validateToken(token);
  if (!payload) {
    throw new Error("Invalid or expired system admin token");
  }
  return payload;
}

async function dispatchSystemMethod(
  host: IrohServerRpcHost,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!host.systemAdmin) {
    throw new Error("Iroh system admin is not configured");
  }

  if (method === "system.requestChallenge" || method === "system.authenticate") {
    const limit = host.getPeerUnauthRateLimit?.() ?? {
      windowMs: IROH_PEER_UNAUTH_WINDOW_MS,
      max: IROH_PEER_UNAUTH_MAX,
    };
    const key =
      method === "system.requestChallenge"
        ? `system-challenge:${String(args[0] ?? "")}`
        : `system-auth:${String(args[0] ?? "")}`;
    if (!allowUnauthPeerCall(key, limit)) {
      throw new Error("Too many system admin requests, please try again later");
    }
  }

  switch (method) {
    case "system.requestChallenge": {
      const username = String(args[0] ?? "");
      const publicsignkey = String(args[1] ?? "");
      if (!username) {
        throw new Error("username is required");
      }
      if (!publicsignkey) {
        throw new Error("publicsignkey is required");
      }
      validateUsername(username);
      validateStringLength(publicsignkey, MAX_PEM_KEY_LENGTH, "publicsignkey");
      try {
        return { challenge: await host.systemAdmin.generateChallenge(username, publicsignkey) };
      } catch (error) {
        if (error instanceof Error && error.message === "Unknown system admin principal") {
          throw new Error("System admin principal not found");
        }
        throw error;
      }
    }
    case "system.authenticate": {
      const challenge = String(args[0] ?? "");
      const signature = asUint8Array(args[1]);
      if (!challenge || !signature) {
        throw new Error("challenge and signature (Uint8Array) are required");
      }
      validateStringLength(challenge, MAX_CHALLENGE_LENGTH, "challenge");
      const result = await host.systemAdmin.authenticate(challenge, signature);
      if (!result.success || !result.token) {
        throw new Error(result.error ?? "Authentication failed");
      }
      return { success: true, token: result.token };
    }
    case "system.registerTenant": {
      const payload = await requireSystemAdminPayload(host, String(args[0] ?? ""));
      const tenantId = String(args[1] ?? "").trim().toLowerCase();
      validateTenantId(tenantId);
      const path = `/system/tenants/${tenantId}`;
      if (!host.systemAdmin.isAuthorized("POST", path, payload.sub, payload.publicsignkey)) {
        throw new Error("Forbidden: insufficient capabilities");
      }
      const body = (args[2] ?? {}) as Record<string, unknown>;
      const adminSigningPublicKey = String(body.adminSigningPublicKey ?? "");
      const adminEncryptionPublicKey = String(body.adminEncryptionPublicKey ?? "");
      if (!adminSigningPublicKey) {
        throw new Error("adminSigningPublicKey is required");
      }
      if (!adminEncryptionPublicKey) {
        throw new Error("adminEncryptionPublicKey is required");
      }
      if (body.adminUsername !== undefined) {
        validateUsername(body.adminUsername);
      }
      validateStringLength(adminSigningPublicKey, MAX_PEM_KEY_LENGTH, "adminSigningPublicKey");
      validateStringLength(adminEncryptionPublicKey, MAX_PEM_KEY_LENGTH, "adminEncryptionPublicKey");
      if (!body.encryptedPublicInfosKey && !body.publicInfosKey) {
        throw new Error("encryptedPublicInfosKey or publicInfosKey is required");
      }
      if (body.publicInfosKey !== undefined) {
        validateStringLength(body.publicInfosKey, MAX_PEM_KEY_LENGTH, "publicInfosKey");
      }
      if (body.encryptedPublicInfosKey !== undefined) {
        validateStringLength(body.encryptedPublicInfosKey, MAX_PEM_KEY_LENGTH, "encryptedPublicInfosKey");
      }
      const request: RegisterTenantRequest = {
        tenantId,
        adminSigningPublicKey,
        adminEncryptionPublicKey,
        adminUsername: typeof body.adminUsername === "string" ? body.adminUsername : undefined,
        publicInfosKey: typeof body.publicInfosKey === "string" ? body.publicInfosKey : undefined,
        encryptedPublicInfosKey:
          typeof body.encryptedPublicInfosKey === "string" ? body.encryptedPublicInfosKey : undefined,
        users: Array.isArray(body.users) ? (body.users as RegisterTenantRequest["users"]) : undefined,
      };
      const result = await host.systemAdmin.registerTenant(request);
      return {
        success: true,
        tenantId: result.context.tenantId,
        created: result.created,
        message: result.created
          ? `Tenant ${result.context.tenantId} registered successfully`
          : `Tenant ${result.context.tenantId} already exists with matching $publicinfos key`,
      };
    }
    default:
      throw new Error(`Unknown Iroh RPC method ${method}`);
  }
}

const IROH_STORE_METHODS = new Set([
  "getCapabilities",
  "findNewEntries",
  "findNewEntriesForDoc",
  "findEntries",
  "scanEntriesSince",
  "getIdBloomSummary",
  "getStoreHead",
  "getCompactionStatus",
  "planDocumentMaterialization",
  "planDocumentMaterializationBatch",
  "planAttachmentReadByWalkingMetadata",
  "getEntries",
  "getEntriesSessionWrapped",
  "getEntryMetadata",
  "putEntries",
  "hasEntries",
  "getAllIds",
  "resolveDependencies",
  "subscribeToChanges",
]);

async function dispatchStoreMethod(
  host: IrohServerRpcHost,
  method: string,
  args: unknown[],
  ctx?: IrohRpcContext,
): Promise<unknown> {
  if (!IROH_STORE_METHODS.has(method)) {
    throw new Error(`Unknown Iroh RPC method ${method}`);
  }
  const scope = requireStoreScope(ctx);
  const store = await host.getServerStore(scope.tenantId, scope.dbId, scope.storeKind);
  const token = String(args[0] ?? "");

  switch (method) {
    case "getCapabilities": {
      const capabilities = (await store.handleGetCapabilities(token)) as Record<string, unknown>;
      return { ...capabilities, supportsChangeEvents: true };
    }
    case "findNewEntries":
      return store.handleFindNewEntries(token, (args[1] as string[]) ?? []);
    case "findNewEntriesForDoc":
      return store.handleFindNewEntriesForDoc(token, (args[1] as string[]) ?? [], String(args[2] ?? ""));
    case "findEntries":
      return store.handleFindEntries(
        token,
        args[1],
        (args[2] as number | null) ?? null,
        (args[3] as number | null) ?? null,
      );
    case "scanEntriesSince":
      return store.handleScanEntriesSince(token, args[1], args[2] as number | undefined, args[3]);
    case "getIdBloomSummary":
      return store.handleGetIdBloomSummary(token);
    case "getStoreHead":
      return store.handleGetStoreHead(token);
    case "getCompactionStatus":
      return store.handleGetCompactionStatus(token);
    case "planDocumentMaterialization":
      return store.handlePlanDocumentMaterialization(token, String(args[1] ?? ""), args[2]);
    case "planDocumentMaterializationBatch":
      return store.handlePlanDocumentMaterializationBatch(token, (args[1] as string[]) ?? [], args[2]);
    case "planAttachmentReadByWalkingMetadata":
      return store.handlePlanAttachmentReadByWalkingMetadata(
        token,
        String(args[1] ?? ""),
        Number(args[2] ?? 0),
        args[3],
      );
    case "getEntries":
      return store.handleGetEntries(token, (args[1] as string[]) ?? []);
    case "getEntriesSessionWrapped":
      return store.handleGetEntriesSessionWrapped(token, (args[1] as string[]) ?? []);
    case "getEntryMetadata":
      return store.handleGetEntryMetadata(token, String(args[1] ?? ""));
    case "putEntries": {
      const ack = (await store.handlePutEntries(token, (args[1] as unknown[]) ?? [])) as {
        receipts?: unknown[];
      };
      if ((ack.receipts?.length ?? 0) > 0 && host.syncEventBus) {
        const head = (await store.handleGetStoreHead(token).catch(() => null)) as {
          epoch?: string;
          maxReceiptOrder?: number;
        } | null;
        const peerName = host.peerAuth
          ? ((await host.peerAuth.validateToken(token).catch(() => null))?.sub ?? undefined)
          : undefined;
        host.syncEventBus.publish({
          tenantId: scope.tenantId,
          dbId: scope.dbId,
          storeKind: scope.storeKind,
          epoch: head?.epoch,
          maxReceiptOrder: head?.maxReceiptOrder,
          originPeer: peerName,
        });
      }
      return ack;
    }
    case "hasEntries":
      return store.handleHasEntries(token, (args[1] as string[]) ?? []);
    case "getAllIds":
      return store.handleGetAllIds(token);
    case "resolveDependencies":
      return store.handleResolveDependencies(
        token,
        String(args[1] ?? ""),
        args[2] as Record<string, unknown> | undefined,
      );
    case "subscribeToChanges":
      await store.handleGetCapabilities(token);
      if (!host.syncEventBus) {
        throw new Error("Iroh change feed is not configured");
      }
      return createIrohChangeFeed(host.syncEventBus, scope);
    default:
      throw new Error(`Unknown Iroh RPC method ${method}`);
  }
}

export function isIrohValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

function createIrohChangeFeed(
  bus: SyncEventBus,
  scope: { tenantId: string; storeKind: StoreKind },
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const queue: unknown[] = [];
      let notify: (() => void) | null = null;
      let closed = false;

      const unsubscribe = bus.subscribe((event) => {
        if (event.tenantId !== scope.tenantId || event.storeKind !== scope.storeKind) {
          return;
        }
        queue.push({
          dbId: event.dbId,
          storeKind: event.storeKind,
          epoch: event.epoch,
          maxReceiptOrder: event.maxReceiptOrder,
        });
        notify?.();
      });

      const heartbeat = setInterval(() => {
        if (closed) {
          return;
        }
        queue.push(IROH_CHANGE_FEED_HEARTBEAT);
        notify?.();
      }, IROH_CHANGE_FEED_HEARTBEAT_MS);
      heartbeat.unref?.();

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        notify?.();
      };

      return {
        async next() {
          while (queue.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
          if (queue.length === 0) {
            return { done: true, value: undefined };
          }
          return { done: false, value: queue.shift() };
        },
        async return() {
          close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createIrohPeerEventFeed(
  bus: SyncEventBus,
  cluster: IrohPeerClusterHost,
  peerName: string,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const queue: unknown[] = [];
      let notify: (() => void) | null = null;
      let closed = false;

      const unsubscribe = bus.subscribe((event) => {
        if (event.originPeer === peerName) {
          return;
        }
        if (!cluster.peerMaySeeTenant(peerName, event.tenantId)) {
          return;
        }
        queue.push({
          tenantId: event.tenantId,
          dbId: event.dbId,
          storeKind: event.storeKind,
          epoch: event.epoch,
          maxReceiptOrder: event.maxReceiptOrder,
        });
        notify?.();
      });

      const heartbeat = setInterval(() => {
        if (closed) {
          return;
        }
        queue.push(IROH_CHANGE_FEED_HEARTBEAT);
        notify?.();
      }, IROH_CHANGE_FEED_HEARTBEAT_MS);
      heartbeat.unref?.();

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        notify?.();
      };

      return {
        async next() {
          while (queue.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
          if (queue.length === 0) {
            return { done: true, value: undefined };
          }
          return { done: false, value: queue.shift() };
        },
        async return() {
          close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
