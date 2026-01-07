import {
  MindooTenant,
  EncryptedPrivateKey,
  MindooDB,
  AppendOnlyStore,
  AppendOnlyStoreFactory,
  MindooTenantFactory,
  MindooTenantDirectory,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag } from "./keys/KeyBag";
import { BaseMindooDB } from "./BaseMindooDB";
import { BaseMindooTenantDirectory } from "./BaseMindooTenantDirectory";

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
  private tenantEncryptionKey: EncryptedPrivateKey;
  private tenantEncryptionKeyPassword: string; // Password to decrypt tenant encryption key
  private administrationPublicKey: string; // Administration public key (Ed25519, PEM format)
  private currentUser: PrivateUserId;
  private currentUserPassword: string; // Password to decrypt user's private keys
  protected cryptoAdapter: CryptoAdapter;
  private keyBag: KeyBag;
  private storeFactory: AppendOnlyStoreFactory;
  private databaseCache: Map<string, MindooDB> = new Map();

  // Cache for decrypted keys (to avoid repeated decryption)
  private decryptedTenantKeyCache?: Uint8Array;
  private decryptedUserSigningKeyCache?: CryptoKey;
  private decryptedUserEncryptionKeyCache?: CryptoKey;

  constructor(
    factory: MindooTenantFactory,
    tenantId: string,
    tenantEncryptionKey: EncryptedPrivateKey,
    tenantEncryptionKeyPassword: string,
    administrationPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
    storeFactory: AppendOnlyStoreFactory,
    cryptoAdapter?: CryptoAdapter
  ) {
    this.factory = factory;
    this.tenantId = tenantId;
    this.tenantEncryptionKey = tenantEncryptionKey;
    this.tenantEncryptionKeyPassword = tenantEncryptionKeyPassword;
    this.administrationPublicKey = administrationPublicKey;
    this.currentUser = currentUser;
    this.currentUserPassword = currentUserPassword;
    this.keyBag = keyBag;
    this.storeFactory = storeFactory;
    // Import createCryptoAdapter dynamically to avoid issues in browser environments
    if (!cryptoAdapter) {
      const { createCryptoAdapter } = require("./crypto/CryptoAdapter");
      this.cryptoAdapter = createCryptoAdapter();
    } else {
      this.cryptoAdapter = cryptoAdapter;
    }
  }

  /**
   * Initialize the tenant.
   */
  async initialize(): Promise<void> {
    console.log(`[BaseMindooTenant] Initializing tenant ${this.tenantId}`);
    // KeyBag is already loaded by the caller before passing it to the constructor
    const keyCount = (await this.keyBag.listKeys()).length;
    console.log(`[BaseMindooTenant] Tenant initialized with ${keyCount} keys in KeyBag`);
  }

  getCryptoAdapter(): CryptoAdapter {
    return this.cryptoAdapter;
  }

  getFactory(): MindooTenantFactory {
    return this.factory;
  }

  getId(): string {
    return this.tenantId;
  }

  getTenantEncryptionKey(): EncryptedPrivateKey {
    return this.tenantEncryptionKey;
  }

  async addNamedKey(
    keyId: string,
    encryptedKey: EncryptedPrivateKey,
    encryptedKeyPassword: string
  ): Promise<void> {
    if (keyId === "default") {
      throw new Error('Key ID "default" is reserved for the tenant encryption key');
    }
    console.log(`[BaseMindooTenant] Adding named key: ${keyId}`);

    // Decrypt the encrypted key and store it in KeyBag
    // KeyBag handles persistence via its save() method (called by the caller)
    await this.keyBag.decryptAndImportKey(keyId, encryptedKey, encryptedKeyPassword);
    
    console.log(`[BaseMindooTenant] Added named key: ${keyId}`);
  }

  async encryptPayload(payload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    console.log(`[BaseMindooTenant] Encrypting payload with key: ${decryptionKeyId}`);

    // Get the symmetric key for this key ID
    let symmetricKey: Uint8Array;
    if (decryptionKeyId === "default") {
      // Use cached tenant encryption key if available
      if (this.decryptedTenantKeyCache) {
        symmetricKey = this.decryptedTenantKeyCache;
      } else {
        // Decrypt tenant encryption key
        const decrypted = await this.decryptPrivateKey(
          this.tenantEncryptionKey,
          this.tenantEncryptionKeyPassword,
          "default"
        );
        symmetricKey = new Uint8Array(decrypted);
        this.decryptedTenantKeyCache = symmetricKey;
      }
    } else {
      // Get the decrypted key from KeyBag
      const decryptedKey = await this.keyBag.get(decryptionKeyId);
      if (!decryptedKey) {
        throw new Error(`Symmetric key not found: ${decryptionKeyId}`);
      }
      symmetricKey = decryptedKey;
    }
    
    const subtle = this.cryptoAdapter.getSubtle();
    const randomValues = this.cryptoAdapter.getRandomValues;

    // Import the symmetric key
    const cryptoKey = await subtle.importKey(
      "raw",
      symmetricKey.buffer as ArrayBuffer,
      { name: "AES-GCM" },
      false, // not extractable
      ["encrypt"]
    );

    // Generate IV (12 bytes for AES-GCM)
    const ivArray = new Uint8Array(12);
    randomValues(ivArray);
    const iv = new Uint8Array(ivArray.buffer, ivArray.byteOffset, ivArray.byteLength);

    // Encrypt the payload
    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        tagLength: 128, // 128-bit authentication tag
      },
      cryptoKey,
      payload.buffer as ArrayBuffer
    );

    // Combine IV and encrypted data
    // Format: IV (12 bytes) + encrypted data (includes authentication tag)
    const encryptedArray = new Uint8Array(encrypted);
    const result = new Uint8Array(12 + encryptedArray.length);
    result.set(iv, 0);
    result.set(encryptedArray, 12);

    console.log(`[BaseMindooTenant] Encrypted payload (${payload.length} -> ${result.length} bytes)`);
    return result;
  }

  async decryptPayload(encryptedPayload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    console.log(`[BaseMindooTenant] Decrypting payload with key: ${decryptionKeyId}`);

    if (encryptedPayload.length < 12) {
      throw new Error("Encrypted payload too short (missing IV)");
    }

    // Extract IV (first 12 bytes) and encrypted data (rest)
    const iv = encryptedPayload.slice(0, 12);
    const encryptedData = encryptedPayload.slice(12);

    // Get the symmetric key for this key ID
    let symmetricKey: Uint8Array;
    if (decryptionKeyId === "default") {
      // Use cached tenant encryption key if available
      if (this.decryptedTenantKeyCache) {
        symmetricKey = this.decryptedTenantKeyCache;
      } else {
        // Decrypt tenant encryption key
        const decrypted = await this.decryptPrivateKey(
          this.tenantEncryptionKey,
          this.tenantEncryptionKeyPassword,
          "default"
        );
        symmetricKey = new Uint8Array(decrypted);
        this.decryptedTenantKeyCache = symmetricKey;
      }
    } else {
      // Get the decrypted key from KeyBag
      const decryptedKey = await this.keyBag.get(decryptionKeyId);
      if (!decryptedKey) {
        throw new Error(`Symmetric key not found: ${decryptionKeyId}`);
      }
      symmetricKey = decryptedKey;
    }
    
    const subtle = this.cryptoAdapter.getSubtle();

    // Import the symmetric key
    const cryptoKey = await subtle.importKey(
      "raw",
      symmetricKey.buffer as ArrayBuffer,
      { name: "AES-GCM" },
      false, // not extractable
      ["decrypt"]
    );

    // Decrypt the payload
    const decrypted = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128, // 128-bit authentication tag
      },
      cryptoKey,
      encryptedData.buffer as ArrayBuffer
    );

    console.log(`[BaseMindooTenant] Decrypted payload (${encryptedPayload.length} -> ${decrypted.byteLength} bytes)`);
    return new Uint8Array(decrypted);
  }

  async signPayload(payload: Uint8Array): Promise<Uint8Array> {
    console.log(`[BaseMindooTenant] Signing payload`);

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

    console.log(`[BaseMindooTenant] Signed payload (signature: ${signature.byteLength} bytes)`);
    return new Uint8Array(signature);
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    console.log(`[BaseMindooTenant] Validating public signing key`);

    // Load the directory database to check if this key belongs to a trusted user
    const directoryDB = await this.openDB("directory");
    
    // TODO: Query the directory database to check if this public key belongs to a registered,
    // non-revoked user. For now, return true as a placeholder.
    // The directory database should contain user records with their public signing keys.
    
    // This is a placeholder - in a full implementation, we would:
    // 1. Query the directory database for users with this public key
    // 2. Check if the user is registered and not revoked
    // 3. Return true only if the key belongs to a trusted user
    
    return true; // TODO: Implement actual validation against directory database
  }

  async getCurrentUserId(): Promise<PublicUserId> {
    // Convert PrivateUserId to PublicUserId
    return {
      username: this.currentUser.username,
      administrationSignature: this.currentUser.administrationSignature,
      userSigningPublicKey: this.currentUser.userSigningKeyPair.publicKey,
      userEncryptionPublicKey: this.currentUser.userEncryptionKeyPair.publicKey,
    };
  }

  async openDirectory(): Promise<MindooTenantDirectory> {
    const directory = new BaseMindooTenantDirectory(this);
    await directory.initialize();
    return directory;
  }

  async openDB(id: string): Promise<MindooDB> {
    // Return cached database if it exists
    if (this.databaseCache[id]) {
      return this.databaseCache[id];
    }

    // Create the database store using the factory
    const store = this.storeFactory.createStore(id);
    const db = new BaseMindooDB(this, id, store);
    await db.initialize();
    
    // Cache the database for future use
    this.databaseCache[id] = db;
    return db;
  }

  /**
   * Internal method to get the decrypted signing key for the current user.
   */
  private async getDecryptedSigningKey(): Promise<CryptoKey> {
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
    const subtle = this.cryptoAdapter.getSubtle();

    // Decode base64 strings
    const ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
    const iv = this.base64ToUint8Array(encryptedKey.iv);
    const tag = this.base64ToUint8Array(encryptedKey.tag);
    const saltBytes = this.base64ToUint8Array(encryptedKey.salt);

    // Derive key from password using PBKDF2
    // Combine the stored salt bytes with the salt string for additional security
    // This ensures different key types (signing, encryption, etc.) use different derived keys
    // even if they share the same password
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
}

