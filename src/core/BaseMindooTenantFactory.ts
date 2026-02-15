import {
  MindooTenantFactory,
  MindooTenant,
  EncryptedPrivateKey,
  ContentAddressedStoreFactory,
  SigningKeyPair,
  EncryptionKeyPair,
  PUBLIC_INFOS_KEY_ID,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { BaseMindooTenant } from "./BaseMindooTenant";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { DEFAULT_PBKDF2_ITERATIONS, resolvePbkdf2Iterations } from "./crypto/pbkdf2Iterations";
import { KeyBag } from "./keys/KeyBag";
import { Logger, LogLevel, MindooLogger, getDefaultLogLevel } from "./logging";

/**
 * BaseTenantFactory is a platform-agnostic implementation of TenantFactory
 * that creates and manages tenants and users.
 * 
 * It uses CryptoAdapter to abstract platform-specific crypto operations,
 * allowing the same implementation to work in browsers and Node.js.
 */
export class BaseMindooTenantFactory implements MindooTenantFactory {
  private cryptoAdapter: CryptoAdapter;
  private storeFactory: ContentAddressedStoreFactory;
  private logger: Logger;

  constructor(
    storeFactory: ContentAddressedStoreFactory,
    cryptoAdapter: CryptoAdapter,
    logger?: Logger
  ) {
    this.storeFactory = storeFactory;
    this.cryptoAdapter = cryptoAdapter;
    // Create root logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "MindooTenantFactory", true);
  }

  getCryptoAdapter(): CryptoAdapter {
    return this.cryptoAdapter;
  }

  /**
   * Opens an existing tenant.
   */
  async openTenant(
    tenantId: string,
    administrationPublicKey: string,
    administrationEncryptionPublicKey: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
  ): Promise<MindooTenant>;
  async openTenant(
    tenantId: string,
    currentUser: PrivateUserId,
    currentUserPassword: string,
    keyBag: KeyBag,
  ): Promise<MindooTenant>;
  async openTenant(
    tenantId: string,
    arg2: string | PrivateUserId,
    arg3: string | PrivateUserId,
    arg4: string | PrivateUserId | KeyBag,
    arg5?: PrivateUserId | string | KeyBag,
    arg6?: string | KeyBag,
    arg7?: KeyBag,
  ): Promise<MindooTenant> {
    this.logger.info(`Opening tenant: ${tenantId}`);

    let administrationPublicKey: string;
    let administrationEncryptionPublicKey: string;
    let currentUser: PrivateUserId;
    let currentUserPassword: string;
    let keyBag: KeyBag;

    if (typeof arg2 === "string") {
      administrationPublicKey = arg2;
      administrationEncryptionPublicKey = arg3 as string;
      currentUser = arg4 as PrivateUserId;
      currentUserPassword = arg5 as string;
      keyBag = arg6 as KeyBag;
    } else {
      // Backward-compatible short form for internal tests
      currentUser = arg2;
      currentUserPassword = arg3 as string;
      keyBag = arg4 as KeyBag;
      administrationPublicKey = currentUser.userSigningKeyPair.publicKey;
      administrationEncryptionPublicKey = currentUser.userEncryptionKeyPair.publicKey;
    }

    if (administrationPublicKey === currentUser.userSigningKeyPair.publicKey) {
      throw new Error(
        "Invalid openTenant configuration: currentUser must not be the administration identity. " +
          "Use a regular user for tenant operations and keep admin credentials for privileged directory operations only."
      );
    }

    await this.assertRequiredKeysInKeyBag(tenantId, keyBag);

    const tenantLogger = this.logger.createChild(`Tenant:${tenantId}`);
    const tenant = new BaseMindooTenant(
      this,
      tenantId,
      administrationPublicKey,
      administrationEncryptionPublicKey,
      currentUser,
      currentUserPassword,
      keyBag,
      this.storeFactory,
      this.cryptoAdapter,
      tenantLogger
    );

    // Initialize the tenant
    await tenant.initialize();

    return tenant;
  }

  /**
   * Creates a new user with separate signing and encryption key pairs.
   */
  async createUserId(username: string, password: string): Promise<PrivateUserId> {
    this.logger.debug(`Creating user ID: ${username}`);
    console.log('[createUserId] Starting createUserId for:', username);
    const startTime = Date.now();

    const subtle = this.cryptoAdapter.getSubtle();
    console.log('[createUserId] Got subtle crypto API');

    // Generate signing key pair (Ed25519)
    console.log('[createUserId] Step 1: Generating Ed25519 signing key pair...');
    const signingKeyPairStart = Date.now();
    const signingKeyPair = await subtle.generateKey(
      {
        name: "Ed25519",
      },
      true, // extractable
      ["sign", "verify"]
    );
    console.log('[createUserId] Step 1: ✓ Ed25519 signing key pair generated in', Date.now() - signingKeyPairStart, 'ms');

    // Export signing public key (PEM format)
    console.log('[createUserId] Step 2: Exporting signing public key...');
    const exportSigningPublicStart = Date.now();
    const signingPublicKeyBuffer = await subtle.exportKey("spki", signingKeyPair.publicKey);
    const signingPublicKey = this.arrayBufferToPEM(signingPublicKeyBuffer, "PUBLIC KEY");
    console.log('[createUserId] Step 2: ✓ Signing public key exported in', Date.now() - exportSigningPublicStart, 'ms');

    // Export signing private key
    console.log('[createUserId] Step 3: Exporting signing private key...');
    const exportSigningPrivateStart = Date.now();
    const signingPrivateKeyBuffer = await subtle.exportKey("pkcs8", signingKeyPair.privateKey);
    const signingPrivateKeyBytes = new Uint8Array(signingPrivateKeyBuffer);
    console.log('[createUserId] Step 3: ✓ Signing private key exported in', Date.now() - exportSigningPrivateStart, 'ms');

    // Encrypt signing private key with password (salt: "signing")
    const pbkdf2Iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    console.log(`[createUserId] Step 4: Encrypting signing private key (PBKDF2 with ${pbkdf2Iterations} iterations)...`);
    const encryptSigningStart = Date.now();
    const encryptedSigningKey = await this.encryptPrivateKey(
      signingPrivateKeyBytes,
      password,
      "signing"
    );
    console.log('[createUserId] Step 4: ✓ Signing private key encrypted in', Date.now() - encryptSigningStart, 'ms');

    // Generate encryption key pair (RSA-OAEP, 3072 bits for state-of-the-art security)
    // NIST recommends 3072-bit RSA for new applications (security through 2030+)
    console.log('[createUserId] Step 5: Generating RSA-3072 encryption key pair (this may take 10-30 seconds in JS)...');
    const rsaKeyGenStart = Date.now();
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
    console.log('[createUserId] Step 5: ✓ RSA-3072 encryption key pair generated in', Date.now() - rsaKeyGenStart, 'ms');

    // Export encryption public key (PEM format)
    console.log('[createUserId] Step 6: Exporting encryption public key...');
    const exportEncryptionPublicStart = Date.now();
    const encryptionPublicKeyBuffer = await subtle.exportKey("spki", encryptionKeyPair.publicKey);
    const encryptionPublicKey = this.arrayBufferToPEM(encryptionPublicKeyBuffer, "PUBLIC KEY");
    console.log('[createUserId] Step 6: ✓ Encryption public key exported in', Date.now() - exportEncryptionPublicStart, 'ms');

    // Export encryption private key
    console.log('[createUserId] Step 7: Exporting encryption private key...');
    const exportEncryptionPrivateStart = Date.now();
    const encryptionPrivateKeyBuffer = await subtle.exportKey(
      "pkcs8",
      encryptionKeyPair.privateKey
    );
    const encryptionPrivateKeyBytes = new Uint8Array(encryptionPrivateKeyBuffer);
    console.log('[createUserId] Step 7: ✓ Encryption private key exported in', Date.now() - exportEncryptionPrivateStart, 'ms');

    // Encrypt encryption private key with password (salt: "encryption")
    console.log(`[createUserId] Step 8: Encrypting encryption private key (PBKDF2 with ${pbkdf2Iterations} iterations)...`);
    const encryptEncryptionStart = Date.now();
    const encryptedEncryptionKey = await this.encryptPrivateKey(
      encryptionPrivateKeyBytes,
      password,
      "encryption"
    );
    console.log('[createUserId] Step 8: ✓ Encryption private key encrypted in', Date.now() - encryptEncryptionStart, 'ms');

    // Create PrivateUserId
    console.log('[createUserId] Step 9: Creating PrivateUserId object...');
    const privateUserId: PrivateUserId = {
      username,
      userSigningKeyPair: {
        publicKey: signingPublicKey,
        privateKey: encryptedSigningKey,
      },
      userEncryptionKeyPair: {
        publicKey: encryptionPublicKey,
        privateKey: encryptedEncryptionKey,
      },
    };

    const totalTime = Date.now() - startTime;
    console.log('[createUserId] ✓ User ID created successfully in', totalTime, 'ms total');
    this.logger.debug(`Created user ID: ${username}`);
    return privateUserId;
  }

  /**
   * Removes the private information from a private user ID and returns a public user ID.
   */
  toPublicUserId(privateUserId: PrivateUserId): PublicUserId {
    return {
      username: privateUserId.username,
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
    this.logger.debug(`Creating signing key pair`);

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

    this.logger.debug(`Created signing key pair`);
    return {
      publicKey,
      privateKey: encryptedKey,
    };
  }

  /**
   * Creates a new asymmetric encryption key pair (RSA-OAEP) for user-to-user encryption.
   * Returns both the public and encrypted private key.
   * 
   * Use case: User A can fetch User B's public key from the directory DB, encrypt data with it,
   * and only User B (with the private key) can decrypt it.
   */
  async createEncryptionKeyPair(password: string): Promise<EncryptionKeyPair> {
    this.logger.debug(`Creating encryption key pair`);

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

    this.logger.debug(`Created encryption key pair`);
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
    console.log(`[encryptPrivateKey] Starting encryption with salt: "${saltString}", key size: ${privateKeyBytes.length} bytes`);
    const startTime = Date.now();
    
    const subtle = this.cryptoAdapter.getSubtle();
    // Bind getRandomValues to maintain 'this' context
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);

    // Generate random salt and IV
    console.log('[encryptPrivateKey] Generating random salt and IV...');
    const saltArray = new Uint8Array(16); // 16 bytes salt
    randomValues(saltArray);
    const salt = new Uint8Array(saltArray);

    const ivArray = new Uint8Array(12); // 12 bytes for AES-GCM
    randomValues(ivArray);
    const iv = new Uint8Array(ivArray);
    console.log('[encryptPrivateKey] ✓ Salt and IV generated');

    // Combine salt with saltString for key derivation (same as decryption)
    const saltStringBytes = new TextEncoder().encode(saltString);
    const combinedSalt = new Uint8Array(salt.length + saltStringBytes.length);
    combinedSalt.set(salt);
    combinedSalt.set(saltStringBytes, salt.length);

    // Derive encryption key from password using PBKDF2
    console.log('[encryptPrivateKey] Importing password key...');
    const importKeyStart = Date.now();
    const passwordKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );
    console.log('[encryptPrivateKey] ✓ Password key imported in', Date.now() - importKeyStart, 'ms');

    const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    console.log(`[encryptPrivateKey] Deriving key with PBKDF2 (${iterations} iterations)...`);
    const deriveKeyStart = Date.now();
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
    console.log('[encryptPrivateKey] ✓ Key derived in', Date.now() - deriveKeyStart, 'ms');

    // Encrypt the private key
    console.log('[encryptPrivateKey] Encrypting private key data...');
    const encryptStart = Date.now();
    const encrypted = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128,
      },
      derivedKey,
      privateKeyBytes.buffer as ArrayBuffer
    );
    console.log('[encryptPrivateKey] ✓ Private key encrypted in', Date.now() - encryptStart, 'ms');

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

    const totalTime = Date.now() - startTime;
    console.log(`[encryptPrivateKey] ✓ Encryption completed in ${totalTime}ms total`);
    return encryptedKey;
  }

  private async assertRequiredKeysInKeyBag(tenantId: string, keyBag: KeyBag): Promise<void> {
    const tenantKey = await keyBag.get("tenant", tenantId);
    if (!tenantKey) {
      throw new Error(
        `Missing required tenant key in KeyBag for tenant "${tenantId}". ` +
          `Create/import it first with keyBag.createTenantKey("${tenantId}") or keyBag.decryptAndImportKey("tenant", "${tenantId}", encryptedTenantKey, password).`
      );
    }

    const publicInfosKey = await keyBag.get("doc", PUBLIC_INFOS_KEY_ID);
    if (!publicInfosKey) {
      throw new Error(
        `Missing required directory access key in KeyBag: ("doc", "${PUBLIC_INFOS_KEY_ID}"). ` +
          `Create/import it first with keyBag.createDocKey("${PUBLIC_INFOS_KEY_ID}") or keyBag.decryptAndImportKey("doc", "${PUBLIC_INFOS_KEY_ID}", encryptedPublicInfosKey, password).`
      );
    }
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

