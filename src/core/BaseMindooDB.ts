// Import platform-appropriate Automerge implementation
// React Native: native Rust (react-native-automerge-generated)
// Browser/Node.js: WASM (@automerge/automerge/slim)
import { Automerge } from "./automerge-adapter";
// Import types from WASM package (types are compatible across implementations)
import type * as AutomergeTypes from "@automerge/automerge/slim";
import { v7 as uuidv7 } from "uuid";
import {
  MindooDB,
  DocumentDagAnalysisTimestamp,
  DocumentDagAnalysisResult,
  DocumentDagBranchMaterializationResult,
  DocumentDagDecodedChangeSummary,
  DocumentDagEntryDetails,
  MindooDoc,
  MindooDocPayload,
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
  MindooTenant,
  ProcessChangesCursor,
  ProcessChangesResult,
  DocumentHistoryResult,
  AttachmentReference,
  AttachmentConfig,
  DocumentCacheConfig,
  SnapshotConfig,
  SigningKeyPair,
  EncryptedPrivateKey,
  PerformanceCallback,
  ProcessChangeSummaryResult,
  SyncOptions,
  SyncResult,
  DocumentHistoryPageEntry,
  DocumentHistoryPageOptions,
  DocumentHistoryPageResult,
} from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";
import {
  StoreKind,
} from "./appendonlystores/types";
import type {
  ContentAddressedStore,
  StoreScanCursor,
  StoreScanFilters,
  StoreIdBloomSummary,
} from "./appendonlystores/types";
import { bloomMightContainId } from "./appendonlystores/bloom";
import {
  computeDocumentMaterializationPlan,
  topologicalByDependencies,
} from "./appendonlystores/MaterializationPlanner";
import {
  computeBranchMaterializationPlan,
  computeDocumentDagAnalysis,
  isDagEntry,
} from "./DocumentDagAnalysis";
import { planAttachmentReadByWalkingMetadata } from "./appendonlystores/AttachmentReadPlanner";
import { 
  generateDocEntryId, 
  computeContentHash, 
  parseDocEntryId,
  generateAttachmentChunkId,
  generateFileUuid7,
} from "./utils/idGeneration";
import { SymmetricKeyNotFoundError } from "./errors";
import { Logger, MindooLogger, getDefaultLogLevel } from "./logging";
import type { LocalCacheStore } from "./cache/LocalCacheStore";
import type { ICacheable } from "./cache/CacheManager";
import type { CacheManager } from "./cache/CacheManager";

/**
 * Default chunk size for attachments: 256KB
 */
const DEFAULT_CHUNK_SIZE_BYTES = 256 * 1024;
const DEFAULT_ATTACHMENT_STREAM_BATCH_SIZE = 4;
const DEFAULT_SNAPSHOT_MIN_CHANGES = 100;
const DEFAULT_SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHED_DOCS = 128;
const DEFAULT_ITERATE_PREFETCH_WINDOW_DOCS = 0;

/**
 * Internal representation of a document with its Automerge state
 */
interface InternalDoc {
  id: string;
  doc: AutomergeTypes.Doc<MindooDocPayload>;
  createdAt: number;
  lastModified: number;
  decryptionKeyId: string;
  isDeleted: boolean;
}

/**
 * BaseMindooDB is a platform-agnostic implementation of MindooDB
 * that works in both browser and server environments.
 * 
 * It receives MindooTenant and ContentAddressedStore in the constructor,
 * allowing platform-specific implementations of those interfaces.
 * 
 * Dependencies:
 * - @automerge/automerge: For CRDT document management
 * - Web Crypto API: Available in both browser (window.crypto) and Node.js (crypto)
 *   - Ed25519 signing/verification (Node.js 15+, Chrome 92+)
 *   - AES-256-GCM encryption (widely supported)
 * 
 * TODO: Verify Automerge 2.x API methods:
 * - Automerge.getChangeHash(change) - verify method name
 * - Automerge.getHeads(doc) - verify method name  
 * - Automerge.load(bytes) - verify method name for snapshots
 * - Automerge.applyChanges(doc, changes) - verify method signature
 */
export class BaseMindooDB implements MindooDB {
  private tenant: BaseMindooTenant;
  private store: ContentAddressedStore;
  private attachmentStore: ContentAddressedStore;
  private chunkSizeBytes: number;
  
  // Admin-only mode: only entries signed by the admin key are loaded
  private _isAdminOnlyDb: boolean;
  
  // Internal changefeed index: sorted by (changeSeq, docId) for deterministic iteration.
  // lastModified remains available for UX metadata but is not the primary cursor key.
  private index: Array<{ docId: string; changeSeq: number; lastModified: number; isDeleted: boolean }> = [];
  
  // Lookup map for O(1) access to index entries by docId
  private indexLookup: Map<string, number> = new Map(); // Map<docId, arrayIndex>
  private nextChangeSeq: number = 1;
  
  // Cache of loaded documents: Map<docId, InternalDoc>
  private docCache: Map<string, InternalDoc> = new Map();
  private readonly maxCachedDocs: number;
  private readonly iteratePrefetchWindowDocs: number;
  private readonly cacheRestoreLimit: number;
  private readonly reconcileRestoredIndexOnInit: boolean;
  private readonly snapshotMinChanges: number;
  private readonly snapshotCooldownMs: number;
  
  // Track which entry IDs we've already processed
  private processedEntryIds: string[] = [];
  private processedEntryCursor: StoreScanCursor | null = null;
  
  // Index: automergeHash -> entryId for each document
  // Used for resolving Automerge dependency hashes to entry IDs
  private automergeHashToEntryId: Map<string, Map<string, string>> = new Map(); // Map<docId, Map<automergeHash, entryId>>
  private logger: Logger;
  private performanceCallback?: PerformanceCallback;
  
  // Cache for imported public keys (CryptoKey objects) to avoid re-importing the same key
  // Map<publicKeyPEM, CryptoKey>
  private publicKeyCache: Map<string, CryptoKey> = new Map();

  // Local cache support
  private cacheManager: CacheManager | null = null;
  private cachePrefix: string | null = null;
  private dirtyDocIds: Set<string> = new Set();
  private cacheMetaDirty: boolean = false;

  constructor(
    tenant: BaseMindooTenant, 
    store: ContentAddressedStore, 
    attachmentStore: ContentAddressedStore,
    attachmentConfig?: AttachmentConfig,
    documentCacheConfig?: DocumentCacheConfig,
    snapshotConfig?: SnapshotConfig,
    adminOnlyDb: boolean = false,
    logger?: Logger,
    performanceCallback?: PerformanceCallback
  ) {
    if (store.getStoreKind() !== StoreKind.docs) {
      throw new Error(
        `[BaseMindooDB] Expected primary store kind ${StoreKind.docs} but received ${store.getStoreKind()}`
      );
    }
    if (attachmentStore.getStoreKind() !== StoreKind.attachments) {
      throw new Error(
        `[BaseMindooDB] Expected attachment store kind ${StoreKind.attachments} but received ${attachmentStore.getStoreKind()}`
      );
    }
    this.tenant = tenant;
    this.store = store;
    this.attachmentStore = attachmentStore;
    this.chunkSizeBytes = attachmentConfig?.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    this._isAdminOnlyDb = adminOnlyDb;
    this.maxCachedDocs = Math.max(
      1,
      Math.floor(documentCacheConfig?.maxEntries ?? DEFAULT_MAX_CACHED_DOCS)
    );
    this.iteratePrefetchWindowDocs = Math.max(
      0,
      Math.floor(
        documentCacheConfig?.iteratePrefetchWindowDocs ??
          DEFAULT_ITERATE_PREFETCH_WINDOW_DOCS
      )
    );
    this.cacheRestoreLimit = Math.max(
      1,
      Math.floor(documentCacheConfig?.restoreLimit ?? this.maxCachedDocs)
    );
    this.reconcileRestoredIndexOnInit = documentCacheConfig?.reconcileRestoredIndexOnInit ?? false;
    this.snapshotMinChanges = Math.max(
      1,
      Math.floor(snapshotConfig?.minChanges ?? DEFAULT_SNAPSHOT_MIN_CHANGES)
    );
    this.snapshotCooldownMs = Math.max(
      0,
      Math.floor(snapshotConfig?.cooldownMs ?? DEFAULT_SNAPSHOT_COOLDOWN_MS)
    );
    // Create logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "BaseMindooDB", true);
    this.performanceCallback = performanceCallback;
  }
  
  /**
   * Get the admin public key from the tenant.
   * Only used when adminOnlyDb is true.
   */
  private getAdminPublicKey(): string {
    return this.tenant.getAdministrationPublicKey();
  }
  
  isAdminOnlyDb(): boolean {
    return this._isAdminOnlyDb;
  }

  // ---------------------------------------------------------------------------
  // Local cache support (ICacheable)
  // ---------------------------------------------------------------------------

  /**
   * Attach a CacheManager so this DB participates in periodic cache flushing.
   */
  setCacheManager(cacheManager: CacheManager): void {
    this.cacheManager = cacheManager;
    const cacheIdentity = this.store.getCacheIdentity?.() ?? this.store.getId();
    this.cachePrefix = `${this.tenant.getId()}/${cacheIdentity}`;
    cacheManager.register(this as unknown as ICacheable);
  }

  getCachePrefix(): string {
    return this.cachePrefix ?? `${this.tenant.getId()}/${this.store.getId()}`;
  }

  hasDirtyState(): boolean {
    return this.dirtyDocIds.size > 0 || this.cacheMetaDirty;
  }

  clearDirty(): void {
    this.dirtyDocIds.clear();
    this.cacheMetaDirty = false;
    this.evictCachedDocsIfNeeded();
  }

  private markDocDirty(docId: string): void {
    this.dirtyDocIds.add(docId);
    this.cacheMetaDirty = true;
    this.cacheManager?.markDirty();
  }

  private getCachedDocument(docId: string): InternalDoc | null {
    const cached = this.docCache.get(docId) ?? null;
    if (!cached) {
      return null;
    }
    this.touchCachedDocument(docId, cached);
    return cached;
  }

  private touchCachedDocument(docId: string, internalDoc: InternalDoc): void {
    this.docCache.delete(docId);
    this.docCache.set(docId, internalDoc);
  }

  private storeCachedDocument(internalDoc: InternalDoc): void {
    this.touchCachedDocument(internalDoc.id, internalDoc);
    this.evictCachedDocsIfNeeded(new Set([internalDoc.id]));
  }

  private evictCachedDocsIfNeeded(protectedDocIds?: Set<string>): void {
    if (this.docCache.size <= this.maxCachedDocs) {
      return;
    }

    for (const [docId] of this.docCache) {
      if (this.docCache.size <= this.maxCachedDocs) {
        break;
      }
      if (protectedDocIds?.has(docId)) {
        continue;
      }
      this.docCache.delete(docId);
      this.dirtyDocIds.delete(docId);
    }
  }

  /**
   * Flush dirty documents and metadata to the cache store.
   */
  async flushToCache(store: LocalCacheStore): Promise<number> {
    const prefix = this.getCachePrefix();
    let written = 0;

    for (const docId of this.dirtyDocIds) {
      const internal = this.docCache.get(docId);
      if (!internal) continue;

      const amBinary = Automerge.save(internal.doc);
      const header = JSON.stringify({
        id: internal.id,
        createdAt: internal.createdAt,
        lastModified: internal.lastModified,
        decryptionKeyId: internal.decryptionKeyId,
        isDeleted: internal.isDeleted,
      });
      const headerBytes = new TextEncoder().encode(header);

      // Format: 4-byte header length (big-endian) + header JSON + Automerge binary
      const value = new Uint8Array(4 + headerBytes.length + amBinary.length);
      const view = new DataView(value.buffer);
      view.setUint32(0, headerBytes.length, false);
      value.set(headerBytes, 4);
      value.set(amBinary, 4 + headerBytes.length);

      await store.put("doc", `${prefix}/${docId}`, value);
      written++;
    }

    // Write metadata checkpoint
    const meta = this.exportMetadataCheckpoint();
    await store.put("db-meta", prefix, meta);
    written++;

    return written;
  }

  private exportMetadataCheckpoint(): Uint8Array {
    const checkpoint: Record<string, unknown> = {
      version: 2,
      processedEntryCursor: this.processedEntryCursor,
      index: this.index,
      nextChangeSeq: this.nextChangeSeq,
    };

    // Serialize automergeHashToEntryId: Map<string, Map<string,string>> -> nested object
    const hashMap: Record<string, Record<string, string>> = {};
    for (const [docId, inner] of this.automergeHashToEntryId) {
      hashMap[docId] = Object.fromEntries(inner);
    }
    checkpoint.automergeHashToEntryId = hashMap;

    // For stores without cursor scan, include processedEntryIds
    if (!this.supportsCursorScan(this.store)) {
      checkpoint.processedEntryIds = this.processedEntryIds;
    }

    return new TextEncoder().encode(JSON.stringify(checkpoint));
  }

  /**
   * Attempt to restore state from cache. Returns true on success.
   */
  async restoreFromCache(store: LocalCacheStore): Promise<boolean> {
    const prefix = this.getCachePrefix();

    try {
      // 1. Load metadata checkpoint
      const metaBytes = await store.get("db-meta", prefix);
      if (!metaBytes) {
        this.logger.debug("No cache metadata found, will do full rebuild");
        return false;
      }

      const checkpoint = JSON.parse(new TextDecoder().decode(metaBytes));
      if (checkpoint.version !== 2) {
        this.logger.warn(`Unknown cache version ${checkpoint.version}, ignoring cache`);
        return false;
      }

      // 2. Restore metadata
      this.processedEntryCursor = checkpoint.processedEntryCursor ?? null;
      this.index = checkpoint.index ?? [];
      this.nextChangeSeq = checkpoint.nextChangeSeq ?? 1;
      if (checkpoint.processedEntryIds) {
        this.processedEntryIds = checkpoint.processedEntryIds;
      }
      // Rebuild indexLookup from index
      this.indexLookup.clear();
      for (let i = 0; i < this.index.length; i++) {
        if (typeof this.index[i].changeSeq !== "number") {
          this.index[i].changeSeq = i + 1;
        }
        this.indexLookup.set(this.index[i].docId, i);
      }
      if (this.index.length > 0 && this.nextChangeSeq <= this.index.length) {
        this.nextChangeSeq = Math.max(...this.index.map(e => e.changeSeq)) + 1;
      }

      // Restore automergeHashToEntryId
      if (checkpoint.automergeHashToEntryId) {
        this.automergeHashToEntryId.clear();
        for (const [docId, inner] of Object.entries(checkpoint.automergeHashToEntryId as Record<string, Record<string, string>>)) {
          this.automergeHashToEntryId.set(docId, new Map(Object.entries(inner)));
        }
      }

      // 3. Load cached documents
      const docIds = await store.list("doc");
      const docPrefix = `${prefix}/`;
      let restoredDocs = 0;

      for (const id of docIds) {
        if (restoredDocs >= this.cacheRestoreLimit) {
          break;
        }
        if (!id.startsWith(docPrefix)) continue;
        const docId = id.slice(docPrefix.length);

        const docBytes = await store.get("doc", id);
        if (!docBytes) continue;

        try {
          const internal = this.deserializeDoc(docBytes);
          this.storeCachedDocument(internal);
          restoredDocs++;
        } catch (e) {
          this.logger.warn(`Failed to restore cached doc ${docId}, will reload from store: ${e}`);
        }
      }
      this.logger.info(`Restored ${restoredDocs} cached documents for ${this.store.getId()}`);

      this.logger.info(`Restored ${restoredDocs} documents from cache for ${prefix}`);
      return true;
    } catch (e) {
      this.logger.warn(`Cache restore failed, will do full rebuild: ${e}`);
      return false;
    }
  }

  private deserializeDoc(value: Uint8Array): InternalDoc {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const headerLen = view.getUint32(0, false);
    const headerBytes = value.slice(4, 4 + headerLen);
    const amBinary = value.slice(4 + headerLen);

    const header = JSON.parse(new TextDecoder().decode(headerBytes));
    const doc = Automerge.load<MindooDocPayload>(amBinary);

    return {
      id: header.id,
      doc,
      createdAt: header.createdAt,
      lastModified: header.lastModified,
      decryptionKeyId: header.decryptionKeyId,
      isDeleted: header.isDeleted,
    };
  }

  /**
   * Get or import a CryptoKey for signature verification, with caching.
   * This avoids re-importing the same public key multiple times.
   */
  private async getOrImportPublicKey(publicKey: string): Promise<CryptoKey | null> {
    // Check cache first
    if (this.publicKeyCache.has(publicKey)) {
      return this.publicKeyCache.get(publicKey)!;
    }

    // Validate the public key is trusted
    const directory = await this.tenant.openDirectory();
    const isTrusted = await directory.validatePublicSigningKey(publicKey);
    if (!isTrusted) {
      this.logger.warn(`Public key not trusted: ${publicKey}`);
      return null;
    }

    // Import the key
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const publicKeyBuffer = this.tenant.pemToArrayBuffer(publicKey);
    
    const cryptoKey = await subtle.importKey(
      "spki",
      publicKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["verify"]
    );

    // Cache the imported key
    this.publicKeyCache.set(publicKey, cryptoKey);
    return cryptoKey;
  }

  /**
   * Verify a signature using a pre-imported CryptoKey.
   * This bypasses the key import step for better performance when keys are cached.
   */
  private async verifySignatureWithKey(
    cryptoKey: CryptoKey,
    payload: Uint8Array,
    signature: Uint8Array
  ): Promise<boolean> {
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    
    const isValid = await subtle.verify(
      {
        name: "Ed25519",
      },
      cryptoKey,
      signature.buffer as ArrayBuffer,
      payload.buffer as ArrayBuffer
    );

    return isValid;
  }

  /**
   * Compare two index entries for sorting.
   * Returns negative if a < b, positive if a > b, 0 if equal.
   * Sorts by deterministic changeSeq first, then by docId for uniqueness.
   */
  private compareIndexEntries(
    a: { docId: string; changeSeq: number },
    b: { docId: string; changeSeq: number }
  ): number {
    if (a.changeSeq !== b.changeSeq) {
      return a.changeSeq - b.changeSeq;
    }
    return a.docId.localeCompare(b.docId);
  }

  /**
   * Update the index entry for a document.
   * When a document changes, it gets a new monotonic sequence and is moved to
   * maintain order by (changeSeq, docId).
   * 
   * Optimized to only update lookup map for entries that actually moved.
   * 
   * @param docId The document ID
   * @param lastModified The new last modified timestamp
   * @param isDeleted Whether the document is deleted
   */
  private updateIndex(docId: string, lastModified: number, isDeleted: boolean): void {
    const startedAt = Date.now();
    const assignedSeq = this.nextChangeSeq;
    const newEntry = { docId, changeSeq: assignedSeq, lastModified, isDeleted };
    const existingIndex = this.indexLookup.get(docId);
    
    // Check if the entry already exists and hasn't changed position
    if (existingIndex !== undefined) {
      const existingEntry = this.index[existingIndex];
      // If only metadata flags stayed identical and caller replays same state, skip.
      if (existingEntry.lastModified === lastModified && existingEntry.isDeleted === isDeleted) {
        return; // No change needed
      }
      
      // Remove from current position
      this.index.splice(existingIndex, 1);
      
      // Update lookup map for entries that moved (only those after the removed position)
      // We'll update the full range after insertion to be safe
      const minAffectedIndex = Math.min(existingIndex, this.index.length);
      for (let i = minAffectedIndex; i < this.index.length; i++) {
        this.indexLookup.set(this.index[i].docId, i);
      }
      this.indexLookup.delete(docId);
    }
    
    // Find insertion point using binary search to maintain sorted order
    let insertIndex = this.index.length; // Default to end
    
    // Binary search for insertion point
    let left = 0;
    let right = this.index.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cmp = this.compareIndexEntries(newEntry, this.index[mid]);
      if (cmp < 0) {
        right = mid - 1;
        insertIndex = mid;
      } else {
        left = mid + 1;
        insertIndex = mid + 1;
      }
    }
    
    // Insert at the correct position
    this.index.splice(insertIndex, 0, newEntry);
    this.nextChangeSeq = assignedSeq + 1;
    
    // Update lookup map for entries from insertion point onwards
    // Only update entries that actually moved (from insertIndex to end)
    for (let i = insertIndex; i < this.index.length; i++) {
      this.indexLookup.set(this.index[i].docId, i);
    }

