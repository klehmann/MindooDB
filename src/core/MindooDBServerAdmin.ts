/**
 * MindooDBServerAdmin — client for MindooDB server `/system/*` endpoints.
 *
 * Platform-agnostic: pass a {@link CryptoAdapter} (`NodeCryptoAdapter`,
 * `createCryptoAdapter()` in browser, or React Native adapter). Uses `fetch`,
 * Web Crypto via the adapter, and `atob`/`btoa` for base64 (no Node `Buffer`).
 */

import type { CryptoAdapter } from "./crypto/CryptoAdapter";
import { decryptPrivateKey as decryptPrivateKeyWithPassword } from "./crypto/privateKeyEncryption";
import type { PrivateUserId } from "./userid";
import type { EncryptedPrivateKey } from "./types";

/**
 * Connection and authentication options for {@link MindooDBServerAdmin}.
 */
export interface MindooDBServerAdminOptions {
  serverUrl: string;
  systemAdminUser: PrivateUserId;
  systemAdminPassword: string;
  /** Platform crypto (e.g. `NodeCryptoAdapter`, browser `createCryptoAdapter()`, RN adapter). */
  cryptoAdapter: CryptoAdapter;
}

interface TrustedServer {
  name: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

interface SyncServerConfig {
  name: string;
  url: string;
  syncIntervalMs?: number;
  databases: string[];
}

/**
 * One system-admin identity as stored in server `config.json`.
 *
 * A principal is uniquely identified by the combination of `username` and
 * `publicsignkey`.
 */
export interface SystemAdminPrincipal {
  username: string;
  publicsignkey: string;
}

/**
 * Runtime server config returned by `GET /system/config`.
 */
export interface ServerConfig {
  capabilities: Record<string, SystemAdminPrincipal[]>;
}

/**
 * Metadata for one historical `config.json` backup.
 */
export interface ConfigBackupInfo {
  file: string;
  createdAt: string;
}

/**
 * Response body for reading one historical config backup.
 */
export interface ConfigBackupResponse {
  file: string;
  config: ServerConfig;
}

interface RegisterTenantBody {
  adminSigningPublicKey: string;
  adminEncryptionPublicKey: string;
  adminUsername?: string;
  publicInfosKey?: string;
  defaultStoreType?: "inmemory" | "file";
  users?: Array<{
    username: string;
    signingPublicKey: string;
    encryptionPublicKey: string;
  }>;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizePrincipalKey(principal: SystemAdminPrincipal): string {
  return `${principal.username.toLowerCase()}\0${principal.publicsignkey}`;
}

function dedupePrincipals(principals: SystemAdminPrincipal[]): SystemAdminPrincipal[] {
  const seen = new Set<string>();
  const result: SystemAdminPrincipal[] = [];
  for (const principal of principals) {
    const key = normalizePrincipalKey(principal);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(principal);
    }
  }
  return result;
}

function cloneServerConfig(config: ServerConfig): ServerConfig {
  return {
    capabilities: Object.fromEntries(
      Object.entries(config.capabilities).map(([rule, principals]) => [
        rule,
        principals.map((principal) => ({ ...principal })),
      ]),
    ),
  };
}

/**
 * High-level client for authenticated access to MindooDB server `/system/*`
 * endpoints.
 *
 * This wrapper performs the Ed25519 challenge/response flow automatically,
 * caches the short-lived JWT, and exposes ergonomic methods for common server
 * administration tasks such as tenant registration, runtime config updates,
 * and delegated system-admin management.
 */
export class MindooDBServerAdmin {
  private baseUrl: string;
  private adminUser: PrivateUserId;
  private adminPassword: string;
  private cryptoAdapter: CryptoAdapter;

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  /**
   * Create a new system-admin API client for one MindooDB server.
   */
  constructor(options: MindooDBServerAdminOptions) {
    this.baseUrl = options.serverUrl.replace(/\/$/, "");
    this.adminUser = options.systemAdminUser;
    this.adminPassword = options.systemAdminPassword;
    this.cryptoAdapter = options.cryptoAdapter;
  }

  // =========================================================================
  // Tenant management
  // =========================================================================

  /**
   * List all tenant IDs currently registered on the server.
   */
  async listTenants(): Promise<string[]> {
    const res = await this.authenticatedRequest("GET", "/system/tenants");
    return (res as { tenants: string[] }).tenants;
  }

  /**
   * Create a new tenant on the server.
   *
   * The caller must already be authorized for `POST /system/tenants/:tenantId`
   * by the server's runtime config.
   */
  async registerTenant(
    tenantId: string,
    body: RegisterTenantBody,
  ): Promise<{ success: boolean; tenantId: string; message?: string }> {
    return await this.authenticatedRequest(
      "POST",
      `/system/tenants/${encodeURIComponent(tenantId)}`,
      body,
    );
  }

