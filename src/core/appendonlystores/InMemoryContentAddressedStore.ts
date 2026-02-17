import {
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreIndexBuildStatus,
  AwaitIndexReadyOptions,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
} from "./types";
import { createIdBloomSummary } from "./bloom";
import type {
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
} from "../types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * A simple in-memory implementation of ContentAddressedStore for testing purposes.
 * 
 * Uses dual-index storage:
 * - Metadata indexed by entry id (primary key)
 * - Encrypted bytes indexed by contentHash (for deduplication)
 * 
 * This allows multiple entries to share the same encrypted bytes if they have
 * the same contentHash, enabling storage-level deduplication.
 */
export class InMemoryContentAddressedStore implements ContentAddressedStore {
  private dbId: string;
  
  /** Metadata indexed by entry id */
  private entries: Map<string, StoreEntryMetadata> = new Map();
  
  /** Encrypted bytes indexed by contentHash (deduplicated) */
  private contentStore: Map<string, Uint8Array> = new Map();
  
  /** Index for finding entries by docId (for efficient doc queries) */
  private docIndex: Map<string, Set<string>> = new Map(); // docId -> Set<entryId>
  
  /** Cached sorted entries for efficient cursor-based scanning (invalidated on mutation) */
  private sortedEntriesCache: StoreEntryMetadata[] | null = null;
  
  /** Reference count per contentHash for O(1) orphan detection during purge */
  private contentRefCount: Map<string, number> = new Map();
  
  private logger: Logger;
  private readonly indexingEnabled: boolean;

