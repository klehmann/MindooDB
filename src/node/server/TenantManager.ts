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
import { join, resolve, sep } from "path";

import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";
import { ServerNetworkContentAddressedStore } from "../../appendonlystores/network/ServerNetworkContentAddressedStore";
import type { ServerTier1Evaluator, ServerReadEvaluator, ServerDbAccessEvaluator } from "../../appendonlystores/network/ServerNetworkContentAddressedStore";
import type { WitnessSigner } from "../../core/crypto/WitnessReceipt";
import type { TimestampProvider } from "../../core/accesscontrol/timestamp/TimestampProvider";
import { Ed25519WitnessProvider } from "../../core/accesscontrol/timestamp/Ed25519WitnessProvider";
import type { BaseMindooTenantDirectory } from "../../core/BaseMindooTenantDirectory";
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
  StoreKind,
  DirectoryUserLookup,
  GrantKeyPairInfo,
} from "../../core/types";
import type { AccessDecision } from "../../core/accesscontrol/types";
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
import { ENV_VARS } from "./types";
import { assertSafeSyncUrl } from "../../core/utils/urlSafety";

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
    return {
      docStore: this.storeFactory.getStore(dbId, "docs" as StoreKind),
      attachmentStore: this.storeFactory.getStore(dbId, "attachments" as StoreKind),
    };
  }
}

// ---------------------------------------------------------------------------
// SimpleMindooDirectory — config-based fallback
// ---------------------------------------------------------------------------

export class SimpleMindooDirectory implements Pick<MindooTenantDirectory,
  "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey" | "getUserBySigningPublicKey"
