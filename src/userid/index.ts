import { SigningKeyPair, EncryptionKeyPair } from "../types";

/**
 * Public info for a user of the platform
 */
export interface PublicUserId {
  /**
   * The username of the user (format: "CN=<username>/O=<tenantId>")
   */
  username: string;

  /**
   * Signature by the administration key proving that an admin has granted this user
   * access to the tenant. This signature covers the username and other user identification.
   */
  administrationSignature: string;

  /**
   * The public key for signing (Ed25519, PEM format)
   * Used ONLY for signing document changes, not for encryption.
   */
  userSigningPublicKey: string;

  /**
   * The public key for encryption (RSA-OAEP, PEM format)
   * Used ONLY for encrypting/decrypting the named symmetric keys map stored on disk, not for signing.
   */
  userEncryptionPublicKey: string;
}

/**
 * Private info for a user of the platform
 * This is used to sign and encrypt operations for the user and not publicly shared.
 */
export interface PrivateUserId {
  /**
   * The username of the user (format: "CN=<username>/O=<tenantId>")
   */
  username: string;

  /**
   * Signature by the administration key proving that an admin has granted this user
   * access to the tenant. This signature covers the username and other user identification.
   */
  administrationSignature: string;

  /**
   * The signing key pair (Ed25519).
   * Contains both public and encrypted private key.
   * Used ONLY for signing document changes, not for encryption.
   */
  userSigningKeyPair: SigningKeyPair;

  /**
   * The encryption key pair (RSA-OAEP).
   * Contains both public and encrypted private key.
   * Used ONLY for encrypting/decrypting the named symmetric keys map stored on disk, not for signing.
   */
  userEncryptionKeyPair: EncryptionKeyPair;
}

