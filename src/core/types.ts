import type { KeyBag } from "./keys/KeyBag";
import type { PublicUserId, PrivateUserId } from "./userid";
import type { ContentAddressedStore, OpenStoreOptions } from "./appendonlystores/types";
import type { CryptoAdapter } from "./crypto/CryptoAdapter";
import { MindooDocSigner } from "./crypto/MindooDocSigner";

/**
 * Well-known key ID for access control documents (grantaccess, revokeaccess, groups).
 * All servers and clients MUST have this key in their KeyBag to verify user access.
 * This enables servers to validate users without having full tenant data access.
 */
export const PUBLIC_INFOS_KEY_ID = "$publicinfos";

/**
 * An EncryptedPrivateKey is a private key that is encrypted with a password.
 * Used for both asymmetric keys (RSA, Ed25519, ECDH) and symmetric keys (AES-256).
 */
export interface EncryptedPrivateKey {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  salt: string; // base64
  iterations: number;
  /**
   * Optional timestamp for key rotation support (milliseconds since Unix epoch)
   * Newer keys should be tried first when decrypting
   */
  createdAt?: number;
}

/**
 * A signing key pair containing both the public and encrypted private key.
 * The public key is needed for signature verification by other users.
 */
export interface SigningKeyPair {
  /**
   * The public signing key (Ed25519, PEM format).
   * This is used by others to verify signatures created with the private key.
   */
  publicKey: string;
  
  /**
   * The encrypted private signing key (Ed25519).
   * This is used to create signatures.
   */
  privateKey: EncryptedPrivateKey;
}

/**
 * An encryption key pair containing both the public and encrypted private key.
 * The public key can be shared with others to allow them to encrypt data specifically for the key owner.
 * Only the owner with the private key can decrypt the data.
 */
export interface EncryptionKeyPair {
  /**
   * The public encryption key (RSA-OAEP, PEM format).
   * This can be shared with others to allow them to encrypt data for the key owner.
   */
  publicKey: string;
  
  /**
   * The encrypted private encryption key (RSA-OAEP).
   * This is used to decrypt data encrypted with the corresponding public key.
   */
  privateKey: EncryptedPrivateKey;
}

// Re-export PublicUserId and PrivateUserId from userid module
export type { PublicUserId, PrivateUserId };

/**
 * A TenantFactory is a factory for creating and managing tenants.
 */
export interface MindooTenantFactory {

  /**
   * Create a new tenant with a new tenant encryption key.
   * 
   * The tenant encryption key is used as the default document encryption key
   * (so that all data within the tenant is secure by default).
   * 
   * The administration public key must be created beforehand using createSigningKeyPair()
   * and passed to this method. The administration key is used for administrative operations
   * within the tenant, such as adding new users to the tenant.
   * 
   * The administration encryption public key must be created using createEncryptionKeyPair()
   * and is used to encrypt sensitive data in the directory that only admins can decrypt
   * (e.g., usernames in access control documents).
   *
   * @param tenantId The ID of the tenant
   * @param administrationPublicKey The administration public key (Ed25519, PEM format) created using createSigningKeyPair()
   * @param administrationEncryptionPublicKey The administration encryption public key (RSA-OAEP, PEM format) created using createEncryptionKeyPair()
   * @param tenantEncryptionKeyPassword The password to be set to decrypt the tenant encryption private key
   * @param currentUser The current user's private user ID (required for tenant operations)
   * @param currentUserPassword The password to decrypt the current user's private keys
   * @param keyBag The KeyBag instance for storing and loading named encrypted keys
   * @return The new tenant
   */
  createTenant(
    tenantId: string,
    administrationPublicKey: string,
    administrationEncryptionPublicKey: string,
    tenantEncryptionKeyPassword: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag
  ): Promise<MindooTenant>;

  /**
   * Opens an existing tenant with previously created keys.
   * 
   * @param tenantId The ID of the tenant
   * @param tenantEncryptionPrivateKey The tenant encryption key (AES-256, encrypted)
   * @param tenantEncryptionKeyPassword The password to decrypt the tenant encryption key
   * @param administrationPublicKey The administration public key (Ed25519, PEM format)
   * @param administrationEncryptionPublicKey The administration encryption public key (RSA-OAEP, PEM format)
   * @param currentUser The current user's private user ID (required for tenant operations)
   * @param currentUserPassword The password to decrypt the current user's private keys
   * @param keyBag The KeyBag instance for storing and loading named encrypted keys
   * @return The tenant
   */
  openTenantWithKeys(
    tenantId: string,
    tenantEncryptionPrivateKey: EncryptedPrivateKey,
    tenantEncryptionKeyPassword: string,
    administrationPublicKey: string,
    administrationEncryptionPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
  ): Promise<MindooTenant>;

  /**
   * Creates a new user with separate signing and encryption key pairs.
   * 
   * @param username The username of the user (format: "CN=<username>/O=<tenantId>")
   * @param password The password to encrypt both private keys (via key derivation with different salts)
   * @return The new user ID
   */
  createUserId(username: string, password: string): Promise<PrivateUserId>;

