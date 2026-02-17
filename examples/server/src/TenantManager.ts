/**
 * TenantManager handles loading, caching, and registration of tenants.
 *
 * When a tenant has a $publicinfos key (sent during publishToServer), the
 * manager creates a real BaseMindooTenant for directory reading. User
 * authentication is then validated against the admin-signed directory DB
 * rather than a static JSON config.
 *
 * When no $publicinfos key is available, a SimpleMindooDirectory backed
 * by config.json users[] is used as a fallback (useful for tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";

import { NodeCryptoAdapter } from "mindoodb/node/crypto/NodeCryptoAdapter";
import { AuthenticationService } from "mindoodb/core/appendonlystores/network/AuthenticationService";
import { ServerNetworkContentAddressedStore } from "mindoodb/appendonlystores/network/ServerNetworkContentAddressedStore";
import { BaseMindooTenantFactory } from "mindoodb/core/BaseMindooTenantFactory";
import { KeyBag } from "mindoodb/core/keys/KeyBag";
import type {
  MindooTenant,
  MindooTenantDirectory,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  OpenTenantOptions,
} from "mindoodb/core/types";
import { PUBLIC_INFOS_KEY_ID } from "mindoodb/core/types";
import type { PrivateUserId } from "mindoodb/core/userid";

import { StoreFactory } from "./StoreFactory";
import type {
  TenantConfig,
  ServerKeysConfig,
  TenantContext,
  RegisterTenantRequest,
  UserConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal structure for a fully loaded tenant with all services.
 */
interface LoadedTenant {
  context: TenantContext;
  storeFactory: StoreFactory;
  authService: AuthenticationService;
  /** Real directory (from BaseMindooTenantDirectory) or config-based fallback */
  directory: MindooTenantDirectory;
  /** Real MindooTenant instance (when publicInfosKey available, for directory reading) */
  mindooTenant?: MindooTenant;
  serverStores: Map<string, ServerNetworkContentAddressedStore>;
}

// ---------------------------------------------------------------------------
// StoreFactoryAdapter — bridges StoreFactory to ContentAddressedStoreFactory
// ---------------------------------------------------------------------------

/**
 * Adapter that wraps the server's StoreFactory to implement the
 * ContentAddressedStoreFactory interface required by BaseMindooTenantFactory.
 *
 * This ensures BaseMindooTenant uses the same underlying stores as the
 * ServerNetworkContentAddressedStore — so directory entries that arrive
 * via client sync are immediately visible to BaseMindooTenantDirectory.
 */
class StoreFactoryAdapter implements ContentAddressedStoreFactory {
  constructor(private storeFactory: StoreFactory) {}
  createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
    return { docStore: this.storeFactory.getStore(dbId) };
  }
}

// ---------------------------------------------------------------------------
// SimpleMindooDirectory — config-based fallback
// ---------------------------------------------------------------------------

/**
 * Simplified directory implementation for fallback/testing.
 *
 * Used when a tenant has no $publicinfos key (i.e. the admin did not send it
 * during publishToServer). Falls back to the users[] array in config.json.
 */
class SimpleMindooDirectory implements Pick<MindooTenantDirectory,
  "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey"
