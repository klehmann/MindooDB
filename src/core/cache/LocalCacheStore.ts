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
   * Batch-retrieve cached values.
   *
   * Implementations should amortize per-key overhead (e.g. open a single
   * IndexedDB transaction for all reads) so that callers loading many
   * documents at once pay one transaction cost instead of N.
   *
   * **Memory note for callers:** every value in the returned array is
   * resident in memory at the same time, and any wrapping
   * {@link EncryptedLocalCacheStore} will additionally hold the
   * decrypted plaintext buffers in memory in parallel during
   * {@link EncryptedLocalCacheStore.getMany}. Callers that load many
   * large entries at once (e.g. a startup cache restore) should chunk
   * `ids` into batches sized to bound the transient peak (rule of
   * thumb: `chunkSize * avgEntryBytes * 2` bytes per batch). The
   * production restore path in `BaseMindooDB` already chunks via
   * `DocumentCacheConfig.restoreBatchSize` (default 256).
   *
   * @param type Cache record type (same semantics as {@link get}).
   * @param ids  Ids to fetch, in order.
   * @returns    Array of values aligned positionally with `ids`. Missing
   *             entries are returned as `null` at their respective index.
   *             Implementations MUST NOT reorder, deduplicate or drop entries.
   */
  getMany(type: string, ids: string[]): Promise<Array<Uint8Array | null>>;

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
 * Default {@link LocalCacheStore.getMany} implementation suitable for
 * stores that have no batch API of their own. Issues `get` in parallel
 * via `Promise.all`. Custom implementations should override this whenever
 * they can do better (e.g. by keeping all reads inside a single
 * transaction).
 */
export function defaultGetMany(
  store: Pick<LocalCacheStore, "get">,
  type: string,
  ids: string[],
): Promise<Array<Uint8Array | null>> {
  if (ids.length === 0) return Promise.resolve([]);
  return Promise.all(ids.map((id) => store.get(type, id)));
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

  async getMany(type: string, ids: string[]): Promise<Array<Uint8Array | null>> {
    return ids.map((id) => this.data.get(this.toKey(type, id)) ?? null);
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
