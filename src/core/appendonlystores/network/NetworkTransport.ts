import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../../types";
import type { NetworkEncryptedEntry, AuthResult } from "./types";

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
 * 4. Client uses the token for subsequent findNewEntries() and getEntries() calls
 * 
 * Security features:
 * - Challenge-response prevents replay attacks
 * - JWT tokens have expiration for session management
 * - Entry payloads are RSA-encrypted with recipient's public key
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
   * Find entries that the remote has which we don't have locally.
   * 
   * This is used to identify which entries need to be synchronized.
   * The returned StoreEntryMetadata contains metadata only (no encrypted payload).
   * 
   * @param token JWT access token from authenticate()
   * @param haveIds List of entry IDs we already have locally
   * @returns List of entry metadata for entries that exist remotely but not locally
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  findNewEntries(
    token: string,
    haveIds: string[]
  ): Promise<StoreEntryMetadata[]>;

  /**
   * Find entries for a specific document that the remote has which we don't have locally.
   * 
   * This is an optimized version of findNewEntries that only returns entries for a specific document.
   * 
   * @param token JWT access token from authenticate()
   * @param haveIds List of entry IDs we already have locally for this document
   * @param docId The document ID to filter by
   * @returns List of entry metadata for the specified document that exist remotely but not locally
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  findNewEntriesForDoc(
    token: string,
    haveIds: string[],
    docId: string
  ): Promise<StoreEntryMetadata[]>;

  /**
   * Find entries by type and creation date range from the remote store.
   * 
   * This enables efficient server-side filtering for time-travel queries.
   * 
   * @param token JWT access token from authenticate()
   * @param type The entry type to filter by
   * @param creationDateFrom Optional start timestamp (inclusive). If null, no lower bound.
   * @param creationDateUntil Optional end timestamp (exclusive). If null, no upper bound.
   * @returns List of entry metadata matching the criteria
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  findEntries(
    token: string,
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]>;

  /**
   * Get entries from the remote store.
   * 
   * The returned entries have their payloads RSA-encrypted with the
   * requesting user's public encryption key. The client must decrypt
   * these with their private key to get the original payload.
   * 
   * @param token JWT access token from authenticate()
   * @param ids The IDs of entries to retrieve
   * @returns NetworkEncryptedEntry[] with RSA-encrypted payloads
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  getEntries(
    token: string,
    ids: string[]
  ): Promise<NetworkEncryptedEntry[]>;

  /**
   * Push entries to the remote store.
   * 
   * This is used to send locally-created entries to the server for storage.
   * The server will verify that the entry was created by a trusted user
   * (by checking the createdByPublicKey against the tenant directory).
   * 
   * @param token JWT access token from authenticate()
   * @param entries The entries to push to the remote store
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   * @throws NetworkError with type INVALID_SIGNATURE if entry signature verification fails
   */
  putEntries(token: string, entries: StoreEntry[]): Promise<void>;

  /**
   * Check which of the provided IDs exist in the remote store.
   * 
   * This is more efficient than getAllIds() when checking a small number of IDs,
   * as it only transfers the IDs that exist rather than all IDs in the store.
   * 
   * @param token JWT access token from authenticate()
   * @param ids The IDs to check for existence
   * @returns List of IDs that exist in the remote store (subset of input)
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  hasEntries(token: string, ids: string[]): Promise<string[]>;

  /**
   * Get all entry IDs from the remote store.
   * 
   * This is used for synchronization to identify which entries the remote has.
   * Returns only the IDs (not the full entries) for efficiency.
   * 
   * @param token JWT access token from authenticate()
   * @returns List of all entry IDs in the remote store
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  getAllIds(token: string): Promise<string[]>;

  /**
   * Resolve the dependency chain starting from an entry ID.
   * 
   * Returns IDs in dependency order, traversing backward through dependencyIds.
   * This is more efficient than client-side traversal as it avoids multiple round trips.
   * 
   * @param token JWT access token from authenticate()
   * @param startId The entry ID to start traversal from
   * @param options Optional traversal options:
   *   - stopAtEntryType: Stop when encountering an entry of this type (e.g., "doc_snapshot")
   *   - maxDepth: Maximum number of hops to traverse
   *   - includeStart: Whether to include startId in the result (default: true)
   * @returns List of entry IDs in dependency order (oldest first)
   * @throws NetworkError with type INVALID_TOKEN if token is invalid or expired
   * @throws NetworkError with type USER_REVOKED if user has been revoked since token was issued
   */
  resolveDependencies(
    token: string,
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]>;
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