> {
  private users: Map<string, UserConfig> = new Map();
  private revokedUsers: Set<string> = new Set();
  private adminSigningPublicKey: string;

  constructor(config: TenantConfig) {
    this.adminSigningPublicKey = config.adminSigningPublicKey;

    if (config.users) {
      for (const user of config.users) {
        this.users.set(user.username.toLowerCase(), user);
      }
    }
  }

  async getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null> {
    const normalizedUsername = username.toLowerCase();
    if (this.revokedUsers.has(normalizedUsername)) {
      return null;
    }
    const user = this.users.get(normalizedUsername);
    if (!user) {
      return null;
    }
    return {
      signingPublicKey: user.signingPublicKey,
      encryptionPublicKey: user.encryptionPublicKey,
    };
  }

  async isUserRevoked(username: string): Promise<boolean> {
    return this.revokedUsers.has(username.toLowerCase());
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    if (publicKey === this.adminSigningPublicKey) {
      return true;
    }
    for (const [, user] of this.users) {
      if (user.signingPublicKey === publicKey) {
        if (!this.revokedUsers.has(user.username.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server identity helpers
// ---------------------------------------------------------------------------

const SERVER_IDENTITY_FILE = "server-identity.json";
const SERVER_IDENTITY_PASSWORD = "server-internal-key";

// ---------------------------------------------------------------------------
// TenantManager
// ---------------------------------------------------------------------------

/**
 * TenantManager is responsible for:
 * - Loading tenant configurations from disk
 * - Caching loaded tenants
 * - Registering new tenants
 * - Managing tenant stores and authentication services
 * - Creating a real MindooDB tenant for directory reading (when keys available)
 */
export class TenantManager {
  private dataDir: string;
  private cryptoAdapter: NodeCryptoAdapter;
  private loadedTenants: Map<string, LoadedTenant> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.cryptoAdapter = new NodeCryptoAdapter();

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      console.log(`[TenantManager] Created data directory: ${dataDir}`);
    }
  }

  /**
   * Register a new tenant by creating its directory and config.json.
   */
  registerTenant(request: RegisterTenantRequest): TenantContext {
    const tenantId = request.tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, tenantId);

    if (existsSync(tenantDir)) {
      throw new Error(`Tenant ${tenantId} already exists`);
    }

    mkdirSync(tenantDir, { recursive: true });

    const config: TenantConfig = {
      adminSigningPublicKey: request.adminSigningPublicKey,
      adminEncryptionPublicKey: request.adminEncryptionPublicKey,
      publicInfosKey: request.publicInfosKey,
      defaultStoreType: request.defaultStoreType || "file",
      users: request.users || [],
    };

    const configPath = join(tenantDir, "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    console.log(`[TenantManager] Registered tenant: ${tenantId} (publicInfosKey: ${config.publicInfosKey ? "yes" : "no"})`);

    return { tenantId, config };
  }

  /**
   * Get or load a tenant by ID.
   * Creates a real BaseMindooTenant for directory reading when keys are available.
   */
  async getTenant(tenantId: string): Promise<LoadedTenant> {
    const normalizedId = tenantId.toLowerCase();

    const cached = this.loadedTenants.get(normalizedId);
    if (cached) {
      return cached;
    }

    const loaded = await this.loadTenant(normalizedId);
    this.loadedTenants.set(normalizedId, loaded);

    return loaded;
  }

  /**
   * Check if a tenant exists.
   */
  tenantExists(tenantId: string): boolean {
    const normalizedId = tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, normalizedId);
    const configPath = join(tenantDir, "config.json");
    return existsSync(configPath);
  }

  /**
   * List all registered tenant IDs.
   */
  listTenants(): string[] {
    if (!existsSync(this.dataDir)) {
      return [];
    }

    const entries = readdirSync(this.dataDir);
    const tenants: string[] = [];

    for (const entry of entries) {
      const tenantDir = join(this.dataDir, entry);
      const configPath = join(tenantDir, "config.json");

      if (statSync(tenantDir).isDirectory() && existsSync(configPath)) {
        tenants.push(entry);
      }
    }

    return tenants.sort();
  }

  /**
   * Remove a tenant and all its data.
   */
  removeTenant(tenantId: string): void {
    const normalizedId = tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, normalizedId);

    if (!existsSync(tenantDir)) {
      throw new Error(`Tenant ${normalizedId} does not exist`);
    }

    this.loadedTenants.delete(normalizedId);
    rmSync(tenantDir, { recursive: true, force: true });

    console.log(`[TenantManager] Removed tenant: ${normalizedId}`);
  }

  /**
   * Get a ServerNetworkContentAddressedStore for a specific database.
   */
  async getServerStore(tenantId: string, dbId: string): Promise<ServerNetworkContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);

    const cacheKey = dbId;
    const cached = tenant.serverStores.get(cacheKey);
    if (cached) {
      return cached;
    }

    const localStore = tenant.storeFactory.getStore(dbId);
    const serverStore = new ServerNetworkContentAddressedStore(
      localStore,
      tenant.directory as unknown as MindooTenantDirectory,
      tenant.authService,
      this.cryptoAdapter
    );

    tenant.serverStores.set(cacheKey, serverStore);
    console.log(`[TenantManager] Created server store for ${tenantId}/${dbId}`);

    return serverStore;
  }

  /**
   * Get the underlying ContentAddressedStore for a database.
   */
  async getStore(tenantId: string, dbId: string): Promise<ContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);
    return tenant.storeFactory.getStore(dbId);
  }

  /**
   * Get the authentication service for a tenant.
   */
  async getAuthService(tenantId: string): Promise<AuthenticationService> {
    const tenant = await this.getTenant(tenantId);
    return tenant.authService;
  }

  /**
   * Get the crypto adapter.
   */
  getCryptoAdapter(): NodeCryptoAdapter {
    return this.cryptoAdapter;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Load a tenant from disk.
   *
   * When the config contains a publicInfosKey, a real BaseMindooTenant is
   * created for directory-based user authentication. Otherwise, falls back
   * to the SimpleMindooDirectory (config.json users[] array).
   */
  private async loadTenant(tenantId: string): Promise<LoadedTenant> {
    const tenantDir = join(this.dataDir, tenantId);
    const configPath = join(tenantDir, "config.json");

    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${tenantId} not found: ${configPath}`);
    }

    const configJson = readFileSync(configPath, "utf-8");
    const config: TenantConfig = JSON.parse(configJson);

    // Load server keys if they exist
    let serverKeys: ServerKeysConfig | undefined;
    const serverKeysPath = join(tenantDir, "server-keys.json");
    if (existsSync(serverKeysPath)) {
      const serverKeysJson = readFileSync(serverKeysPath, "utf-8");
      serverKeys = JSON.parse(serverKeysJson);
      console.log(`[TenantManager] Loaded server keys for tenant ${tenantId}`);
    }

    const context: TenantContext = { tenantId, config, serverKeys };
    const storeFactory = new StoreFactory(tenantId, config, this.dataDir);

    // Try to create a real MindooDB directory
    let directory: MindooTenantDirectory;
    let mindooTenant: MindooTenant | undefined;

    if (config.publicInfosKey) {
      try {
        const result = await this.createDirectoryTenant(tenantId, config, storeFactory);
        mindooTenant = result.tenant;
        directory = await mindooTenant.openDirectory();
        console.log(`[TenantManager] Loaded tenant ${tenantId} with real directory`);
      } catch (error) {
        console.error(`[TenantManager] Failed to create real directory for ${tenantId}, falling back to config:`, error);
        directory = new SimpleMindooDirectory(config) as unknown as MindooTenantDirectory;
      }
    } else {
      console.log(`[TenantManager] No publicInfosKey for ${tenantId}, using config-based directory`);
      directory = new SimpleMindooDirectory(config) as unknown as MindooTenantDirectory;
    }

    const authService = new AuthenticationService(
      this.cryptoAdapter,
      directory,
      tenantId
    );

    console.log(`[TenantManager] Loaded tenant: ${tenantId}`);

    return {
      context,
      storeFactory,
      authService,
      directory,
      mindooTenant,
      serverStores: new Map(),
    };
  }

  /**
   * Create a real BaseMindooTenant for directory reading.
   *
   * The server needs its own identity (PrivateUserId) to instantiate a tenant.
   * This identity must be created externally (e.g. via a setup CLI) and placed
   * at <dataDir>/<tenantId>/server-identity.json before the server starts.
   */
  private async createDirectoryTenant(
    tenantId: string,
    config: TenantConfig,
    storeFactory: StoreFactory,
  ): Promise<{ tenant: MindooTenant }> {
    const storeFactoryAdapter = new StoreFactoryAdapter(storeFactory);
    const factory = new BaseMindooTenantFactory(storeFactoryAdapter, this.cryptoAdapter);

    // Load the server identity (must be created externally before first use)
    const serverUser = await this.getServerIdentity(tenantId);

    // Create a KeyBag using the server user's encryption key
    const keyBag = new KeyBag(
      serverUser.userEncryptionKeyPair.privateKey,
      SERVER_IDENTITY_PASSWORD,
      this.cryptoAdapter,
    );
    // Import the $publicinfos key as raw bytes
    const publicInfosKeyBytes = Buffer.from(config.publicInfosKey!, "base64");
    await keyBag.set("doc", PUBLIC_INFOS_KEY_ID, new Uint8Array(publicInfosKeyBytes));

    // Collect trusted remote server signing keys for server-to-server sync
    const openOptions: OpenTenantOptions = {};
    if (config.remoteServers && config.remoteServers.length > 0) {
      const trustedKeys = new Map<string, boolean>();
      for (const remote of config.remoteServers) {
        if (remote.signingPublicKey) {
          trustedKeys.set(remote.signingPublicKey, true);
          console.log(`[TenantManager] Trusting remote server key for ${tenantId}: ${remote.url}`);
        }
      }
      if (trustedKeys.size > 0) {
        openOptions.additionalTrustedKeys = trustedKeys;
      }
    }

    // Open the tenant in directory-only mode (no tenant key needed)
    const tenant = await factory.openTenant(
      tenantId,
      config.adminSigningPublicKey,
      config.adminEncryptionPublicKey,
      serverUser,
      SERVER_IDENTITY_PASSWORD,
      keyBag,
      openOptions,
    );

    return { tenant };
  }

  /**
   * Load the server identity for a tenant from <dataDir>/<tenantId>/server-identity.json.
   *
   * The identity must be created externally (e.g. via a setup CLI) so that its
   * public key can be shared with remote servers before they attempt to sync.
   */
  private async getServerIdentity(
    tenantId: string,
  ): Promise<PrivateUserId> {
    const tenantDir = join(this.dataDir, tenantId);
    const identityPath = join(tenantDir, SERVER_IDENTITY_FILE);

    if (!existsSync(identityPath)) {
      throw new Error(
        `Server identity not found for tenant "${tenantId}". ` +
        `Expected file: ${identityPath}\n` +
        `Create the server identity first (e.g. via a setup script) and place it at that path. ` +
        `The identity's public key must be shared with remote servers so they can trust this server.`
      );
    }

    const json = readFileSync(identityPath, "utf-8");
    console.log(`[TenantManager] Loaded server identity for tenant ${tenantId}`);
    return JSON.parse(json) as PrivateUserId;
  }

  /**
   * Reload a tenant's configuration from disk.
   */
  async reloadTenant(tenantId: string): Promise<LoadedTenant> {
    const normalizedId = tenantId.toLowerCase();
    this.loadedTenants.delete(normalizedId);
    return this.getTenant(normalizedId);
  }

  /**
   * Clear all cached tenants.
   */
  clearCache(): void {
    this.loadedTenants.clear();
    console.log(`[TenantManager] Cleared tenant cache`);
  }
}