> {
  /** Canonical index: entries are identified by their signing public key. */
  private usersByKey: Map<string, UserConfig> = new Map();
  /**
   * Backward-compat index by documentation-only username, populated only for
   * config entries that carry a `username`. Lets legacy username-based
   * challenges keep resolving; `username` is never required.
   */
  private usersByUsername: Map<string, UserConfig> = new Map();
  private revokedUsers: Set<string> = new Set();
  private adminSigningPublicKey: string;

  constructor(config: TenantConfig) {
    this.adminSigningPublicKey = config.adminSigningPublicKey;

    if (config.users) {
      for (const user of config.users) {
        // Identity is the signing key. `username` is documentation-only and
        // ignored for matching; index it only as a legacy convenience.
        this.usersByKey.set(user.signingPublicKey, user);
        if (typeof user.username === "string" && user.username.trim()) {
          this.usersByUsername.set(user.username.toLowerCase(), user);
        }
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
    const user = this.usersByUsername.get(normalizedUsername);
    if (!user) {
      return null;
    }
    return {
      signingPublicKey: user.signingPublicKey,
      encryptionPublicKey: user.encryptionPublicKey,
    };
  }

  async getUserBySigningPublicKey(publicKey: string): Promise<DirectoryUserLookup | null> {
    const user = this.usersByKey.get(publicKey);
    if (!user) {
      return null;
    }
    if (
      typeof user.username === "string" &&
      this.revokedUsers.has(user.username.toLowerCase())
    ) {
      return null;
    }
    return {
      username: typeof user.username === "string" ? user.username : "",
      signingPublicKey: user.signingPublicKey,
      encryptionPublicKey: user.encryptionPublicKey,
      details: null,
    };
  }

  async isUserRevoked(username: string): Promise<boolean> {
    return this.revokedUsers.has(username.toLowerCase());
  }

  async validatePublicSigningKey(
    publicKey: string,
    _opts?: { forceRefresh?: boolean },
  ): Promise<boolean> {
    if (publicKey === this.adminSigningPublicKey) {
      return true;
    }
    const user = this.usersByKey.get(publicKey);
    if (!user) {
      return false;
    }
    if (
      typeof user.username === "string" &&
      this.revokedUsers.has(user.username.toLowerCase())
    ) {
      return false;
    }
    return true;
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
      "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey">
      & Partial<Pick<MindooTenantDirectory,
        "getUserBySigningPublicKey"
        | "getUserSigningKeyUniverse"
        | "getUserKeyPairs"
        | "getWipeGrantDocId"
        | "evaluateReadAccessForUser"
        | "evaluateReadAccessForSigningKey">>
      & Partial<Pick<BaseMindooTenantDirectory, "evaluateDbAccessForSigningKey">>,
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

  async validatePublicSigningKey(
    publicKey: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<boolean> {
    if (this.adminBootstrapIdentity && this.adminBootstrapIdentity.signingPublicKey === publicKey) {
      return true;
    }

    const innerResult = await this.inner.validatePublicSigningKey(publicKey, opts);
    if (innerResult) return true;

    for (const server of this.trustedServers) {
      if (server.signingPublicKey === publicKey) {
        return true;
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Advanced directory features forwarded to the inner directory. Config-based
  // inner directories (SimpleMindooDirectory) do not implement these, so the
  // composite degrades gracefully (no key-based identity, no read policy, no
  // wipe directives) — preserving legacy config-only behavior — while a real
  // BaseMindooTenantDirectory inner enables the key-based auth, read gate, and
  // remote-wipe paths (docs/accesscontrol.md §6.5).
  // -----------------------------------------------------------------------

  async getUserBySigningPublicKey(publicKey: string): Promise<DirectoryUserLookup | null> {
    if (typeof this.inner.getUserBySigningPublicKey === "function") {
      const innerLookup = await this.inner.getUserBySigningPublicKey(publicKey);
      if (innerLookup) return innerLookup;
    }

    // Bootstrap/config fallback: the admin and trusted-server identities can be
    // resolved by their signing key even without a grantaccess document on this
    // server, mirroring getUserPublicKeys. Without this, key-based identity
    // resolution (and the validateToken active-key check below) would treat the
    // admin's own key as unknown the moment the directory has no admin grant.
    if (this.adminBootstrapIdentity && this.adminBootstrapIdentity.signingPublicKey === publicKey) {
      return {
        username: this.adminBootstrapIdentity.username,
        signingPublicKey: this.adminBootstrapIdentity.signingPublicKey,
        encryptionPublicKey: this.adminBootstrapIdentity.encryptionPublicKey,
        details: null,
      };
    }
    for (const server of this.trustedServers) {
      if (server.signingPublicKey === publicKey) {
        return {
          username: server.name,
          signingPublicKey: server.signingPublicKey,
          encryptionPublicKey: server.encryptionPublicKey,
          details: null,
        };
      }
    }
    return null;
  }

  async getUserSigningKeyUniverse(
    username: string,
  ): Promise<{ active: string[]; wipeRequested: string[] }> {
    const base =
      typeof this.inner.getUserSigningKeyUniverse === "function"
        ? await this.inner.getUserSigningKeyUniverse(username)
        : { active: [] as string[], wipeRequested: [] as string[] };

    // The admin bootstrap identity, trusted servers, and config-based users are
    // valid principals even without a grantaccess document on this server (the
    // server config / bootstrap identity is the root of trust). Their signing
    // key must therefore count as ACTIVE so the token-validation gate in
    // AuthenticationService.validateToken (which requires the device key to be
    // in this active set) does not reject a freshly-issued admin/config token.
    // We reuse getUserPublicKeys, which already applies exactly those fallbacks.
    const active = new Set(base.active);
    const fallback = await this.getUserPublicKeys(username);
    if (fallback) active.add(fallback.signingPublicKey);
    return { active: Array.from(active), wipeRequested: base.wipeRequested };
  }

  async getUserKeyPairs(username: string): Promise<GrantKeyPairInfo[]> {
    if (typeof this.inner.getUserKeyPairs === "function") {
      return this.inner.getUserKeyPairs(username);
    }
    return [];
  }

  async getWipeGrantDocId(signingKey: string): Promise<string | null> {
    if (typeof this.inner.getWipeGrantDocId === "function") {
      return this.inner.getWipeGrantDocId(signingKey);
    }
    return null;
  }

  async evaluateReadAccessForUser(input: {
    username: string;
    dbid: string;
    decryptionKeyId: string;
    at?: number;
  }): Promise<AccessDecision> {
    if (typeof this.inner.evaluateReadAccessForUser === "function") {
      return this.inner.evaluateReadAccessForUser(input);
    }
    // Config-based directories never carry read policies -> unrestricted.
    return { allowed: true, reason: "read access control not enabled", tier: "tier1" };
  }

  async evaluateReadAccessForSigningKey(input: {
    signingKey: string;
    dbid: string;
    decryptionKeyId: string;
    at?: number;
  }): Promise<AccessDecision> {
    if (typeof this.inner.evaluateReadAccessForSigningKey === "function") {
      return this.inner.evaluateReadAccessForSigningKey(input);
    }
    // Config-based directories never carry read policies -> unrestricted.
    return { allowed: true, reason: "read access control not enabled", tier: "tier1" };
  }

  async evaluateDbAccessForSigningKey(input: {
    dbid: string;
    signingKey: string;
  }): Promise<boolean> {
    if (typeof this.inner.evaluateDbAccessForSigningKey === "function") {
      return this.inner.evaluateDbAccessForSigningKey(input);
    }
    // Config-based directories carry no database-open policy -> unrestricted.
    return true;
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
  /** Lazily-built, cached witness signer (server's Ed25519 signing identity). */
  private witnessSigner: WitnessSigner | undefined;

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

  /**
   * Build (and cache) the server's witness identity used to stamp receipts on
   * accepted entries (docs/accesscontrol.md §5.3). Returns undefined when the
   * server identity or its unlock password is unavailable, in which case the
   * server runs in pre-access-control mode (no stamping, no Tier 1 advertised).
   */
  async getWitnessSigner(): Promise<WitnessSigner | undefined> {
    if (this.witnessSigner) return this.witnessSigner;
    if (!this.serverIdentity || !this.serverPassword) return undefined;

    const subtle = this.cryptoAdapter.getSubtle();
    const signingKeyBuffer = await decryptPrivateKey(
      this.cryptoAdapter,
      this.serverIdentity.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      this.serverPassword,
      "signing",
    );
    const signingPrivateKey = await subtle.importKey(
      "pkcs8",
      signingKeyBuffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    this.witnessSigner = {
      publicKeyPem: this.serverIdentity.userSigningKeyPair.publicKey as string,
      signingPrivateKey,
      subtle,
    };
    return this.witnessSigner;
  }

  /**
   * Build the trusted-time provider that stamps receipts on accepted entries
   * (docs/accesscontrol.md §5.3, §13). v1 wraps the server's Ed25519 witness
   * identity; returns undefined when no witness signer is available, leaving the
   * server in pre-access-control mode.
   */
  async getTimestampProvider(): Promise<TimestampProvider | undefined> {
    const signer = await this.getWitnessSigner();
    if (!signer) return undefined;
    return new Ed25519WitnessProvider({ signer, subtle: signer.subtle });
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
    const keyBag = await this.createServerKeyBag(this.serverIdentity, this.serverPassword);
    const keyBagPath = this.getServerKeyBagPath();
    if (existsSync(keyBagPath)) {
      const data = readFileSync(keyBagPath);
      await keyBag.load(new Uint8Array(data));
    }
    return keyBag;
  }

  private async createServerKeyBag(serverUser: PrivateUserId, serverPassword: string): Promise<KeyBag> {
    const wrappingKey = await KeyBag.deriveWrappingKey(
      serverUser.userEncryptionKeyPair.privateKey,
      serverPassword,
      this.cryptoAdapter,
    );

    return new KeyBag({
      wrappingKey,
      cryptoAdapter: this.cryptoAdapter,
    });
  }

  private async saveServerKeyBag(keyBag: KeyBag): Promise<void> {
    const data = await keyBag.save();
    writeFileSync(this.getServerKeyBagPath(), new DataView(data.buffer, data.byteOffset, data.byteLength));
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

  private resolveTenantDir(tenantId: string): string {
    const baseDir = resolve(this.dataDir);
    const tenantDir = resolve(baseDir, tenantId);
    if (tenantDir !== baseDir && !tenantDir.startsWith(`${baseDir}${sep}`)) {
      throw new Error(`Resolved tenant path escapes data directory for tenantId "${tenantId}"`);
    }
    return tenantDir;
  }

  private resolveTenantConfigPath(tenantId: string): string {
    return join(this.resolveTenantDir(tenantId), "config.json");
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
    const configPath = this.resolveTenantConfigPath(normalizedId);
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
    const tenantDir = this.resolveTenantDir(tenantId);
    const configPath = this.resolveTenantConfigPath(tenantId);
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
    const configPath = this.resolveTenantConfigPath(normalizedId);
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
    const configPath = this.resolveTenantConfigPath(normalizedId);
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
    const tenantDir = this.resolveTenantDir(normalizedId);

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
    const configPath = this.resolveTenantConfigPath(normalizedId);
    if (!existsSync(configPath)) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const config: TenantConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    return (config.remoteServers || []) as NamedRemoteServerConfig[];
  }

  addTenantSyncServer(tenantId: string, server: NamedRemoteServerConfig): void {
    const normalizedId = tenantId.toLowerCase();
    // SSRF guard (defense in depth alongside the HTTP route): a configured sync
    // URL is fetched server-side, so reject plaintext/internal targets unless
    // explicitly allowed for local development.
    const allowInsecure = /^(1|true)$/i.test(
      process.env[ENV_VARS.ALLOW_INSECURE_SYNC_URLS] ?? "",
    );
    assertSafeSyncUrl(server.url, {
      requireHttps: !allowInsecure,
      allowPrivate: allowInsecure,
    });
    const configPath = this.resolveTenantConfigPath(normalizedId);
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
    const configPath = this.resolveTenantConfigPath(normalizedId);
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

  async getServerStore(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<ServerNetworkContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);

    const cacheKey = `${dbId}:${storeKind}`;
    const cached = tenant.serverStores.get(cacheKey);
    if (cached) {
      return cached;
    }

    const localStore = tenant.storeFactory.getStore(dbId, storeKind);

    // Access-control v1 wiring (docs/accesscontrol.md §5–§7). The witness signer
    // lets the server stamp receipts on accepted entries; the Tier 1 evaluator
    // enforces identity-tier rules at push time. Both are only active when the
    // server identity is unlocked and the directory supports evaluation, so
    // pre-access-control deployments keep their existing behavior.
    const timestampProvider = await this.getTimestampProvider();
    const directory = tenant.directory as unknown as MindooTenantDirectory;
    const tier1Evaluator = this.buildTier1Evaluator(directory, localStore);
    const wipeGrantDocIdResolver = this.buildWipeGrantDocIdResolver(directory);
    // Read gate is never applied to the directory store itself: every
    // participant must always be able to sync grants, policies, groups and read
    // rules, otherwise read access could never be evaluated at all.
    const readEvaluator =
      dbId === "directory" ? undefined : this.buildReadEvaluator(directory);
    // Database-open gate (directory-restricted policy). Never applied to the
    // directory store itself, which must always sync so the policy can be read.
    const dbAccessEvaluator =
      dbId === "directory" ? undefined : this.buildDbAccessEvaluator(directory);

    const serverStore = new ServerNetworkContentAddressedStore(
      localStore,
      directory,
      tenant.authService,
      this.cryptoAdapter,
      undefined,
      {
        timestampProvider,
        witnessDbid: dbId,
        tier1Evaluator,
        wipeGrantDocIdResolver,
        readEvaluator,
        dbAccessEvaluator,
      },
    );

    tenant.serverStores.set(cacheKey, serverStore);
    console.log(`[TenantManager] Created server store for ${tenantId}/${dbId}/${storeKind}`);

    return serverStore;
  }

  /**
   * Build a Tier 1 evaluator closure for a server store, or undefined when the
   * directory cannot evaluate access (e.g. config-based directory without the
   * access-control state chain). The closure resolves `$author` for non-create
   * ops by reading the document's `doc_create` entry creator key from the local
   * store (metadata only, no decryption) and comparing it to the change author.
   */
  private buildTier1Evaluator(
    directory: MindooTenantDirectory,
    localStore: ContentAddressedStore,
  ): ServerTier1Evaluator | undefined {
    const evaluable = directory as unknown as {
      evaluateAccessForSigningKey?: BaseMindooTenantDirectory["evaluateAccessForSigningKey"];
    };
    if (typeof evaluable.evaluateAccessForSigningKey !== "function") {
      return undefined;
    }

    return async (entry, dbid) => {
      // The witness evaluates Tier 1 at its acceptance time (now), the same time
      // it will stamp into the receipt (docs/accesscontrol.md §5.3, §7).
      const trustedTime = Date.now();

      // Resolve `$author`: for doc_create the author is the creator; otherwise
      // compare the change signer to the document's original doc_create author.
      let isAuthor = entry.entryType === "doc_create";
      if (!isAuthor) {
        try {
          const docEntries = await localStore.findNewEntriesForDoc([], entry.docId);
          const createEntry = docEntries.find((m) => m.entryType === "doc_create");
          if (createEntry) {
            isAuthor = createEntry.createdByPublicKey === entry.createdByPublicKey;
          }
        } catch {
          // If we cannot resolve the creator, leave isAuthor false; a rule that
          // requires $author will deny, which is the safe (fail-closed) choice.
        }
      }

      return evaluable.evaluateAccessForSigningKey!({
        op: entry.entryType as Parameters<BaseMindooTenantDirectory["evaluateAccessForSigningKey"]>[0]["op"],
        dbid,
        signingKey: entry.createdByPublicKey,
        trustedTime,
        isAuthor,
        // Cleartext metadata the witness already holds; enables the create-key
        // allowlist gate to be enforced at push time (Tier 1).
        decryptionKeyId: entry.decryptionKeyId,
      });
    };
  }

  /**
   * Build a database-open evaluator closure for a server store, or undefined
   * when the directory cannot evaluate the database-open policy (e.g. a
   * config-based directory without the access-control state chain). When the
   * tenant policy is `"directory-restricted"`, this rejects sync for any
   * database id that is not in the allowlist; `"directory"` is always allowed
   * and the tenant admin is exempt (resolved from the principal signing key).
   */
  private buildDbAccessEvaluator(
    directory: MindooTenantDirectory,
  ): ServerDbAccessEvaluator | undefined {
    const evaluable = directory as unknown as {
      evaluateDbAccessForSigningKey?: BaseMindooTenantDirectory["evaluateDbAccessForSigningKey"];
    };
    if (typeof evaluable.evaluateDbAccessForSigningKey !== "function") {
      return undefined;
    }

    return async (principal, dbid) => {
      return evaluable.evaluateDbAccessForSigningKey!({
        dbid,
        signingKey: principal.signingKey ?? "",
      });
    };
  }

  /**
   * Build a read evaluator closure for a data server store, or undefined when
   * the directory cannot evaluate read access (read-side of
   * docs/accesscontrol.md). The closure resolves the reader's identity at
   * server time and returns whether an entry with the given cleartext
   * `decryptionKeyId` may be delivered. Failures fail-closed (deny) so a
   * transient directory error never leaks data past a deny policy.
   */
  private buildReadEvaluator(
    directory: MindooTenantDirectory,
  ): ServerReadEvaluator | undefined {
    const evaluable = directory as unknown as {
      evaluateReadAccessForUser?: BaseMindooTenantDirectory["evaluateReadAccessForUser"];
      evaluateReadAccessForSigningKey?: BaseMindooTenantDirectory["evaluateReadAccessForSigningKey"];
    };
    const hasKeyEval = typeof evaluable.evaluateReadAccessForSigningKey === "function";
    const hasUserEval = typeof evaluable.evaluateReadAccessForUser === "function";
    if (!hasKeyEval && !hasUserEval) {
      return undefined;
    }
    return async (principal, dbid, decryptionKeyId) => {
      try {
        // Prefer the key-based gate: it resolves identity from the grant's
        // `identity_hashes` bundle without any cleartext username
        // (docs/accesscontrol.md §6.5). Fall back to the username path only for
        // legacy tokens that carry no device signing key.
        if (hasKeyEval && principal.signingKey) {
          const decision = await evaluable.evaluateReadAccessForSigningKey!({
            signingKey: principal.signingKey,
            dbid,
            decryptionKeyId,
          });
          return decision.allowed;
        }
        if (hasUserEval && principal.username) {
          const decision = await evaluable.evaluateReadAccessForUser!({
            username: principal.username,
            dbid,
            decryptionKeyId,
          });
          return decision.allowed;
        }
        // Neither identifier resolvable -> fail-closed.
        return false;
      } catch {
        // Fail-closed: if the read policy cannot be evaluated, do not deliver.
        return false;
      }
    };
  }

  /**
   * Build a remote-wipe resolver closure for a server store, or undefined when
   * the directory does not support wipe directives (docs/accesscontrol.md §6.5).
   * Maps a wipe-targeted signing key to the admin-signed grant document id so
   * the server can serve only that document to the targeted device.
   */
  private buildWipeGrantDocIdResolver(
    directory: MindooTenantDirectory,
  ): ((signingKey: string) => Promise<string | null>) | undefined {
    if (typeof directory.getWipeGrantDocId !== "function") {
      return undefined;
    }
    return (signingKey: string) => directory.getWipeGrantDocId!(signingKey);
  }

  async getStore(tenantId: string, dbId: string, storeKind: StoreKind): Promise<ContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);
    return tenant.storeFactory.getStore(dbId, storeKind);
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
    const configPath = this.resolveTenantConfigPath(tenantId);

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
    const keyBag = await this.createServerKeyBag(serverUser, this.serverPassword!);
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
