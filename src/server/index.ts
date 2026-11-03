/**
 * Platform-neutral MindooDB server core.
 *
 * Everything a host needs to serve the MindooDB HTTP API without depending on
 * Node: the route handlers ({@link MindooDBServerCore}), the tenant manager,
 * auth services and the persistence interfaces a host implements. The Node
 * server (`node/server`) is one host; it adds Express, files, HTTP/2, Iroh
 * and peer replication. This entry point must not import Node built-ins —
 * `ServerCoreNeutralBundle.test.ts` bundles it for a neutral platform.
 */

export {
  MindooDBServerCore,
  errorResponse,
  formatSyncChangeEvent,
  formatSyncHeartbeat,
  formatSyncHelloEvent,
  parseBodySizeLimitToBytes,
  SYNC_EVENT_HEARTBEAT_MS,
  SYNC_ROUTES,
  SYNC_STORE_KINDS,
  type MindooDBServerCoreOptions,
  type ServerClusterHooks,
  type SyncRouteName,
} from "./http/MindooDBServerCore";
export * from "./http/types";

export {
  TenantManager,
  SimpleMindooDirectory,
  type LoadedTenant,
  type RegisterTenantResult,
  type ExecutePendingPurgesOptions,
  type TenantManagerOptions,
} from "./TenantManager";
export {
  MemoryServerDataStore,
  type ServerDataStore,
  type ServerStoreProvider,
  type TenantStoreFactory,
} from "./ServerDataStore";
export { PurgedDocRegistry } from "./PurgedDocRegistry";
export { SyncEventBus, type SyncChangeEvent, type SyncChangeListener } from "./SyncEventBus";
export { CapabilityMatcher, parseSystemTenantItemPath } from "./CapabilityMatcher";
export { SystemAdminAuthService, type SystemAdminTokenPayload } from "./SystemAdminAuth";
export {
  DeviceDiscoveryAuthError,
  DeviceDiscoveryService,
  type DeviceDiscoverResult,
} from "./DeviceDiscoveryService";
export * from "./serverConfig";
export * from "./rateLimits";
export * from "./validation";
export * from "./timestampProxy";
export * from "./types";
