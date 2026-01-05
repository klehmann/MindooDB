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
 * Map of key IDs to their encrypted symmetric keys.
 * Supports key rotation by storing multiple versions per ID.
 * Key: key ID (string)
 * Value: array of encrypted keys (newest first, or sorted by createdAt)
 */
export type NamedSymmetricKeysMap = Map<string, EncryptedPrivateKey[]>;

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

/**
 * A TenantFactory is a factory for creating and managing tenants.
 */
export interface TenantFactory {

  /**
   * Create a new tenant with a new tenant encryption key and administration key.
   * 
   * The tenant encryption key is used as the default document encryption key
   * (so that all data within the tenant is secure by default).
   * 
   * The administration key is used for administrative operations within the tenant,
   * such as adding new users to the tenant.
   *
   * @param tenantId The ID of the tenant
   * @param administrationKeyPassword The password used to encrypt the administration private key
   *                                 (this key is used to register new users and sign administrative operations)
   * @param tenantEncryptionKeyPassword The password to be set to decrypt the tenant encryption private key
   * @return The new tenant
   */
  createTenant(tenantId: string, administrationKeyPassword: string,
    tenantEncryptionKeyPassword: string): Promise<MindooTenant>;

  /**
   * Opens an existing tenant with previously created keys.
   * 
   * @param tenantId The ID of the tenant
   * @param tenantEncryptionPublicKey The tenant encryption public key identifier
   * @param tenantEncryptionPrivateKey The tenant encryption private key (AES-256, encrypted)
   * @param tenantEncryptionKeyPassword The password to decrypt the tenant encryption private key
   * @param namedSymmetricKeys Map of key IDs to encrypted symmetric keys for document encryption.
   *                          Should include "default" key (tenant encryption key).
   *                          The implementation handles persistence of this map (encrypted on disk).
   * @param administrationPublicKey Optional administration public key (Ed25519, PEM format).
   *                               Required only for users who need to perform administrative operations.
   * @param administrationPrivateKey Optional administration private key (encrypted).
   *                                 Required only for users who need to perform administrative operations.
   * @param administrationPrivateKeyPassword Optional password to decrypt the administration private key.
   *                                        Required only if administrationPrivateKey is provided.
   * @return The tenant
   */
  openTenantWithKeys(
    tenantId: string,
    tenantEncryptionPublicKey: string,
    tenantEncryptionPrivateKey: EncryptedPrivateKey,
    tenantEncryptionKeyPassword: string,
    namedSymmetricKeys: NamedSymmetricKeysMap,
    administrationPublicKey?: string,
    administrationPrivateKey?: EncryptedPrivateKey,
    administrationPrivateKeyPassword?: string
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
   * Get the ID of the tenant (UUID7 format)
   *
   * @return The ID of the tenant
   */
  getId(): string;

  /**
   * Returns the public key for the administration key used to sign administrative
   * operations like registering users (so that only the tenant admin can add users to the tenant).
   * 
   * Note: This key is used ONLY for signing, not for encryption.
   * 
   * @return The administration public key (PEM format, Ed25519)
   */
  getAdministrationPublicKey(): string;

  /**
   * Returns the private key for the administration key used to sign administrative
   * operations like registering users.
   * 
   * Note: This key is used ONLY for signing, not for encryption.
   * 
   * @param password The password to decrypt the administration private key
   * @return The administration private key (Ed25519, encrypted)
   */
  getAdministrationPrivateKey(password: string): EncryptedPrivateKey;

  /**
   * Returns the public key for the encryption key used to encrypt all communication in this tenant
   * (e.g. the document changesets).
   * 
   * Note: This is a symmetric key (AES-256), so "public key" refers to the key identifier.
   * The actual key is stored encrypted in the named symmetric keys map with ID "default".
   * 
   * @return The tenant encryption public key identifier (PEM format for compatibility)
   */
  getTenantEncryptionPublicKey(): string;

  /**
   * Returns the private key for the encryption key used to encrypt all communication in this tenant
   * (e.g. the document changesets).
   * 
   * Note: This is a symmetric key (AES-256) used ONLY for encryption/decryption, not for signing.
   * 
   * @param password The password to decrypt the tenant encryption private key
   * @return The tenant encryption private key (AES-256, encrypted)
   */
  getTenantEncryptionPrivateKey(password: string): EncryptedPrivateKey;

  /**
   * Creates a new named symmetric key for document encryption.
   * The key can be distributed via insecure channels (email, shared folder) and protected
   * with an additional password communicated via secure channels (phone, in-person).
   * 
   * @param keyId Unique identifier for this key (e.g., "project-alpha", "executive-only")
   *              Must not be "default" (reserved for tenant encryption key)
   * @param additionalPassword Optional additional password for extra protection.
   *                          If provided, the key must be decrypted with both the user's
   *                          main password AND this additional password.
   * @return The encrypted symmetric key that can be distributed to authorized users
   */
  createNamedSymmetricKey(keyId: string, additionalPassword?: string): Promise<EncryptedPrivateKey>;

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
   * @param administrationPrivateKey The administration private key to sign the revocation (signing only)
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the user is revoked
   */
  revokeUser(username: string, administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

  /**
   * Adds a named symmetric key to the tenant's key map.
   * This is used when a user receives a key from an administrator (via email, shared folder, etc.).
   * The key will be stored encrypted on disk using the user's encryption key pair.
   * 
   * After adding a key, use discoverDocumentsForKey() to find documents encrypted with this key.
   * 
   * @param keyId The ID of the key to add
   * @param encryptedKey The encrypted symmetric key to add
   * @param additionalPassword Optional additional password if the key was password-protected
   * @param userEncryptionPrivateKey The user's encryption private key (encrypted)
   * @param userEncryptionPrivateKeyPassword The password to decrypt the user's encryption private key
   * @return A promise that resolves when the key is added
   */
  addNamedSymmetricKey(
    keyId: string,
    encryptedKey: EncryptedPrivateKey,
    additionalPassword: string | undefined,
    userEncryptionPrivateKey: EncryptedPrivateKey,
    userEncryptionPrivateKeyPassword: string
  ): Promise<void>;

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
   * Convenience method to open the directory database for this tenant
   *
   * @return The directory database
   */
  openDirectoryDB(): Promise<MindooDB>;

  /**
   * Opens a new database for this tenant
   *
   * @param id The ID of the database
   * @param store The append only store to use
   * @return The new database
   */
  openDB(id: string, store: AppendOnlyStore): Promise<MindooDB>;
}

/**
 * An AppendOnlyStore is a store that is used to store signed and optionally encrypted
 * binary automerge changes to the documents in a MindooDB.
 * 
 * The AppendOnlyStore is responsible for storing the changes and providing
 * methods to get changes by their hashes, find new changes and get all change hashes.
 * 
 * The append only structure makes synchronization of changes easy between peers (client-client,
 * client-server, server-server).
 */
export interface AppendOnlyStore {

  /**
   * Append a new change to the store. No-op if we already have this
   * change in the store (based on the change ID).
   *
   * @param change The change to append
   * @return A promise that resolves when the change is appended
   */
  append(change: MindooDocChange): Promise<void>;

  /**
   * Find changes in the store that are not listed in the given list of change hashes
   *
   * @param haveChangeHashes The list of document IDs and change hashes we already have
   * @return A list of document IDs and change hashes that we don't have yet
   */
  findNewChanges(haveChangeHashes: MindooDocChangeHashes[]): Promise<MindooDocChangeHashes[]>;

  /**
   * Bulk method to get multiple changes given their hash infos
   *
   * @param changeHashes The hashes of the changes to fetch
   * @return A list of changes with payload and signature
   */
  getChanges(changeHashes: MindooDocChangeHashes[]): Promise<MindooDocChange[]>;

  /**
   * Get all change hashes that are stored in the store
   *
   * @return A list of change hashes
  */
  getAllChangeHashes(): Promise<MindooDocChangeHashes[]>;

  /**
   * Get all change hashes for a document
   *
   * @param docId The ID of the document
   * @param fromLastSnapshot Whether to start from the last snapshot (if there is any)
   * @return A list of change hashes
   */
  getAllChangeHashesForDoc(docId: string, fromLastSnapshot: boolean): Promise<MindooDocChangeHashes[]>;
}

/**
 * This is the meta data for changes and snapshots that we store for the document in the append only store.
 * It does not contain the actual change/snapshot payload to save space during synchronization.
 */
export interface MindooDocChangeHashes {
  /**
   * The type of this entry: "change" for document changes, "snapshot" for document snapshots.
   */
  type: "change" | "snapshot";

  /**
   * The ID of the document that the change is for (UUID7 format)
   *
   * Example: "123e4567-e89b-12d3-a456-426614174000"
   */
  docId: string;

  /**
   * The Automerge hash of the change
   *
   * Example: "abc112112abc"
   */
  changeHash: string;

  /**
   * The Automerge hashes of the dependencies of the change
   *
   * Example: ["defdef123123def", "ghi789789ghi"]
   */
  depsHashes: string[];

  /**
   * The timestamp of the change creation in milliseconds since the Unix epoch
   */
  createdAt: number;

  /**
   * The public signing key of the user who created this change (Ed25519, PEM format).
   * Used for signature verification and audit trails in a zero-trust system.
   * This is a cryptographic identifier that can be verified against signatures.
   */
  createdByPublicKey: string;

  /**
   * The ID of the symmetric key used to encrypt this change.
   * "default" means tenant encryption key (all tenant members can decrypt).
   * Other IDs refer to named symmetric keys (only users with that key can decrypt).
   * Always present if isEncrypted is true. If not specified, defaults to "default".
   */
  decryptionKeyId: string;

  /**
   * The signature of the change (signed with the user's signing key)
   */
  signature: Uint8Array;
}

export interface MindooDocChange extends MindooDocChangeHashes {
  /**
   * The binary payload data.
   * - For type "change": Contains the binary Automerge change
   * - For type "snapshot": Contains the binary Automerge snapshot
   */
  payload: Uint8Array;
}

/**
 * A MindooDoc is a document that is stored in the MindooDB.
 * It's a wrapper around the Automerge document.
 */
export interface MindooDoc {
  /*
   * Get the ID of the document (UUID7 format)
   *
   * @return The ID of the document
  */
  getId(): string;

  /**
   * Get the timestamp of the last modification of the document
   * in milliseconds since the Unix epoch.
   *
   * @return The timestamp of the last modification of the document
   */
  getLastModified(): number;
  
  /*
   * Get the payload of the document
   *
   * @return The payload of the document
   */
  getData(): MindooDocPayload;
}

export interface MindooDocPayload {
  [key: string]: unknown;
}

export interface MindooDB {

  /**
   * Returns the underlying append only store that is used to store the changes for this document.
   */
  getStore(): AppendOnlyStore;

  /**
   * Get the tenant that this database belongs to
   *
   * @return The tenant
   */
  getTenant(): MindooTenant;

  /**
   * Get the ID of the database
   *
   * @return The ID of the database
   */
  getId(): string;

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
   * The encryption key ID is determined from the first change's decryptionKeyId (stored in MindooDocChangeHashes).
   * If the document was created with a named key, all subsequent changes use that same key.
   * 
   * @param doc The document to change
   * @param changeFunc The function to change the document
   * @return A promise that resolves when the document is changed
   */
  changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void
  ): Promise<void>;

  /**
   * Each MindooDB maintains an internal index that tracks documents and their latest state,
   * sorted by their last modified timestamp. The index is updated when documents actually change
   * (after applying changes), enabling incremental operations on the database.
   * 
   * This method uses the internal index to efficiently find and process documents that changed
   * since a given timestamp, useful for incremental processing of changes.
   * The callback will receive new documents, changes and deletions.
   *
   * @param timestamp The timestamp to start processing changes from
   * @param limit The maximum number of changes to process (for pagination)
   * @param callback The function to call for each change
   * @return The timestamp of the last change processed, can be used to continue processing from this timestamp
   */
  processChangesSince(timestamp: number, limit: number, callback: (change: MindooDoc) => void): Promise<number>;
}