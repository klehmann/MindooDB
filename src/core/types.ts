import type { KeyBag } from "./keys/KeyBag";
import type { KeyType } from "./keys/KeyContext";
import type { PublicUserId, PrivateUserId } from "./userid";
import { StoreKind } from "./appendonlystores/types";
import type { ContentAddressedStore, OpenStoreOptions, StoreScanCursor } from "./appendonlystores/types";
import type { CryptoAdapter } from "./crypto/CryptoAdapter";
import { MindooDocSigner } from "./crypto/MindooDocSigner";

/**
 * Well-known key ID for access control documents (grantaccess, revokeaccess, groups).
 * All servers and clients MUST have this key in their KeyBag to verify user access.
 * This enables servers to validate users without having full tenant data access.
 * 
 * KeyBag location: type "doc", id PUBLIC_INFOS_KEY_ID.
 */
export const PUBLIC_INFOS_KEY_ID = "$publicinfos";

/**
 * Well-known key ID for the tenant-wide default document encryption key.
 *
 * KeyBag location: type "doc", id DEFAULT_TENANT_KEY_ID.
 */
export const DEFAULT_TENANT_KEY_ID = "default";

/**
 * JSON payload returned by `GET /.well-known/mindoodb-server-info`.
 */
export interface MindooDBServerInfo {
  /** Canonical server name, typically a Notes/Domino-style DN. */
  name: string;
  /** Ed25519 public key in PEM format used for signing/auth verification. */
  signingPublicKey: string;
  /** RSA-OAEP public key in PEM format used for encryption. */
  encryptionPublicKey: string;
  /** Configured JSON request body limit string accepted by the server, e.g. "5mb". */
  maxJsonRequestBodyLimit?: string;
  /** Parsed JSON request body limit in bytes when the configured limit is machine-readable. */
  maxJsonRequestBodyBytes?: number;
}

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
export type { KeyType };

// ==================== Tenant Options ====================

/**
 * Options for opening a tenant.
 */
export interface OpenTenantOptions {
  /**
   * Optional map of additional trusted signing public keys.
   * Keys in this map are checked BEFORE the MindooTenantDirectory when
   * validating public signing keys during signature verification.
   *
   * Use case: server-to-server sync where trusted server identities are
   * configured out-of-band (e.g. server-env.json) rather than registered
   * in the directory database.
   *
   * Map key: signing public key (Ed25519, PEM format)
   * Map value: true if trusted, false if explicitly revoked
   */
  additionalTrustedKeys?: ReadonlyMap<string, boolean>;
  /**
   * Optional pre-decrypted signing/encryption CryptoKeys for the current
   * user. When supplied, the tenant uses these directly instead of
   * decrypting the encrypted private keys with the user password on first
   * use. Typically derived once at login (see e.g.
   * {@link KeyBag.deriveWrappingKey}) and held as `extractable: false`
   * CryptoKeys for the lifetime of the session.
   *
   * When provided, the `currentUserPassword` argument to
   * {@link MindooTenantFactory.openTenant} may be empty - it will not be
   * used as long as the requested cached key is already present.
   */
  preDecryptedUserKeys?: PreDecryptedUserKeys;
}

/**
 * Pre-decrypted user CryptoKeys that callers can pass to
 * {@link MindooTenantFactory.openTenant} via {@link OpenTenantOptions}.
 *
 * Each key is independent. Whichever key is set is used directly; the
 * other is still decrypted on demand from the user password on first
 * use.
 */
export interface PreDecryptedUserKeys {
  /**
   * Pre-imported Ed25519 signing {@link CryptoKey} (`["sign"]` usage).
   * Skips the password-based decryption + import for the user's signing key.
   */
  signingKey?: CryptoKey;
  /**
   * Pre-imported RSA-OAEP encryption {@link CryptoKey} (`["decrypt"]` usage).
   * Skips the password-based decryption + import for the user's encryption key.
   */
  encryptionKey?: CryptoKey;
  /**
   * Pre-derived AES-GCM cache encryption {@link CryptoKey} (`["encrypt", "decrypt"]`
   * usage). Skips the password-based PBKDF2 derivation that the
   * `EncryptedLocalCacheStore` performs internally.
   */
  cacheEncryptionKey?: CryptoKey;
}

// ==================== Join Flow Types ====================

interface CreateTenantPasswords {
  /** Password for the admin user's private keys */
  adminPassword: string;
  /**
   * Password for the regular (app) user's private keys.
   *
   * When {@link existingKeyBag} **and** {@link preDecryptedAppUserKeys}
   * are both supplied the password is no longer needed by `createTenant`
   * (the bag has already been wrapped, and `openTenant` consumes the
   * pre-imported `CryptoKey`s directly). Callers in that live-bag mode
   * may pass an empty string.
   */
  userPassword: string;
  /**
   * Optional pre-existing {@link KeyBag} to extend with the new tenant's
   * keys. When supplied, `createTenant` will mutate this bag in place
   * (adding the new tenant's `default` and `$publicinfos` doc keys) and
   * return the same instance in {@link CreateTenantResult.keyBag}. The
   * caller is then responsible for persisting the bag once.
   *
   * When omitted, `createTenant` constructs a fresh bag using the legacy
   * password-based KeyBag wrapping derivation (existing behavior).
   */
  existingKeyBag?: KeyBag;
  /**
   * Optional pre-decrypted CryptoKeys for the *app user* identity that
   * are forwarded to the underlying {@link MindooTenantFactory.openTenant}
   * call. When supplied alongside {@link existingKeyBag} the
   * password-based decryption + import of the app user's signing /
   * encryption private keys is skipped entirely.
   */
  preDecryptedAppUserKeys?: PreDecryptedUserKeys;
}

/**
 * Options for creating a new tenant with a single convenience call.
 */
export type CreateTenantOptions =
  | ({
    /** Tenant identifier (e.g. "acme") */
    tenantId: string;
    /** Distinguished name for the admin user (e.g. "cn=admin/o=acme") */
    adminName: string;
    /** Distinguished name for the regular app user (e.g. "cn=alice/o=acme") */
    userName: string;
  } & CreateTenantPasswords)
  | ({
    /** Tenant identifier (e.g. "acme") */
    tenantId: string;
    /** Existing admin private identity */
    adminUser: PrivateUserId;
    /** Existing regular app user private identity */
    appUser: PrivateUserId;
  } & CreateTenantPasswords);

/**
 * Result of creating a new tenant via createTenant().
 *
 * When the caller provided {@link CreateTenantOptions.existingKeyBag}, the
 * returned `keyBag` is the same instance (mutated in place with the new
 * tenant's keys). Callers should not double-save in that case - persist
 * the bag once after `createTenant` returns.
 */
export interface CreateTenantResult {
  /** The opened tenant, ready to use */
  tenant: MindooTenant;
  /** The admin user's private identity (contains signing + encryption key pairs) */
  adminUser: PrivateUserId;
  /** The regular app user's private identity */
  appUser: PrivateUserId;
  /** The KeyBag containing the tenant key and tenant-scoped doc keys */
  keyBag: KeyBag;
}

/**
 * A join request is created by a new user who wants to join a tenant.
 * It contains only public information and is safe to share via any channel.
 * 
 * Can be serialized to a mdb://join-request/... URI for out-of-band exchange.
 */
export interface JoinRequest {
  /** Protocol version (always 1 for now) */
  v: 1;
  /** The username the user wants to be registered as (e.g. "cn=user2/o=acme") */
  username: string;
  /** Ed25519 public signing key (PEM format) */
  signingPublicKey: string;
  /** RSA-OAEP public encryption key (PEM format) */
  encryptionPublicKey: string;
}

/**
 * Options for approving a join request.
 */
export interface ApproveJoinRequestOptions {
  /** The admin's encrypted private signing key */
  adminSigningKey: EncryptedPrivateKey;
  /** The password to decrypt the admin signing key */
  adminPassword: string;
  /** A shared password for encrypting the exported keys. Must be communicated out-of-band (e.g. phone). */
  sharePassword: string;
  /** Optional server URL to include in the response so the joining user knows where to sync */
  serverUrl?: string;
  /** Optional admin username to include in the response so the joining user can display it */
  adminUsername?: string;
  /** If "uri", approveJoinRequest returns a mdb://join-response/... URI string instead of an object */
  format?: "object" | "uri";
}

