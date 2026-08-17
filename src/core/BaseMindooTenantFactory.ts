import {
  MindooTenantFactory,
  MindooTenant,
  EncryptedPrivateKey,
  ContentAddressedStoreFactory,
  SigningKeyPair,
  EncryptionKeyPair,
  PUBLIC_INFOS_KEY_ID,
  DEFAULT_TENANT_KEY_ID,
  CreateTenantOptions,
  CreateTenantResult,
  JoinRequest,
  JoinResponse,
  JoinTenantOptions,
  JoinTenantResult,
  OpenTenantOptions,
  DeviceTenantDelivery,
  DiscoverTenantsOnServerOptions,
  BootstrapTenantFromDeliveryOptions,
  BootstrapTenantFromDeliveryResult,
} from "./types";
import { PrivateUserId, PublicUserId } from "./userid";
import { BaseMindooTenant } from "./BaseMindooTenant";
import { CryptoAdapter } from "./crypto/CryptoAdapter";
import { decryptPrivateKey as decryptPrivateKeyWithPassword, encryptPrivateKey as encryptPrivateKeyWithPassword } from "./crypto/privateKeyEncryption";
import { generateRsaOaep3072 } from "./crypto/rsaOaep3072";
import { USERKEY_PRIVATE_SALT } from "./userkeys/types";
import { RSAEncryption } from "./crypto/RSAEncryption";
import { DEFAULT_PBKDF2_ITERATIONS, resolvePbkdf2Iterations } from "./crypto/pbkdf2Iterations";
import { KeyBag } from "./keys/KeyBag";
import { Logger, LogLevel, MindooLogger, getDefaultLogLevel } from "./logging";
import { encodeMindooURI, decodeMindooURI, isMindooURI } from "./uri/MindooURI";
import { encodeJoinRequestUri } from "./uri/joinRequestUri";
import { validateTenantId } from "./tenantIdValidation";
import { semanticNow } from "./utils/timeSource";
import type { LocalCacheStore } from "./cache/LocalCacheStore";
import { readTenantSetupLabel, writeTenantSetupLabel } from "./tenantSetup";
import { StoreKind } from "./appendonlystores/types";

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
  private localCacheStore?: LocalCacheStore;

  constructor(
    storeFactory: ContentAddressedStoreFactory,
    cryptoAdapter: CryptoAdapter,
    logger?: Logger,
    localCacheStore?: LocalCacheStore,
  ) {
    this.storeFactory = storeFactory;
    this.cryptoAdapter = cryptoAdapter;
    this.localCacheStore = localCacheStore;
    // Create root logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "MindooTenantFactory", true);
  }

  getLocalCacheStore(): LocalCacheStore | undefined {
    return this.localCacheStore;
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
    options?: OpenTenantOptions,
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
    arg5?: PrivateUserId | string | KeyBag | OpenTenantOptions,
    arg6?: string | KeyBag | OpenTenantOptions,
    arg7?: KeyBag | OpenTenantOptions,
    arg8?: OpenTenantOptions,
  ): Promise<MindooTenant> {
    this.logger.info(`Opening tenant: ${tenantId}`);

    let administrationPublicKey: string;
    let administrationEncryptionPublicKey: string;
    let currentUser: PrivateUserId;
    let currentUserPassword: string;
    let keyBag: KeyBag;
    let options: OpenTenantOptions | undefined;

    if (typeof arg2 === "string") {
      administrationPublicKey = arg2;
      administrationEncryptionPublicKey = arg3 as string;
      currentUser = arg4 as PrivateUserId;
      currentUserPassword = arg5 as string;
      keyBag = arg6 as KeyBag;
      options = arg7 as OpenTenantOptions | undefined;
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
      tenantLogger,
      options?.additionalTrustedKeys,
      this.localCacheStore,
      options?.preDecryptedUserKeys
        ? {
            signingKey: options.preDecryptedUserKeys.signingKey,
            encryptionKey: options.preDecryptedUserKeys.encryptionKey,
            cacheEncryptionKey: options.preDecryptedUserKeys.cacheEncryptionKey,
          }
        : undefined,
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

  async ensureUserKeyPair(user: PrivateUserId, password: string): Promise<EncryptionKeyPair> {
    if (user.userKeyPair) return user.userKeyPair;
    const generated = await generateRsaOaep3072(this.cryptoAdapter);
    const encrypted = await encryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      generated.privateKeyBytes,
      password,
      USERKEY_PRIVATE_SALT,
    );
    user.userKeyPair = {
      publicKey: generated.publicKeyPem,
      privateKey: encrypted,
    };
    return user.userKeyPair;
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

  async changeIdentityPassword(
    identity: PrivateUserId,
    oldPassword: string,
    newPassword: string,
  ): Promise<PrivateUserId> {
    this.logger.debug(`Changing identity password for: ${identity.username}`);

    const decryptedSigningKey = await decryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      identity.userSigningKeyPair.privateKey,
      oldPassword,
      "signing",
    );
    const decryptedEncryptionKey = await decryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      identity.userEncryptionKeyPair.privateKey,
      oldPassword,
      "encryption",
    );

    const encryptedSigningKey = await encryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      new Uint8Array(decryptedSigningKey),
      newPassword,
      "signing",
    );
    const encryptedEncryptionKey = await encryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      new Uint8Array(decryptedEncryptionKey),
      newPassword,
      "encryption",
    );

    let userKeyPair: EncryptionKeyPair | undefined;
    if (identity.userKeyPair) {
      try {
        userKeyPair = {
          publicKey: identity.userKeyPair.publicKey,
          privateKey: await encryptPrivateKeyWithPassword(
            this.cryptoAdapter,
            new Uint8Array(
              await decryptPrivateKeyWithPassword(
                this.cryptoAdapter,
                identity.userKeyPair.privateKey,
                oldPassword,
                USERKEY_PRIVATE_SALT,
              ),
            ),
            newPassword,
            USERKEY_PRIVATE_SALT,
          ),
        };
      } catch (error) {
        // Haven verifies the password by calling this with old === new.
        // A stored User-Key that cannot be opened (wrong salt, truncated JSON)
        // must not block unlocking the signing/encryption keys.
        try {
          this.logger.warn(
            `Skipping User-Key re-encrypt for ${identity.username}; signing/encryption keys still opened`,
            error,
          );
        } catch {
          // Logging a DOMException must never fail password change / unlock.
        }
      }
    }

    return {
      username: identity.username,
      userSigningKeyPair: {
        publicKey: identity.userSigningKeyPair.publicKey,
        privateKey: encryptedSigningKey,
      },
      userEncryptionKeyPair: {
        publicKey: identity.userEncryptionKeyPair.publicKey,
        privateKey: encryptedEncryptionKey,
      },
      ...(userKeyPair ? { userKeyPair } : {}),
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

  // ==================== Convenience Methods ====================

  /**
   * Create a new tenant with a single call.
   */
  async createTenant(options: CreateTenantOptions): Promise<CreateTenantResult> {
    const tenantId = validateTenantId(options.tenantId);
    this.logger.info(`Creating tenant: ${tenantId}`);
    const hasExistingUsers = "adminUser" in options;
    const adminLabel = hasExistingUsers ? options.adminUser.username : options.adminName;
    const userLabel = hasExistingUsers ? options.appUser.username : options.userName;
    console.log(`[createTenant] Creating tenant "${tenantId}" with admin "${adminLabel}" and user "${userLabel}"`);

    // 1. Create or reuse admin and app user identities
    const adminUser = hasExistingUsers
      ? options.adminUser
      : await this.createUserId(options.adminName, options.adminPassword);
    const appUser = hasExistingUsers
      ? options.appUser
      : await this.createUserId(options.userName, options.userPassword);

    // 2. Create or reuse a KeyBag and add the new tenant's required keys.
    //    When `existingKeyBag` is supplied, the bag is mutated in place
    //    (no merge step needed) and returned as-is in the result, so the
    //    caller can persist it once after createTenant returns.
    const keyBag = options.existingKeyBag ?? new KeyBag(
      appUser.userEncryptionKeyPair.privateKey,
      options.userPassword,
      this.cryptoAdapter,
      this.logger.createChild("KeyBag")
    );
    await keyBag.createDocKey(tenantId, DEFAULT_TENANT_KEY_ID);
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);

    // 3. Open tenant
    const tenant = await this.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      appUser,
      options.userPassword,
      keyBag,
      options.preDecryptedAppUserKeys ? { preDecryptedUserKeys: options.preDecryptedAppUserKeys } : undefined,
    );

    // 4. Register the app user in the directory
    const directory = await tenant.openDirectory();
    await directory.registerUser(
      this.toPublicUserId(appUser),
      adminUser.userSigningKeyPair.privateKey,
      options.adminPassword,
      undefined,
      "First device",
    );

    // 5. Enforce the v2 storage format from creation (default on). We write an
    //    admin-signed default policy carrying `requireMetadataSignatureSince =
    //    now`, but with `disableAllAccessChecksAndPolicies: true` so this turns
    //    on ONLY the storage-format floor (no ACL deny-gates). The server push
    //    gate compares this cutoff against its own clock, so once created the
    //    tenant rejects any new v1 entry, while genuine pre-cutoff history (e.g.
    //    a tenant migrated in from an older format) still loads.
    const requireV2Entries = options.requireV2Entries ?? true;
    if (requireV2Entries && typeof directory.setDefaultAccessPolicy === "function") {
      await directory.setDefaultAccessPolicy(
        {
          disableAllAccessChecksAndPolicies: true,
          requireMetadataSignatureSince: semanticNow(),
        },
        adminUser.userSigningKeyPair.privateKey,
        options.adminPassword,
      );
    }

    const tenantLabel =
      typeof options.tenantLabel === "string" ? options.tenantLabel.trim() : "";
    if (tenantLabel) {
      const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
      await writeTenantSetupLabel(
        directoryDb,
        tenantLabel,
        adminUser.userSigningKeyPair,
        options.adminPassword,
        tenant,
      );
    }

    console.log(`[createTenant] ✓ Tenant "${tenantId}" created successfully`);
    this.logger.info(`Tenant "${tenantId}" created successfully`);

    return { tenant, adminUser, appUser, keyBag };
  }

  /**
   * Create a join request from a user's private identity.
   */
  createJoinRequest(user: PrivateUserId, options?: { format?: "object"; label?: string }): JoinRequest;
  createJoinRequest(user: PrivateUserId, options: { format: "uri"; label?: string }): string;
  createJoinRequest(user: PrivateUserId, options?: { format?: "object" | "uri"; label?: string }): JoinRequest | string {
    const publicUser = this.toPublicUserId(user);

    // An identity without a username produces a nameless v2 request: the
    // approving admin names it from the tenant directory, which is the only
    // device that knows the authoritative spelling (§6.5).
    const username = typeof publicUser.username === "string" ? publicUser.username.trim() : "";
    const joinRequest: JoinRequest = username.length > 0
      ? {
          v: 1,
          username,
          signingPublicKey: publicUser.userSigningPublicKey,
          encryptionPublicKey: publicUser.userEncryptionPublicKey,
        }
      : {
          v: 2,
          signingPublicKey: publicUser.userSigningPublicKey,
          encryptionPublicKey: publicUser.userEncryptionPublicKey,
        };

    // Optional device label the joining user suggests for this key pair (§6.5).
    // The approving admin may override it via ApproveJoinRequestOptions.label.
    const trimmedLabel = typeof options?.label === "string" ? options.label.trim() : "";
    if (trimmedLabel.length > 0) {
      joinRequest.label = trimmedLabel;
    }
    if (user.userKeyPair?.publicKey) {
      joinRequest.userPublicKey = user.userKeyPair.publicKey;
    }

    if (options?.format === "uri") {
      return encodeJoinRequestUri(joinRequest);
    }

    return joinRequest;
  }

  /**
   * Join a tenant using a join response from an admin.
   */
  async joinTenant(joinResponse: JoinResponse | string, options: JoinTenantOptions): Promise<JoinTenantResult> {
    // Parse the join response if it's a URI string
    let response: JoinResponse;
    if (typeof joinResponse === "string") {
      if (!isMindooURI(joinResponse)) {
        throw new Error("Invalid join response: expected a JoinResponse object or a mdb://join-response/... URI string");
      }
      const decoded = decodeMindooURI<JoinResponse>(joinResponse);
      if (decoded.type !== "join-response") {
        throw new Error(`Invalid URI type: expected "join-response", got "${decoded.type}"`);
      }
      response = decoded.payload;
    } else {
      response = joinResponse;
    }

    console.log(`[joinTenant] Joining tenant "${response.tenantId}"`);
    this.logger.info(`Joining tenant: ${response.tenantId}`);

    // 1. Create or reuse a KeyBag for this user. When `existingKeyBag` is
    //    supplied, the joined tenant's keys are added to the existing bag
    //    in place; the same bag instance is returned to the caller.
    const keyBag = options.existingKeyBag ?? new KeyBag(
      options.user.userEncryptionKeyPair.privateKey,
      options.password,
      this.cryptoAdapter,
      this.logger.createChild("KeyBag")
    );

    if ((response.v !== 2 && response.v !== 3) || !Array.isArray(response.encryptedDocKeys)) {
      throw new Error("Invalid join response: expected a v2 or v3 encryptedDocKeys payload");
    }

    if (!response.encryptedDocKeys.some((entry) => entry.keyId === PUBLIC_INFOS_KEY_ID)) {
      throw new Error(`Invalid join response: missing required "${PUBLIC_INFOS_KEY_ID}" document key`);
    }

    // 2. Import all encrypted document key versions from the join response.
    // Preserve the version timestamps so key rotation ordering remains stable
    // in the recipient's KeyBag.
    if (response.v === 3) {
      await this.importRsaWrappedJoinKeys(response, options, keyBag);
    } else {
      await this.importPasswordWrappedJoinKeys(response, options, keyBag);
    }

    // 3. Adopt the username the admin registered. It may differ from the one
    //    this device asked for (corrected spelling, or supplied for a nameless
    //    request), and the tenant has to be opened under the name the
    //    directory actually holds or every access check would miss.
    const registeredUsername =
      typeof response.username === "string" ? response.username.trim() : "";
    const effectiveUser: PrivateUserId =
      registeredUsername.length > 0 && registeredUsername !== options.user.username
        ? { ...options.user, username: registeredUsername }
        : options.user;

    if (effectiveUser !== options.user) {
      console.log(
        `[joinTenant] Adopting registered username "${registeredUsername}" (requested "${options.user.username}")`,
      );
      this.logger.info(`Adopting registered username: ${registeredUsername}`);
    }

    // 4. Open the tenant
    const tenant = await this.openTenant(
      response.tenantId,
      response.adminSigningPublicKey,
      response.adminEncryptionPublicKey,
      effectiveUser,
      options.password,
      keyBag,
      options.preDecryptedUserKeys ? { preDecryptedUserKeys: options.preDecryptedUserKeys } : undefined,
    );

    console.log(`[joinTenant] ✓ Joined tenant "${response.tenantId}" successfully`);
    this.logger.info(`Joined tenant "${response.tenantId}" successfully`);

    return { tenant, keyBag, user: effectiveUser };
  }

  /**
   * Prove device signing-key possession and discover tenants on a MindooDB server
   * (`POST /device/challenge` + `POST /device/discover`).
   */
  async discoverTenantsOnServer(
    serverUrl: string,
    options: DiscoverTenantsOnServerOptions,
  ): Promise<DeviceTenantDelivery[]> {
    const baseUrl = serverUrl.replace(/\/$/, "");
    const subtle = this.cryptoAdapter.getSubtle();

    const signingKey = options.preDecryptedUserKeys?.signingKey
      ?? await subtle.importKey(
        "pkcs8",
        await decryptPrivateKeyWithPassword(
          this.cryptoAdapter,
          options.user.userSigningKeyPair.privateKey,
          options.password,
          "signing",
        ),
        { name: "Ed25519" },
        false,
        ["sign"],
      );

    const challengeRes = await fetch(`${baseUrl}/device/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signingPublicKey: options.user.userSigningKeyPair.publicKey,
      }),
    });
    if (!challengeRes.ok) {
      const errorBody = await challengeRes.text();
      throw new Error(
        `Device discovery challenge failed (HTTP ${challengeRes.status}): ${errorBody}`,
      );
    }
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    if (typeof challenge !== "string" || !challenge) {
      throw new Error("Device discovery challenge response missing challenge");
    }

    const messageBytes = new TextEncoder().encode(challenge);
    const signatureBuffer = await subtle.sign({ name: "Ed25519" }, signingKey, messageBytes);
    const signature = this.uint8ArrayToBase64(new Uint8Array(signatureBuffer));

    const discoverRes = await fetch(`${baseUrl}/device/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, signature }),
    });
    if (!discoverRes.ok) {
      const errorBody = await discoverRes.text();
      throw new Error(
        `Device discovery failed (HTTP ${discoverRes.status}): ${errorBody}`,
      );
    }
    const body = (await discoverRes.json()) as { tenants?: DeviceTenantDelivery[] };
    return Array.isArray(body.tenants) ? body.tenants : [];
  }

  /**
   * Bootstrap a tenant from a device-discovery delivery: unwrap `$publicinfos`,
   * open the tenant, optionally pull the directory and reconcile distributions.
   */
  async bootstrapTenantFromDelivery(
    delivery: DeviceTenantDelivery,
    options: BootstrapTenantFromDeliveryOptions,
  ): Promise<BootstrapTenantFromDeliveryResult> {
    if (!delivery.tenantId || !delivery.wrappedPublicInfosKey) {
      throw new Error("Invalid device delivery: tenantId and wrappedPublicInfosKey are required");
    }
    validateTenantId(delivery.tenantId);

    const keyBag =
      options.existingKeyBag ??
      new KeyBag(
        options.user.userEncryptionKeyPair.privateKey,
        options.password,
        this.cryptoAdapter,
        this.logger.createChild("KeyBag"),
      );

    const decryptKey = await this.resolveJoinRecipientEncryptionKey({
      user: options.user,
      password: options.password,
      preDecryptedUserKeys: options.preDecryptedUserKeys,
    });
    const rsa = new RSAEncryption(this.cryptoAdapter, this.logger.createChild("RSAEncryption"));
    const wrappedList =
      delivery.wrappedPublicInfosKeys && delivery.wrappedPublicInfosKeys.length > 0
        ? delivery.wrappedPublicInfosKeys
        : [delivery.wrappedPublicInfosKey];
    try {
      for (let index = 0; index < wrappedList.length; index++) {
        const rawPublicInfos = await rsa.unwrapKeyFromBase64(wrappedList[index]!, decryptKey);
        // wrappedList is newest-first (server getAllKeys order). Higher createdAt = newer.
        await keyBag.set(
          "doc",
          delivery.tenantId,
          PUBLIC_INFOS_KEY_ID,
          rawPublicInfos,
          wrappedList.length - index,
        );
      }
      this.logger.info(
        `Unwrapped ${wrappedList.length} $publicinfos version(s) from device discovery for tenant ${delivery.tenantId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot unwrap device discovery delivery: it is bound to a different device's encryption key (${message})`,
      );
    }

    let user = options.user;
    const tenant = await this.openTenant(
      delivery.tenantId,
      delivery.adminSigningPublicKey,
      delivery.adminEncryptionPublicKey,
      user,
      options.password,
      keyBag,
      options.preDecryptedUserKeys
        ? { preDecryptedUserKeys: options.preDecryptedUserKeys }
        : undefined,
    );

    if (options.serverUrl) {
      const remoteDirectory = await tenant.connectToServer(
        options.serverUrl,
        "directory",
        StoreKind.docs,
      );
      const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
      try {
        await directoryDb.pullChangesFrom(remoteDirectory);
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot pull directory after device discovery (${name}: ${message})`,
        );
      }

      if (typeof tenant.reconcileKeyDistributionsForCurrentUser === "function") {
        const reconcile = await tenant.reconcileKeyDistributionsForCurrentUser();
        if (reconcile.adoptedUsername && reconcile.adoptedUsername !== user.username) {
          user = { ...user, username: reconcile.adoptedUsername };
        }
      }
    }

    let tenantLabel: string | undefined;
    try {
      const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
      tenantLabel = await readTenantSetupLabel(directoryDb, tenant);
    } catch {
      // Label needs `default`; may still be missing before distribution sync.
    }

    return {
      tenant,
      keyBag,
      user,
      ...(tenantLabel ? { tenantLabel } : {}),
    };
  }

  private async importRsaWrappedJoinKeys(
    response: JoinResponse,
    options: JoinTenantOptions,
    keyBag: KeyBag,
  ): Promise<void> {
    const decryptKey = await this.resolveJoinRecipientEncryptionKey(options);
    const rsa = new RSAEncryption(this.cryptoAdapter, this.logger.createChild("RSAEncryption"));
    for (const entry of response.encryptedDocKeys) {
      if (!entry.keyId || !Array.isArray(entry.versions) || entry.versions.length === 0) {
        throw new Error("Invalid join response: encryptedDocKeys entries must include a keyId and versions");
      }
      for (const version of entry.versions) {
        if (!version.wrappedKey) {
          throw new Error("Invalid join response: v3 versions must include wrappedKey");
        }
        try {
          const rawKey = await rsa.unwrapKeyFromBase64(version.wrappedKey, decryptKey);
          await keyBag.set("doc", response.tenantId, entry.keyId, rawKey, version.createdAt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Cannot decrypt join response: it is bound to a different device's encryption key (${message})`,
          );
        }
      }
    }
  }

  private async importPasswordWrappedJoinKeys(
    response: JoinResponse,
    options: JoinTenantOptions,
    keyBag: KeyBag,
  ): Promise<void> {
    if (!options.sharePassword) {
      throw new Error("This join response requires a sharePassword (legacy v2)");
    }
    for (const entry of response.encryptedDocKeys) {
      if (!entry.keyId || !Array.isArray(entry.versions) || entry.versions.length === 0) {
        throw new Error("Invalid join response: encryptedDocKeys entries must include a keyId and versions");
      }
      for (const version of entry.versions) {
        if (!version.encryptedKey) {
          throw new Error("Invalid join response: v2 versions must include encryptedKey");
        }
        await keyBag.decryptAndImportKey(
          "doc",
          response.tenantId,
          entry.keyId,
          {
            ...version.encryptedKey,
            createdAt: version.createdAt ?? version.encryptedKey.createdAt,
          },
          options.sharePassword,
        );
      }
    }
  }

  private async resolveJoinRecipientEncryptionKey(options: JoinTenantOptions): Promise<CryptoKey> {
    if (options.preDecryptedUserKeys?.encryptionKey) {
      return options.preDecryptedUserKeys.encryptionKey;
    }
    const decryptedKeyBuffer = await decryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      options.user.userEncryptionKeyPair.privateKey,
      options.password,
      "encryption",
    );
    return this.cryptoAdapter.getSubtle().importKey(
      "pkcs8",
      decryptedKeyBuffer,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
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
    
    const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
    console.log('[encryptPrivateKey] Delegating salt generation, PBKDF2, and AES-GCM encryption to shared helper...');
    const encryptStart = Date.now();
    const encryptedKey = await encryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      privateKeyBytes,
      password,
      saltString,
    );
    console.log('[encryptPrivateKey] ✓ Private key encrypted in', Date.now() - encryptStart, 'ms');

    const totalTime = Date.now() - startTime;
    console.log(`[encryptPrivateKey] ✓ Encryption completed in ${totalTime}ms total`);
    return encryptedKey;
  }

  private async assertRequiredKeysInKeyBag(tenantId: string, keyBag: KeyBag): Promise<void> {
    // Note: The default tenant key (type "doc", id DEFAULT_TENANT_KEY_ID) is NOT checked here.
    // It is only needed when decrypting regular database payloads (decryptionKeyId "default").
    // Server-side tenants that only need directory access can operate without it.
    // If it is missing and code tries to decrypt regular data, a clear
    // SymmetricKeyNotFoundError will be thrown at the point of use.

    const publicInfosKey = await keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID);
    if (!publicInfosKey) {
      throw new Error(
        `Missing required directory access key in KeyBag: ("doc", "${tenantId}", "${PUBLIC_INFOS_KEY_ID}"). ` +
          `Create/import it first with keyBag.createDocKey("${tenantId}", "${PUBLIC_INFOS_KEY_ID}") or keyBag.decryptAndImportKey("doc", "${tenantId}", "${PUBLIC_INFOS_KEY_ID}", encryptedPublicInfosKey, password).`
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

