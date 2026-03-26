/**
 * TenantManager handles loading, caching, and registration of tenants.
 *
 * Uses a global server identity (one per server, not per tenant) for
 * authenticating with remote servers and opening tenant directories.
 *
 * When a tenant has a $publicinfos key (sent during publishToServer), the
 * manager creates a real BaseMindooTenant for directory reading. User
 * authentication is then validated against the admin-signed directory DB
 * rather than a static JSON config.
 *
 * When no $publicinfos key is available, a SimpleMindooDirectory backed
 * by config.json users[] is used as a fallback (useful for tests).
 *
 * A CompositeMindooDirectory wraps whichever directory source is used and
 * also checks the global trusted-servers list, enabling server-to-server
 * auth without servers being in each tenant's user directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { randomBytes, timingSafeEqual } from "crypto";

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
  TenantContext,
  RegisterTenantRequest,
  UserConfig,
  TrustedServer,
  TenantCreationKey,
  NamedRemoteServerConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LoadedTenant {
  context: TenantContext;
  storeFactory: StoreFactory;
  authService: AuthenticationService;
  directory: MindooTenantDirectory;
  mindooTenant?: MindooTenant;
  serverStores: Map<string, ServerNetworkContentAddressedStore>;
}

// ---------------------------------------------------------------------------
// StoreFactoryAdapter
// ---------------------------------------------------------------------------

class StoreFactoryAdapter implements ContentAddressedStoreFactory {
  constructor(private storeFactory: StoreFactory) {}
  createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
    return { docStore: this.storeFactory.getStore(dbId) };
  }
}

// ---------------------------------------------------------------------------
// SimpleMindooDirectory — config-based fallback
// ---------------------------------------------------------------------------

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
// CompositeMindooDirectory — wraps tenant directory + trusted servers
// ---------------------------------------------------------------------------

/**
 * Wraps a per-tenant directory (real or config-based) and also checks
 * the global trusted-servers list. Holds a reference to the array so
 * runtime changes via the admin API are immediately visible.
 */
class CompositeMindooDirectory implements Pick<MindooTenantDirectory,
  "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey"
