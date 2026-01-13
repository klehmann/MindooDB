// Network synchronization module for MindooDB
// Provides secure network-based AppendOnlyStore implementations

// Types
export type {
  NetworkEncryptedChange,
  UserPublicKeys,
  NetworkAuthTokenPayload,
  AuthChallenge,
  AuthResult,
} from "../../core/appendonlystores/network/types";
export { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";

// Interfaces
export type { NetworkTransport, NetworkTransportConfig } from "../../core/appendonlystores/network/NetworkTransport";

// Client-side
export { ClientNetworkAppendOnlyStore } from "./ClientNetworkAppendOnlyStore";

// Server-side
export { ServerNetworkAppendOnlyStore } from "./ServerNetworkAppendOnlyStore";

// Authentication
export { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";

// Transport implementations
export { HttpTransport } from "./HttpTransport";
