import { EncryptedPrivateKey } from "../types";
import { CryptoAdapter } from "../crypto/CryptoAdapter";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * Internal structure for storing a key with optional creation timestamp.
 */
interface KeyEntry {
  key: Uint8Array;
  createdAt?: number; // milliseconds since Unix epoch
}

/**
 * The KeyBag is used to store encryption keys that the current user has access to
 * in order to decrypt document changes stored in the AppendOnlyStore.
 * Supports key rotation by storing multiple versions per keyId (newest first).
 */
export class KeyBag {
  private userEncryptionKey: EncryptedPrivateKey;
  private userEncryptionKeyPassword: string;
  private keys: Map<string, KeyEntry[]> = new Map();
  private cryptoAdapter: CryptoAdapter;
  private logger: Logger;

  /**
   * Creates a new KeyBag instance.
   * 
   * @param userEncryptionKey The encrypted user encryption key
   * @param userEncryptionKeyPassword The password to decrypt the user encryption key
   * @param cryptoAdapter The crypto adapter to use for encryption and decryption
   * @param logger Optional logger instance
   */
  constructor(userEncryptionKey: EncryptedPrivateKey, userEncryptionKeyPassword: string, cryptoAdapter: CryptoAdapter, logger?: Logger) {
    this.userEncryptionKey = userEncryptionKey;
    this.userEncryptionKeyPassword = userEncryptionKeyPassword;
    this.cryptoAdapter = cryptoAdapter;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "KeyBag", true);
  }

  /**
   * Reads a key from the key bag.
   * Returns the newest key (based on createdAt) or the first key if no timestamps are available.
   *
   * @param keyId The ID of the key to read
   * @return The exported key, or null if not found
   */
  async get(keyId: string): Promise<Uint8Array | null> {
    const keyEntries = this.keys.get(keyId);
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
  async getAllKeys(keyId: string): Promise<Uint8Array[]> {
    const keyEntries = this.keys.get(keyId);
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
  async set(keyId: string, key: Uint8Array, createdAt?: number): Promise<void> {
    const keyEntries = this.keys.get(keyId) || [];
    keyEntries.push({ key, createdAt });
    this.keys.set(keyId, keyEntries);
  }

  /**
   * Decrypts an encrypted private key with the given password and imports it into the key bag.
   * Adds the key to the array of keys for this keyId (supports key rotation).
   * 
   * @param keyId The ID to store the decrypted key under
   * @param key The encrypted private key to decrypt
   * @param password The password to decrypt the key
   * @param saltString Optional salt string for key derivation. Defaults to "default".
   *                   Use "default" for keys created by createSymmetricEncryptedPrivateKey.
   *                   Keys exported via encryptAndExportKey use keyId as salt, so pass keyId explicitly.
   * @return A promise that resolves when the key is decrypted and stored
   */
  async decryptAndImportKey(keyId: string, key: EncryptedPrivateKey, password: string, saltString?: string): Promise<void> {
    const salt = saltString ?? "default";
    const decryptedKeyBytes = await this.decryptPrivateKey(key, password, salt);
    const keyEntries = this.keys.get(keyId) || [];
    keyEntries.push({ 
      key: new Uint8Array(decryptedKeyBytes),
      createdAt: key.createdAt 
    });
    this.keys.set(keyId, keyEntries);
  }

  /**
   * Encrypts a key from the key bag with the given password and exports it as an EncryptedPrivateKey.
   * Returns the newest key (based on createdAt) or the first key if no timestamps are available.
   * 
   * @param keyId The ID of the key to encrypt and export
   * @param password The password to encrypt the key with
   * @return A promise that resolves to the encrypted private key, or null if the key is not found
   */
  async encryptAndExportKey(keyId: string, password: string): Promise<EncryptedPrivateKey | null> {
    const key = await this.get(keyId);
    if (!key) {
      return null;
    }
    
    // Get the createdAt timestamp from the newest key entry
    const keyEntries = this.keys.get(keyId);
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
    const encryptedKey = await this.encryptPrivateKey(key, password, keyId);
    
    // Include the createdAt timestamp if available
    if (createdAt !== undefined) {
      encryptedKey.createdAt = createdAt;
    }
    
    return encryptedKey;
  }

  /**
   * Deletes all keys for a given keyId from the key bag.
   * 
   * @param keyId The ID of the keys to delete
   * @return A promise that resolves when the keys are deleted
   */
  async deleteKey(keyId: string): Promise<void> {
    this.keys.delete(keyId);
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
   * Save the key bag to a binary data blob, encrypted with the user encryption key.
   * 
   * @return A promise that resolves to the encrypted binary data (Uint8Array)
   */
  async save(): Promise<Uint8Array> {
    this.logger.debug(`Saving key bag with ${this.keys.size} keys`);
    
    // Serialize the map to JSON and convert to Uint8Array
    // Convert Uint8Array values to base64 strings for JSON serialization
    // Support multiple keys per keyId with createdAt timestamps
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
    // Bind getRandomValues to maintain 'this' context
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);
    
    // Derive an AES-GCM key using PBKDF2 with the user encryption key's salt
    // Use the salt from the user encryption key as part of the key derivation
    const userKeySaltBytes = this.base64ToUint8Array(this.userEncryptionKey.salt);
    
    // Combine with a fixed string to differentiate from other key derivations
    const saltStringBytes = new TextEncoder().encode("key-bag-encryption");
    const combinedSalt = new Uint8Array(userKeySaltBytes.length + saltStringBytes.length);
    combinedSalt.set(userKeySaltBytes);
    combinedSalt.set(saltStringBytes, userKeySaltBytes.length);
    
    // Use the user's password as input for PBKDF2
    const passwordInput = new TextEncoder().encode(`${this.userEncryptionKeyPassword}:key-bag-encryption`);
    
    const passwordKey = await subtle.importKey(
      "raw",
      passwordInput,
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    
    // Derive AES-GCM key using PBKDF2
    const derivedKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: combinedSalt,
        iterations: 310000, // OWASP-recommended PBKDF2 iterations for PBKDF2-SHA256
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
    
    // Generate IV for AES-GCM
    const ivArray = new Uint8Array(12); // 12 bytes for AES-GCM
    randomValues(ivArray);
    const iv = new Uint8Array(ivArray);
    
    // Encrypt the plaintext
    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      derivedKey,
      plaintext.buffer as ArrayBuffer
    );
    
    // Extract ciphertext and tag
    const encryptedArray = new Uint8Array(encrypted);
    const tagLength = 16; // 128 bits = 16 bytes
    const ciphertext = encryptedArray.slice(0, encryptedArray.length - tagLength);
    const tag = encryptedArray.slice(encryptedArray.length - tagLength);
    
    // Combine IV + tag + ciphertext
    // Format: IV (12 bytes) + tag (16 bytes) + ciphertext (variable)
    const result = new Uint8Array(12 + 16 + ciphertext.length);
    result.set(iv, 0);
    result.set(tag, 12);
    result.set(ciphertext, 12 + 16);
    
    this.logger.debug(`Saved key bag (${plaintext.length} -> ${result.length} bytes)`);
    return result;
  }

  /**
   * Load the key bag from a binary data blob, decrypted with the user encryption key.
   * 
   * @param encryptedData The encrypted binary data to load (Uint8Array)
   * @return A promise that resolves when the keys are loaded
   */
  async load(encryptedData: Uint8Array): Promise<void> {
    this.logger.debug(`Loading key bag`);
    
    if (encryptedData.length < 28) {
      throw new Error("Encrypted data too short (missing IV and tag)");
    }
    
    // Extract IV, tag, and ciphertext
    const iv = encryptedData.slice(0, 12);
    const tag = encryptedData.slice(12, 28);
    const ciphertext = encryptedData.slice(28);
    
    const subtle = this.cryptoAdapter.getSubtle();
    
    // Derive the same AES-GCM key (same process as encryption)
    const userKeySaltBytes = this.base64ToUint8Array(this.userEncryptionKey.salt);
    
    // Combine with the same fixed string as encryption
    const saltStringBytes = new TextEncoder().encode("key-bag-encryption");
    const combinedSalt = new Uint8Array(userKeySaltBytes.length + saltStringBytes.length);
    combinedSalt.set(userKeySaltBytes);
    combinedSalt.set(saltStringBytes, userKeySaltBytes.length);
    
    // Use the user's password as input for PBKDF2 (same as encryption)
    const passwordInput = new TextEncoder().encode(`${this.userEncryptionKeyPassword}:key-bag-encryption`);
    
    const passwordKey = await subtle.importKey(
      "raw",
      passwordInput,
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    
    // Derive AES-GCM key using PBKDF2 (same parameters as encryption)
    const derivedKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: combinedSalt,
        iterations: 310000, // OWASP-recommended PBKDF2 iterations for PBKDF2-SHA256
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
    
    // Combine ciphertext and tag
    const encryptedDataWithTag = new Uint8Array(ciphertext.length + tag.length);
    encryptedDataWithTag.set(ciphertext);
    encryptedDataWithTag.set(tag, ciphertext.length);
    
    // Decrypt
    const decrypted = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      derivedKey,
      encryptedDataWithTag.buffer as ArrayBuffer
    );
    
    // Deserialize JSON to map
    const decryptedArray = new Uint8Array(decrypted);
    const jsonString = new TextDecoder().decode(decryptedArray);
    const mapArray: Array<[string, Array<{key: string, createdAt?: number}>]> = JSON.parse(jsonString);
    
    // Convert base64 strings back to Uint8Array arrays
    // Support multiple keys per keyId with createdAt timestamps
    this.keys = new Map(
      mapArray.map(([keyId, keyEntries]) => [
        keyId,
        keyEntries.map(entry => ({
          key: this.base64ToUint8Array(entry.key),
          createdAt: entry.createdAt
        }))
      ])
    );
    
    this.logger.debug(`Loaded key bag (${encryptedData.length} -> ${this.keys.size} keys)`);
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

    const iterations = 310000; // OWASP-recommended PBKDF2 iterations for PBKDF2-SHA256
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
