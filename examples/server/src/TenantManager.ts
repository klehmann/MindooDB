/**
 * TenantManager handles loading, caching, and registration of tenants.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";

import { NodeCryptoAdapter } from "../../../src/node/crypto/NodeCryptoAdapter";
import { AuthenticationService } from "../../../src/core/appendonlystores/network/AuthenticationService";
import { ServerNetworkContentAddressedStore } from "../../../src/appendonlystores/network/ServerNetworkContentAddressedStore";
import type { MindooTenantDirectory, ContentAddressedStore } from "../../../src/core/types";

import { StoreFactory } from "./StoreFactory";
import type {
  TenantConfig,
  ServerKeysConfig,
  TenantContext,
  RegisterTenantRequest,
  UserConfig,
  ENV_VARS,
} from "./types";

/**
 * Internal structure for a fully loaded tenant with all services.
 */
interface LoadedTenant {
  context: TenantContext;
  storeFactory: StoreFactory;
  authService: AuthenticationService;
  directory: SimpleMindooDirectory;
  serverStores: Map<string, ServerNetworkContentAddressedStore>;
}

/**
 * Simplified directory implementation for the example server.
 * 
 * This is a minimal implementation that supports user lookup and revocation
 * checking based on the config.json users array. In a production system,
 * this would sync with the actual MindooDB directory database.
 */
class SimpleMindooDirectory implements Pick<MindooTenantDirectory, 
  "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey"
> {
  private users: Map<string, UserConfig> = new Map();
  private revokedUsers: Set<string> = new Set();
  private adminSigningPublicKey: string;

  constructor(config: TenantConfig) {
    this.adminSigningPublicKey = config.adminSigningPublicKey;
    
    // Index users by username (case-insensitive)
    if (config.users) {
      for (const user of config.users) {
        this.users.set(user.username.toLowerCase(), user);
      }
    }
  }

  /**
   * Add a user dynamically (e.g., when updating config).
   */
  addUser(user: UserConfig): void {
    this.users.set(user.username.toLowerCase(), user);
  }

  /**
   * Remove a user dynamically.
   */
  removeUser(username: string): void {
    this.users.delete(username.toLowerCase());
  }

  /**
   * Revoke a user's access.
   */
  revokeUser(username: string): void {
    this.revokedUsers.add(username.toLowerCase());
  }

  async getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null> {
    const normalizedUsername = username.toLowerCase();
    
    // Check if revoked
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
    // Check if it's the admin key
    if (publicKey === this.adminSigningPublicKey) {
      return true;
    }
    
    // Check if it belongs to any registered user
    for (const [, user] of this.users) {
      if (user.signingPublicKey === publicKey) {
        // Make sure user is not revoked
        if (!this.revokedUsers.has(user.username.toLowerCase())) {
          return true;
        }
      }
    }
    
    return false;
  }
}

/**
 * TenantManager is responsible for:
 * - Loading tenant configurations from disk
 * - Caching loaded tenants
 * - Registering new tenants
 * - Managing tenant stores and authentication services
 */
