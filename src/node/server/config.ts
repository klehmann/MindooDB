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

import type { ServerConfig } from "../../server/types";
import {
  isConfigBackupFilename,
  parseConfigBackupTimestamp,
  validateServerConfig,
  type ConfigBackupInfo,
  type ServerConfigRepository,
} from "../../server/serverConfig";

export {
  extractAllPrincipals,
  hasTenantCreationWildcardPrincipal,
  isConfigBackupFilename,
  isTenantCreationCapabilityRule,
  isWildcardSystemAdminPrincipal,
  validateServerConfig,
  type ConfigBackupInfo,
  type ServerConfigRepository,
} from "../../server/serverConfig";

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

export function listConfigBackups(configPath: string): ConfigBackupInfo[] {
  const dir = dirname(configPath);

  return readdirSync(dir)
    .filter((file) => isConfigBackupFilename(file))
    .map((file) => {
      const createdAt = parseConfigBackupTimestamp(file);
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

/** `config.json` on disk next to its timestamped backups. */
export class FileServerConfigRepository implements ServerConfigRepository {
  constructor(private readonly configPath: string) {}

  listBackups(): ConfigBackupInfo[] {
    return listConfigBackups(this.configPath);
  }

  loadBackup(backupFile: string): ServerConfig {
    return loadConfigBackup(this.configPath, backupFile);
  }

  replace(config: ServerConfig): string | null {
    const backupFile = existsSync(this.configPath) ? backupConfig(this.configPath) : null;
    writeConfig(this.configPath, config);
    return backupFile;
  }
}
