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
export interface TrustedServer {
  /** Server name (e.g., "CN=server2") */
  name: string;
  /** Ed25519 public key in PEM format */
  signingPublicKey: string;
  /** RSA-OAEP public key in PEM format */
  encryptionPublicKey: string;
}

/**
 * A delegated API key that allows creating tenants.
 * Stored globally in <dataDir>/tenant-api-keys.json.
 */
export interface TenantCreationKey {
  /** The secret API key value (prefixed with "mdb_tk_") */
  apiKey: string;
  /** Human-readable label (e.g., "acme-corp") */
  name: string;
  /** If set, only allows creating tenants with IDs starting with this prefix */
  tenantIdPrefix?: string;
  /** Creation timestamp */
  createdAt: number;
}

/**
 * Configuration for a remote server to sync with (per-tenant).
 * The server authenticates using its global identity (from server-identity.json).
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

  /** Base64-encoded $publicinfos AES-256 symmetric key for reading the directory DB */
  publicInfosKey?: string;

  /** Default store type for new databases (default: "file") */
  defaultStoreType?: StoreType;
  /** Per-database store configuration overrides */
  databaseStores?: Record<string, DatabaseStoreConfig>;

  /** Registered users (clients and other servers) — bootstrap/test fallback */
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
  /** Base64-encoded $publicinfos AES-256 symmetric key for reading the directory DB */
  publicInfosKey?: string;
  /** Default store type (default: "file") */
  defaultStoreType?: StoreType;
  /** Initial users to register (for testing/bootstrapping only) */
  users?: UserConfig[];
}

/**
 * Response body for POST /admin/register-tenant
 */
export interface RegisterTenantResponse {
  success: boolean;
  tenantId: string;
  message?: string;
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

/**
 * Environment variables used by the server.
 */
export const ENV_VARS = {
  /** Password to decrypt server identity private keys and per-tenant keybags */
  SERVER_PASSWORD: "MINDOODB_SERVER_PASSWORD",
  /** Optional API key to protect admin endpoints (full access) */
  ADMIN_API_KEY: "MINDOODB_ADMIN_API_KEY",
  /**
   * Comma-separated list of IPs or CIDRs allowed to access admin endpoints.
   * Default: localhost only (127.0.0.1, ::1).
   * Set to "*" to allow all IPs.
   * Examples: "10.0.0.0/8,192.168.1.0/24" or "10.0.0.5,10.0.0.6"
   */
  ADMIN_ALLOWED_IPS: "MINDOODB_ADMIN_ALLOWED_IPS",
} as const;
