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

export interface SystemAdminPrincipal {
  username: string;
  publicsignkey: string;
}

export interface ServerConfig {
  capabilities: Record<string, SystemAdminPrincipal[]>;
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

export class MindooDBServerAdmin {
  private baseUrl: string;
  private adminUser: PrivateUserId;
  private adminPassword: string;
  private cryptoAdapter: CryptoAdapter;

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(options: MindooDBServerAdminOptions) {
    this.baseUrl = options.serverUrl.replace(/\/$/, "");
    this.adminUser = options.systemAdminUser;
    this.adminPassword = options.systemAdminPassword;
    this.cryptoAdapter = options.cryptoAdapter;
  }

  // =========================================================================
  // Tenant management
  // =========================================================================

  async listTenants(): Promise<string[]> {
    const res = await this.authenticatedRequest("GET", "/system/tenants");
    return (res as { tenants: string[] }).tenants;
  }

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

  async listTrustedServers(): Promise<TrustedServer[]> {
    const res = await this.authenticatedRequest("GET", "/system/trusted-servers");
    return (res as { servers: TrustedServer[] }).servers;
  }

  async addTrustedServer(server: TrustedServer): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest("POST", "/system/trusted-servers", server);
  }

  async removeTrustedServer(serverName: string): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest(
      "DELETE",
      `/system/trusted-servers/${encodeURIComponent(serverName)}`,
    );
  }

  // =========================================================================
  // Per-tenant sync server management
  // =========================================================================

  async listTenantSyncServers(tenantId: string): Promise<SyncServerConfig[]> {
    const res = await this.authenticatedRequest(
      "GET",
      `/system/tenants/${encodeURIComponent(tenantId)}/sync-servers`,
    );
    return (res as { servers: SyncServerConfig[] }).servers;
  }

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

  async getConfig(): Promise<ServerConfig> {
    return await this.authenticatedRequest("GET", "/system/config");
  }

  async updateConfig(
    config: ServerConfig,
  ): Promise<{ success: boolean; message?: string }> {
    return await this.authenticatedRequest("PUT", "/system/config", config);
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