/**
 * A join response is created by the admin after approving a join request.
 * It contains encrypted symmetric keys and tenant metadata needed to join.
 * 
 * Can be serialized to a mdb://join-response/... URI for out-of-band exchange.
 * The encrypted keys can only be unlocked with the sharePassword communicated separately.
 */
export interface JoinResponse {
  /** Protocol version (always 1 for now) */
  v: 1;
  /** Tenant identifier */
  tenantId: string;
  /** Admin's public signing key (Ed25519, PEM) — needed to open the tenant */
  adminSigningPublicKey: string;
  /** Admin's public encryption key (RSA-OAEP, PEM) — needed to open the tenant */
  adminEncryptionPublicKey: string;
  /** Optional server URL for sync */
  serverUrl?: string;
  /** Optional admin username for display purposes */
  adminUsername?: string;
  /** Tenant symmetric key, encrypted with the sharePassword */
  encryptedTenantKey: EncryptedPrivateKey;
  /** $publicinfos symmetric key, encrypted with the sharePassword */
  encryptedPublicInfosKey: EncryptedPrivateKey;
}

/**
 * Options for joining a tenant with a join response.
 */
export interface JoinTenantOptions {
  /** The user's locally-generated private identity (keys never leave this device) */
  user: PrivateUserId;
  /**
   * The password for the user's private keys.
   *
   * Required when neither {@link existingKeyBag} nor
   * {@link preDecryptedUserKeys} is supplied. When `existingKeyBag` is
   * provided the password is *not* used to construct a new KeyBag; when
   * `preDecryptedUserKeys.signingKey` and `preDecryptedUserKeys.encryptionKey`
   * are both supplied the password is *not* used to decrypt the user's
   * private keys before opening the tenant. In those live-bag cases
   * callers may pass an empty string.
   */
  password: string;
  /** The shared password used to decrypt the keys in the join response */
  sharePassword: string;
  /**
   * Optional pre-existing {@link KeyBag} to extend with the joined tenant's
   * keys. When supplied, `joinTenant` will mutate this bag in place (adding
   * the joined tenant's `default` and `$publicinfos` doc keys) and return
   * the same instance in {@link JoinTenantResult.keyBag}. The caller is
   * then responsible for persisting the bag once.
   *
   * When omitted, `joinTenant` constructs a fresh bag using the legacy
   * password-based KeyBag wrapping derivation (existing behavior).
   */
  existingKeyBag?: KeyBag;
  /**
   * Optional pre-decrypted user keys forwarded to the underlying
   * {@link MindooTenantFactory.openTenant} call. When the joining user's
   * signing/encryption {@link CryptoKey}s are already available
   * (e.g. because they were unlocked once at app startup via a live
   * Haven session) supplying them here avoids the password-based
   * decryption + import that `openTenant` would otherwise perform on
   * the encrypted private keys carried on the user identity.
   */
  preDecryptedUserKeys?: PreDecryptedUserKeys;
}

/**
 * Result of joining a tenant via joinTenant().
 *
 * When the caller provided {@link JoinTenantOptions.existingKeyBag}, the
 * returned `keyBag` is the same instance (mutated in place with the joined
 * tenant's keys). Callers should not double-save in that case - persist the
 * bag once after `joinTenant` returns.
 */
export interface JoinTenantResult {
  /** The opened tenant, ready to use */
  tenant: MindooTenant;
  /** The KeyBag containing the imported tenant and $publicinfos keys */
  keyBag: KeyBag;
}

/**
 * Options for publishing a tenant to a server.
 */
export interface PublishToServerOptions {
  /** System admin identity (PrivateUserId) for challenge/response auth. */
  systemAdminUser?: PrivateUserId;
  /** Password to decrypt systemAdminUser's private keys. */
  systemAdminPassword?: string;
  /** Optional admin username for bootstrap handshake on the server */
  adminUsername?: string;
  /** Optional users to register on the server at the same time */
  registerUsers?: PublicUserId[];
}

/**
 * A TenantFactory is a factory for creating and managing tenants.
 */
export interface MindooTenantFactory {

  /**
   * Opens an existing tenant.
   * 
   * @param tenantId The ID of the tenant
   * @param administrationPublicKey The administration public key (Ed25519, PEM format)
   * @param administrationEncryptionPublicKey The administration encryption public key (RSA-OAEP, PEM format)
   * @param currentUser The current user's private user ID (required for tenant operations)
   * @param currentUserPassword The password to decrypt the current user's private keys
   * @param keyBag The KeyBag instance for storing and loading tenant/doc keys.
   *               Must contain:
   *               - $publicinfos key under type "doc", tenant id tenantId, and id PUBLIC_INFOS_KEY_ID
   *               Optionally (required for decrypting regular database payloads):
   *               - tenant key under type "tenant" and id tenantId
   * @return The tenant
   */
  openTenant(
    tenantId: string,
    administrationPublicKey: string,
    administrationEncryptionPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
    options?: OpenTenantOptions,
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
   * Re-encrypts an identity's private keys with a new password.
   *
   * @param identity The private identity to update
   * @param oldPassword The current password
   * @param newPassword The new password to protect both private keys
   * @return A new PrivateUserId with unchanged public keys and re-encrypted private keys
   */
  changeIdentityPassword(
    identity: PrivateUserId,
    oldPassword: string,
    newPassword: string,
  ): Promise<PrivateUserId>;

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

  // ==================== Convenience Methods ====================

  /**
   * Create a new tenant with a single call. This orchestrates:
   * 1. Creating the admin user identity
   * 2. Creating the regular app user identity
   * 3. Creating a KeyBag with tenant key and $publicinfos key
   * 4. Opening the tenant
   * 5. Registering the app user in the directory
   *
   * @param options Tenant creation options
   * @return The created tenant, admin user, app user, and KeyBag
   */
  createTenant(options: CreateTenantOptions): Promise<CreateTenantResult>;

  /**
   * Create a join request from a user's private identity.
   * The join request contains only public keys and is safe to share via any channel.
   *
   * @param user The user's private identity (only public keys are extracted)
   * @param options Optional. Set format to "uri" to get a mdb://join-request/... URI string.
   * @return A JoinRequest object or a mdb://join-request/... URI string
   */
  createJoinRequest(user: PrivateUserId, options?: { format?: "object" }): JoinRequest;
  createJoinRequest(user: PrivateUserId, options: { format: "uri" }): string;
  createJoinRequest(user: PrivateUserId, options?: { format?: "object" | "uri" }): JoinRequest | string;

  /**
   * Join a tenant using a join response from an admin.
   * This orchestrates:
   * 1. Parsing the join response (object or mdb:// URI string)
   * 2. Creating a new KeyBag and importing the encrypted keys
   * 3. Opening the tenant with the admin public keys from the response
   *
   * @param joinResponse A JoinResponse object or a mdb://join-response/... URI string
   * @param options Options including the user's identity, password, and the shared password
   * @return The opened tenant and KeyBag
   */
  joinTenant(joinResponse: JoinResponse | string, options: JoinTenantOptions): Promise<JoinTenantResult>;
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
   * Replay any pending local KeyBag mutations and refresh open live
   * databases so document visibility matches the current key set.
   *
   * Implementations must be idempotent and safe to call concurrently.
   * The optional shape allows alternative tenant implementations (e.g.
   * server-side, test doubles) to omit visibility reconciliation when it
   * is not applicable.
   */
  reconcileKeyBagChanges?(): Promise<void>;

  /**
   * Return whether the current KeyBag can resolve the given document
   * encryption key id. Implementations must not throw when the key is
   * missing; they should return `false` instead so callers can use the
   * result as a guard before attempting decryption.
   */
  hasDecryptionKey?(decryptionKeyId: string): Promise<boolean>;

  /**
   * Return a stable, opaque fingerprint of the doc keys this tenant
   * currently has access to. The fingerprint must change whenever the
   * set of available doc keys changes for the tenant, and must be safe
   * to persist (no raw key material). Used by databases to skip
   * visibility reconciliation on warm starts when the KeyBag composition
   * has not changed since the last cache flush.
   */
  getDocKeyFingerprint?(): Promise<string>;

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

  // ==================== Convenience Methods ====================

  /**
   * Approve a join request and produce a join response.
   * This orchestrates:
   * 1. Parsing the join request (object or mdb:// URI string)
   * 2. Registering the user in the tenant directory
   * 3. Exporting the tenant key and $publicinfos key, encrypted with the sharePassword
   * 4. Packaging everything into a JoinResponse
   *
   * @param joinRequest A JoinRequest object or a mdb://join-request/... URI string
   * @param options Options including admin key, share password, and optional server URL
   * @return A JoinResponse object, or a mdb://join-response/... URI string if format is "uri"
   */
  approveJoinRequest(joinRequest: JoinRequest | string, options: ApproveJoinRequestOptions & { format: "uri" }): Promise<string>;
  approveJoinRequest(joinRequest: JoinRequest | string, options: ApproveJoinRequestOptions): Promise<JoinResponse>;

  /**
   * Publish (register) this tenant on a MindooDB server.
   * Sends an HTTP POST to the server's /admin/register-tenant endpoint
   * with the admin public keys and optional initial users.
   *
   * @param serverUrl The base URL of the MindooDB server (e.g. "http://localhost:3000")
   * @param options Optional API key and users to register
   */
  publishToServer(serverUrl: string, options?: PublishToServerOptions): Promise<void>;

  /**
   * Create a remote store connected to a MindooDB server, ready for sync.
   * This orchestrates:
   * 1. Creating an HttpTransport pointed at the server
   * 2. Creating a ClientNetworkContentAddressedStore with the current user's keys
   * 3. Returning the store for use with pullChangesFrom/pushChangesTo
   *
   * @param serverUrl The base URL of the MindooDB server (e.g. "http://localhost:3000")
   * @param dbId The database ID to connect to (e.g. "todos")
   * @param storeKind The store kind to connect to (e.g. StoreKind.docs or StoreKind.attachments)
   * @return A ContentAddressedStore connected to the remote server
   */
  connectToServer(serverUrl: string, dbId: string, storeKind?: StoreKind): Promise<ContentAddressedStore>;
}

// Re-export ContentAddressedStore and ContentAddressedStoreFactory from appendonlystores
export type {
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreCompactionStatus,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  AttachmentReadPlanOptions,
  AttachmentReadPlanChunk,
  AttachmentReadPlan,
  MaterializationPlanOptions,
  MaterializationPlanDiagnostics,
  DocumentMaterializationPlan,
  DocumentMaterializationBatchPlan,
} from "./appendonlystores/types";

export { StoreKind } from "./appendonlystores/types";

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
  | "doc_undelete"    // Document undeletion (lifecycle entry)
  | "pending_attachment_upload" // Local recovery ledger for incomplete attachment uploads
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
   * Optional causal coverage heads for snapshot entries.
   * For `doc_snapshot`, this lists the Automerge head hashes represented by the snapshot.
   * For other entry types this should be undefined.
   */
  snapshotHeadHashes?: string[];

