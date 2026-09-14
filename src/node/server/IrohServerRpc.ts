import { StoreKind } from "../../core/appendonlystores/types";
import type { IrohRpcHandler } from "../../core/appendonlystores/network/IrohNetworkTransport";
import type { IrohRpcContext } from "../../core/appendonlystores/network/IrohStreamIO";
import type { MindooDBServerInfo } from "../../core/types";
import { validateTenantId, ValidationError } from "./validation";
import type { SyncEventBus } from "./SyncEventBus";

/** QUIC idle timeout is ~30s; keep the feed alive below that. */
export const IROH_CHANGE_FEED_HEARTBEAT_MS = 20_000;

export const IROH_CHANGE_FEED_HEARTBEAT = { type: "heartbeat" } as const;

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

export interface IrohServerRpcHost {
  getServerPublicInfo(): MindooDBServerInfo | null;
  getJsonBodyLimit?: () => { limit: string; bytes: number | null };
  getClusterRole?: () => string;
  listTenantPublicInfosFingerprints(tenantId: string): Promise<string[]>;
  getAuthService(tenantId: string): Promise<IrohServerAuthService>;
  getServerStore(tenantId: string, dbId: string, storeKind: StoreKind): Promise<IrohServerStore>;
  syncEventBus?: SyncEventBus;
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
      default:
        return dispatchStoreMethod(host, method, args, ctx);
    }
  };
}

async function dispatchStoreMethod(
  host: IrohServerRpcHost,
  method: string,
  args: unknown[],
  ctx?: IrohRpcContext,
): Promise<unknown> {
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
        host.syncEventBus.publish({
          tenantId: scope.tenantId,
          dbId: scope.dbId,
          storeKind: scope.storeKind,
          epoch: head?.epoch,
          maxReceiptOrder: head?.maxReceiptOrder,
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
