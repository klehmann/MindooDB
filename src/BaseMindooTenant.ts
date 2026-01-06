import {
  MindooTenant,
  EncryptedPrivateKey,
  MindooDB,
  AppendOnlyStore,
  AppendOnlyStoreFactory,
  MindooDoc,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag } from "./keys/KeyBag";
import { BaseMindooDB } from "./BaseMindooDB";

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
  private tenantId: string;
  private tenantEncryptionKey: EncryptedPrivateKey;
  private tenantEncryptionPublicKey: string; // Key identifier (PEM format for compatibility)
  private tenantEncryptionKeyPassword: string; // Password to decrypt tenant encryption key
  private currentUser: PrivateUserId;
  private currentUserPassword: string; // Password to decrypt user's private keys
  private cryptoAdapter: CryptoAdapter;
  private keyBag: KeyBag;
  private storeFactory: AppendOnlyStoreFactory;
  private databaseCache: Map<string, MindooDB> = new Map();

  // Cache for decrypted keys (to avoid repeated decryption)
  private decryptedTenantKeyCache?: Uint8Array;
  private decryptedUserSigningKeyCache?: CryptoKey;
  private decryptedUserEncryptionKeyCache?: CryptoKey;

  constructor(
    tenantId: string,
    tenantEncryptionKey: EncryptedPrivateKey,
    tenantEncryptionPublicKey: string,
    tenantEncryptionKeyPassword: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
    storeFactory: AppendOnlyStoreFactory,
    cryptoAdapter?: CryptoAdapter
  ) {
    this.tenantId = tenantId;
    this.tenantEncryptionKey = tenantEncryptionKey;
    this.tenantEncryptionPublicKey = tenantEncryptionPublicKey;
    this.tenantEncryptionKeyPassword = tenantEncryptionKeyPassword;
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

  getId(): string {
    return this.tenantId;
  }

  getTenantEncryptionPublicKey(): string {
    return this.tenantEncryptionPublicKey;
  }

  getTenantEncryptionPrivateKey(): EncryptedPrivateKey {
    return this.tenantEncryptionKey;
  }

  async createEncryptedPrivateKey(password: string): Promise<EncryptedPrivateKey> {
    console.log(`[BaseMindooTenant] Creating encrypted symmetric key`);

    const subtle = this.cryptoAdapter.getSubtle();
    const randomValues = this.cryptoAdapter.getRandomValues;

    // Generate a new AES-256 key
    const key = await subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true, // extractable
      ["encrypt", "decrypt"]
    );

    // Export the key material
    const keyMaterial = await subtle.exportKey("raw", key);
    const keyBytes = new Uint8Array(keyMaterial);

    // Generate IV and salt
    const ivArray = new Uint8Array(12); // 12 bytes for AES-GCM
    randomValues(ivArray);
    const iv = Uint8Array.from(ivArray);
    
    const saltArray = new Uint8Array(16); // 16 bytes salt
    randomValues(saltArray);
    const salt = Uint8Array.from(saltArray);

    // Derive encryption key from password using PBKDF2
    const passwordKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    // Use only the salt (no keyId mixing)
    const derivedKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
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

    // Encrypt the symmetric key
    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      derivedKey,
      keyBytes.buffer as ArrayBuffer
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
      iterations: 100000,
      createdAt: Date.now(),
    };

    console.log(`[BaseMindooTenant] Created encrypted symmetric key`);
    return encryptedKey;
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
    const directoryDB = await this.openDirectoryDB();
    
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
      userSigningPublicKey: this.currentUser.userSigningPublicKey,
      userEncryptionPublicKey: this.currentUser.userEncryptionPublicKey,
    };
  }

  async registerUser(
    userId: PublicUserId,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenant] Registering user: ${userId.username}`);

    // Decrypt the administration private key
    const adminKey = await this.decryptPrivateKey(
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      "administration"
    );

    // Sign the user registration with the administration key
    const registrationData = JSON.stringify({
      username: userId.username,
      userSigningPublicKey: userId.userSigningPublicKey,
      userEncryptionPublicKey: userId.userEncryptionPublicKey,
      timestamp: Date.now(),
    });
    const registrationDataBytes = new TextEncoder().encode(registrationData);

    const subtle = this.cryptoAdapter.getSubtle();
    const cryptoKey = await subtle.importKey(
      "pkcs8",
      adminKey,
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    const signature = await subtle.sign(
      { name: "Ed25519" },
      cryptoKey,
      registrationDataBytes
    );

    // Add user to directory database
    const directoryDB = await this.openDirectoryDB();
    const newDoc = await directoryDB.createDocument();
    await directoryDB.changeDoc(newDoc, (doc: MindooDoc) => {
      const data = doc.getData();
      data.username = userId.username;
      data.userSigningPublicKey = userId.userSigningPublicKey;
      data.userEncryptionPublicKey = userId.userEncryptionPublicKey;
      data.registrationData = this.uint8ArrayToBase64(registrationDataBytes);
      data.administrationSignature = this.uint8ArrayToBase64(new Uint8Array(signature));
    });
    
    console.log(`[BaseMindooTenant] Registered user: ${userId.username}`);
  }

  async revokeUser(
    username: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenant] Revoking user: ${username}`);

    // Decrypt the administration private key
    const adminKey = await this.decryptPrivateKey(
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      "administration"
    );

    // Sign the revocation with the administration key
    const revocationData = JSON.stringify({
      username: username,
      revokedAt: Date.now(),
    });
    const revocationDataBytes = new TextEncoder().encode(revocationData);

    const subtle = this.cryptoAdapter.getSubtle();
    const cryptoKey = await subtle.importKey(
      "pkcs8",
      adminKey,
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    const signature = await subtle.sign(
      { name: "Ed25519" },
      cryptoKey,
      revocationDataBytes
    );

    // Add revocation record to directory database
    const directoryDB = await this.openDirectoryDB();
    
    const newDoc = await directoryDB.createDocument();
    await directoryDB.changeDoc(newDoc, (doc: MindooDoc) => {
      const data = doc.getData();
      data.username = username;
      data.revokedAt = Date.now();
      data.revocationData = this.uint8ArrayToBase64(revocationDataBytes);
      data.revocationSignature = this.uint8ArrayToBase64(new Uint8Array(signature));
    });
    
    console.log(`[BaseMindooTenant] Revoked user: ${username}`);
  }

  async openDirectoryDB(): Promise<MindooDB> {
    return this.openDB("directory");
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
      this.currentUser.userSigningPrivateKey,
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
   * Internal method to get the decrypted encryption key for the current user.
   * Used for encrypting/decrypting the named symmetric keys map.
   */
  private async getDecryptedUserEncryptionKey(): Promise<CryptoKey> {
    // Use cached encryption key if available
    if (this.decryptedUserEncryptionKeyCache) {
      return this.decryptedUserEncryptionKeyCache;
    }

    // Decrypt the user's encryption private key
    const decryptedKeyBuffer = await this.decryptPrivateKey(
      this.currentUser.userEncryptionPrivateKey,
      this.currentUserPassword,
      "encryption"
    );

    const subtle = this.cryptoAdapter.getSubtle();

    // Import the decrypted key - try RSA-OAEP first, fall back to ECDH if needed
    // The key format depends on what was used during key creation
    let cryptoKey: CryptoKey;
    try {
      // Try RSA-OAEP (RSA encryption)
      cryptoKey = await subtle.importKey(
        "pkcs8",
        decryptedKeyBuffer,
        {
          name: "RSA-OAEP",
          hash: "SHA-256",
        },
        false,
        ["decrypt"]
      );
    } catch (error) {
      // Fall back to ECDH if RSA fails
      try {
        cryptoKey = await subtle.importKey(
          "pkcs8",
          decryptedKeyBuffer,
          {
            name: "ECDH",
            namedCurve: "P-256",
          },
          false,
          ["deriveKey", "deriveBits"]
        );
      } catch (error2) {
        throw new Error(`Failed to import user encryption key. Tried RSA-OAEP and ECDH. Error: ${error2}`);
      }
    }

    this.decryptedUserEncryptionKeyCache = cryptoKey;
    return cryptoKey;
  }

  /**
   * Internal method to decrypt a private key using password-based key derivation.
   * 
   * @param encryptedKey The encrypted private key
   * @param password The password to decrypt the key
   * @param saltString The salt string for key derivation (e.g., "signing", "encryption", "administration", keyId)
   *                   This is combined with the encryptedKey.salt for additional security
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

