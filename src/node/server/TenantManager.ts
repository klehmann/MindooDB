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

import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";
import { ServerNetworkContentAddressedStore } from "../../appendonlystores/network/ServerNetworkContentAddressedStore";
import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { RSAEncryption } from "../../core/crypto/RSAEncryption";
import { decryptPrivateKey } from "../../core/crypto/privateKeyEncryption";
import { KeyBag } from "../../core/keys/KeyBag";
import type {
  MindooTenant,
  MindooTenantDirectory,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  OpenTenantOptions,
  EncryptedPrivateKey,
} from "../../core/types";
import { PUBLIC_INFOS_KEY_ID } from "../../core/types";
import type { PrivateUserId } from "../../core/userid";

import { StoreFactory } from "./StoreFactory";
import type {
  TenantConfig,
  TenantContext,
  RegisterTenantRequest,
  UserConfig,
  TrustedServer,
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

interface RegisterTenantResult {
  context: TenantContext;
  created: boolean;
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
 * - Runtime management of trusted servers
 */
export class TenantManager {
  private dataDir: string;
  private serverPassword: string | undefined;
  private cryptoAdapter: NodeCryptoAdapter;
  private loadedTenants: Map<string, LoadedTenant> = new Map();

  private serverIdentity: PrivateUserId | null = null;
  private trustedServers: TrustedServer[] = [];

  constructor(dataDir: string, serverPassword?: string) {
    this.dataDir = dataDir;
    this.serverPassword = serverPassword;
    this.cryptoAdapter = new NodeCryptoAdapter();

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      console.log(`[TenantManager] Created data directory: ${dataDir}`);
    }

    // Load global server identity
    const identityPath = join(dataDir, "server.identity.json");
    if (existsSync(identityPath)) {
      this.serverIdentity = JSON.parse(readFileSync(identityPath, "utf-8"));
      console.log(`[TenantManager] Loaded server identity: ${this.serverIdentity!.username}`);
    } else {
      console.log(`[TenantManager] No server.identity.json found (run "npm run init" to create one)`);
    }

    // Load trusted servers
    const trustedPath = join(dataDir, "trusted-servers.json");
    if (existsSync(trustedPath)) {
      this.trustedServers = JSON.parse(readFileSync(trustedPath, "utf-8"));
      console.log(`[TenantManager] Loaded ${this.trustedServers.length} trusted server(s)`);
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

  private getServerKeyBagPath(): string {
    return join(this.dataDir, "server.keybag");
  }

  private async loadServerKeyBag(): Promise<KeyBag> {
    if (!this.serverIdentity || !this.serverPassword) {
      throw new Error("Server identity and server password are required to manage tenant $publicinfos keys");
    }
    const keyBag = new KeyBag(
      this.serverIdentity.userEncryptionKeyPair.privateKey,
      this.serverPassword,
      this.cryptoAdapter,
    );
    const keyBagPath = this.getServerKeyBagPath();
    if (existsSync(keyBagPath)) {
      const data = readFileSync(keyBagPath);
      await keyBag.load(new Uint8Array(data));
    }
    return keyBag;
  }

  private async saveServerKeyBag(keyBag: KeyBag): Promise<void> {
    writeFileSync(this.getServerKeyBagPath(), Buffer.from(await keyBag.save()));
  }

  private bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }

  private mergeUniqueKeys(keys: Uint8Array[]): Uint8Array[] {
    const seen = new Set<string>();
    const unique: Uint8Array[] = [];
    for (const key of keys) {
      const signature = this.bytesToBase64(key);
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      unique.push(key);
    }
    return unique;
  }

  private async computePublicInfosFingerprint(key: Uint8Array): Promise<string> {
    const digest = await this.cryptoAdapter.getSubtle().digest("SHA-256", key as BufferSource);
    return Array.from(new Uint8Array(digest).slice(0, 8))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(":");
  }

  private async decryptEncryptedPublicInfosKey(base64Payload: string): Promise<Uint8Array> {
    if (!this.serverIdentity) {
      throw new Error("Server identity not initialized; cannot decrypt encrypted $publicinfos payload");
    }
    if (!this.serverPassword) {
      throw new Error("Server password not configured; cannot decrypt encrypted $publicinfos payload");
    }
    const privateKeyBuffer = await decryptPrivateKey(
      this.cryptoAdapter,
      this.serverIdentity.userEncryptionKeyPair.privateKey as EncryptedPrivateKey,
      this.serverPassword,
      "encryption",
    );
    const privateKey = await this.cryptoAdapter.getSubtle().importKey(
      "pkcs8",
      privateKeyBuffer,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );
    const decrypted = await new RSAEncryption(this.cryptoAdapter).decrypt(
      new Uint8Array(Buffer.from(base64Payload, "base64")),
      privateKey,
    );
    return new Uint8Array(decrypted);
  }

  private async resolveIncomingPublicInfosKey(request: RegisterTenantRequest): Promise<Uint8Array> {
    if (request.encryptedPublicInfosKey) {
      return this.decryptEncryptedPublicInfosKey(request.encryptedPublicInfosKey);
    }
    if (request.publicInfosKey) {
      return new Uint8Array(Buffer.from(request.publicInfosKey, "base64"));
    }
    throw new Error("Tenant registration requires encryptedPublicInfosKey or publicInfosKey");
  }

  private async getStoredPublicInfosKeys(tenantId: string): Promise<Uint8Array[]> {
    const keys: Uint8Array[] = [];
    if (this.serverIdentity && this.serverPassword && existsSync(this.getServerKeyBagPath())) {
      const keyBag = await this.loadServerKeyBag();
      keys.push(...await keyBag.getAllKeys("doc", tenantId, PUBLIC_INFOS_KEY_ID));
    }
    return this.mergeUniqueKeys(keys);
  }

  private async persistTenantPublicInfosKey(tenantId: string, key: Uint8Array): Promise<void> {
    const keyBag = await this.loadServerKeyBag();
    const existingKeys = await keyBag.getAllKeys("doc", tenantId, PUBLIC_INFOS_KEY_ID);
    const incomingSignature = this.bytesToBase64(key);
    const alreadyStored = existingKeys.some((entry) => this.bytesToBase64(entry) === incomingSignature);
    if (!alreadyStored) {
      await keyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, key, Date.now());
      await this.saveServerKeyBag(keyBag);
    }
  }

  async listTenantPublicInfosFingerprints(tenantId: string): Promise<string[]> {
    const normalizedId = tenantId.toLowerCase();
    const configPath = join(this.dataDir, normalizedId, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const fingerprints = await Promise.all(
      (await this.getStoredPublicInfosKeys(normalizedId)).map((key) => this.computePublicInfosFingerprint(key)),
    );
    return [...new Set(fingerprints)].sort();
  }

  // =======================================================================
  // Tenant management
  // =======================================================================

  async registerTenant(request: RegisterTenantRequest): Promise<RegisterTenantResult> {
    const tenantId = request.tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, tenantId);
    const configPath = join(tenantDir, "config.json");
    if (!this.serverIdentity || !this.serverPassword) {
      throw new Error("Tenant registration requires an unlocked server identity to store $publicinfos keys");
    }
    const publicInfosKey = await this.resolveIncomingPublicInfosKey(request);

    if (existsSync(configPath)) {
      const existingConfig: TenantConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      const incomingSignature = this.bytesToBase64(publicInfosKey);
      const existingKeys = await this.getStoredPublicInfosKeys(tenantId);
      const hasMatch = existingKeys.some((key) => this.bytesToBase64(key) === incomingSignature);
      if (hasMatch) {
        console.log(`[TenantManager] Tenant ${tenantId} already registered with matching $publicinfos key`);
        return {
          context: { tenantId, config: existingConfig },
          created: false,
        };
      }
      throw new Error(`Tenant ${tenantId} already exists with different $publicinfos key`);
    }

    mkdirSync(tenantDir, { recursive: true });

    const config: TenantConfig = {
      adminUsername: request.adminUsername,
      adminSigningPublicKey: request.adminSigningPublicKey,
      adminEncryptionPublicKey: request.adminEncryptionPublicKey,
      defaultStoreType: request.defaultStoreType || "file",
      users: [],
    };
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      await this.persistTenantPublicInfosKey(tenantId, publicInfosKey);
    } catch (error) {
      rmSync(tenantDir, { recursive: true, force: true });
      throw error;
    }

    console.log(
      `[TenantManager] Registered tenant: ${tenantId} ($publicinfos stored in server keybag)`,
    );

    return {
      context: { tenantId, config },
      created: true,
    };
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

  /**
   * Update operator-owned fields of an existing tenant configuration.
   * Only the fields present in `updates` are overwritten.
   */
  updateTenantConfig(
    tenantId: string,
    updates: Partial<Pick<TenantConfig, "defaultStoreType" | "remoteServers">>,
  ): void {
    const normalizedId = tenantId.toLowerCase();
    const configPath = join(this.dataDir, normalizedId, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const config: TenantConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    if (updates.defaultStoreType !== undefined) {
      config.defaultStoreType = updates.defaultStoreType;
    }
    if (updates.remoteServers !== undefined) {
      config.remoteServers = updates.remoteServers;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    this.loadedTenants.delete(normalizedId);
    console.log(`[TenantManager] Updated tenant config: ${normalizedId}`);
  }

  async removeTenant(tenantId: string): Promise<void> {
    const normalizedId = tenantId.toLowerCase();
    const tenantDir = join(this.dataDir, normalizedId);

    if (!existsSync(tenantDir)) {
      throw new Error(`Tenant ${normalizedId} does not exist`);
    }

    this.loadedTenants.delete(normalizedId);
    if (this.serverIdentity && this.serverPassword && existsSync(this.getServerKeyBagPath())) {
      const keyBag = await this.loadServerKeyBag();
      await keyBag.deleteKey("doc", normalizedId, PUBLIC_INFOS_KEY_ID);
      await this.saveServerKeyBag(keyBag);
    }
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

    const publicInfosKeys = await this.getStoredPublicInfosKeys(tenantId);
    if (publicInfosKeys.length > 0 && this.serverIdentity && this.serverPassword) {
      try {
        const result = await this.createDirectoryTenant(tenantId, config, storeFactory, publicInfosKeys);
        mindooTenant = result.tenant;
        innerDirectory = await mindooTenant.openDirectory();
        console.log(`[TenantManager] Loaded tenant ${tenantId} with real directory`);
      } catch (error) {
        console.error(`[TenantManager] Failed to create real directory for ${tenantId}, falling back to config:`, error);
        innerDirectory = new SimpleMindooDirectory(config);
      }
    } else {
      if (publicInfosKeys.length > 0 && !this.serverIdentity) {
        console.log(`[TenantManager] Tenant ${tenantId} has $publicinfos keys but no server identity; using config-based directory`);
      } else {
        console.log(`[TenantManager] No $publicinfos keys for ${tenantId}, using config-based directory`);
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
    publicInfosKeys: Uint8Array[],
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
    for (const publicInfosKey of this.mergeUniqueKeys(publicInfosKeys)) {
      await keyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    }

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
