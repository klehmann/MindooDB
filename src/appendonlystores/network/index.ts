// Network synchronization module for MindooDB
// Provides secure network-based ContentAddressedStore implementations

// Types
export type {
  NetworkEncryptedEntry,
  UserPublicKeys,
  NetworkAuthTokenPayload,
  AuthChallenge,
  AuthResult,
} from "../../core/appendonlystores/network/types";
export { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";

// Interfaces
export type { NetworkTransport, NetworkTransportConfig } from "../../core/appendonlystores/network/NetworkTransport";

// Client-side
export { ClientNetworkContentAddressedStore } from "./ClientNetworkContentAddressedStore";

// Server-side
export { ServerNetworkContentAddressedStore } from "./ServerNetworkContentAddressedStore";

// Authentication
export { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";

// Transport implementations
export { HttpTransport } from "./HttpTransport";