  /**
   * Optional entry IDs corresponding to the snapshot heads.
   * This allows stores to plan replay using metadata only, without decrypting payloads.
   * For non-snapshot entries this should be undefined.
   */
  snapshotHeadEntryIds?: string[];

  /**
   * The timestamp when this entry was created (milliseconds since Unix epoch).
   */
  createdAt: number;

  /**
   * Monotonic store-local insertion order assigned when the entry becomes
   * visible in a specific replica.
   *
   * This is distinct from `createdAt`:
   * - `createdAt` captures author/origin time and is stable across replicas
   * - `receiptOrder` captures local receipt/persistence order and may differ
   *   between replicas
   *
   * Stores may omit this on pre-migration metadata, but `scanEntriesSince()`
   * must only return cursors built from entries that have a concrete value.
   */
  receiptOrder?: number;

  /**
   * Attachment id associated with attachment chunks or pending upload ledgers.
   * For historical safety, cleanup only acts on pending upload ledgers that
   * prove an attachment never reached a committed document revision.
   */
  attachmentId?: string;

  /**
   * Attachment ids committed by this document entry. Used by local recovery to
   * distinguish never-committed uploads from attachments required by history.
   */
  attachmentIds?: string[];

  /**
   * Start timestamp for `pending_attachment_upload` recovery ledgers.
   */
  uploadStartedAt?: number;

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
   * - For doc_create/doc_change/doc_delete/doc_undelete: Encrypted Automerge change bytes
   * - For doc_snapshot: Encrypted Automerge snapshot bytes
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

export interface IncompleteAttachmentUploadReclaimResult {
  scannedLedgers: number;
  reclaimedUploads: number;
  reclaimedChunks: number;
  keptCommittedUploads: number;
  keptRecentUploads: number;
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
 * Configuration for the in-memory document cache.
 */
export interface DocumentCacheConfig {
  /**
   * Maximum number of fully materialized documents kept in memory at once.
   * Dirty documents remain pinned until cache state has been flushed.
   * Default: 128
   */
  maxEntries?: number;

  /**
   * Number of upcoming documents to prefetch during changefeed iteration.
   * Set to 0 to disable eager iteration prefetch.
   * Default: 0
   */
  iteratePrefetchWindowDocs?: number;

  /**
   * Maximum number of documents restored from the local cache store during
   * startup.  Prevents large cache checkpoints from rehydrating every
   * document into memory immediately.
   * Default: same as `maxEntries`
   */
  restoreLimit?: number;

  /**
   * Number of cached documents fetched per batch during the eager
   * startup restore (`restoreFromCache`). Each batch issues a single
   * `LocalCacheStore.getMany` call, so this knob trades transaction
   * overhead for transient memory pressure:
   *
   * - smaller values (e.g. 32-64) reduce peak memory at the cost of
   *   more cache-store transactions; sensible on memory-constrained
   *   targets (mobile, RN) or with very large average doc bodies (e.g.
   *   attachments-as-documents),
   * - larger values (e.g. 512-1024) amortise per-transaction overhead
   *   but hold more encrypted+decrypted byte buffers in memory at the
   *   same time.
   *
   * Has no effect when `restoreToL2` is `true` (no eager fill happens).
   * Has no effect on lazy L2 reads (`tryLoadFromL2`) or on the
   * background warmer, both of which load one document at a time.
   *
   * Default: 256 (~25 MB transient peak per batch at 50 KB/doc).
   */
  restoreBatchSize?: number;

  /**
   * When enabled, verifies after cache restore that the restored document
   * index still matches the underlying local store and rebuilds metadata if a
   * stale checkpoint is detected. Intended for troubleshooting sync/cache
   * inconsistencies because it adds an extra metadata scan during startup.
   * Default: false
   */
  reconcileRestoredIndexOnInit?: boolean;

  /**
   * When `true`, the persisted document cache is treated as the L2 tier
   * of an L1/L2 cache split: startup does **not** eagerly materialize
   * any cached documents into the in-memory L1 cache. Instead, the L2
   * payloads stay on disk and individual `getDocument()` calls pull
   * them in lazily via the L2 read path (which compares the persisted
   * `changeSeq + automergeHeads` against the live index, applies
   * deltas if stale, and then promotes to L1).
   *
   * This unlocks the "L2 much larger than L1" use case (e.g. 30k docs
   * persisted, 128 in RAM) without burning startup time and memory on
   * documents the user may never read.
   *
   * When `false` (the default), startup behavior is unchanged: cached
   * documents are eagerly loaded into L1 up to `restoreLimit`. Even in
   * eager mode the restore now uses the new batched `getMany` API to
   * amortize per-key transaction overhead.
   */
  restoreToL2?: boolean;

  /**
   * Tuning for the optional background L2 warmer.
   *
   * The warmer is started explicitly via `startBackgroundWarmer()` and
   * walks the in-memory document index, ensuring every doc has an
   * up-to-date L2 cache record (using the same `tryLoadFromL2` path
   * foreground reads use). It yields to the host runtime between
   * batches so it does not starve other work.
   */
  warmer?: DocumentCacheWarmerConfig;
}

/**
 * Cooperative scheduler used by the L2 background warmer to yield
 * between batches so it does not monopolize the event loop.
 *
 * The default implementation uses `setTimeout(0)` which works in both
 * Node and browsers. Embedders can plug in custom schedulers (e.g. one
 * that yields via `requestIdleCallback` in the browser, or that
 * coalesces yields with their own task queue).
 */
export interface WarmerScheduler {
  /**
   * Yield control back to the host runtime. The warmer will resume
   * processing once the returned promise resolves.
   */
  yield(): Promise<void>;
}

/**
 * Tuning options for the background L2 warmer.
 */
export interface DocumentCacheWarmerConfig {
  /**
   * Number of documents to process between scheduler yields. Smaller
   * values yield more often (better responsiveness on the foreground
   * thread, slightly higher per-doc overhead). Larger values run faster
   * but block the event loop in larger bursts.
   * Default: 50
   */
  batchSize?: number;

