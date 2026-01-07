import type { KeyBag } from "./keys/KeyBag";
import type { PublicUserId, PrivateUserId } from "./userid";
import type { AppendOnlyStore } from "./appendonlystores/types";

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
   * @param currentUser The current user's private user ID (required for tenant operations)
   * @param currentUserPassword The password to decrypt the current user's private keys
   * @param keyBag The KeyBag instance for storing and loading named encrypted keys
   * @return The new tenant
   */
  createTenant(
    tenantId: string,
    administrationKeyPassword: string,
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
   * Use addNamedKey() to store the returned key in the tenant's key map.
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
   * Returns the encryption key used to encrypt all communication in this tenant
   * (e.g. the document changesets).
   * 
   * Note: This is a symmetric key (AES-256) used ONLY for encryption/decryption, not for signing.
   * 
   * @return The tenant encryption key (AES-256, encrypted)
   */
  getTenantEncryptionKey(): EncryptedPrivateKey;

  /**
   * Adds a named symmetric key to the tenant's key map.
   * This is used when a user receives a key from an administrator or colleague
   * (via email, shared folder with password protection and a password sent via secure channel).
   * 
   * The method decrypts the encrypted key and adds it to the key bag.
   * The key is then stored in the key bag and can be used to encrypt and decrypt documents.
   * 
   * @param keyId The ID of the key to add
   * @param encryptedKey The encrypted symmetric key to add
   * @param encryptedKeyPassword The password to decrypt the encrypted symmetric key (mandatory)
   * @return A promise that resolves when the key is added and persisted
   */
  addNamedKey(keyId: string, encryptedKey: EncryptedPrivateKey, encryptedKeyPassword: string): Promise<void>;

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
   * Method to open the directory for this tenant
   *
   * @return The directory
   */
  openDirectory(): Promise<MindooTenantDirectory>;

  /**
   * Opens a new database for this tenant
   *
   * @param id The ID of the database
   * @return The new database
   */
  openDB(id: string): Promise<MindooDB>;
}

// Re-export AppendOnlyStore and AppendOnlyStoreFactory from appendonlystores
export type { AppendOnlyStore, AppendOnlyStoreFactory } from "./appendonlystores/types";

/**
 * This is the meta data for changes and snapshots that we store for the document in the append only store.
 * It does not contain the actual change/snapshot payload to save space during synchronization.
 */
export interface MindooDocChangeHashes {
  /**
   * The type of this entry: 
   * - "create" for document creation
   * - "change" for document changes
   * - "snapshot" for document snapshots
   * - "delete" for document deletion (tombstone entry)
   */
  type: "create" | "change" | "snapshot" | "delete";

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
   * @param administrationPrivateKey The administration private key to sign the revocation (signing only)
   * @param administrationPrivateKeyPassword The password to decrypt the administration private key
   * @return A promise that resolves when the user is revoked
   */
  revokeUser(username: string, administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void>;

}

export interface MindooDB {

  /**
   * Get the tenant that this database belongs to
   *
   * @return The tenant
   */
  getTenant(): MindooTenant;

  /**
   * Get the append-only store that is used to store the changes for this database.
   *
   * @return The append-only store
   */
  getStore(): AppendOnlyStore;

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
   * Pull changes from a remote append-only store.
   *
   * @param remoteStore The remote append-only store to pull changes from
   * @return A promise that resolves when the pull is complete
   */
  pullChangesFrom(remoteStore: AppendOnlyStore): Promise<void>;

  /**
   * Push changes to a remote append-only store.
   *
   * @param remoteStore The remote append-only store to push changes to
   * @return A promise that resolves when the push is complete
   */
  pushChangesTo(remoteStore: AppendOnlyStore): Promise<void>;
}