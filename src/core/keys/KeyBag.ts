import { DEFAULT_TENANT_KEY_ID, EncryptedPrivateKey } from "../types";
import { type KeyType, buildKeyDerivationSalt, buildScopedKeyId } from "./KeyContext";
import { CryptoAdapter } from "../crypto/CryptoAdapter";
import { DEFAULT_PBKDF2_ITERATIONS, resolvePbkdf2Iterations } from "../crypto/pbkdf2Iterations";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * Internal structure for storing a key with optional creation timestamp.
 */
interface KeyEntry {
  key: Uint8Array;
  createdAt?: number; // milliseconds since Unix epoch
}

/**
 * Opaque cursor into the {@link KeyBag} local changes feed.
 *
 * `changeSeq` is a monotonic in-memory sequence number assigned to each
 * doc-key mutation by {@link KeyBag.recordKeyChange}. The sequence is
 * local to a single `KeyBag` instance and resets when the bag is
 * recreated; cursors must therefore not be persisted across process
 * restarts.
 */
export interface KeyBagChangeCursor {
  changeSeq: number;
}

/**
 * High-level intent of a doc-key mutation event emitted by the {@link KeyBag}
 * local changes feed. The action describes what the caller did to the bag,
 * not whether a key remains afterwards (see {@link KeyBagChangeEvent.hasKey}).
 */
export type KeyBagChangeAction = "add" | "remove";

/**
 * One event in the local {@link KeyBag} changes feed.
 *
 * Events are emitted by {@link KeyBag.set}, {@link KeyBag.createDocKey},
 * {@link KeyBag.createTenantKey}, {@link KeyBag.decryptAndImportKey},
 * {@link KeyBag.deleteKey}, and {@link KeyBag.deleteKeyVersion} whenever the
 * set of available doc-key versions for a scoped key id actually changes.
 *
 * Events intentionally never carry raw key bytes: they are designed to be
 * safe to pass through telemetry, listeners, and tests without expanding the
 * exposure surface of secret material.
 */
export interface KeyBagChangeEvent {
  /** Monotonic local sequence number assigned at emit time. */
  changeSeq: number;
  /** Scoped key type (currently always `"doc"`). */
  type: KeyType;
  /** Tenant the affected key belongs to. */
  tenantId: string;
  /** Key identifier within the tenant (e.g. `"default"`, `"$publicinfos"`, or a named key id). */
  keyId: string;
  /** Whether the caller added a key version or removed one. */
  action: KeyBagChangeAction;
  /** Number of remaining stored versions for this scoped key id after the mutation. */
  versionsRemaining: number;
  /** Convenience flag equal to `versionsRemaining > 0`. */
  hasKey: boolean;
}

/**
 * Listener callback registered through {@link KeyBag.onChanges}.
 *
 * Listener invocations happen synchronously from the mutating call site
 * after the underlying key store has been updated. Listeners must be
 * short-lived; long-running work should be deferred (`void`-prefixed
 * promises or microtask scheduling are recommended).
 */
export type KeyBagChangeListener = (event: KeyBagChangeEvent) => void;

export interface KeyDetail {
  scopedKeyId: string;
  createdAt?: number;
  keyLengthBits: number;
  versionIndex: number;
}

/**
 * Options accepted by {@link KeyBag.constructor} when constructing a KeyBag from
 * an already-derived AES-GCM wrapping {@link CryptoKey}.
 *
 * Prefer this form over the legacy password-taking constructor: the wrapping
 * key can be derived once during user login (via {@link KeyBag.deriveWrappingKey})
 * and held as a non-extractable {@link CryptoKey} for the lifetime of the
 * session, so {@link KeyBag.save} and {@link KeyBag.load} no longer need to
 * re-run PBKDF2 or hold the plaintext password in memory.
 */
export interface KeyBagWrappingKeyOptions {
  /**
   * The AES-GCM {@link CryptoKey} used to encrypt/decrypt the persisted KeyBag
   * blob. Must have `usages` including `["encrypt", "decrypt"]`. Typically
   * imported with `extractable: false` to avoid the raw bytes leaking into
   * the JS heap.
   */
  wrappingKey: CryptoKey;
  /** Crypto adapter to use for encryption and decryption. */
  cryptoAdapter: CryptoAdapter;
  /** Optional logger instance. */
  logger?: Logger;
}

/**
 * The KeyBag is used to store encryption keys that the current user has access to
 * in order to decrypt document changes stored in the AppendOnlyStore.
 * Supports key rotation by storing multiple versions per keyId (newest first).
 *
 * Two construction modes are supported:
 *  - Legacy: pass `(userEncryptionKey, password, cryptoAdapter, ...)`. Each
 *    {@link save} / {@link load} call re-derives the AES-GCM wrapping key from
 *    `password` via PBKDF2. Required `password` is held by the instance for
 *    its lifetime.
 *  - Preferred: pass `({ wrappingKey, cryptoAdapter, ... })`. The caller has
 *    already derived the wrapping key (e.g. via {@link deriveWrappingKey})
 *    and the bag never sees the password. PBKDF2 runs zero times in this
 *    mode, and the bag is safe to persist/restore from storage repeatedly
 *    without password-handling overhead.
 */