  /**
   * Custom scheduler implementation. Defaults to a `setTimeout(0)`-based
   * scheduler that works in any JavaScript runtime.
   */
  scheduler?: WarmerScheduler;
}

/**
 * Lifecycle phases for a background L2 warmer pass.
 *
 * - `warming`  - the warmer is actively processing documents; `processed`
 *                will continue to grow until it reaches `total`.
 * - `done`     - the warmer reached the end of its document snapshot; the
 *                pass terminated successfully.
 * - `cancelled`- the warmer observed an abort signal mid-pass and exited
 *                early. `processed` reflects how far it got; the
 *                remaining `total - processed` documents were not warmed.
 */
export type BackgroundWarmerPhase = "warming" | "done" | "cancelled";

/**
 * Snapshot of a background L2 warmer pass, suitable for driving a
 * progress UI.
 *
 * `total` is captured once at the start of the pass (a snapshot of
 * `index.length`); concurrent doc creations during the pass do not
 * grow `total` so the bar can advance monotonically toward 100%.
 *
 * `processed` includes both docs that were warmed (an L2 record was
 * read or refreshed) and docs that were skipped because they were
 * already hot in L1 - in both cases the warmer is "done" with that doc.
 */
export interface BackgroundWarmerProgress {
  /** Number of docs the warmer has finished visiting in this pass. */
  processed: number;
  /** Total docs the warmer intends to visit in this pass. */
  total: number;
  /** Lifecycle phase. See {@link BackgroundWarmerPhase}. */
  phase: BackgroundWarmerPhase;
}

/**
 * Options accepted by {@link MindooDB.startBackgroundWarmer}.
 */
export interface StartBackgroundWarmerOptions {
  /**
   * Optional `AbortSignal` that the caller can use to cancel this
   * warmer pass without affecting any other in-flight passes.
   * Aborting via the signal has the same effect as calling
   * {@link MindooDB.stopBackgroundWarmer}.
   *
   * Note: warmer single-flight semantics mean that if a warmer is
   * already running when `startBackgroundWarmer` is called, the
   * existing in-flight promise is returned and the new `signal` is
   * NOT honored (since the existing pass owns its own internal
   * cancellation lifecycle). Callers that need precise cancellation
   * control should call {@link MindooDB.stopBackgroundWarmer} first.
   */
  signal?: AbortSignal;

  /**
   * Optional progress callback invoked by the warmer once per
   * scheduler-yield batch (i.e. roughly every
   * `DocumentCacheWarmerConfig.batchSize` documents) and once more
   * with `phase: "done"` or `phase: "cancelled"` when the pass
   * settles.
   *
   * Designed for driving a progress bar / "Warming…" UI affordance.
   * Per-doc invocation is intentionally avoided so the callback
   * doesn't add measurable overhead even on warmers that walk
   * 30,000+ documents.
   *
   * Errors thrown from this callback are caught and logged so a buggy
   * progress consumer cannot break the warmer.
   */
  onProgress?: (progress: BackgroundWarmerProgress) => void;
}

/**
 * Configuration for automatic snapshot creation.
 */
export interface SnapshotConfig {
  /**
   * Minimum number of replay entries since the latest snapshot before a new
   * snapshot is considered.
   * Default: 100
   */
  minChanges?: number;

  /**
   * Minimum time between snapshot writes for the same document.
   * Default: 10 minutes
   */
  cooldownMs?: number;
}

/**
 * Regex used to validate caller-provided MindooDoc IDs.
 *
 * The first character must be an ASCII letter; subsequent characters may be
 * ASCII letters, ASCII digits, or `_`. This keeps caller-provided IDs safe to
 * use unmodified in content-addressed store entry IDs and on disk.
 */
export const CUSTOM_DOC_ID_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Options accepted by `MindooDB.createDocument()`.
 */
export interface CreateOptions {
  /**
   * Caller-provided document ID. When provided it must match
   * `^[A-Za-z][A-Za-z0-9_]*$` (see `CUSTOM_DOC_ID_REGEX`). When omitted, a fresh
   * UUID7 is generated.
   *
   * If a document with this ID already exists locally, `createDocument()`
   * returns the existing document (idempotent create). For independent replicas
   * to converge on the same custom ID, MindooDB seeds custom-ID documents with
   * a hard-coded initial Automerge change so they share Automerge ancestry.
   */
  id?: string;

  /**
   * Symmetric encryption key ID to use for this document. Defaults to `"default"`
   * (the tenant key). Replaces `createEncryptedDocument(decryptionKeyId)`.
   */
  decryptionKeyId?: string;

  /**
   * Optional signing key pair to sign the initial document entry with. When
   * provided, `signingKeyPassword` must be provided as well. Replaces
   * `createDocumentWithSigningKey(signingKeyPair, signingKeyPassword, ...)`.
   */
  signingKeyPair?: SigningKeyPair;

  /**
   * Password used to decrypt the private key of `signingKeyPair`. Required when
   * `signingKeyPair` is provided.
   */
  signingKeyPassword?: string;
}

/**
 * Options accepted by `MindooDB.deleteDocument()`.
 */
export interface DeleteOptions {
  /**
   * Optional signing key pair to sign the delete lifecycle entry with. When
   * provided, `signingKeyPassword` must be provided as well. Replaces
   * `deleteDocumentWithSigningKey(signingKeyPair, signingKeyPassword)`.
   */
  signingKeyPair?: SigningKeyPair;

  /**
   * Password used to decrypt the private key of `signingKeyPair`. Required when
   * `signingKeyPair` is provided.
   */
  signingKeyPassword?: string;
}

/**
 * Options accepted by `MindooDB.undeleteDocument()`.
 */
export interface UndeleteOptions {
  /**
   * Optional signing key pair to sign the undelete lifecycle entry with. When
   * provided, `signingKeyPassword` must be provided as well.
   */
  signingKeyPair?: SigningKeyPair;

  /**
   * Password used to decrypt the private key of `signingKeyPair`. Required when
   * `signingKeyPair` is provided.
   */
  signingKeyPassword?: string;
}

/**
 * Options accepted by `MindooDB.changeDoc()`.
 */
export interface ChangeOptions {
  /**
   * Optional signing key pair to sign the document change entry with. When
   * provided, `signingKeyPassword` must be provided as well. Replaces
   * `changeDocWithSigningKey(doc, changeFunc, signingKeyPair, signingKeyPassword)`.
   */
  signingKeyPair?: SigningKeyPair;

  /**
   * Password used to decrypt the private key of `signingKeyPair`. Required when
   * `signingKeyPair` is provided.
   */
  signingKeyPassword?: string;
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
   * Get the decryption key ID used for this document.
   *
   * @return The key ID ("default" or a named key ID)
   */
  getDecryptionKeyId(): string;
  
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

