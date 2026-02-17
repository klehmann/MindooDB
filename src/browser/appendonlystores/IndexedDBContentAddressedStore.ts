/**
 * IndexedDB-backed ContentAddressedStore for browser environments.
 *
 * Provides persistent, indexed storage using the IndexedDB API. All indexing
 * is delegated to IDB itself (no in-memory maps), keeping memory usage low
 * even for stores with hundreds of thousands of entries.
 *
 * Schema (IDB version 1):
 *   - `entries`     : metadata per entry id, indexed by docId, contentHash,
 *                     (entryType, createdAt), and (createdAt, id)
 *   - `content`     : encrypted payload per contentHash with reference counting
 *   - `bloom_cache` : single cached bloom filter summary, incrementally updated
 *                     on inserts and fully rebuilt on purge or size threshold
 *
 * @module IndexedDBContentAddressedStore
 */

import type {
  ContentAddressedStore,
  StoreIndexBuildStatus,
  AwaitIndexReadyOptions,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  OpenStoreOptions,
} from "../../core/appendonlystores/types";
import type {
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
} from "../../core/types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";

// ---------------------------------------------------------------------------
// IDB Constants
// ---------------------------------------------------------------------------

const IDB_VERSION = 1;
const ENTRIES_STORE = "entries";
const CONTENT_STORE = "content";
const BLOOM_CACHE_STORE = "bloom_cache";

// Index names
const IDX_DOC_ID = "by_docId";
const IDX_ENTRY_TYPE_CREATED_AT = "by_entryType_createdAt";
const IDX_CREATED_AT_ID = "by_createdAt_id";
const IDX_CONTENT_HASH = "by_contentHash";

// Bloom cache key
const BLOOM_CACHE_KEY = "current";

// ---------------------------------------------------------------------------
// Browser-compatible bloom filter helpers (no Buffer dependency)
// ---------------------------------------------------------------------------