export class TenantManager {
  private dataDir: string;
  private cryptoAdapter: NodeCryptoAdapter;
  private loadedTenants: Map<string, LoadedTenant> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.cryptoAdapter = new NodeCryptoAdapter();
    
    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      console.log(`[TenantManager] Created data directory: ${dataDir}`);
    }
  }

  /**
   * Register a new tenant by creating its directory and config.json.
   * 
   * @param request The registration request
   * @returns The created tenant context
   * @throws Error if tenant already exists
   */
  registerTenant(request: RegisterTenantRequest): TenantContext {
    // Normalize tenant ID to lowercase
    const tenantId = request.tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, tenantId);
    
    // Check if tenant already exists
    if (existsSync(tenantDir)) {
      throw new Error(`Tenant ${tenantId} already exists`);
    }
    
    // Create tenant directory
    mkdirSync(tenantDir, { recursive: true });
    
    // Build config
    const config: TenantConfig = {
      adminSigningPublicKey: request.adminSigningPublicKey,
      adminEncryptionPublicKey: request.adminEncryptionPublicKey,
      defaultStoreType: request.defaultStoreType || "inmemory",
      users: request.users || [],
    };
    
    // Write config.json
    const configPath = join(tenantDir, "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    
    console.log(`[TenantManager] Registered tenant: ${tenantId}`);
    
    // Return context (don't cache yet - let getTenant handle that)
    return {
      tenantId,
      config,
    };
  }

  /**
   * Get or load a tenant by ID.
   * 
   * @param tenantId The tenant identifier (will be lowercased)
   * @returns The loaded tenant with all services
   * @throws Error if tenant doesn't exist
   */
  getTenant(tenantId: string): LoadedTenant {
    const normalizedId = tenantId.toLowerCase();
    
    // Check cache first
    const cached = this.loadedTenants.get(normalizedId);
    if (cached) {
      return cached;
    }
    
    // Load from disk
    const loaded = this.loadTenant(normalizedId);
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
      
      // Check if it's a directory with config.json
      if (statSync(tenantDir).isDirectory() && existsSync(configPath)) {
        tenants.push(entry);
      }
    }
    
    return tenants.sort();
  }

  /**
   * Remove a tenant and all its data.
   * 
   * @param tenantId The tenant to remove
   * @throws Error if tenant doesn't exist
   */
  removeTenant(tenantId: string): void {
    const normalizedId = tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, normalizedId);
    
    if (!existsSync(tenantDir)) {
      throw new Error(`Tenant ${normalizedId} does not exist`);
    }
    
    // Remove from cache
    this.loadedTenants.delete(normalizedId);
    
    // Remove directory
    rmSync(tenantDir, { recursive: true, force: true });
    
    console.log(`[TenantManager] Removed tenant: ${normalizedId}`);
  }

  /**
   * Get a ServerNetworkContentAddressedStore for a specific database.
   * 
   * @param tenantId The tenant ID
   * @param dbId The database ID
   * @returns The server store handler
   */
  getServerStore(tenantId: string, dbId: string): ServerNetworkContentAddressedStore {
    const tenant = this.getTenant(tenantId);
    
    // Check cache
    const cacheKey = dbId;
    const cached = tenant.serverStores.get(cacheKey);
    if (cached) {
      return cached;
    }
    
    // Create new server store
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
  getStore(tenantId: string, dbId: string): ContentAddressedStore {
    const tenant = this.getTenant(tenantId);
    return tenant.storeFactory.getStore(dbId);
  }

  /**
   * Get the authentication service for a tenant.
   */
  getAuthService(tenantId: string): AuthenticationService {
    const tenant = this.getTenant(tenantId);
    return tenant.authService;
  }

  /**
   * Get the crypto adapter.
   */
  getCryptoAdapter(): NodeCryptoAdapter {
    return this.cryptoAdapter;
  }

  /**
   * Load a tenant from disk.
   */
  private loadTenant(tenantId: string): LoadedTenant {
    const tenantDir = join(this.dataDir, tenantId);
    const configPath = join(tenantDir, "config.json");
    
    // Load config
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
    
    // Create context
    const context: TenantContext = {
      tenantId,
      config,
      serverKeys,
    };
    
    // Create services
    const storeFactory = new StoreFactory(tenantId, config);
    const directory = new SimpleMindooDirectory(config);
    const authService = new AuthenticationService(
      this.cryptoAdapter,
      directory as unknown as MindooTenantDirectory,
      tenantId
    );
    
    console.log(`[TenantManager] Loaded tenant: ${tenantId}`);
    
    return {
      context,
      storeFactory,
      authService,
      directory,
      serverStores: new Map(),
    };
  }

  /**
   * Reload a tenant's configuration from disk.
   * Useful after config changes.
   */
  reloadTenant(tenantId: string): LoadedTenant {
    const normalizedId = tenantId.toLowerCase();
    
    // Remove from cache
    this.loadedTenants.delete(normalizedId);
    
    // Load fresh
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