  /**
   * Get the current Automerge heads for this document.
   *
   * These heads are a causal token that callers can pass back with granular
   * text edits so MindooDB can apply stale editor operations at their original
   * base version and then merge them with newer document changes.
   */
  getHeads(): string[];

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

/** Plain JSON-compatible document payload materialized from a MindooDoc. */
export interface MindooDocPayload {
  [key: string]: unknown;
}

/**
 * Single text splice applied to the string at a text patch path.
 *
 * `index` is a character offset in the current text value, `deleteCount`
 * removes characters from that offset, and `insert` adds replacement text.
 */
export interface MindooTextEdit {
  index: number;
  deleteCount: number;
  insert?: string;
}

/**
 * Ordered text edits for one string field in a MindooDoc.
 *
 * `path` addresses the target string inside the document payload. When
 * supplied, `baseHeads` identifies the Automerge heads the caller based the
 * edit on, allowing the backend to apply order-sensitive text changes in the
 * intended causal context.
 */
export interface MindooTextPatch {
  path: Array<string | number>;
  baseHeads?: string[];
  edits: MindooTextEdit[];
}

/** Result returned after applying a text patch and materializing the document. */
export interface MindooTextPatchResult {
  doc: MindooDoc;
  heads: string[];
  data: MindooDocPayload;
}

/** Sets a value at `path`, creating or replacing that payload field. */
export interface MindooJsonSetPatch {
  path: Array<string | number>;
  value: unknown;
}

/** Removes the value at `path` from the payload object or list. */
export interface MindooJsonUnsetPatch {
  path: Array<string | number>;
}

/** Inserts one or more values into the list located at `path`. */
export interface MindooJsonListInsertPatch {
  path: Array<string | number>;
  index: number;
  values: unknown[];
}

/** Deletes one or more values from the list located at `path`. */
export interface MindooJsonListDeletePatch {
  path: Array<string | number>;
  index: number;
  deleteCount: number;
}

/**
 * Granular JSON mutation batch for a MindooDoc payload.
 *
 * Operations are applied in patch order by operation group. `baseHeads` has the
 * same role as in text patches: it records the document heads the caller saw
 * before constructing operations whose order matters, such as list inserts.
 */
export interface MindooJsonPatch {
  baseHeads?: string[];
  set?: MindooJsonSetPatch[];
  unset?: MindooJsonUnsetPatch[];
  listInsert?: MindooJsonListInsertPatch[];
  listDelete?: MindooJsonListDeletePatch[];
}

/** Result returned after applying a JSON patch and materializing the document. */
export interface MindooJsonPatchResult {
  doc: MindooDoc;
  heads: string[];
  data: MindooDocPayload;
}

export interface DirectoryUserDetails {
  [key: string]: string;
}

export interface DirectoryUserLookup {
  username: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  details: DirectoryUserDetails | null;
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
    administrationPrivateKeyPassword: string,
    userDetails?: DirectoryUserDetails,
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
    details?: DirectoryUserDetails | null;
  } | null>;

  /**
   * Look up a user by their public signing key.
   * This is useful for reverse-resolving historical change authors to friendly labels.
   *
   * @param publicKey The public signing key to look up (Ed25519, PEM format)
   * @return The matching user record, or null if no registration is known
   */
  getUserBySigningPublicKey(publicKey: string): Promise<DirectoryUserLookup | null>;

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
   * Returns the database IDs currently known to the directory.
   *
   * This is intended for admin tooling and overview UIs. The result always includes
   * `"directory"` and will also include `"main"` as the conventional default app DB.
   * Additional DBs are discovered from `dbsettings` documents stored in the directory.
   */
  listKnownDBIds(): Promise<string[]>;

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
  /**
   * Get the decrypted member names for a group.
   * Entries that cannot be decrypted are skipped so callers can still work with
   * the readable subset of the group.
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
   * Monotonic changefeed sequence number assigned by BaseMindooDB.
   * This is the primary cursor field for deterministic, gap-free iteration.
   */
  changeSeq?: number;
  /**
   * The timestamp of the last processed change (milliseconds since Unix epoch)
   * Legacy compatibility field. New code should use `changeSeq`.
   */
  lastModified: number;
  
  /**
   * The document ID of the last processed change.
   * Used to break ties when multiple documents have the same timestamp.
   * Legacy compatibility field. New code should use `changeSeq`.
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
 * Result yielded by the metadata-only latest-state iterator.
 * Contains the latest known index metadata without materializing the document.
 */
export interface ProcessChangeSummaryResult {
  /**
   * The document ID that changed.
   */
  docId: string;

  /**
   * Latest user-visible modification timestamp for the document.
   */
  lastModified: number;

  /**
   * Whether the latest known state is deleted.
   */
  isDeleted: boolean;

  /**
   * The cursor position of this document in the deterministic changefeed.
   */
  cursor: ProcessChangesCursor;
}

/**
 * Result yielded by the iterateDocumentHistory generator.
 */
export interface DocumentHistoryResult {
  /**
   * Persisted DAG entry id for the change that produced this materialized state.
   * Stable across restarts while the backing store entry exists.
   */
  changeEntryId: string;

  /**
   * The document state after applying this change.
   * Each document is an independent clone, safe to store in arrays.
   */
  doc: MindooDoc;
  
  /**
   * The timestamp when this change was created (milliseconds since Unix epoch).
   */
  changeCreatedAt: number;
  
  /**
   * The public signing key of the user who created this change (Ed25519, PEM format).
   */
  changeCreatedByPublicKey: string;
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
   * Optional read-only historical cutoff for opening the database.
   *
   * When set, entries with createdAt >= timeTravelDate are ignored. The
   * normalized value maps to store-level creationDateUntil semantics.
   */
  timeTravelDate?: number | Date | string;
  
  /**
   * Configuration for attachment handling (chunk size, etc.)
   * If not provided, defaults are used.
   */
  attachmentConfig?: AttachmentConfig;

  /**
   * Configuration for the in-memory materialized document cache.
   */
  documentCacheConfig?: DocumentCacheConfig;

  /**
   * Configuration for automatic snapshot creation.
   */
  snapshotConfig?: SnapshotConfig;

  /**
   * Optional performance callback for profiling hot paths.
   */
  performanceCallback?: PerformanceCallback;
}

/**
 * Optional performance callback interface for tracking operation timing.
 * Used for profiling and performance analysis.
 */
export interface PerformanceCallback {
  /**
   * Called when a document is loaded, with timing breakdown.
   */
  onDocumentLoad?: (metrics: {
    docId: string;
    cacheHit: boolean;
    metadataEntriesScanned: number;
    replayEntriesLoaded: number;
    snapshotUsed: boolean;
    cacheCheckTime: number;
    storeQueryTime: number;
    entryLoadTime: number;
    signatureVerificationTime: number;
    decryptionTime: number;
    automergeTime: number;
    totalTime: number;
  }) => void;

  /**
   * Called when the index is updated.
   */
  onIndexUpdate?: (metrics: {
    docId: string;
    operation: 'insert' | 'update' | 'remove';
    time: number;
  }) => void;

  /**
   * Called during sync operations.
   */
  onSyncOperation?: (metrics: {
    operation:
      | 'findNewEntries'
      | 'processDocument'
      | 'updateIndex'
      | 'iterateChangesSince'
      | 'iterateChangeMetadataSince'
      | 'planDocumentMaterialization'
      | 'planDocumentMaterializationBatch'
      | 'bloomRebuild';
    time: number;
    details?: Record<string, any>;
  }) => void;

