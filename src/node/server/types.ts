import type { MindooDBServerInfo } from "../../core/types";
import type { PeerSyncDirection, PeerRole, PeerAttachmentMode } from "./peer/types";

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
 *
 * The canonical identity of an entry is its `signingPublicKey`: the server
 * matches and authorizes by key, never by name. `username` is optional and
 * documentation-only (a human-readable label); it is ignored for matching.
 * Arbitrary extra fields (e.g. `comment`) are allowed and ignored by the server.
 */
export interface UserConfig {
  /**
   * Optional, documentation-only label for this key (e.g. "alice" or
   * "server-eu-west"). Ignored for identity matching — the server identifies
   * users by `signingPublicKey`. Kept for backward compatibility with
   * config-based username authentication.
   */
  username?: string;
  /** Ed25519 public key in PEM format for signature verification (the identity). */
  signingPublicKey: string;
  /** RSA-OAEP public key in PEM format for encryption */
  encryptionPublicKey: string;
  /** Optional free-form note describing this entry (ignored by the server). */
  comment?: string;
  /** Arbitrary extra documentation fields are tolerated and ignored. */
  [key: string]: unknown;
}

/**
 * A remote server trusted for server-to-server sync.
 * Stored globally in <dataDir>/trusted-servers.json.
 *
 * Trust and reachability are one entry: the keys authenticate the peer in both
 * directions, and `url` says where to reach it. An entry without `url` stays
 * auth-only — the peer may call us, we never dial it.
 */
export interface TrustedServer extends MindooDBServerInfo {
  /**
   * Base origin of the peer, without a tenant path (e.g.
   * `https://eu-west.example.com`). The replicator appends `/{tenantId}` itself,
   * matching what clients do in `BaseMindooTenant.connectToServer`.
   */
  url?: string;
  /** Which way entries flow. Defaults to `"bidirectional"`. */
  direction?: PeerSyncDirection;
  /** Mesh shape. Defaults to `"peer"`. */
  role?: PeerRole;
  /** How eagerly attachment blobs follow. Defaults to `"eager"`. */
  attachments?: PeerAttachmentMode;
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

/**
 * Timestamp proxying additionally carries a daily cap, because the constrained
 * resource is a third party's allowance rather than this server's CPU.
 */
export interface TimestampRateLimitConfig extends RateLimitConfig {
  dailyMax?: number;
}

export interface ServerRateLimitsConfig {
  auth?: RateLimitConfig;
  sync?: RateLimitConfig;
  timestamps?: TimestampRateLimitConfig;
  /**
   * Per-IP limit for `/system/*`. Defaults to 30/min, which suits occasional
   * CRUD but is tight for a cluster console: `GET /system/cluster/status`
   * polled every few seconds across several nodes will hit it. Raise it on
   * nodes that a monitoring dashboard watches.
   *
   * Does not cover `/system/peer/*`, which is server-to-server traffic with its
   * own, much higher limit.
   */
  system?: RateLimitConfig;
  /**
   * Coarse per-IP net applied to every route ahead of the tier limiters.
   * Defaults to the combined sync and auth budgets plus headroom; setting it
   * below what a tier allows makes it, not the tier, the effective limit.
   */
  global?: RateLimitConfig;
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
  cluster?: ServerClusterConfig;
  /**
   * Join the Iroh network and accept MindooDB sync on ALPN `mindoodb/sync-v5`.
   * Off when omitted. HTTP listen stays unchanged.
   */
  iroh?: ServerIrohConfig;
}

/** Optional Iroh listen settings in config.json. Default is disabled. */
export interface ServerIrohConfig {
  enabled: boolean;
  /**
   * Path to the 32-byte secret key (hex). Relative paths are resolved against
   * the server data directory. Created on first start when missing.
   */
  secretKeyPath?: string;
}

/** Written into new `config.json` files. `--update` does not rewrite existing files. */
export const DEFAULT_SERVER_IROH_CONFIG: ServerIrohConfig = {
  enabled: false,
  secretKeyPath: "iroh-secret.key",
};

/** Node-level cluster settings; per-peer settings live in `trusted-servers.json`. */
export interface ServerClusterConfig {
  /**
   * Start peer replication on boot. Equivalent to the `--auto-sync` CLI flag,
   * which is the more common way to set it.
   */
  autoSync?: boolean;
  /**
   * This node's mesh role. `spoke` means it does not dial other spokes (the hub
   * carries that traffic); `hub` and the default `peer` dial everyone.
   */
  role?: PeerRole;
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
  /**
   * Express `trust proxy` setting: a hop count (`1` behind Cloudflare, `2` when
   * nginx also fronts the origin), a comma-separated list of trusted
   * addresses/CIDRs, `loopback`, or `true`. Unset means no proxy is trusted.
   *
   * Every rate limiter keys on `req.ip`; behind a proxy without this, all
   * clients share the proxy's address and therefore one budget.
   */
  TRUST_PROXY: "MINDOODB_TRUST_PROXY",
  /**
   * When `true`/`1`, peer URLs may use plaintext http and target
   * loopback/private/link-local hosts. Off by default so the server cannot be
   * pointed at internal services (SSRF). Enable only for local development.
   */
  ALLOW_INSECURE_SYNC_URLS: "MINDOODB_ALLOW_INSECURE_SYNC_URLS",
  /**
   * Comma-separated RFC 3161 Time-Stamping Authorities the proxy at
   * `POST /:tenantId/timestamps/rfc3161` may contact. Each entry is a built-in
   * id (`aimoda`, `opentsa`, `freetsa`, ...) or a custom `id=url` pair; suffix
   * `!` marks the provider qualified and `+` marks its root publicly trusted.
   *
   * Example: `aimoda,opentsa,belgium=http://tsa.belgium.be/connect!+`
   *
   * Unset disables the proxy. Clients name a provider by id only — a URL from a
   * client would turn the endpoint into an SSRF gadget.
   */
  TSA_PROVIDERS: "MINDOODB_TSA_PROVIDERS",
} as const;
