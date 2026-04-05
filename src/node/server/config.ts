/**
 * Server config loader and validator.
 *
 * Loads `config.json` at server startup. The file defines capabilities-based
 * authorization for system admin endpoints.
 */

import {
  existsSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { join, dirname, basename } from "path";

import type { ServerConfig, SystemAdminPrincipal } from "./types";

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

  return method === "POST" && pathPattern.startsWith("/system/tenants/");
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

/**
 * Resolve the config file path from CLI argument or data directory fallback.
 */
export function resolveConfigPath(
  dataDir: string,
  explicitConfigPath?: string,
): string {
  return explicitConfigPath ?? join(dataDir, "config.json");
}

/**
 * Load and validate the server config.
 *
 * Resolution order:
 * 1. Explicit `--config <path>` CLI argument.
 * 2. `<dataDir>/config.json` (default fallback).
 *
 * If neither file exists, an empty config with no capabilities is returned
 * (all `/system/*` requests will be denied).
 */
export function loadServerConfig(
  dataDir: string,
  explicitConfigPath?: string,
): ServerConfig {
  const configPath = resolveConfigPath(dataDir, explicitConfigPath);

  if (!existsSync(configPath)) {
    console.log(
      `[Config] No config.json found at ${configPath} — all /system/* endpoints are locked down`,
    );
    return { capabilities: {} };
  }

  const raw = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config.json at ${configPath}: ${err}`);
  }

  return validateServerConfig(parsed, configPath);
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

  const config: ServerConfig = { capabilities };

  const principalCount = Object.values(capabilities).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  console.log(
    `[Config] Loaded config.json from ${filePath}: ${Object.keys(capabilities).length} capability rule(s), ${principalCount} principal entry/entries`,
  );

  return config;
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

/**
 * Create a timestamped backup of the current config.json.
 * Returns the backup filename (not full path).
 *
 * Backup naming: `config.<ISO-timestamp>.json` with colons replaced by
 * hyphens for filesystem compatibility.
 */
export function backupConfig(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const dir = dirname(configPath);
  const backupName = `config.${timestamp}.json`;
  const backupPath = join(dir, backupName);

  copyFileSync(configPath, backupPath);
  console.log(`[Config] Backup created: ${backupName}`);
  return backupName;
}

/**
 * Persist a ServerConfig to disk as formatted JSON.
 */
export function writeConfig(configPath: string, config: ServerConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  console.log(`[Config] Config written to ${configPath}`);
}

export function isConfigBackupFilename(fileName: string): boolean {
  return CONFIG_BACKUP_FILENAME_RE.test(fileName);
}

function parseBackupTimestamp(fileName: string): string | null {
  const match = CONFIG_BACKUP_FILENAME_RE.exec(fileName);
  if (!match) {
    return null;
  }

  return match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d{3})?Z)$/,
    "$1:$2:$3",
  );
}

export function listConfigBackups(configPath: string): ConfigBackupInfo[] {
  const dir = dirname(configPath);

  return readdirSync(dir)
    .filter((file) => isConfigBackupFilename(file))
    .map((file) => {
      const createdAt = parseBackupTimestamp(file);
      if (!createdAt) {
        throw new Error(`Invalid config backup filename: ${file}`);
      }
      return { file, createdAt };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function loadConfigBackup(configPath: string, backupFile: string): ServerConfig {
  if (!isConfigBackupFilename(backupFile)) {
    throw new Error(`Invalid config backup filename: ${backupFile}`);
  }

  const backupPath = join(dirname(configPath), backupFile);
  if (!existsSync(backupPath)) {
    throw new Error(`Config backup not found: ${backupFile}`);
  }

  const raw = readFileSync(backupPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config backup ${backupFile}: ${err}`);
  }

  return validateServerConfig(parsed, backupPath);
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