  /**
   * Called for bounded history/time-travel workflows.
   */
  onHistoryOperation?: (metrics: {
    operation:
      | 'getDocumentAtTimestamp'
      | 'getDocumentHistoryPage'
      | 'analyzeDocumentDagAtTimestamp'
      | 'materializeDocumentBranchAtEntry'
      | 'materializeDocumentBranchAtTimestamp'
      | 'describeDocumentDagEntry'
      | 'analyzeDocumentConflicts'
      | 'getDocumentConflictReport'
      | 'getDocumentConflictBaseValues';
    docId: string;
    time: number;
    scannedEntries: number;
    returnedEntries?: number;
    bounded?: boolean;
  }) => void;
}

/**
 * Cursor for paged history metadata access.
 */
export interface DocumentHistoryPageCursor {
  offset: number;
}

/**
 * One history entry in a bounded history page.
 */
export interface DocumentHistoryPageEntry {
  entryId: string;
  entryType: StoreEntryType;
  changeCreatedAt: number;
  changeCreatedByPublicKey: string;
  dependencyIds: string[];
  isDeleted: boolean;
}

/**
 * Options for bounded history metadata access.
 */
export interface DocumentHistoryPageOptions {
  cursor?: DocumentHistoryPageCursor | null;
  limit?: number;
}

/**
 * Page result for bounded history metadata access.
 */
export interface DocumentHistoryPageResult {
  entries: DocumentHistoryPageEntry[];
  nextCursor: DocumentHistoryPageCursor | null;
  hasMore: boolean;
}

/**
 * Timestamp input for DAG analysis APIs.
 */
export type DocumentDagAnalysisTimestamp = number | "now";

/**
 * Lightweight summary of one decoded Automerge operation.
 */
export interface DocumentDagChangeOperationSummary {
  action: string;
  key?: string | null;
  obj?: string | null;
  insert?: boolean;
  valuePreview?: string | null;
}

/**
 * Decoded change details for a single DAG entry.
 */
export interface DocumentDagDecodedChangeSummary {
  actorId: string | null;
  hash: string | null;
  seq: number | null;
  message: string | null;
  dependencyHashes: string[];
  opCount: number;
  actionCounts: Record<string, number>;
  touchedKeys: string[];
  touchedPaths: string[];
  operations: DocumentDagChangeOperationSummary[];
}

/**
 * One node in the document DAG explorer.
 */
export interface DocumentDagEntrySummary {
  entryId: string;
  entryType: StoreEntryType;
  createdAt: number;
  createdByPublicKey: string;
  automergeActorId: string | null;
  dependencyIds: string[];
  childEntryIds: string[];
  snapshotHeadEntryIds: string[];
  snapshotHeadHashes: string[];
  automergeHash: string | null;
  isActiveHead: boolean;
  isDeleted: boolean;
  isUndelete: boolean;
  liveStateAfter: "alive" | "deleted";
  branchHeadEntryIds: string[];
  graphLaneIds: string[];
  primaryGraphLaneId: string | null;
  isMergePoint: boolean;
  isForkPoint: boolean;
}

/**
 * Summary of the ancestor closure for one active head.
 */
export interface DocumentDagBranchSummary {
  headEntryId: string;
  headCreatedAt: number;
  headCreatedByPublicKey: string;
  ancestorEntryIds: string[];
  compatibleSnapshotEntryId: string | null;
  compatibleSnapshotCreatedAt: number | null;
  isDeleted: boolean;
}

/**
 * Metadata-only DAG analysis result for one document at a point in time.
 */
export interface DocumentDagAnalysisResult {
  docId: string;
  timestamp: number;
  activeHeadEntryIds: string[];
  graphLaneIds: string[];
  entries: DocumentDagEntrySummary[];
  branches: DocumentDagBranchSummary[];
}

/**
 * Lazy, per-entry details for hover/tooling in DAG explorers.
 */
export interface DocumentDagEntryDetails {
  docId: string;
  entryId: string;
  entryType: StoreEntryType;
  createdAt: number;
  createdByPublicKey: string;
  dependencyIds: string[];
  snapshotHeadEntryIds: string[];
  snapshotHeadHashes: string[];
  automergeHash: string | null;
  decodedChange: DocumentDagDecodedChangeSummary | null;
}

/**
 * Conflict analysis mode controls how much history the analyzer traverses.
 */
export type DocumentConflictAnalysisMode = "quick" | "full";

/**
 * Conflict detail level controls whether conflicting values are summarized.
 */
export type DocumentConflictDetailLevel = "paths-only" | "values";

/**
 * JSON-safe path segment returned by conflict analysis.
 */
export type DocumentConflictPathSegment = string | number;

/**
 * JSON-safe value summary for one conflicting value.
 *
 * `value` is included only when it can be represented safely without exposing
 * CRDT-specific objects. `preview` is always intended for compact UI display.
 */
export interface DocumentConflictValueSummary {
  conflictId: string;
  preview: string | null;
  value?: unknown;
  isWinner: boolean;
}

/**
 * One conflicted document path detected during analysis.
 */
export interface DocumentConflictPath {
  path: DocumentConflictPathSegment[];
  pathString: string;
  values?: DocumentConflictValueSummary[];
}

/**
 * Describes where in the document DAG a conflict observation was made.
 */
export interface DocumentConflictLocation {
  kind: "entry-after" | "active-heads" | "merge-deps";
  entryId?: string;
  createdAt?: number;
  receiptOrder?: number;
  createdByPublicKey?: string;
  headEntryIds: string[];
  automergeHeads: string[];
}

/**
 * Conflict observation or resolution event for one document.
 */
export interface DocumentConflictSummary {
  docId: string;
  location: DocumentConflictLocation;
  paths: DocumentConflictPath[];
}

/**
 * Durable cursor for incremental conflict scans.
 *
 * `changeSeqAsOf` is used for cheap document-level pre-filtering through the
 * document index. `storeReceiptOrderAsOf` is used for per-event filtering so
 * late-arriving sync entries are surfaced even if their author timestamp is old.
 */
export interface ConflictScanCheckpoint {
  changeSeqAsOf: number;
  storeReceiptOrderAsOf?: number;
  takenAt: number;
}

/**
 * Options accepted by conflict analysis APIs.
 */
export interface DocumentConflictAnalysisOptions {
  mode?: DocumentConflictAnalysisMode;
  detail?: DocumentConflictDetailLevel;
  pageSize?: number;
  yieldEveryMs?: number;
  maxConflictsPerDoc?: number;
  since?: ConflictScanCheckpoint;
  includeUnresolvedFromBefore?: boolean;
  signal?: AbortSignal;
}

/**
 * Options accepted by the convenience report API.
 */
export interface DocumentConflictReportOptions extends Omit<DocumentConflictAnalysisOptions, "mode" | "maxConflictsPerDoc"> {
}

/**
 * Streaming event emitted by `analyzeDocumentConflicts()`.
 */
export type DocumentConflictAnalysisEvent =
  | {
      type: "progress";
      scannedDocs: number;
      totalDocs: number;
      docId?: string;
      scannedEntries?: number;
      message: string;
    }
  | {
      type: "docStart";
      docId: string;
    }
  | {
      type: "conflictDetected";
      conflict: DocumentConflictSummary;
      quick: boolean;
    }
  | {
      type: "conflictResolved";
      docId: string;
      entryId: string;
      createdAt: number;
      receiptOrder?: number;
      createdByPublicKey: string;
      path: DocumentConflictPath;
      automergeHash: string | null;
    }
  | {
      type: "docDone";
      docId: string;
      hadConflicts: boolean;
      conflictsFound: number;
      entriesScanned: number;
    }
  | {
      type: "error";
      docId?: string;
      entryId?: string;
      error: unknown;
    }
  | {
      type: "scanCheckpoint";
      checkpoint: ConflictScanCheckpoint;
    };

/**
 * Full conflict report for one document.
 */
export interface DocumentConflictReport {
  docId: string;
  hadConflicts: boolean;
  conflictsFound: number;
  conflicts: DocumentConflictSummary[];
  resolutions: Array<Extract<DocumentConflictAnalysisEvent, { type: "conflictResolved" }>>;
  entriesScanned: number;
  errors: Array<Extract<DocumentConflictAnalysisEvent, { type: "error" }>>;
  scanCheckpoint: ConflictScanCheckpoint | null;
}

/**
 * Request to look up the value at a conflicted path as it stood at the merge
 * base of the contributing branches (the "old" value before the conflict).
 */
export interface DocumentConflictBaseValueQuery {
  /** Conflict location as returned by `getDocumentConflictReport`. */
  location: DocumentConflictLocation;
  /** Structured path segments (matches `DocumentConflictPath.path`). */
  path: DocumentConflictPathSegment[];
  /** Stable string key (matches `DocumentConflictPath.pathString`). */
  pathString: string;
}

/**
 * Result for one base-value lookup.
 *
 * - `available`: a previous value existed at the merge base; `preview` and
 *   `value` are populated.
 * - `no-prior-value`: a merge base was found but the path did not exist there
 *   (e.g. both branches independently created the field).
 * - `no-base`: no shared ancestor could be determined for the contributing
 *   heads (e.g. the conflict has only one head, or the parent set is empty).
 * - `missing-entry`: the conflict's `entryId` is not (or no longer) in the
 *   local store; the base value cannot be resolved.
 */
export interface DocumentConflictBaseValue {
  pathString: string;
  baseEntryId: string | null;
  status: "available" | "no-prior-value" | "no-base" | "missing-entry";
  preview: string | null;
  value?: unknown;
}

/**
 * Result of reconstructing one branch-local document state for a selected DAG head.
 */
export interface DocumentDagBranchMaterializationResult {
  docId: string;
  headEntryId: string;
  headCreatedAt: number;
  headCreatedByPublicKey: string;
  snapshotEntryId: string | null;
  entryIdsApplied: string[];
  branchEntryIds: string[];
  doc: MindooDoc;
}

/**
 * Progress information emitted during pull/push sync operations.
 */
export interface SyncProgress {
  /** Current lifecycle stage of the sync operation. */
  phase: 'preparing' | 'planning' | 'transferring' | 'processing' | 'complete';
  /** Human-readable status description suitable for display in a UI. */
  message: string;
  /** Cumulative number of entries successfully written to the target store so far. */
  transferredEntries: number;
  /** Cumulative number of source entries whose metadata has been examined. */
  scannedEntries: number;
  /** Estimated total entry count on the source, when known (e.g. from a bloom summary). */
  totalSourceEntries?: number;
  /** 1-based index of the current metadata scan page (set during cursor-based scanning). */
  currentPage?: number;
  /** 1-based index of the current transfer batch within the active scan page or legacy transfer. */
  currentTransferBatch?: number;
  /** Total number of transfer batches planned for the current set of missing IDs. */
  totalTransferBatches?: number;
  /** Number of entry IDs fetched per `getEntries` call in this transfer run. */
  transferBatchSize?: number;
}

/**
 * Sync mode controls how much data is transferred between stores.
 *
 * - `"full"` (default) transfers every entry the target is missing.
 * - `"dense"` uses the batch materialization planner to transfer only the
 *   entries needed to reconstruct the latest state of each document (best
 *   snapshot + uncovered changes + lifecycle bookkeeping).  Historical
 *   entries superseded by a snapshot are skipped, and attachment chunks are
 *   deferred.
 */
export type SyncMode = "full" | "dense";

/**
 * Options for pull/push sync operations.
 */
export interface SyncOptions {
  onProgress?: (progress: SyncProgress) => void;
  pageSize?: number;
  transferBatchSize?: number;
  signal?: AbortSignal;
  storeKind?: StoreKind;
  /**
   * Optional network auth override for this sync call.
   *
   * Useful for bootstrap scenarios where a specific user identity (for example
   * an admin identity) must be used for the challenge/response handshake.
   */
  networkAuthOverride?: {
    user: PrivateUserId;
    password: string;
  };
  /**
   * Transfer strategy.  Defaults to `"full"`.
   *
   * Use `"dense"` for bandwidth-constrained scenarios (initial mobile setup,
   * metered connections) where only the current document state is needed.
   */
  mode?: SyncMode;
}

/**
 * Result returned by pull/push sync operations.
 */
export interface SyncResult {
  transferredEntries: number;
  scannedEntries: number;
  cancelled: boolean;
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
   * True when this database was opened with a timeTravelDate cutoff.
   */
  isTimeTravelMode(): boolean;

