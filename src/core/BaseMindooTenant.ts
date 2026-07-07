import {
  MindooTenant,
  EncryptedPrivateKey,
  MindooDB,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  OpenStoreOptions,
  StoreKind,
  OpenDBOptions,
  MindooTenantFactory,
  MindooTenantDirectory,
  StoreEntryMetadata,
  SigningKeyPair,
  JoinRequest,
  JoinResponse,
  JoinResponseEncryptedDocKey,
  JoinResponseEncryptedDocKeyVersion,
  ApproveJoinRequestOptions,
  DEFAULT_TENANT_KEY_ID,
  PublishToServerOptions,
  PUBLIC_INFOS_KEY_ID,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag, type KeyBagChangeCursor } from "./keys/KeyBag";
import { BaseMindooDB } from "./BaseMindooDB";
import { BaseMindooTenantDirectory } from "./BaseMindooTenantDirectory";
import { extractWipeRequestedSigningKeys } from "./accesscontrol/grantKeys";
import { KeyBagReconciler } from "./accesscontrol/keyBagReconciler";
import { MindooDocSigner } from "./crypto/MindooDocSigner";
import { RSAEncryption } from "./crypto/RSAEncryption";
import { decryptPrivateKey as decryptPrivateKeyWithPassword } from "./crypto/privateKeyEncryption";
import { verifyEntrySignatureWithImportedKey } from "./crypto/EntrySignature";
import { entryTrustedTime } from "./storeEntryTime";
import { computeContentHash } from "./utils/idGeneration";
import { semanticNow } from "./utils/timeSource";
import { SymmetricKeyNotFoundError } from "./errors";
import { Logger, MindooLogger, getDefaultLogLevel, LogLevel } from "./logging";
import { encodeMindooURI, decodeMindooURI, isMindooURI } from "./uri/MindooURI";
import type { LocalCacheStore } from "./cache/LocalCacheStore";
import { EncryptedLocalCacheStore } from "./cache/EncryptedLocalCacheStore";
import { CacheManager } from "./cache/CacheManager";
import { validateDatabaseId } from "./databaseIdValidation";

/**
 * BaseMindooTenant is a platform-agnostic implementation of MindooTenant
 * that works in both browser and server environments.
 * 
 * It uses a CryptoAdapter to abstract platform-specific crypto operations,
 * allowing the same implementation to work in browsers and Node.js.
 * 
 * Dependencies:
 * - Web Crypto API: Available in both browser (window.crypto) and Node.js (crypto.webcrypto)
 *   - AES-256-GCM encryption (widely supported)
 *   - Ed25519 signing/verification (Node.js 15+, Chrome 92+)
 *   - RSA/ECDH encryption (for encrypting named symmetric keys map)
 *   - PBKDF2 key derivation (for password-based key derivation)
 */
export class BaseMindooTenant implements MindooTenant {
  private factory: MindooTenantFactory;
  private tenantId: string;
  private administrationPublicKey: string; // Administration public key (Ed25519, PEM format)
  private administrationEncryptionPublicKey: string; // Administration encryption public key (RSA-OAEP, PEM format)
  private currentUser: PrivateUserId;
  private currentUserPassword: string; // Password to decrypt user's private keys
  protected cryptoAdapter: CryptoAdapter;
  private keyBag: KeyBag;
  private storeFactory: ContentAddressedStoreFactory;
  private databaseCache: Map<string, MindooDB> = new Map();
  private directoryCache: MindooTenantDirectory | null = null;
  private remoteStoreCache: Map<string, Promise<ContentAddressedStore>> = new Map();
  /**
   * Cursor into the local KeyBag changes feed. Tracks the last event
   * consumed by {@link reconcileKeyBagChanges} so we can replay only the
   * deltas and stay idempotent across both live notifications and
   * explicit reconcile calls.
   */
  private keyBagChangeCursor: KeyBagChangeCursor | null = null;
  /**
   * Disposer returned by {@link KeyBag.onChanges} for live notifications.
   * `null` once the tenant has been torn down via {@link disposeCacheManager}.
   */
  private unsubscribeKeyBagChanges: (() => void) | null = null;
  /**
   * Single-flight latch for {@link reconcileKeyBagChanges}. Concurrent calls
   * coalesce onto the same in-flight reconcile so live listener firings and
   * explicit calls cannot race against each other or duplicate work.
   */
  private keyBagReconcilePromise: Promise<void> | null = null;

  // Cache for decrypted keys (to avoid repeated decryption)
  private decryptedTenantKeyCache?: Uint8Array;
  private decryptedUserSigningKeyCache?: CryptoKey;
  private decryptedUserEncryptionKeyCache?: CryptoKey;
  /**
   * Cache of imported AES-GCM `CryptoKey`s, keyed by usage + raw key bytes
   * (hex). `subtle.importKey` costs a WebCrypto round trip per call, which
   * adds up on bulk writes/reads (one import per store entry). Because the
   * cache is content-addressed by the key bytes, rotated key versions miss
   * the cache naturally — no explicit invalidation is needed.
   */
  private readonly importedAesKeyCache = new Map<string, CryptoKey>();
  /**
   * Cache of imported Ed25519 verify `CryptoKey`s, keyed by the PEM public
   * key. Signature verification runs once per entry when materializing
   * documents, so the per-call SPKI import is on the hot read path.
   */
  private readonly importedVerifyKeyCache = new Map<string, CryptoKey>();
  private static readonly MAX_IMPORTED_KEY_CACHE_ENTRIES = 128;
  private logger: Logger;

  // Single-flight guard for SDK-driven key-distribution reconcile (§13). The
  // reconcile driver itself calls getDirectoryDB / updateUnifiedCache /
  // syncStoreChanges, any of which can re-enter a trigger; this flag keeps the
  // run-always trigger (directory bring-up + after each directory pull) from
  // recursing or overlapping. Reconcile is idempotent, so a skipped overlap is
  // harmless — the next trigger re-runs it.
  private reconcileInFlight = false;

  // Local cache support
  private cacheManager: CacheManager | null = null;

  /**
   * Optional map of additional trusted signing public keys.
   * Keys in this map are checked BEFORE the MindooTenantDirectory when validating
   * public signing keys. This is useful for server-to-server sync where
   * trusted server identities are configured out-of-band (e.g. server-env.json)
   * rather than registered in the directory database.
   *
   * Map key: signing public key (Ed25519, PEM format)
   * Map value: true if trusted, false if explicitly revoked
   */
  private additionalTrustedKeys?: ReadonlyMap<string, boolean>;

  constructor(
    factory: MindooTenantFactory,
    tenantId: string,
    administrationPublicKey: string,
    administrationEncryptionPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
    storeFactory: ContentAddressedStoreFactory,
    cryptoAdapter: CryptoAdapter,
    logger?: Logger,
    additionalTrustedKeys?: ReadonlyMap<string, boolean>,
    localCacheStore?: LocalCacheStore,
    /**
     * Optional pre-derived crypto material for the current user. When the
     * caller has already decrypted the user's signing/encryption private
     * keys (e.g. once at login) and/or derived the cache encryption key,
     * passing them here skips the per-instance PBKDF2 + decrypt path. The
     * `currentUserPassword` argument may then be empty and is never used
     * downstream (as long as the requested key is already present in the
     * cache).
     */
    preDecryptedMaterial?: {
      signingKey?: CryptoKey;
      encryptionKey?: CryptoKey;
      cacheEncryptionKey?: CryptoKey;
    },
  ) {
    this.factory = factory;
    this.tenantId = tenantId;
    this.administrationPublicKey = administrationPublicKey;
    this.administrationEncryptionPublicKey = administrationEncryptionPublicKey;
    this.currentUser = currentUser;
    this.currentUserPassword = currentUserPassword;
    this.keyBag = keyBag;
    this.storeFactory = storeFactory;
    this.additionalTrustedKeys = additionalTrustedKeys;
    if (!cryptoAdapter) {
      throw new Error("BaseMindooTenant requires a CryptoAdapter instance.");
    }
    this.cryptoAdapter = cryptoAdapter;
    // Create logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `Tenant:${tenantId}`, true);
    // Hook the local KeyBag changes feed:
    //  - Snapshot the cursor so any pre-existing key state is treated as
    //    "already seen" and only future mutations trigger reconciliation.
    //  - Subscribe to live events scoped to this tenant; missed events
    //    are still recovered when callers invoke
    //    {@link reconcileKeyBagChanges} explicitly (it replays from the
    //    cursor regardless of whether the listener fired).
    this.keyBagChangeCursor = this.keyBag.getLatestChangeCursor();
    this.unsubscribeKeyBagChanges = this.keyBag.onChanges((event) => {
      if (event.type !== "doc" || event.tenantId !== this.tenantId) {
        return;
      }
      // Fire-and-forget: errors are surfaced via the reconcile path itself.
      // We intentionally do not await here to keep the mutation call site
      // synchronous from the listener's perspective.
      void this.reconcileKeyBagChanges();
    });

    // Pre-warm the per-user CryptoKey caches so getDecryptedSigningKey()
    // and getDecryptedEncryptionKey() never run PBKDF2 + decryptPrivateKey
    // when the caller has already derived these keys at login.
    if (preDecryptedMaterial?.signingKey) {
      this.decryptedUserSigningKeyCache = preDecryptedMaterial.signingKey;
    }
    if (preDecryptedMaterial?.encryptionKey) {
      this.decryptedUserEncryptionKeyCache = preDecryptedMaterial.encryptionKey;
    }

    // Set up cache if a local cache store is provided. When a pre-derived
    // cache encryption key is available, prefer that to skip the password
    // path and avoid retaining the plaintext password inside the encrypted
    // cache wrapper.
    if (localCacheStore) {
      const encryptedStore = preDecryptedMaterial?.cacheEncryptionKey
        ? new EncryptedLocalCacheStore(localCacheStore, {
            cacheKey: preDecryptedMaterial.cacheEncryptionKey,
            cryptoAdapter: this.cryptoAdapter,
            logger: this.logger.createChild("EncryptedCache"),
          })
        : new EncryptedLocalCacheStore(
            localCacheStore,
            currentUserPassword,
            this.cryptoAdapter,
            this.logger.createChild("EncryptedCache"),
          );
      this.cacheManager = new CacheManager(
        encryptedStore,
        undefined,
        this.logger.createChild("CacheManager"),
      );
    }
  }

