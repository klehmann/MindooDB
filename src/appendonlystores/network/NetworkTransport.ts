import type { MindooDocChange, MindooDocChangeHashes } from "../../types";
import type { NetworkEncryptedChange, AuthResult } from "./types";

/**
 * Abstract interface for network communication in MindooDB sync.
 * 
 * This interface defines the protocol for secure communication between
 * clients and servers (or peer-to-peer). It can be implemented for various
 * transport protocols like HTTP, WebSocket, WebRTC, etc.
 * 
 * The authentication flow is:
 * 1. Client calls requestChallenge(username) to get a challenge string
 * 2. Client signs the challenge with their private signing key
 * 3. Client calls authenticate(challenge, signature) to get a JWT token
 * 4. Client uses the token for subsequent findNewChanges() and getChanges() calls
 * 
 * Security features:
 * - Challenge-response prevents replay attacks
 * - JWT tokens have expiration for session management
 * - Change payloads are RSA-encrypted with recipient's public key
 */
export interface NetworkTransport {
  /**
   * Request a challenge string for authentication.
   * 
   * The server generates a unique challenge (UUID v7) that the client
   * must sign with their private signing key to prove identity.
   * 
   * @param username The username requesting authentication
   * @returns The challenge string (UUID v7) to be signed
   * @throws NetworkError with type USER_NOT_FOUND if user doesn't exist
   * @throws NetworkError with type USER_REVOKED if user has been revoked
   */
  requestChallenge(username: string): Promise<string>;

  /**
   * Authenticate by providing a signed challenge.
   * 
   * The server verifies the signature using the user's public signing key
   * from the tenant directory. If valid, returns a JWT access token.
   * 
   * @param challenge The challenge string that was signed
   * @param signature The Ed25519 signature of the challenge
   * @returns AuthResult with success status and JWT token (if successful)
   * @throws NetworkError with type INVALID_SIGNATURE if signature verification fails
   * @throws NetworkError with type CHALLENGE_EXPIRED if challenge has expired or was already used
   * @throws NetworkError with type USER_REVOKED if user has been revoked
   */
  authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult>;

  /**
   * Find changes that the remote has which we don't have locally.
   * 
   * This is used to identify which changes need to be synchronized.
   * The returned MindooDocChangeHashes contain metadata only (no payload).
   * 
   * @param token JWT access token from authenticate()
   * @param haveChangeHashes List of change hashes we already have locally
   * @returns List of change hashes that exist remotely but not locally
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  findNewChanges(
    token: string,
    haveChangeHashes: string[]
  ): Promise<MindooDocChangeHashes[]>;

  /**
   * Find changes for a specific document that the remote has which we don't have locally.
   * 
   * This is an optimized version of findNewChanges that only returns changes for a specific document.
   * 
   * @param token JWT access token from authenticate()
   * @param haveChangeHashes List of change hashes we already have locally for this document
   * @param docId The document ID to filter by
   * @returns List of change hashes for the specified document that exist remotely but not locally
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  findNewChangesForDoc(
    token: string,
    haveChangeHashes: string[],
    docId: string
  ): Promise<MindooDocChangeHashes[]>;

  /**
   * Get changes from the remote store.
   * 
   * The returned changes have their payloads RSA-encrypted with the
   * requesting user's public encryption key. The client must decrypt
   * these with their private key to get the original payload.
   * 
   * @param token JWT access token from authenticate()
   * @param changeHashes The change hashes to retrieve
   * @returns NetworkEncryptedChange[] with RSA-encrypted payloads
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  getChanges(
    token: string,
    changeHashes: MindooDocChangeHashes[]
  ): Promise<NetworkEncryptedChange[]>;

  /**
   * Push changes to the remote store.
   * 
   * This is used to send locally-created changes to the server for storage.
   * The server will verify that the change was created by a trusted user
   * (by checking the createdByPublicKey against the tenant directory).
   * 
   * @param token JWT access token from authenticate()
   * @param changes The changes to push to the remote store
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   * @throws NetworkError with type INVALID_SIGNATURE if change signature verification fails
   */
  pushChanges(token: string, changes: MindooDocChange[]): Promise<void>;

  /**
   * Get all change hashes from the remote store.
   * 
   * This is used for synchronization to identify which changes the remote has.
   * Returns only the hashes (not the full changes) for efficiency.
   * 
   * @param token JWT access token from authenticate()
   * @returns List of all change hashes in the remote store
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  getAllChangeHashes(token: string): Promise<string[]>;
}

/**
 * Configuration options for network transport implementations.
 */
export interface NetworkTransportConfig {
  /**
   * Base URL for the remote server (for HTTP transport)
   */
  baseUrl?: string;

  /**
   * Timeout for network requests in milliseconds (default: 30000)
   */
  timeout?: number;

  /**
   * Number of retry attempts for failed requests (default: 3)
   */
  retryAttempts?: number;

  /**
   * Base delay for exponential backoff in milliseconds (default: 1000)
   */
  retryDelayMs?: number;

  /**
   * Tenant ID for scoping requests
   */
  tenantId: string;

  /**
   * Database ID for scoping requests (optional)
   */
  dbId?: string;
}