  /**
   * True when mutating APIs are disabled for this database instance.
   */
  isReadOnly(): boolean;

  /**
   * Normalized time travel cutoff in epoch milliseconds, or null for live mode.
   */
  getTimeTravelDate(): number | null;

  /**
   * Get the content-addressed store that is used to store document changes for this database.
   *
   * @return The content-addressed store for documents
   */
  getStore(): ContentAddressedStore;

  /**
   * Get the content-addressed store that is used to store attachment chunks for this database.
   *
   * @return The content-addressed store for attachments
   */
  getAttachmentStore(): ContentAddressedStore;

  reclaimIncompleteAttachmentUploads?(
    options?: { minAgeMs?: number }
  ): Promise<IncompleteAttachmentUploadReclaimResult>;

  /**
   * Create a new document.
   *
   * Without options the document gets a fresh UUID7 id and is encrypted with the
   * tenant's default symmetric key. The behavior of `createEncryptedDocument()` and
   * `createDocumentWithSigningKey()` is fully expressible through `CreateOptions`.
   *
   * Caller-provided `id` enables two important use cases:
   * - app developers can directly load known documents without first creating a view
   * - app migrations from systems like Notes/Domino or MongoDB can preserve their
   *   original document IDs
   *
   * For documents created with the same caller-provided `id` on independent replicas,
   * MindooDB uses a hard-coded initial Automerge change so the replicas share Automerge
   * ancestry and merge correctly when synced. If a document with the given `id` already
   * exists locally, the existing document is returned (idempotent create).
   *
   * @param options Optional creation options.
   * @return The new (or, if `options.id` already exists locally, existing) document.
   */
  createDocument(options?: CreateOptions): Promise<MindooDoc>;

  /**
   * Create a new document with optional encryption using a named symmetric key.
   *
   * @deprecated Use `createDocument({ decryptionKeyId })` instead.
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
   * @deprecated Use `createDocument({ signingKeyPair, signingKeyPassword, decryptionKeyId })` instead.
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
   * @return The document at the specified timestamp, or null if the document didn't exist at that time.
   *         If the document was deleted at or before the timestamp, returns a document with isDeleted() === true.
   */
  getDocumentAtTimestamp(docId: string, timestamp: number): Promise<MindooDoc | null>;

  /**
   * Iterate through the history of a document from its origin to the latest version.
   * Traverses changes in chronological order (oldest to newest), applying each change and yielding the document state.
   * 
   * Each yielded document is an independent clone, safe to store in arrays or modify.
   * 
   * Documents are yielded in chronological order from oldest to newest (origin to latest version).
   * 
   * Example usage:
   * ```typescript
   * for await (const { doc, changeCreatedAt, changeCreatedByPublicKey } of db.iterateDocumentHistory(docId)) {
   *   const data = doc.getData();
   *   console.log(`Document at ${new Date(changeCreatedAt)}:`, data);
   *   // Store doc in array - each is independent
   *   history.push(doc);
   * }
   * ```
   *
   * @param docId The ID of the document to traverse
   * @return An async generator that yields DocumentHistoryResult objects containing the document state and change metadata, in chronological order from oldest to newest
   */
  iterateDocumentHistory(docId: string): AsyncGenerator<DocumentHistoryResult, void, unknown>;

  /**
   * Return bounded history metadata for a document without materializing every
   * historical document state.
   *
   * This is intended for scalable history UIs where the caller wants a paged
   * timeline first, and only materializes specific snapshots on demand.
   */
  getDocumentHistoryPage(
    docId: string,
    options?: DocumentHistoryPageOptions
  ): Promise<DocumentHistoryPageResult>;

  /**
   * Analyze the document DAG visible at a point in time without materializing
   * every branch-local Automerge state.
   *
   * The result contains the active replay heads, per-entry metadata, and
   * derived branch summaries keyed by active head.
   */
  analyzeDocumentDagAtTimestamp(
    docId: string,
    timestamp: DocumentDagAnalysisTimestamp
  ): Promise<DocumentDagAnalysisResult>;

  /**
   * Reconstruct the branch-local document state for the selected head entry.
   *
   * This follows the selected head's ancestor closure only, ignoring unrelated
   * concurrent branches unless the selected head explicitly depends on them.
   */
  materializeDocumentBranchAtEntry(
    docId: string,
    headEntryId: string
  ): Promise<DocumentDagBranchMaterializationResult | null>;

  /**
   * Reconstruct the branch-local document state for a selected head within a
   * time-bounded DAG slice.
   */
  materializeDocumentBranchAtTimestamp(
    docId: string,
    timestamp: DocumentDagAnalysisTimestamp,
    headEntryId: string
  ): Promise<DocumentDagBranchMaterializationResult | null>;

  /**
   * Decode and summarize one DAG entry for hover/tooling use cases.
   */
  describeDocumentDagEntry(
    docId: string,
    entryId: string
  ): Promise<DocumentDagEntryDetails | null>;

  /**
   * Stream conflict analysis events for one or more documents.
   *
   * The API intentionally returns MindooDB DTOs only. It does not expose
   * Automerge documents, patches, or operation objects so the storage backend
   * can evolve without changing callers.
   */
  analyzeDocumentConflicts(
    docIds: string[],
    options?: DocumentConflictAnalysisOptions
  ): AsyncGenerator<DocumentConflictAnalysisEvent, void, unknown>;

  /**
   * Build a full conflict report for one document by consuming the streaming
   * analyzer internally.
   */
  getDocumentConflictReport(
    docId: string,
    options?: DocumentConflictReportOptions
  ): Promise<DocumentConflictReport>;

  /**
   * Resolve the value each conflicted path had at its merge base (the most
   * recent common ancestor of the branches that contributed to the conflict).
   *
   * Each query independently maps to a base value so the caller can request
   * lookups lazily — for example, only for the paths it currently displays.
   * Queries that share a merge base are coalesced internally so the
   * underlying document state is materialized at most once per base entry.
   */
  getDocumentConflictBaseValues(
    docId: string,
    queries: DocumentConflictBaseValueQuery[]
  ): Promise<DocumentConflictBaseValue[]>;

  /**
   * Return an incremental conflict-scan checkpoint for the current local view.
   *
   * Callers can persist this value after presenting scan results and pass it
   * back as `DocumentConflictAnalysisOptions.since` on the next run.
   */
  getConflictScanCheckpoint(): Promise<ConflictScanCheckpoint>;

  /**
   * Get all non-deleted document IDs in this database.
   *
   * @return A list of document IDs
   */
  getAllDocumentIds(): Promise<string[]>;