  constructor(dbId: string, logger?: Logger, options?: OpenStoreOptions) {
    this.dbId = dbId;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `InMemoryStore:${dbId}`, true);
    this.indexingEnabled = options?.indexingEnabled !== false;
  }

  getId(): string {
    return this.dbId;
  }

  /**
   * Store one or more entries.
   * - Metadata is stored by entry id (always unique)
   * - Encrypted bytes are deduplicated by contentHash (same bytes stored once)
   *
   * @param entries The entries to store
   * @return A promise that resolves when all entries are stored
   */
  async putEntries(entries: StoreEntry[]): Promise<void> {
    for (const entry of entries) {
      // Check if we already have this entry by id (no-op if exists)
      if (this.entries.has(entry.id)) {
        this.logger.debug(`Entry ${entry.id} already exists, skipping`);
        continue;
      }

      // Separate metadata from encrypted data
      const { encryptedData, ...metadata } = entry;
      
      // Store metadata by id
      this.entries.set(entry.id, metadata);

      // Store bytes by contentHash (deduplication happens here)
      if (!this.contentStore.has(entry.contentHash)) {
        this.contentStore.set(entry.contentHash, encryptedData);
        this.logger.debug(`Stored content for hash ${entry.contentHash.substring(0, 8)}...`);
      } else {
        this.logger.debug(`Content ${entry.contentHash.substring(0, 8)}... already exists (deduplicated)`);
      }

      // Update document index
      if (!this.docIndex.has(entry.docId)) {
        this.docIndex.set(entry.docId, new Set());
      }
      this.docIndex.get(entry.docId)!.add(entry.id);

      // Update content reference count for efficient orphan cleanup
      this.contentRefCount.set(
        entry.contentHash,
        (this.contentRefCount.get(entry.contentHash) || 0) + 1
      );

      this.logger.debug(`Stored entry ${entry.id} for doc ${entry.docId}`);
    }

    // Invalidate sorted entries cache since new entries were added
    this.sortedEntriesCache = null;
  }

  /**
   * Get entries by their IDs.
   * Returns only entries that exist in this store.
   *
   * @param ids The IDs of the entries to fetch
   * @return A list of entries (may be shorter than input if some don't exist)
   */
  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    const result: StoreEntry[] = [];

    for (const id of ids) {
      const metadata = this.entries.get(id);
      if (metadata) {
        const encryptedData = this.contentStore.get(metadata.contentHash);
        if (encryptedData) {
          result.push({ ...metadata, encryptedData });
        } else {
          this.logger.warn(`Content ${metadata.contentHash} not found for entry ${id}`);
        }
      } else {
        this.logger.warn(`Entry ${id} not found`);
      }
    }

    this.logger.debug(`Retrieved ${result.length} entries out of ${ids.length} requested`);
    return result;
  }

  /**
   * Check which IDs from the provided list exist in this store.
   *
   * @param ids The IDs to check
   * @return A list of IDs that exist in this store
   */
  async hasEntries(ids: string[]): Promise<string[]> {
    const existing: string[] = [];
    for (const id of ids) {
      if (this.entries.has(id)) {
        existing.push(id);
      }
    }
    this.logger.debug(`Found ${existing.length} existing entries out of ${ids.length} checked`);
    return existing;
  }

  /**
   * Find entries in the store that are not listed in the given list of IDs.
   * Used for synchronization to identify which entries we have that the peer doesn't.
   *
   * @param knownIds The list of entry IDs we already have
   * @return A list of entry metadata for entries we have that aren't in knownIds
   */
  async findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    // Create a Set of IDs we already have for fast lookup
    const knownIdsSet = new Set<string>(knownIds);

    // Find all entries we have that are not in the provided list
    const newEntries: StoreEntryMetadata[] = [];
    for (const [id, metadata] of this.entries) {
      if (!knownIdsSet.has(id)) {
        newEntries.push(metadata);
      }
    }

    this.logger.debug(`Found ${newEntries.length} new entries out of ${this.entries.size} total`);
    return newEntries;
  }

  /**
   * Find entries in the store for a specific document that are not listed in the given list of IDs.
   *
   * @param knownIds The list of entry IDs we already have
   * @param docId The ID of the document
   * @return A list of entry metadata for entries we have that aren't in knownIds
   */
  async findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    // Create a Set of IDs we already have for fast lookup
    const knownIdsSet = new Set<string>(knownIds);

    // Get entry IDs for this specific document
    const docEntryIds = this.docIndex.get(docId) || new Set();

    // Find all entries for this doc that are not in the provided list
    const newEntries: StoreEntryMetadata[] = [];
    for (const id of docEntryIds) {
      if (!knownIdsSet.has(id)) {
        const metadata = this.entries.get(id);
        if (metadata) {
          newEntries.push(metadata);
        }
      }
    }

    this.logger.debug(`Found ${newEntries.length} new entries for doc ${docId} out of ${docEntryIds.size} total`);
    return newEntries;
  }

  /**
   * Find entries by type and creation date range.
   */
  async findEntries(
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    const results: StoreEntryMetadata[] = [];
    
    for (const [id, metadata] of this.entries) {
      // Filter by type
      if (metadata.entryType !== type) {
        continue;
      }
      
      // Filter by creation date range
      if (creationDateFrom !== null && metadata.createdAt < creationDateFrom) {
        continue;
      }
      
      if (creationDateUntil !== null && metadata.createdAt >= creationDateUntil) {
        continue;
      }
      
      results.push(metadata);
    }
    
    this.logger.debug(`Found ${results.length} entries of type ${type} in date range`);
    return results;
  }

  /**
   * Get all entry IDs in the store.
   * Used for synchronization to identify which entries we have.
   *
   * @return A list of all entry IDs in the store
   */
  async getAllIds(): Promise<string[]> {
    const ids = Array.from(this.entries.keys());
    this.logger.debug(`Returning ${ids.length} entry IDs`);
    return ids;
  }

  /**
   * Return all entries sorted by (createdAt ASC, id ASC).
   * Result is cached and invalidated on mutation for amortized O(1) access.
   */
  private getSortedEntries(): StoreEntryMetadata[] {
    if (!this.sortedEntriesCache) {
      this.sortedEntriesCache = Array.from(this.entries.values())
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id.localeCompare(b.id)
            : a.createdAt - b.createdAt
        );
    }
    return this.sortedEntriesCache;
  }

  /**
   * Binary search for the index of the first entry strictly after `cursor`
   * in the sorted (createdAt, id) order.
   * Returns sorted.length when no entry comes after the cursor.
   */
  private binarySearchAfterCursor(
    sorted: StoreEntryMetadata[],
    cursor: StoreScanCursor
  ): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = sorted[mid];
      if (
        m.createdAt < cursor.createdAt ||
        (m.createdAt === cursor.createdAt && m.id <= cursor.id)
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Test whether an entry passes the given scan filters. */
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

  /**
   * Cursor-based metadata scan for high-volume synchronization.
   * Ordering: createdAt ASC, id ASC.
   *
   * Uses a cached sorted index with binary search for O(log n) cursor
   * lookup instead of re-sorting all entries on every call.
   */
  async scanEntriesSince(
    cursor: StoreScanCursor | null,
    limit: number = Number.MAX_SAFE_INTEGER,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    const sorted = this.getSortedEntries();
    const startIdx =
      cursor === null
        ? 0
        : this.binarySearchAfterCursor(sorted, cursor);

    // Single forward pass: collect up to `limit` matching entries
    const page: StoreEntryMetadata[] = [];
    let i = startIdx;
    for (; i < sorted.length && page.length < limit; i++) {
      if (this.matchesScanFilters(sorted[i], filters)) {
        page.push(sorted[i]);
      }
    }

    // Probe for one more matching entry to determine hasMore
    let hasMore = false;
    for (; i < sorted.length; i++) {
      if (this.matchesScanFilters(sorted[i], filters)) {
        hasMore = true;
        break;
      }
    }

    const last = page.length > 0 ? page[page.length - 1] : null;
    return {
      entries: page,
      nextCursor: last
        ? { createdAt: last.createdAt, id: last.id }
        : cursor,
      hasMore,
    };
  }

  async getIdBloomSummary(): Promise<StoreIdBloomSummary> {
    const ids = await this.getAllIds();
    return createIdBloomSummary(ids);
  }

  /**
   * Resolve the dependency chain starting from an entry ID.
   * Returns IDs in dependency order (oldest first), traversing backward through dependencyIds.
   *
   * @param startId The entry ID to start traversal from
   * @param options Optional traversal options:
   *   - stopAtEntryType: Stop when encountering an entry of this type (e.g., "doc_snapshot")
   *   - maxDepth: Maximum number of hops to traverse
   *   - includeStart: Whether to include startId in the result (default: true)
   * @return A list of entry IDs in dependency order (oldest first)
   */
  async resolveDependencies(
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    const stopAtEntryType = options?.stopAtEntryType as string | undefined;
    const maxDepth = options?.maxDepth as number | undefined;
    const includeStart = options?.includeStart !== false; // default: true

    const result: string[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    let queueIdx = 0;

    while (queueIdx < queue.length) {
      const { id, depth } = queue[queueIdx++];

      // Skip if already visited
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);

      // Check max depth
      if (maxDepth !== undefined && depth > maxDepth) {
        continue;
      }

      // Get the entry metadata
      const entry = this.entries.get(id);
      if (!entry) {
        this.logger.warn(`Entry ${id} not found during dependency resolution`);
        continue;
      }

      // Check stop condition
      if (stopAtEntryType && entry.entryType === stopAtEntryType && id !== startId) {
        // Include the stop entry but don't traverse its dependencies
        result.push(id);
        continue;
      }

      // Add to result (unless it's the start ID and includeStart is false)
      if (id !== startId || includeStart) {
        result.push(id);
      }

      // Queue dependencies for traversal
      for (const depId of entry.dependencyIds) {
        if (!visited.has(depId)) {
          queue.push({ id: depId, depth: depth + 1 });
        }
      }
    }

    // Reverse to get oldest first (we traversed from newest to oldest)
    result.reverse();

    this.logger.debug(`Resolved ${result.length} dependencies for ${startId}`);
    return result;
  }

  /**
   * Purge all entries for a specific document from the store.
   * This breaks append-only semantics but is required for GDPR compliance.
   * 
   * After purging, all entries for the specified document will be removed
   * from the store. Content bytes that are no longer referenced by any
   * entry will also be cleaned up.
   * 
   * @param docId The document ID whose entries should be purged
   * @return A promise that resolves when the purge is complete
   */
  async purgeDocHistory(docId: string): Promise<void> {
    this.logger.info(`Purging entry history for document: ${docId}`);
    
    // Get all entry IDs for this document
    const docEntryIds = this.docIndex.get(docId);
    
    if (!docEntryIds || docEntryIds.size === 0) {
      this.logger.debug(`No entries found for document ${docId}, nothing to purge`);
      return;
    }
    
    // Remove each entry and decrement content reference counts
    for (const id of docEntryIds) {
      const metadata = this.entries.get(id);
      if (metadata) {
        // Decrement ref count; clean up content when no longer referenced
        const newCount =
          (this.contentRefCount.get(metadata.contentHash) || 1) - 1;
        if (newCount <= 0) {
          this.contentStore.delete(metadata.contentHash);
          this.contentRefCount.delete(metadata.contentHash);
          this.logger.debug(
            `Cleaned up orphaned content ${metadata.contentHash.substring(0, 8)}...`
          );
        } else {
          this.contentRefCount.set(metadata.contentHash, newCount);
        }
        this.entries.delete(id);
      }
    }
    
    // Remove document from docIndex
    this.docIndex.delete(docId);
    
    // Invalidate sorted entries cache
    this.sortedEntriesCache = null;
    
    this.logger.info(`Purged ${docEntryIds.size} entries for document ${docId}`);
  }
  
  /**
   * Get storage statistics for debugging/monitoring.
   * @returns Object with entry count, content count, and doc count
   */
  getStats(): { entryCount: number; contentCount: number; docCount: number } {
    return {
      entryCount: this.entries.size,
      contentCount: this.contentStore.size,
      docCount: this.docIndex.size,
    };
  }

  /**
   * Clear all local in-memory data.
   * Useful for test setups that need deterministic clean state behavior.
   */
  async clearAllLocalData(): Promise<void> {
    this.entries.clear();
    this.contentStore.clear();
    this.docIndex.clear();
    this.contentRefCount.clear();
    this.sortedEntriesCache = null;
  }

  /**
   * In-memory stores are always ready immediately.
   */
  async awaitIndexReady(_options?: AwaitIndexReadyOptions): Promise<StoreIndexBuildStatus> {
    return {
      phase: "ready",
      indexingEnabled: this.indexingEnabled,
      progress01: 1,
    };
  }

  /**
   * In-memory stores are always ready immediately.
   */
  getIndexBuildStatus(): StoreIndexBuildStatus {
    return {
      phase: "ready",
      indexingEnabled: this.indexingEnabled,
      progress01: 1,
    };
  }
}

/**
 * Factory for creating InMemoryContentAddressedStore instances.
 * Each database gets its own isolated in-memory store.
 */
export class InMemoryContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    // For in-memory stores, we use a single store for both documents and attachments
    // Note: options are ignored for in-memory stores but accepted for interface compatibility
    const store = new InMemoryContentAddressedStore(dbId, undefined, options);
    if (options?.clearLocalDataOnStartup) {
      // Initialize in a deterministic clean state for parity with persistent stores.
      void store.clearAllLocalData();
    }
    return {
      docStore: store,
      // attachmentStore not provided - will use docStore for attachments
    };
  }
}
