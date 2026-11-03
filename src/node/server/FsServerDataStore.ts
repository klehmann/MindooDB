/**
 * {@link ServerDataStore} on the local file system: every key is a file path
 * below the data directory, so the on-disk layout is the one servers have
 * always used (`server.identity.json`, `<tenantId>/config.json`, …).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, resolve, sep } from "path";

import type { ServerDataStore } from "../../server/ServerDataStore";

export class FsServerDataStore implements ServerDataStore {
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = resolve(dataDir);
  }

  /**
   * Absolute path of `key`. Throws when the key would escape the data
   * directory (tenant ids and file names come from requests).
   */
  resolvePath(key: string): string {
    const target = resolve(this.baseDir, key);
    if (target !== this.baseDir && !target.startsWith(`${this.baseDir}${sep}`)) {
      throw new Error(`Resolved path escapes data directory for key "${key}"`);
    }
    return target;
  }

  exists(key: string): boolean {
    return existsSync(this.resolvePath(key));
  }

  readText(key: string): string | null {
    const path = this.resolvePath(key);
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  writeText(key: string, value: string): void {
    const path = this.resolvePath(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, "utf-8");
  }

  readBytes(key: string): Uint8Array | null {
    const path = this.resolvePath(key);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  writeBytes(key: string, value: Uint8Array): void {
    const path = this.resolvePath(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new DataView(value.buffer, value.byteOffset, value.byteLength));
  }

  listDirectories(prefix: string): string[] {
    const dir = this.resolvePath(prefix);
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir).filter((entry) =>
      statSync(this.resolvePath(prefix ? `${prefix}/${entry}` : entry)).isDirectory(),
    );
  }

  deleteTree(prefix: string): void {
    rmSync(this.resolvePath(prefix), { recursive: true, force: true });
  }
}
