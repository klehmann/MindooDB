import { EncryptedPrivateKey } from "../types";

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
   * The public key for encryption (RSA or ECDH, PEM format)
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
   * The public key for signing (Ed25519, PEM format)
   * Used ONLY for signing document changes, not for encryption.
   */
  userSigningPublicKey: string;

  /**
   * The encrypted private key for signing (Ed25519)
   * Encrypted with password via key derivation (salt: "signing")
   * Used ONLY for signing document changes, not for encryption.
   */
  userSigningPrivateKey: EncryptedPrivateKey;

  /**
   * The public key for encryption (RSA or ECDH, PEM format)
   * Used ONLY for encrypting/decrypting the named symmetric keys map stored on disk, not for signing.
   */
  userEncryptionPublicKey: string;

  /**
   * The encrypted private key for encryption (RSA or ECDH)
   * Encrypted with password via key derivation (salt: "encryption")
   * Used ONLY for encrypting/decrypting the named symmetric keys map stored on disk, not for signing.
   */
  userEncryptionPrivateKey: EncryptedPrivateKey;
}