  /**
   * Initialize the tenant.
   */
  async initialize(): Promise<void> {
    this.logger.info(`Initializing tenant ${this.tenantId}`);
    // KeyBag is already loaded by the caller before passing it to the constructor
    const keyCount = (await this.keyBag.listKeys()).length;
    this.logger.info(`Tenant initialized with ${keyCount} keys in KeyBag`);
  }

  /**
   * Get the CacheManager for this tenant (null if caching is disabled).
   */
  getCacheManager(): CacheManager | null {
    return this.cacheManager;
  }

  /**
   * Flush and dispose the cache manager.
   * Should be called when the tenant is being closed.
   */
  async disposeCacheManager(): Promise<void> {
    // Unsubscribe from KeyBag changes alongside cache teardown. Callers
    // already use `disposeCacheManager` as the "tenant is closing" signal,
    // so this keeps lifecycle hooks in one place. Safe to call multiple
    // times - the disposer is nulled out after the first call.
    this.unsubscribeKeyBagChanges?.();
    this.unsubscribeKeyBagChanges = null;
    if (this.cacheManager) {
      await this.cacheManager.dispose();
      this.cacheManager = null;
    }
  }

  getCryptoAdapter(): CryptoAdapter {
    return this.cryptoAdapter;
  }

  private normalizeTimeTravelDate(value: OpenDBOptions["timeTravelDate"]): number | null {
    if (value == null || value === "") {
      return null;
    }
    const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Invalid timeTravelDate: ${String(value)}`);
    }
    return timestamp;
  }

  getFactory(): MindooTenantFactory {
    return this.factory;
  }

  getId(): string {
    return this.tenantId;
  }

  /**
   * Get the administration public key for this tenant.
   * Used for creating document signers for administrative operations.
   * 
   * @return The administration public key (Ed25519, PEM format)
   */
  getAdministrationPublicKey(): string {
    return this.administrationPublicKey;
  }

  /**
   * Get the administration encryption public key for this tenant.
   * Used for encrypting sensitive data in the directory that only admins can decrypt
   * (e.g., usernames in access control documents).
   * 
   * @return The administration encryption public key (RSA-OAEP, PEM format)
   */
  getAdministrationEncryptionPublicKey(): string {
    return this.administrationEncryptionPublicKey;
  }

  /**
   * Import an AES-GCM key for `usage`, memoized on the raw key bytes. See
   * {@link importedAesKeyCache}. On overflow the cache is simply cleared —
   * refilling it costs one import per active key, which is negligible.
   */
  private async importAesKeyCached(
    symmetricKey: Uint8Array,
    usage: "encrypt" | "decrypt",
  ): Promise<CryptoKey> {
    let cacheKey = usage + ":";
    for (let i = 0; i < symmetricKey.length; i++) {
      cacheKey += symmetricKey[i].toString(16).padStart(2, "0");
    }
    const cached = this.importedAesKeyCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const subtle = this.cryptoAdapter.getSubtle();
    // Create a new Uint8Array to ensure we have a proper ArrayBuffer
    const keyArray = new Uint8Array(symmetricKey);
    const cryptoKey = await subtle.importKey(
      "raw",
      keyArray.buffer,
      { name: "AES-GCM" },
      false, // not extractable
      [usage]
    );
    if (this.importedAesKeyCache.size >= BaseMindooTenant.MAX_IMPORTED_KEY_CACHE_ENTRIES) {
      this.importedAesKeyCache.clear();
    }
    this.importedAesKeyCache.set(cacheKey, cryptoKey);
    return cryptoKey;
  }

  async encryptPayload(payload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    // The per-step debug logs below are on the hot write path (one call per
    // store entry); skip building the interpolated strings when debug is off.
    const debugEnabled = this.logger.isLevelEnabled(LogLevel.DEBUG);
    if (debugEnabled) {
      this.logger.debug(`Encrypting payload with key: ${decryptionKeyId}`);
      this.logger.debug(`Payload size: ${payload.length} bytes`);
    }

    // Get the symmetric key for this key ID
    let symmetricKey: Uint8Array;
    try {
      if (decryptionKeyId === "default") {
        // Use cached tenant encryption key if available
        if (this.decryptedTenantKeyCache) {
          symmetricKey = this.decryptedTenantKeyCache;
          if (debugEnabled) this.logger.debug(`Using cached tenant key, length: ${symmetricKey.length} bytes`);
        } else {
          if (debugEnabled) this.logger.debug(`Resolving tenant encryption key from KeyBag`);
          const tenantKey = await this.keyBag.get("doc", this.tenantId, DEFAULT_TENANT_KEY_ID);
          if (!tenantKey) {
            throw new SymmetricKeyNotFoundError(`doc:${this.tenantId}:${DEFAULT_TENANT_KEY_ID}`);
          }
          symmetricKey = tenantKey;
          this.decryptedTenantKeyCache = symmetricKey;
          if (debugEnabled) this.logger.debug(`Loaded tenant key from KeyBag, length: ${symmetricKey.length} bytes`);
        }
      } else {
        if (debugEnabled) this.logger.debug(`Getting named key from KeyBag: ${decryptionKeyId}`);
        // Get the decrypted key from KeyBag
        const decryptedKey = await this.keyBag.get("doc", this.tenantId, decryptionKeyId);
        if (!decryptedKey) {
          throw new SymmetricKeyNotFoundError(decryptionKeyId);
        }
        symmetricKey = decryptedKey;
        if (debugEnabled) this.logger.debug(`Got named key, length: ${symmetricKey.length} bytes`);
      }
    } catch (error) {
      this.logger.error(`Error getting symmetric key:`, error);
      throw error;
    }

    const subtle = this.cryptoAdapter.getSubtle();
    // Bind getRandomValues to maintain 'this' context
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);

    // Import the symmetric key (memoized; see importAesKeyCached)
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await this.importAesKeyCached(symmetricKey, "encrypt");
    } catch (error) {
      this.logger.error(`Error importing key:`, error);
      this.logger.error(`Key length: ${symmetricKey.length}, expected: 32 bytes for AES-256`);
      throw error;
    }

    // Generate IV (12 bytes for AES-GCM)
    let iv: Uint8Array;
    try {
      const ivArray = new Uint8Array(12);
      randomValues(ivArray);
      iv = new Uint8Array(ivArray.buffer, ivArray.byteOffset, ivArray.byteLength);
    } catch (error) {
      this.logger.error(`Error generating IV:`, error);
      throw error;
    }

    // Encrypt the payload
    let encrypted: ArrayBuffer;
    try {
      // Create a new Uint8Array to ensure we have a proper ArrayBuffer
      const payloadArray = new Uint8Array(payload);
      encrypted = await subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          tagLength: 128, // 128-bit authentication tag
        },
        cryptoKey,
        payloadArray
      );
    } catch (error) {
      this.logger.error(`Error encrypting payload:`, error);
      this.logger.error(`Error details:`, {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        payloadLength: payload.length,
        keyLength: symmetricKey.length,
        ivLength: iv.length,
      });
      throw error;
    }

    // Combine IV and encrypted data
    // Format: IV (12 bytes) + encrypted data (includes authentication tag)
    const encryptedArray = new Uint8Array(encrypted);
    const result = new Uint8Array(12 + encryptedArray.length);
    result.set(iv, 0);
    result.set(encryptedArray, 12);

    if (debugEnabled) this.logger.debug(`Encrypted payload (${payload.length} -> ${result.length} bytes)`);
    return result;
  }

  async decryptPayload(encryptedPayload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    // Hot read path (one call per store entry): skip interpolations when off.
    const debugEnabled = this.logger.isLevelEnabled(LogLevel.DEBUG);
    if (debugEnabled) this.logger.debug(`Decrypting payload with key: ${decryptionKeyId}`);

    if (encryptedPayload.length < 12) {
      throw new Error("Encrypted payload too short (missing IV)");
    }

    // Extract IV (first 12 bytes) and encrypted data (rest)
    const iv = encryptedPayload.slice(0, 12);
    const encryptedData = encryptedPayload.slice(12);

    // Gather ALL stored versions of the key (newest first). Key rotation keeps
    // several versions under one keyId, and a payload may have been encrypted
    // under any of them, so we must try each — not just the newest. The newest
    // version is overwhelmingly the common case, so it is tried first.
    const candidates = await this.getDecryptionKeyCandidates(decryptionKeyId);
    if (candidates.length === 0) {
      throw new SymmetricKeyNotFoundError(
        decryptionKeyId === "default" ? `doc:${this.tenantId}:${DEFAULT_TENANT_KEY_ID}` : decryptionKeyId,
      );
    }

    const subtle = this.cryptoAdapter.getSubtle();
    let lastError: unknown = undefined;
    for (const symmetricKey of candidates) {
      try {
        const cryptoKey = await this.importAesKeyCached(symmetricKey, "decrypt");
        const decrypted = await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            tagLength: 128, // 128-bit authentication tag
          },
          cryptoKey,
          encryptedData as BufferSource,
        );
        if (debugEnabled) {
          this.logger.debug(`Decrypted payload (${encryptedPayload.length} -> ${decrypted.byteLength} bytes)`);
        }
        return new Uint8Array(decrypted);
      } catch (error) {
        // AES-GCM authentication failure means this version was not the one used
        // to encrypt; fall through and try the next version.
        lastError = error;
      }
    }
    this.logger.debug(`Decrypt failed against all ${candidates.length} version(s) of key "${decryptionKeyId}"`);
    throw lastError ?? new SymmetricKeyNotFoundError(decryptionKeyId);
  }

  /**
   * Return every stored version of the symmetric key for `decryptionKeyId`,
   * newest first, mapping the `"default"` alias to the tenant default key id.
   * Used by the decryption paths to support key rotation (a payload may have
   * been encrypted under an older version than the current newest one).
   *
   * As a side effect, refreshes {@link decryptedTenantKeyCache} to the newest
   * tenant-default version so encryption keeps using the latest key.
   */
  private async getDecryptionKeyCandidates(decryptionKeyId: string): Promise<Uint8Array[]> {
    const id = decryptionKeyId === "default" ? DEFAULT_TENANT_KEY_ID : decryptionKeyId;
    const versions = await this.keyBag.getAllKeys("doc", this.tenantId, id);
    if (decryptionKeyId === "default" && versions.length > 0) {
      this.decryptedTenantKeyCache = versions[0];
    }
    return versions;
  }

  async signPayload(payload: Uint8Array): Promise<Uint8Array> {
    this.logger.debug(`Signing payload`);

    // Get the current user's signing private key (decrypted)
    const signingKey = await this.getDecryptedSigningKey();

    const subtle = this.cryptoAdapter.getSubtle();

    // Sign the payload
    const signature = await subtle.sign(
      {
        name: "Ed25519",
      },
      signingKey,
      payload.buffer as ArrayBuffer
    );

    this.logger.debug(`Signed payload (signature: ${signature.byteLength} bytes)`);
    return new Uint8Array(signature);
  }

  async signPayloadWithKey(
    payload: Uint8Array,
    signingKeyPair: SigningKeyPair,
    password: string
  ): Promise<Uint8Array> {
    this.logger.debug(`Signing payload with provided key`);

    const subtle = this.cryptoAdapter.getSubtle();

    // Decrypt the provided signing private key
    const decryptedKeyBuffer = await this.decryptPrivateKey(
      signingKeyPair.privateKey,
      password,
      "signing"
    );

    // Import the decrypted key as an Ed25519 private key
    const signingKey = await subtle.importKey(
      "pkcs8",
      decryptedKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["sign"]
    );

    // Sign the payload
    const signature = await subtle.sign(
      {
        name: "Ed25519",
      },
      signingKey,
      payload.buffer as ArrayBuffer
    );

    this.logger.debug(`Signed payload with provided key (signature: ${signature.byteLength} bytes)`);
    return new Uint8Array(signature);
  }

  async verifySignature(payload: Uint8Array, signature: Uint8Array, publicKey: string): Promise<boolean> {
    this.logger.debug(`Verifying signature`);

    const directory = await this.openDirectory();
    const isTrusted = await directory.validatePublicSigningKey(publicKey);
    if (!isTrusted) {
      this.logger.warn(`Public key not trusted: ${publicKey}`);
      return false;
    }

    const subtle = this.cryptoAdapter.getSubtle();

    // Import the public key from SPKI format (memoized per PEM string)
    const cryptoKey = await this.importVerifyKeyCached(publicKey);

    // Verify the signature
    const isValid = await subtle.verify(
      {
        name: "Ed25519",
      },
      cryptoKey,
      signature.buffer as ArrayBuffer,
      payload.buffer as ArrayBuffer
    );

    // Debug (not info): this runs once per verified entry on the read path.
    if (this.logger.isLevelEnabled(LogLevel.DEBUG)) {
      this.logger.debug(`Signature verification result: ${isValid}`);
    }
    return isValid;
  }

  /**
   * Import an Ed25519 verify key from its PEM SPKI form, memoized per PEM
   * string. See {@link importedVerifyKeyCache}.
   */
  private async importVerifyKeyCached(publicKeyPem: string): Promise<CryptoKey> {
    const cached = this.importedVerifyKeyCache.get(publicKeyPem);
    if (cached) {
      return cached;
    }
    const subtle = this.cryptoAdapter.getSubtle();
    const cryptoKey = await subtle.importKey(
      "spki",
      this.pemToArrayBuffer(publicKeyPem),
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["verify"]
    );
    if (this.importedVerifyKeyCache.size >= BaseMindooTenant.MAX_IMPORTED_KEY_CACHE_ENTRIES) {
      this.importedVerifyKeyCache.clear();
    }
    this.importedVerifyKeyCache.set(publicKeyPem, cryptoKey);
    return cryptoKey;
  }

  async verifyEntrySignature(entry: StoreEntryMetadata, encryptedData: Uint8Array): Promise<boolean> {
    // The author key must be trusted by the tenant directory.
    const directory = await this.openDirectory();
    const isTrusted = await directory.validatePublicSigningKey(entry.createdByPublicKey);
    if (!isTrusted) {
      this.logger.warn(`Public key not trusted: ${entry.createdByPublicKey}`);
      return false;
    }

    const subtle = this.cryptoAdapter.getSubtle();

    // Integrity: the served bytes must hash to the signed/hashed contentHash so
    // a relay cannot substitute payload bytes that disagree with the metadata
    // (audit finding #5).
    const actualHash = await computeContentHash(encryptedData, subtle);
    if (actualHash !== entry.contentHash) {
      this.logger.warn(
        `Content hash mismatch for entry ${entry.id} (expected ${entry.contentHash.substring(0, 16)}..., got ${actualHash.substring(0, 16)}...)`,
      );
      return false;
    }

    // Storage-format floor (requireMetadataSignatureSince): if the tenant
    // requires the v2 metadata-binding signature for entries at/after a
    // trusted-time cutoff, disable the legacy fallback for this entry. The
    // cutoff is compared against the entry's trusted time so genuine older
    // history still verifies via the legacy signature.
    const requireMetadataSignature = await this.requiresMetadataSignature(directory, entry);

    // Version-aware author signature: prefer the metadata-binding signature,
    // fall back to the legacy ciphertext-only signature for v1/legacy entries
    // (unless the floor above forbids the fallback for this entry). The
    // author's verify key is imported once per PEM and cached — this runs for
    // every entry a document replays.
    const authorKey = await this.importVerifyKeyCached(entry.createdByPublicKey);
    const isValid = await verifyEntrySignatureWithImportedKey(
      entry,
      encryptedData,
      authorKey,
      subtle,
      { requireMetadataSignature },
    );
    if (this.logger.isLevelEnabled(LogLevel.DEBUG)) {
      this.logger.debug(`Entry signature verification result: ${isValid}`);
    }
    return isValid;
  }

  /**
   * Whether the storage-format floor (`requireMetadataSignatureSince`) requires
   * `entry` to carry the v2 metadata-binding signature, based on the entry's
   * trusted time. Returns false when no floor is configured, when the directory
   * implementation predates the policy, or on any resolution error (fail-open
   * here is safe: the legacy signature is still cryptographically verified — the
   * floor only refuses the *weaker* fallback for new entries).
   */
  private async requiresMetadataSignature(
    directory: MindooTenantDirectory,
    entry: StoreEntryMetadata,
  ): Promise<boolean> {
    if (entry.metadataSignature) {
      return false; // already v2 — the floor is irrelevant
    }
    if (typeof directory.getRequireMetadataSignatureSince !== "function") {
      return false;
    }
    try {
      const cutoff = await directory.getRequireMetadataSignatureSince();
      if (cutoff === undefined) {
        return false;
      }
      return entryTrustedTime(entry, semanticNow()) >= cutoff;
    } catch (error) {
      this.logger.warn(`Failed to resolve metadata-signature floor: ${String(error)}`);
      return false;
    }
  }

  async getCurrentUserId(): Promise<PublicUserId> {
    // Convert PrivateUserId to PublicUserId
    return {
      username: this.currentUser.username,
      userSigningPublicKey: this.currentUser.userSigningKeyPair.publicKey,
      userEncryptionPublicKey: this.currentUser.userEncryptionKeyPair.publicKey,
    };
  }

  /**
   * Get the additional trusted signing keys map, if configured.
   * Used by BaseMindooTenantDirectory to check keys before the directory DB.
   */
  getAdditionalTrustedKeys(): ReadonlyMap<string, boolean> | undefined {
    return this.additionalTrustedKeys;
  }

  async openDirectory(): Promise<MindooTenantDirectory> {
    if (!this.directoryCache) {
      const directoryLogger = this.logger.createChild("Directory");
      this.directoryCache = new BaseMindooTenantDirectory(this, directoryLogger);
    }
    return this.directoryCache;
  }

  /**
   * Check whether an admin has requested a remote wipe of THIS device and, if
   * so, delete the entire local tenant (docs/accesscontrol.md §6.5).
   *
   * The directive lives in the current user's admin-signed `grantaccess`
   * document as `wipeRequestedForSigningKeys`. Because the directory database is
   * admin-only, any grant document that materializes there is already verified
   * as admin-signed — so finding this device's signing key in that list is a
   * genuine, admin-issued directive (the server, which may be hostile, cannot
   * forge it). Sync the directory before calling this so the latest directive is
   * visible.
   *
   * @returns true if a wipe was applied (the tenant is now gone locally), false
   *   if this device is not targeted.
   */
  async checkAndApplyRemoteWipe(): Promise<boolean> {
    const directory = await this.openDirectory();
    const myKey = this.currentUser.userSigningKeyPair.publicKey;

    const finder = directory as unknown as {
      findGrantAccessDocuments?: (username: string) => Promise<Array<{ getData(): Record<string, unknown> }>>;
    };
    if (typeof finder.findGrantAccessDocuments !== "function") {
      return false;
    }

    const grants = await finder.findGrantAccessDocuments(this.currentUser.username);
    const targeted = grants.some((grant) =>
      extractWipeRequestedSigningKeys(grant.getData()).includes(myKey),
    );
    if (!targeted) {
      return false;
    }

    this.logger.warn(
      `Remote-wipe directive found for this device; deleting local tenant "${this.tenantId}".`,
    );
    await this.wipeLocalTenant();
    return true;
  }

  /**
   * Delete all local data for this tenant from the device (docs/accesscontrol.md
   * §6.5): every local database (the directory database plus all known data
   * databases), this tenant's keys in the (multi-tenant) KeyBag, and all
   * in-memory caches. Other tenants on the same device are untouched.
   *
   * Idempotent and best-effort: once the local tenant is gone there is nothing
   * left to delete. Pass extra database ids for databases that exist locally but
   * have not been opened in this session.
   *
   * @param additionalDbIds Optional extra local database ids to wipe.
   */
  async wipeLocalTenant(additionalDbIds?: string[]): Promise<void> {
    // Every local database belonging to this tenant: the directory plus any
    // opened/known data databases. Wipe is a whole-tenant operation.
    const dbIds = new Set<string>([
      "directory",
      ...this.databaseCache.keys(),
      ...(additionalDbIds ?? []),
    ]);

    for (const dbId of dbIds) {
      await this.clearLocalStoresForDb(dbId);
    }

    // Drop in-memory caches and decrypted key material so nothing lingers.
    this.databaseCache.clear();
    this.directoryCache = null;
    this.remoteStoreCache.clear();
    this.decryptedTenantKeyCache = undefined;
    this.decryptedUserSigningKeyCache = undefined;
    this.decryptedUserEncryptionKeyCache = undefined;
    this.disposeCacheManager();

    // Remove this tenant's keys from the multi-tenant KeyBag, leaving other
    // tenants intact.
    try {
      await this.keyBag.deleteTenantKeys(this.tenantId);
    } catch (error) {
      this.logger.warn(`wipeLocalTenant: failed to delete KeyBag keys: ${error}`);
    }
  }

  /** Clear the document and attachment stores for one local database. */
  private async clearLocalStoresForDb(dbId: string): Promise<void> {
    let docStore: ContentAddressedStore | undefined;
    let attachmentStore: ContentAddressedStore | undefined;

    const opened = this.databaseCache.get(dbId);
    if (opened) {
      docStore = opened.getStore();
      attachmentStore = opened.getAttachmentStore();
    } else {
      try {
        const created = this.storeFactory.createStore(dbId);
        docStore = created.docStore;
        attachmentStore = created.attachmentStore;
      } catch (error) {
        this.logger.warn(`wipeLocalTenant: could not open stores for db "${dbId}": ${error}`);
        return;
      }
    }

    for (const store of [docStore, attachmentStore]) {
      if (store && typeof store.clearAllLocalData === "function") {
        try {
          await store.clearAllLocalData();
        } catch (error) {
          this.logger.warn(`wipeLocalTenant: clearAllLocalData failed for db "${dbId}": ${error}`);
        }
      }
    }
  }

  private async assertCurrentUserCanOpenDB(id: string): Promise<void> {
    if (id === "directory") {
      return;
    }

    const currentUser = await this.getCurrentUserId();
    if (currentUser.userSigningPublicKey === this.getAdministrationPublicKey()) {
      return;
    }

    const directory = await this.openDirectory();
    const registeredUser = await directory.getUserPublicKeys(currentUser.username);
    const hasMatchingGrant =
      registeredUser?.signingPublicKey === currentUser.userSigningPublicKey &&
      registeredUser?.encryptionPublicKey === currentUser.userEncryptionPublicKey;

    if (!hasMatchingGrant) {
      this.logger.warn(
        `Denied database open for ungranted user ${currentUser.username} on database ${id}`,
      );
      throw new Error(
        `User "${currentUser.username}" does not have tenant access yet; the tenant admin must grant access first.`,
      );
    }

    // Directory-restricted database policy: when the tenant's default policy
    // restricts which databases may be opened, a granted (non-admin) user may
    // only open a listed database. "directory" is already short-circuited above
    // and the admin returned earlier, so this never blocks the policy read
    // itself (which opens "directory").
    if (typeof directory.isDatabaseAllowed === "function") {
      const allowed = await directory.isDatabaseAllowed(id);
      if (!allowed) {
        this.logger.warn(
          `Denied database open for ${currentUser.username}: database "${id}" is not in the tenant's allowed database list`,
        );
        throw new Error(
          `Database "${id}" is not in the tenant's allowed database list.`,
        );
      }
    }

    // Database read gate (doc_read, §6.6): when the tenant policy denies read
    // access to this database for the current user (and no doc_read allow rule
    // grants it), refuse to open it. Because read is the coarse gate in front
    // of every sync operation, this also prevents creating data in a database
    // the user cannot read. "directory" and the admin are exempt (handled in
    // canReadDatabase).
    if (typeof directory.canReadDatabase === "function") {
      const canRead = await directory.canReadDatabase(id);
      if (!canRead) {
        this.logger.warn(
          `Denied database open for ${currentUser.username}: no read access to database "${id}"`,
        );
        throw new Error(
          `User "${currentUser.username}" does not have read access to database "${id}".`,
        );
      }
    }
  }

  async openDB(id: string, options?: OpenDBOptions): Promise<MindooDB> {
    const validDbId = validateDatabaseId(id, "dbId");

    // Enforce admin-only mode for directory database - this is a security invariant
    // The directory database must only accept entries signed by the admin key
    const effectiveOptions: OpenDBOptions = validDbId === "directory"
      ? { ...options, adminOnlyDb: true }
      : options ?? {};
    const normalizedTimeTravelDate = this.normalizeTimeTravelDate(effectiveOptions.timeTravelDate);
    const databaseCacheKey = normalizedTimeTravelDate == null
      ? validDbId
      : `${validDbId}::tt:${normalizedTimeTravelDate}`;

    await this.assertCurrentUserCanOpenDB(validDbId);
    
    // Return cached database if it exists
    const cached = this.databaseCache.get(databaseCacheKey);
    if (cached) {
      // For directory DB, verify admin-only flag matches (defensive check)
      if (validDbId === "directory" && !cached.isAdminOnlyDb()) {
        throw new Error("Directory database was cached without adminOnlyDb - this should never happen");
      }
      // Live databases must reflect the current KeyBag state before they
      // are handed back to callers. Time-travel snapshots are immutable
      // historical views and intentionally do not participate in
      // visibility reconciliation, so we skip the call for them.
      if (normalizedTimeTravelDate == null) {
        await this.reconcileKeyBagChanges();
      }
      return cached;
    }

    // Extract store options and DB-specific options
    const {
      adminOnlyDb,
      timeTravelDate: _timeTravelDate,
      attachmentConfig,
      documentCacheConfig,
      snapshotConfig,
      performanceCallback,
      ...storeOptions
    } = effectiveOptions;
    
    // Snapshot opens can share an already-open live store instance. This keeps
    // in-memory factories usable while the snapshot DB maintains isolated state.
    const liveDbForSnapshot = normalizedTimeTravelDate == null
      ? null
      : this.databaseCache.get(validDbId);
    const { docStore, attachmentStore } = liveDbForSnapshot
      ? {
          docStore: liveDbForSnapshot.getStore(),
          attachmentStore: liveDbForSnapshot.getAttachmentStore(),
        }
      : this.storeFactory.createStore(validDbId, storeOptions);
    
    const dbLogger = this.logger.createChild("BaseMindooDB");
    const db = new BaseMindooDB(
      this, 
      docStore, 
      attachmentStore, 
      attachmentConfig,
      documentCacheConfig,
      snapshotConfig,
      adminOnlyDb ?? false,
      dbLogger,
      performanceCallback,
      normalizedTimeTravelDate,
    );
    if (this.cacheManager && normalizedTimeTravelDate == null) {
      db.setCacheManager(this.cacheManager);
    }
    await db.initialize();
    
    // Cache the database for future use
    this.databaseCache.set(databaseCacheKey, db);
    return db;
  }

  /**
   * Replay any pending KeyBag mutations for this tenant and refresh open
   * live databases so document visibility matches the current key set.
   *
   * Designed as the single barrier callers can `await` to be certain that
   * subsequent reads observe the latest add/remove of doc keys. Behaviour:
   *
   *  - Idempotent and concurrency-safe. Concurrent callers share the same
   *    in-flight reconcile via {@link keyBagReconcilePromise}, and a second
   *    call after the cursor catches up is a fast no-op.
   *  - Cursor-based. Replays from the persisted cursor in
   *    {@link keyBagChangeCursor}, so missed live notifications are
   *    automatically recovered.
   *  - Tenant-scoped. Events for other tenants in a shared KeyBag are
   *    consumed (the cursor still advances) but ignored.
   *  - Invalidates the cached tenant default key when its add/remove was
   *    observed, so the next encrypt/decrypt call re-reads the bag.
   *  - Skips time-travel databases. Those views are immutable historical
   *    cuts and never participate in visibility reconciliation.
   */
  async reconcileKeyBagChanges(): Promise<void> {
    if (this.keyBagReconcilePromise) {
      return this.keyBagReconcilePromise;
    }

    this.keyBagReconcilePromise = (async () => {
      let sawTenantDocKeyChange = false;
      let latestCursor = this.keyBagChangeCursor;

      // Consume every pending event so the cursor advances even for
      // unrelated tenants sharing the same bag. We only need to react to
      // doc keys for our own tenant though.
      for await (const event of this.keyBag.iterateChangesSince(this.keyBagChangeCursor)) {
        latestCursor = { changeSeq: event.changeSeq };
        if (event.type !== "doc" || event.tenantId !== this.tenantId) {
          continue;
        }

        sawTenantDocKeyChange = true;
        if (event.keyId === DEFAULT_TENANT_KEY_ID) {
          // The cached plaintext default key may now refer to a rotated
          // or removed version; drop it so the next access re-resolves.
          this.decryptedTenantKeyCache = undefined;
        }
      }

      this.keyBagChangeCursor = latestCursor;
      if (!sawTenantDocKeyChange) {
        return;
      }

      // Notify every open live database; time-travel views are read-only
      // historical snapshots and intentionally skip reconciliation.
      for (const db of this.databaseCache.values()) {
        if (db.isTimeTravelMode()) {
          continue;
        }
        const reconcile = (db as unknown as { reconcileKeyVisibility?: () => Promise<void> }).reconcileKeyVisibility;
        if (typeof reconcile === "function") {
          await reconcile.call(db);
        }
      }
    })();

    try {
      await this.keyBagReconcilePromise;
    } finally {
      this.keyBagReconcilePromise = null;
    }
  }

  createDocSignerFor(signKey: SigningKeyPair): MindooDocSigner {
    this.logger.debug(`Creating MindooDocSigner for signing key pair`);
    const signerLogger = this.logger.createChild("MindooDocSigner");
    return new MindooDocSigner(this, signKey, signerLogger);
  }

  private async exportJoinResponseDocKeyVersions(
    keyId: string,
    sharePassword: string
  ): Promise<JoinResponseEncryptedDocKey> {
    const scopedKeyId = `doc:${this.tenantId}:${keyId}`;
    const details = (await this.keyBag.listKeyDetails())
      .filter((detail) => detail.scopedKeyId === scopedKeyId)
      .sort((a, b) => a.versionIndex - b.versionIndex);

    if (details.length === 0) {
      throw new Error(`Failed to export document key "${keyId}" for tenant "${this.tenantId}"`);
    }

    const versions: JoinResponseEncryptedDocKeyVersion[] = [];
    for (const detail of details) {
      const encryptedKey = await this.keyBag.encryptAndExportKeyVersion(
        "doc",
        this.tenantId,
        keyId,
        detail.versionIndex,
        sharePassword
      );
      if (!encryptedKey) {
        throw new Error(
          `Failed to export document key "${keyId}" version ${detail.versionIndex} for tenant "${this.tenantId}"`
        );
      }

      const { createdAt: encryptedKeyCreatedAt, ...encryptedKeyPayload } = encryptedKey;
      versions.push({
        createdAt: detail.createdAt ?? encryptedKeyCreatedAt,
        encryptedKey: encryptedKeyPayload,
      });
    }

    return { keyId, versions };
  }

  private resolveJoinResponseDocKeyIds(options: ApproveJoinRequestOptions): string[] {
    const requestedKeyIds = options.sharedDocKeyIds ?? [PUBLIC_INFOS_KEY_ID, DEFAULT_TENANT_KEY_ID];
    const keyIds = new Set<string>();
    keyIds.add(PUBLIC_INFOS_KEY_ID);

    for (const keyId of requestedKeyIds) {
      const normalizedKeyId = keyId.trim();
      if (normalizedKeyId) {
        keyIds.add(normalizedKeyId);
      }
    }

    return [
      PUBLIC_INFOS_KEY_ID,
      ...Array.from(keyIds)
        .filter((keyId) => keyId !== PUBLIC_INFOS_KEY_ID)
        .sort((a, b) => {
          if (a === DEFAULT_TENANT_KEY_ID) return -1;
          if (b === DEFAULT_TENANT_KEY_ID) return 1;
          return a.localeCompare(b);
        }),
    ];
  }

  // ==================== Convenience Methods ====================

  /**
   * Approve a join request and produce a join response.
   */
  async approveJoinRequest(joinRequest: JoinRequest | string, options: ApproveJoinRequestOptions & { format: "uri" }): Promise<string>;
  async approveJoinRequest(joinRequest: JoinRequest | string, options: ApproveJoinRequestOptions): Promise<JoinResponse>;
  async approveJoinRequest(joinRequest: JoinRequest | string, options: ApproveJoinRequestOptions): Promise<JoinResponse | string> {
    // Parse the join request if it's a URI string
    let request: JoinRequest;
    if (typeof joinRequest === "string") {
      if (!isMindooURI(joinRequest)) {
        throw new Error("Invalid join request: expected a JoinRequest object or a mdb://join-request/... URI string");
      }
      const decoded = decodeMindooURI<JoinRequest>(joinRequest);
      if (decoded.type !== "join-request") {
        throw new Error(`Invalid URI type: expected "join-request", got "${decoded.type}"`);
      }
      request = decoded.payload;
    } else {
      request = joinRequest;
    }

    console.log(`[approveJoinRequest] Approving join request for user "${request.username}"`);
    this.logger.info(`Approving join request for user: ${request.username}`);

    // 1. Register the user in the directory
    const directory = await this.openDirectory();
    const publicUserId: PublicUserId = {
      username: request.username,
      userSigningPublicKey: request.signingPublicKey,
      userEncryptionPublicKey: request.encryptionPublicKey,
    };
    // Device label for this key pair (§6.5): an explicit admin-provided label
    // overrides the one suggested by the joining user in the request.
    const deviceLabel =
      typeof options.label === "string" && options.label.trim().length > 0
        ? options.label.trim()
        : request.label;
    await directory.registerUser(
      publicUserId,
      options.adminSigningKey,
      options.adminPassword,
      undefined,
      deviceLabel,
    );

    // 2. Export selected document keys encrypted with the share password.
    // `$publicinfos` is mandatory because the joining user needs it for
    // directory access; all selected key ids include every rotated version.
    const encryptedDocKeys = await Promise.all(
      this.resolveJoinResponseDocKeyIds(options).map((keyId) =>
        this.exportJoinResponseDocKeyVersions(keyId, options.sharePassword)
      )
    );

    // 3. Build the join response
    const joinResponse: JoinResponse = {
      v: 2,
      tenantId: this.tenantId,
      adminSigningPublicKey: this.administrationPublicKey,
      adminEncryptionPublicKey: this.administrationEncryptionPublicKey,
      encryptedDocKeys,
    };

    if (options.serverUrl) {
      joinResponse.serverUrl = options.serverUrl;
    }
    if (options.adminUsername) {
      joinResponse.adminUsername = options.adminUsername;
    }

    console.log(`[approveJoinRequest] ✓ Join request approved for user "${request.username}"`);
    this.logger.info(`Join request approved for user: ${request.username}`);

    // Return as URI string or object depending on format option
    if (options.format === "uri") {
      return encodeMindooURI("join-response", joinResponse as unknown as Record<string, unknown>);
    }

    return joinResponse;
  }

  /**
   * Publish (register) this tenant on a MindooDB server.
   *
   * When `systemAdminUser` + `systemAdminPassword` are provided the method
   * performs a challenge/response handshake against `/system/auth/*` to
   * obtain a JWT, then calls `POST /system/tenants/:tenantId`.
   */
  async publishToServer(serverUrl: string, options?: PublishToServerOptions): Promise<void> {
    console.log(`[publishToServer] Publishing tenant "${this.tenantId}" to server: ${serverUrl}`);
    this.logger.info(`Publishing tenant "${this.tenantId}" to server: ${serverUrl}`);

    const baseUrl = serverUrl.replace(/\/$/, "");

    // Export the $publicinfos key so the server can read the directory DB
    const publicInfosKeyBytes = await this.keyBag.get("doc", this.tenantId, PUBLIC_INFOS_KEY_ID);
    if (!publicInfosKeyBytes) {
      throw new Error(`Cannot publish to server: $publicinfos key not found in KeyBag`);
    }
    // Build the registration request body
    const requestBody: Record<string, unknown> = {
      adminSigningPublicKey: this.administrationPublicKey,
      adminEncryptionPublicKey: this.administrationEncryptionPublicKey,
    };
    try {
      const serverInfoResponse = await fetch(`${baseUrl}/.well-known/mindoodb-server-info`, {
        headers: {
          Accept: "application/json",
        },
      });
      let serverInfoBody: unknown = null;
      try {
        serverInfoBody = await serverInfoResponse.json();
      } catch {
        serverInfoBody = null;
      }
      if (!serverInfoResponse.ok) {
        throw new Error(
          typeof (serverInfoBody as { error?: unknown } | null)?.error === "string"
            ? (serverInfoBody as { error: string }).error
            : `Could not read ${baseUrl}/.well-known/mindoodb-server-info (HTTP ${serverInfoResponse.status}).`,
        );
      }
      if (
        !serverInfoBody
        || typeof serverInfoBody !== "object"
        || Array.isArray(serverInfoBody)
        || typeof (serverInfoBody as { encryptionPublicKey?: unknown }).encryptionPublicKey !== "string"
      ) {
        throw new Error("The server returned an invalid .well-known payload.");
      }
      const rsaEncryption = new RSAEncryption(this.cryptoAdapter);
      requestBody.encryptedPublicInfosKey = this.uint8ArrayToBase64(
        await rsaEncryption.encrypt(
          publicInfosKeyBytes,
          (serverInfoBody as { encryptionPublicKey: string }).encryptionPublicKey,
        ),
      );
    } catch (error) {
      console.warn("[publishToServer] Falling back to raw publicInfosKey transport:", error);
      requestBody.publicInfosKey = this.uint8ArrayToBase64(publicInfosKeyBytes);
    }
    if (options?.adminUsername) {
      requestBody.adminUsername = options.adminUsername;
    }

    // Add users if provided
    if (options?.registerUsers && options.registerUsers.length > 0) {
      requestBody.users = options.registerUsers.map((u) => ({
        username: u.username,
        signingPublicKey: u.userSigningPublicKey,
        encryptionPublicKey: u.userEncryptionPublicKey,
      }));
    }

    // Authenticate as system admin via challenge/response
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options?.systemAdminUser && options?.systemAdminPassword) {
      const token = await this.authenticateAsSystemAdmin(
        baseUrl,
        options.systemAdminUser,
        options.systemAdminPassword,
      );
      headers["Authorization"] = `Bearer ${token}`;
    }

    // POST to /system/tenants/:tenantId
    const url = `${baseUrl}/system/tenants/${encodeURIComponent(this.tenantId)}`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Failed to publish tenant to server (HTTP ${response.status}): ${errorBody}`
      );
    }

    console.log(`[publishToServer] ✓ Tenant "${this.tenantId}" published to server successfully`);
    this.logger.info(`Tenant "${this.tenantId}" published to server successfully`);
  }

  /**
   * Perform system admin challenge/response auth and return a JWT token.
   */
  private async authenticateAsSystemAdmin(
    baseUrl: string,
    adminUser: PrivateUserId,
    adminPassword: string,
  ): Promise<string> {
    const subtle = this.cryptoAdapter.getSubtle();

    // Decrypt the admin's signing private key
    const signingKeyBuffer = await this.decryptPrivateKey(
      adminUser.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      adminPassword,
      "signing",
    );
    const signingKey = await subtle.importKey(
      "pkcs8",
      signingKeyBuffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );

    // Step 1: Request challenge from server
    const challengeRes = await fetch(`${baseUrl}/system/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: adminUser.username,
        publicsignkey: adminUser.userSigningKeyPair.publicKey,
      }),
    });

    if (!challengeRes.ok) {
      const errorBody = await challengeRes.text();
      throw new Error(
        `System admin challenge failed (HTTP ${challengeRes.status}): ${errorBody}`,
      );
    }

    const { challenge } = (await challengeRes.json()) as { challenge: string };

    // Step 2: Sign the challenge
    const messageBytes = new TextEncoder().encode(challenge);
    const signatureBuffer = await subtle.sign(
      { name: "Ed25519" },
      signingKey,
      messageBytes,
    );
    const signatureBase64 = this.uint8ArrayToBase64(new Uint8Array(signatureBuffer));

    // Step 3: Authenticate
    const authRes = await fetch(`${baseUrl}/system/auth/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, signature: signatureBase64 }),
    });

    if (!authRes.ok) {
      const errorBody = await authRes.text();
      throw new Error(
        `System admin authentication failed (HTTP ${authRes.status}): ${errorBody}`,
      );
    }

    const result = (await authRes.json()) as {
      success: boolean;
      token?: string;
      error?: string;
    };
    if (!result.success || !result.token) {
      throw new Error(
        `System admin authentication failed: ${result.error || "unknown error"}`,
      );
    }

    return result.token;
  }

  /**
   * Create a remote store connected to a MindooDB server, ready for sync.
   */
  async connectToServer(
    serverUrl: string,
    dbId: string,
    storeKind: StoreKind = StoreKind.docs,
  ): Promise<ContentAddressedStore> {
    const validDbId = validateDatabaseId(dbId, "dbId");

    console.log(`[connectToServer] Connecting to server: ${serverUrl}, db: ${validDbId}, storeKind: ${storeKind}`);
    this.logger.info(`Connecting to server: ${serverUrl}, db: ${validDbId}, storeKind: ${storeKind}`);

    const normalizedServerUrl = serverUrl.replace(/\/$/, "");
    const cacheKey = `${normalizedServerUrl}::${validDbId}::${storeKind}`;
    const cachedStore = this.remoteStoreCache.get(cacheKey);
    if (cachedStore) {
      this.logger.debug(`Reusing cached remote store for ${normalizedServerUrl}, db: ${validDbId}`);
      return cachedStore;
    }

    const remoteStorePromise = (async () => {
      // Lazy-import network modules to avoid circular dependencies and keep core lightweight
      const { HttpTransport } = await import("../appendonlystores/network/HttpTransport.js");
      const { ClientNetworkContentAddressedStore } = await import(
        "../appendonlystores/network/ClientNetworkContentAddressedStore.js"
      );

      // Create the HTTP transport
      const baseUrl = `${normalizedServerUrl}/${this.tenantId}`;
      const transport = new HttpTransport(
        {
          baseUrl,
          tenantId: this.tenantId,
          dbId: validDbId,
          storeKind,
        },
        this.logger.createChild("HttpTransport")
      );

      // Get the current user's decrypted signing key
      const signingKey = await this.getDecryptedSigningKey();

      // Get the current user's decrypted RSA encryption private key (for decrypting entries)
      const decryptedEncryptionKey = await this.getDecryptedEncryptionKey();

      // Create the client network store
      const store = new ClientNetworkContentAddressedStore(
        validDbId,
        storeKind,
        transport,
        this.cryptoAdapter,
        this.currentUser.username,
        signingKey,
        decryptedEncryptionKey,
        this.logger.createChild(`ClientNetworkStore:${validDbId}:${storeKind}`)
      );

      console.log(`[connectToServer] ✓ Connected to server for db "${validDbId}"`);
      this.logger.info(`Connected to server for db "${validDbId}"`);

      return store;
    })();

    this.remoteStoreCache.set(cacheKey, remoteStorePromise);
    try {
      return await remoteStorePromise;
    } catch (error) {
      this.remoteStoreCache.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Internal method to get the decrypted signing key for the current user.
   * Protected so that connectToServer() helper and subclasses can access it.
   */
  protected async getDecryptedSigningKey(): Promise<CryptoKey> {
    // Use cached signing key if available
    if (this.decryptedUserSigningKeyCache) {
      return this.decryptedUserSigningKeyCache;
    }

    // Decrypt the user's signing private key
    const decryptedKeyBuffer = await this.decryptPrivateKey(
      this.currentUser.userSigningKeyPair.privateKey,
      this.currentUserPassword,
      "signing"
    );

    const subtle = this.cryptoAdapter.getSubtle();

    // Import the decrypted key as an Ed25519 private key
    const cryptoKey = await subtle.importKey(
      "pkcs8",
      decryptedKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["sign"]
    );

    this.decryptedUserSigningKeyCache = cryptoKey;
    return cryptoKey;
  }

  /**
   * Internal method to get the decrypted RSA encryption private key for the current user.
   * Used by connectToServer() to create the network store.
   */
  private async getDecryptedEncryptionKey(): Promise<CryptoKey> {
    if (this.decryptedUserEncryptionKeyCache) {
      return this.decryptedUserEncryptionKeyCache;
    }

    const decryptedKeyBuffer = await this.decryptPrivateKey(
      this.currentUser.userEncryptionKeyPair.privateKey,
      this.currentUserPassword,
      "encryption"
    );

    const subtle = this.cryptoAdapter.getSubtle();

    const cryptoKey = await subtle.importKey(
      "pkcs8",
      decryptedKeyBuffer,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"]
    );

    this.decryptedUserEncryptionKeyCache = cryptoKey;
    return cryptoKey;
  }

  /**
   * Inject an already-unlocked RSA-OAEP encryption private key for the current
   * user, priming the same cache {@link getDecryptedEncryptionKey} uses. Hosts
   * that create the tenant password-less (e.g. Haven, which holds the unlocked
   * key in its session rather than a password) call this so SDK-driven KeyBag
   * reconcile can unwrap pushed key versions (docs/accesscontrol.md §13).
   */
  setSessionEncryptionKey(cryptoKey: CryptoKey): void {
    this.decryptedUserEncryptionKeyCache = cryptoKey;
  }

  /**
   * The RSA-OAEP encryption private key used by KeyBag reconcile to unwrap
   * pushed key versions. Returns the injected/cached session key when present,
   * else derives it from the current user password. Returns `null` when neither
   * is available (a locked, password-less host) so reconcile can skip its import
   * pass without throwing — the revoke pass needs no key and still runs.
   */
  async getEncryptionPrivateKeyForReconcile(): Promise<CryptoKey | null> {
    if (this.decryptedUserEncryptionKeyCache) {
      return this.decryptedUserEncryptionKeyCache;
    }
    try {
      return await this.getDecryptedEncryptionKey();
    } catch (error) {
      this.logger.debug(
        `getEncryptionPrivateKeyForReconcile: no encryption key available (locked host): ${error}`,
      );
      return null;
    }
  }

  /**
   * Internal method to decrypt a private key using password-based key derivation.
   * Protected so that BaseMindooTenantDirectory can access it.
   * 
   * @param encryptedKey The encrypted private key
   * @param password The password to decrypt the key
   * @param saltString The salt string for key derivation (e.g., "signing", "encryption", "administration", keyId)
   *                   This is combined with the encryptedKey.salt for additional security
   * @returns The decrypted private key as ArrayBuffer
   */
  public async decryptPrivateKey(
    encryptedKey: EncryptedPrivateKey,
    password: string,
    saltString: string
  ): Promise<ArrayBuffer> {
    // Do NOT log the password length or KDF iteration count (audit, Medium:
    // sensitive debug logging) — both narrow an offline cracking search space.
    this.logger.debug(`decryptPrivateKey: Starting decryption (keyCategory: ${saltString})`);
    this.logger.debug(`decryptPrivateKey: Delegating PBKDF2 + AES-GCM work to shared helper`);
    try {
      const decrypted = await decryptPrivateKeyWithPassword(
        this.cryptoAdapter,
        encryptedKey,
        password,
        saltString,
      );
      this.logger.debug(`decryptPrivateKey: Successfully decrypted, result length: ${decrypted.byteLength} bytes`);
      return decrypted;
    } catch (error) {
      this.logger.error(`decryptPrivateKey: Error during decryption:`, error);
      this.logger.error(`decryptPrivateKey: Error details:`, {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        iterations: encryptedKey.iterations,
        saltString,
      });
      throw error;
    }
  }

  /**
   * Helper method to convert base64 string to Uint8Array
   * Protected so that BaseMindooTenantDirectory can access it.
   */
  protected base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Helper method to convert Uint8Array to base64 string
   * Protected so that BaseMindooTenantDirectory can access it.
   */
  public uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Helper method to convert PEM format to ArrayBuffer
   * Removes PEM headers/footers and decodes base64 content
   * Public so that MindooDocSigner and other utilities can use it.
   */
  public pemToArrayBuffer(pem: string): ArrayBuffer {
    // Remove PEM headers and footers
    const pemHeader = "-----BEGIN PUBLIC KEY-----";
    const pemFooter = "-----END PUBLIC KEY-----";
    
    let base64 = pem
      .replace(pemHeader, "")
      .replace(pemFooter, "")
      .replace(/\s/g, ""); // Remove all whitespace (newlines, spaces, etc.)

    // Decode base64 to binary string
    const binary = atob(base64);
    
    // Convert binary string to Uint8Array
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    return bytes.buffer;
  }

  // ============================================================================
  // Attachment Encryption Methods
  // ============================================================================

  /**
   * Encryption mode byte values for attachment payloads.
   * 0x00 = Random IV (more secure, no deduplication)
   * 0x01 = Deterministic IV (enables deduplication, reveals identical content)
   */
  protected static readonly ENCRYPTION_MODE_RANDOM = 0x00;
  protected static readonly ENCRYPTION_MODE_DETERMINISTIC = 0x01;

  /**
   * Check whether the symmetric key for the given key ID is available in the KeyBag.
   * This is a lightweight probe that does not perform any crypto operations.
   * 
   * @param decryptionKeyId The key ID ("default" or a named key ID)
   * @returns true if the key can be resolved, false otherwise
   */
  async hasDecryptionKey(decryptionKeyId: string): Promise<boolean> {
    try {
      await this.getSymmetricKey(decryptionKeyId);
      return true;
    } catch (error) {
      if (error instanceof SymmetricKeyNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Stable fingerprint of the doc-type keys this tenant currently has
   * access to, delegating to {@link KeyBag.getDocKeyFingerprint} scoped
   * to this tenant. Persisted by {@link BaseMindooDB} alongside its cache
   * checkpoint so warm starts can skip a full metadata scan when the
   * KeyBag composition has not changed.
   */
  async getDocKeyFingerprint(): Promise<string> {
    return this.keyBag.getDocKeyFingerprint(this.tenantId);
  }

  /**
   * Remove a **named** document key from the local KeyBag. Refuses to delete the
   * shared tenant default key (`"default"` / {@link DEFAULT_TENANT_KEY_ID}),
   * which is required for the tenant to function. Returns true if a key was
   * removed.
   */
  async removeNamedDecryptionKey(decryptionKeyId: string): Promise<boolean> {
    if (decryptionKeyId === "default" || decryptionKeyId === DEFAULT_TENANT_KEY_ID) {
      this.logger.debug(`removeNamedDecryptionKey: refusing to delete the tenant default key`);
      return false;
    }
    try {
      await this.keyBag.deleteKey("doc", this.tenantId, decryptionKeyId);
      this.invalidateDecryptedKeyCaches();
      return true;
    } catch (error) {
      this.logger.warn(`removeNamedDecryptionKey: failed to delete key ${decryptionKeyId}: ${error}`);
      return false;
    }
  }

  /**
   * Reconcile the local KeyBag against the directory head for the current user
   * (docs/accesscontrol.md §13). SDK-driven so standalone apps using the
   * `mindoodb` package get key distribution/revocation automatically after a
   * directory sync — not just the Haven UI. Two independent passes:
   *
   *  - **Revoke (no key required):** bulk-remove every revoked key id (from the
   *    directory head cache) from the bag. Idempotent and a no-op when the bag
   *    does not hold the key, so it also re-cleans a restored older KeyBag
   *    backup on every run. The `deleteKey` mutation drives visibility
   *    reconciliation (forgetting now-inaccessible docs) and emits
   *    `keyBag.onChanges` so the host can persist the cleaned bag.
   *  - **Import (needs the encryption private key):** unwrap and merge the key
   *    versions pushed to this user. Skipped with a debug log when the host is
   *    locked (no session key / password); the revoke pass still ran.
   *
   * Best-effort and idempotent; safe to call on every directory bring-up / pull.
   * Returns the key ids imported and removed.
   */
  async reconcileKeyDistributionsForCurrentUser(): Promise<{
    imported: string[];
    removed: string[];
  }> {
    const username = this.currentUser.username;
    const directory = await this.openDirectory();
    const removed: string[] = [];
    const imported: string[] = [];

    // Revoke pass — no key, no comparison, idempotent.
    if (typeof directory.getRevokedDecryptionKeyIdsForUser === "function") {
      let revokedIds: string[] = [];
      try {
        revokedIds = await directory.getRevokedDecryptionKeyIdsForUser(username);
      } catch (error) {
        this.logger.warn(
          `reconcileKeyDistributionsForCurrentUser: revoked-id lookup failed: ${error}`,
        );
      }
      for (const keyId of revokedIds) {
        if (await this.removeNamedDecryptionKey(keyId)) {
          removed.push(keyId);
        }
      }
    }

    // Import pass — sources the encryption private key from this tenant. The
    // directory exposes this only via the internal KeyBagReconciler contract,
    // so the key is never passed across the public directory API.
    const reconciler = directory as unknown as Partial<KeyBagReconciler>;
    if (typeof reconciler.reconcileImportedKeysForCurrentUser === "function") {
      try {
        const result = await reconciler.reconcileImportedKeysForCurrentUser(username);
        imported.push(...result.imported);
        for (const id of result.removed) {
          if (!removed.includes(id)) removed.push(id);
        }
      } catch (error) {
        this.logger.warn(
          `reconcileKeyDistributionsForCurrentUser: import pass failed: ${error}`,
        );
      }
    }

    return { imported, removed };
  }

  /**
   * Single-flight, best-effort wrapper around
   * {@link reconcileKeyDistributionsForCurrentUser} for the run-always trigger
   * (docs/accesscontrol.md §13). Fired on directory bring-up and after every
   * directory pull. Never throws and never blocks sync: a reconcile error is
   * logged and swallowed. The in-flight guard prevents the driver's own
   * directory access from re-triggering it.
   */
  async reconcileKeyDistributionsForCurrentUserSafe(): Promise<void> {
    if (this.reconcileInFlight) {
      return;
    }
    this.reconcileInFlight = true;
    try {
      await this.reconcileKeyDistributionsForCurrentUser();
    } catch (error) {
      this.logger.warn(`reconcileKeyDistributionsForCurrentUserSafe: ${error}`);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /**
   * Export **all** stored versions of a document key for an admin-blind key
   * delivery (read-side key push). A rotated key keeps multiple versions in the
   * KeyBag and decryption tries them all, so a delivery must carry every version
   * - otherwise the recipient could not read documents encrypted under an
   * earlier version. Each entry pairs the raw key bytes with the version's
   * `createdAt` (used as `keyVersionCreatedAt`); versions are newest-first.
   * Returns null when the caller's KeyBag lacks the key. Only a key-holder can
   * run this — never the admin who later publishes the wrapped bytes.
   */
  async exportDecryptionKeyForDelivery(
    decryptionKeyId: string,
  ): Promise<Array<{ bytes: Uint8Array; keyVersionCreatedAt: number }> | null> {
    const id = decryptionKeyId === "default" ? DEFAULT_TENANT_KEY_ID : decryptionKeyId;
    const versions = await this.keyBag.getAllKeyVersions("doc", this.tenantId, id);
    if (versions.length === 0) {
      return null;
    }
    return versions.map((v) => ({ bytes: v.key, keyVersionCreatedAt: v.createdAt ?? 0 }));
  }

  /**
   * Import a delivered document key into the local KeyBag (read-side key push,
   * recipient side). Writing the key triggers the existing KeyBag change
   * listener -> {@link reconcileKeyBagChanges} -> per-database reveal-on-add, so
   * documents encrypted with it surface automatically. Idempotent: a key
   * version with the same `keyVersionCreatedAt` is not duplicated.
   */
  async importDeliveredDecryptionKey(
    keyId: string,
    bytes: Uint8Array,
    keyVersionCreatedAt: number,
  ): Promise<void> {
    await this.importDeliveredDecryptionKeyVersions(keyId, [{ bytes, keyVersionCreatedAt }]);
  }

  /**
   * Import several delivered versions of one document key at once (read-side key
   * push, recipient side). Each version absent from the KeyBag (matched by
   * `keyVersionCreatedAt`) is added; already-present versions are skipped so the
   * call is idempotent. Caches are invalidated and reveal-on-add reconciliation
   * runs once, after all new versions are written. Returns the number of
   * versions actually imported.
   */
  async importDeliveredDecryptionKeyVersions(
    keyId: string,
    versions: Array<{ bytes: Uint8Array; keyVersionCreatedAt: number }>,
  ): Promise<number> {
    const id = keyId === "default" ? DEFAULT_TENANT_KEY_ID : keyId;
    const scopedKeyId = `doc:${this.tenantId}:${id}`;
    const existing = await this.keyBag.listKeyDetails();
    const haveStamps = new Set(
      existing.filter((d) => d.scopedKeyId === scopedKeyId).map((d) => d.createdAt ?? 0),
    );
    let importedCount = 0;
    for (const version of versions) {
      if (haveStamps.has(version.keyVersionCreatedAt)) {
        this.logger.debug(`importDeliveredDecryptionKeyVersions: ${keyId}@${version.keyVersionCreatedAt} already present`);
        continue;
      }
      await this.keyBag.set("doc", this.tenantId, id, version.bytes, version.keyVersionCreatedAt || undefined);
      haveStamps.add(version.keyVersionCreatedAt);
      importedCount++;
    }
    if (importedCount > 0) {
      this.invalidateDecryptedKeyCaches();
      await this.reconcileKeyBagChanges();
    }
    return importedCount;
  }

  /** SHA-256 hex of raw key bytes — the stable version fingerprint used by key distribution. */
  async fingerprintKeyBytes(bytes: Uint8Array): Promise<string> {
    const subtle = this.getCryptoAdapter().getSubtle();
    const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * All stored versions of a document key with their raw bytes, `createdAt`, and
   * SHA-256 fingerprint (newest first). The source of truth for a key
   * distribution's `keyVersions` manifest and per-device wrapping. Empty when the
   * caller's KeyBag lacks the key.
   */
  async fingerprintKeyVersions(
    keyId: string,
  ): Promise<Array<{ bytes: Uint8Array; createdAt: number; fingerprint: string }>> {
    const id = keyId === "default" ? DEFAULT_TENANT_KEY_ID : keyId;
    const versions = await this.keyBag.getAllKeyVersions("doc", this.tenantId, id);
    const result: Array<{ bytes: Uint8Array; createdAt: number; fingerprint: string }> = [];
    for (const v of versions) {
      result.push({
        bytes: v.key,
        createdAt: v.createdAt ?? 0,
        fingerprint: await this.fingerprintKeyBytes(v.key),
      });
    }
    return result;
  }

  /**
   * Remove exactly the key versions of `keyId` whose raw-bytes fingerprint is in
   * `fingerprints` (version-scoped `pullfrom` revocation). Versions obtained
   * elsewhere — i.e. not in the distribution manifest — survive. Refuses the
   * protected tenant default / `$publicinfos` keys. The KeyBag change feed
   * triggers visibility reconciliation (scope purge when nothing remains).
   * Returns the number of versions removed.
   */
  async removeDecryptionKeyVersionsByFingerprint(
    keyId: string,
    fingerprints: string[],
  ): Promise<number> {
    if (keyId === "default" || keyId === DEFAULT_TENANT_KEY_ID || keyId === PUBLIC_INFOS_KEY_ID) {
      this.logger.debug(`removeDecryptionKeyVersionsByFingerprint: refusing protected key ${keyId}`);
      return 0;
    }
    const target = new Set(fingerprints);
    if (target.size === 0) return 0;
    const id = keyId === "default" ? DEFAULT_TENANT_KEY_ID : keyId;
    let removed = 0;
    // Re-read versions each pass: deleteKeyVersion is index-based against the
    // current sorted list, which shifts as entries are removed.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const versions = await this.keyBag.getAllKeyVersions("doc", this.tenantId, id);
      let removedThisPass = false;
      for (let index = 0; index < versions.length; index++) {
        const fp = await this.fingerprintKeyBytes(versions[index].key);
        if (target.has(fp)) {
          await this.keyBag.deleteKeyVersion("doc", this.tenantId, id, index);
          removed++;
          removedThisPass = true;
          break;
        }
      }
      if (!removedThisPass) break;
    }
    if (removed > 0) {
      this.invalidateDecryptedKeyCaches();
      await this.reconcileKeyBagChanges();
    }
    return removed;
  }

  /** Clear in-memory decrypted-key caches after a KeyBag mutation. */
  private invalidateDecryptedKeyCaches(): void {
    this.decryptedTenantKeyCache = undefined;
  }

  /**
   * Get the symmetric key for a given key ID.
   * This is a protected helper method that can be used by subclasses.
   * 
   * @param decryptionKeyId The key ID ("default" or a named key ID)
   * @returns The decrypted symmetric key bytes
   */
  protected async getSymmetricKey(decryptionKeyId: string): Promise<Uint8Array> {
    if (decryptionKeyId === "default") {
      // Use cached tenant encryption key if available
      if (this.decryptedTenantKeyCache) {
        return this.decryptedTenantKeyCache;
      }
      const tenantKey = await this.keyBag.get("doc", this.tenantId, DEFAULT_TENANT_KEY_ID);
      if (!tenantKey) {
        throw new SymmetricKeyNotFoundError(`doc:${this.tenantId}:${DEFAULT_TENANT_KEY_ID}`);
      }
      const symmetricKey = tenantKey;
      this.decryptedTenantKeyCache = symmetricKey;
      return symmetricKey;
    } else {
      // Get the decrypted key from KeyBag
      const decryptedKey = await this.keyBag.get("doc", this.tenantId, decryptionKeyId);
      if (!decryptedKey) {
        throw new SymmetricKeyNotFoundError(decryptionKeyId);
      }
      return decryptedKey;
    }
  }

  /**
   * Configuration method that determines whether to use deterministic encryption for attachments.
   * Subclasses can override this to change the default behavior.
   * 
   * When true (default):
   * - Same plaintext + same key = same ciphertext (enables deduplication)
   * - Reveals when identical content is stored
   * 
   * When false:
   * - Each encryption produces unique ciphertext
   * - No deduplication possible
   * - More secure for sensitive content
   * 
   * @returns True to use deterministic encryption, false for random IV
   */
  protected usesDeterministicAttachmentEncryption(): boolean {
    return true; // Default: enable deduplication
  }

  /**
   * Encrypt an attachment payload with the appropriate encryption mode.
   * Uses mode prefix format: [mode byte][IV (12 bytes)][encrypted data + tag]
   * 
   * For deterministic mode (0x01), the IV is derived from SHA-256(plaintext)[:12]
   * For random mode (0x00), the IV is randomly generated
   * 
   * @param payload The plaintext attachment data
   * @param decryptionKeyId The key ID for encryption
   * @returns The encrypted payload with mode prefix
   */
  async encryptAttachmentPayload(
    payload: Uint8Array,
    decryptionKeyId: string
  ): Promise<Uint8Array> {
    this.logger.debug(`Encrypting attachment payload with key: ${decryptionKeyId}`);
    
    const symmetricKey = await this.getSymmetricKey(decryptionKeyId);
    const subtle = this.cryptoAdapter.getSubtle();
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);
    
    // Import the symmetric key
    const keyArray = new Uint8Array(symmetricKey);
    const cryptoKey = await subtle.importKey(
      "raw",
      keyArray.buffer,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );

    // Determine encryption mode and generate IV accordingly
    const useDeterministic = this.usesDeterministicAttachmentEncryption();
    const mode = useDeterministic 
      ? BaseMindooTenant.ENCRYPTION_MODE_DETERMINISTIC 
      : BaseMindooTenant.ENCRYPTION_MODE_RANDOM;
    
    let iv: Uint8Array;
    if (useDeterministic) {
      // Deterministic IV: derive from plaintext hash
      // IV = SHA-256(plaintext)[:12]
      const payloadBuffer = payload.buffer.slice(
        payload.byteOffset, 
        payload.byteOffset + payload.byteLength
      ) as ArrayBuffer;
      const hashBuffer = await subtle.digest("SHA-256", payloadBuffer);
      iv = new Uint8Array(hashBuffer).slice(0, 12);
      this.logger.debug(`Using deterministic IV derived from content hash`);
    } else {
      // Random IV
      iv = new Uint8Array(12);
      randomValues(iv);
      this.logger.debug(`Using random IV`);
    }

    // Encrypt the payload
    const payloadArray = new Uint8Array(payload);
    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        tagLength: 128,
      },
      cryptoKey,
      payloadArray
    );

    // Combine: mode byte (1) + IV (12) + encrypted data
    const encryptedArray = new Uint8Array(encrypted);
    const result = new Uint8Array(1 + 12 + encryptedArray.length);
    result[0] = mode;
    result.set(iv, 1);
    result.set(encryptedArray, 13);

    this.logger.debug(`Encrypted attachment (mode=${mode}, ${payload.length} -> ${result.length} bytes)`);
    return result;
  }

  /**
   * Decrypt an attachment payload that was encrypted with encryptAttachmentPayload.
   * Reads the mode prefix to determine which decryption method to use.
   * 
   * @param encryptedPayload The encrypted payload with mode prefix
   * @param decryptionKeyId The key ID for decryption
   * @returns The decrypted plaintext
   */
  async decryptAttachmentPayload(
    encryptedPayload: Uint8Array,
    decryptionKeyId: string
  ): Promise<Uint8Array> {
    this.logger.debug(`Decrypting attachment payload with key: ${decryptionKeyId}`);
    
    if (encryptedPayload.length < 13) {
      throw new Error("Invalid encrypted attachment payload: too short");
    }

    // Read mode byte
    const mode = encryptedPayload[0];
    if (mode !== BaseMindooTenant.ENCRYPTION_MODE_RANDOM && 
        mode !== BaseMindooTenant.ENCRYPTION_MODE_DETERMINISTIC) {
      throw new Error(`Invalid encryption mode: ${mode}`);
    }
    this.logger.debug(`Decrypting attachment with mode=${mode}`);

    // Extract IV (bytes 1-12)
    const iv = encryptedPayload.slice(1, 13);
    
    // Extract ciphertext (bytes 13 onwards)
    const ciphertext = encryptedPayload.slice(13);

    // Try every stored version of the key (newest first) so attachments
    // encrypted under an earlier rotation of the key still decrypt.
    const candidates = await this.getDecryptionKeyCandidates(decryptionKeyId);
    if (candidates.length === 0) {
      throw new SymmetricKeyNotFoundError(
        decryptionKeyId === "default" ? `doc:${this.tenantId}:${DEFAULT_TENANT_KEY_ID}` : decryptionKeyId,
      );
    }
    const subtle = this.cryptoAdapter.getSubtle();
    let lastError: unknown = undefined;
    for (const symmetricKey of candidates) {
      try {
        const cryptoKey = await subtle.importKey(
          "raw",
          new Uint8Array(symmetricKey).buffer,
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );
        const decrypted = await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            tagLength: 128,
          },
          cryptoKey,
          ciphertext as BufferSource,
        );
        const result = new Uint8Array(decrypted);
        this.logger.debug(`Decrypted attachment (${encryptedPayload.length} -> ${result.length} bytes)`);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    this.logger.debug(`Attachment decrypt failed against all ${candidates.length} version(s) of key "${decryptionKeyId}"`);
    throw lastError ?? new SymmetricKeyNotFoundError(decryptionKeyId);
  }
}

