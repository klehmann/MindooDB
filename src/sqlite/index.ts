/**
 * Additive SQLite ContentAddressedStore. Not imported by `mindoodb/browser`.
 */
export {
  SqliteContentAddressedStore,
  SqliteContentAddressedStoreFactory,
} from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
export {
  createMemorySqliteBackend,
  createSqlBackend,
  type SqliteExecutor,
  type SqliteStoreBackend,
  type SqliteValue,
} from "../core/appendonlystores/sqlite/SqliteDriver";
export {
  createExpoSqliteBackend,
  createExpoSqliteExecutor,
  type ExpoSqliteLike,
} from "../core/appendonlystores/sqlite/expoSqliteDriver";
// Store RPC, so a host app can serve SQLite stores to a WebView client
// without importing the whole library (see RpcContentAddressedStore).
export {
  StoreRpcServer,
  type StoreRpcServerBytes,
  type StoreRpcServerOptions,
} from "../core/appendonlystores/rpc/StoreRpcServer";
export {
  RpcContentAddressedStoreFactory,
  SQLITE_STORE_RPC_METHODS,
  type StoreRpcClientTransport,
  type StoreRpcRequest,
} from "../core/appendonlystores/rpc/RpcContentAddressedStore";
