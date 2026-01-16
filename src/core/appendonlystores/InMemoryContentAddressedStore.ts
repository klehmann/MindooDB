import {
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
} from "./types";
import type {
  StoreEntry,
  StoreEntryMetadata,
} from "../types";

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

  constructor(dbId: string) {
    this.dbId = dbId;
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
        console.log(`[InMemoryContentAddressedStore:${this.dbId}] Entry ${entry.id} already exists, skipping`);
        continue;
      }

      // Separate metadata from encrypted data
      const { encryptedData, ...metadata } = entry;
      
      // Store metadata by id
      this.entries.set(entry.id, metadata);

      // Store bytes by contentHash (deduplication happens here)
      if (!this.contentStore.has(entry.contentHash)) {
        this.contentStore.set(entry.contentHash, encryptedData);
        console.log(`[InMemoryContentAddressedStore:${this.dbId}] Stored content for hash ${entry.contentHash.substring(0, 8)}...`);
      } else {
        console.log(`[InMemoryContentAddressedStore:${this.dbId}] Content ${entry.contentHash.substring(0, 8)}... already exists (deduplicated)`);
      }

      // Update document index
      if (!this.docIndex.has(entry.docId)) {
        this.docIndex.set(entry.docId, new Set());
      }
      this.docIndex.get(entry.docId)!.add(entry.id);

      console.log(`[InMemoryContentAddressedStore:${this.dbId}] Stored entry ${entry.id} for doc ${entry.docId}`);
    }
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
          console.warn(`[InMemoryContentAddressedStore:${this.dbId}] Content ${metadata.contentHash} not found for entry ${id}`);
        }
      } else {
        console.warn(`[InMemoryContentAddressedStore:${this.dbId}] Entry ${id} not found`);
      }
    }

    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Retrieved ${result.length} entries out of ${ids.length} requested`);
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
    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Found ${existing.length} existing entries out of ${ids.length} checked`);
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

    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Found ${newEntries.length} new entries out of ${this.entries.size} total`);
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

    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Found ${newEntries.length} new entries for doc ${docId} out of ${docEntryIds.size} total`);
    return newEntries;
  }

  /**
   * Get all entry IDs in the store.
   * Used for synchronization to identify which entries we have.
   *
   * @return A list of all entry IDs in the store
   */
  async getAllIds(): Promise<string[]> {
    const ids = Array.from(this.entries.keys());
    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Returning ${ids.length} entry IDs`);
    return ids;
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

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

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
        console.warn(`[InMemoryContentAddressedStore:${this.dbId}] Entry ${id} not found during dependency resolution`);
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

    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Resolved ${result.length} dependencies for ${startId}`);
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
    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Purging entry history for document: ${docId}`);
    
    // Get all entry IDs for this document
    const docEntryIds = this.docIndex.get(docId);
    
    if (!docEntryIds || docEntryIds.size === 0) {
      console.log(`[InMemoryContentAddressedStore:${this.dbId}] No entries found for document ${docId}, nothing to purge`);
      return;
    }
    
    // Collect contentHashes that might become orphaned
    const contentHashesToCheck = new Set<string>();
    
    // Remove each entry
    for (const id of docEntryIds) {
      const metadata = this.entries.get(id);
      if (metadata) {
        contentHashesToCheck.add(metadata.contentHash);
        this.entries.delete(id);
      }
    }
    
    // Remove document from docIndex
    this.docIndex.delete(docId);
    
    // Clean up orphaned content (no remaining entries reference it)
    for (const contentHash of contentHashesToCheck) {
      let isReferenced = false;
      for (const [, meta] of this.entries) {
        if (meta.contentHash === contentHash) {
          isReferenced = true;
          break;
        }
      }
      if (!isReferenced) {
        this.contentStore.delete(contentHash);
        console.log(`[InMemoryContentAddressedStore:${this.dbId}] Cleaned up orphaned content ${contentHash.substring(0, 8)}...`);
      }
    }
    
    console.log(`[InMemoryContentAddressedStore:${this.dbId}] Purged ${docEntryIds.size} entries for document ${docId}`);
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
}

/**
 * Factory for creating InMemoryContentAddressedStore instances.
 * Each database gets its own isolated in-memory store.
 */
export class InMemoryContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
    // For in-memory stores, we use a single store for both documents and attachments
    // Note: options are ignored for in-memory stores but accepted for interface compatibility
    return {
      docStore: new InMemoryContentAddressedStore(dbId),
      // attachmentStore not provided - will use docStore for attachments
    };
  }
}
