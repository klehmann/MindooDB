import type { StoreEntryMetadata } from "../../types";

/**
 * Network-encrypted entry for secure transport over the network.
 * 
 * Extends StoreEntryMetadata (metadata stays clear for routing/filtering)
 * but adds an RSA-encrypted version of the payload for transport security.
 * 
 * The metadata (docId, id, etc.) is transmitted unencrypted to allow
 * efficient filtering and routing without requiring decryption. The actual
 * payload data is RSA-encrypted with the recipient's public encryption key.
 */
export interface NetworkEncryptedEntry extends StoreEntryMetadata {
  /**
   * The original symmetric-encrypted payload, wrapped in RSA encryption
   * for secure network transport.
   * 
   * Must be decrypted with the recipient's RSA private key to get the
   * original StoreEntry.encryptedData (which is still encrypted with
   * the symmetric key).
   * 
   * This provides defense-in-depth: even if RSA is compromised, the
   * underlying symmetric encryption remains intact.
   */
  rsaEncryptedPayload: Uint8Array;
}

/**
 * User public keys retrieved from the tenant directory.
 * Used for authentication (signature verification) and encryption (transport encryption).
 */
export interface UserPublicKeys {
  /**
   * The user's public signing key (Ed25519, PEM format).
   * Used for verifying signatures on challenges during authentication.
   */
  signingPublicKey: string;

  /**
   * The user's public encryption key (RSA-OAEP, PEM format).
   * Used for encrypting change payloads for network transport.
   */
  encryptionPublicKey: string;
}

/**
 * JWT token payload structure for authenticated sessions.
 */
export interface NetworkAuthTokenPayload {
  /**
   * Subject of the authenticated session. Historically the cleartext username
   * the client posted to `/auth/challenge`. With key-based challenges the
   * username is optional, so `sub` may instead carry the authenticated device
   * signing key (Ed25519, PEM) when no username was supplied. Treat it as an
   * opaque principal id; identity for the read gate is resolved from
   * {@link deviceSigningKey} where present.
   */
  sub: string;

  /**
   * Issued at: timestamp when the token was issued (Unix epoch seconds)
   */
  iat: number;

  /**
   * Expiration: timestamp when the token expires (Unix epoch seconds)
   */
  exp: number;

  /**
   * Tenant ID this token is valid for
   */
  tenantId: string;

  /**
   * Optional: database ID if token is scoped to a specific database
   */
  dbId?: string;

  /**
   * Optional: the signing public key (Ed25519, PEM) the device actually
   * authenticated with (docs/accesscontrol.md §6.5). Determined by the server
   * from which of the user's granted/wipe-targeted keys verified the challenge.
   * Used to target a specific device for remote wipe.
   */
  deviceSigningKey?: string;

  /**
   * Optional: set when the authenticating device's signing key is the target of
   * an admin-requested remote wipe (`wipeRequestedForSigningKeys`, §6.5). A
   * wipe-scoped token may only fetch the admin-signed grant document carrying
   * the directive, and bypasses the normal revocation check so a revoked device
   * can still learn it must wipe.
   */
  wipe?: boolean;
}

/**
 * Challenge stored server-side for authentication.
 */
export interface AuthChallenge {
  /**
   * The challenge string (UUID v7)
   */
  challenge: string;

  /**
   * The username this challenge was issued for. Optional: with key-based
   * challenges the client may identify itself by its signing public key
   * instead (see {@link signingPublicKey}), so the server no longer requires
   * the cleartext username.
   */
  username?: string;

  /**
   * The device signing public key (Ed25519, PEM) this challenge was issued for,
   * when the client identified itself by key rather than username. Used by
   * {@link AuthenticationService.authenticate} to scope candidate keys.
   */
  signingPublicKey?: string;

  /**
   * Timestamp when the challenge was created (Unix epoch milliseconds)
   */
  createdAt: number;

  /**
   * Timestamp when the challenge expires (Unix epoch milliseconds)
   */
  expiresAt: number;

  /**
   * Whether the challenge has been used (for single-use enforcement)
   */
  used: boolean;
}

/**
 * Result of an authentication attempt.
 */
