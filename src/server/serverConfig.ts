/**
 * Platform-neutral part of the server config: the `config.json` schema
 * validator and the capability helpers. File access lives in the host
 * (`node/server/config.ts` for Node).
 */

import type {
  RateLimitConfig,
  ServerClusterConfig,
  ServerConfig,
  ServerIrohConfig,
  ServerRateLimitsConfig,
  SystemAdminPrincipal,
  TimestampRateLimitConfig,
} from "./types";
import { isPeerRole } from "./peer/types";

export interface ConfigBackupInfo {
  file: string;
  createdAt: string;
}

const CONFIG_BACKUP_FILENAME_RE =
  /^config\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z)\.json$/;

export function isTenantCreationCapabilityRule(ruleKey: string): boolean {
  const colonIdx = ruleKey.indexOf(":");
  if (colonIdx === -1) {
    return false;
  }

  const method = ruleKey.substring(0, colonIdx).toUpperCase();
  const pathPattern = ruleKey.substring(colonIdx + 1);

  // Segment-exact: tenant creation targets exactly one segment under
  // `/system/tenants/` (the tenant id, which may itself be a `*` pattern). A
  // prefix test would let a wildcard `*` principal be configured on an existing
  // tenant's sub-resource, an over-grant (audit #6).
  return method === "POST" && /^\/system\/tenants\/[^/]+\/?$/.test(pathPattern);
}

export function isWildcardSystemAdminPrincipal(
  principal: SystemAdminPrincipal,
): boolean {
  return principal.username === "*" && principal.publicsignkey === "*";
}

export function hasTenantCreationWildcardPrincipal(config: ServerConfig): boolean {
  return Object.entries(config.capabilities).some(([ruleKey, principals]) =>
    isTenantCreationCapabilityRule(ruleKey) &&
    principals.some((principal) => isWildcardSystemAdminPrincipal(principal)),
  );
}

export function validateServerConfig(raw: unknown, filePath: string): ServerConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.json at ${filePath} must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.capabilities || typeof obj.capabilities !== "object" || Array.isArray(obj.capabilities)) {
    throw new Error(
      `config.json at ${filePath} must have a "capabilities" object`,
    );
  }

  const capabilities: Record<string, SystemAdminPrincipal[]> = {};

  for (const [ruleKey, principals] of Object.entries(
    obj.capabilities as Record<string, unknown>,
  )) {
    validateCapabilityRule(ruleKey, filePath);

    if (!Array.isArray(principals)) {
      throw new Error(
        `config.json: capability rule "${ruleKey}" must map to an array of principals`,
      );
    }

    capabilities[ruleKey] = principals.map((p, i) =>
      validatePrincipal(p, ruleKey, i, filePath),
    );
  }

  const rateLimits = validateRateLimits(obj.rateLimits, filePath);
  const config: ServerConfig = rateLimits ? { capabilities, rateLimits } : { capabilities };

  const cluster = validateCluster(obj.cluster, filePath);
  if (cluster) {
    config.cluster = cluster;
  }

  const iroh = validateIroh(obj.iroh, filePath);
  if (iroh) {
    config.iroh = iroh;
  }

  const principalCount = Object.values(capabilities).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  console.log(
    `[Config] Loaded config.json from ${filePath}: ${Object.keys(capabilities).length} capability rule(s), ${principalCount} principal entry/entries`,
  );

  return config;
}

function validateCluster(raw: unknown, filePath: string): ServerClusterConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.json at ${filePath}: "cluster" must be an object`);
  }

  const obj = raw as Record<string, unknown>;
  const cluster: ServerClusterConfig = {};

  if (obj.autoSync !== undefined) {
    if (typeof obj.autoSync !== "boolean") {
      throw new Error(`config.json at ${filePath}: "cluster.autoSync" must be a boolean`);
    }
    cluster.autoSync = obj.autoSync;
  }
  if (obj.role !== undefined) {
    if (!isPeerRole(obj.role)) {
      throw new Error(
        `config.json at ${filePath}: "cluster.role" must be "peer", "hub" or "spoke"`,
      );
    }
    cluster.role = obj.role;
  }
  return Object.keys(cluster).length > 0 ? cluster : undefined;
}

function validateIroh(raw: unknown, filePath: string): ServerIrohConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.json at ${filePath}: "iroh" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    throw new Error(`config.json at ${filePath}: "iroh.enabled" must be a boolean`);
  }
  if (obj.secretKeyPath !== undefined) {
    if (typeof obj.secretKeyPath !== "string" || !obj.secretKeyPath.trim()) {
      throw new Error(`config.json at ${filePath}: "iroh.secretKeyPath" must be a non-empty string`);
    }
  }
  const iroh: ServerIrohConfig = {
    enabled: obj.enabled === true,
  };
  if (typeof obj.secretKeyPath === "string") {
    iroh.secretKeyPath = obj.secretKeyPath.trim();
  }
  return iroh;
}

function validateRateLimits(
  raw: unknown,
  filePath: string,
): ServerRateLimitsConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.json at ${filePath}: "rateLimits" must be an object`);
  }

  const obj = raw as Record<string, unknown>;
  const auth = validateRateLimitConfig(obj.auth, "auth", filePath);
  const sync = validateRateLimitConfig(obj.sync, "sync", filePath);
  const timestamps = validateTimestampRateLimitConfig(obj.timestamps, filePath);
  const global = validateRateLimitConfig(obj.global, "global", filePath);
  const system = validateRateLimitConfig(obj.system, "system", filePath);

  const rateLimits: ServerRateLimitsConfig = {};
  if (system) {
    rateLimits.system = system;
  }
  if (auth) {
    rateLimits.auth = auth;
  }
  if (sync) {
    rateLimits.sync = sync;
  }
  if (timestamps) {
    rateLimits.timestamps = timestamps;
  }
  if (global) {
    rateLimits.global = global;
  }
  return Object.keys(rateLimits).length > 0 ? rateLimits : {};
}

