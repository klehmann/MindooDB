// Core platform-agnostic exports

// Types
export * from "./types";

// User ID types
export { PublicUserId, PrivateUserId } from "./userid";

// Base classes
export { BaseMindooDB } from "./BaseMindooDB";
export { BaseMindooTenant } from "./BaseMindooTenant";
export { BaseMindooTenantFactory } from "./BaseMindooTenantFactory";

// Crypto
export { CryptoAdapter } from "./crypto/CryptoAdapter";
export { RSAEncryption } from "./crypto/RSAEncryption";
export { MindooDocSigner } from "./crypto/MindooDocSigner";

// Keys
export { KeyBag } from "./keys/KeyBag";

// Errors
export { SymmetricKeyNotFoundError } from "./errors";

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
export { ContentAddressedStore, ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions } from "./appendonlystores/types";
export { InMemoryContentAddressedStore, InMemoryContentAddressedStoreFactory } from "./appendonlystores/InMemoryContentAddressedStore";

// Network
export { AuthenticationService } from "./appendonlystores/network/AuthenticationService";
export { NetworkTransport, NetworkTransportConfig } from "./appendonlystores/network/NetworkTransport";
export {
  NetworkEncryptedEntry,
  UserPublicKeys,
  NetworkAuthTokenPayload,
  AuthChallenge,
  AuthResult,
  NetworkErrorType,
  NetworkError,
} from "./appendonlystores/network/types";

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
