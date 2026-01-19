/**
 * Types for the MindooDB Example Server
 */

import type { EncryptedPrivateKey } from "../../../src/core/types";

/**
 * Store type for content-addressed stores.
 * Currently only "inmemory" is implemented; "file" is reserved for future use.
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
 * Configuration for a remote server to sync with.
 */
export interface RemoteServerConfig {
  /** Base URL of the remote server (e.g., "https://eu-west.example.com") */
  url: string;
  /** This server's username on the remote server */
  username: string;
  /** Optional: automatic sync interval in milliseconds */
  syncIntervalMs?: number;
  /** Optional: specific databases to sync (default: all) */
  databases?: string[];
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
  /** Ed25519 public key in PEM format for verifying admin signatures */
  adminSigningPublicKey: string;
  /** RSA-OAEP public key in PEM format for encrypting admin-only data */
  adminEncryptionPublicKey: string;
  
  /** Default store type for new databases (default: "inmemory") */
  defaultStoreType?: StoreType;
  /** Per-database store configuration overrides */
  databaseStores?: Record<string, DatabaseStoreConfig>;
  
  /** Registered users (clients and other servers) */
  users?: UserConfig[];
  
  /** Remote servers to sync with (for server-to-server sync) */
  remoteServers?: RemoteServerConfig[];
}

/**
 * Server keys configuration stored in <dataDir>/<tenantId>/server-keys.json
 * 
 * Contains the server's identity for authenticating with remote servers.
 * The password to decrypt the private keys is NOT stored here - it must
 * be provided via the MINDOODB_SERVER_KEY_PASSWORD environment variable.
 */
export interface ServerKeysConfig {
  /** This server's username identity */
  username: string;
  /** Encrypted Ed25519 private signing key */
  signingPrivateKey: EncryptedPrivateKey;
  /** Ed25519 public signing key in PEM format */
  signingPublicKey: string;
  /** Encrypted RSA-OAEP private encryption key */
  encryptionPrivateKey: EncryptedPrivateKey;
  /** RSA-OAEP public encryption key in PEM format */
  encryptionPublicKey: string;
}

/**
 * Request body for POST /admin/register-tenant
 */
export interface RegisterTenantRequest {
  /** Tenant identifier (lowercase, becomes directory name) */
  tenantId: string;
  /** Ed25519 public key in PEM format */
  adminSigningPublicKey: string;
  /** RSA-OAEP public key in PEM format */
  adminEncryptionPublicKey: string;
  /** Default store type (default: "inmemory") */
  defaultStoreType?: StoreType;
  /** Initial users to register */
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
  /** Server keys (if server-keys.json exists) */
  serverKeys?: ServerKeysConfig;
}

/**
 * Environment variables used by the server.
 */
export const ENV_VARS = {
  /** Password to decrypt server private keys */
  SERVER_KEY_PASSWORD: "MINDOODB_SERVER_KEY_PASSWORD",
  /** Optional API key to protect admin endpoints */
  ADMIN_API_KEY: "MINDOODB_ADMIN_API_KEY",
} as const;
