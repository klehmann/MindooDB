// Core platform-agnostic exports

// Types
export * from "./types";

// User ID types
export { PublicUserId, PrivateUserId } from "./userid";

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
