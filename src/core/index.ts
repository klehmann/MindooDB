// Core platform-agnostic exports

// Types
export * from "./types";
export * from "./databaseIdValidation";
export * from "./tenantIdValidation";

// Access-control directory schema + time-travel state (docs/accesscontrol.md
// §6/§8). Surfaced so consumers (e.g. the Haven directory-history UI) can read
// the time-travel DirectoryStateNode returned by
// MindooTenantDirectory.getDirectoryStateAt / getDirectoryStateHead.
export {
  ACCESS_CONTROL_FORM,
  ACL_DEFAULT_POLICY_DOC_ID,
  DEFAULT_POLICY_DEFAULTS,
  RULE_TYPES,
  RULE_TYPE_TO_DENY_FIELD,
  effectivePolicy,
  aclDbPolicyDocId,
  aclRuleDocId,
  aclTrustedWitnessDocId,
  encodeAclIdComponent,
  decodeAclIdComponent,
  aclKeyDistributionDocId,
  isKeyDistributionDocId,
  validateKeyDistribution,
  KEY_DISTRIBUTION_TYPE,
  ACL_KEY_DISTRIBUTION_PREFIX,
  PROTECTED_DISTRIBUTION_KEY_IDS,
  aclAppDistributionDocId,
  isAppDistributionDocId,
  validateAppDistribution,
  APP_DISTRIBUTION_TYPE,
  ACL_APP_DISTRIBUTION_PREFIX,
  aclSyncSetupPolicyDocId,
  isSyncSetupPolicyDocId,
  validateSyncSetupPolicy,
  SYNC_SETUP_POLICY_TYPE,
  SYNC_SETUP_POLICY_MODES,
  ACL_SYNC_SETUP_POLICY_PREFIX,
  aclDocHistoryPurgeDocId,
  isDocHistoryPurgeDocId,
  validateDocHistoryPurge,
  DOC_HISTORY_PURGE_TYPE,
  ACL_DOC_HISTORY_PURGE_PREFIX,
  type RuleType,
  type Operator,
  type WithFieldWhen,
  type WithFieldClause,
  type DefaultAccessPolicyDoc,
  type AclRuleDoc,
  type RuleTargets,
  type TrustedWitnessDoc,
  type AccessTier,
  type AccessDecision,
  type KeyVersionRef,
  type DeviceWrappedVersions,
  type KeyDistributionDoc,
  type KeyDistributionRequest,
  type KeyDistributionPushRecipient,
  type KeyDistributionView,
  type AppDistributionDoc,
  type AppDistributionRequest,
  type AppDistributionView,
  type AppDistributionInstall,
  type AppDistributionReconcilePlan,
  type SyncSetupPolicyDoc,
  type SyncSetupPolicyRequest,
  type SyncSetupPolicyView,
  type SyncSetupPolicyMode,
  type SyncSetupPolicyDatabase,
  type SyncSetupPolicyReconcilePlan,
  type DocHistoryPurgeDoc,
  type DocHistoryPurgeRequest,
  type DocHistoryPurgeView,
} from "./accesscontrol/types";
export {
  createGenesisNode,
  nodeCovering,
  type DirectoryStateNode,
  type UserGrantSnapshot,
  type GroupSnapshot,
} from "./accesscontrol/DirectoryStateNode";
export { AccessDeniedError } from "./accesscontrol/AccessDeniedError";

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
export {
  decryptEncryptedField,
  getEncryptedFieldKeyId,
  type EncryptedFieldDecryptor,
} from "./crypto/encryptedFields";

// Keys
export { KeyBag, type KeyDetail } from "./keys/KeyBag";

// URI
export {
  encodeMindooURI,
  decodeMindooURI,
  isMindooURI,
  encodeKeyDistributionRequest,
  decodeKeyDistributionRequest,
  encodeAppDistributionRequest,
  decodeAppDistributionRequest,
  encodeSyncSetupPolicyRequest,
  decodeSyncSetupPolicyRequest,
  encodeDocHistoryPurgeRequest,
  decodeDocHistoryPurgeRequest,
  type MindooURIType,
  type DecodedMindooURI,
} from "./uri/MindooURI";

// Errors
export {
  SymmetricKeyNotFoundError,
  DocumentNotFoundError,
  DocumentDeletedError,
  isDocumentMissingError,
} from "./errors";

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
  type VirtualViewUpdateStats,
  type ViewDataSourceInfo,
  type WithDBOptions,
} from "./indexing/virtualviews";

// Summary-first data provider factory (summary buffer when possible,
// materialized documents on request/fallback)
export {
  createViewDataProvider,
  collectSummaryFallbackReasons,
  filterExpressionToDocumentFilter,
  type CreateViewDataProviderOptions,
  type CreateViewDataProviderResult,
  type ViewDataProviderSource,
} from "./indexing/createViewDataProvider";

// Expression language (formerly mindoodb-view-language; that package
// re-exports these symbols as a compatibility wrapper)
export * from "./expressions";

// Ad-hoc query engine over the document summary buffer
export {
  executeQuery,
  executeQueryLive,
  MindooQueryError,
  EphemeralSummaryView,
  createEphemeralSummaryView,
  queryViewAcross,
  type EphemeralViewSource,
  type MindooQuerySubscription,
  type MindooQueryViewDefinition,
  type MindooQuery,
  type MindooQuerySortKey,
  type MindooQueryTextClause,
  type MindooQueryErrorCode,
  type MindooQueryOptions,
  type MindooQueryRow,
  type MindooQueryCoverage,
  type MindooQueryResult,
} from "./query";

// Indexing - Document summary buffer (ad-hoc query substrate)
export {
  DocumentSummaryStore,
  SummaryVirtualViewDataProvider,
  type SummaryVirtualViewDataProviderOptions,
  resolveSummaryConfig,
  computeSummaryConfigFingerprint,
  sanitizeSummaryConfig,
  extractSummaryFields,
  getSummaryFieldValue,
  isFieldPathCovered,
  DEFAULT_SUMMARY_MAX_VALUE_BYTES,
  DB_SETUP_DOC_ID,
  SUMMARY_SETUP_FIELD,
  ATTACHMENTS_FIELD,
  type SummaryAttachmentInfo,
  type SummaryConfig,
  type ResolvedSummaryConfig,
  type DocumentSummaryEntry,
  type SummaryCoverage,
} from "./indexing/summary";

// Indexing - Document full-text index (opt-in, see docs/fulltext-search.md)
export {
  DocumentFullTextIndex,
  MiniSearchAdapter,
  createTokenizer,
  resolveFulltextConfig,
  sanitizeFulltextConfig,
  computeFulltextConfigFingerprint,
  collectPlainText,
  extractFulltextFields,
  FULLTEXT_SETUP_FIELD,
  FULLTEXT_ATTACHMENT_FIELD,
  FULLTEXT_INDEX_FORMAT_VERSION,
  DEFAULT_FULLTEXT_MAX_FIELD_BYTES,
  type SearchEngineAdapter,
  type FulltextConfig,
  type ResolvedFulltextConfig,
  type FulltextCoverage,
  type FulltextSearchHit,
  type FulltextSearchOptions,
  type FulltextSearchResult,
  type AttachmentTextExtractor,
} from "./indexing/fulltext";

// Attachment text extraction setup (host-side services like Haven's OCR;
// results are persisted at the attachment entry, see docs/fulltext-search.md)
export {
  EXTRACTION_SETUP_FIELD,
  sanitizeExtractionConfig,
  type ExtractionConfig,
} from "./extraction/types";