> {
  private readonly adminUsernameNormalized: string | null;

  constructor(
    private inner: Pick<MindooTenantDirectory,
      "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey">,
    private trustedServers: TrustedServer[],
    private adminBootstrapIdentity?: {
      username: string;
      signingPublicKey: string;
      encryptionPublicKey: string;
    },
  ) {
    this.adminUsernameNormalized = adminBootstrapIdentity?.username.toLowerCase() ?? null;
  }

  async getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null> {
    const normalizedUsername = username.toLowerCase();

    // Bootstrap special-case: allow configured admin identity to authenticate
    // even before directory grantaccess docs are present on the server.
    if (
      this.adminBootstrapIdentity &&
      this.adminUsernameNormalized &&
      normalizedUsername === this.adminUsernameNormalized
    ) {
      return {
        signingPublicKey: this.adminBootstrapIdentity.signingPublicKey,
        encryptionPublicKey: this.adminBootstrapIdentity.encryptionPublicKey,
      };
    }

    const result = await this.inner.getUserPublicKeys(username);
    if (result) return result;

    for (const server of this.trustedServers) {
      if (server.name.toLowerCase() === normalizedUsername) {
        return {
          signingPublicKey: server.signingPublicKey,
          encryptionPublicKey: server.encryptionPublicKey,
        };
      }
    }
    return null;
  }

  async isUserRevoked(username: string): Promise<boolean> {
    const normalizedUsername = username.toLowerCase();

    if (this.adminUsernameNormalized && normalizedUsername === this.adminUsernameNormalized) {
      return false;
    }

    for (const server of this.trustedServers) {
      if (server.name.toLowerCase() === normalizedUsername) {
        return false;
      }
    }
    return this.inner.isUserRevoked(username);
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    if (this.adminBootstrapIdentity && this.adminBootstrapIdentity.signingPublicKey === publicKey) {
      return true;
    }

    const innerResult = await this.inner.validatePublicSigningKey(publicKey);
    if (innerResult) return true;

    for (const server of this.trustedServers) {
      if (server.signingPublicKey === publicKey) {
        return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// TenantManager
// ---------------------------------------------------------------------------

/**
 * TenantManager is responsible for:
 * - Loading the global server identity and trusted servers
 * - Loading tenant configurations from disk
 * - Caching loaded tenants
 * - Registering new tenants
 * - Managing tenant stores and authentication services
 * - Creating a real MindooDB tenant for directory reading (when keys available)
 * - Runtime management of trusted servers and tenant creation keys
 */
export class TenantManager {
  private dataDir: string;
  private serverPassword: string | undefined;
  private cryptoAdapter: NodeCryptoAdapter;
  private loadedTenants: Map<string, LoadedTenant> = new Map();

  private serverIdentity: PrivateUserId | null = null;
  private trustedServers: TrustedServer[] = [];
  private tenantCreationKeys: TenantCreationKey[] = [];

  constructor(dataDir: string, serverPassword?: string) {
    this.dataDir = dataDir;
    this.serverPassword = serverPassword;
    this.cryptoAdapter = new NodeCryptoAdapter();

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      console.log(`[TenantManager] Created data directory: ${dataDir}`);
    }

    // Load global server identity
    const identityPath = join(dataDir, "server-identity.json");
    if (existsSync(identityPath)) {
      this.serverIdentity = JSON.parse(readFileSync(identityPath, "utf-8"));
      console.log(`[TenantManager] Loaded server identity: ${this.serverIdentity!.username}`);
    } else {
      console.log(`[TenantManager] No server-identity.json found (run "npm run init" to create one)`);
    }

    // Load trusted servers
    const trustedPath = join(dataDir, "trusted-servers.json");
    if (existsSync(trustedPath)) {
      this.trustedServers = JSON.parse(readFileSync(trustedPath, "utf-8"));
      console.log(`[TenantManager] Loaded ${this.trustedServers.length} trusted server(s)`);
    }

    // Load tenant creation keys
    const keysPath = join(dataDir, "tenant-api-keys.json");
    if (existsSync(keysPath)) {
      this.tenantCreationKeys = JSON.parse(readFileSync(keysPath, "utf-8"));
      console.log(`[TenantManager] Loaded ${this.tenantCreationKeys.length} tenant creation key(s)`);
    }
  }

  // =======================================================================
  // Server identity
  // =======================================================================

  getServerIdentity(): PrivateUserId | null {
    return this.serverIdentity;
  }

  getServerPublicInfo(): TrustedServer | null {
    if (!this.serverIdentity) return null;
    return {
      name: this.serverIdentity.username,
      signingPublicKey: this.serverIdentity.userSigningKeyPair.publicKey as string,
      encryptionPublicKey: this.serverIdentity.userEncryptionKeyPair.publicKey as string,
    };
  }

  // =======================================================================
  // Trusted server management
  // =======================================================================

  listTrustedServers(): TrustedServer[] {
    return [...this.trustedServers];
  }

  addTrustedServer(server: TrustedServer): void {
    const existing = this.trustedServers.find(
      (s) => s.name.toLowerCase() === server.name.toLowerCase(),
    );
    if (existing) {
      throw new Error(`Trusted server "${server.name}" already exists`);
    }
    this.trustedServers.push(server);
    this.persistTrustedServers();
    console.log(`[TenantManager] Added trusted server: ${server.name}`);
  }

  removeTrustedServer(name: string): boolean {
    const idx = this.trustedServers.findIndex(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx === -1) return false;
    this.trustedServers.splice(idx, 1);
    this.persistTrustedServers();
    console.log(`[TenantManager] Removed trusted server: ${name}`);
    return true;
  }

  private persistTrustedServers(): void {
    const filePath = join(this.dataDir, "trusted-servers.json");
    writeFileSync(filePath, JSON.stringify(this.trustedServers, null, 2), "utf-8");
  }

  // =======================================================================
  // Tenant creation key management
  // =======================================================================

  listTenantCreationKeys(): TenantCreationKey[] {
    return this.tenantCreationKeys.map((k) => ({ ...k }));
  }

  addTenantCreationKey(name: string, tenantIdPrefix?: string): TenantCreationKey {
    const existing = this.tenantCreationKeys.find(
      (k) => k.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      throw new Error(`Tenant creation key "${name}" already exists`);
    }

    const key: TenantCreationKey = {
      apiKey: "mdb_tk_" + randomBytes(32).toString("hex"),
      name,
      tenantIdPrefix,
      createdAt: Date.now(),
    };

    this.tenantCreationKeys.push(key);
    this.persistTenantCreationKeys();
    console.log(`[TenantManager] Created tenant creation key: ${name}${tenantIdPrefix ? ` (prefix: ${tenantIdPrefix})` : ""}`);
    return key;
  }

  removeTenantCreationKey(name: string): boolean {
    const idx = this.tenantCreationKeys.findIndex(
      (k) => k.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx === -1) return false;
    this.tenantCreationKeys.splice(idx, 1);
    this.persistTenantCreationKeys();
    console.log(`[TenantManager] Removed tenant creation key: ${name}`);
    return true;
  }

  /**
   * Validate a tenant creation API key against a tenantId.
   * Returns true if the key exists and the tenantId satisfies the prefix constraint.
   */
  validateTenantCreationKey(apiKey: string, tenantId: string): boolean {
    const key = this.tenantCreationKeys.find((k) => {
      if (k.apiKey.length !== apiKey.length) return false;
      return timingSafeEqual(Buffer.from(k.apiKey), Buffer.from(apiKey));
    });
    if (!key) return false;
    if (key.tenantIdPrefix) {
      return tenantId.toLowerCase().startsWith(key.tenantIdPrefix.toLowerCase());
    }
    return true;
  }

  private persistTenantCreationKeys(): void {
    const filePath = join(this.dataDir, "tenant-api-keys.json");
    writeFileSync(filePath, JSON.stringify(this.tenantCreationKeys, null, 2), "utf-8");
  }

  // =======================================================================
  // Tenant management
  // =======================================================================

  registerTenant(request: RegisterTenantRequest): TenantContext {
    const tenantId = request.tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, tenantId);

    if (existsSync(tenantDir)) {
      throw new Error(`Tenant ${tenantId} already exists`);
    }

    mkdirSync(tenantDir, { recursive: true });

    const config: TenantConfig = {
      adminUsername: request.adminUsername,
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

  tenantExists(tenantId: string): boolean {
    const normalizedId = tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, normalizedId);
    const configPath = join(tenantDir, "config.json");
    return existsSync(configPath);
  }

  listTenants(): string[] {
    if (!existsSync(this.dataDir)) {
      return [];
    }

    const entries = readdirSync(this.dataDir);
    const tenants: string[] = [];

    for (const entry of entries) {
      const entryPath = join(this.dataDir, entry);
      const configPath = join(entryPath, "config.json");

      if (statSync(entryPath).isDirectory() && existsSync(configPath)) {
        tenants.push(entry);
      }
    }

    return tenants.sort();
  }

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

  // =======================================================================
  // Per-tenant sync server management
  // =======================================================================

  getTenantSyncServers(tenantId: string): NamedRemoteServerConfig[] {
    const normalizedId = tenantId.toLowerCase();
    const configPath = join(this.dataDir, normalizedId, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const config: TenantConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    return (config.remoteServers || []) as NamedRemoteServerConfig[];
  }

  addTenantSyncServer(tenantId: string, server: NamedRemoteServerConfig): void {
    const normalizedId = tenantId.toLowerCase();
    const configPath = join(this.dataDir, normalizedId, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const config: TenantConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    const servers = (config.remoteServers || []) as NamedRemoteServerConfig[];

    const idx = servers.findIndex(
      (s) => s.name?.toLowerCase() === server.name.toLowerCase(),
    );
    if (idx >= 0) {
      servers[idx] = server;
      console.log(`[TenantManager] Updated sync server "${server.name}" for tenant ${normalizedId}`);
    } else {
      servers.push(server);
      console.log(`[TenantManager] Added sync server "${server.name}" for tenant ${normalizedId}`);
    }
    config.remoteServers = servers;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    this.loadedTenants.delete(normalizedId);
  }

  removeTenantSyncServer(tenantId: string, serverName: string): boolean {
    const normalizedId = tenantId.toLowerCase();
    const configPath = join(this.dataDir, normalizedId, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const config: TenantConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    const servers = (config.remoteServers || []) as NamedRemoteServerConfig[];

    const idx = servers.findIndex(
      (s) => s.name?.toLowerCase() === serverName.toLowerCase(),
    );
    if (idx === -1) return false;

    servers.splice(idx, 1);
    config.remoteServers = servers;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    this.loadedTenants.delete(normalizedId);
    console.log(`[TenantManager] Removed sync server "${serverName}" from tenant ${normalizedId}`);
    return true;
  }

  // =======================================================================
  // Server stores
  // =======================================================================

  async getServerStore(tenantId: string, dbId: string): Promise<ServerNetworkContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);

    const cached = tenant.serverStores.get(dbId);
    if (cached) {
      return cached;
    }

    const localStore = tenant.storeFactory.getStore(dbId);
    const serverStore = new ServerNetworkContentAddressedStore(
      localStore,
      tenant.directory as unknown as MindooTenantDirectory,
      tenant.authService,
      this.cryptoAdapter,
    );

    tenant.serverStores.set(dbId, serverStore);
    console.log(`[TenantManager] Created server store for ${tenantId}/${dbId}`);

    return serverStore;
  }

  async getStore(tenantId: string, dbId: string): Promise<ContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);
    return tenant.storeFactory.getStore(dbId);
  }

  async getAuthService(tenantId: string): Promise<AuthenticationService> {
    const tenant = await this.getTenant(tenantId);
    return tenant.authService;
  }

  getCryptoAdapter(): NodeCryptoAdapter {
    return this.cryptoAdapter;
  }

  async reloadTenant(tenantId: string): Promise<LoadedTenant> {
    const normalizedId = tenantId.toLowerCase();
    this.loadedTenants.delete(normalizedId);
    return this.getTenant(normalizedId);
  }

  clearCache(): void {
    this.loadedTenants.clear();
    console.log(`[TenantManager] Cleared tenant cache`);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadTenant(tenantId: string): Promise<LoadedTenant> {
    const tenantDir = join(this.dataDir, tenantId);
    const configPath = join(tenantDir, "config.json");

    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${tenantId} not found: ${configPath}`);
    }

    const configJson = readFileSync(configPath, "utf-8");
    const config: TenantConfig = JSON.parse(configJson);

    const context: TenantContext = { tenantId, config };
    const storeFactory = new StoreFactory(tenantId, config, this.dataDir);

    // Build the inner directory (real or config-based fallback)
    let innerDirectory: Pick<MindooTenantDirectory,
      "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey">;
    let mindooTenant: MindooTenant | undefined;

    if (config.publicInfosKey && this.serverIdentity && this.serverPassword) {
      try {
        const result = await this.createDirectoryTenant(tenantId, config, storeFactory);
        mindooTenant = result.tenant;
        innerDirectory = await mindooTenant.openDirectory();
        console.log(`[TenantManager] Loaded tenant ${tenantId} with real directory`);
      } catch (error) {
        console.error(`[TenantManager] Failed to create real directory for ${tenantId}, falling back to config:`, error);
        innerDirectory = new SimpleMindooDirectory(config);
      }
    } else {
      if (config.publicInfosKey && !this.serverIdentity) {
        console.log(`[TenantManager] Tenant ${tenantId} has publicInfosKey but no server identity; using config-based directory`);
      } else {
        console.log(`[TenantManager] No publicInfosKey for ${tenantId}, using config-based directory`);
      }
      innerDirectory = new SimpleMindooDirectory(config);
    }

    // Wrap with CompositeMindooDirectory so trusted servers are also recognized
    const directory = new CompositeMindooDirectory(
      innerDirectory,
      this.trustedServers,
      config.adminUsername
        ? {
            username: config.adminUsername,
            signingPublicKey: config.adminSigningPublicKey,
            encryptionPublicKey: config.adminEncryptionPublicKey,
          }
        : undefined,
    ) as unknown as MindooTenantDirectory;

    const authService = new AuthenticationService(
      this.cryptoAdapter,
      directory,
      tenantId,
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
   * Create a real BaseMindooTenant for directory reading using the global
   * server identity.
   */
  private async createDirectoryTenant(
    tenantId: string,
    config: TenantConfig,
    storeFactory: StoreFactory,
  ): Promise<{ tenant: MindooTenant }> {
    const storeFactoryAdapter = new StoreFactoryAdapter(storeFactory);
    const factory = new BaseMindooTenantFactory(storeFactoryAdapter, this.cryptoAdapter);

    const serverUser = this.serverIdentity!;

    // Create a KeyBag using the server user's encryption key
    const keyBag = new KeyBag(
      serverUser.userEncryptionKeyPair.privateKey,
      this.serverPassword!,
      this.cryptoAdapter,
    );
    const publicInfosKeyBytes = Buffer.from(config.publicInfosKey!, "base64");
    await keyBag.set("doc", PUBLIC_INFOS_KEY_ID, new Uint8Array(publicInfosKeyBytes));

    // Collect trusted server signing keys for additionalTrustedKeys
    const openOptions: OpenTenantOptions = {};
    if (this.trustedServers.length > 0) {
      const trustedKeys = new Map<string, boolean>();
      for (const server of this.trustedServers) {
        trustedKeys.set(server.signingPublicKey, true);
      }
      openOptions.additionalTrustedKeys = trustedKeys;
    }

    const tenant = await factory.openTenant(
      tenantId,
      config.adminSigningPublicKey,
      config.adminEncryptionPublicKey,
      serverUser,
      this.serverPassword!,
      keyBag,
      openOptions,
    );

    return { tenant };
  }
}
