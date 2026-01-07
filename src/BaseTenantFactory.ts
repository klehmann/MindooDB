import {
  TenantFactory,
  MindooTenant,
  EncryptedPrivateKey,
  AppendOnlyStoreFactory,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { BaseMindooTenant } from "./BaseMindooTenant";
import { CryptoAdapter, createCryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag } from "./keys/KeyBag";

/**
 * BaseTenantFactory is a platform-agnostic implementation of TenantFactory
 * that creates and manages tenants and users.
 * 
 * It uses CryptoAdapter to abstract platform-specific crypto operations,
 * allowing the same implementation to work in browsers and Node.js.
 */
export class BaseTenantFactory implements TenantFactory {
  private cryptoAdapter: CryptoAdapter;
  private storeFactory: AppendOnlyStoreFactory;

  constructor(storeFactory: AppendOnlyStoreFactory, cryptoAdapter?: CryptoAdapter) {
    this.storeFactory = storeFactory;
    this.cryptoAdapter = cryptoAdapter || createCryptoAdapter();
  }

  /**
   * Create a new tenant from scratch with a new tenant encryption key and administration key.
   * 
   * @param tenantId The ID of the tenant
   * @param administrationKeyPassword The password used to encrypt the administration private key
   * @param tenantEncryptionKeyPassword The password to decrypt the tenant encryption private key
   * @param currentUser The current user's private user ID (required for tenant operations)
   * @param currentUserPassword The password to decrypt the current user's private keys
   * @param keyBag The KeyBag instance for storing and loading named encrypted keys
   * @return The new tenant
   */
  async createTenant(
    tenantId: string,
    administrationKeyPassword: string,
    tenantEncryptionKeyPassword: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag
  ): Promise<MindooTenant> {
    console.log(`[BaseTenantFactory] Creating tenant: ${tenantId}`);

    const subtle = this.cryptoAdapter.getSubtle();
    const randomValues = this.cryptoAdapter.getRandomValues;

    // Generate tenant encryption key (AES-256)
    const tenantEncryptionKey = await subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true, // extractable
      ["encrypt", "decrypt"]
    );

    // Export the tenant encryption key material
    const tenantKeyMaterial = await subtle.exportKey("raw", tenantEncryptionKey);
    const tenantKeyBytes = new Uint8Array(tenantKeyMaterial);

    // Encrypt the tenant encryption key with password
    const encryptedTenantKey = await this.encryptPrivateKey(
      tenantKeyBytes,
      tenantEncryptionKeyPassword,
      "default"
    );

    // Generate tenant encryption public key identifier (PEM format for compatibility)
    // For symmetric keys, we use a hash of the key as the identifier
    const keyHash = await subtle.digest("SHA-256", tenantKeyBytes);
    const keyHashArray = new Uint8Array(keyHash);
    const tenantEncryptionPublicKey = this.uint8ArrayToPEM(keyHashArray, "PUBLIC KEY");

    // Generate administration key pair (Ed25519)
    const administrationKeyPair = await subtle.generateKey(
      {
        name: "Ed25519",
      },
      true, // extractable
      ["sign", "verify"]
    );

    // Export administration public key (PEM format)
    const administrationPublicKeyBuffer = await subtle.exportKey(
      "spki",
      administrationKeyPair.publicKey
    );
    const administrationPublicKey = this.arrayBufferToPEM(
      administrationPublicKeyBuffer,
      "PUBLIC KEY"
    );

    // Export administration private key
    const administrationPrivateKeyBuffer = await subtle.exportKey(
      "pkcs8",
      administrationKeyPair.privateKey
    );
    const administrationPrivateKeyBytes = new Uint8Array(administrationPrivateKeyBuffer);

    // Encrypt the administration private key with password
    const encryptedAdministrationKey = await this.encryptPrivateKey(
      administrationPrivateKeyBytes,
      administrationKeyPassword,
      "administration"
    );

    return this.openTenantWithKeys(
      tenantId,
      tenantEncryptionPublicKey,
      encryptedTenantKey,
      tenantEncryptionKeyPassword,
      administrationPublicKey,
      currentUser,
      currentUserPassword,
      keyBag
    );
  }

  /**
   * Opens an existing tenant with previously created keys.
   */
  async openTenantWithKeys(
    tenantId: string,
    tenantEncryptionPublicKey: string,
    tenantEncryptionPrivateKey: EncryptedPrivateKey,
    tenantEncryptionKeyPassword: string,
    administrationPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
  ): Promise<MindooTenant> {
    console.log(`[BaseTenantFactory] Opening tenant: ${tenantId}`);

    const tenant = new BaseMindooTenant(
      tenantId,
      tenantEncryptionPrivateKey,
      tenantEncryptionPublicKey,
      tenantEncryptionKeyPassword,
      administrationPublicKey,
      currentUser,
      currentUserPassword,
      keyBag,
      this.storeFactory,
      this.cryptoAdapter
    );

    // Initialize the tenant
    await tenant.initialize();

    return tenant;
  }

  /**
   * Creates a new user with separate signing and encryption key pairs.
   */
  async createUserId(username: string, password: string): Promise<PrivateUserId> {
    console.log(`[BaseTenantFactory] Creating user ID: ${username}`);

    const subtle = this.cryptoAdapter.getSubtle();

    // Generate signing key pair (Ed25519)
    const signingKeyPair = await subtle.generateKey(
      {
        name: "Ed25519",
      },
      true, // extractable
      ["sign", "verify"]
    );

    // Export signing public key (PEM format)
    const signingPublicKeyBuffer = await subtle.exportKey("spki", signingKeyPair.publicKey);
    const signingPublicKey = this.arrayBufferToPEM(signingPublicKeyBuffer, "PUBLIC KEY");

    // Export signing private key
    const signingPrivateKeyBuffer = await subtle.exportKey("pkcs8", signingKeyPair.privateKey);
    const signingPrivateKeyBytes = new Uint8Array(signingPrivateKeyBuffer);

    // Encrypt signing private key with password (salt: "signing")
    const encryptedSigningKey = await this.encryptPrivateKey(
      signingPrivateKeyBytes,
      password,
      "signing"
    );

    // Generate encryption key pair (RSA-OAEP, 2048 bits for good compatibility)
    const encryptionKeyPair = await subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), // 65537
        hash: "SHA-256",
      },
      true, // extractable
      ["encrypt", "decrypt"]
    );

    // Export encryption public key (PEM format)
    const encryptionPublicKeyBuffer = await subtle.exportKey("spki", encryptionKeyPair.publicKey);
    const encryptionPublicKey = this.arrayBufferToPEM(encryptionPublicKeyBuffer, "PUBLIC KEY");

    // Export encryption private key
    const encryptionPrivateKeyBuffer = await subtle.exportKey(
      "pkcs8",
      encryptionKeyPair.privateKey
    );
    const encryptionPrivateKeyBytes = new Uint8Array(encryptionPrivateKeyBuffer);

    // Encrypt encryption private key with password (salt: "encryption")
    const encryptedEncryptionKey = await this.encryptPrivateKey(
      encryptionPrivateKeyBytes,
      password,
      "encryption"
    );

    // Create PrivateUserId
    const privateUserId: PrivateUserId = {
      username,
      administrationSignature: "", // Will be set when user is registered by an admin
      userSigningPublicKey: signingPublicKey,
      userSigningPrivateKey: encryptedSigningKey,
      userEncryptionPublicKey: encryptionPublicKey,
      userEncryptionPrivateKey: encryptedEncryptionKey,
    };

    console.log(`[BaseTenantFactory] Created user ID: ${username}`);
    return privateUserId;
  }

  /**
   * Removes the private information from a private user ID and returns a public user ID.
   */
  toPublicUserId(privateUserId: PrivateUserId): PublicUserId {
    return {
      username: privateUserId.username,
      administrationSignature: privateUserId.administrationSignature,
      userSigningPublicKey: privateUserId.userSigningPublicKey,
      userEncryptionPublicKey: privateUserId.userEncryptionPublicKey,
    };
  }

  /**
   * Creates a new signing private key for the tenant.
   */
  async createSigningPrivateKey(password: string): Promise<EncryptedPrivateKey> {
    console.log(`[BaseTenantFactory] Creating encrypted signing private key`);

    const subtle = this.cryptoAdapter.getSubtle();

    // Generate a new Ed25519 signing key pair
    const keyPair = await subtle.generateKey(
      {
        name: "Ed25519",
      },
      true, // extractable
      ["sign", "verify"]
    );

    // Export the private key in PKCS8 format
    const privateKeyBuffer = await subtle.exportKey("pkcs8", keyPair.privateKey);
    const keyBytes = new Uint8Array(privateKeyBuffer);

    // Encrypt the key material using the shared helper
    const encryptedKey = await this.encryptPrivateKey(keyBytes, password, "signing");

    console.log(`[BaseTenantFactory] Created encrypted signing private key`);
    return encryptedKey;
  }

  /**
   * Creates a new encrypted symmetric key (AES-256) for document encryption.
   */
  async createEncryptedPrivateKey(password: string): Promise<EncryptedPrivateKey> {
    console.log(`[BaseTenantFactory] Creating encrypted symmetric key`);

    const subtle = this.cryptoAdapter.getSubtle();

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

    // Encrypt the key material using the shared helper
    // Use "symmetric" as the salt string for generic symmetric keys
    const encryptedKey = await this.encryptPrivateKey(keyBytes, password, "symmetric");

    console.log(`[BaseTenantFactory] Created encrypted symmetric key`);
    return encryptedKey;
  }

  /**
   * Internal method to encrypt a private key using password-based key derivation.
   * This is the reverse of BaseMindooTenant.decryptPrivateKey().
   * 
   * @param privateKeyBytes The private key bytes to encrypt
   * @param password The password to encrypt the key with
   * @param saltString The salt string for key derivation (e.g., "signing", "encryption", "administration", keyId)
   * @returns The encrypted private key
   */
  private async encryptPrivateKey(
    privateKeyBytes: Uint8Array,
    password: string,
    saltString: string
  ): Promise<EncryptedPrivateKey> {
    const subtle = this.cryptoAdapter.getSubtle();
    const randomValues = this.cryptoAdapter.getRandomValues;

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

    const iterations = 100000; // Standard PBKDF2 iterations
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
   * Convert ArrayBuffer to PEM format
   */
  private arrayBufferToPEM(buffer: ArrayBuffer, type: string): string {
    const bytes = new Uint8Array(buffer);
    return this.uint8ArrayToPEM(bytes, type);
  }

  /**
   * Convert Uint8Array to PEM format
   */
  private uint8ArrayToPEM(bytes: Uint8Array, type: string): string {
    const base64 = this.uint8ArrayToBase64(bytes);
    const chunks = base64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${chunks.join("\n")}\n-----END ${type}-----`;
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

