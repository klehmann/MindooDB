import type { MindooDBServerInfo } from "../../core/types";

/**
 * Types for the MindooDB Example Server
 */

/**
 * Store type for content-addressed stores.
 */
export type StoreType = "inmemory" | "file";

/**
 * Configuration for a user registered in the tenant.
 * Users can be human clients or other servers (for server-to-server sync).
 */
export interface UserConfig {
  /** Username identifier (e.g., "alice" or "server-eu-west") */
  username: string;
  /** Ed25519 public key in PEM format for signature verification */
  signingPublicKey: string;
  /** RSA-OAEP public key in PEM format for encryption */
  encryptionPublicKey: string;
}

/**
 * A remote server trusted for server-to-server sync.
 * Stored globally in <dataDir>/trusted-servers.json.
 */
export interface TrustedServer extends MindooDBServerInfo {}

/**
 * Configuration for a remote server to sync with (per-tenant).
 * The server authenticates using its global identity (from server.identity.json).
 * The remote server's public keys are looked up from trusted-servers.json.
 */
export interface RemoteServerConfig {
  /** Base URL of the remote server (e.g., "https://eu-west.example.com") */
  url: string;
  /** Optional: automatic sync interval in milliseconds */
  syncIntervalMs?: number;
  /** Optional: specific databases to sync (default: all) */
  databases?: string[];
}

/**
 * RemoteServerConfig with a required name, used when managing sync servers
 * via the admin API. The name identifies the server for updates and deletes.
 */
export interface NamedRemoteServerConfig extends RemoteServerConfig {
  /** Server name matching the trusted-servers identity (e.g., "CN=server2") */
  name: string;
}

/**
 * Per-database store configuration.
 */
export interface DatabaseStoreConfig {
  storeType: StoreType;
}

/**
 * Tenant configuration stored in <dataDir>/<tenantId>/config.json
 *
 * The tenantId is NOT stored here - it's derived from the directory name.
 */
export interface TenantConfig {
  /** Admin username used for bootstrap authentication (e.g., "cn=admin/o=acme") */
  adminUsername?: string;
  /** Ed25519 public key in PEM format for verifying admin signatures */
  adminSigningPublicKey: string;
  /** RSA-OAEP public key in PEM format for encrypting admin-only data */
  adminEncryptionPublicKey: string;

  /** Default store type for new databases (default: "file") */
  defaultStoreType?: StoreType;
  /** Per-database store configuration overrides */
  databaseStores?: Record<string, DatabaseStoreConfig>;

  /** Registered users (clients and other servers) kept for bootstrap metadata only */
  users?: UserConfig[];

  /** Remote servers to sync with (for server-to-server sync) */
  remoteServers?: RemoteServerConfig[];
}

/**
 * Request body for POST /admin/register-tenant
 */
export interface RegisterTenantRequest {
  /** Tenant identifier (lowercase, becomes directory name) */
  tenantId: string;
  /** Admin username used for bootstrap authentication */
  adminUsername?: string;
  /** Ed25519 public key in PEM format */
  adminSigningPublicKey: string;
  /** RSA-OAEP public key in PEM format */
  adminEncryptionPublicKey: string;
  /** Legacy fallback: base64-encoded raw $publicinfos AES-256 key */
  publicInfosKey?: string;
  /** Preferred transport: base64-encoded RSA-encrypted $publicinfos AES-256 key */
  encryptedPublicInfosKey?: string;
  /** Default store type (default: "file") */
  defaultStoreType?: StoreType;
  /** Initial users to register (for testing/bootstrapping only, ignored when publicInfosKey is present) */
  users?: UserConfig[];
}

/**
 * Response body for POST /admin/register-tenant
 */
export interface RegisterTenantResponse {
  success: boolean;
  tenantId: string;
  created?: boolean;
  message?: string;
}

export interface TenantPublicInfosFingerprintsResponse {
  tenantId: string;
  fingerprints: string[];
}

/**
 * Response body for GET /admin/tenants
 */
export interface ListTenantsResponse {
  tenants: string[];
}

/**
 * Loaded tenant context used internally by the server.
 */
export interface TenantContext {
  /** Tenant identifier (lowercase) */
  tenantId: string;
  /** Loaded tenant configuration */
  config: TenantConfig;
}

// =========================================================================
// System admin config types (config.json)
// =========================================================================

/**
 * A principal entry in a capability rule.
 * Identifies a system admin by both username and public signing key.
 *
 * The special wildcard principal `{ username: "*", publicsignkey: "*" }`
 * is reserved for demo tenant-creation rules and is rejected for all other
 * system endpoints.
 */
export interface SystemAdminPrincipal {
  username: string;
  publicsignkey: string;
}

export interface RateLimitConfig {
  windowMs?: number;
  max?: number;
}

export interface ServerRateLimitsConfig {
  sync?: RateLimitConfig;
}

/**
 * Server-level configuration loaded from config.json.
 *
 * The `capabilities` map controls which system admins can call which
 * endpoints. Keys are `METHOD:PATHPATTERN` rules (e.g. `ALL:/system/*`,
 * `POST:/system/tenants/company-*`). Values are arrays of principals
 * allowed to call matching routes.
 */
export interface ServerConfig {
  capabilities: Record<string, SystemAdminPrincipal[]>;
  rateLimits?: ServerRateLimitsConfig;
}

/**
 * Environment variables used by the server.
 */
export const ENV_VARS = {
  /** Password to decrypt server identity private keys and per-tenant keybags */
  SERVER_PASSWORD: "MINDOODB_SERVER_PASSWORD",
  /**
   * Path to a file whose contents are the server password (trimmed). If set, used
   * instead of {@link ENV_VARS.SERVER_PASSWORD}. Prefer in Docker so the secret is
   * not stored in the container environment block.
   */
  SERVER_PASSWORD_FILE: "MINDOODB_SERVER_PASSWORD_FILE",
  /**
   * Optional comma-separated allowlist for /system/* (system admin HTTP surface).
   * If unset or `*`, any client IP may call /system/* (JWT + capabilities still required).
   * Supports exact IPv4/IPv6 addresses plus IPv4/IPv6 CIDRs.
   * Example: `127.0.0.1,::1,10.0.0.0/8,2001:db8::/32`
   */
  ADMIN_ALLOWED_IPS: "MINDOODB_ADMIN_ALLOWED_IPS",
} as const;