function validateRateLimitConfig(
  raw: unknown,
  name: string,
  filePath: string,
): RateLimitConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.json at ${filePath}: "rateLimits.${name}" must be an object`);
  }

  const obj = raw as Record<string, unknown>;
  const config: RateLimitConfig = {};

  if (obj.windowMs !== undefined) {
    config.windowMs = validatePositiveInteger(
      obj.windowMs,
      `rateLimits.${name}.windowMs`,
      filePath,
    );
  }
  if (obj.max !== undefined) {
    config.max = validatePositiveInteger(
      obj.max,
      `rateLimits.${name}.max`,
      filePath,
    );
  }

  return Object.keys(config).length > 0 ? config : {};
}

function validateTimestampRateLimitConfig(
  raw: unknown,
  filePath: string,
): TimestampRateLimitConfig | undefined {
  const base = validateRateLimitConfig(raw, "timestamps", filePath);
  if (!base) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const config: TimestampRateLimitConfig = { ...base };
  if (obj.dailyMax !== undefined) {
    config.dailyMax = validatePositiveInteger(
      obj.dailyMax,
      "rateLimits.timestamps.dailyMax",
      filePath,
    );
  }
  return config;
}

function validatePositiveInteger(
  raw: unknown,
  fieldName: string,
  filePath: string,
): number {
  if (!Number.isInteger(raw) || (raw as number) <= 0) {
    throw new Error(
      `config.json at ${filePath}: "${fieldName}" must be a positive integer`,
    );
  }
  return raw as number;
}

/**
 * Validate a capability rule key has the format `METHOD:PATH`.
 */
function validateCapabilityRule(rule: string, filePath: string): void {
  const colonIdx = rule.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(
      `config.json at ${filePath}: invalid capability rule "${rule}" — expected "METHOD:PATH" format`,
    );
  }

  const method = rule.substring(0, colonIdx).toUpperCase();
  const pathPattern = rule.substring(colonIdx + 1);

  const validMethods = ["ALL", "GET", "POST", "PUT", "DELETE", "PATCH"];
  if (!validMethods.includes(method)) {
    throw new Error(
      `config.json at ${filePath}: invalid method "${method}" in rule "${rule}" — expected one of ${validMethods.join(", ")}`,
    );
  }

  if (!pathPattern.startsWith("/")) {
    throw new Error(
      `config.json at ${filePath}: path pattern in rule "${rule}" must start with "/"`,
    );
  }
}

function validatePrincipal(
  raw: unknown,
  ruleKey: string,
  index: number,
  filePath: string,
): SystemAdminPrincipal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `config.json at ${filePath}: principal #${index} in rule "${ruleKey}" must be an object`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.username !== "string" || obj.username.length === 0) {
    throw new Error(
      `config.json at ${filePath}: principal #${index} in rule "${ruleKey}" must have a non-empty "username" string`,
    );
  }

  if (typeof obj.publicsignkey !== "string" || obj.publicsignkey.length === 0) {
    throw new Error(
      `config.json at ${filePath}: principal #${index} in rule "${ruleKey}" must have a non-empty "publicsignkey" string`,
    );
  }

  const hasWildcardField = obj.username === "*" || obj.publicsignkey === "*";
  if (hasWildcardField) {
    if (obj.username !== "*" || obj.publicsignkey !== "*") {
      throw new Error(
        `config.json at ${filePath}: principal #${index} in rule "${ruleKey}" must use "*" for both "username" and "publicsignkey"`,
      );
    }

    if (!isTenantCreationCapabilityRule(ruleKey)) {
      throw new Error(
        `config.json at ${filePath}: wildcard principal "*" is only allowed for POST:/system/tenants/... rules`,
      );
    }
  }

  return {
    username: obj.username,
    publicsignkey: obj.publicsignkey,
  };
}

export function isConfigBackupFilename(fileName: string): boolean {
  return CONFIG_BACKUP_FILENAME_RE.test(fileName);
}

export function parseConfigBackupTimestamp(fileName: string): string | null {
  const match = CONFIG_BACKUP_FILENAME_RE.exec(fileName);
  if (!match) {
    return null;
  }

  return match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d{3})?Z)$/,
    "$1:$2:$3",
  );
}

/**
 * Where a host keeps `config.json` and its backups. `PUT /system/config`
 * goes through this so the handler does not care whether the config is a
 * file (Node) or a stored document (serverless hosts).
 */
export interface ServerConfigRepository {
  listBackups(): ConfigBackupInfo[];
  /** Throws `Config backup not found: <file>` / `Invalid config backup filename: <file>`. */
  loadBackup(backupFile: string): ServerConfig;
  /**
   * Back up the current config (when there is one) and persist `config`.
   * Returns the backup file name, or null when there was nothing to back up.
   */
  replace(config: ServerConfig): string | null;
}

/**
 * Extract all unique system admin principals from the capabilities config.
 * Each principal is identified by (username, publicsignkey).
 */
export function extractAllPrincipals(
  config: ServerConfig,
): SystemAdminPrincipal[] {
  const seen = new Set<string>();
  const result: SystemAdminPrincipal[] = [];

  for (const principals of Object.values(config.capabilities)) {
    for (const p of principals) {
      const key = `${p.username.toLowerCase()}\0${p.publicsignkey}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(p);
      }
    }
  }

  return result;
}
