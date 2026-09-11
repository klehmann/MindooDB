// React Native-specific exports
// Re-exports everything from core plus React Native-specific implementations

// Re-export all core exports
export * from "../core/index";

// Re-export Base* classes that aren't in core/index
export { BaseMindooDB } from "../core/BaseMindooDB";
export { BaseMindooTenant } from "../core/BaseMindooTenant";
export { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";

// React Native-specific crypto adapters
export { ReactNativeCryptoAdapter, createCryptoAdapter } from "./crypto/ReactNativeCryptoAdapter";
export { ExpoGoCryptoAdapter } from "./crypto/ExpoGoCryptoAdapter";
export { QuickCryptoAdapter, isQuickCryptoAvailable } from "./crypto/QuickCryptoAdapter";

// React Native-specific cache store
export { MMKVLocalCacheStore, type MMKVInterface, type AsyncStorageInterface } from "./cache/MMKVLocalCacheStore";

// Additive native persistence + P2P (not imported by mindoodb/browser)
export {
  SqliteContentAddressedStore,
  SqliteContentAddressedStoreFactory,
  createMemorySqliteBackend,
  createSqlBackend,
  createExpoSqliteBackend,
  createExpoSqliteExecutor,
} from "../sqlite/index";
export type { SqliteExecutor, SqliteStoreBackend, SqliteValue, ExpoSqliteLike } from "../sqlite/index";
export {
  MINDOODB_IROH_ALPN,
  IrohNetworkTransport,
  IrohPeerStore,
  createLoopbackIrohPair,
  createReactNativeIrohStreamIO,
  createStoreIrohHandler,
  listenForIrohPeers,
  serveIrohRpc,
} from "../iroh/index";
export type { IrohByteStream, IrohStreamIO, IrohRpcHandler, IrohRpcContext } from "../iroh/index";
export { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
