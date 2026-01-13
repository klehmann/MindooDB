import {
  MindooTenantFactory,
  MindooTenant,
  EncryptedPrivateKey,
  AppendOnlyStoreFactory,
  SigningKeyPair,
  EncryptionKeyPair,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { BaseMindooTenant } from "./BaseMindooTenant";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag } from "./keys/KeyBag";

/**
 * BaseTenantFactory is a platform-agnostic implementation of TenantFactory
 * that creates and manages tenants and users.
 * 
 * It uses CryptoAdapter to abstract platform-specific crypto operations,
 * allowing the same implementation to work in browsers and Node.js.
 */
export class BaseMindooTenantFactory implements MindooTenantFactory {
  private cryptoAdapter: CryptoAdapter;
  private storeFactory: AppendOnlyStoreFactory;

  constructor(storeFactory: AppendOnlyStoreFactory, cryptoAdapter: CryptoAdapter) {
    this.storeFactory = storeFactory;
    this.cryptoAdapter = cryptoAdapter;
  }

  getCryptoAdapter(): CryptoAdapter {
    return this.cryptoAdapter;
  }

  /**
   * Create a new tenant from scratch with a new tenant encryption key.
   * 
   * The administration public key must be created beforehand using createSigningKeyPair()
   * and passed to this method.
   * 
   * @param tenantId The ID of the tenant
   * @param administrationPublicKey The administration public key (Ed25519, PEM format) created using createSigningKeyPair()
   * @param tenantEncryptionKeyPassword The password to decrypt the tenant encryption private key
   * @param currentUser The current user's private user ID (required for tenant operations)
   * @param currentUserPassword The password to decrypt the current user's private keys
   * @param keyBag The KeyBag instance for storing and loading named encrypted keys
   * @return The new tenant
   */
  async createTenant(
    tenantId: string,
    administrationPublicKey: string,
    tenantEncryptionKeyPassword: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag
  ): Promise<MindooTenant> {
    console.log(`[BaseTenantFactory] Creating tenant: ${tenantId}`);

    const subtle = this.cryptoAdapter.getSubtle();

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

    return this.openTenantWithKeys(
      tenantId,
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
    tenantEncryptionPrivateKey: EncryptedPrivateKey,
    tenantEncryptionKeyPassword: string,
    administrationPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
  ): Promise<MindooTenant> {
    console.log(`[BaseTenantFactory] Opening tenant: ${tenantId}`);

    const tenant = new BaseMindooTenant(
      this,
      tenantId,
      tenantEncryptionPrivateKey,
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

    // Generate encryption key pair (RSA-OAEP, 3072 bits for state-of-the-art security)
    // NIST recommends 3072-bit RSA for new applications (security through 2030+)
    const encryptionKeyPair = await subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 3072,
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
      userSigningKeyPair: {
        publicKey: signingPublicKey,
        privateKey: encryptedSigningKey,
      },
      userEncryptionKeyPair: {
        publicKey: encryptionPublicKey,
        privateKey: encryptedEncryptionKey,
      },
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
      userSigningPublicKey: privateUserId.userSigningKeyPair.publicKey,
      userEncryptionPublicKey: privateUserId.userEncryptionKeyPair.publicKey,
    };
  }

  /**
   * Creates a new signing key pair for the tenant.
   * Returns both the public and encrypted private key, as the public key is needed
   * for signature verification by other users.
   */
  async createSigningKeyPair(password: string): Promise<SigningKeyPair> {
    console.log(`[BaseTenantFactory] Creating signing key pair`);

    const subtle = this.cryptoAdapter.getSubtle();

    // Generate a new Ed25519 signing key pair
    const keyPair = await subtle.generateKey(
      {
        name: "Ed25519",
      },
      true, // extractable
      ["sign", "verify"]
    );

    // Export the public key (PEM format) - needed for signature verification
    const publicKeyBuffer = await subtle.exportKey("spki", keyPair.publicKey);
    const publicKey = this.arrayBufferToPEM(publicKeyBuffer, "PUBLIC KEY");

    // Export the private key in PKCS8 format
    const privateKeyBuffer = await subtle.exportKey("pkcs8", keyPair.privateKey);
    const keyBytes = new Uint8Array(privateKeyBuffer);

    // Encrypt the key material using the shared helper
    const encryptedKey = await this.encryptPrivateKey(keyBytes, password, "signing");

    console.log(`[BaseTenantFactory] Created signing key pair`);
    return {
      publicKey,
      privateKey: encryptedKey,
    };
  }

  /**
   * Creates a new encrypted symmetric key (AES-256) for document encryption.
   * Symmetric keys are shared secrets - anyone with the key can both encrypt and decrypt.
   * For user-to-user encryption where only the recipient can decrypt, use createEncryptionKeyPair() instead.
   */
  async createSymmetricEncryptedPrivateKey(password: string): Promise<EncryptedPrivateKey> {
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
    // Use "default" as the salt string to match how tenant encryption keys are decrypted
    const encryptedKey = await this.encryptPrivateKey(keyBytes, password, "default");

    console.log(`[BaseTenantFactory] Created encrypted symmetric key`);
    return encryptedKey;
  }

  /**
   * Creates a new asymmetric encryption key pair (RSA-OAEP) for user-to-user encryption.
   * Returns both the public and encrypted private key.
   * 
   * Use case: User A can fetch User B's public key from the directory DB, encrypt data with it,
   * and only User B (with the private key) can decrypt it.
   */
  async createEncryptionKeyPair(password: string): Promise<EncryptionKeyPair> {
    console.log(`[BaseTenantFactory] Creating encryption key pair`);

    const subtle = this.cryptoAdapter.getSubtle();

    // Generate a new RSA-OAEP encryption key pair (3072 bits for state-of-the-art security)
    // NIST recommends 3072-bit RSA for new applications (security through 2030+)
    const encryptionKeyPair = await subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]), // 65537
        hash: "SHA-256",
      },
      true, // extractable
      ["encrypt", "decrypt"]
    );

    // Export the public key (PEM format) - can be shared for encryption
    const publicKeyBuffer = await subtle.exportKey("spki", encryptionKeyPair.publicKey);
    const publicKey = this.arrayBufferToPEM(publicKeyBuffer, "PUBLIC KEY");

    // Export the private key in PKCS8 format
    const privateKeyBuffer = await subtle.exportKey("pkcs8", encryptionKeyPair.privateKey);
    const privateKeyBytes = new Uint8Array(privateKeyBuffer);

    // Encrypt the private key material using the shared helper
    // Use "encryption" as the salt string (same as user encryption keys)
    const encryptedKey = await this.encryptPrivateKey(privateKeyBytes, password, "encryption");

    console.log(`[BaseTenantFactory] Created encryption key pair`);
    return {
      publicKey,
      privateKey: encryptedKey,
    };
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

