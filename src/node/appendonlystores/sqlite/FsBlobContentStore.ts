/**
 * Payloads of a SQLite store kept as one immutable file per content hash,
 * below `<root>/<h0h1>/<h2h3>/<hash>` (see {@link ExternalContentStore}).
 *
 * Large payloads (attachment chunks) stay out of the SQLite file, so a file
 * backup only copies new blobs, and the database file stays small. Every
 * write goes tmp → fsync → rename → directory fsync, so a blob is durable
 * before the SQLite row that references it commits.
 */

import { mkdir, open, readFile, rename, rm, unlink } from "fs/promises";
import * as path from "path";

import type { ExternalContentStore } from "../../../core/appendonlystores/sqlite/SqliteDriver";

/** Payloads of at least this size go to files (smaller ones stay inline in SQLite). */
export const DEFAULT_BLOB_THRESHOLD_BYTES = 64 * 1024;

function assertSafeHash(hash: string): void {
  // Content hashes are hex; anything else must not become a path.
  if (!/^[A-Za-z0-9_-]{4,}$/.test(hash)) {
    throw new Error(`Invalid content hash for blob storage: ${hash}`);
  }
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported on every platform (e.g. Windows); the rename stays atomic.
  }
}

export class FsBlobContentStore implements ExternalContentStore {
  constructor(
    private readonly root: string,
    readonly thresholdBytes: number = DEFAULT_BLOB_THRESHOLD_BYTES,
  ) {}

  pathFor(hash: string): string {
    assertSafeHash(hash);
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const finalPath = this.pathFor(hash);
    const dir = path.dirname(finalPath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, finalPath);
    await syncDirectory(dir);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    try {
      const buffer = await readFile(this.pathFor(hash));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async delete(hash: string): Promise<void> {
    await unlink(this.pathFor(hash)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