  /**
   * Get all deleted document IDs in this database.
   *
   * Deleted documents remain available through history/time-travel APIs until
   * their history is purged.
   *
   * @return A list of deleted document IDs
   */
  getDeletedDocumentIds(): Promise<string[]>;

  /**
   * Get all document IDs that existed at a specific timestamp.
   * 
   * This method efficiently queries the content-addressed store to find
   * documents that existed at the given point in time. A document is considered
   * to exist at a timestamp if:
   * - It has a doc_create entry with createdAt <= timestamp
   * - Either it has no doc_delete entry, or its doc_delete entry has createdAt > timestamp
   * 
   * @param timestamp The timestamp to query (milliseconds since Unix epoch)
   * @return A promise that resolves to a list of document IDs that existed at the specified timestamp
   */
  getAllDocumentIdsAtTimestamp(timestamp: number): Promise<string[]>;

  /**
   * Delete a document by its ID.
   *
   * When `options.signingKeyPair` is provided, the delete lifecycle entry is
   * signed with that key instead of the current user's key.
   *
   * @param docId The ID of the document
   * @param options Optional signing options for the delete entry
   * @return A promise that resolves when the document is deleted
   */
  deleteDocument(docId: string, options?: DeleteOptions): Promise<void>;

  /**
   * Delete a document using a specific signing key.
   * This is like deleteDocument but allows signing with a different key than the current user's.
   * Used for directory operations that must be signed with the administration key.
   *
   * @deprecated Use `deleteDocument(docId, { signingKeyPair, signingKeyPassword })` instead.
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
   * Undelete a document by its ID.
   *
   * Deleted documents remain in the append-only store. Undeleting writes a new
   * lifecycle entry that marks the latest document state as alive again without
   * clearing or replacing the existing document body.
   *
   * @param docId The ID of the document
   * @param options Optional signing options for the undelete entry
   * @return A promise that resolves when the document is undeleted
   */
  undeleteDocument(docId: string, options?: UndeleteOptions): Promise<void>;

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
   * @param options Optional signing options for the change entry
   * @return A promise that resolves when the document is changed
   */
  changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    options?: ChangeOptions
  ): Promise<void>;

  /**
   * Apply granular text edits at a document path.
   *
   * If `baseHeads` is provided, edits are applied at that historical Automerge
   * version using `changeAt`, then merged into the current document. This lets
   * apps flush buffered text operations based on a stale local copy without
   * overwriting concurrent edits that arrived meanwhile.
   */
  applyTextPatch(doc: MindooDoc, patch: MindooTextPatch): Promise<MindooTextPatchResult>;

  /**
   * Apply granular JSON edits at document paths.
   *
   * If `baseHeads` is provided, edits are applied at that historical Automerge
   * version using `changeAt`, then merged into the current document. This lets
   * apps flush buffered object/list operations based on a stale local copy
   * without replacing concurrent changes that arrived meanwhile.
   */
  applyJsonPatch(doc: MindooDoc, patch: MindooJsonPatch): Promise<MindooJsonPatchResult>;

  /**
   * Change a document using a specific signing key.
   * This is like changeDoc but allows signing with a different key than the current user's.
   * Used for directory operations that must be signed with the administration key.
   *
   * @deprecated Use `changeDoc(doc, changeFunc, { signingKeyPair, signingKeyPassword })` instead.
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
   * Iterate over latest-state change metadata since a given cursor without
   * loading, verifying, or decrypting the full document body.
   *
   * This is intended for external indexes, sync checkpoints, and overview UIs
   * that only need document IDs, deletion flags, and cursors.
   *
   * @param cursor The cursor to start processing changes from. Use `null` to start from the beginning.
   * @return An async generator that yields metadata-only change summaries.
   */
  iterateChangeMetadataSince(
    cursor: ProcessChangesCursor | null
  ): AsyncGenerator<ProcessChangeSummaryResult, void, unknown>;

  /**
   * Return the latest available changefeed cursor without iterating the full
   * change index. Returns `null` when the database has no indexed changes yet.
   */
  getLatestChangeCursor?(): ProcessChangesCursor | null;

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
   * Sync deliberately does NOT trigger the L2 background warmer. Callers
   * that want to warm the L2 cache after a sync (e.g. the Haven sync
   * page once a sync settles) should call {@link startBackgroundWarmer}
   * explicitly. This keeps casual `syncStoreChanges()` calls cheap and
   * leaves warmer scheduling to the caller, which knows whether the
   * cost of a full L2 walk is worth paying for the current workload.
   *
   * @return A promise that resolves when the sync is complete.
   */
  syncStoreChanges(): Promise<void>;

  /**
   * Reconcile local document visibility with the current tenant KeyBag.
   *
   * Reveals documents whose decryption keys are now available, hides
   * documents whose keys have been removed, and purges any plaintext
   * caches for inaccessible documents. The method only touches in-memory
   * and L2 caches owned by this database instance - it does not write
   * synthetic store entries and is safe to call repeatedly.
   *
   * Optional so alternative database implementations (e.g. read-only
   * views, time-travel snapshots) can omit it.
   */
  reconcileKeyVisibility?(): Promise<void>;

  /**
   * Start the L2 background warmer.
   *
   * Walks the in-memory document index and ensures every document has
   * an up-to-date L2 cache record (using the same internal load-from-L2
   * code path foreground reads use). Runs in batches with cooperative
   * yields so foreground operations are not starved.
   *
   * Intended to be called explicitly by long-lived sessions that just
   * finished a sync (e.g. the Haven sync page after pulling/pushing
   * completes) so subsequent reads - especially virtual view rebuilds
   * - hit the fast L2 path. Casual database opens should NOT call this;
   * pay the warmer cost only when the workload is about to benefit
   * from a fully warm L2.
   *
   * Single-flight: a second call while the warmer is already running
   * returns the same in-flight promise rather than starting a second
   * pass. The returned promise resolves when the warmer has finished
   * (either by visiting every document or by being cancelled via
   * {@link stopBackgroundWarmer} or via the optional `signal`).
   *
   * @param options See {@link StartBackgroundWarmerOptions}: optional
   *   `signal` for per-call cancellation and `onProgress` for driving
   *   a progress UI.
   */
  startBackgroundWarmer?(options?: StartBackgroundWarmerOptions): Promise<void>;

  /**
   * Cancel the running background warmer (if any). Returns a promise
   * that resolves once the in-flight warmer pass has observed the
   * cancellation and returned (so callers can `await` clean shutdown).
   * Safe to call when no warmer is running - resolves immediately in
   * that case.
   *
   * Useful before initiating destructive operations (key rotation, data
   * wipe, etc.) so the warmer cannot race against the mutation, and at
   * the end of tests to ensure no background work outlives the test.
   */
  stopBackgroundWarmer?(): Promise<void>;

  /**
   * Returns `true` while the L2 background warmer is actively
   * processing documents. Useful for "Warming…" UI indicators and
   * tests that need to coordinate with warmer progress.
   */
  isWarmerRunning?(): boolean;

  /**
   * Snapshot of the current (or most recent) background warmer pass's
   * progress, or `null` if no warmer has ever run on this database
   * instance. Designed for UIs that mount AFTER the warmer has already
   * started (e.g. the user navigates back to the Sync page mid-warm)
   * and need to "catch up" on state without missing onProgress events.
   *
   * After a warmer settles, the returned snapshot persists with its
   * final `phase` (`"done"` or `"cancelled"`) so the UI can decide
   * whether to keep showing a "Optimized" message or fade away. The
   * snapshot is replaced on the next {@link startBackgroundWarmer}
   * call.
   */
  getBackgroundWarmerProgress?(): BackgroundWarmerProgress | null;

  /**
   * Pull changes from a remote content-addressed store or another MindooDB instance.
   *
   * @param remote The remote store or MindooDB instance to pull changes from
   * @param options Optional sync options for progress tracking, paging, and cancellation
   * @return A promise that resolves with the sync result
   */
  pullChangesFrom(remote: ContentAddressedStore | MindooDB, options?: SyncOptions): Promise<SyncResult>;

  /**
   * Push changes to a remote content-addressed store or another MindooDB instance.
   *
   * @param remote The remote store or MindooDB instance to push changes to
   * @param options Optional sync options for progress tracking, paging, and cancellation
   * @return A promise that resolves with the sync result
   */
  pushChangesTo(remote: ContentAddressedStore | MindooDB, options?: SyncOptions): Promise<SyncResult>;
}
