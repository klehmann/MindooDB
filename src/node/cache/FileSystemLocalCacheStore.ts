import { mkdir, readdir, readFile, rename, unlink, open, rm } from "fs/promises";
import * as path from "path";
import type { LocalCacheStore } from "../../core/cache/LocalCacheStore";

function tempPathFor(finalPath: string): string {
  return `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Encode a (type, id) pair into a filename-safe path.
 *
 * Layout: `<basePath>/<type>/<encoded-id>.bin`
 *
 * The id is percent-encoded so that slashes and special chars are safe.
 */
function keyToPath(basePath: string, type: string, id: string): string {
  const safeId = encodeURIComponent(id);
  return path.join(basePath, type, `${safeId}.bin`);
}

function pathToId(filename: string): string {
  return decodeURIComponent(filename.replace(/\.bin$/, ""));
}

/**
 * Node.js filesystem-backed {@link LocalCacheStore}.
 *
 * Each (type, id) entry becomes a file at `<basePath>/<type>/<encoded-id>.bin`.
 * Writes use atomic temp-file + rename for crash safety.
 */
export class FileSystemLocalCacheStore implements LocalCacheStore {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async get(type: string, id: string): Promise<Uint8Array | null> {
    const filePath = keyToPath(this.basePath, type, id);
    try {
      const data = await readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async put(type: string, id: string, value: Uint8Array): Promise<void> {
    const filePath = keyToPath(this.basePath, type, id);
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = tempPathFor(filePath);
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  }

  async delete(type: string, id: string): Promise<void> {
    const filePath = keyToPath(this.basePath, type, id);
    try {
      await unlink(filePath);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  async list(type: string): Promise<string[]> {
    const dir = path.join(this.basePath, type);
    try {
      const files = await readdir(dir);
      return files
        .filter(f => f.endsWith(".bin"))
        .map(pathToId);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.basePath, { recursive: true, force: true });
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