    this.performanceCallback?.onIndexUpdate?.({
      docId,
      operation: existingIndex === undefined ? "insert" : "update",
      time: Date.now() - startedAt,
    });
  }

  /**
   * Register an automerge hash -> entry ID mapping for a document.
   * This is used to resolve Automerge dependency hashes to entry IDs.
   */
  private registerAutomergeHashMapping(docId: string, automergeHash: string, entryId: string): void {
    if (!this.automergeHashToEntryId.has(docId)) {
      this.automergeHashToEntryId.set(docId, new Map());
    }
    this.automergeHashToEntryId.get(docId)!.set(automergeHash, entryId);
  }

  /**
   * Get the entry ID for an automerge hash within a document.
   * Returns null if not found.
   */
  private getEntryIdForAutomergeHash(docId: string, automergeHash: string): string | null {
    const docIndex = this.automergeHashToEntryId.get(docId);
    if (docIndex) {
      return docIndex.get(automergeHash) || null;
    }
    return null;
  }

  /**
   * Resolve Automerge dependency hashes to entry IDs for a document.
   * Returns the entry IDs for the given automerge hashes.
   */
  private resolveAutomergeDepsToEntryIds(docId: string, automergeHashes: string[]): string[] {
    const entryIds: string[] = [];
    for (const hash of automergeHashes) {
      const entryId = this.getEntryIdForAutomergeHash(docId, hash);
      if (entryId) {
        entryIds.push(entryId);
      } else {
        this.logger.warn(`Could not resolve automerge hash ${hash} to entry ID for doc ${docId}`);
      }
    }
    return entryIds;
  }

  /**
   * Get the SubtleCrypto instance from the tenant's crypto adapter.
   */
  private getSubtle(): SubtleCrypto {
    return this.tenant.getCryptoAdapter().getSubtle();
  }

  /**
   * Initialize the database instance.
   * If a cache store is available, attempts to restore from cache first,
   * then processes only the delta. Falls back to full rebuild on cache miss.
   */
  async initialize(): Promise<void> {
    this.logger.info(`Initializing database ${this.store.getId()} in tenant ${this.tenant.getId()}`);

    const cacheStore = this.cacheManager?.getStore();
    if (cacheStore) {
      const restored = await this.restoreFromCache(cacheStore);
      if (restored) {
        this.logger.info("Restored from cache, processing delta only");
        await this.syncStoreChanges();
        if (this.reconcileRestoredIndexOnInit) {
          await this.reconcileRestoredIndexWithStore();
        }
        return;
      }
    }

    await this.syncStoreChanges();
  }

  private async reconcileRestoredIndexWithStore(): Promise<void> {
    const lifecycleMetadata = await this.scanAllMetadata(this.store);
    const lifecycleDocIds = Array.from(new Set(
      lifecycleMetadata
        .filter((entry) =>
          entry.entryType === "doc_create"
          || entry.entryType === "doc_change"
          || entry.entryType === "doc_delete"
          || entry.entryType === "doc_snapshot",
        )
        .map((entry) => entry.docId),
    )).sort((left, right) => left.localeCompare(right));
    const missingDocIds = lifecycleDocIds.filter((docId) => !this.indexLookup.has(docId));

    if (missingDocIds.length === 0) {
      return;
    }

    this.logger.warn(
      `Detected stale cache checkpoint for ${this.store.getId()} - ` +
      `index is missing ${missingDocIds.length} document(s): ${missingDocIds.join(", ")}. ` +
      `Rebuilding metadata from local store.`,
    );

    this.index = [];
    this.indexLookup.clear();
    this.docCache.clear();
    this.automergeHashToEntryId.clear();
    this.processedEntryIds = [];
    this.processedEntryCursor = null;
    this.nextChangeSeq = 1;
    this.cacheMetaDirty = true;
    this.cacheManager?.markDirty();

    await this.syncStoreChanges();

    this.logger.info(
      `Metadata rebuild complete for ${this.store.getId()} - ` +
      `index now has ${this.index.length} document(s).`,
    );
  }

  /**
   * Sync changes from the content-addressed store by finding new entries and processing them.
   * This method can be called multiple times to incrementally sync new entries.
   * On first call (when processedEntryIds is empty), it will process all entries.
   */
  async syncStoreChanges(): Promise<void> {
    const syncStartedAt = Date.now();
    this.logger.debug(`Syncing store changes for database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    this.logger.debug(`Already processed ${this.processedEntryIds.length} entry IDs`);
    
    // Find new entries that we haven't processed yet
    const { entries: newEntryMetadata, nextCursor } = await this.getNewEntryMetadataForSync();
    this.logger.debug(`Found ${newEntryMetadata.length} new entries`);
    
    if (newEntryMetadata.length === 0) {
      this.processedEntryCursor = nextCursor;
      this.logger.debug(`No new entries to process`);
      this.performanceCallback?.onSyncOperation?.({
        operation: "findNewEntries",
        time: Date.now() - syncStartedAt,
        details: {
          newEntryCount: 0,
          processedEntryCount: this.processedEntryIds.length,
        },
      });
      return;
    }
    
    // Group new entries by document ID
    const entriesByDoc = new Map<string, StoreEntryMetadata[]>();
    for (const entryMeta of newEntryMetadata) {
      if (!entriesByDoc.has(entryMeta.docId)) {
        entriesByDoc.set(entryMeta.docId, []);
      }
      entriesByDoc.get(entryMeta.docId)!.push(entryMeta);
    }
    
    // Process each document with new entries
    // Use incremental cache updates when possible
    // Process documents in parallel with concurrency limit
    this.logger.debug(`Processing ${entriesByDoc.size} documents with new entries`);
    
    // Helper function to process a single document
    const processDocument = async (docId: string, entryMetadataList: StoreEntryMetadata[]): Promise<void> => {
      const processStartedAt = Date.now();
      try {
        this.logger.debug(`===== Processing document ${docId} with ${entryMetadataList.length} new entry(s) in syncStoreChanges =====`);
        
        // Check if document is cached
        const cachedDoc = this.getCachedDocument(docId);
        
        let updatedDoc: InternalDoc | null = null;
        
        if (cachedDoc) {
          // Document is cached - try incremental update
          this.logger.debug(`Document ${docId} found in cache, attempting incremental update`);
          try {
            updatedDoc = await this.applyNewEntriesToCachedDocument(cachedDoc, entryMetadataList);
            if (updatedDoc) {
              this.logger.debug(`Successfully updated cached document ${docId} incrementally`);
              // Only update index if document actually changed
              this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted);
              this.logger.debug(`Updated index for document ${docId} (lastModified: ${updatedDoc.lastModified}, isDeleted: ${updatedDoc.isDeleted})`);
            } else {
              this.logger.debug(`Document ${docId} unchanged after applying new entries, skipping index update`);
            }
          } catch (error) {
            // If incremental update fails, fall back to full reload
            this.logger.warn(`Incremental update failed for document ${docId}, falling back to full reload:`, error);
            this.docCache.delete(docId);
            updatedDoc = await this.loadDocumentInternal(docId);
            if (updatedDoc) {
              this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted);
            }
          }
        } else {
          // Metadata-first startup: avoid full materialization for uncached docs.
          // Index based on doc-lifecycle entries (create/change/delete) plus
          // doc_snapshot which may be the sole entry after a dense sync.
          // Attachment-only batches should not trigger document index updates.
          const docLifecycleEntries = entryMetadataList.filter(
            (e) =>
              e.entryType === "doc_create" ||
              e.entryType === "doc_change" ||
              e.entryType === "doc_delete" ||
              e.entryType === "doc_snapshot",
          );
          if (docLifecycleEntries.length === 0) {
            this.logger.debug(
              `Skipping metadata-first index for doc ${docId} — no document lifecycle entries (${entryMetadataList.length} attachment/other entries only)`,
            );
          } else {
            // Before indexing, verify the user has the decryption key so that
            // documents the user cannot access do not appear in getAllDocumentIds.
            const representativeEntry = docLifecycleEntries[0];
            const keyAvailable = await this.tenant.hasDecryptionKey(representativeEntry.decryptionKeyId);
            if (!keyAvailable) {
              this.logger.debug(
                `Skipping metadata-first index for doc ${docId} — decryption key "${representativeEntry.decryptionKeyId}" not available`,
              );
            } else {
              const mutationEntries = docLifecycleEntries.filter(
                (e) =>
                  e.entryType === "doc_create" ||
                  e.entryType === "doc_change" ||
                  e.entryType === "doc_delete",
              );
              // Snapshots compact replay history but should not change the user-visible
              // modification time when the original create/change/delete entries still exist.
              const entriesForLastModified =
                mutationEntries.length > 0 ? mutationEntries : docLifecycleEntries;
              const lastModified = Math.max(
                ...entriesForLastModified.map((e) => e.createdAt),
              );
              const isDeleted = mutationEntries.some(
                (e) => e.entryType === "doc_delete",
              );
              this.updateIndex(docId, lastModified, isDeleted);
              this.logger.debug(
                `Metadata-first update for uncached doc ${docId} (lastModified: ${lastModified}, isDeleted: ${isDeleted})`,
              );
            }
          }
        }
      } catch (error) {
        // Handle missing symmetric key gracefully - skip documents we can't decrypt
        if (error instanceof SymmetricKeyNotFoundError) {
          this.logger.debug(`Skipping document ${docId} - missing key: ${error.keyId}`);
          // Mark entry IDs as processed so we don't retry them
          this.processedEntryIds.push(...entryMetadataList.map(em => em.id));
          return; // Skip this document
        }
        
        this.logger.error(`===== ERROR processing document ${docId} in syncStoreChanges =====`, error);
        // Re-throw the error so we can see what's happening in the test
        throw error;
      } finally {
        this.performanceCallback?.onSyncOperation?.({
          operation: "processDocument",
          time: Date.now() - processStartedAt,
          details: {
            docId,
            entryCount: entryMetadataList.length,
            cacheHit: this.docCache.has(docId),
          },
        });
      }
    };
    
    const documentEntries = Array.from(entriesByDoc.entries())
      .sort((a, b) => {
        const aMinCreatedAt = Math.min(...a[1].map((e) => e.createdAt));
        const bMinCreatedAt = Math.min(...b[1].map((e) => e.createdAt));
        if (aMinCreatedAt !== bMinCreatedAt) {
          return aMinCreatedAt - bMinCreatedAt;
        }
        return a[0].localeCompare(b[0]);
      });

    // Deterministic sequential processing ensures stable changefeed ordering.
    for (const [docId, entryMetadataList] of documentEntries) {
      await processDocument(docId, entryMetadataList);
    }
    
    // Append new entry IDs to our processed list
    this.processedEntryIds.push(...newEntryMetadata.map(em => em.id));
    this.processedEntryCursor = nextCursor;
    this.cacheMetaDirty = true;
    this.cacheManager?.markDirty();
    
    this.logger.debug(`Synced ${newEntryMetadata.length} new entries, index now has ${this.index.length} documents`);
    this.performanceCallback?.onSyncOperation?.({
      operation: "findNewEntries",
      time: Date.now() - syncStartedAt,
      details: {
        newEntryCount: newEntryMetadata.length,
        documentCount: entriesByDoc.size,
        indexSize: this.index.length,
      },
    });
  }

  private supportsCursorScan(store: ContentAddressedStore): boolean {
    return typeof store.scanEntriesSince === "function";
  }

  private async scanAllMetadata(
    store: ContentAddressedStore,
    filters?: StoreScanFilters
  ): Promise<StoreEntryMetadata[]> {
    if (!this.supportsCursorScan(store)) {
      if (filters?.docId) {
        return store.findNewEntriesForDoc([], filters.docId);
      }
      return store.findNewEntries([]);
    }

    const all: StoreEntryMetadata[] = [];
    let cursor: StoreScanCursor | null = null;

    while (true) {
      const page = await store.scanEntriesSince!(cursor, 1000, filters);
      all.push(...page.entries);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    return all;
  }

  private async getNewEntryMetadataForSync(): Promise<{
    entries: StoreEntryMetadata[];
    nextCursor: StoreScanCursor | null;
  }> {
    const startedAt = Date.now();
    if (!this.supportsCursorScan(this.store)) {
      const result = await this.store.findNewEntries(this.processedEntryIds);
      this.performanceCallback?.onSyncOperation?.({
        operation: "findNewEntries",
        time: Date.now() - startedAt,
        details: {
          mode: "knownIds",
          resultCount: result.length,
          processedEntryCount: this.processedEntryIds.length,
        },
      });
      return {
        entries: result,
        nextCursor: this.processedEntryCursor,
      };
    }

    const allNew: StoreEntryMetadata[] = [];
    let cursor = this.processedEntryCursor;

    while (true) {
      const page = await this.store.scanEntriesSince!(cursor, 1000);
      allNew.push(...page.entries);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    this.performanceCallback?.onSyncOperation?.({
      operation: "findNewEntries",
      time: Date.now() - startedAt,
      details: {
        mode: "cursorScan",
        resultCount: allNew.length,
        cursor,
      },
    });
    return {
      entries: allNew,
      nextCursor: cursor,
    };
  }

  /**
   * Fetch the target store's bloom filter summary, returning null if
   * unsupported or on error (callers fall back to exact checks).
   */
  private async getTargetBloomSummary(
    targetStore: ContentAddressedStore,
  ): Promise<StoreIdBloomSummary | null> {
    if (typeof targetStore.getIdBloomSummary !== "function") {
      return null;
    }
    try {
      return await targetStore.getIdBloomSummary();
    } catch (error) {
      this.logger.warn("Failed to get bloom summary from target store, falling back to exact checks", error);
      return null;
    }
  }

  private static setSyncAbortSignalOnStore(store: ContentAddressedStore, signal?: AbortSignal): void {
    if ('setSyncAbortSignal' in store && typeof (store as any).setSyncAbortSignal === 'function') {
      (store as any).setSyncAbortSignal(signal);
    }
  }

  /**
   * From a list of candidate IDs, return only those the target store is
   * missing.  Uses bloom-filter pre-screening when available, then falls
   * back to exact `hasEntries` for the uncertain set.
   */
  private async filterMissingIds(
    targetStore: ContentAddressedStore,
    candidateIds: string[],
    bloom: StoreIdBloomSummary | null,
  ): Promise<string[]> {
    let definitelyMissing: string[] = [];
    let maybeExisting: string[] = candidateIds;

    if (bloom) {
      definitelyMissing = [];
      maybeExisting = [];
      for (const id of candidateIds) {
        if (bloomMightContainId(bloom, id)) {
          maybeExisting.push(id);
        } else {
          definitelyMissing.push(id);
        }
      }
    }

    let missingIds = definitelyMissing;
    if (maybeExisting.length > 0) {
      const existing = await targetStore.hasEntries(maybeExisting);
      const existingSet = new Set(existing);
      missingIds = missingIds.concat(maybeExisting.filter((id) => !existingSet.has(id)));
    }
    return missingIds;
  }

  /**
   * Determine how many entry IDs to fetch per `getEntries` call during sync.
   *
   * This is intentionally separate from the metadata scan `pageSize` so that
   * scanning can page through large ID lists quickly while the heavier
   * payload downloads use a smaller batch to keep progress responsive and
   * cancellation timely.
   *
   * Priority: explicit option > attachment default (100) > pageSize fallback.
   */
  private resolveTransferBatchSize(options?: SyncOptions): number {
    if (options?.transferBatchSize && options.transferBatchSize > 0) {
      return options.transferBatchSize;
    }
    if (options?.storeKind === StoreKind.attachments) {
      return 100;
    }
    return options?.pageSize ?? 1000;
  }

  /**
   * Transfer a set of entry IDs from source to target in fixed-size batches,
   * emitting progress and checking for cancellation between each batch.
   *
   * Callers (cursor-scan path and legacy path) collect the IDs that need
   * transferring, then delegate to this method instead of issuing one
   * monolithic `getEntries`.  This gives three benefits:
   *
   * 1. The UI receives frequent progress updates with batch metadata so long
   *    transfers no longer look frozen.
   * 2. Cancellation can interrupt work between batches rather than waiting
   *    for one large HTTP response to complete.
   * 3. Each server-side `getEntries` + RSA encryption unit is smaller,
   *    reducing the risk of socket timeouts on large payloads.
   *
   * Returns partial progress on cancellation so callers can report how much
   * was actually transferred before the abort.
   */
  private async transferEntriesInBatches(
    sourceStore: ContentAddressedStore,
    targetStore: ContentAddressedStore,
    entryIds: string[],
    options: SyncOptions | undefined,
    state: {
      transferred: number;
      scanned: number;
      totalSourceEntries?: number;
      currentPage?: number;
    },
  ): Promise<{ transferred: number; cancelled: boolean }> {
    if (entryIds.length === 0) {
      return { transferred: state.transferred, cancelled: false };
    }

    const onProgress = options?.onProgress;
    const signal = options?.signal;
    const transferBatchSize = this.resolveTransferBatchSize(options);
    const totalTransferBatches = Math.max(1, Math.ceil(entryIds.length / transferBatchSize));
    let transferred = state.transferred;

    for (let offset = 0; offset < entryIds.length; offset += transferBatchSize) {
      if (signal?.aborted) {
        return { transferred, cancelled: true };
      }

      const currentTransferBatch = Math.floor(offset / transferBatchSize) + 1;
      const batchIds = entryIds.slice(offset, offset + transferBatchSize);
      const pageSummary = state.currentPage ? `page ${state.currentPage}, ` : "";
      onProgress?.({
        phase: "transferring",
        message: `Transferring batch ${currentTransferBatch}/${totalTransferBatches} (${batchIds.length} entries, ${pageSummary}scanned ${state.scanned})...`,
        transferredEntries: transferred,
        scannedEntries: state.scanned,
        totalSourceEntries: state.totalSourceEntries,
        currentPage: state.currentPage,
        currentTransferBatch,
        totalTransferBatches,
        transferBatchSize,
      });

      try {
        const batchEntries = await sourceStore.getEntries(batchIds);
        if (signal?.aborted) {
          return { transferred, cancelled: true };
        }
        await targetStore.putEntries(batchEntries);
        transferred += batchEntries.length;
      } catch (error) {
        if (signal?.aborted) {
          return { transferred, cancelled: true };
        }
        throw error;
      }

      onProgress?.({
        phase: "transferring",
        message: `Transferred ${transferred} entries after batch ${currentTransferBatch}/${totalTransferBatches}`,
        transferredEntries: transferred,
        scannedEntries: state.scanned,
        totalSourceEntries: state.totalSourceEntries,
        currentPage: state.currentPage,
        currentTransferBatch,
        totalTransferBatches,
        transferBatchSize,
      });
    }

    return { transferred, cancelled: false };
  }

  private async syncEntriesFromStore(
    sourceStore: ContentAddressedStore,
    targetStore: ContentAddressedStore,
    options?: SyncOptions
  ): Promise<{ transferred: number; scanned: number; cancelled: boolean }> {
    const signal = options?.signal;
    BaseMindooDB.setSyncAbortSignalOnStore(sourceStore, signal);
    BaseMindooDB.setSyncAbortSignalOnStore(targetStore, signal);
    try {
      if (options?.mode === "dense") {
        return await this.syncEntriesFromStoreDense(sourceStore, targetStore, options);
      }
      return await this.syncEntriesFromStoreImpl(sourceStore, targetStore, options);
    } catch (error) {
      if (signal?.aborted) {
        this.logger.info("Sync cancelled by abort signal");
        return { transferred: 0, scanned: 0, cancelled: true };
      }
      throw error;
    } finally {
      BaseMindooDB.setSyncAbortSignalOnStore(sourceStore, undefined);
      BaseMindooDB.setSyncAbortSignalOnStore(targetStore, undefined);
    }
  }

  private async syncEntriesFromStoreImpl(
    sourceStore: ContentAddressedStore,
    targetStore: ContentAddressedStore,
    options?: SyncOptions
  ): Promise<{ transferred: number; scanned: number; cancelled: boolean }> {
    let transferred = 0;
    let scanned = 0;
    const onProgress = options?.onProgress;
    const pageSize = options?.pageSize ?? 1000;
    const signal = options?.signal;

    const targetBloom = await this.getTargetBloomSummary(targetStore);
    const totalSourceEstimate = targetBloom?.totalIds;

    if (this.supportsCursorScan(sourceStore)) {
      onProgress?.({
        phase: 'preparing',
        message: 'Preparing to sync entries...',
        transferredEntries: 0,
        scannedEntries: 0,
        totalSourceEntries: totalSourceEstimate,
      });

      let cursor: StoreScanCursor | null = null;
      let currentPage = 0;
      while (true) {
        if (signal?.aborted) {
          return { transferred, scanned, cancelled: true };
        }

        const page = await sourceStore.scanEntriesSince!(cursor, pageSize);
        currentPage++;
        scanned += page.entries.length;

        if (signal?.aborted) {
          return { transferred, scanned, cancelled: true };
        }

        if (page.entries.length > 0) {
          onProgress?.({
            phase: 'transferring',
            message: `Scanned ${scanned} entries, checking for changes (page ${currentPage})...`,
            transferredEntries: transferred,
            scannedEntries: scanned,
            totalSourceEntries: totalSourceEstimate,
            currentPage,
          });

          const ids = page.entries.map((m) => m.id);
          const missingIds = await this.filterMissingIds(targetStore, ids, targetBloom);

          if (signal?.aborted) {
            return { transferred, scanned, cancelled: true };
          }

          if (missingIds.length > 0) {
            const transferResult = await this.transferEntriesInBatches(
              sourceStore,
              targetStore,
              missingIds,
              options,
              {
                transferred,
                scanned,
                totalSourceEntries: totalSourceEstimate,
                currentPage,
              },
            );
            transferred = transferResult.transferred;
            if (transferResult.cancelled) {
              return { transferred, scanned, cancelled: true };
            }
          }
        }

        onProgress?.({
          phase: 'transferring',
          message: `Transferred ${transferred} entries (page ${currentPage}, scanned ${scanned})`,
          transferredEntries: transferred,
          scannedEntries: scanned,
          totalSourceEntries: totalSourceEstimate,
          currentPage,
        });

        cursor = page.nextCursor;
        if (!page.hasMore) {
          break;
        }
      }
      return { transferred, scanned, cancelled: false };
    }

    onProgress?.({
      phase: 'preparing',
      message: 'Finding new entries...',
      transferredEntries: 0,
      scannedEntries: 0,
    });

    const targetIds = await targetStore.getAllIds();
    const sourceNewMetadata = await sourceStore.findNewEntries(targetIds);
    if (sourceNewMetadata.length === 0) {
      return { transferred: 0, scanned: 0, cancelled: false };
    }

    if (options?.signal?.aborted) {
      return { transferred: 0, scanned: 0, cancelled: true };
    }

    onProgress?.({
      phase: 'transferring',
      message: `Transferring ${sourceNewMetadata.length} entries...`,
      transferredEntries: transferred,
      scannedEntries: sourceNewMetadata.length,
      totalSourceEntries: sourceNewMetadata.length,
    });

    const transferResult = await this.transferEntriesInBatches(
      sourceStore,
      targetStore,
      sourceNewMetadata.map((m) => m.id),
      options,
      {
        transferred,
        scanned: sourceNewMetadata.length,
        totalSourceEntries: sourceNewMetadata.length,
      },
    );
    transferred = transferResult.transferred;
    if (transferResult.cancelled) {
      return { transferred, scanned: sourceNewMetadata.length, cancelled: true };
    }

    onProgress?.({
      phase: 'transferring',
      message: `Transferred ${transferred} entries`,
      transferredEntries: transferred,
      scannedEntries: sourceNewMetadata.length,
      totalSourceEntries: sourceNewMetadata.length,
    });

    return {
      transferred,
      scanned: sourceNewMetadata.length,
      cancelled: false,
    };
  }

  /**
   * Dense sync: transfer only the entries required to reconstruct the latest
   * state of each document, using the batch materialization planner to skip
   * historical entries already superseded by snapshots.
   *
   * Algorithm:
   * 1. Discover all documents on the source via `doc_create` metadata.
   * 2. Also fetch `doc_delete` metadata so deletion markers are transferred.
   * 3. Ask the source's batch planner for the optimal replay set per document.
   * 4. Merge all entry IDs: doc_create + doc_delete + snapshot + uncovered changes.
   * 5. Filter out IDs the target already has (bloom + exact check).
   * 6. Transfer only the missing entries.
   *
   * Attachment chunks are intentionally skipped — they are not part of the
   * Automerge document DAG and can be fetched on demand when accessed.
   */
  private async syncEntriesFromStoreDense(
    sourceStore: ContentAddressedStore,
    targetStore: ContentAddressedStore,
    options?: SyncOptions,
  ): Promise<{ transferred: number; scanned: number; cancelled: boolean }> {
    const onProgress = options?.onProgress;

    onProgress?.({
      phase: "preparing",
      message: "Dense sync: discovering documents on source...",
      transferredEntries: 0,
      scannedEntries: 0,
    });

    if (options?.signal?.aborted) {
      return { transferred: 0, scanned: 0, cancelled: true };
    }

    // ── Phase 1: discover documents ──────────────────────────────────
    const docCreateEntries = await sourceStore.findEntries("doc_create", null, null);
    const docDeleteEntries = await sourceStore.findEntries("doc_delete", null, null);
    const docIds = [...new Set(docCreateEntries.map((e) => e.docId))];

    this.logger.info(`Dense sync: found ${docIds.length} documents on source`);

    if (docIds.length === 0) {
      return { transferred: 0, scanned: 0, cancelled: false };
    }

    if (options?.signal?.aborted) {
      return { transferred: 0, scanned: 0, cancelled: true };
    }

    // ── Phase 2: batch plan on source ────────────────────────────────
    onProgress?.({
      phase: "planning",
      message: `Dense sync: computing materialization plans for ${docIds.length} documents...`,
      transferredEntries: 0,
      scannedEntries: docIds.length,
    });

    const batchPlan = await sourceStore.planDocumentMaterializationBatch(docIds);

    // ── Phase 3: collect needed entry IDs ────────────────────────────
    const neededIds = new Set<string>();

    for (const entry of docCreateEntries) {
      neededIds.add(entry.id);
    }
    for (const entry of docDeleteEntries) {
      neededIds.add(entry.id);
    }
    for (const plan of batchPlan.plans) {
      if (plan.snapshotEntryId) {
        neededIds.add(plan.snapshotEntryId);
      }
      for (const id of plan.entryIdsToApply) {
        neededIds.add(id);
      }
    }

    this.logger.info(
      `Dense sync: planner identified ${neededIds.size} required entries ` +
      `(from ${docIds.length} documents)`,
    );

    if (options?.signal?.aborted) {
      return { transferred: 0, scanned: neededIds.size, cancelled: true };
    }

    // ── Phase 4: filter out entries the target already has ───────────
    const allNeededArray = Array.from(neededIds);
    const targetBloom = await this.getTargetBloomSummary(targetStore);
    const missingIds = await this.filterMissingIds(targetStore, allNeededArray, targetBloom);

    this.logger.info(
      `Dense sync: ${missingIds.length} entries to transfer ` +
      `(${allNeededArray.length - missingIds.length} already present)`,
    );

    if (missingIds.length === 0) {
      return { transferred: 0, scanned: allNeededArray.length, cancelled: false };
    }

    if (options?.signal?.aborted) {
      return { transferred: 0, scanned: allNeededArray.length, cancelled: true };
    }

    // ── Phase 5: transfer missing entries in pages ───────────────────
    const pageSize = options?.pageSize ?? 500;
    let transferred = 0;

    for (let offset = 0; offset < missingIds.length; offset += pageSize) {
      if (options?.signal?.aborted) {
        return { transferred, scanned: allNeededArray.length, cancelled: true };
      }

      const batch = missingIds.slice(offset, offset + pageSize);
      const entries = await sourceStore.getEntries(batch);
      await targetStore.putEntries(entries);
      transferred += entries.length;

      onProgress?.({
        phase: "transferring",
        message: `Dense sync: transferred ${transferred}/${missingIds.length} entries`,
        transferredEntries: transferred,
        scannedEntries: allNeededArray.length,
        totalSourceEntries: allNeededArray.length,
      });
    }

    this.logger.info(`Dense sync complete: transferred ${transferred} entries`);
    return { transferred, scanned: allNeededArray.length, cancelled: false };
  }

  getStore(): ContentAddressedStore {
    return this.store;
  }

  getAttachmentStore(): ContentAddressedStore {
    return this.attachmentStore;
  }

  getTenant(): MindooTenant {
    return this.tenant;
  }

  async createDocument(): Promise<MindooDoc> {
    return this.createEncryptedDocument("default");
  }

  async createEncryptedDocument(decryptionKeyId?: string): Promise<MindooDoc> {
    return this.createDocumentInternal(decryptionKeyId || "default");
  }

  async createDocumentWithSigningKey(
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string,
    decryptionKeyId?: string
  ): Promise<MindooDoc> {
    return this.createDocumentInternal(decryptionKeyId || "default", signingKeyPair, signingKeyPassword);
  }
  
  /**
   * Internal method to create a new document.
   * Handles both regular document creation (signed by current user) and
   * document creation with a custom signing key (e.g., for directory operations).
   */
  private async createDocumentInternal(
    decryptionKeyId: string,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<MindooDoc> {
    const keyId = decryptionKeyId;
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    
    // Admin-only validation: only admin key can modify data in admin-only databases
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomSigningKey 
        ? signingKeyPair!.publicKey 
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
    
    // Generate UUID7 for document ID
    const docId = uuidv7();
    
    this.logger.debug(`Creating document ${docId} with key ${keyId}${useCustomSigningKey ? ' using custom signing key' : ''}`);
    
    // Create initial Automerge document
    const initialDoc = Automerge.init<MindooDocPayload>();
    
    // Create the first change
    const now = Date.now();
    this.logger.debug(`Creating initial Automerge change for document ${docId}`);
    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    try {
      newDoc = Automerge.change(initialDoc, (doc: MindooDocPayload) => {
        // Store metadata in the document payload
        // We need to modify the document to ensure a change is created
        doc._attachments = [];
      });
      this.logger.debug(`Successfully created Automerge change, document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      this.logger.error(`Error in Automerge.change for document ${docId}:`, error);
      throw error;
    }
    
    // Get the change bytes from the document
    this.logger.debug(`Getting change bytes from document ${docId}`);
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    this.logger.debug(`Got change bytes: ${changeBytes.length} bytes`);
    
    // Decode the change to get hash and dependencies
    this.logger.debug(`Decoding change to get hash and dependencies`);
    let decodedChange: any;
    try {
      decodedChange = Automerge.decodeChange(changeBytes);
      this.logger.debug(`Successfully decoded change, hash: ${decodedChange.hash}, deps: ${decodedChange.deps?.length || 0}`);
    } catch (error) {
      this.logger.error(`Error decoding change for document ${docId}:`, error);
      throw error;
    }
    const automergeHash = decodedChange.hash;
    const automergeDepHashes: string[] = decodedChange.deps || []; // First change has no dependencies
    
    // Encrypt the change payload first
    this.logger.debug(`Encrypting change payload for document ${docId}`);
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, keyId);
    this.logger.debug(`Encrypted payload: ${changeBytes.length} -> ${encryptedPayload.length} bytes`);
    
    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());
    this.logger.debug(`Computed content hash: ${contentHash.substring(0, 16)}...`);
    
    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    this.logger.debug(`Generated entry ID: ${entryId}`);
    
    // Resolve Automerge dependency hashes to entry IDs (empty for first change)
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);
    
    // Sign the encrypted payload - either with custom key or current user's key
    let signature: Uint8Array;
    let createdByPublicKey: string;
    
    if (useCustomSigningKey) {
      this.logger.debug(`Signing encrypted payload for document ${docId} with provided key`);
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair!, signingKeyPassword!);
      createdByPublicKey = signingKeyPair!.publicKey;
    } else {
      this.logger.debug(`Signing encrypted payload for document ${docId}`);
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }
    this.logger.debug(`Signed payload, signature length: ${signature.length} bytes`);

    // Create entry metadata
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_create",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: now,
      createdByPublicKey,
      decryptionKeyId: keyId,
      signature,
      originalSize: changeBytes.length,
      encryptedSize: encryptedPayload.length,
    };
    
    // Create full entry object
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };
    
    // Store entry
    await this.store.putEntries([fullEntry]);
    
    // Register automerge hash -> entry ID mapping
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);
    
    // Create internal document representation
    const internalDoc: InternalDoc = {
      id: docId,
      doc: newDoc,
      createdAt: now,
      lastModified: now,
      decryptionKeyId: keyId,
      isDeleted: false,
    };
    
    // Update cache and index
    this.storeCachedDocument(internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, false);
    this.markDocDirty(docId);
    
    this.logger.info(`Document ${docId} created successfully`);
    this.logger.debug(`Document ${docId} cached and indexed (lastModified: ${internalDoc.lastModified})`);
    
    return this.wrapDocument(internalDoc);
  }

  async getDocument(docId: string): Promise<MindooDoc> {
    const internalDoc = await this.loadDocumentInternal(docId);
    
    if (!internalDoc) {
      throw new Error(`Document ${docId} not found`);
    }
    
    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }
    
    return this.wrapDocument(internalDoc);
  }

  async getDocumentAtTimestamp(docId: string, timestamp: number): Promise<MindooDoc | null> {
    const startedAt = Date.now();
    this.logger.debug(`Getting document ${docId} at timestamp ${timestamp}`);
    
    // Get all entry metadata for this document
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    
    // Filter to document replay metadata plus snapshots up to the timestamp.
    // Attachment chunks are not part of the Automerge replay DAG and must not
    // participate in historical materialization.
    const relevantEntries = allEntryMetadata
      .filter((em) =>
        em.createdAt <= timestamp
        && (
          em.entryType === "doc_create"
          || em.entryType === "doc_change"
          || em.entryType === "doc_delete"
          || em.entryType === "doc_snapshot"
        )
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    
    if (relevantEntries.length === 0) {
      this.performanceCallback?.onHistoryOperation?.({
        operation: "getDocumentAtTimestamp",
        docId,
        time: Date.now() - startedAt,
        scannedEntries: 0,
        bounded: false,
      });
      return null; // Document didn't exist at that time
    }

    const metadataById = new Map(relevantEntries.map((meta) => [meta.id, meta]));
    const materializationPlan = computeDocumentMaterializationPlan(docId, relevantEntries);
    let startFromSnapshot = materializationPlan.snapshotEntryId !== null;
    const snapshotMeta = materializationPlan.snapshotEntryId
      ? (metadataById.get(materializationPlan.snapshotEntryId) || null)
      : null;
    if (startFromSnapshot && !snapshotMeta) {
      this.logger.warn(
        `Planner referenced snapshot ${materializationPlan.snapshotEntryId} not found in metadata for ${docId}; falling back to replay without snapshot`,
      );
      startFromSnapshot = false;
    }

    let doc: AutomergeTypes.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotMeta) {
      const snapshotEntries = await this.store.getEntries([snapshotMeta.id]);
      if (snapshotEntries.length > 0) {
        const snapshotData = snapshotEntries[0];

        let isValid = false;
        if (this._isAdminOnlyDb && snapshotData.createdByPublicKey !== this.getAdminPublicKey()) {
          this.logger.warn(`Admin-only DB: skipping snapshot ${snapshotData.id} not signed by admin key`);
        } else {
          isValid = await this.tenant.verifySignature(
            snapshotData.encryptedData,
            snapshotData.signature,
            snapshotData.createdByPublicKey,
          );
        }

        if (!isValid) {
          this.logger.warn(`Invalid signature for snapshot ${snapshotData.id}, falling back to replay without snapshot`);
          startFromSnapshot = false;
        } else {
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.encryptedData,
            snapshotData.decryptionKeyId,
          );
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);

          const parsed = parseDocEntryId(snapshotData.id);
          if (parsed) {
            this.registerAutomergeHashMapping(docId, parsed.automergeHash, snapshotData.id);
          }
        }
      }
    }

    if (!doc) {
      doc = Automerge.init<MindooDocPayload>();
    }

    const entriesToApply = materializationPlan.entryIdsToApply
      .map((id) => metadataById.get(id))
      .filter((entry): entry is StoreEntryMetadata => entry !== undefined);
    const loadedEntries = entriesToApply.length > 0
      ? await this.store.getEntries(entriesToApply.map((entry) => entry.id))
      : [];
    const entryById = new Map(loadedEntries.map((entry) => [entry.id, entry]));

    for (const entryMeta of entriesToApply) {
      const entryData = entryById.get(entryMeta.id);
      if (!entryData) {
        this.logger.warn(`Entry ${entryMeta.id} not found in store, skipping`);
        continue;
      }

      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        continue;
      }

      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey,
      );
      if (!isValid) {
        this.logger.warn(`Invalid signature for entry ${entryData.id}, skipping`);
        continue;
      }

      const decryptedPayload = await this.tenant.decryptPayload(
        entryData.encryptedData,
        entryData.decryptionKeyId,
      );
      doc = Automerge.loadIncremental(doc, decryptedPayload);

      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
    }

    const replayEntries = relevantEntries.filter(
      (entry) =>
        entry.entryType === "doc_create"
        || entry.entryType === "doc_change"
        || entry.entryType === "doc_delete",
    );
    const firstReplayEntry = replayEntries.length > 0 ? replayEntries[0] : null;
    const lastReplayEntry = replayEntries.length > 0 ? replayEntries[replayEntries.length - 1] : null;
    const createdAt = firstReplayEntry?.createdAt ?? snapshotMeta?.createdAt ?? timestamp;
    const decryptionKeyId =
      firstReplayEntry?.decryptionKeyId
      ?? snapshotMeta?.decryptionKeyId
      ?? "default";
    const isDeleted = lastReplayEntry?.entryType === "doc_delete";
    const lastModified = lastReplayEntry?.createdAt ?? snapshotMeta?.createdAt ?? timestamp;
    
    const internalDoc: InternalDoc = {
      id: docId,
      doc,
      createdAt,
      lastModified,
      decryptionKeyId,
      isDeleted,
    };
    
    this.performanceCallback?.onHistoryOperation?.({
      operation: "getDocumentAtTimestamp",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: relevantEntries.length,
      returnedEntries: 1,
      bounded: false,
    });

    return this.wrapDocument(internalDoc);
  }

  async *iterateDocumentHistory(docId: string): AsyncGenerator<DocumentHistoryResult, void, unknown> {
    this.logger.debug(`Iterating document history for ${docId}`);
    
    // Get all entry metadata for this document
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    
    // Filter to only doc_create, doc_change, and doc_delete entries (exclude snapshots)
    const relevantEntries = allEntryMetadata
      .filter(em => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete")
      .sort((a, b) => a.createdAt - b.createdAt);
    
    if (relevantEntries.length === 0) {
      return; // Document has no history
    }
    
    // Load all entries
    const entries = await this.store.getEntries(relevantEntries.map(em => em.id));
    
    // Build a map for quick lookup
    const entryMap = new Map(entries.map(e => [e.id, e]));
    
    // Apply changes in order
    let currentDoc: AutomergeTypes.Doc<MindooDocPayload> | null = null;
    let createdAt: number | null = null;
    let decryptionKeyId: string = "default";
    
    for (const entryMetadata of relevantEntries) {
      const entryData = entryMap.get(entryMetadata.id);
      if (!entryData) {
        this.logger.warn(`Entry ${entryMetadata.id} not found in store, skipping`);
        continue;
      }
      
      // Admin-only mode: only accept entries signed by the admin key
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        continue;
      }
      
      // Verify signature
      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey
      );
      if (!isValid) {
        this.logger.warn(`Invalid signature for entry ${entryData.id}, skipping`);
        continue;
      }
      
      // Decrypt payload
      const decryptedPayload = await this.tenant.decryptPayload(
        entryData.encryptedData,
        entryData.decryptionKeyId
      );
      
      // Initialize document if this is the first entry (doc_create)
      const isFirstEntry = currentDoc === null;
      if (isFirstEntry) {
        if (entryMetadata.entryType !== "doc_create") {
          this.logger.warn(`First entry is not doc_create, skipping`);
          continue;
        }
        currentDoc = Automerge.init<MindooDocPayload>();
        createdAt = entryMetadata.createdAt;
        decryptionKeyId = entryMetadata.decryptionKeyId;
      }
      
      // Check document heads before applying change (for non-first entries)
      const headsBefore = isFirstEntry ? null : (currentDoc ? Automerge.getHeads(currentDoc) : null);
      
      // Apply change using loadIncremental
      if (currentDoc === null) {
        throw new Error("currentDoc should not be null at this point");
      }
      currentDoc = Automerge.loadIncremental(currentDoc, decryptedPayload);
      
      // Check if document actually changed by comparing heads
      // For first entry (doc_create), always yield since it's the initial creation
      // For delete entries, always yield
      // For other entries, only yield if heads changed
      let shouldYield = false;
      if (isFirstEntry || entryMetadata.entryType === "doc_delete") {
        shouldYield = true;
      } else {
        const headsAfter = Automerge.getHeads(currentDoc);
        const headsChanged = headsBefore !== null && JSON.stringify(headsBefore) !== JSON.stringify(headsAfter);
        shouldYield = headsChanged;
      }
      
      // Register automerge hash mapping
      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
      
      // Only yield if document actually changed (or if this is create/delete entry)
      if (shouldYield) {
        // Clone the document to ensure independence
        const clonedDoc = Automerge.clone(currentDoc);
        
        // Create internal doc representation
        const internalDoc: InternalDoc = {
          id: docId,
          doc: clonedDoc,
          createdAt: createdAt!,
          lastModified: entryMetadata.createdAt,
          decryptionKeyId,
          isDeleted: entryMetadata.entryType === "doc_delete",
        };
        
        // Wrap and yield (including delete entries)
        const wrappedDoc = this.wrapDocument(internalDoc);
        
        yield {
          doc: wrappedDoc,
          changeCreatedAt: entryMetadata.createdAt,
          changeCreatedByPublicKey: entryMetadata.createdByPublicKey,
        };
      }
      
      // Stop after delete entry (document is deleted, no more changes)
      if (entryMetadata.entryType === "doc_delete") {
        break;
      }
    }
  }

  async getDocumentHistoryPage(
    docId: string,
    options?: DocumentHistoryPageOptions
  ): Promise<DocumentHistoryPageResult> {
    const startedAt = Date.now();
    const limit = Math.max(1, Math.floor(options?.limit ?? 100));
    const offset = Math.max(0, Math.floor(options?.cursor?.offset ?? 0));

    // This API stays metadata-only so large history views can page cheaply
    // without reconstructing every historical Automerge document state.
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    const relevantEntries = allEntryMetadata
      .filter(
        (em) =>
          em.entryType === "doc_create" ||
          em.entryType === "doc_change" ||
          em.entryType === "doc_delete"
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    // Cursor paging is offset-based because the result is a bounded timeline view
    // over the doc's sorted change metadata, not a resumable store scan cursor.
    const slice = relevantEntries.slice(offset, offset + limit);
    const entries: DocumentHistoryPageEntry[] = slice.map((entry) => ({
      entryId: entry.id,
      entryType: entry.entryType,
      changeCreatedAt: entry.createdAt,
      changeCreatedByPublicKey: entry.createdByPublicKey,
      dependencyIds: [...entry.dependencyIds],
      isDeleted: entry.entryType === "doc_delete",
    }));
    const nextOffset = offset + entries.length;
    const hasMore = nextOffset < relevantEntries.length;
    const result: DocumentHistoryPageResult = {
      entries,
      nextCursor: hasMore ? { offset: nextOffset } : null,
      hasMore,
    };

    this.performanceCallback?.onHistoryOperation?.({
      operation: "getDocumentHistoryPage",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: relevantEntries.length,
      returnedEntries: entries.length,
      bounded: true,
    });

    return result;
  }

  async analyzeDocumentDagAtTimestamp(
    docId: string,
    timestamp: DocumentDagAnalysisTimestamp,
  ): Promise<DocumentDagAnalysisResult> {
    const startedAt = Date.now();
    const resolvedTimestamp = this.resolveDagTimestamp(timestamp);
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    const relevantEntries = allEntryMetadata
      .filter((entry) => entry.createdAt <= resolvedTimestamp && isDagEntry(entry));
    const result = computeDocumentDagAnalysis(docId, relevantEntries, resolvedTimestamp);
    const actorIdByEntryId = await this.decodeAutomergeActorIds(relevantEntries);
    result.entries = result.entries.map((entry) => ({
      ...entry,
      automergeActorId: actorIdByEntryId.get(entry.entryId) ?? null,
    }));
    this.performanceCallback?.onHistoryOperation?.({
      operation: "analyzeDocumentDagAtTimestamp",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: relevantEntries.length,
      returnedEntries: result.entries.length,
      bounded: true,
    });
    return result;
  }

  /**
   * Decodes Automerge actor ids for replay entries so analysis consumers can color
   * or group nodes by the logical Automerge actor instead of transport metadata.
   */
  private async decodeAutomergeActorIds(
    relevantEntries: StoreEntryMetadata[],
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const replayEntries = relevantEntries.filter((entry) => entry.entryType !== "doc_snapshot");
    if (replayEntries.length === 0) {
      return result;
    }
    const loadedEntries = await this.store.getEntries(replayEntries.map((entry) => entry.id));
    const entryById = new Map(loadedEntries.map((entry) => [entry.id, entry]));
    for (const metadata of replayEntries) {
      const entry = entryById.get(metadata.id);
      if (!entry) {
        result.set(metadata.id, null);
        continue;
      }
      if (this._isAdminOnlyDb && entry.createdByPublicKey !== this.getAdminPublicKey()) {
        result.set(metadata.id, null);
        continue;
      }
      const isValid = await this.tenant.verifySignature(
        entry.encryptedData,
        entry.signature,
        entry.createdByPublicKey,
      );
      if (!isValid) {
        result.set(metadata.id, null);
        continue;
      }
      const decryptedPayload = await this.tenant.decryptPayload(
        entry.encryptedData,
        entry.decryptionKeyId,
      );
      const decodedAutomergeChange = Automerge.decodeChange(decryptedPayload) as Record<string, unknown>;
      result.set(
        metadata.id,
        typeof decodedAutomergeChange.actor === "string" ? decodedAutomergeChange.actor : null,
      );
    }
    return result;
  }

  async materializeDocumentBranchAtEntry(
    docId: string,
    headEntryId: string,
  ): Promise<DocumentDagBranchMaterializationResult | null> {
    const startedAt = Date.now();
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    const plan = computeBranchMaterializationPlan(docId, allEntryMetadata, headEntryId);
    if (!plan) {
      this.performanceCallback?.onHistoryOperation?.({
        operation: "materializeDocumentBranchAtEntry",
        docId,
        time: Date.now() - startedAt,
        scannedEntries: allEntryMetadata.length,
        returnedEntries: 0,
        bounded: true,
      });
      return null;
    }
    const metadataById = new Map(allEntryMetadata.map((entry) => [entry.id, entry]));
    const branchEntries = plan.branchEntryIds
      .map((entryId) => metadataById.get(entryId))
      .filter((entry): entry is StoreEntryMetadata => entry !== undefined);
    const internalDoc = await this.materializeDocumentFromPlan(
      docId,
      allEntryMetadata,
      branchEntries,
      plan.snapshotEntryId,
      plan.entryIdsToApply,
      plan.headCreatedAt,
    );
    this.performanceCallback?.onHistoryOperation?.({
      operation: "materializeDocumentBranchAtEntry",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: allEntryMetadata.length,
      returnedEntries: internalDoc ? 1 : 0,
      bounded: true,
    });
    if (!internalDoc) {
      return null;
    }
    return {
      docId,
      headEntryId: plan.headEntryId,
      headCreatedAt: plan.headCreatedAt,
      headCreatedByPublicKey: plan.headCreatedByPublicKey,
      snapshotEntryId: plan.snapshotEntryId,
      entryIdsApplied: [...plan.entryIdsToApply],
      branchEntryIds: [...plan.branchEntryIds],
      doc: this.wrapDocument(internalDoc),
    };
  }

  async materializeDocumentBranchAtTimestamp(
    docId: string,
    timestamp: DocumentDagAnalysisTimestamp,
    headEntryId: string,
  ): Promise<DocumentDagBranchMaterializationResult | null> {
    const startedAt = Date.now();
    const resolvedTimestamp = this.resolveDagTimestamp(timestamp);
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    const relevantEntries = allEntryMetadata
      .filter((entry) => entry.createdAt <= resolvedTimestamp && isDagEntry(entry));
    const plan = computeBranchMaterializationPlan(docId, relevantEntries, headEntryId);
    if (!plan) {
      this.performanceCallback?.onHistoryOperation?.({
        operation: "materializeDocumentBranchAtTimestamp",
        docId,
        time: Date.now() - startedAt,
        scannedEntries: relevantEntries.length,
        returnedEntries: 0,
        bounded: true,
      });
      return null;
    }
    const metadataById = new Map(relevantEntries.map((entry) => [entry.id, entry]));
    const branchEntries = plan.branchEntryIds
      .map((entryId) => metadataById.get(entryId))
      .filter((entry): entry is StoreEntryMetadata => entry !== undefined);
    const internalDoc = await this.materializeDocumentFromPlan(
      docId,
      relevantEntries,
      branchEntries,
      plan.snapshotEntryId,
      plan.entryIdsToApply,
      resolvedTimestamp,
    );
    this.performanceCallback?.onHistoryOperation?.({
      operation: "materializeDocumentBranchAtTimestamp",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: relevantEntries.length,
      returnedEntries: internalDoc ? 1 : 0,
      bounded: true,
    });
    if (!internalDoc) {
      return null;
    }
    return {
      docId,
      headEntryId: plan.headEntryId,
      headCreatedAt: plan.headCreatedAt,
      headCreatedByPublicKey: plan.headCreatedByPublicKey,
      snapshotEntryId: plan.snapshotEntryId,
      entryIdsApplied: [...plan.entryIdsToApply],
      branchEntryIds: [...plan.branchEntryIds],
      doc: this.wrapDocument(internalDoc),
    };
  }

  async describeDocumentDagEntry(
    docId: string,
    entryId: string,
  ): Promise<DocumentDagEntryDetails | null> {
    const startedAt = Date.now();
    const metadata = await this.store.getEntryMetadata(entryId);
    if (!metadata || metadata.docId !== docId || !isDagEntry(metadata)) {
      this.performanceCallback?.onHistoryOperation?.({
        operation: "describeDocumentDagEntry",
        docId,
        time: Date.now() - startedAt,
        scannedEntries: metadata ? 1 : 0,
        returnedEntries: 0,
        bounded: true,
      });
      return null;
    }
    let decodedChange: DocumentDagDecodedChangeSummary | null = null;
    if (metadata.entryType !== "doc_snapshot") {
      const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
      const entries = await this.store.getEntries([entryId]);
      const entry = entries[0];
      if (entry) {
        let isValid = false;
        if (this._isAdminOnlyDb && entry.createdByPublicKey !== this.getAdminPublicKey()) {
          this.logger.warn(`Admin-only DB: skipping DAG details for ${entry.id} not signed by admin key`);
        } else {
          isValid = await this.tenant.verifySignature(
            entry.encryptedData,
            entry.signature,
            entry.createdByPublicKey,
          );
        }
        if (isValid) {
          const decryptedPayload = await this.tenant.decryptPayload(
            entry.encryptedData,
            entry.decryptionKeyId,
          );
          const decodedAutomergeChange = Automerge.decodeChange(decryptedPayload) as Record<string, unknown>;
          decodedChange = this.summarizeDecodedChange(decodedAutomergeChange);
          decodedChange.touchedPaths = await this.deriveReadableTouchedPaths(
            docId,
            metadata,
            allEntryMetadata,
            decodedChange.touchedKeys,
          );
        }
      }
    }
    const parsed = parseDocEntryId(metadata.id);
    const result: DocumentDagEntryDetails = {
      docId,
      entryId: metadata.id,
      entryType: metadata.entryType,
      createdAt: metadata.createdAt,
      createdByPublicKey: metadata.createdByPublicKey,
      dependencyIds: [...metadata.dependencyIds],
      snapshotHeadEntryIds: [...(metadata.snapshotHeadEntryIds ?? [])],
      snapshotHeadHashes: [...(metadata.snapshotHeadHashes ?? [])],
      automergeHash: parsed?.automergeHash ?? null,
      decodedChange,
    };
    this.performanceCallback?.onHistoryOperation?.({
      operation: "describeDocumentDagEntry",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: 1,
      returnedEntries: 1,
      bounded: true,
    });
    return result;
  }

  /**
   * Derives human-readable changed field paths for one DAG entry.
   *
   * This compares the branch-local document state at the selected entry with each
   * reachable parent state, then normalizes array indices so the UI can show stable
   * paths such as `_attachments[].fileName` instead of raw Automerge op keys only.
   */
  private async deriveReadableTouchedPaths(
    docId: string,
    entryMetadata: StoreEntryMetadata,
    allEntryMetadata: StoreEntryMetadata[],
    touchedKeys: string[],
  ): Promise<string[]> {
    if (entryMetadata.entryType === "doc_snapshot") {
      return [];
    }

    const currentDoc = await this.materializeBranchInternalDoc(docId, allEntryMetadata, entryMetadata.id);
    const currentData = this.getReadableDiffValueForDoc(currentDoc);
    const parentEntryIds = entryMetadata.dependencyIds.filter((dependencyId) =>
      allEntryMetadata.some((entry) => entry.id === dependencyId),
    );
    const diffPaths = new Set<string>();

    if (parentEntryIds.length === 0) {
      this.collectReadableDiffPaths(undefined, currentData, "", diffPaths);
    } else {
      for (const parentEntryId of parentEntryIds) {
        const parentDoc = await this.materializeBranchInternalDoc(docId, allEntryMetadata, parentEntryId);
        const parentData = this.getReadableDiffValueForDoc(parentDoc);
        this.collectReadableDiffPaths(parentData, currentData, "", diffPaths);
      }
    }

    const normalizedPaths = Array.from(diffPaths)
      .map((path) => path.replace(/\[\d+\]/g, "[]"))
      .filter((path, index, allPaths) => path.length > 0 && allPaths.indexOf(path) === index)
      .sort();
    if (normalizedPaths.length === 0) {
      return [];
    }

    const touchedKeySet = new Set(touchedKeys);
    if (touchedKeySet.size === 0) {
      return normalizedPaths;
    }

    const filteredPaths = normalizedPaths.filter((path) => touchedKeySet.has(this.extractLeafPathSegment(path)));
    return filteredPaths.length > 0 ? filteredPaths : normalizedPaths;
  }

  async getAllDocumentIds(): Promise<string[]> {
    // Return all non-deleted document IDs from index
    const docIds: string[] = [];
    for (const entry of this.index) {
      if (!entry.isDeleted) {
        docIds.push(entry.docId);
      }
    }
    return docIds;
  }

  async getDeletedDocumentIds(): Promise<string[]> {
    const docIds: string[] = [];
    for (const entry of this.index) {
      if (entry.isDeleted) {
        docIds.push(entry.docId);
      }
    }
    return docIds;
  }

  async getAllDocumentIdsAtTimestamp(timestamp: number): Promise<string[]> {
    // findEntries() uses an exclusive upper bound (createdAt < creationDateUntil).
    // Query up to timestamp + 1 so entries created exactly at `timestamp` are included
    // for the strict checks below (createTime < timestamp, deleteTime > timestamp).
    const upperBoundExclusive =
      timestamp === Number.MAX_SAFE_INTEGER ? timestamp : timestamp + 1;

    // Efficiently query for doc_create and doc_delete entries before the timestamp
    const [creates, deletes] = await Promise.all([
      this.store.findEntries("doc_create", null, upperBoundExclusive),
      this.store.findEntries("doc_delete", null, upperBoundExclusive)
    ]);
    
    // Build sets of docIds for efficient lookup
    const createdDocIds = new Set<string>();
    const deletedDocIds = new Set<string>();
    
    // Track earliest create time for each doc
    const createTimes = new Map<string, number>();
    for (const entry of creates) {
      const existingTime = createTimes.get(entry.docId);
      if (!existingTime || entry.createdAt < existingTime) {
        createTimes.set(entry.docId, entry.createdAt);
        createdDocIds.add(entry.docId);
      }
    }
    
    // Track earliest delete time for each doc
    const deleteTimes = new Map<string, number>();
    for (const entry of deletes) {
      const existingTime = deleteTimes.get(entry.docId);
      if (!existingTime || entry.createdAt < existingTime) {
        deleteTimes.set(entry.docId, entry.createdAt);
        deletedDocIds.add(entry.docId);
      }
    }
    
    // Find documents that existed at the timestamp
    const docIds: string[] = [];
    
    for (const docId of createdDocIds) {
      const createTime = createTimes.get(docId)!;
      const deleteTime = deleteTimes.get(docId);
      
      // Document exists at timestamp if:
      // 1. It was created at or before the timestamp
      // 2. Either it was never deleted, or it was deleted after the timestamp
      if (createTime <= timestamp) {
        if (!deleteTime || deleteTime > timestamp) {
          docIds.push(docId);
        }
      }
    }
    
    return docIds;
  }

  async deleteDocument(docId: string): Promise<void> {
    return this.deleteDocInternal(docId);
  }

  async deleteDocumentWithSigningKey(
    docId: string,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void> {
    return this.deleteDocInternal(docId, signingKeyPair, signingKeyPassword);
  }

  /**
   * Internal method to delete a document.
   * Handles both regular deletion (signed by current user) and
   * deletion with a custom signing key (e.g., for directory operations).
   */
  private async deleteDocInternal(
    docId: string,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<void> {
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    this.logger.debug(`Deleting document ${docId}${useCustomSigningKey ? ' using custom signing key' : ''}`);
    
    // Admin-only validation: only admin key can modify data in admin-only databases
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomSigningKey 
        ? signingKeyPair!.publicKey 
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
    
    // Get current document
    const internalDoc = await this.loadDocumentInternal(docId);
    if (!internalDoc || internalDoc.isDeleted) {
      throw new Error(`Document ${docId} not found or already deleted`);
    }
    
    const now = Date.now();

    // Create deletion change by clearing all fields from the document
    // This ensures Automerge produces actual change bytes
    // The deletion is also tracked via the "doc_delete" type entry in the append-only store
    const newDoc = Automerge.change(internalDoc.doc, (doc: MindooDocPayload) => {
      // Remove all fields from the document
      for (const key of Object.keys(doc)) {
        delete (doc as Record<string, unknown>)[key];
      }
      // Mark as deleted for clarity
      (doc as Record<string, unknown>)._deleted = true;
      (doc as Record<string, unknown>)._lastModified = now;
    });
    
    // Get the change bytes from the document
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    
    // Decode the change to get hash and dependencies
    const decodedChange = Automerge.decodeChange(changeBytes);
    const automergeHash = decodedChange.hash;
    const automergeDepHashes = decodedChange.deps || []; // Dependencies from the decoded change

    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);

    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());

    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());

    // Resolve Automerge dependency hashes to entry IDs
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);

    // Sign the encrypted payload - either with custom key or current user's key
    let signature: Uint8Array;
    let createdByPublicKey: string;
    
    if (useCustomSigningKey) {
      this.logger.debug(`Signing deletion for document ${docId} with provided key`);
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair!, signingKeyPassword!);
      createdByPublicKey = signingKeyPair!.publicKey;
    } else {
      this.logger.debug(`Signing deletion for document ${docId} with current user's key`);
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }

    // Create entry metadata with type "doc_delete" to mark this as a deletion entry in the store
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_delete",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: now,
      createdByPublicKey,
      decryptionKeyId: internalDoc.decryptionKeyId,
      signature,
      originalSize: changeBytes.length,
      encryptedSize: encryptedPayload.length,
    };

    // Create full entry object
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };

    // Store entry
    await this.store.putEntries([fullEntry]);

    // Register automerge hash -> entry ID mapping
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);

    // Update cache and index
    internalDoc.isDeleted = true;
    internalDoc.lastModified = now;
    this.storeCachedDocument(internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, true);
    this.markDocDirty(docId);
    
    this.logger.info(`Document ${docId} deleted successfully`);
  }

  async changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>
  ): Promise<void> {
    return this.changeDocInternal(doc, changeFunc);
  }

  async changeDocWithSigningKey(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void> {
    return this.changeDocInternal(doc, changeFunc, signingKeyPair, signingKeyPassword);
  }

  private async changeDocInternal(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<void> {
    const docId = doc.getId();
    const useCustomKey = signingKeyPair && signingKeyPassword;
    this.logger.debug(`===== ${useCustomKey ? 'changeDocWithSigningKey' : 'changeDoc'} called for document ${docId} =====`);
    
    // Admin-only validation: only admin key can modify data in admin-only databases
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomKey 
        ? signingKeyPair!.publicKey 
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
    
    // Get internal document from cache or load it
    let internalDoc = this.getCachedDocument(docId);
    if (!internalDoc) {
      this.logger.debug(`Document ${docId} not in cache, loading from store`);
      const loadedDoc = await this.loadDocumentInternal(docId);
      if (!loadedDoc) {
        throw new Error(`Document ${docId} not found`);
      }
      internalDoc = loadedDoc;
      this.logger.debug(`Successfully loaded document ${docId} from store for ${useCustomKey ? 'changeDocWithSigningKey' : 'changeDoc'}`);
    } else {
      this.logger.debug(`Document ${docId} found in cache`);
    }
    
    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }
    
    // Apply the change function
    const now = Date.now();
    this.logger.debug(`Applying change function to document ${docId}`);
    this.logger.debug(`Document state before change: heads=${JSON.stringify(Automerge.getHeads(internalDoc.doc))}`);
    
    // For async callbacks, we need to handle document modifications carefully.
    // Automerge.change() requires synchronous modifications, so we'll:
    // 1. Execute the async callback to do any async work (like signing)
    // 2. Apply document modifications synchronously within Automerge.change()
    // 
    // We use a two-phase approach: the callback can do async work and collect
    // what needs to be changed, then we apply those changes in Automerge.change()
    const pendingChanges = new Map<string, unknown>();
    const pendingDeletions = new Set<string>();
    
    // Track pending attachment operations
    const pendingAttachmentAdditions: AttachmentReference[] = [];
    const pendingAttachmentRemovals = new Set<string>();
    // Map of attachmentId -> {lastChunkId, sizeIncrease} for appends
    const pendingAttachmentAppends = new Map<string, { lastChunkId: string; sizeIncrease: number }>();
    
    // Reference to db for closures
    const db = this;
    
    // Guard flag to prevent operations after callback completes
    // This ensures changes can only be made during the callback execution
    let isCallbackActive = true;
    
    const throwIfCallbackInactive = (methodName: string) => {
      if (!isCallbackActive) {
        throw new Error(`${methodName}() cannot be called after changeDoc() callback has completed. Document changes can only be made within the callback.`);
      }
    };
    
    // Create a document wrapper that collects changes
    const collectingDoc: MindooDoc = {
      getDatabase: () => this,
      getId: () => docId,
      getCreatedAt: () => internalDoc.createdAt,
      getLastModified: () => internalDoc.lastModified,
      getDecryptionKeyId: () => internalDoc.decryptionKeyId,
      isDeleted: () => false,
      getData: () => {
        // Return a proxy that collects property assignments and deletions
        const currentData = internalDoc.doc as unknown as MindooDocPayload;
        return new Proxy(currentData, {
          set: (target, prop, value) => {
            throwIfCallbackInactive('set property');
            if (typeof prop === 'string') {
              // If this property was marked for deletion, remove it from deletions
              pendingDeletions.delete(prop);
              // Track the change
              pendingChanges.set(prop, value);
              // NOTE: Don't set on target immediately - Automerge requires changes
              // to be made inside Automerge.change(). Pending changes are applied later.
            }
            return true;
          },
          deleteProperty: (target, prop) => {
            throwIfCallbackInactive('delete property');
            if (typeof prop === 'string') {
              // Mark for deletion
              pendingDeletions.add(prop);
              // Remove from pending changes if it was there
              pendingChanges.delete(prop);
              // NOTE: Don't delete from target immediately - Automerge requires changes
              // to be made inside Automerge.change(). Pending deletions are applied later.
            }
            return true;
          },
          get: (target, prop) => {
            // If marked for deletion, return undefined
            if (typeof prop === 'string' && pendingDeletions.has(prop)) {
              return undefined;
            }
            // Check pending changes first, then target
            if (typeof prop === 'string' && pendingChanges.has(prop)) {
              return pendingChanges.get(prop);
            }
            return (target as any)[prop];
          },
          has: (target, prop) => {
            // If marked for deletion, it doesn't exist
            if (typeof prop === 'string' && pendingDeletions.has(prop)) {
              return false;
            }
            // Check pending changes first, then target
            if (typeof prop === 'string' && pendingChanges.has(prop)) {
              return true;
            }
            return prop in target;
          }
        }) as MindooDocPayload;
      },
      
      // ========== Attachment Write Methods (work in changeDoc context) ==========
      
      addAttachment: async (
        fileData: Uint8Array,
        fileName: string,
        mimeType: string,
        keyId?: string
      ): Promise<AttachmentReference> => {
        throwIfCallbackInactive('addAttachment');
        const decryptionKeyId = keyId || internalDoc.decryptionKeyId;
        const ref = await db.addAttachmentInternal(
          docId,
          fileData,
          fileName,
          mimeType,
          decryptionKeyId,
          now
        );
        pendingAttachmentAdditions.push(ref);
        return ref;
      },
      
      addAttachmentStream: async (
        dataStream: AsyncIterable<Uint8Array>,
        fileName: string,
        mimeType: string,
        keyId?: string
      ): Promise<AttachmentReference> => {
        throwIfCallbackInactive('addAttachmentStream');
        const decryptionKeyId = keyId || internalDoc.decryptionKeyId;
        const ref = await db.addAttachmentStreamInternal(
          docId,
          dataStream,
          fileName,
          mimeType,
          decryptionKeyId,
          now
        );
        pendingAttachmentAdditions.push(ref);
        return ref;
      },
      
      removeAttachment: async (attachmentId: string): Promise<void> => {
        throwIfCallbackInactive('removeAttachment');
        // Check if attachment exists (either in current doc or pending additions)
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        const existingAttachments = (payload._attachments as AttachmentReference[]) || [];
        const existsInDoc = existingAttachments.some(a => a.attachmentId === attachmentId);
        const existsInPending = pendingAttachmentAdditions.some(a => a.attachmentId === attachmentId);
        
        if (!existsInDoc && !existsInPending) {
          throw new Error(`Attachment ${attachmentId} not found in document ${docId}`);
        }
        
        // If it was added in this same changeDoc call, just remove from pending
        const pendingIndex = pendingAttachmentAdditions.findIndex(a => a.attachmentId === attachmentId);
        if (pendingIndex >= 0) {
          pendingAttachmentAdditions.splice(pendingIndex, 1);
        } else {
          // Mark for removal from existing attachments
          pendingAttachmentRemovals.add(attachmentId);
        }
      },
      
      appendToAttachment: async (attachmentId: string, data: Uint8Array): Promise<void> => {
        throwIfCallbackInactive('appendToAttachment');
        // Find the attachment reference
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        const existingAttachments = (payload._attachments as AttachmentReference[]) || [];
        let ref = existingAttachments.find(a => a.attachmentId === attachmentId);
        
        // Also check pending additions
        if (!ref) {
          ref = pendingAttachmentAdditions.find(a => a.attachmentId === attachmentId);
        }
        
        if (!ref) {
          throw new Error(`Attachment ${attachmentId} not found in document ${docId}`);
        }
        
        // Determine the previous lastChunkId (might have been updated by previous append in this changeDoc)
        let prevLastChunkId = ref.lastChunkId;
        const prevAppend = pendingAttachmentAppends.get(attachmentId);
        if (prevAppend) {
          prevLastChunkId = prevAppend.lastChunkId;
        }
        
        // Append the data by creating new chunks
        const { lastChunkId, sizeIncrease } = await db.appendToAttachmentInternal(
          docId,
          attachmentId,
          ref.decryptionKeyId,
          prevLastChunkId,
          data,
          now
        );
        
        // Track the append
        const existingAppend = pendingAttachmentAppends.get(attachmentId);
        if (existingAppend) {
          existingAppend.lastChunkId = lastChunkId;
          existingAppend.sizeIncrease += sizeIncrease;
        } else {
          pendingAttachmentAppends.set(attachmentId, { lastChunkId, sizeIncrease });
        }
      },
      
      // ========== Attachment Read Methods (also work in changeDoc context) ==========
      
      getAttachments: (): AttachmentReference[] => {
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        const existing = (payload._attachments as AttachmentReference[]) || [];
        // Filter out removals and add pending additions
        const filtered = existing.filter(a => !pendingAttachmentRemovals.has(a.attachmentId));
        return [...filtered, ...pendingAttachmentAdditions];
      },
      
      getAttachment: async (attachmentId: string): Promise<Uint8Array> => {
        return db.getAttachmentInternal(docId, attachmentId);
      },
      
      getAttachmentRange: async (
        attachmentId: string,
        startByte: number,
        endByte: number
      ): Promise<Uint8Array> => {
        return db.getAttachmentRangeInternal(docId, attachmentId, startByte, endByte);
      },
      
      streamAttachment: (
        attachmentId: string,
        startOffset: number = 0
      ): AsyncGenerator<Uint8Array, void, unknown> => {
        return db.streamAttachmentInternal(docId, attachmentId, startOffset);
      },
    };
    
    // Execute the async callback (this may do async operations like signing)
    await changeFunc(collectingDoc);
    
    // Deactivate the callback guard - no more changes can be made via collectingDoc
    isCallbackActive = false;
    
    // Now apply the collected changes synchronously in Automerge.change()
    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    try {
      newDoc = Automerge.change(internalDoc.doc, (automergeDoc: MindooDocPayload) => {
        // Apply all pending changes (sets/updates)
        for (const [key, value] of pendingChanges) {
          (automergeDoc as any)[key] = value;
        }
        
        // Apply all pending deletions
        for (const key of pendingDeletions) {
          delete (automergeDoc as any)[key];
        }
        
        // Apply pending attachment changes
        if (pendingAttachmentAdditions.length > 0 || pendingAttachmentRemovals.size > 0 || pendingAttachmentAppends.size > 0) {
          // Initialize _attachments array if needed
          if (!automergeDoc._attachments) {
            automergeDoc._attachments = [];
          }
          const attachments = automergeDoc._attachments as AttachmentReference[];
          
          // Remove attachments marked for removal
          for (const attachmentId of pendingAttachmentRemovals) {
            const index = attachments.findIndex(a => a.attachmentId === attachmentId);
            if (index >= 0) {
              attachments.splice(index, 1);
            }
          }
          
          // Apply appends (update lastChunkId and size)
          for (const [attachmentId, { lastChunkId, sizeIncrease }] of pendingAttachmentAppends) {
            const attachment = attachments.find(a => a.attachmentId === attachmentId);
            if (attachment) {
              attachment.lastChunkId = lastChunkId;
              attachment.size += sizeIncrease;
            }
          }
          
          // Add new attachments
          for (const ref of pendingAttachmentAdditions) {
            attachments.push(ref);
          }
        }
        
        // Update lastModified timestamp
        automergeDoc._lastModified = now;
      });
      this.logger.debug(`Successfully applied change function, new document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      this.logger.error(`Error in Automerge.change for document ${docId}:`, error);
      throw error;
    }
    
    // Get the change bytes from the document
    this.logger.debug(`Getting change bytes from document ${docId}`);
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      //TODO decide if we just exit here or throw an error
      throw new Error("Failed to get change bytes from Automerge document");
    }
    this.logger.debug(`Got change bytes: ${changeBytes.length} bytes`);
    
    // Decode the change to get hash and dependencies
    const decodedChange = Automerge.decodeChange(changeBytes);
    const automergeHash = decodedChange.hash;
    const automergeDepHashes = decodedChange.deps || []; // Dependencies from the decoded change

    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);

    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());

    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    this.logger.debug(`Generated entry ID for change: ${entryId}`);

    // Resolve Automerge dependency hashes to entry IDs
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);

    // Sign the encrypted payload - use custom key if provided, otherwise current user's key
    let signature: Uint8Array;
    let createdByPublicKey: string;

    if (useCustomKey) {
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair, signingKeyPassword);
      createdByPublicKey = signingKeyPair.publicKey;
    } else {
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }

    // Create entry metadata
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_change",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: now,
      createdByPublicKey,
      decryptionKeyId: internalDoc.decryptionKeyId,
      signature,
      originalSize: changeBytes.length,
      encryptedSize: encryptedPayload.length,
    };

    // Create full entry object
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };

    // Store entry
    await this.store.putEntries([fullEntry]);

    // Register automerge hash -> entry ID mapping
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);

    // Update cache and index
    internalDoc.doc = newDoc;
    internalDoc.lastModified = now;
    this.storeCachedDocument(internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, internalDoc.isDeleted);
    this.markDocDirty(docId);
    
    this.logger.info(`Document ${docId} ${useCustomKey ? 'changed with custom signing key' : 'changed'} successfully`);

    // Snapshot creation runs as a best-effort background optimization.
    await this.maybeWriteSnapshotForDocument(
      internalDoc,
      useCustomKey
        ? { signingKeyPair, signingKeyPassword, createdByPublicKey }
        : { createdByPublicKey },
    );
  }

  /**
   * Best-effort snapshot scheduling and writing.
   * A snapshot is written only when enough replay history has accumulated and
   * a cooldown window has elapsed, to avoid snapshot churn on hot documents.
   */
  private async maybeWriteSnapshotForDocument(
    internalDoc: InternalDoc,
    options: {
      signingKeyPair?: SigningKeyPair;
      signingKeyPassword?: string;
      createdByPublicKey: string;
    },
  ): Promise<void> {
    const docId = internalDoc.id;
    try {
      const allMetadata = await this.scanAllMetadata(this.store, { docId });
      const replayEntries = allMetadata.filter(
        (em) => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete",
      );
      const snapshots = allMetadata
        .filter((em) => em.entryType === "doc_snapshot")
        .sort((a, b) => b.createdAt - a.createdAt);
      const latestSnapshot = snapshots[0] || null;
      const latestSnapshotAt = latestSnapshot?.createdAt ?? 0;
      const changesSinceSnapshot = replayEntries.filter((em) => em.createdAt > latestSnapshotAt).length;
      if (changesSinceSnapshot < this.snapshotMinChanges) {
        return;
      }
      if (
        latestSnapshot &&
        Date.now() - latestSnapshot.createdAt < this.snapshotCooldownMs
      ) {
        return;
      }

      const headHashes = Automerge.getHeads(internalDoc.doc);
      const headEntryIds = this.resolveAutomergeDepsToEntryIds(docId, headHashes);
      const snapshotBytes = Automerge.save(internalDoc.doc);
      const encryptedPayload = await this.tenant.encryptPayload(snapshotBytes, internalDoc.decryptionKeyId);
      const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());
      const pseudoSnapshotHash = `snapshot-${uuidv7()}`;
      const entryId = await generateDocEntryId(docId, pseudoSnapshotHash, headHashes, this.getSubtle());

      let signature: Uint8Array;
      if (options.signingKeyPair && options.signingKeyPassword) {
        signature = await this.tenant.signPayloadWithKey(
          encryptedPayload,
          options.signingKeyPair,
          options.signingKeyPassword,
        );
      } else {
        signature = await this.tenant.signPayload(encryptedPayload);
      }

      const snapshotEntry: StoreEntry = {
        entryType: "doc_snapshot",
        id: entryId,
        contentHash,
        docId,
        dependencyIds: headEntryIds,
        createdAt: Date.now(),
        createdByPublicKey: options.createdByPublicKey,
        decryptionKeyId: internalDoc.decryptionKeyId,
        snapshotHeadHashes: headHashes,
        snapshotHeadEntryIds: headEntryIds,
        signature,
        originalSize: snapshotBytes.length,
        encryptedSize: encryptedPayload.length,
        encryptedData: encryptedPayload,
      };

      await this.store.putEntries([snapshotEntry]);
      this.logger.debug(
        `Created snapshot for document ${docId} with ${headHashes.length} heads and ${changesSinceSnapshot} changes since previous snapshot`,
      );
    } catch (error) {
      this.logger.warn(`Failed to create snapshot for document ${docId}, continuing without snapshot`, error);
    }
  }

  private async prefetchIterationWindow(
    indexSnapshot: Array<{
      docId: string;
      changeSeq: number;
      lastModified: number;
      isDeleted: boolean;
    }>,
    startIndex: number
  ): Promise<number> {
    if (this.iteratePrefetchWindowDocs <= 0) {
      return 0;
    }

    const docIds: string[] = [];
    const seen = new Set<string>();
    // Only look ahead a bounded number of uncached docs so iteration does not
    // materialize the entire remaining changefeed tail up front.
    for (
      let i = startIndex;
      i < indexSnapshot.length && docIds.length < this.iteratePrefetchWindowDocs;
      i++
    ) {
      const docId = indexSnapshot[i].docId;
      if (seen.has(docId) || this.docCache.has(docId)) {
        continue;
      }
      seen.add(docId);
      docIds.push(docId);
    }

    if (docIds.length === 0) {
      return 0;
    }

    // Prefetch is opportunistic: iteration can still fall back to on-demand
    // loads, so individual prefetch failures are logged and ignored here.
    await Promise.all(
      docIds.map((docId) =>
        this.loadDocumentInternal(docId).catch((err) => {
          this.logger.warn(`Failed to prefetch document ${docId}:`, err);
          return null;
        })
      )
    );

    return docIds.length;
  }

  private getStartIndexForCursor(
    indexSnapshot: Array<{
      docId: string;
      changeSeq: number;
      lastModified: number;
      isDeleted: boolean;
    }>,
    actualCursor: ProcessChangesCursor
  ): number {
    let startIndex = 0;
    if (indexSnapshot.length === 0) {
      return startIndex;
    }

    const cursorSeq =
      typeof actualCursor.changeSeq === "number" ? actualCursor.changeSeq : 0;

    let left = 0;
    let right = indexSnapshot.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const entry = indexSnapshot[mid];
      const cursorComparable = {
        docId: actualCursor.docId,
        changeSeq: cursorSeq,
      };
      const cmp = this.compareIndexEntries(cursorComparable, entry);

      if (cmp < 0) {
        right = mid - 1;
        startIndex = mid;
      } else {
        left = mid + 1;
        startIndex = mid + 1;
      }
    }

    if (startIndex < indexSnapshot.length) {
      const entry = indexSnapshot[startIndex];
      if (entry.changeSeq === cursorSeq && entry.docId === actualCursor.docId) {
        startIndex++;
      }
    }

    return startIndex;
  }

  private resolveDagTimestamp(timestamp: DocumentDagAnalysisTimestamp): number {
    return timestamp === "now" ? Date.now() : timestamp;
  }

  private previewChangeValue(value: unknown): string | null {
    if (value === undefined) {
      return null;
    }
    if (typeof value === "string") {
      return value.length > 80 ? `${value.slice(0, 77)}...` : value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value === null) {
      return "null";
    }
    try {
      const serialized = JSON.stringify(value);
      if (!serialized) {
        return null;
      }
      return serialized.length > 80 ? `${serialized.slice(0, 77)}...` : serialized;
    } catch {
      return String(value);
    }
  }

  /**
   * Materializes a single branch-local document state for a specific DAG head.
   *
   * This is the internal building block used by DAG inspection helpers when they
   * need the document exactly as that branch would have looked at `headEntryId`.
   */
  private async materializeBranchInternalDoc(
    docId: string,
    allEntryMetadata: StoreEntryMetadata[],
    headEntryId: string,
  ): Promise<InternalDoc | null> {
    const plan = computeBranchMaterializationPlan(docId, allEntryMetadata, headEntryId);
    if (!plan) {
      return null;
    }
    const metadataById = new Map(allEntryMetadata.map((entry) => [entry.id, entry]));
    const branchEntries = plan.branchEntryIds
      .map((entryId) => metadataById.get(entryId))
      .filter((entry): entry is StoreEntryMetadata => entry !== undefined);
    return this.materializeDocumentFromPlan(
      docId,
      allEntryMetadata,
      branchEntries,
      plan.snapshotEntryId,
      plan.entryIdsToApply,
      plan.headCreatedAt,
    );
  }

  /**
   * Converts an internal doc into a plain JS value that is safe to diff for UI summaries.
   *
   * Deleted or missing docs are normalized to `undefined` so the diff code can treat
   * creation/deletion as ordinary before/after transitions.
   */
  private getReadableDiffValueForDoc(internalDoc: InternalDoc | null): unknown {
    if (!internalDoc || internalDoc.isDeleted) {
      return undefined;
    }
    return this.wrapDocument(internalDoc).getData();
  }

  /**
   * Walks two plain JS values and records the changed field paths.
   *
   * Arrays are tracked by index first and later normalized to `[]` for display,
   * which keeps attachment-style changes readable in the DAG explorer.
   */
  private collectReadableDiffPaths(
    beforeValue: unknown,
    afterValue: unknown,
    basePath: string,
    results: Set<string>,
  ): void {
    if (Object.is(beforeValue, afterValue)) {
      return;
    }

    if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
      const beforeArray = Array.isArray(beforeValue) ? beforeValue : [];
      const afterArray = Array.isArray(afterValue) ? afterValue : [];
      const maxLength = Math.max(beforeArray.length, afterArray.length);
      if (maxLength === 0 && basePath) {
        results.add(basePath);
        return;
      }
      for (let index = 0; index < maxLength; index++) {
        this.collectReadableDiffPaths(
          beforeArray[index],
          afterArray[index],
          `${basePath}[${index}]`,
          results,
        );
      }
      return;
    }

    if (this.isPlainDiffObject(beforeValue) || this.isPlainDiffObject(afterValue)) {
      const beforeObject = this.isPlainDiffObject(beforeValue) ? beforeValue : {};
      const afterObject = this.isPlainDiffObject(afterValue) ? afterValue : {};
      const childKeys = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
      if (childKeys.size === 0 && basePath) {
        results.add(basePath);
        return;
      }
      for (const key of childKeys) {
        const nextPath = basePath ? `${basePath}.${key}` : key;
        this.collectReadableDiffPaths(beforeObject[key], afterObject[key], nextPath, results);
      }
      return;
    }

    if (basePath) {
      results.add(basePath);
    }
  }

  /**
   * Returns true for diffable object literals and false for arrays/binary payloads.
   */
  private isPlainDiffObject(value: unknown): value is Record<string, unknown> {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && !(value instanceof Uint8Array);
  }

  /**
   * Extracts the terminal field name from a normalized path for loose key/path matching.
   */
  private extractLeafPathSegment(path: string): string {
    const normalizedPath = path.replace(/\[\]/g, "");
    const segments = normalizedPath.split(".");
    return segments[segments.length - 1] ?? normalizedPath;
  }

  /**
   * Produces a compact, UI-oriented summary of a decoded Automerge change.
   *
   * The raw Automerge ops are reduced to counts, touched keys, and a short list of
   * previewable operations so Haven can show useful change context without dumping
   * the full decoded structure.
   */
  private summarizeDecodedChange(decodedChange: Record<string, unknown>): DocumentDagDecodedChangeSummary {
    const operations = Array.isArray(decodedChange.ops) ? decodedChange.ops : [];
    const actionCounts: Record<string, number> = {};
    const touchedKeys = new Set<string>();
    const summarizedOperations = operations.slice(0, 12).map((operation) => {
      const op = operation as Record<string, unknown>;
      const action = typeof op.action === "string" ? op.action : "unknown";
      actionCounts[action] = (actionCounts[action] ?? 0) + 1;
      const key = typeof op.key === "string"
        ? op.key
        : typeof op.elemId === "string"
          ? op.elemId
          : null;
      if (typeof op.key === "string") {
        touchedKeys.add(op.key);
      }
      return {
        action,
        key,
        obj: typeof op.obj === "string" ? op.obj : null,
        insert: typeof op.insert === "boolean" ? op.insert : undefined,
        valuePreview: this.previewChangeValue(op.value),
      };
    });
    for (const operation of operations.slice(12)) {
      const op = operation as Record<string, unknown>;
      const action = typeof op.action === "string" ? op.action : "unknown";
      actionCounts[action] = (actionCounts[action] ?? 0) + 1;
      if (typeof op.key === "string") {
        touchedKeys.add(op.key);
      }
    }
    return {
      actorId: typeof decodedChange.actor === "string" ? decodedChange.actor : null,
      hash: typeof decodedChange.hash === "string" ? decodedChange.hash : null,
      seq: typeof decodedChange.seq === "number" ? decodedChange.seq : null,
      message: typeof decodedChange.message === "string" ? decodedChange.message : null,
      dependencyHashes: Array.isArray(decodedChange.deps)
        ? decodedChange.deps.filter((dep): dep is string => typeof dep === "string")
        : [],
      opCount: operations.length,
      actionCounts,
      touchedKeys: Array.from(touchedKeys).sort(),
      touchedPaths: [],
      operations: summarizedOperations,
    };
  }

  /**
   * Rebuilds a document from a materialization plan produced by the DAG/history planners.
   *
   * The plan may start from a compatible snapshot and then replay incremental changes,
   * or fall back to a full replay if no usable snapshot is available.
   */
  private async materializeDocumentFromPlan(
    docId: string,
    allEntryMetadata: StoreEntryMetadata[],
    replayEntriesForState: StoreEntryMetadata[],
    snapshotEntryId: string | null,
    entryIdsToApply: string[],
    fallbackTimestamp: number,
  ): Promise<InternalDoc | null> {
    if (replayEntriesForState.length === 0 && !snapshotEntryId) {
      return null;
    }
    const metadataById = new Map(allEntryMetadata.map((entry) => [entry.id, entry]));
    let startFromSnapshot = snapshotEntryId !== null;
    const snapshotMeta = snapshotEntryId ? (metadataById.get(snapshotEntryId) || null) : null;
    if (startFromSnapshot && !snapshotMeta) {
      this.logger.warn(
        `Materialization referenced snapshot ${snapshotEntryId} not found in metadata for ${docId}; falling back to replay without snapshot`,
      );
      startFromSnapshot = false;
    }

    let doc: AutomergeTypes.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotMeta) {
      const snapshotEntries = await this.store.getEntries([snapshotMeta.id]);
      if (snapshotEntries.length > 0) {
        const snapshotData = snapshotEntries[0];
        let isValid = false;
        if (this._isAdminOnlyDb && snapshotData.createdByPublicKey !== this.getAdminPublicKey()) {
          this.logger.warn(`Admin-only DB: skipping snapshot ${snapshotData.id} not signed by admin key`);
        } else {
          isValid = await this.tenant.verifySignature(
            snapshotData.encryptedData,
            snapshotData.signature,
            snapshotData.createdByPublicKey,
          );
        }
        if (!isValid) {
          this.logger.warn(`Invalid signature for snapshot ${snapshotData.id}, falling back to replay without snapshot`);
          startFromSnapshot = false;
        } else {
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.encryptedData,
            snapshotData.decryptionKeyId,
          );
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);
          const parsed = parseDocEntryId(snapshotData.id);
          if (parsed) {
            this.registerAutomergeHashMapping(docId, parsed.automergeHash, snapshotData.id);
          }
        }
      }
    }

    if (!doc) {
      doc = Automerge.init<MindooDocPayload>();
    }

    const entriesToApply = entryIdsToApply
      .map((id) => metadataById.get(id))
      .filter((entry): entry is StoreEntryMetadata => entry !== undefined);
    const loadedEntries = entriesToApply.length > 0
      ? await this.store.getEntries(entriesToApply.map((entry) => entry.id))
      : [];
    const entryById = new Map(loadedEntries.map((entry) => [entry.id, entry]));
    for (const entryMeta of entriesToApply) {
      const entryData = entryById.get(entryMeta.id);
      if (!entryData) {
        this.logger.warn(`Entry ${entryMeta.id} not found in store, skipping`);
        continue;
      }
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        continue;
      }
      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey,
      );
      if (!isValid) {
        this.logger.warn(`Invalid signature for entry ${entryData.id}, skipping`);
        continue;
      }
      const decryptedPayload = await this.tenant.decryptPayload(
        entryData.encryptedData,
        entryData.decryptionKeyId,
      );
      doc = Automerge.loadIncremental(doc, decryptedPayload);
      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
    }

    const orderedReplayEntries = [...replayEntriesForState].sort((left, right) =>
      left.createdAt !== right.createdAt ? left.createdAt - right.createdAt : left.id.localeCompare(right.id),
    );
    const firstReplayEntry = orderedReplayEntries[0] ?? null;
    const lastReplayEntry = orderedReplayEntries[orderedReplayEntries.length - 1] ?? null;
    return {
      id: docId,
      doc,
      createdAt: firstReplayEntry?.createdAt ?? snapshotMeta?.createdAt ?? fallbackTimestamp,
      lastModified: lastReplayEntry?.createdAt ?? snapshotMeta?.createdAt ?? fallbackTimestamp,
      decryptionKeyId: firstReplayEntry?.decryptionKeyId ?? snapshotMeta?.decryptionKeyId ?? "default",
      isDeleted: lastReplayEntry?.entryType === "doc_delete",
    };
  }

  async *iterateChangeMetadataSince(
    cursor: ProcessChangesCursor | null
  ): AsyncGenerator<ProcessChangeSummaryResult, void, unknown> {
    const startedAt = Date.now();
    const actualCursor: ProcessChangesCursor = cursor ?? {
      changeSeq: 0,
      lastModified: 0,
      docId: "",
    };
    const indexSnapshot = [...this.index];
    const startIndex = this.getStartIndexForCursor(indexSnapshot, actualCursor);
    let yieldedDocuments = 0;

    try {
      for (let i = startIndex; i < indexSnapshot.length; i++) {
        const entry = indexSnapshot[i];
        const currentCursor: ProcessChangesCursor = {
          changeSeq: entry.changeSeq,
          lastModified: entry.lastModified,
          docId: entry.docId,
        };
        yieldedDocuments++;
        yield {
          docId: entry.docId,
          lastModified: entry.lastModified,
          isDeleted: entry.isDeleted,
          cursor: currentCursor,
        };
      }
    } finally {
      this.performanceCallback?.onSyncOperation?.({
        operation: "iterateChangeMetadataSince",
        time: Date.now() - startedAt,
        details: {
          yieldedDocuments,
          startIndex,
        },
      });
    }
  }

  getLatestChangeCursor(): ProcessChangesCursor | null {
    const latestEntry = this.index[this.index.length - 1];
    if (!latestEntry) {
      return null;
    }
    return {
      changeSeq: latestEntry.changeSeq,
      lastModified: latestEntry.lastModified,
      docId: latestEntry.docId,
    };
  }

  seedStoreScanCursor(cursor: StoreScanCursor | null): void {
    if (!cursor || this.index.length > 0 || this.processedEntryIds.length > 0) {
      return;
    }
    if (
      this.processedEntryCursor
      && (
        this.processedEntryCursor.receiptOrder > cursor.receiptOrder
        || (
          this.processedEntryCursor.receiptOrder === cursor.receiptOrder
          && this.processedEntryCursor.id >= cursor.id
        )
      )
    ) {
      return;
    }

    this.processedEntryCursor = cursor;
    this.cacheMetaDirty = true;
    this.cacheManager?.markDirty();
  }

  async *iterateChangesSince(
    cursor: ProcessChangesCursor | null
  ): AsyncGenerator<ProcessChangesResult, void, unknown> {
    const startedAt = Date.now();
    // Default to initial cursor if null is provided.
    // Prefer deterministic sequence-based cursoring; keep legacy fallback compatibility.
    const actualCursor: ProcessChangesCursor = cursor ?? { changeSeq: 0, lastModified: 0, docId: "" };
    this.logger.debug(`Starting iteration from cursor ${JSON.stringify(actualCursor)}`);

    // Use a stable snapshot of the index for this generator run so concurrent
    // updates do not reorder/skip entries while iterating.
    const indexSnapshot = [...this.index];

    // Find starting position using binary search
    // We want to find the first entry that is greater than the cursor.
    const startIndex = this.getStartIndexForCursor(indexSnapshot, actualCursor);

    let prefetchedDocuments = await this.prefetchIterationWindow(
      indexSnapshot,
      startIndex
    );
    let yieldedDocuments = 0;
    let loadedDocuments = 0;
    
    try {
      // Iterate through the stable snapshot and yield documents one at a time.
      for (let i = startIndex; i < indexSnapshot.length; i++) {
        const entry = indexSnapshot[i];
        
        try {
          this.logger.debug(`Yielding document ${entry.docId} from index (lastModified: ${entry.lastModified}, isDeleted: ${entry.isDeleted})`);
          
          let internalDoc: InternalDoc | null = this.getCachedDocument(entry.docId);
          
          if (!internalDoc) {
            this.logger.debug(`Document ${entry.docId} not in cache, loading from store`);
            internalDoc = await this.loadDocumentInternal(entry.docId);
            if (internalDoc) {
              loadedDocuments++;
            }
          }

          if (!internalDoc) {
            this.logger.warn(`Document ${entry.docId} not found, skipping`);
            continue;
          }
          
          // Wrap the document (works for both deleted and non-deleted documents)
          const doc = this.wrapDocument(internalDoc);
          this.logger.debug(`Successfully loaded document ${entry.docId} (isDeleted: ${doc.isDeleted()})`);
          
          // Create cursor for current document
          const currentCursor: ProcessChangesCursor = {
            changeSeq: entry.changeSeq,
            lastModified: entry.lastModified,
            docId: entry.docId,
          };
          
          // Yield immediately - this allows the caller to break early after each document
          // Deleted documents are included so external indexes can handle deletions
          yieldedDocuments++;
          yield { doc, cursor: currentCursor };
          prefetchedDocuments += await this.prefetchIterationWindow(
            indexSnapshot,
            i + 1
          );
        } catch (error) {
          this.logger.error(`Error processing document ${entry.docId}:`, error);
          // Stop processing on error
          throw error;
        }
      }
    } finally {
      this.logger.debug(`Iteration completed`);
      this.performanceCallback?.onSyncOperation?.({
        operation: "iterateChangesSince",
        time: Date.now() - startedAt,
        details: {
          yieldedDocuments,
          prefetchedDocuments,
          loadedDocuments,
          startIndex,
        },
      });
    }
  }

  /**
   * Incrementally update a cached document with new entries.
   * Returns the updated document, or null if document wasn't actually changed.
   */
  private async applyNewEntriesToCachedDocument(
    cachedDoc: InternalDoc,
    newEntryMetadata: StoreEntryMetadata[]
  ): Promise<InternalDoc | null> {
    const docId = cachedDoc.id;
    
    if (newEntryMetadata.length === 0) {
      this.logger.debug(`No new entries for cached document ${docId}`);
      return null; // No changes
    }
    
    this.logger.debug(`Applying ${newEntryMetadata.length} new entries to cached document ${docId}`);
    
    // Get current document heads to check if it changes
    const headsBefore = Automerge.getHeads(cachedDoc.doc);
    
    // Filter entries to only include change entries (exclude snapshots)
    const entriesToApply = newEntryMetadata.filter(
      em => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete"
    );
    
    if (entriesToApply.length === 0) {
      this.logger.debug(`No change entries to apply for document ${docId}`);
      return null; // No changes
    }
    
    const entriesById = new Map(entriesToApply.map((entry) => [entry.id, entry]));
    const orderedEntryIds = topologicalByDependencies(
      new Set(entriesToApply.map((entry) => entry.id)),
      entriesById,
    );
    
    // Load entries from store
    const entries = await this.store.getEntries(orderedEntryIds);
    
    // Filter entries for admin-only mode first
    const validEntries = entries.filter(entryData => {
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        return false;
      }
      return true;
    });
    
    if (validEntries.length === 0) {
      this.logger.debug(`No valid entries to process for cached document ${docId}`);
      return null;
    }
    
    // Batch signature verification with key caching
    // Group entries by public key to import each key only once
    const entriesByPublicKey = new Map<string, StoreEntry[]>();
    for (const entryData of validEntries) {
      if (!entriesByPublicKey.has(entryData.createdByPublicKey)) {
        entriesByPublicKey.set(entryData.createdByPublicKey, []);
      }
      entriesByPublicKey.get(entryData.createdByPublicKey)!.push(entryData);
    }

    // Import all unique public keys in parallel (with caching)
    const keyImportResults = await Promise.all(
      Array.from(entriesByPublicKey.keys()).map(async (publicKey) => {
        const cryptoKey = await this.getOrImportPublicKey(publicKey);
        return { publicKey, cryptoKey };
      })
    );

    // Create a map of public key -> CryptoKey for quick lookup
    const keyMap = new Map<string, CryptoKey>();
    for (const { publicKey, cryptoKey } of keyImportResults) {
      if (cryptoKey) {
        keyMap.set(publicKey, cryptoKey);
      }
    }

    // Verify all signatures in parallel using cached keys
    const signatureVerificationResults = await Promise.all(
      validEntries.map(async (entryData) => {
        const cryptoKey = keyMap.get(entryData.createdByPublicKey);
        if (!cryptoKey) {
          // Key was not trusted or failed to import
          return { entryData, isValid: false };
        }
        
        const isValid = await this.verifySignatureWithKey(
          cryptoKey,
          entryData.encryptedData,
          entryData.signature
        );
        return { entryData, isValid };
      })
    );
    
    // Filter out entries with invalid signatures
    const verifiedEntries = signatureVerificationResults
      .filter(({ isValid }) => isValid)
      .map(({ entryData }) => entryData);
    
    if (verifiedEntries.length === 0) {
      this.logger.debug(`No entries with valid signatures for cached document ${docId}`);
      return null;
    }
    
    // Parallel decryption - decrypt all entries concurrently
    const decryptionResults = await Promise.all(
      verifiedEntries.map(async (entryData) => {
        const decryptedPayload = await this.tenant.decryptPayload(
          entryData.encryptedData,
          entryData.decryptionKeyId
        );
        return { entryData, decryptedPayload };
      })
    );
    
    // Collect change bytes and register automerge hash mappings
    const changeBytes: Uint8Array[] = [];
    for (const { entryData, decryptedPayload } of decryptionResults) {
      changeBytes.push(decryptedPayload);
      
      // Register automerge hash -> entry ID mapping
      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
    }
    
    if (changeBytes.length === 0) {
      this.logger.debug(`No valid change bytes to apply for document ${docId}`);
      return null; // No changes
    }
    
    // Clone the cached document to avoid "outdated document" error
    // This happens when the document has been wrapped and returned to the user
    // Automerge marks documents as outdated when they're accessed, preventing direct mutation
    const clonedDoc = Automerge.clone(cachedDoc.doc);
    
    // Apply all changes at once (Automerge handles dependency ordering)
    const result = Automerge.applyChanges<MindooDocPayload>(clonedDoc, changeBytes);
    const updatedDoc = result[0] as AutomergeTypes.Doc<MindooDocPayload>;
    
    // Check if document actually changed
    const headsAfter = Automerge.getHeads(updatedDoc);
    const headsChanged = JSON.stringify(headsBefore) !== JSON.stringify(headsAfter);
    
    if (!headsChanged) {
      this.logger.debug(`Document ${docId} heads unchanged after applying new entries`);
      return null; // Document didn't actually change
    }
    
    this.logger.debug(`Document ${docId} changed: heads before=${JSON.stringify(headsBefore)}, after=${JSON.stringify(headsAfter)}`);
    
    // Update metadata
    const payload = updatedDoc as unknown as MindooDocPayload;
    const lastEntryCreatedAt = entries.reduce(
      (maxCreatedAt, entry) => Math.max(maxCreatedAt, entry.createdAt),
      cachedDoc.lastModified,
    );
    const lastModified = (payload._lastModified as number) || 
                         lastEntryCreatedAt;
    
    // Check if document was deleted
    const hasDeleteEntry = newEntryMetadata.some(em => em.entryType === "doc_delete");
    const isDeleted = hasDeleteEntry || cachedDoc.isDeleted;
    
    const updatedInternalDoc: InternalDoc = {
      id: docId,
      doc: updatedDoc,
      createdAt: cachedDoc.createdAt,
      lastModified,
      decryptionKeyId: cachedDoc.decryptionKeyId,
      isDeleted,
    };
    // Update cache
    this.storeCachedDocument(updatedInternalDoc);
    this.markDocDirty(docId);
    
    return updatedInternalDoc;
  }

  /**
   * Internal method to load a document from the content-addressed store
   */
  private async loadDocumentInternal(docId: string): Promise<InternalDoc | null> {
    const startedAt = Date.now();
    const cacheCheckStartedAt = Date.now();
    // Check cache first
    if (this.docCache.has(docId)) {
      this.logger.debug(`Document ${docId} found in cache, returning cached version`);
      const cached = this.getCachedDocument(docId)!;
      this.performanceCallback?.onDocumentLoad?.({
        docId,
        cacheHit: true,
        metadataEntriesScanned: 0,
        replayEntriesLoaded: 0,
        snapshotUsed: false,
        cacheCheckTime: Date.now() - cacheCheckStartedAt,
        storeQueryTime: 0,
        entryLoadTime: 0,
        signatureVerificationTime: 0,
        decryptionTime: 0,
        automergeTime: 0,
        totalTime: Date.now() - startedAt,
      });
      return cached;
    }
    
    this.logger.debug(`===== Starting to load document ${docId} from store =====`);
    const cacheCheckTime = Date.now() - cacheCheckStartedAt;
    let storeQueryTime = 0;
    let entryLoadTime = 0;
    let signatureVerificationTime = 0;
    let decryptionTime = 0;
    let automergeTime = 0;
    
    // Get all entry metadata for this document
    // TODO: Implement loading from last snapshot if available
    this.logger.debug(`Getting all entry hashes for document ${docId}`);
    const storeQueryStartedAt = Date.now();
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    storeQueryTime += Date.now() - storeQueryStartedAt;
    this.logger.debug(`Found ${allEntryMetadata.length} total entry hashes for document ${docId}`);
    
    if (allEntryMetadata.length === 0) {
      this.logger.debug(`No entry hashes found for document ${docId}, returning null`);
      this.performanceCallback?.onDocumentLoad?.({
        docId,
        cacheHit: false,
        metadataEntriesScanned: 0,
        replayEntriesLoaded: 0,
        snapshotUsed: false,
        cacheCheckTime,
        storeQueryTime,
        entryLoadTime,
        signatureVerificationTime,
        decryptionTime,
        automergeTime,
        totalTime: Date.now() - startedAt,
      });
      return null;
    }
    
    // Log all entry types
    const entryTypes = allEntryMetadata.map(em => `${em.entryType}@${em.createdAt}`).join(', ');
    this.logger.debug(`Entry types for ${docId}: ${entryTypes}`);
    
    const metadataById = new Map(allEntryMetadata.map((meta) => [meta.id, meta]));
    const planStartedAt = Date.now();
    const materializationPlan = computeDocumentMaterializationPlan(docId, allEntryMetadata, {
      includeDiagnostics: true,
    });
    const planTime = Date.now() - planStartedAt;
    this.performanceCallback?.onSyncOperation?.({
      operation: "planDocumentMaterialization",
      time: planTime,
      details: {
        docId,
        metadataEntriesScanned: allEntryMetadata.length,
        replayEntriesLoaded: materializationPlan.entryIdsToApply.length,
        snapshotEntryId: materializationPlan.snapshotEntryId,
        diagnostics: materializationPlan.diagnostics,
      },
    });
    let startFromSnapshot = materializationPlan.snapshotEntryId !== null;
    const snapshotMeta = materializationPlan.snapshotEntryId
      ? (metadataById.get(materializationPlan.snapshotEntryId) || null)
      : null;
    if (startFromSnapshot && !snapshotMeta) {
      this.logger.warn(`Planner referenced snapshot ${materializationPlan.snapshotEntryId} not found in metadata for ${docId}; falling back to replay without snapshot`);
      startFromSnapshot = false;
    }
    if (startFromSnapshot && snapshotMeta) {
      this.logger.debug(`Planner selected snapshot ${snapshotMeta.id} for ${docId}`);
    } else {
      this.logger.debug(`Planner did not select a snapshot for ${docId}`);
    }
    const entriesToLoad = materializationPlan.entryIdsToApply
      .map((id) => metadataById.get(id))
      .filter((m): m is StoreEntryMetadata => m !== undefined);
    this.logger.debug(
      `Planner returned ${entriesToLoad.length} replay entries for ${docId}; diagnostics=${JSON.stringify(materializationPlan.diagnostics || {})}`,
    );
    
    // Load the snapshot first if we have one
    let doc: AutomergeTypes.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotMeta) {
      this.logger.debug(`Loading snapshot for document ${docId}`);
      const snapshotLoadStartedAt = Date.now();
      const snapshotEntries = await this.store.getEntries([snapshotMeta.id]);
      entryLoadTime += Date.now() - snapshotLoadStartedAt;
      this.logger.debug(`Retrieved ${snapshotEntries.length} snapshot entry(s) from store`);
      if (snapshotEntries.length > 0) {
        const snapshotData = snapshotEntries[0];
        
        // Admin-only mode: only accept snapshots signed by admin
        let isValid = false;
        if (this._isAdminOnlyDb && snapshotData.createdByPublicKey !== this.getAdminPublicKey()) {
          this.logger.warn(`Admin-only DB: skipping snapshot ${snapshotData.id} not signed by admin key`);
        } else {
          // Verify signature against the encrypted snapshot (no decryption needed)
          // We sign the encrypted payload, so anyone can verify signatures without decryption keys
          const signatureStartedAt = Date.now();
          isValid = await this.tenant.verifySignature(
            snapshotData.encryptedData,
            snapshotData.signature,
            snapshotData.createdByPublicKey
          );
          signatureVerificationTime += Date.now() - signatureStartedAt;
        }
        if (!isValid) {
          this.logger.warn(`Invalid signature for snapshot ${snapshotData.id}, falling back to loading from scratch`);
          // Fall back to loading from scratch
          startFromSnapshot = false;
        } else {
          this.logger.debug(`Snapshot signature valid, decrypting snapshot`);
          // Decrypt snapshot (only after signature verification passes)
          const decryptStartedAt = Date.now();
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.encryptedData,
            snapshotData.decryptionKeyId
          );
          decryptionTime += Date.now() - decryptStartedAt;
          this.logger.debug(`Decrypted snapshot (${snapshotData.encryptedData.length} -> ${decryptedSnapshot.length} bytes)`);
          
          // Load snapshot using Automerge.load()
          // This deserializes a full document snapshot from binary data
          // According to Automerge docs: load() is equivalent to init() followed by loadIncremental()
          this.logger.debug(`Loading snapshot into Automerge document`);
          const automergeStartedAt = Date.now();
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);
          automergeTime += Date.now() - automergeStartedAt;
          this.logger.debug(`Successfully loaded snapshot, document heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
          
          // Register the snapshot's automerge hash -> entry ID mapping
          const parsed = parseDocEntryId(snapshotData.id);
          if (parsed) {
            this.registerAutomergeHashMapping(docId, parsed.automergeHash, snapshotData.id);
          }
        }
      }
    }

    // If we don't have a snapshot, start from scratch
    if (!doc) {
      this.logger.debug(`Initializing new Automerge document for ${docId}`);
      doc = Automerge.init<MindooDocPayload>();
      this.logger.debug(`Initialized empty document, heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
    }
    
    // Load and apply all entries
    this.logger.debug(`Fetching ${entriesToLoad.length} entries from store for document ${docId}`);
    const entryLoadStartedAt = Date.now();
    const entries = await this.store.getEntries(entriesToLoad.map(em => em.id));
    entryLoadTime += Date.now() - entryLoadStartedAt;
    this.logger.debug(`Retrieved ${entries.length} entries from store for document ${docId}`);
    this.logger.debug(`Loading document ${docId}: found ${entries.length} entries to apply (${startFromSnapshot ? 'starting from snapshot' : 'starting from scratch'})`);
    
    // Log current document state before applying entries
    this.logger.debug(`Document state before applying entries: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
    
    // Filter entries for admin-only mode first
    const validEntries = entries.filter(entryData => {
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        return false;
      }
      return true;
    });
    
    if (validEntries.length === 0) {
      this.logger.debug(`No valid entries to process for document ${docId}`);
    } else {
      // Batch signature verification with key caching
      // Group entries by public key to import each key only once
      this.logger.debug(`Verifying ${validEntries.length} signatures in parallel with key caching`);
      const entriesByPublicKey = new Map<string, StoreEntry[]>();
      for (const entryData of validEntries) {
        if (!entriesByPublicKey.has(entryData.createdByPublicKey)) {
          entriesByPublicKey.set(entryData.createdByPublicKey, []);
        }
        entriesByPublicKey.get(entryData.createdByPublicKey)!.push(entryData);
      }

      // Import all unique public keys in parallel (with caching)
      const keyImportResults = await Promise.all(
        Array.from(entriesByPublicKey.keys()).map(async (publicKey) => {
          const cryptoKey = await this.getOrImportPublicKey(publicKey);
          return { publicKey, cryptoKey };
        })
      );

      // Create a map of public key -> CryptoKey for quick lookup
      const keyMap = new Map<string, CryptoKey>();
      for (const { publicKey, cryptoKey } of keyImportResults) {
        if (cryptoKey) {
          keyMap.set(publicKey, cryptoKey);
        }
      }

      // Verify all signatures in parallel using cached keys
      const signatureStartedAt = Date.now();
      const signatureVerificationResults = await Promise.all(
        validEntries.map(async (entryData) => {
          const cryptoKey = keyMap.get(entryData.createdByPublicKey);
          if (!cryptoKey) {
            // Key was not trusted or failed to import
            return { entryData, isValid: false };
          }
          
          const isValid = await this.verifySignatureWithKey(
            cryptoKey,
            entryData.encryptedData,
            entryData.signature
          );
          return { entryData, isValid };
        })
      );
      signatureVerificationTime += Date.now() - signatureStartedAt;
      
      // Filter out entries with invalid signatures
      const verifiedEntries = signatureVerificationResults
        .filter(({ isValid }) => {
          if (!isValid) {
            this.logger.warn(`Invalid signature for entry, skipping`);
          }
          return isValid;
        })
        .map(({ entryData }) => entryData);
      
      if (verifiedEntries.length === 0) {
        this.logger.debug(`No entries with valid signatures for document ${docId}`);
      } else {
        // Parallel decryption - decrypt all entries concurrently
        // Automerge handles dependency buffering internally, so we can decrypt all in parallel
        this.logger.debug(`Decrypting ${verifiedEntries.length} entries in parallel`);
        const decryptionStartedAt = Date.now();
        const decryptionResults = await Promise.all(
          verifiedEntries.map(async (entryData) => {
            const decryptedPayload = await this.tenant.decryptPayload(
              entryData.encryptedData,
              entryData.decryptionKeyId
            );
            return { entryData, decryptedPayload };
          })
        );
        decryptionTime += Date.now() - decryptionStartedAt;
        
        // Collect change bytes and register automerge hash mappings
        const changeBytes: Uint8Array[] = [];
        for (const { entryData, decryptedPayload } of decryptionResults) {
          changeBytes.push(decryptedPayload);
          
          // Register the automerge hash -> entry ID mapping for future dependency resolution
          const parsed = parseDocEntryId(entryData.id);
          if (parsed) {
            this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
          }
        }
        
        // Batch apply all changes at once - Automerge handles dependency ordering
        if (changeBytes.length > 0) {
          this.logger.debug(`Applying ${changeBytes.length} changes to document ${docId} using batch applyChanges`);
          try {
            const automergeStartedAt = Date.now();
            const result = Automerge.applyChanges<MindooDocPayload>(doc!, changeBytes);
            doc = result[0] as AutomergeTypes.Doc<MindooDocPayload>;
            automergeTime += Date.now() - automergeStartedAt;
            this.logger.debug(`Successfully applied ${changeBytes.length} changes to document ${docId}`);
            this.logger.debug(`Document state after applying changes: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
          } catch (error) {
            this.logger.error(`Error applying changes to document ${docId}:`, error);
            this.logger.error(`Number of changes: ${changeBytes.length}`);
            throw error;
          }
        }
      }
    }
    
    // Extract metadata from document (doc is guaranteed to be defined at this point)
    this.logger.debug(`All entries applied successfully for document ${docId}`);
    this.logger.debug(`Final document heads: ${JSON.stringify(Automerge.getHeads(doc!))}`);
    const payload = doc! as unknown as MindooDocPayload;
    
    // Check if document was deleted by looking for a "doc_delete" type entry
    const hasDeleteEntry = allEntryMetadata.some(em => em.entryType === "doc_delete");
    const isDeleted = hasDeleteEntry;
    this.logger.debug(`Document ${docId} isDeleted: ${isDeleted}`);
    
    // The authoritative decryptionKeyId comes from the doc_create entry's metadata,
    // not from the Automerge payload (which does not store encryption metadata).
    const createEntry = allEntryMetadata.find(em => em.entryType === "doc_create");
    const decryptionKeyId = createEntry ? createEntry.decryptionKeyId : "default";
    // Get lastModified from payload, or use the timestamp of the last entry
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastModified = (payload._lastModified as number) || 
                         (lastEntry ? lastEntry.createdAt : Date.now());
    // Get createdAt from the first entry
    const firstEntry = allEntryMetadata.length > 0 ? allEntryMetadata[0] : null;
    const createdAt = firstEntry ? firstEntry.createdAt : lastModified;
    
    this.logger.debug(`Document ${docId} metadata: createdAt=${createdAt}, lastModified=${lastModified}, decryptionKeyId=${decryptionKeyId}`);
    
    const internalDoc: InternalDoc = {
      id: docId,
      doc: doc!, // doc is guaranteed to be defined at this point
      createdAt,
      lastModified,
      decryptionKeyId,
      isDeleted,
    };
    
    // Update cache
    this.storeCachedDocument(internalDoc);
    this.markDocDirty(docId);
    this.logger.debug(`===== Successfully loaded document ${docId} and cached it =====`);
    this.performanceCallback?.onDocumentLoad?.({
      docId,
      cacheHit: false,
      metadataEntriesScanned: allEntryMetadata.length,
      replayEntriesLoaded: entriesToLoad.length,
      snapshotUsed: startFromSnapshot && snapshotMeta !== null,
      cacheCheckTime,
      storeQueryTime,
      entryLoadTime,
      signatureVerificationTime,
      decryptionTime,
      automergeTime,
      totalTime: Date.now() - startedAt,
    });
    
    return internalDoc;
  }


  /**
   * Convert an Automerge document to a plain JS object, converting Text objects to strings.
   * If using native Automerge (react-native-automerge-generated), this uses the native
   * materialize() method which properly converts Text objects to strings.
   * Falls back to direct access if native backend is not available.
   */
  private convertAutomergeToJS(doc: AutomergeTypes.Doc<MindooDocPayload>): MindooDocPayload {
    // Check if this document has a native Automerge handle attached
    // The native implementation attaches metadata with Symbol.for('_am_meta')
    const STATE = Symbol.for('_am_meta');
    const meta = (doc as any)[STATE];

    if (meta && meta.handle && typeof meta.handle.materialize === 'function') {
      // Use native materialize() which properly converts Text objects to strings
      try {
        const materialized = meta.handle.materialize('/');
        return materialized as MindooDocPayload;
      } catch (error) {
        console.error('[MindooDB] Failed to materialize document:', error);
        // Fall through to direct access
      }
    }

    // Fallback: direct access (for WASM or if native fails)
    const result: Record<string, any> = {};
    const keys = Object.keys(doc);

    for (const key of keys) {
      const value = (doc as any)[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
        result[key] = this.convertAutomergeToJS(value as AutomergeTypes.Doc<MindooDocPayload>);
      } else if (Array.isArray(value)) {
        result[key] = value.map(item => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item) && !(item instanceof Uint8Array)) {
            return this.convertAutomergeToJS(item as AutomergeTypes.Doc<MindooDocPayload>);
          }
          return item;
        });
      } else {
        result[key] = value;
      }
    }

    return result as MindooDocPayload;
  }

  /**
   * Wrap an internal document in the MindooDoc interface.
   * This is the read-only wrapper - write methods throw errors.
   */
  private wrapDocument(internalDoc: InternalDoc): MindooDoc {
    const db = this;
    const docId = internalDoc.id;

    // Create a read-only proxy that throws on any modification attempts
    const createReadOnlyProxy = (target: MindooDocPayload): MindooDocPayload => {
      return new Proxy(target, {
        set: (_target, prop) => {
          throw new Error(`Cannot modify property '${String(prop)}' on read-only document. Use changeDoc() to modify documents.`);
        },
        deleteProperty: (_target, prop) => {
          throw new Error(`Cannot delete property '${String(prop)}' on read-only document. Use changeDoc() to modify documents.`);
        },
        get: (target, prop) => {
          const value = (target as Record<string | symbol, unknown>)[prop];
          // Recursively wrap nested objects (but not arrays or special types)
          if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
            return createReadOnlyProxy(value as MindooDocPayload);
          }
          return value;
        },
      }) as MindooDocPayload;
    };

    return {
      getDatabase: () => db,
      getId: () => docId,
      getCreatedAt: () => internalDoc.createdAt,
      getLastModified: () => internalDoc.lastModified,
      getDecryptionKeyId: () => internalDoc.decryptionKeyId,
      isDeleted: () => internalDoc.isDeleted,
      getData: () => {
        // Convert Automerge document to plain JS object, converting Text objects to strings
        const jsDoc = this.convertAutomergeToJS(internalDoc.doc);
        return createReadOnlyProxy(jsDoc);
      },
      
      // ========== Attachment Write Methods ==========
      // These throw errors in the read-only wrapper
      
      addAttachment: async () => {
        throw new Error("addAttachment() can only be called within changeDoc() callback");
      },
      
      addAttachmentStream: async () => {
        throw new Error("addAttachmentStream() can only be called within changeDoc() callback");
      },
      
      removeAttachment: async () => {
        throw new Error("removeAttachment() can only be called within changeDoc() callback");
      },
      
      appendToAttachment: async () => {
        throw new Error("appendToAttachment() can only be called within changeDoc() callback");
      },
      
      // ========== Attachment Read Methods ==========
      // These work in the read-only wrapper
      
      getAttachments: (): AttachmentReference[] => {
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        return (payload._attachments as AttachmentReference[]) || [];
      },
      
      getAttachment: async (attachmentId: string): Promise<Uint8Array> => {
        return db.getAttachmentInternal(docId, attachmentId);
      },
      
      getAttachmentRange: async (
        attachmentId: string,
        startByte: number,
        endByte: number
      ): Promise<Uint8Array> => {
        return db.getAttachmentRangeInternal(docId, attachmentId, startByte, endByte);
      },
      
      streamAttachment: (
        attachmentId: string,
        startOffset: number = 0
      ): AsyncGenerator<Uint8Array, void, unknown> => {
        return db.streamAttachmentInternal(docId, attachmentId, startOffset);
      },
    };
  }

  /**
   * Get an attachment reference by ID from a document's _attachments array.
   */
  private async getAttachmentRefInternal(docId: string, attachmentId: string): Promise<AttachmentReference> {
    const internalDoc = this.getCachedDocument(docId) ?? await this.loadDocumentInternal(docId);
    if (!internalDoc) {
      throw new Error(`Document ${docId} not found while reading attachment ${attachmentId}`);
    }
    const payload = internalDoc.doc as unknown as MindooDocPayload;
    const attachments = (payload._attachments as AttachmentReference[]) || [];
    const ref = attachments.find(a => a.attachmentId === attachmentId);
    if (!ref) {
      throw new Error(`Attachment ${attachmentId} not found in document ${docId}`);
    }
    return ref;
  }

  private async planAttachmentRead(
    store: ContentAddressedStore,
    ref: AttachmentReference,
    startByte: number,
    endByteExclusive: number,
  ) {
    if (store.planAttachmentReadByWalkingMetadata) {
      try {
        // if the store has a planAttachmentReadByWalkingMetadata method, use it for less overhead through the network
        return await store.planAttachmentReadByWalkingMetadata(ref.lastChunkId, ref.size, {
          startByte,
          endByteExclusive,
        });
      } catch (error) {
        this.logger.debug(
          "Store-level attachment read planner failed, falling back to local metadata walk",
          { attachmentId: ref.attachmentId, error }
        );
      }
    }
    // fall back to local metadata walk
    return planAttachmentReadByWalkingMetadata(store, ref.lastChunkId, ref.size, {
      startByte,
      endByteExclusive,
    });
  }

  private async decryptAttachmentChunk(chunk: StoreEntry): Promise<Uint8Array> {
    if (this._isAdminOnlyDb && chunk.createdByPublicKey !== this.getAdminPublicKey()) {
      throw new Error(`Admin-only DB: chunk ${chunk.id} not signed by admin key`);
    }

    const isValid = await this.tenant.verifySignature(
      chunk.encryptedData,
      chunk.signature,
      chunk.createdByPublicKey
    );
    if (!isValid) {
      throw new Error(`Invalid signature for chunk ${chunk.id}`);
    }

    const plaintext = await this.tenant.decryptAttachmentPayload(
      chunk.encryptedData,
      chunk.decryptionKeyId
    );
    if (plaintext.length !== chunk.originalSize) {
      throw new Error(
        `Attachment chunk ${chunk.id} decrypted to ${plaintext.length} bytes, expected ${chunk.originalSize}`,
      );
    }
    return plaintext;
  }

  /**
   * Internal method to fetch and concatenate all chunks for an attachment.
   */
  private async getAttachmentInternal(
    docId: string, 
    attachmentId: string
  ): Promise<Uint8Array> {
    this.logger.debug(`Getting attachment ${attachmentId} from document ${docId}`);
    
    const ref = await this.getAttachmentRefInternal(docId, attachmentId);
    const store = this.getEffectiveAttachmentStore();
    
    // Resolve dependency chain to get all chunk IDs in order (oldest first)
    const chunkIds = await store.resolveDependencies(ref.lastChunkId, { includeStart: true });
    this.logger.debug(`Resolved ${chunkIds.length} chunks for attachment ${attachmentId}`);
    
    // Fetch all chunks
    const chunks = await store.getEntries(chunkIds);
    
    // Verify signatures, decrypt, and collect plaintext chunks
    const plaintextChunks: Uint8Array[] = [];
    let totalSize = 0;
    
    for (const chunk of chunks) {
      const plaintext = await this.decryptAttachmentChunk(chunk);
      plaintextChunks.push(plaintext);
      totalSize += plaintext.length;
    }
    
    // Concatenate all chunks into final result
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of plaintextChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    this.logger.debug(`Retrieved attachment ${attachmentId}: ${result.length} bytes`);
    return result;
  }

  /**
   * Internal method to get a byte range from an attachment.
   */
  private async getAttachmentRangeInternal(
    docId: string,
    attachmentId: string,
    startByte: number,
    endByte: number
  ): Promise<Uint8Array> {
    this.logger.debug(`Getting attachment ${attachmentId} range [${startByte}, ${endByte}) from document ${docId}`);
    
    if (startByte < 0 || endByte <= startByte) {
      throw new Error(`Invalid byte range: [${startByte}, ${endByte})`);
    }
    
    const ref = await this.getAttachmentRefInternal(docId, attachmentId);
    const store = this.getEffectiveAttachmentStore();
    const readPlan = await this.planAttachmentRead(store, ref, startByte, endByte);
    const neededChunkIds = readPlan.chunkPlans.map((chunkPlan) => chunkPlan.id);
    const chunks = await store.getEntries(neededChunkIds);

    // Decrypt needed chunks
    const plaintextChunks: Uint8Array[] = [];
    for (const chunk of chunks) {
      const plaintext = await this.decryptAttachmentChunk(chunk);
      plaintextChunks.push(plaintext);
    }
    
    const totalNeededBytes = endByte - startByte;
    
    // Extract the requested range
    const result = new Uint8Array(totalNeededBytes);
    let resultOffset = 0;
    let bytesRemaining = totalNeededBytes;
    
    for (let i = 0; i < plaintextChunks.length && bytesRemaining > 0; i++) {
      const chunk = plaintextChunks[i];
      const chunkStart = i === 0 ? readPlan.offsetInFirstChunk : 0;
      const bytesToCopy = Math.min(chunk.length - chunkStart, bytesRemaining);
      result.set(chunk.slice(chunkStart, chunkStart + bytesToCopy), resultOffset);
      resultOffset += bytesToCopy;
      bytesRemaining -= bytesToCopy;
    }
    
    this.logger.debug(`Retrieved attachment ${attachmentId} range: ${result.length} bytes`);
    return result;
  }

  /**
   * Internal async generator to stream attachment data.
   */
  private async *streamAttachmentInternal(
    docId: string,
    attachmentId: string,
    startOffset: number
  ): AsyncGenerator<Uint8Array, void, unknown> {
    this.logger.debug(`Streaming attachment ${attachmentId} from offset ${startOffset}`);
    
    const ref = await this.getAttachmentRefInternal(docId, attachmentId);
    if (startOffset < 0 || startOffset > ref.size) {
      throw new Error(`Invalid stream offset ${startOffset} for attachment size ${ref.size}`);
    }
    if (ref.size === 0 || startOffset === ref.size) {
      return;
    }
    const store = this.getEffectiveAttachmentStore();
    const readPlan = await this.planAttachmentRead(store, ref, startOffset, ref.size);

    for (let i = 0; i < readPlan.chunkPlans.length; i += DEFAULT_ATTACHMENT_STREAM_BATCH_SIZE) {
      const chunkPlansBatch = readPlan.chunkPlans.slice(i, i + DEFAULT_ATTACHMENT_STREAM_BATCH_SIZE);
      const batchIds = chunkPlansBatch.map((chunkPlan) => chunkPlan.id);
      const chunks = await store.getEntries(batchIds);
      const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

      for (let batchIndex = 0; batchIndex < chunkPlansBatch.length; batchIndex++) {
        const chunkPlan = chunkPlansBatch[batchIndex];
        const chunk = chunkById.get(chunkPlan.id);
        if (!chunk) {
          throw new Error(
            `Attachment chunk ${chunkPlan.id} not found in store. The document metadata exists, but the attachment payload may not be synced locally yet.`,
          );
        }
        const plaintext = await this.decryptAttachmentChunk(chunk);

        // For first chunk, skip bytes before startOffset
        if (i === 0 && batchIndex === 0 && readPlan.offsetInFirstChunk > 0) {
          yield plaintext.slice(readPlan.offsetInFirstChunk);
        } else {
          yield plaintext;
        }
      }
    }
    
    this.logger.debug(`Finished streaming attachment ${attachmentId}`);
  }

  /**
   * Get the attachment store for this database.
   */
  private getEffectiveAttachmentStore(): ContentAddressedStore {
    return this.attachmentStore;
  }

  /**
   * Internal method to add an attachment by chunking the file and storing chunks.
   */
  private async addAttachmentInternal(
    docId: string,
    fileData: Uint8Array,
    fileName: string,
    mimeType: string,
    decryptionKeyId: string,
    createdAt: number
  ): Promise<AttachmentReference> {
    this.logger.debug(`Adding attachment to document ${docId}: ${fileName} (${fileData.length} bytes)`);
    
    const store = this.getEffectiveAttachmentStore();
    const currentUser = await this.tenant.getCurrentUserId();
    const attachmentId = generateFileUuid7();
    
    // Chunk the file
    const chunks: StoreEntry[] = [];
    let prevChunkId: string | null = null;
    let lastChunkId: string = "";
    
    for (let offset = 0; offset < fileData.length; offset += this.chunkSizeBytes) {
      const chunkData = fileData.slice(offset, Math.min(offset + this.chunkSizeBytes, fileData.length));
      
      // Encrypt chunk
      const encryptedData = await this.tenant.encryptAttachmentPayload(chunkData, decryptionKeyId);
      
      // Compute content hash
      const contentHash = await computeContentHash(encryptedData, this.getSubtle());
      
      // Generate chunk ID
      const chunkId = generateAttachmentChunkId(docId, attachmentId);
      lastChunkId = chunkId;
      
      // Sign the encrypted chunk
      const signature = await this.tenant.signPayload(encryptedData);
      
      // Create chunk entry
      const chunkEntry: StoreEntry = {
        entryType: "attachment_chunk",
        id: chunkId,
        contentHash,
        docId,
        dependencyIds: prevChunkId ? [prevChunkId] : [],
        createdAt,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };
      
      chunks.push(chunkEntry);
      prevChunkId = chunkId;
    }
    
    // Store all chunks
    await store.putEntries(chunks);
    this.logger.debug(`Stored ${chunks.length} chunks for attachment ${attachmentId}`);
    
    // Create attachment reference
    const ref: AttachmentReference = {
      attachmentId,
      fileName,
      mimeType,
      size: fileData.length,
      lastChunkId,
      decryptionKeyId,
      createdAt,
      createdBy: currentUser.userSigningPublicKey,
    };
    
    return ref;
  }

  /**
   * Internal method to add an attachment from a streaming data source.
   * Memory efficient - processes data chunk by chunk without loading entire file into memory.
   */
  private async addAttachmentStreamInternal(
    docId: string,
    dataStream: AsyncIterable<Uint8Array>,
    fileName: string,
    mimeType: string,
    decryptionKeyId: string,
    createdAt: number
  ): Promise<AttachmentReference> {
    this.logger.debug(`Adding streaming attachment to document ${docId}: ${fileName}`);
    
    const store = this.getEffectiveAttachmentStore();
    const currentUser = await this.tenant.getCurrentUserId();
    const attachmentId = generateFileUuid7();
    
    // Buffer to accumulate incoming data until we have a full chunk
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let totalSize = 0;
    let prevChunkId: string | null = null;
    let lastChunkId: string = "";
    let chunkCount = 0;
    
    // Helper to concatenate Uint8Arrays
    const concatArrays = (a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> => {
      const result = new Uint8Array(a.length + b.length);
      result.set(a, 0);
      result.set(b, a.length);
      return result;
    };
    
    // Helper to store a chunk
    const storeChunk = async (chunkData: Uint8Array): Promise<string> => {
      // Encrypt chunk
      const encryptedData = await this.tenant.encryptAttachmentPayload(chunkData, decryptionKeyId);
      
      // Compute content hash
      const contentHash = await computeContentHash(encryptedData, this.getSubtle());
      
      // Generate chunk ID
      const chunkId = generateAttachmentChunkId(docId, attachmentId);
      
      // Sign the encrypted chunk
      const signature = await this.tenant.signPayload(encryptedData);
      
      // Create chunk entry
      const chunkEntry: StoreEntry = {
        entryType: "attachment_chunk",
        id: chunkId,
        contentHash,
        docId,
        dependencyIds: prevChunkId ? [prevChunkId] : [],
        createdAt,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };
      
      // Store immediately (streaming - don't buffer chunks in memory)
      await store.putEntries([chunkEntry]);
      chunkCount++;
      
      return chunkId;
    };
    
    // Process incoming data stream
    for await (const chunk of dataStream) {
      // Add incoming data to buffer
      buffer = concatArrays(buffer, chunk);
      
      // Process complete chunks
      while (buffer.length >= this.chunkSizeBytes) {
        const chunkData = buffer.slice(0, this.chunkSizeBytes);
        buffer = buffer.slice(this.chunkSizeBytes);
        
        lastChunkId = await storeChunk(chunkData);
        prevChunkId = lastChunkId;
        totalSize += chunkData.length;
      }
    }
    
    // Store remaining data as final chunk (if any)
    if (buffer.length > 0) {
      lastChunkId = await storeChunk(buffer);
      totalSize += buffer.length;
    }
    
    this.logger.debug(`Stored ${chunkCount} chunks for streaming attachment ${attachmentId} (${totalSize} bytes)`);
    
    // Create attachment reference
    const ref: AttachmentReference = {
      attachmentId,
      fileName,
      mimeType,
      size: totalSize,
      lastChunkId,
      decryptionKeyId,
      createdAt,
      createdBy: currentUser.userSigningPublicKey,
    };
    
    return ref;
  }

  /**
   * Internal method to append data to an existing attachment.
   */
  private async appendToAttachmentInternal(
    docId: string,
    attachmentId: string,
    decryptionKeyId: string,
    prevLastChunkId: string,
    data: Uint8Array,
    createdAt: number
  ): Promise<{ lastChunkId: string; sizeIncrease: number }> {
    this.logger.debug(`Appending ${data.length} bytes to attachment ${attachmentId}`);
    
    const store = this.getEffectiveAttachmentStore();
    const currentUser = await this.tenant.getCurrentUserId();
    
    // Chunk the data
    const chunks: StoreEntry[] = [];
    let prevChunkId = prevLastChunkId;
    let lastChunkId = prevLastChunkId;
    
    for (let offset = 0; offset < data.length; offset += this.chunkSizeBytes) {
      const chunkData = data.slice(offset, Math.min(offset + this.chunkSizeBytes, data.length));
      
      // Encrypt chunk
      const encryptedData = await this.tenant.encryptAttachmentPayload(chunkData, decryptionKeyId);
      
      // Compute content hash
      const contentHash = await computeContentHash(encryptedData, this.getSubtle());
      
      // Generate chunk ID
      const chunkId = generateAttachmentChunkId(docId, attachmentId);
      lastChunkId = chunkId;
      
      // Sign the encrypted chunk
      const signature = await this.tenant.signPayload(encryptedData);
      
      // Create chunk entry with dependency on previous chunk
      const chunkEntry: StoreEntry = {
        entryType: "attachment_chunk",
        id: chunkId,
        contentHash,
        docId,
        dependencyIds: [prevChunkId],
        createdAt,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };
      
      chunks.push(chunkEntry);
      prevChunkId = chunkId;
    }
    
    // Store all chunks
    await store.putEntries(chunks);
    this.logger.debug(`Appended ${chunks.length} chunks to attachment ${attachmentId}`);
    
    return {
      lastChunkId,
      sizeIncrease: data.length,
    };
  }

  /**
   * Resolve a sync target to a ContentAddressedStore.
   * Accepts either a raw store or a MindooDB instance (calls getStore()).
   */
  private getStoreForKind(storeKind: StoreKind = StoreKind.docs): ContentAddressedStore {
    return storeKind === StoreKind.attachments ? this.attachmentStore : this.store;
  }

  private resolveStore(
    remote: ContentAddressedStore | MindooDB,
    storeKind: StoreKind = StoreKind.docs,
  ): ContentAddressedStore {
    if ('getStore' in remote && typeof (remote as MindooDB).getStore === 'function') {
      return storeKind === StoreKind.attachments
        ? (remote as MindooDB).getAttachmentStore()
        : (remote as MindooDB).getStore();
    }
    return remote as ContentAddressedStore;
  }

  /**
   * Apply a temporary network-auth identity override for a single sync call.
   *
   * Purpose:
   * - Allows per-call authentication as a different user (for example admin bootstrap)
   *   without changing the tenant's default connected user.
   * - Returns a cleanup callback so caller can always restore default auth state in `finally`.
   */
  private async applyNetworkAuthOverrideForSync(
    remoteStore: ContentAddressedStore,
    options?: SyncOptions
  ): Promise<() => void> {
    // Per-call override: use an alternate identity (for example, admin bootstrap)
    // only for this sync operation.
    const override = options?.networkAuthOverride;
    if (!override) {
      // No override requested: return a no-op cleanup callback for unified call sites.
      return () => {};
    }

    const overrideCapableStore = remoteStore as ContentAddressedStore & {
      setSyncAuthOverride?: (override: {
        username: string;
        signingKey: CryptoKey;
        privateEncryptionKey?: CryptoKey | string;
      } | null) => void;
      clearSyncAuthOverride?: () => void;
    };

    if (typeof overrideCapableStore.setSyncAuthOverride !== "function") {
      // Local/in-memory stores do not support network auth override; keep default auth.
      this.logger.warn("networkAuthOverride was provided, but remote store does not support auth override");
      return () => {};
    }

    const subtle = this.tenant.getCryptoAdapter().getSubtle();

    // Decrypt and import override signing key (Ed25519) for challenge signing.
    const signingKeyBuffer = await this.tenant.decryptPrivateKey(
      override.user.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      override.password,
      "signing"
    );
    const signingKey = await subtle.importKey(
      "pkcs8",
      signingKeyBuffer,
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    // Decrypt and import override encryption key (RSA-OAEP) so encrypted network
    // entries can be decrypted with the same override identity.
    const encryptionKeyBuffer = await this.tenant.decryptPrivateKey(
      override.user.userEncryptionKeyPair.privateKey as EncryptedPrivateKey,
      override.password,
      "encryption"
    );
    const encryptionKey = await subtle.importKey(
      "pkcs8",
      encryptionKeyBuffer,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"]
    );

    // Activate temporary override on the remote store.
    overrideCapableStore.setSyncAuthOverride({
      username: override.user.username,
      signingKey,
      privateEncryptionKey: encryptionKey,
    });

    // Return cleanup callback so caller can always restore normal auth in finally.
    return () => {
      if (typeof overrideCapableStore.clearSyncAuthOverride === "function") {
        overrideCapableStore.clearSyncAuthOverride();
      } else {
        // Backward-compatible fallback if explicit clear API is not implemented.
        overrideCapableStore.setSyncAuthOverride?.(null);
      }
    };
  }

  /**
   * Pull changes from a remote content-addressed store or another MindooDB instance.
   * 
   * This method:
   * 1. Finds entries in the remote store that we don't have locally
   * 2. Retrieves those entries from the remote store
   * 3. Stores them in our local store
   * 4. Syncs the local store to process the new entries
   *
   * The optional `storeKind` sync option selects which store is synced.
   * By default, this method syncs the docs store only.
   *
   * @param remote The remote store or MindooDB instance to pull entries from
   * @param options Optional sync options for progress tracking, paging, cancellation, and store selection
   * @return A promise that resolves with the sync result
   */
  async pullChangesFrom(remote: ContentAddressedStore | MindooDB, options?: SyncOptions): Promise<SyncResult> {
    const storeKind = options?.storeKind ?? StoreKind.docs;
    const localStore = this.getStoreForKind(storeKind);
    const remoteStore = this.resolveStore(remote, storeKind);

    if (localStore.getId() !== remoteStore.getId() || localStore.getStoreKind() !== remoteStore.getStoreKind()) {
      throw new Error(`[BaseMindooDB] Cannot pull entries from the incompatible store ${localStore.getId()}/${localStore.getStoreKind()}`);
    }

    this.logger.info(`Pulling entries from remote store ${remoteStore.getId()}/${remoteStore.getStoreKind()}`);
    const restoreAuthOverride = await this.applyNetworkAuthOverrideForSync(remoteStore, options);
    try {
      const syncResult = await this.syncEntriesFromStore(remoteStore, localStore, options);
      this.logger.debug(`Transferred ${syncResult.transferred} entries from remote store`);

      if (syncResult.cancelled) {
        this.logger.info(`Pull cancelled after transferring ${syncResult.transferred} entries`);
        return {
          transferredEntries: syncResult.transferred,
          scannedEntries: syncResult.scanned,
          cancelled: true,
        };
      }

      if (syncResult.transferred === 0) {
        this.logger.debug(`No new entries to pull`);
        return { transferredEntries: 0, scannedEntries: syncResult.scanned, cancelled: false };
      }
      
      options?.onProgress?.({
        phase: 'processing',
        message: `Processing ${syncResult.transferred} new entries...`,
        transferredEntries: syncResult.transferred,
        scannedEntries: syncResult.scanned,
      });

      // Sync the local store to process the new entries
      // This will update the index, cache, and processedEntryIds
      if (options?.signal?.aborted) {
        this.logger.info(`Pull cancelled before local processing after transferring ${syncResult.transferred} entries`);
        return {
          transferredEntries: syncResult.transferred,
          scannedEntries: syncResult.scanned,
          cancelled: true,
        };
      }
      if (storeKind === StoreKind.docs) {
        await this.syncStoreChanges();
      }
      if (options?.signal?.aborted) {
        this.logger.info(`Pull cancelled after local processing for ${storeKind} entries`);
        return {
          transferredEntries: syncResult.transferred,
          scannedEntries: syncResult.scanned,
          cancelled: true,
        };
      }
      
      this.logger.info(`Pull complete, synced ${syncResult.transferred} entries`);

      options?.onProgress?.({
        phase: 'complete',
        message: `Pull complete: ${syncResult.transferred} ${storeKind} entries synced`,
        transferredEntries: syncResult.transferred,
        scannedEntries: syncResult.scanned,
      });

      return {
        transferredEntries: syncResult.transferred,
        scannedEntries: syncResult.scanned,
        cancelled: false,
      };
    } finally {
      restoreAuthOverride();
    }
  }

  /**
   * Push changes to a remote content-addressed store or another MindooDB instance.
   * 
   * This method:
   * 1. Finds entries in our local store that the remote doesn't have
   * 2. Retrieves those entries from our local store
   * 3. Stores them in the remote store
   *
   * The optional `storeKind` sync option selects which store is synced.
   * By default, this method syncs the docs store only.
   *
   * @param remote The remote store or MindooDB instance to push entries to
   * @param options Optional sync options for progress tracking, paging, cancellation, and store selection
   * @return A promise that resolves with the sync result
   */
  async pushChangesTo(remote: ContentAddressedStore | MindooDB, options?: SyncOptions): Promise<SyncResult> {
    const storeKind = options?.storeKind ?? StoreKind.docs;
    const localStore = this.getStoreForKind(storeKind);
    const remoteStore = this.resolveStore(remote, storeKind);

    if (localStore.getId() !== remoteStore.getId() || localStore.getStoreKind() !== remoteStore.getStoreKind()) {
      throw new Error(`[BaseMindooDB] Cannot push entries to the incompatible store ${localStore.getId()}/${localStore.getStoreKind()}`);
    }

    this.logger.info(`Pushing entries to remote store ${remoteStore.getId()}/${remoteStore.getStoreKind()}`);
    const restoreAuthOverride = await this.applyNetworkAuthOverrideForSync(remoteStore, options);
    try {
      const syncResult = await this.syncEntriesFromStore(localStore, remoteStore, options);
      this.logger.debug(`Transferred ${syncResult.transferred} entries to remote store`);

      if (syncResult.cancelled) {
        this.logger.info(`Push cancelled after transferring ${syncResult.transferred} entries`);
        return {
          transferredEntries: syncResult.transferred,
          scannedEntries: syncResult.scanned,
          cancelled: true,
        };
      }

      if (syncResult.transferred === 0) {
        this.logger.debug(`No new entries to push`);
      } else {
        this.logger.info(`Pushed ${syncResult.transferred} entries to remote store`);
      }

      options?.onProgress?.({
        phase: 'complete',
        message: `Push complete: ${syncResult.transferred} entries transferred`,
        transferredEntries: syncResult.transferred,
        scannedEntries: syncResult.scanned,
      });

      return {
        transferredEntries: syncResult.transferred,
        scannedEntries: syncResult.scanned,
        cancelled: false,
      };
    } finally {
      restoreAuthOverride();
    }
  }
}

