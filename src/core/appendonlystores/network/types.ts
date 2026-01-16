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
   * Subject: the username of the authenticated user
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
   * The username this challenge was issued for
   */
  username: string;

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
  /** Server-side error */
  SERVER_ERROR = "SERVER_ERROR",
  /** User not found in directory */
  USER_NOT_FOUND = "USER_NOT_FOUND",
}

/**
 * Network transport error with type for structured error handling.
 */
export class NetworkError extends Error {
  constructor(
    public readonly type: NetworkErrorType,
    message: string
  ) {
    super(message);
    this.name = "NetworkError";
  }
}
