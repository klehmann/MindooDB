// Core platform-agnostic exports

// Types
export * from "./types";

// User ID types
export type { PublicUserId, PrivateUserId } from "./userid";

// Base classes
export { BaseMindooDB } from "./BaseMindooDB";
export { BaseMindooTenant } from "./BaseMindooTenant";
export { BaseMindooTenantFactory } from "./BaseMindooTenantFactory";

export {
  MindooDBServerAdmin,
  type MindooDBServerAdminOptions,
  type ServerConfig,
  type SystemAdminPrincipal,
  type ConfigBackupInfo,
  type ConfigBackupResponse,
} from "./MindooDBServerAdmin";

// Crypto
export type { CryptoAdapter } from "./crypto/CryptoAdapter";
export { RSAEncryption } from "./crypto/RSAEncryption";
export { MindooDocSigner } from "./crypto/MindooDocSigner";

// Keys
export { KeyBag, type KeyDetail } from "./keys/KeyBag";

// URI
export {
  encodeMindooURI,
  decodeMindooURI,
  isMindooURI,
  type MindooURIType,
  type DecodedMindooURI,
} from "./uri/MindooURI";

// Errors
export { SymmetricKeyNotFoundError } from "./errors";

// Cache
export type { LocalCacheStore } from "./cache/LocalCacheStore";
export { InMemoryLocalCacheStore } from "./cache/LocalCacheStore";
export { EncryptedLocalCacheStore } from "./cache/EncryptedLocalCacheStore";
export { CacheManager, type ICacheable, type CacheManagerOptions } from "./cache/CacheManager";

// Utilities
export {
  generateDocEntryId,
  generateDepsFingerprint,
  generateAttachmentChunkId,
  generateFileUuid7,
  generateChunkUuid7,
  parseDocEntryId,
  parseAttachmentChunkId,
  isDocEntryId,
  isAttachmentChunkId,
  extractDocIdFromEntryId,
  computeContentHash,
} from "./utils";

// Content-addressed stores
export {
  type ContentAddressedStore,
  type ContentAddressedStoreFactory,
  type CreateStoreResult,
  type OpenStoreOptions,
  type StoreCompactionStatus,
  type StoreScanCursor,
  type StoreScanFilters,
  type StoreScanResult,
  type StoreIdBloomSummary,
  type MaterializationPlanOptions,
  type MaterializationPlanDiagnostics,
  type DocumentMaterializationPlan,
  type DocumentMaterializationBatchPlan,
} from "./appendonlystores/types";
export { InMemoryContentAddressedStore, InMemoryContentAddressedStoreFactory } from "./appendonlystores/InMemoryContentAddressedStore";

// Network
export { AuthenticationService } from "./appendonlystores/network/AuthenticationService";
export type { NetworkTransport, NetworkTransportConfig } from "./appendonlystores/network/NetworkTransport";
export {
  type NetworkEncryptedEntry,
  type UserPublicKeys,
  type NetworkAuthTokenPayload,
  type AuthChallenge,
  type AuthResult,
  type NetworkSyncCapabilities,
  NetworkErrorType,
  NetworkError,
} from "./appendonlystores/network/types";
export { ClientNetworkContentAddressedStore } from "../appendonlystores/network/ClientNetworkContentAddressedStore";
export { HttpTransport } from "../appendonlystores/network/HttpTransport";

// Indexing - Virtual Views
export {
  VirtualView,
  VirtualViewFactory,
  VirtualViewBuilder,
  VirtualViewNavigatorBuilder,
  VirtualViewColumn,
  VirtualViewNavigator,
  VirtualViewEntryData,
  VirtualViewDataChange,
  MindooDBVirtualViewDataProvider,
  ColumnSorting,
  TotalMode,
  CategorizationStyle,
  WithCategories,
  WithDocuments,
  SelectedOnly,
  type VirtualViewColumnOptions,
  type IVirtualViewDataProvider,
  type MindooDBVirtualViewDataProviderOptions,
  type ScopedDocId,
  type ColumnValueFunction,
  type DocumentFilterFunction,
} from "./indexing/virtualviews";
