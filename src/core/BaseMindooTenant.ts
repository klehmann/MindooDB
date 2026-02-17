import {
  MindooTenant,
  EncryptedPrivateKey,
  MindooDB,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  OpenStoreOptions,
  OpenDBOptions,
  MindooTenantFactory,
  MindooTenantDirectory,
  SigningKeyPair,
  JoinRequest,
  JoinResponse,
  ApproveJoinRequestOptions,
  PublishToServerOptions,
  PUBLIC_INFOS_KEY_ID,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { KeyBag } from "./keys/KeyBag";
import { BaseMindooDB } from "./BaseMindooDB";
import { BaseMindooTenantDirectory } from "./BaseMindooTenantDirectory";
import { MindooDocSigner } from "./crypto/MindooDocSigner";
import { SymmetricKeyNotFoundError } from "./errors";
import { Logger, MindooLogger, getDefaultLogLevel } from "./logging";
import { encodeMindooURI, decodeMindooURI, isMindooURI } from "./uri/MindooURI";

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

  // Cache for decrypted keys (to avoid repeated decryption)
  private decryptedTenantKeyCache?: Uint8Array;
  private decryptedUserSigningKeyCache?: CryptoKey;
  private decryptedUserEncryptionKeyCache?: CryptoKey;
  private logger: Logger;

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
    cryptoAdapter?: CryptoAdapter,
    logger?: Logger,
    additionalTrustedKeys?: ReadonlyMap<string, boolean>
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
    // Import createCryptoAdapter dynamically to avoid issues in browser environments
    if (!cryptoAdapter) {
      const { createCryptoAdapter } = require("./crypto/CryptoAdapter");
      this.cryptoAdapter = createCryptoAdapter();
    } else {
      this.cryptoAdapter = cryptoAdapter;
    }
    // Create logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `Tenant:${tenantId}`, true);
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

  async encryptPayload(payload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    this.logger.debug(`Encrypting payload with key: ${decryptionKeyId}`);
    this.logger.debug(`Payload size: ${payload.length} bytes`);

    // Get the symmetric key for this key ID
    let symmetricKey: Uint8Array;
    try {
      if (decryptionKeyId === "default") {
        this.logger.debug(`Using default key (tenant encryption key)`);
        // Use cached tenant encryption key if available
        if (this.decryptedTenantKeyCache) {
          symmetricKey = this.decryptedTenantKeyCache;
          this.logger.debug(`Using cached tenant key, length: ${symmetricKey.length} bytes`);
        } else {
          this.logger.debug(`Resolving tenant encryption key from KeyBag`);
          const tenantKey = await this.keyBag.get("tenant", this.tenantId);
          if (!tenantKey) {
            throw new SymmetricKeyNotFoundError(`tenant:${this.tenantId}`);
          }
          symmetricKey = tenantKey;
          this.decryptedTenantKeyCache = symmetricKey;
          this.logger.debug(`Loaded tenant key from KeyBag, length: ${symmetricKey.length} bytes`);
        }
      } else {
        this.logger.debug(`Getting named key from KeyBag: ${decryptionKeyId}`);
        // Get the decrypted key from KeyBag
        const decryptedKey = await this.keyBag.get("doc", decryptionKeyId);
        if (!decryptedKey) {
          throw new SymmetricKeyNotFoundError(decryptionKeyId);
        }
        symmetricKey = decryptedKey;
        this.logger.debug(`Got named key, length: ${symmetricKey.length} bytes`);
      }
    } catch (error) {
      this.logger.error(`Error getting symmetric key:`, error);
      throw error;
    }
    
    this.logger.debug(`Got symmetric key, length: ${symmetricKey.length} bytes`);
    
    const subtle = this.cryptoAdapter.getSubtle();
    // Bind getRandomValues to maintain 'this' context
    const randomValues = this.cryptoAdapter.getRandomValues.bind(this.cryptoAdapter);

    // Import the symmetric key
    this.logger.debug(`Importing symmetric key for AES-GCM`);
    let cryptoKey: CryptoKey;
    try {
      // Create a new Uint8Array to ensure we have a proper ArrayBuffer
      const keyArray = new Uint8Array(symmetricKey);
      this.logger.debug(`Key buffer size: ${keyArray.buffer.byteLength} bytes`);
      cryptoKey = await subtle.importKey(
        "raw",
        keyArray.buffer,
        { name: "AES-GCM" },
        false, // not extractable
        ["encrypt"]
      );
      this.logger.debug(`Successfully imported key`);
    } catch (error) {
      this.logger.error(`Error importing key:`, error);
      this.logger.error(`Key length: ${symmetricKey.length}, expected: 32 bytes for AES-256`);
      throw error;
    }

    // Generate IV (12 bytes for AES-GCM)
    this.logger.debug(`Generating IV`);
    let iv: Uint8Array;
    try {
      const ivArray = new Uint8Array(12);
      randomValues(ivArray);
      iv = new Uint8Array(ivArray.buffer, ivArray.byteOffset, ivArray.byteLength);
      this.logger.debug(`Generated IV: ${iv.length} bytes`);
    } catch (error) {
      this.logger.error(`Error generating IV:`, error);
      throw error;
    }

    // Encrypt the payload
    this.logger.debug(`Encrypting payload with AES-GCM`);
    this.logger.debug(`Payload buffer size: ${payload.buffer.byteLength} bytes`);
    this.logger.debug(`Payload byteOffset: ${payload.byteOffset}, byteLength: ${payload.byteLength}`);
    let encrypted: ArrayBuffer;
    try {
      // Create a new Uint8Array to ensure we have a proper ArrayBuffer
      const payloadArray = new Uint8Array(payload);
      this.logger.debug(`Using payload array: ${payloadArray.length} bytes`);
      encrypted = await subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          tagLength: 128, // 128-bit authentication tag
        },
        cryptoKey,
        payloadArray
      );
      this.logger.debug(`Successfully encrypted payload, encrypted size: ${encrypted.byteLength} bytes`);
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
    this.logger.debug(`Combining IV and encrypted data`);
    const encryptedArray = new Uint8Array(encrypted);
    const result = new Uint8Array(12 + encryptedArray.length);
    result.set(iv, 0);
    result.set(encryptedArray, 12);

    this.logger.debug(`Encrypted payload (${payload.length} -> ${result.length} bytes)`);
    return result;
  }

  async decryptPayload(encryptedPayload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
    this.logger.debug(`Decrypting payload with key: ${decryptionKeyId}`);

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
        const tenantKey = await this.keyBag.get("tenant", this.tenantId);
        if (!tenantKey) {
          throw new SymmetricKeyNotFoundError(`tenant:${this.tenantId}`);
        }
        symmetricKey = tenantKey;
        this.decryptedTenantKeyCache = symmetricKey;
      }
    } else {
      // Get the decrypted key from KeyBag
      const decryptedKey = await this.keyBag.get("doc", decryptionKeyId);
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

    this.logger.debug(`Decrypted payload (${encryptedPayload.length} -> ${decrypted.byteLength} bytes)`);
    return new Uint8Array(decrypted);
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

    this.logger.info(`Signature verification result: ${isValid}`);
    return isValid;
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    this.logger.info(`Validating public signing key`);

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
    
    const dbLogger = this.logger.createChild("BaseMindooDB");
    const db = new BaseMindooDB(
      this, 
      docStore, 
      attachmentStore, 
      attachmentConfig,
      adminOnlyDb ?? false,
      dbLogger
    );
    await db.initialize();
    
    // Cache the database for future use
    this.databaseCache.set(id, db);
    return db;
  }

  createDocSignerFor(signKey: SigningKeyPair): MindooDocSigner {
    this.logger.debug(`Creating MindooDocSigner for signing key pair`);
    const signerLogger = this.logger.createChild("MindooDocSigner");
    return new MindooDocSigner(this, signKey, signerLogger);
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
    await directory.registerUser(
      publicUserId,
      options.adminSigningKey,
      options.adminPassword
    );

    // 2. Export the tenant key encrypted with the share password
    const encryptedTenantKey = await this.keyBag.encryptAndExportKey(
      "tenant",
      this.tenantId,
      options.sharePassword
    );
    if (!encryptedTenantKey) {
      throw new Error(`Failed to export tenant key for tenant "${this.tenantId}"`);
    }

    // 3. Export the $publicinfos key encrypted with the share password
    const encryptedPublicInfosKey = await this.keyBag.encryptAndExportKey(
      "doc",
      PUBLIC_INFOS_KEY_ID,
      options.sharePassword
    );
    if (!encryptedPublicInfosKey) {
      throw new Error(`Failed to export $publicinfos key`);
    }

    // 4. Build the join response
    const joinResponse: JoinResponse = {
      v: 1,
      tenantId: this.tenantId,
      adminSigningPublicKey: this.administrationPublicKey,
      adminEncryptionPublicKey: this.administrationEncryptionPublicKey,
      encryptedTenantKey,
      encryptedPublicInfosKey,
    };

    if (options.serverUrl) {
      joinResponse.serverUrl = options.serverUrl;
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
   */
  async publishToServer(serverUrl: string, options?: PublishToServerOptions): Promise<void> {
    console.log(`[publishToServer] Publishing tenant "${this.tenantId}" to server: ${serverUrl}`);
    this.logger.info(`Publishing tenant "${this.tenantId}" to server: ${serverUrl}`);

    // Export the $publicinfos key so the server can read the directory DB
    const publicInfosKeyBytes = await this.keyBag.get("doc", PUBLIC_INFOS_KEY_ID);
    if (!publicInfosKeyBytes) {
      throw new Error(`Cannot publish to server: $publicinfos key not found in KeyBag`);
    }
    const publicInfosKeyBase64 = this.uint8ArrayToBase64(publicInfosKeyBytes);

    // Build the registration request
    const requestBody: Record<string, unknown> = {
      tenantId: this.tenantId,
      adminSigningPublicKey: this.administrationPublicKey,
      adminEncryptionPublicKey: this.administrationEncryptionPublicKey,
      publicInfosKey: publicInfosKeyBase64,
    };

    // Add users if provided
    if (options?.registerUsers && options.registerUsers.length > 0) {
      requestBody.users = options.registerUsers.map((u) => ({
        username: u.username,
        signingPublicKey: u.userSigningPublicKey,
        encryptionPublicKey: u.userEncryptionPublicKey,
      }));
    }

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options?.adminApiKey) {
      headers["x-api-key"] = options.adminApiKey;
    }

    // POST to the server's admin register-tenant endpoint
    const url = `${serverUrl.replace(/\/$/, "")}/admin/register-tenant`;
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
   * Create a remote store connected to a MindooDB server, ready for sync.
   */
  async connectToServer(serverUrl: string, dbId: string): Promise<ContentAddressedStore> {
    console.log(`[connectToServer] Connecting to server: ${serverUrl}, db: ${dbId}`);
    this.logger.info(`Connecting to server: ${serverUrl}, db: ${dbId}`);

    // Lazy-import network modules to avoid circular dependencies and keep core lightweight
    const { HttpTransport } = await import("../appendonlystores/network/HttpTransport.js");
    const { ClientNetworkContentAddressedStore } = await import(
      "../appendonlystores/network/ClientNetworkContentAddressedStore.js"
    );

    // Create the HTTP transport
    const baseUrl = `${serverUrl.replace(/\/$/, "")}/${this.tenantId}`;
    const transport = new HttpTransport(
      {
        baseUrl,
        tenantId: this.tenantId,
        dbId,
      },
      this.logger.createChild("HttpTransport")
    );

    // Get the current user's decrypted signing key
    const signingKey = await this.getDecryptedSigningKey();

    // Get the current user's decrypted RSA encryption private key (for decrypting entries)
    const decryptedEncryptionKey = await this.getDecryptedEncryptionKey();

    // Create the client network store
    const store = new ClientNetworkContentAddressedStore(
      dbId,
      transport,
      this.cryptoAdapter,
      this.currentUser.username,
      signingKey,
      decryptedEncryptionKey,
      this.logger.createChild(`ClientNetworkStore:${dbId}`)
    );

    console.log(`[connectToServer] ✓ Connected to server for db "${dbId}"`);
    this.logger.info(`Connected to server for db "${dbId}"`);

    return store;
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
    this.logger.debug(`decryptPrivateKey: Starting decryption with saltString: ${saltString}`);
    this.logger.debug(`decryptPrivateKey: Password length: ${password.length}`);
    this.logger.debug(`decryptPrivateKey: EncryptedKey iterations: ${encryptedKey.iterations}`);
    
    const subtle = this.cryptoAdapter.getSubtle();

    // Decode base64 strings
    this.logger.debug(`decryptPrivateKey: Decoding base64 strings`);
    let ciphertext: Uint8Array;
    let iv: Uint8Array;
    let tag: Uint8Array;
    let saltBytes: Uint8Array;
    try {
      ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
      iv = this.base64ToUint8Array(encryptedKey.iv);
      tag = this.base64ToUint8Array(encryptedKey.tag);
      saltBytes = this.base64ToUint8Array(encryptedKey.salt);
      this.logger.debug(`decryptPrivateKey: Decoded - ciphertext: ${ciphertext.length} bytes, iv: ${iv.length} bytes, tag: ${tag.length} bytes, salt: ${saltBytes.length} bytes`);
    } catch (error) {
      this.logger.error(`decryptPrivateKey: Error decoding base64:`, error);
      throw error;
    }

    // Derive key from password using PBKDF2
    // Combine the stored salt bytes with the salt string for additional security
    // This ensures different key types (signing, encryption, etc.) use different derived keys
    // even if they share the same password
    this.logger.debug(`decryptPrivateKey: Combining salt with saltString`);
    const saltStringBytes = new TextEncoder().encode(saltString);
    const combinedSalt = new Uint8Array(saltBytes.length + saltStringBytes.length);
    combinedSalt.set(saltBytes);
    combinedSalt.set(saltStringBytes, saltBytes.length);
    this.logger.debug(`decryptPrivateKey: Combined salt length: ${combinedSalt.length} bytes`);

    this.logger.debug(`decryptPrivateKey: Importing password key for PBKDF2`);
    let passwordKey: CryptoKey;
    try {
      passwordKey = await subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
      );
      this.logger.debug(`decryptPrivateKey: Successfully imported password key`);
    } catch (error) {
      this.logger.error(`decryptPrivateKey: Error importing password key:`, error);
      throw error;
    }

    this.logger.debug(`decryptPrivateKey: Deriving key with PBKDF2 (iterations: ${encryptedKey.iterations})`);
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
      this.logger.debug(`decryptPrivateKey: Successfully derived key`);
    } catch (error) {
      this.logger.error(`decryptPrivateKey: Error deriving key:`, error);
      throw error;
    }

    // Combine ciphertext and tag (GCM authentication tag is separate)
    // AES-GCM expects the tag to be appended to the ciphertext
    this.logger.debug(`decryptPrivateKey: Combining ciphertext and tag`);
    const encryptedData = new Uint8Array(ciphertext.length + tag.length);
    encryptedData.set(ciphertext);
    encryptedData.set(tag, ciphertext.length);
    this.logger.debug(`decryptPrivateKey: Combined encrypted data length: ${encryptedData.length} bytes`);

    // Decrypt the private key
    this.logger.debug(`decryptPrivateKey: Decrypting with AES-GCM`);
    this.logger.debug(`decryptPrivateKey: IV length: ${iv.length} bytes (expected: 12 for AES-GCM)`);
    this.logger.debug(`decryptPrivateKey: Tag length: ${tag.length} bytes (expected: 16 for 128-bit tag)`);
    this.logger.debug(`decryptPrivateKey: Ciphertext length: ${ciphertext.length} bytes`);
    let decrypted: ArrayBuffer;
    try {
      // Create a new ArrayBuffer to ensure we have the correct buffer without any offset issues
      const encryptedBuffer = new Uint8Array(encryptedData).buffer;
      this.logger.debug(`decryptPrivateKey: Encrypted buffer size: ${encryptedBuffer.byteLength} bytes`);
      
      decrypted = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(iv), // Create a new Uint8Array to ensure proper buffer
          tagLength: 128,
        },
        derivedKey,
        encryptedBuffer
      );
      this.logger.debug(`decryptPrivateKey: Successfully decrypted, result length: ${decrypted.byteLength} bytes`);
    } catch (error) {
      this.logger.error(`decryptPrivateKey: Error during decryption:`, error);
      this.logger.error(`decryptPrivateKey: Error details:`, {
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
      const tenantKey = await this.keyBag.get("tenant", this.tenantId);
      if (!tenantKey) {
        throw new SymmetricKeyNotFoundError(`tenant:${this.tenantId}`);
      }
      const symmetricKey = tenantKey;
      this.decryptedTenantKeyCache = symmetricKey;
      return symmetricKey;
    } else {
      // Get the decrypted key from KeyBag
      const decryptedKey = await this.keyBag.get("doc", decryptionKeyId);
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
    this.logger.debug(`Decrypted attachment (${encryptedPayload.length} -> ${result.length} bytes)`);
    return result;
  }
}