export interface AuthResult {
  /**
   * Whether authentication was successful
   */
  success: boolean;

  /**
   * JWT access token (only present if success is true)
   */
  token?: string;

  /**
   * Error message (only present if success is false)
   */
  error?: string;
}

/**
 * Advertised sync capabilities for transport-level feature negotiation.
 * Used by clients to choose fast paths while preserving compatibility.
 */
export interface NetworkSyncCapabilities {
  /**
   * Version of the advertised sync protocol shape.
   * Useful for coarse compatibility checks and rollout diagnostics.
   */
  protocolVersion: string;
  /**
   * Remote store supports cursor-based metadata scans via `scanEntriesSince()`.
   * Clients can avoid full known-id exchanges when reconciling large stores.
   */
  supportsCursorScan: boolean;
  /**
   * Remote store supports Bloom-filter summaries via `getIdBloomSummary()`.
   * Clients can use probabilistic prefiltering before exact reconciliation.
   */
  supportsIdBloomSummary: boolean;
  /**
   * Remote store exposes compaction/index observability via `getCompactionStatus()`.
   * This is informational and used for monitoring/debugging rather than correctness.
   */
  supportsCompactionStatus: boolean;
  /**
   * Remote store can compute a materialization plan for one document.
   * Clients can ask the server which snapshot and change entries are needed
   * instead of scanning and planning locally.
   */
  supportsMaterializationPlanning: boolean;
  /**
   * Remote store can compute materialization plans for multiple documents in one call.
   * Clients can reduce round trips when opening or refreshing many documents.
   */
  supportsBatchMaterializationPlanning: boolean;
  /**
   * Remote store can compute attachment read plans from chunk metadata.
   * Clients can delegate attachment range planning to the server instead of
   * walking attachment chunk metadata over the network.
   */
  supportsAttachmentReadPlanning: boolean;
  /**
   * Server's current wall-clock time (ms since Unix epoch) at the moment it
   * answered the capabilities request. Clients use this for the clock-skew
   * guard before syncing against an access-controlled tenant
   * (docs/accesscontrol.md §4 "Clock-skew guard"), so a client with a wrong
   * local clock cannot mis-stamp `createdAt`/trusted-time decisions.
   */
  serverTime?: number;
  /**
   * Whether the server implements the v1 access-control protocol (witness
   * receipts + Tier 1 enforcement, docs/accesscontrol.md §5–§7). Clients use
   * this to negotiate whether to enforce the clock-skew guard and to expect
   * witness receipts on accepted entries.
   */
  supportsAccessControlV1?: boolean;
  /**
   * Whether the server enforces remote-wipe serving (docs/accesscontrol.md
   * §6.5): a device whose signing key is wipe-targeted is served only the
   * admin-signed grant document carrying the directive and no other data.
   */
  supportsRemoteWipeV1?: boolean;
}

/**
 * Network transport error types for error handling.
 */
export enum NetworkErrorType {
  /** Token is invalid or expired */
  INVALID_TOKEN = "INVALID_TOKEN",
  /** User has been revoked */
  USER_REVOKED = "USER_REVOKED",
  /** Signature verification failed */
  INVALID_SIGNATURE = "INVALID_SIGNATURE",
  /** Challenge expired or already used */
  CHALLENGE_EXPIRED = "CHALLENGE_EXPIRED",
  /** Network communication error */
  NETWORK_ERROR = "NETWORK_ERROR",
  /** Request payload exceeded the remote server limit */
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",
  /** Request was rate limited by the remote server */
  RATE_LIMITED = "RATE_LIMITED",
  /** Server-side error */
  SERVER_ERROR = "SERVER_ERROR",
  /** User not found in directory */
  USER_NOT_FOUND = "USER_NOT_FOUND",
  /** Entry was denied by a Tier 1 access-control rule (docs/accesscontrol.md §7) */
  ACCESS_DENIED = "ACCESS_DENIED",
  /** Local/server clock skew exceeded tolerance during sync (§4 clock-skew guard) */
  CLOCK_SKEW = "CLOCK_SKEW",
}

/**
 * Network transport error with type for structured error handling.
 */
export class NetworkError extends Error {
  constructor(
    public readonly type: NetworkErrorType,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}
