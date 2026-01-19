import {
  MindooTenant,
  EncryptedPrivateKey,
  MindooDB,
  ContentAddressedStoreFactory,
  OpenStoreOptions,
  OpenDBOptions,
  MindooTenantFactory,
  MindooTenantDirectory,
  SigningKeyPair,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag } from "./keys/KeyBag";
import { BaseMindooDB } from "./BaseMindooDB";
import { BaseMindooTenantDirectory } from "./BaseMindooTenantDirectory";
import { MindooDocSigner } from "./crypto/MindooDocSigner";
import { SymmetricKeyNotFoundError } from "./errors";

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
  private administrationEncryptionPublicKey: string; // Administration encryption public key (RSA-OAEP, PEM format)
  private currentUser: PrivateUserId;
  private currentUserPassword: string; // Password to decrypt user's private keys
  protected cryptoAdapter: CryptoAdapter;
  private keyBag: KeyBag;
  private storeFactory: ContentAddressedStoreFactory;
  private databaseCache: Map<string, MindooDB> = new Map();
  private directoryCache: MindooTenantDirectory | null = null;

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
    administrationEncryptionPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
    storeFactory: ContentAddressedStoreFactory,
    cryptoAdapter?: CryptoAdapter
  ) {
    this.factory = factory;
    this.tenantId = tenantId;
    this.tenantEncryptionKey = tenantEncryptionKey;
    this.tenantEncryptionKeyPassword = tenantEncryptionKeyPassword;
    this.administrationPublicKey = administrationPublicKey;
    this.administrationEncryptionPublicKey = administrationEncryptionPublicKey;
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

  getTenantEncryptionKey(): EncryptedPrivateKey {
    return this.tenantEncryptionKey;
  }

  async encryptPayload(payload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    console.log(`[BaseMindooTenant] Encrypting payload with key: ${decryptionKeyId}`);
    console.log(`[BaseMindooTenant] Payload size: ${payload.length} bytes`);

    // Get the symmetric key for this key ID
    let symmetricKey: Uint8Array;
    try {
      if (decryptionKeyId === "default") {
        console.log(`[BaseMindooTenant] Using default key (tenant encryption key)`);
        // Use cached tenant encryption key if available
        if (this.decryptedTenantKeyCache) {
          symmetricKey = this.decryptedTenantKeyCache;
          console.log(`[BaseMindooTenant] Using cached tenant key, length: ${symmetricKey.length} bytes`);
        } else {
          console.log(`[BaseMindooTenant] Decrypting tenant encryption key`);
          // Decrypt tenant encryption key
          const decrypted = await this.decryptPrivateKey(
            this.tenantEncryptionKey,
            this.tenantEncryptionKeyPassword,
            "default"
          );
          symmetricKey = new Uint8Array(decrypted);
          this.decryptedTenantKeyCache = symmetricKey;
          console.log(`[BaseMindooTenant] Decrypted tenant key, length: ${symmetricKey.length} bytes`);
        }
      } else {
        console.log(`[BaseMindooTenant] Getting named key from KeyBag: ${decryptionKeyId}`);
        // Get the decrypted key from KeyBag
        const decryptedKey = await this.keyBag.get(decryptionKeyId);
        if (!decryptedKey) {
          throw new SymmetricKeyNotFoundError(decryptionKeyId);
        }
        symmetricKey = decryptedKey;
        console.log(`[BaseMindooTenant] Got named key, length: ${symmetricKey.length} bytes`);
      }
    } catch (error) {
      console.error(`[BaseMindooTenant] Error getting symmetric key:`, error);
      throw error;
    }
    
    console.log(`[BaseMindooTenant] Got symmetric key, length: ${symmetricKey.length} bytes`);
    
    const subtle = this.cryptoAdapter.getSubtle();
    // Bind getRandomValues to maintain 'this' context
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);

    // Import the symmetric key
    console.log(`[BaseMindooTenant] Importing symmetric key for AES-GCM`);
    let cryptoKey: CryptoKey;
    try {
      // Create a new Uint8Array to ensure we have a proper ArrayBuffer
      const keyArray = new Uint8Array(symmetricKey);
      console.log(`[BaseMindooTenant] Key buffer size: ${keyArray.buffer.byteLength} bytes`);
      cryptoKey = await subtle.importKey(
        "raw",
        keyArray.buffer,
        { name: "AES-GCM" },
        false, // not extractable
        ["encrypt"]
      );
      console.log(`[BaseMindooTenant] Successfully imported key`);
    } catch (error) {
      console.error(`[BaseMindooTenant] Error importing key:`, error);
      console.error(`[BaseMindooTenant] Key length: ${symmetricKey.length}, expected: 32 bytes for AES-256`);
      throw error;
    }

    // Generate IV (12 bytes for AES-GCM)
    console.log(`[BaseMindooTenant] Generating IV`);
    let iv: Uint8Array;
    try {
      const ivArray = new Uint8Array(12);
      randomValues(ivArray);
      iv = new Uint8Array(ivArray.buffer, ivArray.byteOffset, ivArray.byteLength);
      console.log(`[BaseMindooTenant] Generated IV: ${iv.length} bytes`);
    } catch (error) {
      console.error(`[BaseMindooTenant] Error generating IV:`, error);
      throw error;
    }

    // Encrypt the payload
    console.log(`[BaseMindooTenant] Encrypting payload with AES-GCM`);
    console.log(`[BaseMindooTenant] Payload buffer size: ${payload.buffer.byteLength} bytes`);
    console.log(`[BaseMindooTenant] Payload byteOffset: ${payload.byteOffset}, byteLength: ${payload.byteLength}`);
    let encrypted: ArrayBuffer;
    try {
      // Create a new Uint8Array to ensure we have a proper ArrayBuffer
      const payloadArray = new Uint8Array(payload);
      console.log(`[BaseMindooTenant] Using payload array: ${payloadArray.length} bytes`);
      encrypted = await subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          tagLength: 128, // 128-bit authentication tag
        },
        cryptoKey,
        payloadArray
      );
      console.log(`[BaseMindooTenant] Successfully encrypted payload, encrypted size: ${encrypted.byteLength} bytes`);
    } catch (error) {
      console.error(`[BaseMindooTenant] Error encrypting payload:`, error);
      console.error(`[BaseMindooTenant] Error details:`, {
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
    console.log(`[BaseMindooTenant] Combining IV and encrypted data`);
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
        throw new SymmetricKeyNotFoundError(decryptionKeyId);
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

  async signPayloadWithKey(
    payload: Uint8Array,
    signingKeyPair: SigningKeyPair,
    password: string
  ): Promise<Uint8Array> {
    console.log(`[BaseMindooTenant] Signing payload with provided key`);

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

    console.log(`[BaseMindooTenant] Signed payload with provided key (signature: ${signature.byteLength} bytes)`);
    return new Uint8Array(signature);
  }

  async verifySignature(payload: Uint8Array, signature: Uint8Array, publicKey: string): Promise<boolean> {
    console.log(`[BaseMindooTenant] Verifying signature`);

    const directory = await this.openDirectory();
    const isTrusted = await directory.validatePublicSigningKey(publicKey);
    if (!isTrusted) {
      console.warn(`[BaseMindooTenant] Public key not trusted: ${publicKey}`);
      return false;
    }

    const subtle = this.cryptoAdapter.getSubtle();

    // Convert PEM format to ArrayBuffer
    const publicKeyBuffer = this.pemToArrayBuffer(publicKey);

    // Import the public key from SPKI format
    const cryptoKey = await subtle.importKey(
      "spki",
      publicKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["verify"]
    );

    // Verify the signature
    const isValid = await subtle.verify(
      {
        name: "Ed25519",
      },
      cryptoKey,
      signature.buffer as ArrayBuffer,
      payload.buffer as ArrayBuffer
    );

    console.log(`[BaseMindooTenant] Signature verification result: ${isValid}`);
    return isValid;
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
    if (!this.directoryCache) {
      this.directoryCache = new BaseMindooTenantDirectory(this);
    }
    return this.directoryCache;
  }

  async openDB(id: string, options?: OpenDBOptions): Promise<MindooDB> {
    // Enforce admin-only mode for directory database - this is a security invariant
    // The directory database must only accept entries signed by the admin key
    const effectiveOptions: OpenDBOptions = id === "directory"
      ? { ...options, adminOnlyDb: true }
      : options ?? {};
    
    // Return cached database if it exists
    const cached = this.databaseCache.get(id);
    if (cached) {
      // For directory DB, verify admin-only flag matches (defensive check)
      if (id === "directory" && !cached.isAdminOnlyDb()) {
        throw new Error("Directory database was cached without adminOnlyDb - this should never happen");
      }
      return cached;
    }

    // Extract store options and DB-specific options
    const { adminOnlyDb, attachmentConfig, ...storeOptions } = effectiveOptions;
    
    // Create the database stores using the factory
    const { docStore, attachmentStore } = this.storeFactory.createStore(id, storeOptions);
    
    const db = new BaseMindooDB(
      this, 
      docStore, 
      attachmentStore, 
      attachmentConfig,
      adminOnlyDb ?? false
    );
    await db.initialize();
    
    // Cache the database for future use
    this.databaseCache.set(id, db);
    return db;
  }

  createDocSignerFor(signKey: SigningKeyPair): MindooDocSigner {
    console.log(`[BaseMindooTenant] Creating MindooDocSigner for signing key pair`);
    return new MindooDocSigner(this, signKey);
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
    console.log(`[BaseMindooTenant] decryptPrivateKey: Starting decryption with saltString: ${saltString}`);
    console.log(`[BaseMindooTenant] decryptPrivateKey: Password length: ${password.length}`);
    console.log(`[BaseMindooTenant] decryptPrivateKey: EncryptedKey iterations: ${encryptedKey.iterations}`);
    
    const subtle = this.cryptoAdapter.getSubtle();

    // Decode base64 strings
    console.log(`[BaseMindooTenant] decryptPrivateKey: Decoding base64 strings`);
    let ciphertext: Uint8Array;
    let iv: Uint8Array;
    let tag: Uint8Array;
    let saltBytes: Uint8Array;
    try {
      ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
      iv = this.base64ToUint8Array(encryptedKey.iv);
      tag = this.base64ToUint8Array(encryptedKey.tag);
      saltBytes = this.base64ToUint8Array(encryptedKey.salt);
      console.log(`[BaseMindooTenant] decryptPrivateKey: Decoded - ciphertext: ${ciphertext.length} bytes, iv: ${iv.length} bytes, tag: ${tag.length} bytes, salt: ${saltBytes.length} bytes`);
    } catch (error) {
      console.error(`[BaseMindooTenant] decryptPrivateKey: Error decoding base64:`, error);
      throw error;
    }

    // Derive key from password using PBKDF2
    // Combine the stored salt bytes with the salt string for additional security
    // This ensures different key types (signing, encryption, etc.) use different derived keys
    // even if they share the same password
    console.log(`[BaseMindooTenant] decryptPrivateKey: Combining salt with saltString`);
    const saltStringBytes = new TextEncoder().encode(saltString);
    const combinedSalt = new Uint8Array(saltBytes.length + saltStringBytes.length);
    combinedSalt.set(saltBytes);
    combinedSalt.set(saltStringBytes, saltBytes.length);
    console.log(`[BaseMindooTenant] decryptPrivateKey: Combined salt length: ${combinedSalt.length} bytes`);

    console.log(`[BaseMindooTenant] decryptPrivateKey: Importing password key for PBKDF2`);
    let passwordKey: CryptoKey;
    try {
      passwordKey = await subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
      );
      console.log(`[BaseMindooTenant] decryptPrivateKey: Successfully imported password key`);
    } catch (error) {
      console.error(`[BaseMindooTenant] decryptPrivateKey: Error importing password key:`, error);
      throw error;
    }

    console.log(`[BaseMindooTenant] decryptPrivateKey: Deriving key with PBKDF2 (iterations: ${encryptedKey.iterations})`);
    let derivedKey: CryptoKey;
    try {
      derivedKey = await subtle.deriveKey(
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
      console.log(`[BaseMindooTenant] decryptPrivateKey: Successfully derived key`);
    } catch (error) {
      console.error(`[BaseMindooTenant] decryptPrivateKey: Error deriving key:`, error);
      throw error;
    }

    // Combine ciphertext and tag (GCM authentication tag is separate)
    // AES-GCM expects the tag to be appended to the ciphertext
    console.log(`[BaseMindooTenant] decryptPrivateKey: Combining ciphertext and tag`);
    const encryptedData = new Uint8Array(ciphertext.length + tag.length);
    encryptedData.set(ciphertext);
    encryptedData.set(tag, ciphertext.length);
    console.log(`[BaseMindooTenant] decryptPrivateKey: Combined encrypted data length: ${encryptedData.length} bytes`);

    // Decrypt the private key
    console.log(`[BaseMindooTenant] decryptPrivateKey: Decrypting with AES-GCM`);
    console.log(`[BaseMindooTenant] decryptPrivateKey: IV length: ${iv.length} bytes (expected: 12 for AES-GCM)`);
    console.log(`[BaseMindooTenant] decryptPrivateKey: Tag length: ${tag.length} bytes (expected: 16 for 128-bit tag)`);
    console.log(`[BaseMindooTenant] decryptPrivateKey: Ciphertext length: ${ciphertext.length} bytes`);
    let decrypted: ArrayBuffer;
    try {
      // Create a new ArrayBuffer to ensure we have the correct buffer without any offset issues
      const encryptedBuffer = new Uint8Array(encryptedData).buffer;
      console.log(`[BaseMindooTenant] decryptPrivateKey: Encrypted buffer size: ${encryptedBuffer.byteLength} bytes`);
      
      decrypted = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(iv), // Create a new Uint8Array to ensure proper buffer
          tagLength: 128,
        },
        derivedKey,
        encryptedBuffer
      );
      console.log(`[BaseMindooTenant] decryptPrivateKey: Successfully decrypted, result length: ${decrypted.byteLength} bytes`);
    } catch (error) {
      console.error(`[BaseMindooTenant] decryptPrivateKey: Error during decryption:`, error);
      console.error(`[BaseMindooTenant] decryptPrivateKey: Error details:`, {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        ivLength: iv.length,
        tagLength: tag.length,
        ciphertextLength: ciphertext.length,
        encryptedDataLength: encryptedData.length,
        iterations: encryptedKey.iterations,
        saltString: saltString,
        encryptedDataByteOffset: encryptedData.byteOffset,
        encryptedDataByteLength: encryptedData.byteLength,
        encryptedDataBufferLength: encryptedData.buffer.byteLength,
      });
      throw error;
    }

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
      // Decrypt tenant encryption key
      const decrypted = await this.decryptPrivateKey(
        this.tenantEncryptionKey,
        this.tenantEncryptionKeyPassword,
        "default"
      );
      const symmetricKey = new Uint8Array(decrypted);
      this.decryptedTenantKeyCache = symmetricKey;
      return symmetricKey;
    } else {
      // Get the decrypted key from KeyBag
      const decryptedKey = await this.keyBag.get(decryptionKeyId);
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
    console.log(`[BaseMindooTenant] Encrypting attachment payload with key: ${decryptionKeyId}`);
    
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
      console.log(`[BaseMindooTenant] Using deterministic IV derived from content hash`);
    } else {
      // Random IV
      iv = new Uint8Array(12);
      randomValues(iv);
      console.log(`[BaseMindooTenant] Using random IV`);
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

    console.log(`[BaseMindooTenant] Encrypted attachment (mode=${mode}, ${payload.length} -> ${result.length} bytes)`);
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
    console.log(`[BaseMindooTenant] Decrypting attachment payload with key: ${decryptionKeyId}`);
    
    if (encryptedPayload.length < 13) {
      throw new Error("Invalid encrypted attachment payload: too short");
    }

    // Read mode byte
    const mode = encryptedPayload[0];
    if (mode !== BaseMindooTenant.ENCRYPTION_MODE_RANDOM && 
        mode !== BaseMindooTenant.ENCRYPTION_MODE_DETERMINISTIC) {
      throw new Error(`Invalid encryption mode: ${mode}`);
    }
    console.log(`[BaseMindooTenant] Decrypting attachment with mode=${mode}`);

    // Extract IV (bytes 1-12)
    const iv = encryptedPayload.slice(1, 13);
    
    // Extract ciphertext (bytes 13 onwards)
    const ciphertext = encryptedPayload.slice(13);

    const symmetricKey = await this.getSymmetricKey(decryptionKeyId);
    const subtle = this.cryptoAdapter.getSubtle();

    // Import the symmetric key
    const keyArray = new Uint8Array(symmetricKey);
    const cryptoKey = await subtle.importKey(
      "raw",
      keyArray.buffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );

    // Decrypt
    const decrypted = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        tagLength: 128,
      },
      cryptoKey,
      ciphertext
    );

    const result = new Uint8Array(decrypted);
    console.log(`[BaseMindooTenant] Decrypted attachment (${encryptedPayload.length} -> ${result.length} bytes)`);
    return result;
  }
}