  /**
   * Removes the private information from a private user ID and returns a public user ID.
   * 
   * @param privateUserId The private user ID to convert to a public user ID
   * @return The public user ID
   */
  toPublicUserId(privateUserId: PrivateUserId): PublicUserId;

  /**
   * Creates a new signing key pair for the tenant.
   * Returns both the public and encrypted private key, as the public key is needed
   * for signature verification by other users.
   * 
   * @param password The password to encrypt the signing private key with
   * @return The signing key pair containing both public key (PEM format) and encrypted private key (Ed25519)
   */
  createSigningKeyPair(password: string): Promise<SigningKeyPair>;

  /**
   * Creates a new encrypted symmetric key (AES-256) for document encryption.
   * The key is encrypted with the provided password and can be distributed to authorized users.
   * Use KeyBag.decryptAndImportKey() to store the returned key in the user's KeyBag.
   * 
   * Symmetric keys are shared secrets - anyone with the key can both encrypt and decrypt.
   * For user-to-user encryption where only the recipient can decrypt, use createEncryptionKeyPair() instead.
   * 
   * @param password The password to encrypt the symmetric key with (mandatory)
   * @return The encrypted symmetric key that can be distributed to authorized users
   */
  createSymmetricEncryptedPrivateKey(password: string): Promise<EncryptedPrivateKey>;

  /**
   * Creates a new asymmetric encryption key pair (RSA-OAEP) for user-to-user encryption.
   * Returns both the public and encrypted private key.
   * 
   * Use case: User A can fetch User B's public key from the directory DB, encrypt data with it,
   * and only User B (with the private key) can decrypt it. This enables secure point-to-point
   * encryption without sharing symmetric keys.
   * 
   * @param password The password to encrypt the private key with (mandatory)
   * @return The encryption key pair containing both public key (PEM format) and encrypted private key (RSA-OAEP)
   */
  createEncryptionKeyPair(password: string): Promise<EncryptionKeyPair>;
}

/**
 * A MindooTenant contains multiple MindooDB in an organization. One MindooDB is a mandatory part
 * of every tenant and called "directory". It contains all users and their public keys that
 * have access to the tenant and are considered trusted users.
 * 
 * Note on access revocation: Due to the append-only nature of the store, revoking a user's access
 * prevents them from decrypting future document changes, but they retain access to previously
 * decrypted changes. This is a fundamental tradeoff of append-only stores.
 */
export interface MindooTenant {
  /**
   * Get the factory that was used to create this tenant.
   * 
   * @return The factory that was used to create this tenant
   */
  getFactory(): MindooTenantFactory;

  /**
   * Get the ID of the tenant (UUID7 format)
   *
   * @return The ID of the tenant
   */
  getId(): string;

  /**
   * Get the administration public key for this tenant.
   * Used for creating document signers for administrative operations and verifying
   * signatures on administrative documents (e.g., user registration, revocation).
   * 
   * @return The administration public key (Ed25519, PEM format)
   */
  getAdministrationPublicKey(): string;

  /**
   * Get the administration encryption public key for this tenant.
   * Used for encrypting sensitive data in the directory that only admins can decrypt
   * (e.g., usernames in access control documents).
   * 
   * @return The administration encryption public key (RSA-OAEP, PEM format)
   */
  getAdministrationEncryptionPublicKey(): string;

  /**
   * Returns the encryption key used to encrypt all communication in this tenant
   * (e.g. the document changesets).
   * 
   * Note: This is a symmetric key (AES-256) used ONLY for encryption/decryption, not for signing.
   * 
   * @return The tenant encryption key (AES-256, encrypted)
   */
  getTenantEncryptionKey(): EncryptedPrivateKey;

