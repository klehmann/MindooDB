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

// Append-only stores
export { AppendOnlyStore, AppendOnlyStoreFactory } from "./appendonlystores/types";
export { InMemoryAppendOnlyStore, InMemoryAppendOnlyStoreFactory } from "./appendonlystores/InMemoryAppendOnlyStore";

// Network
export { AuthenticationService } from "./appendonlystores/network/AuthenticationService";
export { NetworkTransport, NetworkTransportConfig } from "./appendonlystores/network/NetworkTransport";
export {
  NetworkEncryptedChange,
  UserPublicKeys,
  NetworkAuthTokenPayload,
  AuthChallenge,
  AuthResult,
  NetworkErrorType,
  NetworkError,
} from "./appendonlystores/network/types";