  /**
   * Update server-side metadata for an existing tenant.
   */
  async updateTenant(
    tenantId: string,
    updates: Record<string, unknown>,
  ): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "PUT",
      `/system/tenants/${encodeURIComponent(tenantId)}`,
      updates,
    );
  }

  /**
   * Remove a tenant from the server.
   */
  async removeTenant(
    tenantId: string,
  ): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "DELETE",
      `/system/tenants/${encodeURIComponent(tenantId)}`,
    );
  }

  // =========================================================================
  // Trusted server management
  // =========================================================================

  /**
   * List globally trusted peer servers used for server-to-server sync.
   */
  async listTrustedServers(): Promise<TrustedServer[]> {
    const res = await this.authenticatedRequest("GET", "/system/trusted-servers");
    return (res as { servers: TrustedServer[] }).servers;
  }

  /**
   * Add one globally trusted peer server.
   */
  async addTrustedServer(server: TrustedServer): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest("POST", "/system/trusted-servers", server);
  }

  /**
   * Remove one globally trusted peer server by name.
   */
  async removeTrustedServer(serverName: string): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "DELETE",
      `/system/trusted-servers/${encodeURIComponent(serverName)}`,
    );
  }

  // =========================================================================
  // Per-tenant sync server management
  // =========================================================================

  /**
   * List sync server targets configured for one tenant.
   */
  async listTenantSyncServers(tenantId: string): Promise<SyncServerConfig[]> {
    const res = await this.authenticatedRequest(
      "GET",
      `/system/tenants/${encodeURIComponent(tenantId)}/sync-servers`,
    );
    return (res as { servers: SyncServerConfig[] }).servers;
  }

  /**
   * Add one sync target for a tenant.
   */
  async addTenantSyncServer(
    tenantId: string,
    config: SyncServerConfig,
  ): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "POST",
      `/system/tenants/${encodeURIComponent(tenantId)}/sync-servers`,
      config,
    );
  }

  /**
   * Remove one tenant-specific sync target.
   */
  async removeTenantSyncServer(
    tenantId: string,
    serverName: string,
  ): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "DELETE",
      `/system/tenants/${encodeURIComponent(tenantId)}/sync-servers/${encodeURIComponent(serverName)}`,
    );
  }

  // =========================================================================
  // Trigger sync
  // =========================================================================

  /**
   * Trigger an on-demand sync for one tenant.
   */
  async triggerTenantSync(
    tenantId: string,
  ): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "POST",
      `/system/tenants/${encodeURIComponent(tenantId)}/trigger-sync`,
    );
  }

  // =========================================================================
  // Runtime config management
  // =========================================================================

  /**
   * Fetch the currently active runtime server config.
   */
  async getConfig(): Promise<ServerConfig> {
    return await this.authenticatedRequest("GET", "/system/config");
  }

  /**
   * Replace the full runtime server config.
   *
   * The server remains the source of truth for validation, backup creation, and
   * self-lockout protection.
   */
  async updateConfig(
    config: ServerConfig,
  ): Promise<{ success: boolean; message?: string; backupFile?: string }> {
    return await this.authenticatedRequest("PUT", "/system/config", config);
  }

  /**
   * List historical config backups created by prior runtime config updates.
   */
  async listConfigBackups(): Promise<ConfigBackupInfo[]> {
    const res = await this.authenticatedRequest("GET", "/system/config/backups");
    return (res as { backups: ConfigBackupInfo[] }).backups;
  }

  /**
   * Read one historical config backup from the server.
   */
  async readConfigBackup(backupFile: string): Promise<ConfigBackupResponse> {
    return await this.authenticatedRequest(
      "GET",
      `/system/config/backups/${encodeURIComponent(backupFile)}`,
    );
  }

  /**
   * Read one historical config backup from the server.
   *
   * Alias for {@link readConfigBackup} kept for compatibility with earlier
   * wrapper code.
   */
  async getConfigBackup(backupFile: string): Promise<ConfigBackupResponse> {
    return await this.readConfigBackup(backupFile);
  }

  /**
   * Return all capability rules that currently include the given principal.
   *
   * This is a client-side convenience method derived from `getConfig()`. It
   * does not require a dedicated server endpoint.
   */
  async findSystemAdminAccess(
    principal: SystemAdminPrincipal,
  ): Promise<{ principal: SystemAdminPrincipal; rules: string[] }> {
    const config = await this.getConfig();
    const principalKey = normalizePrincipalKey(principal);
    const rules = Object.entries(config.capabilities)
      .filter(([, principals]) =>
        principals.some((existing) => normalizePrincipalKey(existing) === principalKey),
      )
      .map(([rule]) => rule)
      .sort();

    return {
      principal: { ...principal },
      rules,
    };
  }

  /**
   * Grant a principal access to one or more capability rules.
   *
   * Missing rules are created automatically. Existing principal entries are
   * deduplicated by `username.toLowerCase()` + `publicsignkey`.
   */
  async grantSystemAdminAccess(
    principal: SystemAdminPrincipal,
    rules: string[],
  ): Promise<{
    success: boolean;
    config: ServerConfig;
    addedToRules: string[];
    alreadyPresentRules: string[];
    backupFile?: string;
  }> {
    if (rules.length === 0) {
      throw new Error("grantSystemAdminAccess requires at least one rule");
    }

    const config = await this.getConfig();
    const nextConfig = cloneServerConfig(config);
    const principalKey = normalizePrincipalKey(principal);
    const addedToRules: string[] = [];
    const alreadyPresentRules: string[] = [];

    for (const rule of rules) {
      const existing = nextConfig.capabilities[rule] ?? [];
      const alreadyPresent = existing.some(
        (candidate) => normalizePrincipalKey(candidate) === principalKey,
      );

      if (alreadyPresent) {
        alreadyPresentRules.push(rule);
        continue;
      }

      nextConfig.capabilities[rule] = dedupePrincipals([
        ...existing,
        { ...principal },
      ]);
      addedToRules.push(rule);
    }

    const result = await this.updateConfig(nextConfig);
    return {
      success: result.success,
      config: nextConfig,
      addedToRules,
      alreadyPresentRules,
      backupFile: result.backupFile,
    };
  }

  /**
   * Revoke a principal from selected capability rules, or from all rules when
   * no `rules` filter is provided.
   */
  async revokeSystemAdminAccess(
    principal: SystemAdminPrincipal,
    options?: { rules?: string[] },
  ): Promise<{
    success: boolean;
    config: ServerConfig;
    removedFromRules: string[];
    backupFile?: string;
  }> {
    const config = await this.getConfig();
    const nextConfig = cloneServerConfig(config);
    const principalKey = normalizePrincipalKey(principal);
    const targetRules = options?.rules ?? Object.keys(nextConfig.capabilities);
    const removedFromRules: string[] = [];

    for (const rule of targetRules) {
      const existing = nextConfig.capabilities[rule];
      if (!existing) {
        continue;
      }

      const filtered = existing.filter(
        (candidate) => normalizePrincipalKey(candidate) !== principalKey,
      );

      if (filtered.length === existing.length) {
        continue;
      }

      removedFromRules.push(rule);
      if (filtered.length === 0) {
        delete nextConfig.capabilities[rule];
      } else {
        nextConfig.capabilities[rule] = filtered;
      }
    }

    const result = await this.updateConfig(nextConfig);
    return {
      success: result.success,
      config: nextConfig,
      removedFromRules,
      backupFile: result.backupFile,
    };
  }

  // =========================================================================
  // Internal: auth + request
  // =========================================================================

  private async authenticatedRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const token = await this.ensureAuthenticated();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `MindooDBServerAdmin: ${method} ${path} failed (HTTP ${response.status}): ${errorBody}`,
      );
    }

    return response.json();
  }

  private async ensureAuthenticated(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }

    const subtle = this.cryptoAdapter.getSubtle();

    const signingKeyBuffer = await this.decryptPrivateKey(
      this.adminUser.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      this.adminPassword,
      "signing",
    );
    const signingKey = await subtle.importKey(
      "pkcs8",
      signingKeyBuffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );

    const challengeRes = await fetch(`${this.baseUrl}/system/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.adminUser.username,
        publicsignkey: this.adminUser.userSigningKeyPair.publicKey,
      }),
    });

    if (!challengeRes.ok) {
      const errorBody = await challengeRes.text();
      throw new Error(
        `MindooDBServerAdmin: challenge request failed (HTTP ${challengeRes.status}): ${errorBody}`,
      );
    }

    const { challenge } = (await challengeRes.json()) as { challenge: string };

    const messageBytes = new TextEncoder().encode(challenge);
    const signatureBuffer = await subtle.sign(
      { name: "Ed25519" },
      signingKey,
      messageBytes,
    );
    const signatureBase64 = uint8ArrayToBase64(new Uint8Array(signatureBuffer));

    const authRes = await fetch(`${this.baseUrl}/system/auth/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, signature: signatureBase64 }),
    });

    if (!authRes.ok) {
      const errorBody = await authRes.text();
      throw new Error(
        `MindooDBServerAdmin: authenticate request failed (HTTP ${authRes.status}): ${errorBody}`,
      );
    }

    const result = (await authRes.json()) as {
      success: boolean;
      token?: string;
      error?: string;
    };

    if (!result.success || !result.token) {
      throw new Error(
        `MindooDBServerAdmin: authentication failed: ${result.error || "unknown error"}`,
      );
    }

    this.cachedToken = result.token;
    this.tokenExpiresAt = Date.now() + 55 * 60 * 1000;

    return result.token;
  }

  /**
   * Decrypt a PBKDF2 + AES-GCM encrypted private key (same layout as BaseMindooTenant).
   */
  private async decryptPrivateKey(
    encrypted: EncryptedPrivateKey,
    password: string,
    saltString: string,
  ): Promise<ArrayBuffer> {
    return decryptPrivateKeyWithPassword(
      this.cryptoAdapter,
      encrypted,
      password,
      saltString,
    );
  }
}
