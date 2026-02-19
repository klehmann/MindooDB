/**
 * A simple mutable key-value store for local cache data.
 *
 * Keys are structured as (type, id) pairs where:
 * - `type` groups related entries (e.g. "db-meta", "doc", "vv")
 * - `id` is caller-defined and may include tenant/store/doc scoping
 *
 * All values are opaque `Uint8Array`. Encryption is handled externally
 * (e.g. by wrapping with {@link EncryptedLocalCacheStore}).
 *
 * One implementation per platform (Node.js filesystem, IndexedDB, MMKV),
 * but the interface is open for custom implementations.
 */
export interface LocalCacheStore {
  /**
   * Retrieve a cached value.
   * @returns The value, or `null` if not found.
   */
  get(type: string, id: string): Promise<Uint8Array | null>;

  /**
   * Store (or overwrite) a cached value.
   */
  put(type: string, id: string, value: Uint8Array): Promise<void>;

  /**
   * Delete a single cached value.
   */
  delete(type: string, id: string): Promise<void>;

  /**
   * List all ids stored under the given type.
   */
  list(type: string): Promise<string[]>;

  /**
   * Wipe all data from the cache store.
   */
  clear(): Promise<void>;
}

/**
 * Trivial in-memory implementation of {@link LocalCacheStore}.
 * Useful for tests and as a reference implementation.
 */
export class InMemoryLocalCacheStore implements LocalCacheStore {
  private data: Map<string, Uint8Array> = new Map();

  private toKey(type: string, id: string): string {
    return `${type}\0${id}`;
  }

  async get(type: string, id: string): Promise<Uint8Array | null> {
    return this.data.get(this.toKey(type, id)) ?? null;
  }

  async put(type: string, id: string, value: Uint8Array): Promise<void> {
    this.data.set(this.toKey(type, id), value);
  }

  async delete(type: string, id: string): Promise<void> {
    this.data.delete(this.toKey(type, id));
  }

  async list(type: string): Promise<string[]> {
    const prefix = `${type}\0`;
    const ids: string[] = [];
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) {
        ids.push(key.slice(prefix.length));
      }
    }
    return ids;
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}