  /**
   * Encrypt a payload using the symmetric key identified by decryptionKeyId.
   * For "default", uses the tenant encryption key.
   * For named keys, uses the named symmetric key (trying newest versions first for key rotation).
   * This method handles all key management internally.
   * 
   * @param payload The payload to encrypt (binary data)
   * @param decryptionKeyId The key ID ("default" or a named key ID)
   * @return The encrypted payload (binary data, AES-256-GCM)
   */
  encryptPayload(payload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array>;

  /**
   * Decrypt a payload using the symmetric key identified by decryptionKeyId.
   * For "default", uses the tenant encryption key.
   * For named keys, uses the named symmetric key (trying newest versions first for key rotation).
   * This method handles all key management internally.
   * 
   * @param encryptedPayload The encrypted payload to decrypt (binary data, AES-256-GCM)
   * @param decryptionKeyId The key ID ("default" or a named key ID)
   * @return The decrypted payload (binary data)
   */
  decryptPayload(encryptedPayload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array>;

  /**
   * Validates a public signing key by checking if it belongs to a trusted user in the tenant.
   * This is used for signature verification when loading changes from the append-only store.
   * 
   * @param publicKey The public signing key to validate (Ed25519, PEM format)
   * @return True if the public key belongs to a trusted (registered and not revoked) user, false otherwise
   */
  validatePublicSigningKey(publicKey: string): Promise<boolean>;

  /**
   * Get the current user ID for the tenant.
   * This provides user context for operations that need to know which user is performing them.
   * Used for signing document changes.
   * 
   * @return The current user's public user ID (always set, never null)
   */
  getCurrentUserId(): Promise<PublicUserId>;

  /**
   * Sign a payload with the current user's signing private key.
   * This is used by MindooDB operations (like changeDoc) to sign document changes.
   * The signature proves authenticity and integrity of the payload.
   * 
   * @param payload The payload to sign (binary data)
   * @return The signature (Ed25519 signature as Uint8Array)
   */
  signPayload(payload: Uint8Array): Promise<Uint8Array>;

  /**
   * Sign a payload with a specific signing key pair.
   * This is used for operations that need to sign with a different key than the current user's,
   * such as directory operations that must be signed with the administration key.
   * 
   * @param payload The payload to sign (binary data)
   * @param signingKeyPair The signing key pair to use (Ed25519)
   * @param password The password to decrypt the signing private key
   * @return The signature (Ed25519 signature as Uint8Array)
   */
  signPayloadWithKey(
    payload: Uint8Array,
    signingKeyPair: SigningKeyPair,
    password: string
  ): Promise<Uint8Array>;

  /**
   * Verify a signature for a payload with a public key.
   *
   * @param payload The payload to verify the signature for (binary data)
   * @param signature The signature to verify (Ed25519 signature as Uint8Array)
   * @param publicKey The public key to verify the signature with (Ed25519, PEM format)
   * @return True if the signature is valid, false otherwise
   */
  verifySignature(payload: Uint8Array, signature: Uint8Array, publicKey: string): Promise<boolean>;

  /**
   * Method to open the directory for this tenant
   *
   * @return The directory
   */
  openDirectory(): Promise<MindooTenantDirectory>;

  /**
   * Opens a database for this tenant.
   * Creates the database if it doesn't exist.
   *
   * @param id The ID of the database
   * @param options Optional configuration including store options and adminOnlyDb flag
   * @return The database instance
   */
  openDB(id: string, options?: OpenDBOptions): Promise<MindooDB>;

  /**
   * Creates a MindooDocSigner instance for signing and verifying document items.
   * The signer uses the tenant's cryptographic infrastructure for key management.
   * 
   * @param signKey The signing key pair to use for document item signatures
   * @return A MindooDocSigner instance configured with this tenant and the provided signing key
   */
  createDocSignerFor(signKey: SigningKeyPair): MindooDocSigner;

  /**
   * Get the crypto adapter for this tenant.
   * The crypto adapter provides access to the Web Crypto API (SubtleCrypto).
   * 
   * @return The crypto adapter
   */
  getCryptoAdapter(): CryptoAdapter;
}

// Re-export ContentAddressedStore and ContentAddressedStoreFactory from appendonlystores
export type { ContentAddressedStore, ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions } from "./appendonlystores/types";

/**
 * The type of entry stored in the ContentAddressedStore.
 * Entry types are prefixed to indicate their domain:
 * - doc_* entries are for Automerge document operations
 * - attachment_* entries are for file attachment storage
 */
export type StoreEntryType = 
  | "doc_create"      // Document creation (first Automerge change)
  | "doc_change"      // Document modification (subsequent Automerge changes)
  | "doc_snapshot"    // Automerge snapshot for performance optimization
  | "doc_delete"      // Document deletion (tombstone entry)
  | "attachment_chunk"; // File attachment chunk

/**
 * Metadata for entries stored in the ContentAddressedStore.
 * This contains all information except the actual encrypted payload,
 * making it efficient for synchronization negotiations.
 */
export interface StoreEntryMetadata {
  /**
   * The type of this entry, indicating what kind of data it contains.
   */
  entryType: StoreEntryType;

  /**
   * Unique identifier for this entry (primary key in the store).
   * - For doc_* entries: "<docId>_d_<depsFingerprint>_<automergeHash>"
   * - For attachment_chunk: "<docId>_a_<fileUuid7>_<base62ChunkUuid7>"
   * 
   * The structured ID format enables:
   * - Guaranteed uniqueness across documents
   * - Efficient prefix-based queries
   * - Debugging visibility into entry relationships
   */
  id: string;

  /**
   * SHA-256 hash of the encryptedData.
   * Used for integrity verification and storage-level deduplication.
   * Multiple entries can share the same contentHash (same bytes on disk).
   */
  contentHash: string;

  /**
   * The ID of the document this entry is associated with (UUID7 format).
   * For attachment chunks, this links the chunk to its parent document.
   */
  docId: string;

  /**
   * IDs of entries this entry depends on.
   * - For doc_* entries: Entry IDs of Automerge dependencies
   * - For attachment_chunk: Previous chunk's entry ID (enables append-only file growth)
   */
  dependencyIds: string[];

  /**
   * The timestamp when this entry was created (milliseconds since Unix epoch).
   */
  createdAt: number;

  /**
   * The public signing key of the user who created this entry (Ed25519, PEM format).
   * Used for signature verification and audit trails.
   */
  createdByPublicKey: string;

  /**
   * The ID of the symmetric key used to encrypt this entry.
   * "default" means tenant encryption key (all tenant members can decrypt).
   * Other IDs refer to named symmetric keys (only users with that key can decrypt).
   */
  decryptionKeyId: string;

  /**
   * The signature of the entry (signed with the user's signing key over the encrypted data).
   * This allows signature verification without decryption.
   */
  signature: Uint8Array;

  /**
   * Original size of the plaintext data before encryption (in bytes).
   * For doc_* entries: size of the Automerge binary change/snapshot
   * For attachment_chunk: size of the unencrypted chunk data
   */
  originalSize: number;

  /**
   * Size of the encrypted data (in bytes).
   * This is the size that will be transferred over the network or stored on disk.
   * Useful for download time estimation, storage space checks, and progress indicators.
   */
  encryptedSize: number;
}

/**
 * A complete entry stored in the ContentAddressedStore.
 * Extends StoreEntryMetadata with the actual encrypted payload.
 */
export interface StoreEntry extends StoreEntryMetadata {
  /**
   * The encrypted binary payload data.
   * - For doc_create/doc_change: Encrypted Automerge change bytes
   * - For doc_snapshot: Encrypted Automerge snapshot bytes
   * - For doc_delete: Encrypted Automerge change bytes (may be empty change)
   * - For attachment_chunk: Encrypted file chunk data
   * 
   * The IV and authentication tag are embedded within this data.
   */
  encryptedData: Uint8Array;
}

/**
 * Reference to an attachment stored in the attachment store.
 * This metadata is stored in the document's _attachments array.
 */
export interface AttachmentReference {
  /**
   * Unique identifier for this attachment instance (UUID7 format)
   */
  attachmentId: string;
  
  /**
   * Original filename of the attachment
   */
  fileName: string;
  
  /**
   * MIME type of the attachment (e.g., "application/pdf", "image/png")
   */
  mimeType: string;
  
  /**
   * Total size of the attachment in bytes
   */
  size: number;
  
  /**
   * Entry ID of the last chunk in the attachment store.
   * Used for dependency resolution to traverse all chunks.
   */
  lastChunkId: string;
  
  /**
   * The key ID used to encrypt attachment chunks.
   * Same as the document's decryptionKeyId ("default" or named key).
   */
  decryptionKeyId: string;
  
  /**
   * Timestamp when the attachment was added (milliseconds since Unix epoch)
   */
  createdAt: number;
  
  /**
   * Public signing key of the user who created this attachment (Ed25519, PEM format)
   */
  createdBy: string;
}

/**
 * Configuration for attachment handling in MindooDB.
 */
export interface AttachmentConfig {
  /**
   * Size of each attachment chunk in bytes.
   * Larger chunks mean fewer entries but higher memory usage.
   * Default: 256 * 1024 (256KB)
   */
  chunkSizeBytes?: number;
}

/**
 * A MindooDoc is a document that is stored in the MindooDB.
 * It's a wrapper around the Automerge document.
 */
export interface MindooDoc {
  /**
   * Get the database that this document belongs to
   *
   * @return The database that this document belongs to
   */
  getDatabase(): MindooDB;

  /*
   * Get the ID of the document (UUID7 format)
   *
   * @return The ID of the document
  */
  getId(): string;

  /**
   * Get the timestamp of the creation of the document
   * in milliseconds since the Unix epoch.
   *
   * @return The timestamp of the creation of the document
   */
  getCreatedAt(): number;

  /**
   * Get the timestamp of the last modification of the document
   * in milliseconds since the Unix epoch.
   *
   * @return The timestamp of the last modification of the document
   */
  getLastModified(): number;
  
  /**
   * Check if the document has been deleted.
   * Deletion is tracked via "delete" type entries in the append-only store.
   *
   * @return True if the document has been deleted, false otherwise
   */
  isDeleted(): boolean;
  
  /*
   * Get the payload of the document
   *
   * @return The payload of the document
   */
  getData(): MindooDocPayload;

  // ========== Attachment Write Methods ==========
  // These methods only work within the changeDoc() callback.
  // Calling them outside of changeDoc() will throw an error.

  /**
   * Add an attachment to this document.
   * This method only works within the changeDoc() callback.
   * 
   * @param fileData The binary data of the attachment
   * @param fileName The original filename
   * @param mimeType The MIME type (e.g., "application/pdf")
   * @param decryptionKeyId Optional key ID for encryption. If not provided, uses the document's key.
   * @return The attachment reference with metadata
   * @throws Error if called outside of changeDoc() callback
   */
  addAttachment(
    fileData: Uint8Array,
    fileName: string,
    mimeType: string,
    decryptionKeyId?: string
  ): Promise<AttachmentReference>;

  /**
   * Add an attachment from a streaming data source.
   * This method only works within the changeDoc() callback.
   * Memory efficient for large files - processes data chunk by chunk.
   * 
   * Accepts any AsyncIterable, including:
   * - ReadableStream (from fetch, File.stream(), Blob.stream())
   * - Node.js streams (via async iteration)
   * - Custom async generators
   * 
   * @param dataStream An async iterable yielding Uint8Array chunks
   * @param fileName The original filename
   * @param mimeType The MIME type (e.g., "application/pdf")
   * @param decryptionKeyId Optional key ID for encryption. If not provided, uses the document's key.
   * @return The attachment reference with metadata
   * @throws Error if called outside of changeDoc() callback
   */
  addAttachmentStream(
    dataStream: AsyncIterable<Uint8Array>,
    fileName: string,
    mimeType: string,
    decryptionKeyId?: string
  ): Promise<AttachmentReference>;

  /**
   * Remove an attachment from this document.
   * This method only works within the changeDoc() callback.
   * Note: This removes the reference from the document but does not delete the chunks
   * from the attachment store (append-only semantics).
   * 
   * @param attachmentId The ID of the attachment to remove
   * @throws Error if called outside of changeDoc() callback or if attachment not found
   */
  removeAttachment(attachmentId: string): Promise<void>;

  /**
   * Append data to an existing attachment.
   * This method only works within the changeDoc() callback.
   * Useful for log files and other append-only data.
   * 
   * @param attachmentId The ID of the attachment to append to
   * @param data The binary data to append
   * @throws Error if called outside of changeDoc() callback or if attachment not found
   */
  appendToAttachment(attachmentId: string, data: Uint8Array): Promise<void>;

  // ========== Attachment Read Methods ==========
  // These methods work both inside and outside of changeDoc().

  /**
   * Get all attachment references for this document.
   * 
   * @return Array of attachment references
   */
  getAttachments(): AttachmentReference[];

  /**
   * Get the full content of an attachment.
   * Fetches all chunks, verifies signatures, decrypts, and concatenates them.
   * 
   * @param attachmentId The ID of the attachment to retrieve
   * @return The complete binary data of the attachment
   * @throws Error if attachment not found or decryption fails
   */
  getAttachment(attachmentId: string): Promise<Uint8Array>;

  /**
   * Get a byte range from an attachment.
   * Only fetches and decrypts the chunks needed for the requested range.
   * Useful for random access to large files.
   * 
   * @param attachmentId The ID of the attachment
   * @param startByte The starting byte offset (inclusive, 0-based)
   * @param endByte The ending byte offset (exclusive)
   * @return The binary data for the requested range
   * @throws Error if attachment not found, range invalid, or decryption fails
   */
  getAttachmentRange(
    attachmentId: string,
    startByte: number,
    endByte: number
  ): Promise<Uint8Array>;

  /**
   * Stream attachment data starting from a given offset.
   * Returns an AsyncGenerator that yields decrypted chunks one at a time.
   * Memory-efficient for large files - only one chunk in memory at a time.
   * 
   * @param attachmentId The ID of the attachment to stream
   * @param startOffset Optional byte offset to start streaming from (default: 0)
   * @return AsyncGenerator yielding Uint8Array chunks
   * @throws Error if attachment not found
   * 
   * @example
   * // Stream from the beginning
   * for await (const chunk of doc.streamAttachment(attachmentId)) {
   *   await processChunk(chunk);
   *   if (shouldStop) break; // Early termination supported
   * }
   * 
   * // Seek to 1MB offset and stream
   * for await (const chunk of doc.streamAttachment(attachmentId, 1024 * 1024)) {
   *   await writeToOutput(chunk);
   * }
   */
  streamAttachment(
    attachmentId: string,
    startOffset?: number
  ): AsyncGenerator<Uint8Array, void, unknown>;
}

export interface MindooDocPayload {
  [key: string]: unknown;
}

export interface MindooTenantDirectory {

  /**
   * Adds a new user to the tenant. The user is identified by its user ID.
   * The registration operation is signed with the administration key (signing only, not encryption).
   * 
   * @param userId The user ID to register
   * @param administrationPrivateKey The administration private key to sign the registration operation with (signing only)
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the user is registered
   */
  registerUser(userId: PublicUserId, administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Revokes a user's access to the tenant by adding a revocation record to the directory.
   * This prevents the user from decrypting future changes, but they retain access to previously
   * decrypted changes (append-only limitation).
   * 
   * @param username The username of the user to revoke (format: "CN=<username>/O=<tenantId>")
   * @param requestDataWipe If true, the next time the user syncs the directory, the locally cached data on the user's machine will be wiped.
   * @param administrationPrivateKey The administration private key to sign the revocation (signing only)
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the user is revoked
   */
  revokeUser(username: string, requestDataWipe: boolean, administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Validates a public signing key by checking if it belongs to a trusted user in the tenant.
   * This is used for signature verification when loading changes from the append-only store.
   * 
   * @param publicKey The public signing key to validate (Ed25519, PEM format)
   * @return True if the public key belongs to a trusted (registered and not revoked) user, false otherwise
   */
  validatePublicSigningKey(publicKey: string): Promise<boolean>;

  /**
   * Get a user's public keys from the directory.
   * Used for authentication (signature verification) and encryption (transport encryption).
   * 
   * @param username The username to look up (format: "CN=<username>/O=<tenantId>")
   * @return The user's public keys, or null if user not found or has been revoked
   */
  getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null>;

  /**
   * Check if a user has been revoked.
   * 
   * @param username The username to check (format: "CN=<username>/O=<tenantId>")
   * @return True if the user has been revoked (all grant access documents have been revoked), false otherwise
   */
  isUserRevoked(username: string): Promise<boolean>;

  /**
   * Requests that a document's change history be purged from all client stores.
   * Creates a purge request record in the directory that clients will process when they
   * sync directory changes. Clients receiving this directory update will purge all
   * changes for the specified document from their local stores.
   * 
   * This is useful for GDPR compliance (right to be forgotten) and other scenarios
   * where document data must be removed from all systems.
   * 
   * @param dbId The database ID containing the document
   * @param docId The document ID whose change history should be purged
   * @param reason Optional reason for the purge request (e.g., "GDPR right to be forgotten")
   * @param administrationPrivateKey The administration private key to sign the request
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the purge request record is created
   */
  requestDocHistoryPurge(
    dbId: string,
    docId: string,
    reason: string | undefined,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Get all pending document history purge requests that clients should process.
   * Returns purge requests with verified admin signatures that clients have not yet processed.
   * 
   * Clients should call this method periodically (e.g., after directory sync) and
   * purge the requested documents from their local stores.
   * 
   * @return Array of purge request records with verified admin signatures
   */
  getRequestedDocHistoryPurges(): Promise<Array<{
    dbId: string;
    docId: string;
    reason?: string;
    requestedAt: number;
    purgeRequestDocId: string;  // ID of the purge request document in directory
  }>>;

  /**
   * Get the latest tenant-wide settings document from the directory.
   * Returns null if no settings document exists.
   * 
   * Settings are synced to all clients via the directory database.
   * 
   * @return The latest tenant settings document, or null if none exists
   */
  getTenantSettings(): Promise<MindooDoc | null>;

  /**
   * Create or update tenant-wide settings.
   * Automatically uses the cached settings document if it exists, or creates a new one.
   * 
   * Settings are signed with the administration key and synced to all clients.
   * The `form` field is automatically set to "tenantsettings" after the callback.
   * 
   * @param changeFunc Function to modify the settings document
   * @param administrationPrivateKey The administration private key to sign the settings
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the settings are updated
   */
  changeTenantSettings(
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Get the latest database-specific settings document from the directory.
   * Returns null if no settings document exists for the given database.
   * 
   * @param dbId The database ID to get settings for
   * @return The latest DB settings document, or null if none exists
   */
  getDBSettings(dbId: string): Promise<MindooDoc | null>;

  /**
   * Create or update database-specific settings.
   * Automatically uses the cached settings document for the given dbId if it exists, or creates a new one.
   * 
   * The `form` field is automatically set to "dbsettings" and `dbid` is set to the provided dbId
   * after the callback to ensure they are always correct.
   * 
   * @param dbId The database ID these settings apply to
   * @param changeFunc Function to modify the settings document
   * @param administrationPrivateKey The administration private key to sign the settings
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the settings are updated
   */
  changeDBSettings(
    dbId: string,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Get the names of all groups from the directory.
   * 
   * @return names
   */
  getGroups(): Promise<string[]>;

  /**
   * Looks up the members of a group by name.
   * 
   * @param groupName The name of the group to look up (case-insensitive, converted to lowercase)
   * @return The members of the group
   */
  getGroupMembers(groupName: string): Promise<string[]>;

  /**
   * Deletes a group. Does nothing if the group does not exist.
   * 
   * @param groupName The name of the group to delete (case-insensitive, converted to lowercase)
   * @param administrationPrivateKey The administration private key to sign the group
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the group is deleted
   */
  deleteGroup(groupName: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * For a given username, get the username, name variants (e.g. wildcards)
   * and all groups the user is currently a member of (resolved recursively).
   * For example: if the user is cn=john.doe/ou=team1/o=example.com, the result will be:
   * 
   * cn=john.doe/ou=team1/o=example.com , *\/ou=team1/o=example.com ,
   * *\/o=example.com, group1, group2
   * 
   * @param username The username to get the names list for (case-insensitive comparison)
   * @return A promise that resolves with the usernameslist
   */
  getUserNamesList(username: string): Promise<string[]>;

  /**
   * Adds users to a group. Does nothing if the users are already in the group.
   * 
   * @param groupName The name of the group to add users to (case-insensitive, converted to lowercase)
   * @param username The usernames to add to the group
   * @param administrationPrivateKey The administration private key to sign the group
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the users are added to the group
   */
  addUsersToGroup(groupName: string, username: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Removes users from a group. Does nothing if the users are not in the group.
   * 
   * @param groupName The name of the group to remove users from (case-insensitive, converted to lowercase)
   * @param username The usernames to remove from the group
   * @param administrationPrivateKey The administration private key to sign the group
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the users are removed from the group
   */
  removeUsersFromGroup(groupName: string, username: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;
}

/**
 * Cursor for incremental processing of document changes.
 * Contains both timestamp and document ID to ensure uniqueness
 * and prevent duplicate processing when multiple documents have the same timestamp.
 */
export interface ProcessChangesCursor {
  /**
   * The timestamp of the last processed change (milliseconds since Unix epoch)
   */
  lastModified: number;
  
  /**
   * The document ID of the last processed change.
   * Used to break ties when multiple documents have the same timestamp.
   */
  docId: string;
}

/**
 * Result yielded by the iterateChangesSince generator.
 * Contains both the document and its cursor position for tracking progress.
 */
export interface ProcessChangesResult {
  /**
   * The document that was processed
   */
  doc: MindooDoc;
  
  /**
   * The cursor position of this document
   */
  cursor: ProcessChangesCursor;
}

/**
 * Options for opening a database
 */
export interface OpenDBOptions extends OpenStoreOptions {
  /**
   * If true, only entries signed by the administration key will be loaded.
   * All other entries will be silently ignored.
   * This is used for the directory database to prevent recursion and ensure security.
   */
  adminOnlyDb?: boolean;
  
  /**
   * Configuration for attachment handling (chunk size, etc.)
   * If not provided, defaults are used.
   */
  attachmentConfig?: AttachmentConfig;
}

export interface MindooDB {

  /**
   * Get the tenant that this database belongs to
   *
   * @return The tenant
   */
  getTenant(): MindooTenant;

  /**
   * Check if this database is in admin-only mode.
   * In admin-only mode, only entries signed by the administration key are loaded.
   * 
   * @return True if admin-only mode is enabled
   */
  isAdminOnlyDb(): boolean;

  /**
   * Get the content-addressed store that is used to store document changes for this database.
   *
   * @return The content-addressed store for documents
   */
  getStore(): ContentAddressedStore;

  /**
   * Get the content-addressed store that is used to store attachment chunks for this database.
   * Returns undefined if no attachment store was configured.
   *
   * @return The content-addressed store for attachments, or undefined if not configured
   */
  getAttachmentStore(): ContentAddressedStore | undefined;

  /**
   * Create a new document (unencrypted, uses tenant default encryption)
   *
   * @return The new document
   */
  createDocument(): Promise<MindooDoc>;

  /**
   * Create a new document with optional encryption using a named symmetric key.
   * 
   * @param decryptionKeyId Optional key ID for encryption. If not provided, uses "default" (tenant key).
   *                        If provided, document will be encrypted with the named symmetric key.
   *                        All changes to this document will use the same key ID.
   * @return The new document
   */
  createEncryptedDocument(decryptionKeyId?: string): Promise<MindooDoc>;

  /**
   * Create a new document using a specific signing key.
   * This is like createDocument but allows signing with a different key than the current user's.
   * Used for directory operations that must be signed with the administration key.
   * 
   * @param signingKeyPair The signing key pair to use for signing the initial entry
   * @param signingKeyPassword The password to decrypt the signing private key
   * @param decryptionKeyId Optional key ID for encryption. If not provided, uses "default" (tenant key).
   * @return The new document
   */
  createDocumentWithSigningKey(
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string,
    decryptionKeyId?: string
  ): Promise<MindooDoc>;

  /**
   * Get a document by its ID
   *
   * @param docId The ID of the document
   * @return The document
   */
  getDocument(docId: string): Promise<MindooDoc>;

  /**
   * Get a document at a specific point in time by applying changes up to the given timestamp.
   * This enables historical analysis and time travel functionality.
   *
   * @param docId The ID of the document
   * @param timestamp The timestamp to reconstruct the document at (milliseconds since Unix epoch)
   * @return The document at the specified timestamp, or null if the document didn't exist at that time
   */
  getDocumentAtTimestamp(docId: string, timestamp: number): Promise<MindooDoc | null>;

  /**
   * Get all document IDs in this database.
   *
   * @return A list of document IDs
   */
  getAllDocumentIds(): Promise<string[]>;

  /**
   * Delete a document by its ID
   *
   * @param docId The ID of the document
   * @return A promise that resolves when the document is deleted
   */
  deleteDocument(docId: string): Promise<void>;

  /**
   * Delete a document using a specific signing key.
   * This is like deleteDocument but allows signing with a different key than the current user's.
   * Used for directory operations that must be signed with the administration key.
   * 
   * @param docId The ID of the document
   * @param signingKeyPair The signing key pair to use for signing the deletion
   * @param signingKeyPassword The password to decrypt the signing private key
   * @return A promise that resolves when the document is deleted
   */
  deleteDocumentWithSigningKey(
    docId: string,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void>;

  /**
   * Change a document. This internally produces a binary Automerge change
   * to the underlying Automerge document, signs it with the current user's signing key,
   * optionally encrypts it with the appropriate encryption key, and appends it to the attached AppendOnlyStore.
   * 
   * Note: Signing and encryption use different keys:
   * - Signing uses the current user's signing key (Ed25519) - proves authorship and integrity
   *   The signature is created via tenant.signPayload()
   * - Encryption uses the tenant encryption key or a named symmetric key (AES-256) - protects content
   *   Encryption/decryption is handled via tenant.encryptPayload() and tenant.decryptPayload()
   * 
   * The encryption key ID is determined from the first entry's decryptionKeyId (stored in StoreEntryMetadata).
   * If the document was created with a named key, all subsequent changes use that same key.
   * 
   * @param doc The document to change
   * @param changeFunc The function to change the document (can be async to perform operations like signing)
   * @return A promise that resolves when the document is changed
   */
  changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>
  ): Promise<void>;

  /**
   * Change a document using a specific signing key.
   * This is like changeDoc but allows signing with a different key than the current user's.
   * Used for directory operations that must be signed with the administration key.
   * 
   * @param doc The document to change
   * @param changeFunc The function to change the document (can be async)
   * @param signingKeyPair The signing key pair to use for signing the change
   * @param signingKeyPassword The password to decrypt the signing private key
   * @return A promise that resolves when the document is changed
   */
  changeDocWithSigningKey(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void>;

  /**
   * Each MindooDB maintains an internal index that tracks documents and their latest state,
   * sorted by their last modified timestamp (then by document ID for uniqueness).
   * The index is updated when documents actually change (after applying changes),
   * enabling incremental operations on the database.
   * 
   * This method uses the internal index to efficiently find and process documents that changed
   * since a given cursor, useful for incremental processing of changes.
   * Documents are returned in modification order (oldest first).
   * The callback will receive new documents, changes and deletions.
   * 
   * Deleted documents are included in the iteration so external indexes can be updated.
   * Check `doc.isDeleted()` in the callback to handle deletions appropriately.
   * 
   * The callback can return `false` to stop processing early. If the callback throws an error
   * or if there's an error processing a document, the loop will stop and the error will be propagated.
   *
   * @param cursor The cursor to start processing changes from. Use `null` or `{ lastModified: 0, docId: "" }` to start from the beginning.
   * @param limit The maximum number of changes to process (for pagination)
   * @param callback The function to call for each change. Receives the document and its cursor position. Return `false` to stop processing, or `true`/`undefined` to continue. Check `doc.isDeleted()` to handle deleted documents.
   * @return The cursor of the last change processed, can be used to continue processing from this position
   */
  processChangesSince(cursor: ProcessChangesCursor | null, limit: number, callback: (change: MindooDoc, currentCursor: ProcessChangesCursor) => boolean | void): Promise<ProcessChangesCursor>;

  /**
   * Iterate over documents that changed since a given cursor using an async generator.
   * 
   * Documents are returned in modification order (oldest first).
   * Documents are yielded one at a time, allowing early termination via `break` after each document.
   * 
   * Example usage:
   * ```typescript
   * for await (const { doc, cursor } of db.iterateChangesSince(null)) {
   *   const data = doc.getData();
   *   if (data.type === "target") {
   *     // Process document
   *     break; // Stop iteration early if needed - works after each document
   *   }
   * }
   * ```
   *
   * @param cursor The cursor to start processing changes from. Use `null` to start from the beginning.
   * @return An async generator that yields ProcessChangesResult objects containing the document and its cursor. Each document is yielded immediately after loading, enabling early termination.
   */
  iterateChangesSince(cursor: ProcessChangesCursor | null): AsyncGenerator<ProcessChangesResult, void, unknown>;

  /**
   * Sync changes from the append-only store by finding new changes and processing them.
   * This method can be called multiple times to incrementally sync new changes.
   * On first call (when processedChangeHashes is empty), it will process all changes.
   * 
   * The method uses a stored list of processed change hashes to determine which changes
   * are new. It calls AppendOnlyStore.findNewChanges() to find unprocessed changes,
   * then processes them to update the cached database documents and index.
   * After processing, the new change hashes are appended to the stored list.
   *
   * @return A promise that resolves when the sync is complete
   */
  syncStoreChanges(): Promise<void>;

  /**
   * Pull changes from a remote content-addressed store.
   *
   * @param remoteStore The remote store to pull changes from
   * @return A promise that resolves when the pull is complete
   */
  pullChangesFrom(remoteStore: ContentAddressedStore): Promise<void>;

  /**
   * Push changes to a remote content-addressed store.
   *
   * @param remoteStore The remote store to push changes to
   * @return A promise that resolves when the push is complete
   */
  pushChangesTo(remoteStore: ContentAddressedStore): Promise<void>;
}