export class KeyBag {
  private userEncryptionKey: EncryptedPrivateKey | null;
  private userEncryptionKeyPassword: string | null;
  private wrappingKey: CryptoKey | null;
  private keys: Map<string, KeyEntry[]> = new Map();
  /**
   * In-memory append-only log of doc-key mutations applied to this bag.
   *
   * Used by {@link iterateChangesSince} and {@link getLatestChangeCursor}
   * so consumers (notably {@link BaseMindooTenant}) can reconcile state
   * from a cursor even if they missed live listener notifications.
   *
   * Bound by the number of doc-key mutations per session, which in
   * practice is small (one entry per add/remove/version change).
   */
  private keyChanges: KeyBagChangeEvent[] = [];
  private nextKeyChangeSeq = 1;
  private changeListeners: Set<KeyBagChangeListener> = new Set();
  private cryptoAdapter: CryptoAdapter;
  private logger: Logger;

  /**
   * Creates a KeyBag from a user encryption key + password (legacy form).
   *
   * @deprecated Prefer the wrapping-key constructor overload. The password
   *   form holds the plaintext password for the lifetime of the bag and
   *   re-runs PBKDF2 on every {@link save}/{@link load} call.
   *
   * @param userEncryptionKey The encrypted user encryption key (provides
   *   the salt used for KeyBag wrapping-key derivation).
   * @param userEncryptionKeyPassword The password to derive the KeyBag
   *   wrapping key.
   * @param cryptoAdapter The crypto adapter to use for encryption and
   *   decryption.
   * @param logger Optional logger instance.
   */
  constructor(userEncryptionKey: EncryptedPrivateKey, userEncryptionKeyPassword: string, cryptoAdapter: CryptoAdapter, logger?: Logger);
  /**
   * Creates a KeyBag from a pre-derived AES-GCM wrapping {@link CryptoKey}.
   *
   * Recommended for production use: derive `wrappingKey` once at login via
   * {@link KeyBag.deriveWrappingKey} and reuse it across {@link save}/{@link load}.
   * No plaintext password is retained by the bag in this mode.
   */
  constructor(options: KeyBagWrappingKeyOptions);
  constructor(
    userEncryptionKeyOrOptions: EncryptedPrivateKey | KeyBagWrappingKeyOptions,
    userEncryptionKeyPassword?: string,
    cryptoAdapter?: CryptoAdapter,
    logger?: Logger,
  ) {
    if (KeyBag.isWrappingKeyOptions(userEncryptionKeyOrOptions)) {
      this.userEncryptionKey = null;
      this.userEncryptionKeyPassword = null;
      this.wrappingKey = userEncryptionKeyOrOptions.wrappingKey;
      this.cryptoAdapter = userEncryptionKeyOrOptions.cryptoAdapter;
      this.logger =
        userEncryptionKeyOrOptions.logger
        || new MindooLogger(getDefaultLogLevel(), "KeyBag", true);
      return;
    }

    if (userEncryptionKeyPassword === undefined || cryptoAdapter === undefined) {
      throw new Error("KeyBag legacy constructor requires (userEncryptionKey, password, cryptoAdapter, logger?).");
    }
    this.userEncryptionKey = userEncryptionKeyOrOptions;
    this.userEncryptionKeyPassword = userEncryptionKeyPassword;
    this.wrappingKey = null;
    this.cryptoAdapter = cryptoAdapter;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "KeyBag", true);
  }

  /**
   * Derives the AES-GCM wrapping {@link CryptoKey} that {@link KeyBag.save}
   * and {@link KeyBag.load} use to encrypt/decrypt the persisted bag blob.
   *
   * This runs PBKDF2 once with the same parameters the legacy constructor
   * uses internally (combined salt = `userEncryptionKey.salt` +
   * `"key-bag-encryption"`, iterations from
   * {@link resolvePbkdf2Iterations}), so a key derived here is fully
   * interchangeable with the password-derived key for both new and existing
   * persisted bags.
   *
   * Callers that want to eliminate plaintext-password retention should
   * derive the wrapping key once at login and pass it to the
   * {@link KeyBagWrappingKeyOptions} constructor overload.
   *
   * @param userEncryptionKey The user's encrypted encryption key (provides
   *   the salt). Only `userEncryptionKey.salt` is read; the encrypted
   *   bytes are not touched.
   * @param password The user's password.
   * @param cryptoAdapter Crypto adapter to use for the derivation.
   * @param options.extractable Whether the returned key should be
   *   extractable. Defaults to `false` so the raw bytes never appear in
   *   the JS heap.
   */
  static async deriveWrappingKey(
    userEncryptionKey: EncryptedPrivateKey,
    password: string,
    cryptoAdapter: CryptoAdapter,
    options?: { extractable?: boolean },
  ): Promise<CryptoKey> {
    const subtle = cryptoAdapter.getSubtle();

    const userKeySaltBytes = KeyBag.staticBase64ToUint8Array(userEncryptionKey.salt);
    const saltStringBytes = new TextEncoder().encode("key-bag-encryption");
    const combinedSalt = new Uint8Array(userKeySaltBytes.length + saltStringBytes.length);
    combinedSalt.set(userKeySaltBytes);
    combinedSalt.set(saltStringBytes, userKeySaltBytes.length);

    const passwordInput = new TextEncoder().encode(`${password}:key-bag-encryption`);

    const passwordKey = await subtle.importKey(
      "raw",
      passwordInput,
      "PBKDF2",
      false,
      ["deriveKey"],
    );

    const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    return subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: combinedSalt,
        iterations,
        hash: "SHA-256",
      },
      passwordKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      options?.extractable ?? false,
      ["encrypt", "decrypt"],
    );
  }

  private static isWrappingKeyOptions(value: EncryptedPrivateKey | KeyBagWrappingKeyOptions): value is KeyBagWrappingKeyOptions {
    return typeof value === "object"
      && value !== null
      && "wrappingKey" in value
      && "cryptoAdapter" in value;
  }

  private static staticBase64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Subscribe to live doc-key mutation events.
   *
   * Listeners receive a shallow copy of the same {@link KeyBagChangeEvent}
   * record that gets appended to the internal feed, so reads via
   * {@link iterateChangesSince} stay consistent with what listeners see.
   * Listener exceptions are caught and logged so they cannot break the
   * mutating call site.
   *
   * Live notifications are a convenience: callers that need to be robust
   * against missed events should also persist a cursor and replay through
   * {@link iterateChangesSince}.
   *
   * @returns A disposer that removes the listener.
   */
  onChanges(listener: KeyBagChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Snapshot the current head of the local changes feed.
   *
   * Returns `null` when no doc-key mutations have ever been observed by
   * this bag instance. Useful as a starting cursor when a consumer wants
   * to react only to *future* changes.
   */
  getLatestChangeCursor(): KeyBagChangeCursor | null {
    const latest = this.keyChanges[this.keyChanges.length - 1];
    return latest ? { changeSeq: latest.changeSeq } : null;
  }

  /**
   * Iterate doc-key mutation events strictly after the given cursor.
   *
   * Pass `null` to consume all events since the bag was created. Yielded
   * events are independent copies, so consumers may mutate them freely
   * without affecting other listeners. Events are emitted in the order
   * the underlying mutations occurred, which is also the order of their
   * `changeSeq` values.
   */
  async *iterateChangesSince(cursor: KeyBagChangeCursor | null): AsyncGenerator<KeyBagChangeEvent, void, unknown> {
    const startSeq = cursor?.changeSeq ?? 0;
    for (const event of this.keyChanges) {
      if (event.changeSeq > startSeq) {
        yield { ...event };
      }
    }
  }

  /**
   * Append a doc-key mutation event to the local feed and notify
   * subscribed listeners.
   *
   * Called from every mutation site after the underlying `keys` map has
   * been updated. Never includes raw key bytes in the recorded event so
   * the feed is safe to expose to telemetry or external consumers.
   */
  private recordKeyChange(
    type: KeyType,
    tenantId: string,
    keyId: string,
    action: KeyBagChangeAction,
    versionsRemaining: number,
  ): void {
    const event: KeyBagChangeEvent = {
      changeSeq: this.nextKeyChangeSeq++,
      type,
      tenantId,
      keyId,
      action,
      versionsRemaining,
      hasKey: versionsRemaining > 0,
    };
    this.keyChanges.push(event);
    for (const listener of this.changeListeners) {
      try {
        listener({ ...event });
      } catch (error) {
        // Listener failure must not break the mutation; just log and continue.
        // Pass the error as a separate argument so the logger captures the
        // full (sanitized) stack trace rather than just the toString() form.
        this.logger.warn(`KeyBag change listener failed`, error);
      }
    }
  }

  /**
   * Reads a key from the key bag.
   * Returns the newest key (based on createdAt) or the first key if no timestamps are available.
   *
   * @param keyId The ID of the key to read
   * @return The exported key, or null if not found
   */
  async get(type: KeyType, tenantId: string, id: string): Promise<Uint8Array | null>;
  async get(type: KeyType, tenantId: string, id: string): Promise<Uint8Array | null> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const keyEntries = this.keys.get(scopedKeyId);
    if (!keyEntries || keyEntries.length === 0) {
      return null;
    }
    
    // Sort by createdAt (newest first), then return the first one
    const sorted = [...keyEntries].sort((a, b) => {
      const aTime = a.createdAt ?? 0;
      const bTime = b.createdAt ?? 0;
      return bTime - aTime; // Descending order (newest first)
    });
    
    return sorted[0].key;
  }

  /**
   * Gets all keys for a given keyId, sorted by createdAt (newest first).
   * Useful for trying multiple keys during decryption (key rotation support).
   *
   * @param keyId The ID of the keys to read
   * @return Array of keys sorted by createdAt (newest first), or empty array if not found
   */
  async getAllKeys(type: KeyType, tenantId: string, id: string): Promise<Uint8Array[]>;
  async getAllKeys(type: KeyType, tenantId: string, id: string): Promise<Uint8Array[]> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const keyEntries = this.keys.get(scopedKeyId);
    if (!keyEntries || keyEntries.length === 0) {
      return [];
    }
    
    // Sort by createdAt (newest first)
    const sorted = [...keyEntries].sort((a, b) => {
      const aTime = a.createdAt ?? 0;
      const bTime = b.createdAt ?? 0;
      return bTime - aTime; // Descending order (newest first)
    });
    
    return sorted.map(entry => entry.key);
  }

  /**
   * Sets a key in the key bag.
   * Adds the key to the array of keys for this keyId (supports key rotation).
   * 
   * @param keyId The ID of the key
   * @param key The key bytes
   * @param createdAt Optional creation timestamp (milliseconds since Unix epoch)
   */
  async set(type: KeyType, tenantId: string, id: string, key: Uint8Array, createdAt?: number): Promise<void>;
  async set(type: KeyType, tenantId: string, id: string, key: Uint8Array, createdAt?: number): Promise<void> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const keyEntries = this.keys.get(scopedKeyId) || [];
    keyEntries.push({ key, createdAt });
    this.keys.set(scopedKeyId, keyEntries);
    this.recordKeyChange(type, tenantId, id, "add", keyEntries.length);
  }

  /**
   * Creates a new tenant symmetric key (AES-256) and stores it directly in this KeyBag.
   * This avoids temporary password-wrapped key blobs when the key is only needed locally.
   */
  async createTenantKey(tenantId: string, createdAt?: number): Promise<void> {
    await this.createAndStoreSymmetricKey("doc", tenantId, DEFAULT_TENANT_KEY_ID, createdAt);
  }

  /**
   * Creates a new document symmetric key (AES-256) and stores it directly in this KeyBag.
   * This avoids temporary password-wrapped key blobs when the key is only needed locally.
   */
  async createDocKey(tenantId: string, keyId: string, createdAt?: number): Promise<void> {
    await this.createAndStoreSymmetricKey("doc", tenantId, keyId, createdAt);
  }

  /**
   * Decrypts an encrypted private key with the given password and imports it into the key bag.
   * Adds the key to the array of keys for this keyId (supports key rotation).
   * 
   * @param type The key type ("doc")
   * @param id The document key identifier
   * @param key The encrypted private key to decrypt
   * @param password The password to decrypt the key
   * @return A promise that resolves when the key is decrypted and stored
   */
  async decryptAndImportKey(type: KeyType, tenantId: string, id: string, key: EncryptedPrivateKey, password: string): Promise<void>;
  async decryptAndImportKey(
    type: KeyType,
    tenantId: string,
    id: string,
    key: EncryptedPrivateKey,
    password: string,
  ): Promise<void> {
    const salt = buildKeyDerivationSalt(type, tenantId, id);
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const decryptedKeyBytes = await this.decryptPrivateKey(key, password, salt);
    const keyEntries = this.keys.get(scopedKeyId) || [];
    keyEntries.push({ 
      key: new Uint8Array(decryptedKeyBytes),
      createdAt: key.createdAt 
    });
    this.keys.set(scopedKeyId, keyEntries);
    this.recordKeyChange(type, tenantId, id, "add", keyEntries.length);
  }

  /**
   * Encrypts a key from the key bag with the given password and exports it as an EncryptedPrivateKey.
   * Returns the newest key (based on createdAt) or the first key if no timestamps are available.
   * 
   * @param type The key type ("doc")
   * @param id The document key identifier
   * @param password The password to encrypt the key with
   * @return A promise that resolves to the encrypted private key, or null if the key is not found
   */
  async encryptAndExportKey(type: KeyType, tenantId: string, id: string, password: string): Promise<EncryptedPrivateKey | null>;
  async encryptAndExportKey(
    type: KeyType,
    tenantId: string,
    id: string,
    password: string,
  ): Promise<EncryptedPrivateKey | null> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const key = await this.get(type, tenantId, id);
    if (!key) {
      return null;
    }
    
    // Get the createdAt timestamp from the newest key entry
    const keyEntries = this.keys.get(scopedKeyId);
    if (!keyEntries || keyEntries.length === 0) {
      return null;
    }
    
    // Sort by createdAt (newest first) to get the timestamp
    const sorted = [...keyEntries].sort((a, b) => {
      const aTime = a.createdAt ?? 0;
      const bTime = b.createdAt ?? 0;
      return bTime - aTime; // Descending order (newest first)
    });
    
    const createdAt = sorted[0].createdAt;
    
    // Encrypt the key using the same pattern as decryptPrivateKey
    const encryptedKey = await this.encryptPrivateKey(
      key,
      password,
      buildKeyDerivationSalt(type, tenantId, id)
    );
    
    // Include the createdAt timestamp if available
    if (createdAt !== undefined) {
      encryptedKey.createdAt = createdAt;
    }
    
    return encryptedKey;
  }

  /**
   * Encrypts a specific key version from the key bag with the given password.
   *
   * @param versionIndex Index within the sorted key versions (newest first)
   */
  async encryptAndExportKeyVersion(type: KeyType, tenantId: string, id: string, versionIndex: number, password: string): Promise<EncryptedPrivateKey | null>;
  async encryptAndExportKeyVersion(
    type: KeyType,
    tenantId: string,
    id: string,
    versionIndex: number,
    password: string,
  ): Promise<EncryptedPrivateKey | null> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const keyEntries = this.keys.get(scopedKeyId);
    if (!keyEntries || keyEntries.length === 0) {
      return null;
    }

    const sorted = this.sortKeyEntries(keyEntries);
    const target = sorted[versionIndex];
    if (!target) {
      return null;
    }

    const encryptedKey = await this.encryptPrivateKey(
      target.key,
      password,
      buildKeyDerivationSalt(type, tenantId, id)
    );

    if (target.createdAt !== undefined) {
      encryptedKey.createdAt = target.createdAt;
    }

    return encryptedKey;
  }

  /**
   * Deletes all keys for a given keyId from the key bag.
   * 
   * @param type The key type ("doc")
   * @param id The document key identifier
   * @return A promise that resolves when the keys are deleted
   */
  async deleteKey(type: KeyType, tenantId: string, id: string): Promise<void>;
  async deleteKey(type: KeyType, tenantId: string, id: string): Promise<void> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const existing = this.keys.get(scopedKeyId);
    if (!existing || existing.length === 0) {
      return;
    }
    this.keys.delete(scopedKeyId);
    this.recordKeyChange(type, tenantId, id, "remove", 0);
  }

  /**
   * Deletes a specific key version from the key bag.
   *
   * @param versionIndex Index within the sorted key versions (newest first)
   */
  async deleteKeyVersion(type: KeyType, tenantId: string, id: string, versionIndex: number): Promise<void>;
  async deleteKeyVersion(type: KeyType, tenantId: string, id: string, versionIndex: number): Promise<void> {
    const scopedKeyId = buildScopedKeyId(type, tenantId, id);
    const keyEntries = this.keys.get(scopedKeyId);
    if (!keyEntries || keyEntries.length === 0) {
      return;
    }

    const sorted = this.sortKeyEntries(keyEntries);
    const target = sorted[versionIndex];
    if (!target) {
      return;
    }

    const remainingEntries = keyEntries.filter((entry) => entry !== target);
    if (remainingEntries.length === 0) {
      this.keys.delete(scopedKeyId);
      this.recordKeyChange(type, tenantId, id, "remove", 0);
      return;
    }

    this.keys.set(scopedKeyId, remainingEntries);
    this.recordKeyChange(type, tenantId, id, "remove", remainingEntries.length);
  }

  /**
   * Deletes every key belonging to a tenant, leaving keys for other tenants
   * intact. Used by remote wipe (docs/accesscontrol.md §6.5) to remove a tenant
   * from a multi-tenant device as a unit.
   *
   * @param tenantId The tenant whose keys should be removed
   */
  async deleteTenantKeys(tenantId: string): Promise<void> {
    // Scoped key ids have the form `${type}:${tenantId}:${id}` (see KeyContext).
    for (const scopedKeyId of Array.from(this.keys.keys())) {
      const firstColon = scopedKeyId.indexOf(":");
      const secondColon = scopedKeyId.indexOf(":", firstColon + 1);
      if (firstColon < 0 || secondColon < 0) {
        continue;
      }
      const type = scopedKeyId.slice(0, firstColon) as KeyType;
      const keyTenantId = scopedKeyId.slice(firstColon + 1, secondColon);
      const id = scopedKeyId.slice(secondColon + 1);
      if (keyTenantId === tenantId) {
        this.keys.delete(scopedKeyId);
        this.recordKeyChange(type, tenantId, id, "remove", 0);
      }
    }
  }

  /**
   * Lists all key IDs in the key bag.
   * 
   * @return A promise that resolves to an array of key IDs
   */
  async listKeys(): Promise<string[]> {
    return Array.from(this.keys.keys());
  }

  /**
   * Build a stable fingerprint of the doc-type keys available for a given
   * tenant.
   *
   * The fingerprint changes whenever the *set* of scoped key ids the bag
   * holds for `doc:tenantId:*` gains or loses an entry, but does not
   * depend on key version counts or key material. It is used by
   * {@link BaseMindooDB} to short-circuit visibility reconciliation on
   * warm starts when the bag composition has not changed since the last
   * cache flush, avoiding an otherwise unconditional full metadata scan
   * against the underlying store (potentially several REST round-trips
   * against a remote store).
   *
   * Implementation notes:
   * - Scoped key ids are not secret (only key bytes are), so we use the
   *   sorted ids directly rather than hashing them. This keeps the
   *   fingerprint debuggable and avoids dragging crypto into a hot
   *   startup path.
   * - The leading `v1:` tag is a format version so future iterations can
   *   extend the fingerprint without colliding with old persisted
   *   values.
   */
  async getDocKeyFingerprint(tenantId: string): Promise<string> {
    const prefix = `doc:${tenantId}:`;
    const scopedIds: string[] = [];
    for (const scopedKeyId of this.keys.keys()) {
      if (scopedKeyId.startsWith(prefix)) {
        scopedIds.push(scopedKeyId);
      }
    }
    scopedIds.sort();
    return `v1:${scopedIds.join("|")}`;
  }

  /**
   * Lists all stored key versions with metadata, newest first within each scoped key.
   */
  async listKeyDetails(): Promise<KeyDetail[]> {
    const details: KeyDetail[] = [];
    for (const [scopedKeyId, keyEntries] of this.keys.entries()) {
      const sorted = this.sortKeyEntries(keyEntries);
      sorted.forEach((entry, versionIndex) => {
        details.push({
          scopedKeyId,
          createdAt: entry.createdAt,
          keyLengthBits: entry.key.length * 8,
          versionIndex,
        });
      });
    }
    return details;
  }

  /**
   * Creates an in-memory clone of this KeyBag.
   * The clone contains deep-copied key material and independent key maps.
   *
   * The clone follows the same construction mode as this instance:
   *  - bags built with the wrapping-key constructor are cloned with the
   *    same {@link CryptoKey} reference (the underlying key handle is safe
   *    to share across instances - it is treated as immutable),
   *  - bags built with the legacy password constructor are cloned with the
   *    same encrypted user key + plaintext password.
   */
  clone(): KeyBag {
    let cloned: KeyBag;
    if (this.wrappingKey !== null) {
      cloned = new KeyBag({
        wrappingKey: this.wrappingKey,
        cryptoAdapter: this.cryptoAdapter,
        logger: this.logger,
      });
    } else {
      if (this.userEncryptionKey === null || this.userEncryptionKeyPassword === null) {
        throw new Error("KeyBag.clone(): legacy bag missing userEncryptionKey/password.");
      }
      const clonedUserEncryptionKey: EncryptedPrivateKey = { ...this.userEncryptionKey };
      cloned = new KeyBag(
        clonedUserEncryptionKey,
        this.userEncryptionKeyPassword,
        this.cryptoAdapter,
        this.logger
      );
    }

    cloned.keys = new Map(
      Array.from(this.keys.entries()).map(([scopedKeyId, entries]) => [
        scopedKeyId,
        entries.map((entry) => ({
          key: new Uint8Array(entry.key),
          createdAt: entry.createdAt,
        })),
      ])
    );

    return cloned;
  }

  /**
   * Save the key bag to a binary data blob, encrypted with the wrapping key
   * (either the {@link CryptoKey} provided to the constructor or one derived
   * on demand from the legacy password).
   *
   * @return A promise that resolves to the encrypted binary data (Uint8Array)
   */
  async save(): Promise<Uint8Array> {
    this.logger.debug(`Saving key bag with ${this.keys.size} keys`);

    const mapArray: Array<[string, Array<{key: string, createdAt?: number}>]> = Array.from(this.keys.entries()).map(([keyId, keyEntries]) => [
      keyId,
      keyEntries.map(entry => ({
        key: this.uint8ArrayToBase64(entry.key),
        createdAt: entry.createdAt
      }))
    ]);
    const jsonString = JSON.stringify(mapArray);
    const plaintext = new TextEncoder().encode(jsonString);

    const subtle = this.cryptoAdapter.getSubtle();
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);

    const wrappingKey = await this.resolveWrappingKey("encrypt");

    const ivArray = new Uint8Array(12); // 12 bytes for AES-GCM
    randomValues(ivArray);
    const iv = new Uint8Array(ivArray);

    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      wrappingKey,
      plaintext.buffer as ArrayBuffer
    );

    // AES-GCM appends the 16-byte authentication tag at the end of the ciphertext
    const encryptedArray = new Uint8Array(encrypted);
    const tagLength = 16;
    const ciphertext = encryptedArray.slice(0, encryptedArray.length - tagLength);
    const tag = encryptedArray.slice(encryptedArray.length - tagLength);

    // Combined wire format: IV (12B) + tag (16B) + ciphertext (variable)
    const result = new Uint8Array(12 + 16 + ciphertext.length);
    result.set(iv, 0);
    result.set(tag, 12);
    result.set(ciphertext, 12 + 16);

    this.logger.debug(`Saved key bag (${plaintext.length} -> ${result.length} bytes)`);
    return result;
  }

  /**
   * Load the key bag from a binary data blob, decrypted with the wrapping key
   * (either the {@link CryptoKey} provided to the constructor or one derived
   * on demand from the legacy password).
   * 
   * @param encryptedData The encrypted binary data to load (Uint8Array)
   * @return A promise that resolves when the keys are loaded
   */
  async load(encryptedData: Uint8Array): Promise<void> {
    this.logger.debug(`Loading key bag`);

    if (encryptedData.length < 28) {
      throw new Error("Encrypted data too short (missing IV and tag)");
    }

    const iv = encryptedData.slice(0, 12);
    const tag = encryptedData.slice(12, 28);
    const ciphertext = encryptedData.slice(28);

    const subtle = this.cryptoAdapter.getSubtle();

    const wrappingKey = await this.resolveWrappingKey("decrypt");

    // Re-attach the auth tag for SubtleCrypto's combined input format
    const encryptedDataWithTag = new Uint8Array(ciphertext.length + tag.length);
    encryptedDataWithTag.set(ciphertext);
    encryptedDataWithTag.set(tag, ciphertext.length);

    const decrypted = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      wrappingKey,
      encryptedDataWithTag.buffer as ArrayBuffer
    );

    const decryptedArray = new Uint8Array(decrypted);
    const jsonString = new TextDecoder().decode(decryptedArray);
    const mapArray: Array<[string, Array<{key: string, createdAt?: number}>]> = JSON.parse(jsonString);

    const loadedKeys = new Map<string, KeyEntry[]>();
    for (const [scopedKeyId, keyEntries] of mapArray) {
      const normalizedScopedKeyId = this.normalizeLoadedScopedKeyId(scopedKeyId);
      const normalizedEntries = keyEntries.map(entry => ({
        key: this.base64ToUint8Array(entry.key),
        createdAt: entry.createdAt
      }));
      const existingEntries = loadedKeys.get(normalizedScopedKeyId) || [];
      loadedKeys.set(normalizedScopedKeyId, existingEntries.concat(normalizedEntries));
    }
    this.keys = loadedKeys;

    this.logger.debug(`Loaded key bag (${encryptedData.length} -> ${this.keys.size} keys)`);
  }

  /**
   * Returns the AES-GCM wrapping key used for {@link save}/{@link load}.
   *
   * - If this bag was constructed with a pre-derived `wrappingKey`, returns
   *   that key directly. The caller-supplied key already supports both
   *   `encrypt` and `decrypt`, so no per-usage derivation is needed.
   * - Otherwise (legacy password constructor), derives a wrapping key from
   *   the stored password + user encryption salt via PBKDF2 with the
   *   requested usage. The derived key is intentionally not cached on the
   *   instance: the password constructor is the slow path and exists for
   *   backward compatibility only.
   */
  private async resolveWrappingKey(usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
    if (this.wrappingKey) {
      return this.wrappingKey;
    }

    if (this.userEncryptionKey === null || this.userEncryptionKeyPassword === null) {
      throw new Error("KeyBag is missing both a wrapping key and a password; cannot resolve wrapping key.");
    }

    const subtle = this.cryptoAdapter.getSubtle();

    const userKeySaltBytes = this.base64ToUint8Array(this.userEncryptionKey.salt);
    const saltStringBytes = new TextEncoder().encode("key-bag-encryption");
    const combinedSalt = new Uint8Array(userKeySaltBytes.length + saltStringBytes.length);
    combinedSalt.set(userKeySaltBytes);
    combinedSalt.set(saltStringBytes, userKeySaltBytes.length);

    const passwordInput = new TextEncoder().encode(`${this.userEncryptionKeyPassword}:key-bag-encryption`);

    const passwordKey = await subtle.importKey(
      "raw",
      passwordInput,
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    const keyBagIterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    if (keyBagIterations !== DEFAULT_PBKDF2_ITERATIONS) {
      this.logger.warn(`Using overridden PBKDF2 iterations for KeyBag.${usage === "encrypt" ? "save" : "load"}(): ${keyBagIterations}`);
    }

    return subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: combinedSalt,
        iterations: keyBagIterations,
        hash: "SHA-256",
      },
      passwordKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      [usage],
    );
  }

  /**
   * Internal method to decrypt a private key using password-based key derivation.
   * 
   * @param encryptedKey The encrypted private key
   * @param password The password to decrypt the key
   * @param saltString The salt string for key derivation (e.g., keyId)
   * @returns The decrypted private key as ArrayBuffer
   */
  private async decryptPrivateKey(
    encryptedKey: EncryptedPrivateKey,
    password: string,
    saltString: string
  ): Promise<ArrayBuffer> {
    const subtle = this.cryptoAdapter.getSubtle();

    // Decode base64 strings
    const ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
    const iv = this.base64ToUint8Array(encryptedKey.iv);
    const tag = this.base64ToUint8Array(encryptedKey.tag);
    const saltBytes = this.base64ToUint8Array(encryptedKey.salt);

    // Derive key from password using PBKDF2
    // Combine the stored salt bytes with the salt string for additional security
    const saltStringBytes = new TextEncoder().encode(saltString);
    const combinedSalt = new Uint8Array(saltBytes.length + saltStringBytes.length);
    combinedSalt.set(saltBytes);
    combinedSalt.set(saltStringBytes, saltBytes.length);

    const passwordKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    const derivedKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: combinedSalt,
        iterations: encryptedKey.iterations,
        hash: "SHA-256",
      },
      passwordKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["decrypt"]
    );

    // Combine ciphertext and tag (GCM authentication tag is separate)
    const encryptedData = new Uint8Array(ciphertext.length + tag.length);
    encryptedData.set(ciphertext);
    encryptedData.set(tag, ciphertext.length);

    // Decrypt the private key
    const decrypted = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        tagLength: 128,
      },
      derivedKey,
      encryptedData.buffer as ArrayBuffer
    );

    return decrypted;
  }

  /**
   * Generates a new AES-256 key and stores raw key bytes in KeyBag.
   */
  private async createAndStoreSymmetricKey(
    type: KeyType,
    tenantId: string,
    id: string,
    createdAt?: number
  ): Promise<void>;
  private async createAndStoreSymmetricKey(
    type: "doc",
    tenantId: string,
    id: string,
    createdAt?: number
  ): Promise<void> {
    const subtle = this.cryptoAdapter.getSubtle();
    const key = await subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true,
      ["encrypt", "decrypt"]
    );
    const keyMaterial = await subtle.exportKey("raw", key);
    await this.set(type, tenantId, id, new Uint8Array(keyMaterial), createdAt);
  }

  private sortKeyEntries(entries: KeyEntry[]): KeyEntry[] {
    return [...entries].sort((a, b) => {
      const aTime = a.createdAt ?? 0;
      const bTime = b.createdAt ?? 0;
      return bTime - aTime;
    });
  }

  private normalizeLoadedScopedKeyId(scopedKeyId: string): string {
    if (!scopedKeyId.startsWith("tenant:")) {
      return scopedKeyId;
    }

    const tenantId = scopedKeyId.slice("tenant:".length);
    if (!tenantId) {
      return scopedKeyId;
    }

    const normalizedScopedKeyId = buildScopedKeyId("doc", tenantId, DEFAULT_TENANT_KEY_ID);
    this.logger.warn(`Normalizing legacy KeyBag entry "${scopedKeyId}" to "${normalizedScopedKeyId}" during load().`);
    return normalizedScopedKeyId;
  }

  /**
   * Internal method to encrypt a private key using password-based key derivation.
   * This is the reverse of decryptPrivateKey().
   * 
   * @param privateKeyBytes The private key bytes to encrypt
   * @param password The password to encrypt the key with
   * @param saltString The salt string for key derivation (e.g., keyId)
   * @returns The encrypted private key
   */
  private async encryptPrivateKey(
    privateKeyBytes: Uint8Array,
    password: string,
    saltString: string
  ): Promise<EncryptedPrivateKey> {
    const subtle = this.cryptoAdapter.getSubtle();
    // Bind getRandomValues to maintain 'this' context
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);

    // Generate random salt and IV
    const saltArray = new Uint8Array(16); // 16 bytes salt
    randomValues(saltArray);
    const salt = new Uint8Array(saltArray);

    const ivArray = new Uint8Array(12); // 12 bytes for AES-GCM
    randomValues(ivArray);
    const iv = new Uint8Array(ivArray);

    // Combine salt with saltString for key derivation (same as decryption)
    const saltStringBytes = new TextEncoder().encode(saltString);
    const combinedSalt = new Uint8Array(salt.length + saltStringBytes.length);
    combinedSalt.set(salt);
    combinedSalt.set(saltStringBytes, salt.length);

    // Derive encryption key from password using PBKDF2
    const passwordKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    if (iterations !== DEFAULT_PBKDF2_ITERATIONS) {
      this.logger.warn(`Using overridden PBKDF2 iterations for KeyBag.encryptPrivateKey(): ${iterations}`);
    }
    const derivedKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: combinedSalt,
        iterations: iterations,
        hash: "SHA-256",
      },
      passwordKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["encrypt"]
    );

    // Encrypt the private key
    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      derivedKey,
      privateKeyBytes.buffer as ArrayBuffer
    );

    // Extract ciphertext and tag from encrypted data
    // AES-GCM appends the tag at the end
    const encryptedArray = new Uint8Array(encrypted);
    const tagLength = 16; // 128 bits = 16 bytes
    const ciphertext = encryptedArray.slice(0, encryptedArray.length - tagLength);
    const tag = encryptedArray.slice(encryptedArray.length - tagLength);

    // Create encrypted key structure
    const encryptedKey: EncryptedPrivateKey = {
      ciphertext: this.uint8ArrayToBase64(ciphertext),
      iv: this.uint8ArrayToBase64(iv),
      tag: this.uint8ArrayToBase64(tag),
      salt: this.uint8ArrayToBase64(salt),
      iterations: iterations,
    };

    return encryptedKey;
  }

  /**
   * Helper method to convert base64 string to Uint8Array
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Helper method to convert Uint8Array to base64 string
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