const DEFAULT_FALSE_POSITIVE_RATE = 0.01;
const DEFAULT_SALT = "mindoodb-bloom-v1";

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function djb2_32(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function computeBloomShape(
  itemCount: number,
  falsePositiveRate: number
): { bitCount: number; hashCount: number } {
  if (itemCount <= 0) {
    return { bitCount: 64, hashCount: 2 };
  }
  const ln2 = Math.log(2);
  const bitCount = Math.max(
    64,
    Math.ceil((-itemCount * Math.log(falsePositiveRate)) / (ln2 * ln2))
  );
  const hashCount = Math.max(1, Math.round((bitCount / itemCount) * ln2));
  return { bitCount, hashCount };
}

function bloomIndexes(
  id: string,
  bitCount: number,
  hashCount: number,
  salt: string
): number[] {
  const h1 = fnv1a32(`${salt}:${id}`);
  const h2 = djb2_32(`${id}:${salt}`) || 1;
  const indexes: number[] = [];
  for (let i = 0; i < hashCount; i++) {
    indexes.push((h1 + i * h2) % bitCount);
  }
  return indexes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Build a bloom filter summary from a list of entry IDs (browser-compatible).
 * Produces output identical to core bloom.ts but without Node.js Buffer.
 */
function createIdBloomSummaryBrowser(
  ids: string[],
  falsePositiveRate: number = DEFAULT_FALSE_POSITIVE_RATE
): StoreIdBloomSummary {
  const { bitCount, hashCount } = computeBloomShape(
    ids.length,
    falsePositiveRate
  );
  const bitset = new Uint8Array(Math.ceil(bitCount / 8));

  for (const id of ids) {
    const idxs = bloomIndexes(id, bitCount, hashCount, DEFAULT_SALT);
    for (const idx of idxs) {
      const byteIndex = Math.floor(idx / 8);
      const bitOffset = idx % 8;
      bitset[byteIndex] |= 1 << bitOffset;
    }
  }

  return {
    version: "bloom-v1",
    totalIds: ids.length,
    bitCount,
    hashCount,
    salt: DEFAULT_SALT,
    bitsetBase64: uint8ArrayToBase64(bitset),
  };
}

/**
 * Threshold multiplier for bloom filter rebuild.
 * When totalIds exceeds originalSizedFor * BLOOM_REBUILD_FACTOR the filter
 * is rebuilt from scratch to maintain the target false-positive rate.
 */
const BLOOM_REBUILD_FACTOR = 2;

/**
 * Incrementally add new IDs to an existing bloom filter summary.
 *
 * Because bloom filters only ever set bits to 1, adding IDs is safe without
 * a full recompute: decode the bitset, OR in the new bits, re-encode.
 *
 * Returns `null` when the filter should be fully rebuilt instead (totalIds
 * has grown past BLOOM_REBUILD_FACTOR * the size it was originally sized
 * for, meaning the false-positive rate has degraded beyond acceptable).
 */
function incrementalBloomUpdate(
  summary: StoreIdBloomSummary,
  newIds: string[]
): StoreIdBloomSummary | null {
  if (newIds.length === 0) return summary;

  const newTotal = summary.totalIds + newIds.length;

  // Check if the filter was sized for far fewer items than it now holds.
  // originalSizedFor is the item count the current bitCount/hashCount was
  // optimised for.  We back-derive it from the bloom shape formula:
  //   bitCount = -(n * ln(p)) / (ln2)^2  =>  n = -bitCount * (ln2)^2 / ln(p)
  const ln2 = Math.log(2);
  const originalSizedFor = Math.max(
    1,
    Math.floor(
      (-summary.bitCount * ln2 * ln2) /
        Math.log(DEFAULT_FALSE_POSITIVE_RATE)
    )
  );

  if (newTotal > originalSizedFor * BLOOM_REBUILD_FACTOR) {
    // False-positive rate has degraded too far; caller should rebuild.
    return null;
  }

  const bitset = base64ToUint8Array(summary.bitsetBase64);

  for (const id of newIds) {
    const idxs = bloomIndexes(
      id,
      summary.bitCount,
      summary.hashCount,
      summary.salt
    );
    for (const idx of idxs) {
      const byteIndex = Math.floor(idx / 8);
      const bitOffset = idx % 8;
      bitset[byteIndex] |= 1 << bitOffset;
    }
  }

  return {
    ...summary,
    totalIds: newTotal,
    bitsetBase64: uint8ArrayToBase64(bitset),
  };
}

// ---------------------------------------------------------------------------
// IDB helpers
// ---------------------------------------------------------------------------

/** Wrap an IDBRequest in a Promise. */
function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Wrap an IDBTransaction completion in a Promise. */
function txToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * An IndexedDB-backed ContentAddressedStore.
 *
 * Each instance maps to a single IndexedDB database named
 * `mindoodb_<prefix>_<storeId>` where `prefix` comes from `options.basePath`
 * and defaults to `"default"`.
 *
 * Entries are stored in an `entries` object store with IDB indexes that
 * replace the in-memory Map indexes used by the InMemory and OnDisk stores.
 * Encrypted payloads are deduplicated via a `content` object store keyed
 * by `contentHash` with a `refCount` field.
 *
 * A single `bloom_cache` record avoids recomputing the bloom filter on every
 * `getIdBloomSummary()` call.
 */
export class IndexedDBContentAddressedStore implements ContentAddressedStore {
  private readonly storeId: string;
  private readonly idbName: string;
  private readonly logger: Logger;

  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  constructor(storeId: string, logger?: Logger, options?: OpenStoreOptions) {
    this.storeId = storeId;
    this.logger =
      logger ??
      new MindooLogger(
        getDefaultLogLevel(),
        `IndexedDBStore:${storeId}`,
        true
      );

    const prefix = (options?.basePath as string) || "default";
    this.idbName = `mindoodb_${prefix}_${storeId}`;
  }

  // -------------------------------------------------------------------------
  // IDB lifecycle
  // -------------------------------------------------------------------------

  /** Lazily open the IDB database, creating object stores on first access. */
  private ensureOpen(): Promise<IDBDatabase> {
    if (this.db) {
      return Promise.resolve(this.db);
    }
    if (this.openPromise) {
      return this.openPromise;
    }

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.idbName, IDB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // entries store
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          const entriesStore = db.createObjectStore(ENTRIES_STORE, {
            keyPath: "id",
          });
          entriesStore.createIndex(IDX_DOC_ID, "docId", { unique: false });
          entriesStore.createIndex(
            IDX_ENTRY_TYPE_CREATED_AT,
            ["entryType", "createdAt"],
            { unique: false }
          );
          entriesStore.createIndex(IDX_CREATED_AT_ID, ["createdAt", "id"], {
            unique: true,
          });
          entriesStore.createIndex(IDX_CONTENT_HASH, "contentHash", {
            unique: false,
          });
        }

        // content store
        if (!db.objectStoreNames.contains(CONTENT_STORE)) {
          db.createObjectStore(CONTENT_STORE, { keyPath: "contentHash" });
        }

        // bloom cache store
        if (!db.objectStoreNames.contains(BLOOM_CACHE_STORE)) {
          db.createObjectStore(BLOOM_CACHE_STORE, { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.logger.warn(
            "IndexedDB version change detected, closing connection"
          );
          this.db?.close();
          this.db = null;
          this.openPromise = null;
        };
        resolve(this.db);
      };

      request.onerror = () => {
        this.openPromise = null;
        reject(request.error);
      };

      request.onblocked = () => {
        this.logger.warn(
          `IndexedDB open blocked for ${this.idbName} – close other tabs?`
        );
      };
    });

    return this.openPromise;
  }

  // -------------------------------------------------------------------------
  // ContentAddressedStore interface
  // -------------------------------------------------------------------------

  getId(): string {
    return this.storeId;
  }

  async putEntries(entries: StoreEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const db = await this.ensureOpen();
    const tx = db.transaction(
      [ENTRIES_STORE, CONTENT_STORE, BLOOM_CACHE_STORE],
      "readwrite"
    );
    const entriesOS = tx.objectStore(ENTRIES_STORE);
    const contentOS = tx.objectStore(CONTENT_STORE);
    const bloomOS = tx.objectStore(BLOOM_CACHE_STORE);

    const insertedIds: string[] = [];

    for (const entry of entries) {
      // Check if entry already exists (skip duplicate)
      const existing = await reqToPromise(entriesOS.get(entry.id));
      if (existing) {
        this.logger.debug(`Entry ${entry.id} already exists, skipping`);
        continue;
      }

      // Separate metadata from encrypted data
      const { encryptedData, ...metadata } = entry;

      // Store metadata
      await reqToPromise(entriesOS.put(metadata));

      // Deduplicate content
      const existingContent = await reqToPromise(
        contentOS.get(entry.contentHash)
      );
      if (existingContent) {
        existingContent.refCount += 1;
        await reqToPromise(contentOS.put(existingContent));
        this.logger.debug(
          `Content ${entry.contentHash.substring(0, 8)}... already exists (deduplicated)`
        );
      } else {
        await reqToPromise(
          contentOS.put({
            contentHash: entry.contentHash,
            data: encryptedData,
            refCount: 1,
          })
        );
        this.logger.debug(
          `Stored content for hash ${entry.contentHash.substring(0, 8)}...`
        );
      }

      insertedIds.push(entry.id);
      this.logger.debug(`Stored entry ${entry.id} for doc ${entry.docId}`);
    }

    // Incrementally update bloom cache with newly inserted IDs
    if (insertedIds.length > 0) {
      const cached = await reqToPromise(bloomOS.get(BLOOM_CACHE_KEY));

      if (cached && !cached.dirty && cached.summary) {
        // Try incremental update (returns null if rebuild is needed)
        const updated = incrementalBloomUpdate(
          cached.summary as StoreIdBloomSummary,
          insertedIds
        );
        if (updated) {
          await reqToPromise(
            bloomOS.put({
              key: BLOOM_CACHE_KEY,
              summary: updated,
              dirty: false,
            })
          );
          this.logger.debug(
            `Incrementally updated bloom cache (+${insertedIds.length} IDs, total ${updated.totalIds})`
          );
        } else {
          // Filter has grown past rebuild threshold; mark dirty for full recompute
          await reqToPromise(
            bloomOS.put({ key: BLOOM_CACHE_KEY, summary: null, dirty: true })
          );
          this.logger.debug(
            "Bloom cache exceeded rebuild threshold, marked dirty"
          );
        }
      } else {
        // No valid cache exists; mark dirty so next getIdBloomSummary() rebuilds
        await reqToPromise(
          bloomOS.put({ key: BLOOM_CACHE_KEY, summary: null, dirty: true })
        );
      }
    }

    await txToPromise(tx);
  }

  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    if (ids.length === 0) return [];

    const db = await this.ensureOpen();
    const tx = db.transaction([ENTRIES_STORE, CONTENT_STORE], "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);
    const contentOS = tx.objectStore(CONTENT_STORE);

    const result: StoreEntry[] = [];

    for (const id of ids) {
      const metadata = (await reqToPromise(
        entriesOS.get(id)
      )) as StoreEntryMetadata | undefined;
      if (!metadata) {
        this.logger.warn(`Entry ${id} not found`);
        continue;
      }
      const contentRecord = await reqToPromise(
        contentOS.get(metadata.contentHash)
      );
      if (!contentRecord) {
        this.logger.warn(
          `Content ${metadata.contentHash} not found for entry ${id}`
        );
        continue;
      }
      result.push({
        ...metadata,
        encryptedData: new Uint8Array(contentRecord.data),
      });
    }

    this.logger.debug(
      `Retrieved ${result.length} entries out of ${ids.length} requested`
    );
    return result;
  }

  async hasEntries(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);

    const existing: string[] = [];
    for (const id of ids) {
      const key = await reqToPromise(entriesOS.getKey(id));
      if (key !== undefined) {
        existing.push(id);
      }
    }

    this.logger.debug(
      `Found ${existing.length} existing entries out of ${ids.length} checked`
    );
    return existing;
  }

  async findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    const knownSet = new Set(knownIds);
    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);

    const newEntries: StoreEntryMetadata[] = [];

    return new Promise<StoreEntryMetadata[]>((resolve, reject) => {
      const cursorReq = entriesOS.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          this.logger.debug(
            `Found ${newEntries.length} new entries out of total`
          );
          resolve(newEntries);
          return;
        }
        const metadata = cursor.value as StoreEntryMetadata;
        if (!knownSet.has(metadata.id)) {
          newEntries.push(metadata);
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async findNewEntriesForDoc(
    knownIds: string[],
    docId: string
  ): Promise<StoreEntryMetadata[]> {
    const knownSet = new Set(knownIds);
    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);
    const index = entriesOS.index(IDX_DOC_ID);

    const newEntries: StoreEntryMetadata[] = [];

    return new Promise<StoreEntryMetadata[]>((resolve, reject) => {
      const cursorReq = index.openCursor(IDBKeyRange.only(docId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          this.logger.debug(
            `Found ${newEntries.length} new entries for doc ${docId}`
          );
          resolve(newEntries);
          return;
        }
        const metadata = cursor.value as StoreEntryMetadata;
        if (!knownSet.has(metadata.id)) {
          newEntries.push(metadata);
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async findEntries(
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);
    const index = entriesOS.index(IDX_ENTRY_TYPE_CREATED_AT);

    // Build key range on [entryType, createdAt]
    const lower = [type, creationDateFrom ?? -Infinity];
    const upper = [type, creationDateUntil ?? Infinity];
    const range = IDBKeyRange.bound(
      lower,
      upper,
      false, // lowerOpen: inclusive
      creationDateUntil !== null // upperOpen: exclusive when creationDateUntil is set
    );

    const results: StoreEntryMetadata[] = [];

    return new Promise<StoreEntryMetadata[]>((resolve, reject) => {
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          this.logger.debug(
            `Found ${results.length} entries of type ${type} in date range`
          );
          resolve(results);
          return;
        }
        results.push(cursor.value as StoreEntryMetadata);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async getAllIds(): Promise<string[]> {
    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);

    const keys = await reqToPromise(entriesOS.getAllKeys());
    this.logger.debug(`Returning ${keys.length} entry IDs`);
    return keys as string[];
  }

  async scanEntriesSince(
    cursor: StoreScanCursor | null,
    limit: number = Number.MAX_SAFE_INTEGER,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);
    const index = entriesOS.index(IDX_CREATED_AT_ID);

    // Build lower bound from cursor
    let range: IDBKeyRange | null = null;
    if (cursor) {
      range = IDBKeyRange.lowerBound([cursor.createdAt, cursor.id], true);
    }

    const page: StoreEntryMetadata[] = [];

    return new Promise<StoreScanResult>((resolve, reject) => {
      const cursorReq = index.openCursor(range);
      let hasMore = false;

      cursorReq.onsuccess = () => {
        const idbCursor = cursorReq.result;
        if (!idbCursor) {
          const last = page.length > 0 ? page[page.length - 1] : null;
          resolve({
            entries: page,
            nextCursor: last
              ? { createdAt: last.createdAt, id: last.id }
              : cursor,
            hasMore,
          });
          return;
        }

        const meta = idbCursor.value as StoreEntryMetadata;

        if (page.length >= limit) {
          // We already have enough entries. Check if this one matches filters
          // to determine hasMore.
          if (this.matchesScanFilters(meta, filters)) {
            hasMore = true;
          }
          const last = page[page.length - 1];
          resolve({
            entries: page,
            nextCursor: { createdAt: last.createdAt, id: last.id },
            hasMore: true,
          });
          return;
        }

        if (this.matchesScanFilters(meta, filters)) {
          page.push(meta);
        }

        idbCursor.continue();
      };

      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async getIdBloomSummary(): Promise<StoreIdBloomSummary> {
    const db = await this.ensureOpen();

    // Try to read from cache first
    const readTx = db.transaction(BLOOM_CACHE_STORE, "readonly");
    const bloomOS = readTx.objectStore(BLOOM_CACHE_STORE);
    const cached = await reqToPromise(bloomOS.get(BLOOM_CACHE_KEY));

    if (cached && !cached.dirty && cached.summary) {
      this.logger.debug("Returning cached bloom summary");
      return cached.summary as StoreIdBloomSummary;
    }

    // Recompute bloom summary
    this.logger.debug("Recomputing bloom summary");
    const ids = await this.getAllIds();
    const summary = createIdBloomSummaryBrowser(ids);

    // Persist to cache
    const writeTx = db.transaction(BLOOM_CACHE_STORE, "readwrite");
    const writeBloomOS = writeTx.objectStore(BLOOM_CACHE_STORE);
    await reqToPromise(
      writeBloomOS.put({
        key: BLOOM_CACHE_KEY,
        summary,
        dirty: false,
      })
    );
    await txToPromise(writeTx);

    return summary;
  }

  async resolveDependencies(
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    const stopAtEntryType = options?.stopAtEntryType as string | undefined;
    const maxDepth = options?.maxDepth as number | undefined;
    const includeStart = options?.includeStart !== false;

    const db = await this.ensureOpen();
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const entriesOS = tx.objectStore(ENTRIES_STORE);

    const result: string[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: startId, depth: 0 },
    ];
    let queueIdx = 0;

    while (queueIdx < queue.length) {
      const { id, depth } = queue[queueIdx++];

      if (visited.has(id)) continue;
      visited.add(id);

      if (maxDepth !== undefined && depth > maxDepth) continue;

      const entry = (await reqToPromise(
        entriesOS.get(id)
      )) as StoreEntryMetadata | undefined;
      if (!entry) {
        this.logger.warn(
          `Entry ${id} not found during dependency resolution`
        );
        continue;
      }

      if (stopAtEntryType && entry.entryType === stopAtEntryType && id !== startId) {
        result.push(id);
        continue;
      }

      if (id !== startId || includeStart) {
        result.push(id);
      }

      for (const depId of entry.dependencyIds) {
        if (!visited.has(depId)) {
          queue.push({ id: depId, depth: depth + 1 });
        }
      }
    }

    result.reverse();
    this.logger.debug(`Resolved ${result.length} dependencies for ${startId}`);
    return result;
  }

  async purgeDocHistory(docId: string): Promise<void> {
    this.logger.info(`Purging entry history for document: ${docId}`);

    const db = await this.ensureOpen();
    const tx = db.transaction(
      [ENTRIES_STORE, CONTENT_STORE, BLOOM_CACHE_STORE],
      "readwrite"
    );
    const entriesOS = tx.objectStore(ENTRIES_STORE);
    const contentOS = tx.objectStore(CONTENT_STORE);
    const bloomOS = tx.objectStore(BLOOM_CACHE_STORE);
    const docIndex = entriesOS.index(IDX_DOC_ID);

    // Collect all entries for this docId
    const entriesToPurge: StoreEntryMetadata[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursorReq = docIndex.openCursor(IDBKeyRange.only(docId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        entriesToPurge.push(cursor.value as StoreEntryMetadata);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    if (entriesToPurge.length === 0) {
      this.logger.debug(
        `No entries found for document ${docId}, nothing to purge`
      );
      return;
    }

    // Delete entries and decrement content ref counts
    for (const entry of entriesToPurge) {
      await reqToPromise(entriesOS.delete(entry.id));

      const contentRecord = await reqToPromise(
        contentOS.get(entry.contentHash)
      );
      if (contentRecord) {
        const newCount = contentRecord.refCount - 1;
        if (newCount <= 0) {
          await reqToPromise(contentOS.delete(entry.contentHash));
          this.logger.debug(
            `Cleaned up orphaned content ${entry.contentHash.substring(0, 8)}...`
          );
        } else {
          contentRecord.refCount = newCount;
          await reqToPromise(contentOS.put(contentRecord));
        }
      }
    }

    // Invalidate bloom cache
    await reqToPromise(
      bloomOS.put({ key: BLOOM_CACHE_KEY, summary: null, dirty: true })
    );

    await txToPromise(tx);
    this.logger.info(
      `Purged ${entriesToPurge.length} entries for document ${docId}`
    );
  }

  async clearAllLocalData(): Promise<void> {
    this.logger.info(`Clearing all local data for store ${this.storeId}`);

    if (this.db) {
      this.db.close();
      this.db = null;
      this.openPromise = null;
    }

    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.idbName);
      request.onsuccess = () => {
        this.logger.info(`Deleted IndexedDB database ${this.idbName}`);
        resolve();
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        this.logger.warn(
          `IndexedDB delete blocked for ${this.idbName} – close other tabs?`
        );
      };
    });
  }

  async awaitIndexReady(
    _options?: AwaitIndexReadyOptions
  ): Promise<StoreIndexBuildStatus> {
    return {
      phase: "ready",
      indexingEnabled: true,
      progress01: 1,
    };
  }

  getIndexBuildStatus(): StoreIndexBuildStatus {
    return {
      phase: "ready",
      indexingEnabled: true,
      progress01: 1,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private matchesScanFilters(
    meta: StoreEntryMetadata,
    filters?: StoreScanFilters
  ): boolean {
    if (filters?.docId && meta.docId !== filters.docId) {
      return false;
    }
    if (
      filters?.entryTypes &&
      filters.entryTypes.length > 0 &&
      !filters.entryTypes.includes(meta.entryType)
    ) {
      return false;
    }
    if (
      filters?.creationDateFrom !== undefined &&
      filters.creationDateFrom !== null &&
      meta.createdAt < filters.creationDateFrom
    ) {
      return false;
    }
    if (
      filters?.creationDateUntil !== undefined &&
      filters.creationDateUntil !== null &&
      meta.createdAt >= filters.creationDateUntil
    ) {
      return false;
    }
    return true;
  }
}
