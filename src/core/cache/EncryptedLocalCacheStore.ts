import { LocalCacheStore } from "./LocalCacheStore";
import { CryptoAdapter } from "../crypto/CryptoAdapter";
import { DEFAULT_PBKDF2_ITERATIONS, resolvePbkdf2Iterations } from "../crypto/pbkdf2Iterations";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * Transparent encryption wrapper around any {@link LocalCacheStore}.
 *
 * - Encrypts values on `put()`, decrypts on `get()`
 * - Keys (type + id) are passed through unmodified
 * - Uses AES-256-GCM with a key derived from the user's password via PBKDF2
 * - If decryption fails (password changed, corruption) returns `null`
 */
export class EncryptedLocalCacheStore implements LocalCacheStore {
  private inner: LocalCacheStore;
  private cryptoAdapter: CryptoAdapter;
  private derivedKey: CryptoKey | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;
  private logger: Logger;

  /**
   * @param inner        The underlying (plaintext) cache store
   * @param userPassword The user's password used to derive the encryption key
   * @param cryptoAdapter Platform-agnostic crypto interface
   * @param logger       Optional logger
   */
  constructor(
    inner: LocalCacheStore,
    userPassword: string,
    cryptoAdapter: CryptoAdapter,
    logger?: Logger,
  ) {
    this.inner = inner;
    this.cryptoAdapter = cryptoAdapter;
    this.logger = logger || new MindooLogger(getDefaultLogLevel(), "EncryptedLocalCacheStore", true);
    this.keyPromise = this.deriveKey(userPassword);
  }

  private async deriveKey(password: string): Promise<CryptoKey> {
    const subtle = this.cryptoAdapter.getSubtle();

    const saltString = "mindoodb-cache-encryption:v1";
    const salt = new TextEncoder().encode(saltString);

    const passwordInput = new TextEncoder().encode(password);
    const baseKey = await subtle.importKey(
      "raw",
      passwordInput.buffer as ArrayBuffer,
      "PBKDF2",
      false,
      ["deriveKey"],
    );

    const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    if (iterations !== DEFAULT_PBKDF2_ITERATIONS) {
      this.logger.warn(`Using overridden PBKDF2 iterations for cache key derivation: ${iterations}`);
    }

    const key = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt.buffer as ArrayBuffer,
        iterations,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    this.derivedKey = key;
    return key;
  }

  private async getKey(): Promise<CryptoKey> {
    if (this.derivedKey) return this.derivedKey;
    return this.keyPromise!;
  }

  /**
   * Ensure the Uint8Array owns its entire backing ArrayBuffer (byteOffset=0,
   * byteLength=buffer.byteLength).  Some React Native crypto polyfills
   * access `.buffer` directly, which would read wrong data for sub-views.
   */
  private static ensureOwnedBuffer(arr: Uint8Array): Uint8Array {
    if (arr.byteOffset !== 0 || arr.byteLength !== arr.buffer.byteLength) {
      const copy = new Uint8Array(arr.byteLength);
      copy.set(arr);
      return copy;
    }
    return arr;
  }

  private async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const subtle = this.cryptoAdapter.getSubtle();
    const key = await this.getKey();

    const iv = new Uint8Array(12);
    this.cryptoAdapter.getRandomValues(iv);

    const safeData = EncryptedLocalCacheStore.ensureOwnedBuffer(plaintext);
    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
      key,
      safeData.buffer as ArrayBuffer,
    );

    // Format: IV (12 bytes) + ciphertext+tag (variable)
    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), 12);
    return result;
  }

  private async decrypt(data: Uint8Array): Promise<Uint8Array | null> {
    if (data.length < 12 + 16) {
      this.logger.warn("Encrypted cache entry too short, treating as corrupt");
      return null;
    }

    try {
      const subtle = this.cryptoAdapter.getSubtle();
      const key = await this.getKey();

      // .slice() creates copies with their own backing ArrayBuffer
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);

      const plaintext = await subtle.decrypt(
        { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
        key,
        ciphertext.buffer as ArrayBuffer,
      );

      return new Uint8Array(plaintext);
    } catch (e) {
      this.logger.warn(`Cache decryption failed (password changed or data corrupt): ${e}`);
      return null;
    }
  }

  // --- LocalCacheStore interface ---

  async get(type: string, id: string): Promise<Uint8Array | null> {
    const encrypted = await this.inner.get(type, id);
    if (!encrypted) return null;
    return this.decrypt(encrypted);
  }

  async put(type: string, id: string, value: Uint8Array): Promise<void> {
    const encrypted = await this.encrypt(value);
    return this.inner.put(type, id, encrypted);
  }

  async delete(type: string, id: string): Promise<void> {
    return this.inner.delete(type, id);
  }

  async list(type: string): Promise<string[]> {
    return this.inner.list(type);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }
}
