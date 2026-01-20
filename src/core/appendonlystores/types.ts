import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../types";

/**
 * Options for opening/creating a database store.
 * Factory implementations can use these to customize store behavior.
 * 
 * This is an open interface that allows any implementation-specific options.
 * Examples of options that implementations might support:
 * - preferLocal: boolean - Prefer local storage over remote
 * - cacheSize: number - Maximum cache size
 * - syncMode: "eager" | "lazy" - Synchronization strategy
 */
export interface OpenStoreOptions {
  [key: string]: unknown;
}

/**
 * Result of creating stores for a database.
 * Contains the document store and an optional separate attachment store.
 */
export interface CreateStoreResult {
  /**
   * The store for document changes (doc_create, doc_change, doc_snapshot, doc_delete).
   * This is required.
   */
  docStore: ContentAddressedStore;
  
  /**
   * Optional separate store for attachment chunks (attachment_chunk).
   * If not provided, attachments are stored in the docStore.
   * Having a separate store enables:
   * - Different storage backends (e.g., local docs, cloud attachments)
   * - Different caching/eviction policies
   * - Cost optimization (cheaper storage for large attachments)
   */
  attachmentStore?: ContentAddressedStore;
}

/**
 * ContentAddressedStoreFactory creates ContentAddressedStore instances for a given database ID.
 * This allows different implementations to provide different storage backends
 * (e.g., in-memory, file-based, database-backed, cloud storage) while maintaining a consistent interface.
 */
export interface ContentAddressedStoreFactory {
  /**
   * Create stores for the given database ID.
   * Returns a document store and optionally a separate attachment store.
   * 
   * @param dbId The ID of the database (e.g., "directory" for the tenant directory database)
   * @param options Optional configuration for store creation (e.g., preferLocal, custom settings)
   * @return An object containing the document store and optional attachment store
   */
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult;
}

/**
 * A ContentAddressedStore is a store that stores signed and optionally encrypted
 * binary entries. Each entry has:
 * - A unique `id` (primary key for lookups)
 * - A `contentHash` (SHA-256 of encrypted data, for deduplication)
 * 
 * The store supports both Automerge document changes and attachment chunks through
 * a unified interface, with storage-level deduplication based on contentHash.
 * 
 * The store is responsible for:
 * - Storing entries with metadata indexed by id
 * - Deduplicating encrypted bytes by contentHash (same content stored once)
 * - Providing methods to retrieve entries by id
 * - Finding new entries for synchronization
 * - Resolving dependency chains (for traversing DAG structures)
 * 
 * The append-only structure makes synchronization easy between peers (client-client,
 * client-server, server-server). Store implementations can optimize storage based on
 * entry type (e.g., inline small doc changes, external storage for large attachment chunks).
 */
export interface ContentAddressedStore {
  /**
   * Get the ID of the store
   *
   * @return The ID of the store
   */
  getId(): string;

  /**
   * Store one or more entries. 
   * - Metadata is stored by entry id (always unique)
   * - Encrypted bytes are deduplicated by contentHash (same bytes stored once)
   *
   * @param entries The entries to store
   * @return A promise that resolves when all entries are stored
   */
  putEntries(entries: StoreEntry[]): Promise<void>;

  /**
   * Get entries by their IDs.
   * Returns only entries that exist in this store.
   *
   * @param ids The IDs of the entries to fetch
   * @return A list of entries (may be shorter than input if some don't exist)
   */
  getEntries(ids: string[]): Promise<StoreEntry[]>;

  /**
   * Check which IDs from the provided list exist in this store.
   *
   * @param ids The IDs to check
   * @return A list of IDs that exist in this store
   */
  hasEntries(ids: string[]): Promise<string[]>;

  /**
   * Find entries in the store that are not listed in the given list of IDs.
   * Used for synchronization to identify which entries we have that the peer doesn't.
   *
   * @param knownIds The list of entry IDs we already have
   * @return A list of entry metadata for entries we have that aren't in knownIds
   */
  findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]>;

  /**
   * Find entries in the store for a specific document that are not listed in the given list of IDs.
   *
   * @param knownIds The list of entry IDs we already have
   * @param docId The ID of the document
   * @return A list of entry metadata for entries we have that aren't in knownIds
   */
  findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]>;

  /**
   * Find entries by type and creation date range.
   * 
   * This method allows efficient filtering of entries at the store level,
   * which is especially important for network stores where server-side filtering
   * reduces data transfer.
   * 
   * @param type The entry type to filter by (e.g., "doc_create", "doc_delete")
   * @param creationDateFrom Optional start timestamp (inclusive). If null, no lower bound.
   * @param creationDateUntil Optional end timestamp (exclusive). If null, no upper bound.
   * @return A list of entry metadata matching the criteria
   */
  findEntries(
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]>;

  /**
   * Get all entry IDs in the store.
   * Used for synchronization to identify which entries we have.
   *
   * @return A list of all entry IDs in the store
   */
  getAllIds(): Promise<string[]>;

  /**
   * Resolve the dependency chain starting from an entry ID.
   * Returns IDs in dependency order, traversing backward through dependencyIds.
   * 
   * This is useful for:
   * - Loading all chunks of an attachment (traverse from last to first chunk)
   * - Finding all changes needed to reconstruct a document state
   * - Stopping at snapshots when loading documents (use options.stopAtEntryType)
   *
   * @param startId The entry ID to start traversal from
   * @param options Optional traversal options:
   *   - stopAtEntryType: Stop when encountering an entry of this type (e.g., "doc_snapshot")
   *   - maxDepth: Maximum number of hops to traverse
   *   - includeStart: Whether to include startId in the result (default: true)
   * @return A list of entry IDs in dependency order (oldest first by default)
   */
  resolveDependencies(
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]>;

  /**
   * Purge all entries for a specific document from the store.
   * This breaks append-only semantics but is required for GDPR compliance
   * (right to be forgotten).
   * 
   * After purging, all entries for the specified document will be removed
   * from the store. Content bytes that are no longer referenced by any
   * entry should also be cleaned up.
   * 
   * @param docId The document ID whose entries should be purged
   * @return A promise that resolves when the purge is complete
   * @throws Error if the store implementation does not support purging
   */
  purgeDocHistory(docId: string): Promise<void>;
}
