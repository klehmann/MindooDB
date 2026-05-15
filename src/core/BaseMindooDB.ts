// Import platform-appropriate Automerge implementation
// React Native: native Rust (react-native-automerge-generated)
// Browser/Node.js: WASM (@automerge/automerge/slim)
import { Automerge } from "./automerge-adapter";
// Import types from WASM package (types are compatible across implementations)
import type * as AutomergeTypes from "@automerge/automerge/slim";
import { v7 as uuidv7 } from "uuid";
import {
  MindooDB,
  CreateOptions,
  DeleteOptions,
  UndeleteOptions,
  ChangeOptions,
  CUSTOM_DOC_ID_REGEX,
  DocumentDagAnalysisTimestamp,
  DocumentDagAnalysisResult,
  DocumentDagBranchMaterializationResult,
  DocumentDagDecodedChangeSummary,
  DocumentDagEntryDetails,
  DocumentConflictAnalysisEvent,
  DocumentConflictAnalysisOptions,
  DocumentConflictBaseValue,
  DocumentConflictBaseValueQuery,
  DocumentConflictLocation,
  DocumentConflictPath,
  DocumentConflictReport,
  DocumentConflictReportOptions,
  DocumentConflictSummary,
  DocumentConflictValueSummary,
  ConflictScanCheckpoint,
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
  IncompleteAttachmentUploadReclaimResult,
  SyncOptions,
  SyncResult,
  DocumentHistoryPageEntry,
  DocumentHistoryPageOptions,
  DocumentHistoryPageResult,
  MindooTextEdit,
  MindooJsonPatch,
  MindooJsonPatchResult,
  MindooTextPatch,
  MindooTextPatchResult,
  WarmerScheduler,
  StartBackgroundWarmerOptions,
  BackgroundWarmerProgress,
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
  isDeletedFromHeads,
  isDagEntry,
} from "./DocumentDagAnalysis";
import {
  computeDocumentConflictAnalysisPlan,
  formatDocumentConflictPath,
} from "./DocumentConflictAnalysis";
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
import { validateDatabaseId } from "./databaseIdValidation";
import type { LocalCacheStore } from "./cache/LocalCacheStore";
import type { ICacheable } from "./cache/CacheManager";
import type { CacheManager } from "./cache/CacheManager";

/**
 * Default chunk size for attachments: 256KB
 */
const DEFAULT_CHUNK_SIZE_BYTES = 256 * 1024;
const ATTACHMENT_WRITE_BATCH_BYTES = 16 * 1024 * 1024;
const ATTACHMENT_WRITE_RETRY_DELAYS_MS = [50, 250, 1000];
const DEFAULT_ATTACHMENT_STREAM_BATCH_SIZE = 4;
const DEFAULT_SNAPSHOT_MIN_CHANGES = 100;
const DEFAULT_SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHED_DOCS = 128;
const DEFAULT_ITERATE_PREFETCH_WINDOW_DOCS = 0;
const DEFAULT_WARMER_BATCH_SIZE = 50;
/**
 * Default number of cached documents fetched per `getMany` batch during
 * the eager startup restore. 256 is a balance between IDB transaction
 * overhead (favours larger batches) and transient memory pressure
 * during decryption (favours smaller batches): at ~50 KB/doc this is
 * roughly 25 MB of transient encrypted+decrypted bytes per batch.
 * Tunable via {@link DocumentCacheConfig.restoreBatchSize}.
 */
const DEFAULT_RESTORE_BATCH_SIZE = 256;

/**
 * Default {@link WarmerScheduler}: a simple `setTimeout(0)` yield that
 * works in Node, browsers, and React Native without pulling in any
 * runtime-specific APIs.
 */
const DEFAULT_WARMER_SCHEDULER: WarmerScheduler = {
  yield(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  },
};

/**
 * On-disk format version for L2 (persisted) document cache records.
 *
 * v1 (implicit): legacy header with `id, createdAt, lastModified,
 * decryptionKeyId, isDeleted` only. No version field.
 *
 * v2: explicit `version: 2` header, plus `changeSeq` and
 * `automergeHeads` so the L2 read path can detect freshness without
 * touching the document store, and apply only missing changes when
 * stale (see Phase 1c of the L1/L2 cache plan).
 *
 * v1 records are silently ignored on restore - the next read of that
 * doc falls through to the normal materialization path and re-flushes
 * with a v2 header.
 */
const DOC_CACHE_HEADER_VERSION = 2;

/**
 * Result of deserializing a persisted L2 document cache record.
 *
 * `internal` is the materialized {@link InternalDoc}. `persistedChangeSeq`
 * and `persistedHeads` are the freshness sentinels written at flush
 * time, used by the L2 read path to decide whether the record is up to
 * date or needs incremental delta application.
 *
 * Returned only for v2 records; v1 (legacy) records yield `null` so
 * callers can skip them gracefully.
 */
interface DeserializedCachedDoc {
  internal: InternalDoc;
  persistedChangeSeq: number;
  persistedHeads: string[];
}

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
 * Local visibility state for an index entry.
 *
 * - `"visible"`: the current tenant KeyBag can resolve the document's
 *   encryption key, so the doc participates in the public read paths
 *   (`getAllDocumentIds`, `iterateChangesSince`, virtual views, ...).
 * - `"inaccessible"`: the doc exists in the underlying store but the
 *   current KeyBag cannot decrypt it. The entry stays in the index as
 *   an internal tombstone so metadata-only consumers can emit a
 *   `isDeleted: true` change and removal from caches/views happens
 *   exactly once. The doc body is never materialized while in this
 *   state.
 *
 * Visibility is local cache/index state, *not* persisted into the
 * append-only store. The store entries are unchanged; only this
 * database instance's view of them flips.
 */
type DocumentAccessState = "visible" | "inaccessible";

/**
 * One row in the in-memory changefeed index.
 *
 * The index is the source of truth for what this `BaseMindooDB`
 * exposes to readers, ordered by `(changeSeq, docId)`. `decryptionKeyId`
 * and `accessState` are required to keep the visibility reconciliation
 * layer (see {@link BaseMindooDB.reconcileKeyVisibility}) self-contained:
 * they let cache/view consumers drop entries by key id without touching
 * document bodies, and let the read paths refuse to surface entries
 * whose key has been revoked.
 */
interface DocumentIndexEntry {
  /** Document id this entry represents. */
  docId: string;
  /** Monotonic local sequence assigned at the latest visibility transition. */
  changeSeq: number;
  /** Latest user-visible modification timestamp from the underlying store. */
  lastModified: number;
  /** Whether the latest known state is a tombstone (deleted *or* inaccessible). */
  isDeleted: boolean;
  /** Encryption key id used to decrypt this document's payload. */
  decryptionKeyId: string;
  /** See {@link DocumentAccessState}. */
  accessState: DocumentAccessState;
}

interface VerifiedReplayChange {
  entry: StoreEntryMetadata;
  changeBytes: Uint8Array;
  automergeHash: string | null;
  dependencyHashes: string[];
}

interface ConflictDetectionResult {
  conflicts: DocumentConflictSummary[];
  resolutions: Array<Extract<DocumentConflictAnalysisEvent, { type: "conflictResolved" }>>;
  entriesApplied: number;
}

/**
 * Hard-coded initial Automerge change bytes that seed every document created
 * with a caller-provided id (`createDocument({ id })`).
 *
 * Two replicas independently invoking `createDocument({ id: ... })` must
 * produce the same initial Automerge change bytes/hash so the resulting
 * `doc_create` entries converge. We hard-code the bytes (rather than
 * regenerating them at runtime) for two reasons recommended by the Automerge
 * cookbook:
 *
 *  1. Future Automerge releases may change change-byte encoding. Hard-coding
 *     pins the wire format we shipped, so old custom-id docs stay mergeable.
 *  2. It prevents accidental schema drift in this file from silently shifting
 *     the doc_create entry id of every newly-created custom-id document.
 *
 * To intentionally regenerate these bytes (a breaking change for existing
 * custom-id documents in the field), run
 *   `node scripts/regen-custom-id-initial-change.js`
 * paste the new array below, then update the expected hash in
 * `__tests__/CustomIdInitialChange.test.ts`.
 *
 * The encoded change is:
 *   actor: 00000000000000c0  (well-known, 8 bytes; only used for this seed)
 *   time:  0
 *   deps:  []
 *   ops:   set `_attachments` = []
 *   hash:  b55efb45769e62bff921fd6f4fbb325a446d788ded077ec2a625c32e7631a190
 */
/** @internal Exported for tests only; do not import from app code. */
export const CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES = new Uint8Array([
  133, 111,  74, 131, 181,  94, 251,  69,   1,  47,   0,   8,   0,   0,   0,   0,
    0,   0,   0, 192,   1,   1,   0,   0,   0,   5,  21,  14,  52,   1,  66,   2,
   86,   2, 112,   2, 127,  12,  95,  97, 116, 116,  97,  99, 104, 109, 101, 110,
  116, 115,   1, 127,   2, 127,   0, 127,   0,
]);

/**
 * Returns the hard-coded initial Automerge change bytes used to seed every
 * custom-id document. Callers must apply these bytes into a fresh
 * `Automerge.init()` so that subsequent edits use the replica's own actor id
 * while still sharing Automerge ancestry with peers.
 */
function getCustomIdInitialChangeBytes(): Uint8Array {
  return CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES;
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
  private readonly timeTravelDate: number | null;
  
  // Internal changefeed index: sorted by (changeSeq, docId) for deterministic iteration.
  // lastModified remains available for UX metadata but is not the primary cursor key.
  private index: DocumentIndexEntry[] = [];
  
  // Lookup map for O(1) access to index entries by docId
  private indexLookup: Map<string, number> = new Map(); // Map<docId, arrayIndex>
  private nextChangeSeq: number = 1;
  
  // Cache of loaded documents: Map<docId, InternalDoc>
  private docCache: Map<string, InternalDoc> = new Map();
  private readonly maxCachedDocs: number;
  private readonly iteratePrefetchWindowDocs: number;
  private readonly cacheRestoreLimit: number;
  private readonly cacheRestoreBatchSize: number;
  private readonly reconcileRestoredIndexOnInit: boolean;
  /**
   * When `true`, startup leaves the in-memory L1 cache empty and lets
   * subsequent reads pull documents lazily from L2 via
   * {@link tryLoadFromL2}. See `DocumentCacheConfig.restoreToL2`.
   */
  private readonly restoreToL2: boolean;
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

  /**
   * Tenant KeyBag fingerprint observed at the time the in-memory index
   * was last reconciled with the underlying store.
   *
   * Persisted alongside the cache checkpoint so warm starts can compare
   * the current fingerprint against the stored one and skip a full
   * metadata scan (and the associated REST round-trips against remote
   * stores) when the bag composition has not changed since the last
   * flush.
   *
   * Set to `null` when no reconciliation has been performed yet, or
   * when the tenant does not expose a fingerprint method.
   */
  private lastReconciledKeyBagFingerprint: string | null = null;

  // ---------------------------------------------------------------------------
  // Background L2 warmer state (single-flight + cancellation).
  // ---------------------------------------------------------------------------
  private readonly warmerBatchSize: number;
  private readonly warmerScheduler: WarmerScheduler;
  /**
   * Resolves when the currently-running warmer pass finishes. `null`
   * when no warmer is running. Re-used to enforce single-flight: a
   * second `startBackgroundWarmer()` call returns the same promise.
   */
  private warmerPromise: Promise<void> | null = null;
  /**
   * AbortController for the in-flight warmer. `null` when no warmer is
   * running. {@link stopBackgroundWarmer} aborts via this controller.
   */
  private warmerAbort: AbortController | null = null;
  /**
   * Snapshot of the most recent warmer pass's progress. Updated
   * in-place by {@link runBackgroundWarmer} so {@link getBackgroundWarmerProgress}
   * can return the current state without additional bookkeeping. Set
   * back to a fresh `{ processed: 0, total, phase: "warming" }` at the
   * start of each new pass; the final value (`"done"` or
   * `"cancelled"`) lingers between passes so a UI that mounts after
   * the warmer settled can still display its outcome.
   */
  private warmerProgress: BackgroundWarmerProgress | null = null;

  constructor(
    tenant: BaseMindooTenant, 
    store: ContentAddressedStore, 
    attachmentStore: ContentAddressedStore,
    attachmentConfig?: AttachmentConfig,
    documentCacheConfig?: DocumentCacheConfig,
    snapshotConfig?: SnapshotConfig,
    adminOnlyDb: boolean = false,
    logger?: Logger,
    performanceCallback?: PerformanceCallback,
    timeTravelDate: number | null = null,
  ) {
    validateDatabaseId(store.getId(), "dbId");
    validateDatabaseId(attachmentStore.getId(), "dbId");
    if (store.getId() !== attachmentStore.getId()) {
      throw new Error(
        `[BaseMindooDB] Expected document and attachment stores to share dbId but received ${store.getId()} and ${attachmentStore.getId()}`
      );
    }
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
    this.timeTravelDate = timeTravelDate;
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
    this.cacheRestoreBatchSize = Math.max(
      1,
      Math.floor(documentCacheConfig?.restoreBatchSize ?? DEFAULT_RESTORE_BATCH_SIZE)
    );
    this.reconcileRestoredIndexOnInit = documentCacheConfig?.reconcileRestoredIndexOnInit ?? false;
    this.restoreToL2 = documentCacheConfig?.restoreToL2 ?? false;
    this.warmerBatchSize = Math.max(
      1,
      Math.floor(documentCacheConfig?.warmer?.batchSize ?? DEFAULT_WARMER_BATCH_SIZE)
    );
    this.warmerScheduler =
      documentCacheConfig?.warmer?.scheduler ?? DEFAULT_WARMER_SCHEDULER;
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

  isTimeTravelMode(): boolean {
    return this.timeTravelDate !== null;
  }

  isReadOnly(): boolean {
    return this.isTimeTravelMode();
  }

  getTimeTravelDate(): number | null {
    return this.timeTravelDate;
  }

  private assertWritable(operation: string): void {
    if (this.isReadOnly()) {
      throw new Error(`${operation} is not allowed because database "${this.store.getId()}" is opened in time travel read-only mode.`);
    }
  }

  private metadataVisibleAtTimeTravelDate(metadata: StoreEntryMetadata): boolean {
    return this.timeTravelDate == null || metadata.createdAt < this.timeTravelDate;
  }

  private applyTimeTravelFilter(metadata: StoreEntryMetadata[]): StoreEntryMetadata[] {
    return this.timeTravelDate == null ? metadata : metadata.filter((entry) => this.metadataVisibleAtTimeTravelDate(entry));
  }

  private mergeTimeTravelScanFilters(filters?: StoreScanFilters): StoreScanFilters | undefined {
    if (this.timeTravelDate == null) {
      return filters;
    }
    const existingUntil = filters?.creationDateUntil ?? null;
    const creationDateUntil = existingUntil == null
      ? this.timeTravelDate
      : Math.min(existingUntil, this.timeTravelDate);
    return {
      ...filters,
      creationDateUntil,
    };
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
    // Safe to use the sync eviction here: a successful flush has just
    // drained `dirtyDocIds`, so there is nothing left to flush-before-evict.
    this.evictCleanCachedDocsIfNeeded();
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

  private async storeCachedDocument(internalDoc: InternalDoc): Promise<void> {
    this.touchCachedDocument(internalDoc.id, internalDoc);
    await this.evictCachedDocsIfNeeded(new Set([internalDoc.id]));
  }

  /**
   * Bring the in-memory L1 cache back under `maxCachedDocs` after a new
   * insert, performing flush-before-evict for any dirty entry that would
   * otherwise be dropped.
   *
   * Without flush-before-evict, an evicted dirty doc loses its in-memory
   * state before the periodic `CacheManager` flush has a chance to
   * persist it, forcing the next read to fall through to the expensive
   * full-materialization path. By writing the doc to L2 inline first, we
   * guarantee the next read can recover it via the cheap L2 read path
   * (Phase 1c) - either as a fresh hit (changeSeq matches) or as a
   * stale hit that only needs the missing deltas re-applied.
   *
   * If no `cacheManager` is attached (i.e. there is no L2 store
   * available), we fall back to the legacy behavior and just drop the
   * dirty marker - matching pre-Phase-1 semantics so embedders who
   * never opted into L2 see no behavior change.
   */
  private async evictCachedDocsIfNeeded(protectedDocIds?: Set<string>): Promise<void> {
    if (this.docCache.size <= this.maxCachedDocs) {
      return;
    }

    const store = this.cacheManager?.getStore() ?? null;
    const prefix = store ? this.getCachePrefix() : null;

    // Snapshot the iteration order to avoid surprises if a flush ever
    // re-touches a doc mid-loop. Map iteration in insertion order is the
    // LRU eviction order we want.
    const candidates: string[] = [];
    for (const docId of this.docCache.keys()) {
      candidates.push(docId);
    }

    for (const docId of candidates) {
      if (this.docCache.size <= this.maxCachedDocs) {
        break;
      }
      if (protectedDocIds?.has(docId)) {
        continue;
      }

      if (store && prefix && this.dirtyDocIds.has(docId)) {
        const internal = this.docCache.get(docId);
        if (internal) {
          try {
            await this.flushDirtyDocToCache(store, prefix, docId, internal);
          } catch (e) {
            this.logger.warn(
              `Flush-before-evict failed for doc ${docId}; dropping dirty marker without persisting: ${e}`
            );
          }
        }
      }

      this.docCache.delete(docId);
      this.dirtyDocIds.delete(docId);
    }
  }

  /**
   * Synchronous eviction variant used after the periodic flush has
   * already drained `dirtyDocIds`. No L2 work is required because there
   * are no dirty docs left to persist.
   */
  private evictCleanCachedDocsIfNeeded(protectedDocIds?: Set<string>): void {
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

      await this.flushDirtyDocToCache(store, prefix, docId, internal);
      written++;
    }

    // Write metadata checkpoint
    const meta = this.exportMetadataCheckpoint();
    await store.put("db-meta", prefix, meta);
    written++;

    return written;
  }

  /**
   * Serialize and persist a single document into the L2 cache store.
   *
   * Header format (v2):
   *   `{ version: 2, id, createdAt, lastModified, decryptionKeyId,
   *      isDeleted, changeSeq, automergeHeads }`
   *
   * `changeSeq` is read from the in-memory changefeed index so that on
   * the next open we can compare it against the live index entry and
   * decide whether the persisted Automerge state is up to date or needs
   * incremental delta application. `automergeHeads` snapshots
   * `Automerge.getHeads(doc)` so a future read can identify which entries
   * (if any) still need to be applied to bring the persisted doc current.
   *
   * Both fields are derived inline (no extra index lookups beyond the
   * O(1) `indexLookup`) so this stays cheap to call from the periodic
   * flush as well as from the upcoming flush-before-evict path.
   */
  private async flushDirtyDocToCache(
    store: LocalCacheStore,
    prefix: string,
    docId: string,
    internal: InternalDoc,
  ): Promise<void> {
    const amBinary = Automerge.save(internal.doc);

    const indexEntryIdx = this.indexLookup.get(docId);
    const changeSeq = indexEntryIdx === undefined
      ? 0
      : this.index[indexEntryIdx].changeSeq;
    const automergeHeads = Automerge.getHeads(internal.doc);

    const header = JSON.stringify({
      version: DOC_CACHE_HEADER_VERSION,
      id: internal.id,
      createdAt: internal.createdAt,
      lastModified: internal.lastModified,
      decryptionKeyId: internal.decryptionKeyId,
      isDeleted: internal.isDeleted,
      changeSeq,
      automergeHeads,
    });
    const headerBytes = new TextEncoder().encode(header);

    // Format: 4-byte header length (big-endian) + header JSON + Automerge binary
    const value = new Uint8Array(4 + headerBytes.length + amBinary.length);
    const view = new DataView(value.buffer);
    view.setUint32(0, headerBytes.length, false);
    value.set(headerBytes, 4);
    value.set(amBinary, 4 + headerBytes.length);

    await store.put("doc", `${prefix}/${docId}`, value);
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

    // Persist the KeyBag fingerprint observed at the last reconciliation
    // so the next restore can decide whether to skip the visibility
    // metadata scan. `null` is acceptable - older checkpoints simply
    // force one reconcile on the next startup.
    if (this.lastReconciledKeyBagFingerprint !== null) {
      checkpoint.keyBagFingerprint = this.lastReconciledKeyBagFingerprint;
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
      this.lastReconciledKeyBagFingerprint =
        typeof checkpoint.keyBagFingerprint === "string" ? checkpoint.keyBagFingerprint : null;
      // Rebuild indexLookup from index
      this.indexLookup.clear();
      for (let i = 0; i < this.index.length; i++) {
        if (typeof this.index[i].changeSeq !== "number") {
          this.index[i].changeSeq = i + 1;
        }
        if (!this.index[i].decryptionKeyId) {
          this.index[i].decryptionKeyId = "default";
        }
        if (!this.index[i].accessState) {
          this.index[i].accessState = "visible";
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
      const allOwnedKeys = docIds.filter((id) => id.startsWith(docPrefix));

      if (this.restoreToL2) {
        // L2-only restore: leave L1 empty; let lazy reads via
        // tryLoadFromL2 promote individual docs as they are needed. We
        // still log how many records are sitting in L2 so operators can
        // sanity-check cache size.
        this.logger.info(
          `restoreToL2 enabled for ${prefix}: deferring L1 fill; ${allOwnedKeys.length} cached document records will load lazily on demand`
        );
        return true;
      }

      // Eager restore mode (default): bulk-load doc records via the
      // batched getMany API. This avoids N independent IndexedDB
      // transactions for N docs while preserving exactly the legacy
      // semantics (capped by `cacheRestoreLimit`, populates L1). The
      // batch size is bounded by `cacheRestoreBatchSize` so that the
      // transient encrypted+decrypted byte buffers held in memory at
      // any one time stay predictable - see
      // `DocumentCacheConfig.restoreBatchSize`.
      const targetKeys = allOwnedKeys.slice(0, this.cacheRestoreLimit);
      let restoredDocs = 0;
      let skippedLegacyDocs = 0;

      for (let offset = 0; offset < targetKeys.length; offset += this.cacheRestoreBatchSize) {
        if (restoredDocs >= this.cacheRestoreLimit) {
          break;
        }
        const batch = targetKeys.slice(offset, offset + this.cacheRestoreBatchSize);
        const batchValues = await store.getMany("doc", batch);

        for (let i = 0; i < batch.length; i++) {
          if (restoredDocs >= this.cacheRestoreLimit) {
            break;
          }
          const docBytes = batchValues[i];
          if (!docBytes) continue;

          try {
            const deserialized = this.deserializeDoc(docBytes);
            if (deserialized === null) {
              skippedLegacyDocs++;
              continue;
            }
            // Defence-in-depth: an L2 record holds the decrypted Automerge
            // state. If the current KeyBag can no longer resolve the doc's
            // key (e.g. the user lost access between sessions) we evict
            // both the L2 record and any L1 entry instead of restoring
            // plaintext into memory. The post-restore call to
            // `reconcileKeyVisibility` will then flip the index entry to
            // `"inaccessible"` so future reads behave correctly.
            const canRead = await this.tenant.hasDecryptionKey(deserialized.internal.decryptionKeyId);
            if (!canRead) {
              const docId = batch[i].slice(docPrefix.length);
              await store.delete("doc", batch[i]);
              this.docCache.delete(docId);
              continue;
            }
            await this.storeCachedDocument(deserialized.internal);
            restoredDocs++;
          } catch (e) {
            const docId = batch[i].slice(docPrefix.length);
            this.logger.warn(`Failed to restore cached doc ${docId}, will reload from store: ${e}`);
          }
        }
      }
      if (skippedLegacyDocs > 0) {
        this.logger.info(
          `Skipped ${skippedLegacyDocs} legacy (v1) cached documents during restore; they will be re-flushed in v2 format on next access.`
        );
      }
      this.logger.info(`Restored ${restoredDocs} cached documents for ${this.store.getId()}`);

      this.logger.info(`Restored ${restoredDocs} documents from cache for ${prefix}`);
      return true;
    } catch (e) {
      this.logger.warn(`Cache restore failed, will do full rebuild: ${e}`);
      return false;
    }
  }

  /**
   * Decode a persisted L2 document cache record.
   *
   * Returns `null` for legacy (v1) records - they predate the
   * `changeSeq + automergeHeads` freshness sentinels and so cannot
   * participate in the L2 read-path freshness check; callers should
   * fall back to the normal materialization path when they encounter
   * one. Throws on truly malformed records (caught by callers).
   */
  private deserializeDoc(value: Uint8Array): DeserializedCachedDoc | null {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const headerLen = view.getUint32(0, false);
    const headerBytes = value.slice(4, 4 + headerLen);
    const amBinary = value.slice(4 + headerLen);

    const header = JSON.parse(new TextDecoder().decode(headerBytes));

    if (header.version !== DOC_CACHE_HEADER_VERSION) {
      // v1 records (no `version`) and unknown future versions: skip
      // gracefully so they get re-flushed with the current header on
      // the next dirty cycle.
      return null;
    }

    const doc = Automerge.load<MindooDocPayload>(amBinary);

    const internal: InternalDoc = {
      id: header.id,
      doc,
      createdAt: header.createdAt,
      lastModified: header.lastModified,
      decryptionKeyId: header.decryptionKeyId,
      isDeleted: header.isDeleted,
    };

    return {
      internal,
      persistedChangeSeq: typeof header.changeSeq === "number" ? header.changeSeq : 0,
      persistedHeads: Array.isArray(header.automergeHeads) ? header.automergeHeads : [],
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
   *
   * When a document changes, it gets a new monotonic sequence and is
   * moved within the sorted index to maintain `(changeSeq, docId)` order.
   * The lookup map is only patched for the range of entries that actually
   * shifted.
   *
   * Idempotent: if every tracked field (`lastModified`, `isDeleted`,
   * `decryptionKeyId`, `accessState`) matches the existing entry the
   * call is a no-op and no new `changeSeq` is consumed. This is what
   * keeps repeated visibility reconciliations from inflating the
   * changefeed.
   *
   * @param docId The document ID
   * @param lastModified The new last modified timestamp
   * @param isDeleted Whether the document is a deletion/inaccessibility tombstone
   * @param decryptionKeyId Encryption key id derived from the doc's store metadata
   * @param accessState `"visible"` for readable docs, `"inaccessible"` for
   *   tombstones produced by the key visibility layer
   */
  private updateIndex(
    docId: string,
    lastModified: number,
    isDeleted: boolean,
    decryptionKeyId: string = "default",
    accessState: DocumentAccessState = "visible",
  ): void {
    const startedAt = Date.now();
    const assignedSeq = this.nextChangeSeq;
    const newEntry: DocumentIndexEntry = {
      docId,
      changeSeq: assignedSeq,
      lastModified,
      isDeleted,
      decryptionKeyId,
      accessState,
    };
    const existingIndex = this.indexLookup.get(docId);
    
    // Check if the entry already exists and hasn't changed position
    if (existingIndex !== undefined) {
      const existingEntry = this.index[existingIndex];
      // If only metadata flags stayed identical and caller replays same state, skip.
      if (
        existingEntry.lastModified === lastModified
        && existingEntry.isDeleted === isDeleted
        && existingEntry.decryptionKeyId === decryptionKeyId
        && existingEntry.accessState === accessState
      ) {
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
   * Rebuild the in-memory automerge-hash lookup for one document from stored metadata.
   *
   * This is a defensive recovery path for cases where the cached lookup missed
   * previously stored entries even though the content-addressed store already has
   * enough metadata to recover them.
   */
  private async hydrateAutomergeHashMappingsFromStore(docId: string): Promise<void> {
    const allMetadata = await this.scanAllMetadata(this.store, { docId });
    for (const metadata of allMetadata) {
      const parsed = parseDocEntryId(metadata.id);
      if (!parsed) {
        continue;
      }
      this.registerAutomergeHashMapping(docId, parsed.automergeHash, metadata.id);
    }
  }

  /**
   * Resolve Automerge dependency hashes to entry IDs without silently dropping parents.
   *
   * The fast path uses the in-memory hash lookup. If that lookup is incomplete, we
   * rebuild it from local store metadata once before failing the write.
   */
  private async ensureAutomergeDepsResolved(docId: string, automergeHashes: string[]): Promise<string[]> {
    if (automergeHashes.length === 0) {
      return [];
    }

    const resolvedEntryIds = this.resolveAutomergeDepsToEntryIds(docId, automergeHashes);
    if (resolvedEntryIds.length === automergeHashes.length) {
      return resolvedEntryIds;
    }

    this.logger.warn(
      `Falling back to metadata scan for unresolved automerge dependency hashes in doc ${docId}`,
    );
    await this.hydrateAutomergeHashMappingsFromStore(docId);

    const recoveredEntryIds = this.resolveAutomergeDepsToEntryIds(docId, automergeHashes);
    if (recoveredEntryIds.length === automergeHashes.length) {
      return recoveredEntryIds;
    }

    const missingHashes = automergeHashes.filter((hash) => this.getEntryIdForAutomergeHash(docId, hash) === null);
    throw new Error(
      `Could not resolve automerge dependency hashes ${missingHashes.join(", ")} to entry IDs for doc ${docId}`,
    );
  }

  /**
   * Get the SubtleCrypto instance from the tenant's crypto adapter.
   */
  private getSubtle(): SubtleCrypto {
    return this.tenant.getCryptoAdapter().getSubtle();
  }

  private isDocumentReplayEntry(entry: StoreEntryMetadata): boolean {
    // Only these entry types participate in Automerge replay and document
    // lifecycle state. Snapshots and attachment entries are derived side data.
    return (
      entry.entryType === "doc_create" ||
      entry.entryType === "doc_change" ||
      entry.entryType === "doc_delete" ||
      entry.entryType === "doc_undelete"
    );
  }

  private findActiveReplayHeadEntryIds(replayEntries: StoreEntryMetadata[]): string[] {
    const replayIds = new Set(replayEntries.map((entry) => entry.id));
    const referencedIds = new Set<string>();

    // A replay entry is no longer an active head once another replay entry
    // depends on it. Remaining entries are the branch heads visible in metadata.
    for (const entry of replayEntries) {
      for (const depId of entry.dependencyIds) {
        if (replayIds.has(depId)) {
          referencedIds.add(depId);
        }
      }
    }
    return replayEntries
      .filter((entry) => !referencedIds.has(entry.id))
      .sort((left, right) =>
        left.createdAt !== right.createdAt
          ? left.createdAt - right.createdAt
          : left.id.localeCompare(right.id),
      )
      .map((entry) => entry.id);
  }

  private computeIsDeletedFromMetadata(
    metadata: StoreEntryMetadata[],
    headEntryIds?: string[],
  ): boolean {
    // Deletion is intentionally metadata-derived: the latest reachable
    // doc_delete/doc_undelete lifecycle entry wins without materializing the doc.
    const replayEntries = metadata.filter((entry) => this.isDocumentReplayEntry(entry));
    const replayById = new Map(replayEntries.map((entry) => [entry.id, entry]));
    const heads = headEntryIds ?? this.findActiveReplayHeadEntryIds(replayEntries);
    return isDeletedFromHeads(heads, replayById);
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

        // Visibility reconciliation runs a full metadata scan over the
        // store, which on a remote store is one or more REST round-trips.
        // Skip it on warm starts when we can prove the KeyBag composition
        // has not changed since the last flush by comparing fingerprints.
        // Fall back to the unconditional reconcile when the tenant does
        // not expose a fingerprint so we never silently miss a key
        // transition.
        const currentFingerprint = await this.computeCurrentKeyBagFingerprint();
        const fingerprintMatches =
          currentFingerprint !== null && currentFingerprint === this.lastReconciledKeyBagFingerprint;
        if (!fingerprintMatches) {
          await this.reconcileKeyVisibility();
        }
        this.markKeyBagFingerprintReconciled(currentFingerprint);

        // If `reconcileRestoredIndexOnInit` triggers a full rebuild,
        // that rebuild reruns `syncStoreChanges` from scratch, which
        // applies per-doc visibility checks itself. We do not need to
        // call `reconcileKeyVisibility` again afterwards.
        if (this.reconcileRestoredIndexOnInit) {
          await this.reconcileRestoredIndexWithStore();
        }
        return;
      }
    }

    await this.syncStoreChanges();
    // First-time materialization: `syncStoreChanges` already filters out
    // docs whose keys are unavailable, so the only thing left to do is
    // record the current fingerprint for the next warm start.
    this.markKeyBagFingerprintReconciled(await this.computeCurrentKeyBagFingerprint());
  }

  /**
   * Compute the current tenant KeyBag fingerprint, or `null` when the
   * tenant does not expose one (older `MindooTenant` implementations).
   */
  private async computeCurrentKeyBagFingerprint(): Promise<string | null> {
    if (typeof this.tenant.getDocKeyFingerprint !== "function") {
      return null;
    }
    return this.tenant.getDocKeyFingerprint();
  }

  /**
   * Record that the in-memory index now reflects the given KeyBag
   * fingerprint. Marks the cache metadata dirty whenever the recorded
   * value changes so the new fingerprint reaches the persisted
   * checkpoint at the next flush.
   */
  private markKeyBagFingerprintReconciled(fingerprint: string | null): void {
    if (this.lastReconciledKeyBagFingerprint === fingerprint) {
      return;
    }
    this.lastReconciledKeyBagFingerprint = fingerprint;
    this.cacheMetaDirty = true;
    this.cacheManager?.markDirty();
  }

  /**
   * Derive the per-doc visibility summary needed to reconcile the index
   * against the current KeyBag state.
   *
   * - `decryptionKeyId` is taken from the chronologically first lifecycle
   *   entry, mirroring how {@link syncStoreChanges} materializes a doc.
   *   Replay entries inside a doc cannot retroactively re-key it.
   * - `lastModified` is the latest `createdAt` among the entries that
   *   would be replayed for this doc (or, if none exist, the lifecycle
   *   entries themselves). This matches the user-visible timestamp the
   *   existing read path produces.
   * - `isDeleted` is the lifecycle state derived from the same metadata
   *   {@link syncStoreChanges} would have observed.
   *
   * Returns `null` when there are no lifecycle entries for the doc,
   * meaning there is nothing to reconcile.
   */
  private deriveDocumentVisibilityMetadata(metadata: StoreEntryMetadata[]): {
    decryptionKeyId: string;
    lastModified: number;
    isDeleted: boolean;
  } | null {
    const lifecycleEntries = metadata.filter(
      (entry) =>
        entry.entryType === "doc_create"
        || entry.entryType === "doc_change"
        || entry.entryType === "doc_delete"
        || entry.entryType === "doc_undelete"
        || entry.entryType === "doc_snapshot",
    );
    if (lifecycleEntries.length === 0) {
      return null;
    }
    lifecycleEntries.sort((left, right) =>
      left.createdAt !== right.createdAt ? left.createdAt - right.createdAt : left.id.localeCompare(right.id)
    );

    const replayEntries = metadata.filter((entry) => this.isDocumentReplayEntry(entry));
    const entriesForLastModified = replayEntries.length > 0 ? replayEntries : lifecycleEntries;
    return {
      decryptionKeyId: lifecycleEntries[0].decryptionKeyId,
      lastModified: Math.max(...entriesForLastModified.map((entry) => entry.createdAt)),
      isDeleted: this.computeIsDeletedFromMetadata(metadata),
    };
  }

  /**
   * Evict every locally cached form of a document.
   *
   * Used by the visibility layer whenever a document transitions to
   * `"inaccessible"` (the user lost the decryption key) or when a stale
   * L2 record for an inaccessible doc is discovered. The point is to
   * make sure no decrypted plaintext or in-memory Automerge state for
   * the doc survives beyond the key revocation.
   *
   *  - L1 (`docCache`) is cleared and the dirty marker dropped so we do
   *    not later persist a stale entry.
   *  - The automerge-hash lookup is cleared so any future re-add starts
   *    with a clean re-materialization.
   *  - The L2 record is deleted via the {@link LocalCacheStore} (if a
   *    cache manager is attached). Failures are logged but never thrown:
   *    a leftover encrypted record is preferable to crashing the read
   *    path that triggered the purge.
   */
  private async purgeMaterializedDocument(docId: string): Promise<void> {
    this.docCache.delete(docId);
    this.dirtyDocIds.delete(docId);
    this.automergeHashToEntryId.delete(docId);

    const store = this.cacheManager?.getStore();
    if (store) {
      try {
        await store.delete("doc", `${this.getCachePrefix()}/${docId}`);
      } catch (error) {
        // Best-effort: failure to evict the L2 record only means a stale
        // cached doc may linger on disk; the index entry below still
        // marks the doc inaccessible so read paths refuse to surface it.
        this.logger.warn(`Failed to evict L2 cache record for inaccessible doc ${docId}: ${error}`);
      }
    }
  }

  /**
   * Reconcile the in-memory index with the current tenant KeyBag.
   *
   * This is the core entry point for "the user's keys changed; refresh
   * what this database thinks is visible". It is safe to call repeatedly,
   * including from concurrent live updates: the underlying `updateIndex`
   * call only consumes a new `changeSeq` when state actually transitions.
   *
   * Behaviour for each doc that exists in the underlying store:
   *
   *  - **Key now available, no entry / inaccessible entry** -> mark
   *    `"visible"` and emit a new index revision so view providers can
   *    re-add the doc. The doc body will be materialized lazily on the
   *    next read.
   *  - **Key now available, already visible** -> no-op.
   *  - **Key now missing, currently visible** -> purge any materialized
   *    state and mark `"inaccessible"` with `isDeleted: true` so
   *    metadata-only feeds emit a single tombstone and views remove
   *    the entry.
   *  - **Key now missing, already inaccessible (or not yet in index)** ->
   *    no index change, but we still call {@link purgeMaterializedDocument}
   *    defensively to scrub any leftover plaintext cache that might exist.
   *
   * Time-travel views are immutable; the function returns early for them.
   * After running, if any transition occurred we mark the cache metadata
   * dirty so the new visibility state survives a process restart.
   */
  public async reconcileKeyVisibility(): Promise<void> {
    if (this.isTimeTravelMode()) {
      return;
    }

    const lifecycleMetadata = await this.scanAllMetadata(this.store);
    const metadataByDoc = new Map<string, StoreEntryMetadata[]>();
    for (const entry of lifecycleMetadata) {
      if (
        entry.entryType !== "doc_create"
        && entry.entryType !== "doc_change"
        && entry.entryType !== "doc_delete"
        && entry.entryType !== "doc_undelete"
        && entry.entryType !== "doc_snapshot"
      ) {
        continue;
      }
      const entries = metadataByDoc.get(entry.docId) ?? [];
      entries.push(entry);
      metadataByDoc.set(entry.docId, entries);
    }

    let changed = false;
    // Deterministic ordering by docId keeps the resulting changefeed
    // stable between runs, which simplifies test expectations.
    const docIds = Array.from(metadataByDoc.keys()).sort((left, right) => left.localeCompare(right));
    for (const docId of docIds) {
      const visibility = this.deriveDocumentVisibilityMetadata(metadataByDoc.get(docId)!);
      if (!visibility) {
        continue;
      }

      const existingIndex = this.indexLookup.get(docId);
      const existing = existingIndex === undefined ? undefined : this.index[existingIndex];
      const canRead = await this.tenant.hasDecryptionKey(visibility.decryptionKeyId);

      if (canRead) {
        // Reveal-on-add only triggers when the previous state was
        // missing or inaccessible; visible->visible transitions stay
        // idempotent via the existing `updateIndex` short-circuit.
        if (!existing || existing.accessState === "inaccessible") {
          this.updateIndex(docId, visibility.lastModified, visibility.isDeleted, visibility.decryptionKeyId, "visible");
          changed = true;
        }
        continue;
      }

      if (existing?.accessState === "visible") {
        // Key was revoked while we still had plaintext state in cache:
        // wipe it and flip the index entry to an inaccessible tombstone
        // with `isDeleted: true` so view feeds emit a clean removal.
        await this.purgeMaterializedDocument(docId);
        this.updateIndex(docId, visibility.lastModified, true, visibility.decryptionKeyId, "inaccessible");
        changed = true;
      } else {
        // Already inaccessible (or never seen). Scrub defensively in
        // case a previous session left an L2 record behind.
        await this.purgeMaterializedDocument(docId);
      }
    }

    if (changed) {
      this.cacheMetaDirty = true;
      this.cacheManager?.markDirty();
    }

    // Whatever path triggered the reconcile (init, KeyBag listener,
    // explicit caller), record the fingerprint observed during this
    // pass so a subsequent warm start with identical bag composition
    // can skip the scan.
    this.markKeyBagFingerprintReconciled(await this.computeCurrentKeyBagFingerprint());
  }

  private async reconcileRestoredIndexWithStore(): Promise<void> {
    const lifecycleMetadata = await this.scanAllMetadata(this.store);
    const lifecycleDocIds = Array.from(new Set(
      lifecycleMetadata
        .filter((entry) =>
          entry.entryType === "doc_create"
          || entry.entryType === "doc_change"
          || entry.entryType === "doc_delete"
          || entry.entryType === "doc_undelete"
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
   *
   * Sync intentionally does not trigger the L2 background warmer.
   * Callers that want to warm the L2 cache after a sync (e.g. the Haven
   * sync page) must call {@link startBackgroundWarmer} explicitly so
   * casual sync calls stay cheap and the warmer cost is paid only when
   * the workload is about to benefit from it.
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
              this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted, updatedDoc.decryptionKeyId, "visible");
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
              this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted, updatedDoc.decryptionKeyId, "visible");
            }
          }
        } else {
          // Metadata-first startup: avoid full materialization for uncached docs.
          // Index based on doc-lifecycle entries (create/change/delete/undelete) plus
          // doc_snapshot which may be the sole entry after a dense sync.
          // Attachment-only batches should not trigger document index updates.
          const docLifecycleEntries = entryMetadataList.filter(
            (e) =>
              e.entryType === "doc_create" ||
              e.entryType === "doc_change" ||
              e.entryType === "doc_delete" ||
              e.entryType === "doc_undelete" ||
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
              const allDocMetadata = await this.scanAllMetadata(this.store, { docId });
              const mutationEntries = allDocMetadata.filter((e) => this.isDocumentReplayEntry(e));
              // Snapshots compact replay history but should not change the user-visible
              // modification time when the original create/change/delete/undelete entries still exist.
              const entriesForLastModified =
                mutationEntries.length > 0 ? mutationEntries : docLifecycleEntries;
              const lastModified = Math.max(
                ...entriesForLastModified.map((e) => e.createdAt),
              );
              const isDeleted = this.computeIsDeletedFromMetadata(allDocMetadata);
              this.updateIndex(docId, lastModified, isDeleted, representativeEntry.decryptionKeyId, "visible");
              this.logger.debug(
                `Metadata-first update for uncached doc ${docId} (lastModified: ${lastModified}, isDeleted: ${isDeleted})`,
              );
            }
          }
        }
      } catch (error) {
        // Missing symmetric key during live sync: the doc exists in the
        // store but we cannot decrypt it. Treat this as a visibility
        // transition rather than a hard failure:
        //  - If the doc had previously been visible, purge any plaintext
        //    we still hold and flip the index entry to `"inaccessible"`
        //    with a deletion tombstone so view feeds remove it cleanly.
        //  - If the doc was never visible (first time we see it without
        //    a key), we simply skip; `reconcileKeyVisibility` will mark
        //    it appropriately the next time it runs.
        // Either way we advance the processed-entries marker so a
        // subsequent sync doesn't endlessly retry the same untranslatable
        // doc.
        if (error instanceof SymmetricKeyNotFoundError) {
          this.logger.debug(`Skipping document ${docId} - missing key: ${error.keyId}`);
          // Avoid a per-doc scanAllMetadata round-trip here: everything
          // we need is already in this batch's entryMetadataList plus the
          // existing index entry (if any). We do NOT need a second pass
          // over the underlying store - the key is missing, so we just
          // record an inaccessibility tombstone.
          const existingIndex = this.indexLookup.get(docId);
          const existing = existingIndex === undefined ? undefined : this.index[existingIndex];
          if (existing?.accessState === "visible") {
            const lifecycleEntriesInBatch = entryMetadataList.filter((entry) =>
              entry.entryType === "doc_create"
              || entry.entryType === "doc_change"
              || entry.entryType === "doc_delete"
              || entry.entryType === "doc_undelete"
              || entry.entryType === "doc_snapshot",
            );
            // Prefer a lifecycle entry from the failing batch for the
            // key id (they all share the same `decryptionKeyId` for a
            // doc), then fall back to any entry, then to the existing
            // index entry. One of these must be present whenever we
            // reach this branch.
            const representative =
              lifecycleEntriesInBatch[0] ?? entryMetadataList[0];
            const decryptionKeyId = representative?.decryptionKeyId ?? existing.decryptionKeyId;
            const batchLastModified = entryMetadataList.length > 0
              ? Math.max(...entryMetadataList.map((entry) => entry.createdAt))
              : 0;
            const lastModified = Math.max(existing.lastModified, batchLastModified);
            await this.purgeMaterializedDocument(docId);
            this.updateIndex(docId, lastModified, true, decryptionKeyId, "inaccessible");
            this.cacheMetaDirty = true;
            this.cacheManager?.markDirty();
          }
          this.processedEntryIds.push(...entryMetadataList.map(em => em.id));
          return;
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
    const effectiveFilters = this.mergeTimeTravelScanFilters(filters);
    if (!this.supportsCursorScan(store)) {
      let entries: StoreEntryMetadata[];
      if (filters?.docId) {
        entries = await store.findNewEntriesForDoc([], filters.docId);
      } else {
        entries = await store.findNewEntries([]);
      }
      if (effectiveFilters?.entryTypes?.length) {
        const allowedTypes = new Set(effectiveFilters.entryTypes);
        entries = entries.filter((entry) => allowedTypes.has(entry.entryType));
      }
      if (effectiveFilters?.creationDateFrom != null) {
        entries = entries.filter((entry) => entry.createdAt >= effectiveFilters.creationDateFrom!);
      }
      if (effectiveFilters?.creationDateUntil != null) {
        entries = entries.filter((entry) => entry.createdAt < effectiveFilters.creationDateUntil!);
      }
      return this.applyTimeTravelFilter(entries);
    }

    const all: StoreEntryMetadata[] = [];
    let cursor: StoreScanCursor | null = null;

    while (true) {
      const page = await store.scanEntriesSince!(cursor, 1000, effectiveFilters);
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
      const result = this.applyTimeTravelFilter(await this.store.findNewEntries(this.processedEntryIds));
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
      const page = await this.store.scanEntriesSince!(cursor, 1000, this.mergeTimeTravelScanFilters());
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
   * 2. Also fetch `doc_delete` and `doc_undelete` metadata so lifecycle markers are transferred.
   * 3. Ask the source's batch planner for the optimal replay set per document.
   * 4. Merge all entry IDs: doc_create + doc_delete + doc_undelete + snapshot + uncovered changes.
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
    const docUndeleteEntries = await sourceStore.findEntries("doc_undelete", null, null);
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
    for (const entry of docUndeleteEntries) {
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

  async reclaimIncompleteAttachmentUploads(
    options?: { minAgeMs?: number }
  ): Promise<IncompleteAttachmentUploadReclaimResult> {
    const minAgeMs = options?.minAgeMs ?? 5 * 60 * 1000;
    const cutoff = Date.now() - minAgeMs;
    const ledgers = await this.store.findEntries(
      "pending_attachment_upload",
      null,
      cutoff
    );
    const result: IncompleteAttachmentUploadReclaimResult = {
      scannedLedgers: ledgers.length,
      reclaimedUploads: 0,
      reclaimedChunks: 0,
      keptCommittedUploads: 0,
      keptRecentUploads: 0,
    };

    for (const ledger of ledgers) {
      const attachmentId = ledger.attachmentId;
      if (!attachmentId) {
        continue;
      }
      if ((ledger.uploadStartedAt ?? ledger.createdAt) > cutoff) {
        result.keptRecentUploads++;
        continue;
      }

      const liveDoc = await this.getDocument(ledger.docId).catch(() => null);
      if (liveDoc?.getAttachments().some((attachment) => attachment.attachmentId === attachmentId)) {
        await this.clearPendingAttachmentUploadLedger(attachmentId);
        result.keptCommittedUploads++;
        continue;
      }

      const docEntries = await this.scanAllMetadata(this.store, { docId: ledger.docId });
      const mentionedByHistory = docEntries.some((entry) =>
        entry.attachmentIds?.includes(attachmentId)
      );
      if (mentionedByHistory) {
        await this.clearPendingAttachmentUploadLedger(attachmentId);
        result.keptCommittedUploads++;
        continue;
      }

      const deletedChunks = await this.getEffectiveAttachmentStore()
        .deleteEntriesForAttachment?.(ledger.docId, attachmentId) ?? 0;
      await this.clearPendingAttachmentUploadLedger(attachmentId);
      result.reclaimedUploads++;
      result.reclaimedChunks += deletedChunks;
    }

    if (result.scannedLedgers > 0) {
      this.logger.info(
        `[idb-orphan-sweep] reclaimed ${result.reclaimedUploads} incomplete uploads (${result.reclaimedChunks} chunks), kept ${result.keptCommittedUploads} committed, kept ${result.keptRecentUploads} recent`
      );
    }

    return result;
  }

  getTenant(): MindooTenant {
    return this.tenant;
  }

  async createDocument(options?: CreateOptions): Promise<MindooDoc> {
    return this.createDocumentInternal(options ?? {});
  }

  /**
   * @deprecated Use `createDocument({ decryptionKeyId })` instead.
   */
  async createEncryptedDocument(decryptionKeyId?: string): Promise<MindooDoc> {
    return this.createDocumentInternal({ decryptionKeyId });
  }

  /**
   * @deprecated Use `createDocument({ signingKeyPair, signingKeyPassword, decryptionKeyId })` instead.
   */
  async createDocumentWithSigningKey(
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string,
    decryptionKeyId?: string
  ): Promise<MindooDoc> {
    return this.createDocumentInternal({ signingKeyPair, signingKeyPassword, decryptionKeyId });
  }
  
  /**
   * Internal method to create a new document.
   *
   * Handles all four creation flavors expressible through `CreateOptions`:
   * - generated UUID7 ID, current user signs, default tenant key
   * - generated UUID7 ID, custom signing key (e.g. directory admin operations)
   * - caller-provided ID, current user signs (idempotent on existing IDs)
   * - caller-provided ID with custom signing key
   *
   * For caller-provided IDs the initial Automerge change is seeded from a
   * deterministic, hard-coded change so that two replicas creating the same
   * custom ID converge when synced (see `getCustomIdInitialChangeBytes`).
   */
  private async createDocumentInternal(options: CreateOptions): Promise<MindooDoc> {
    this.assertWritable("createDocument");
    const { signingKeyPair, signingKeyPassword } = options;
    if ((signingKeyPair !== undefined) !== (signingKeyPassword !== undefined)) {
      throw new Error(
        "createDocument: signingKeyPair and signingKeyPassword must be provided together"
      );
    }
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    const keyId = options.decryptionKeyId ?? "default";
    const useCustomDocId = options.id !== undefined;

    if (useCustomDocId) {
      if (!CUSTOM_DOC_ID_REGEX.test(options.id!)) {
        throw new Error(
          `createDocument: invalid document id "${options.id}". ` +
          `Custom document IDs must match ${CUSTOM_DOC_ID_REGEX.source}.`
        );
      }
    }

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

    const docId = useCustomDocId ? options.id! : uuidv7();

    // Idempotent create: when a caller-provided id already exists locally,
    // return the existing document instead of producing a duplicate doc_create.
    if (useCustomDocId) {
      const existing = await this.loadDocumentInternal(docId);
      if (existing) {
        if (existing.isDeleted) {
          this.logger.debug(`Document ${docId} exists as a tombstone; undeleting existing custom-id document`);
          await this.undeleteDocInternal(docId, signingKeyPair, signingKeyPassword);
          const undeleted = await this.loadDocumentInternal(docId);
          if (!undeleted || undeleted.isDeleted) {
            throw new Error(`Document ${docId} could not be undeleted`);
          }
          return this.wrapDocument(undeleted);
        }
        this.logger.debug(`Document ${docId} already exists locally; returning existing document`);
        return this.wrapDocument(existing);
      }
    }

    this.logger.debug(`Creating document ${docId} with key ${keyId}${useCustomSigningKey ? ' using custom signing key' : ''}${useCustomDocId ? ' with caller-provided id' : ''}`);
    
    // Build the initial Automerge document and its first change bytes.
    //
    // For UUID7 documents we use the historical path (Automerge.init + change).
    // For custom-ID documents we apply a hard-coded initial change so that
    // independent replicas using the same id produce the same Automerge hash
    // and `doc_create` entry id, allowing later changes to merge.
    const now = Date.now();
    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    let changeBytes: Uint8Array;
    if (useCustomDocId) {
      this.logger.debug(`Seeding custom-id document ${docId} with hard-coded initial Automerge change`);
      changeBytes = getCustomIdInitialChangeBytes();
      try {
        const fresh = Automerge.init<MindooDocPayload>();
        const [appliedDoc] = Automerge.applyChanges(fresh, [changeBytes]);
        newDoc = appliedDoc;
        this.logger.debug(`Applied hard-coded initial change, heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
      } catch (error) {
        this.logger.error(`Error applying hard-coded initial change for document ${docId}:`, error);
        throw error;
      }
    } else {
      this.logger.debug(`Creating initial Automerge change for document ${docId}`);
      const initialDoc = Automerge.init<MindooDocPayload>();
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
      this.logger.debug(`Getting change bytes from document ${docId}`);
      const localChange = Automerge.getLastLocalChange(newDoc);
      if (!localChange) {
        throw new Error("Failed to get change bytes from Automerge document");
      }
      changeBytes = localChange;
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
    const dependencyIds = await this.ensureAutomergeDepsResolved(docId, automergeDepHashes);
    
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
    await this.storeCachedDocument(internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, false, internalDoc.decryptionKeyId, "visible");
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
          || em.entryType === "doc_undelete"
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
      (entry) => this.isDocumentReplayEntry(entry),
    );
    const firstReplayEntry = replayEntries.length > 0 ? replayEntries[0] : null;
    const lastReplayEntry = replayEntries.length > 0 ? replayEntries[replayEntries.length - 1] : null;
    const createdAt = firstReplayEntry?.createdAt ?? snapshotMeta?.createdAt ?? timestamp;
    const decryptionKeyId =
      firstReplayEntry?.decryptionKeyId
      ?? snapshotMeta?.decryptionKeyId
      ?? "default";
    const isDeleted = this.computeIsDeletedFromMetadata(relevantEntries);
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
    
    // Filter to document replay entries (exclude snapshots)
    const relevantEntries = allEntryMetadata
      .filter((em) => this.isDocumentReplayEntry(em))
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
      // For lifecycle terminal entries, always yield
      // For other entries, only yield if heads changed
      let shouldYield = false;
      if (isFirstEntry || entryMetadata.entryType === "doc_delete" || entryMetadata.entryType === "doc_undelete") {
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
          isDeleted: this.computeIsDeletedFromMetadata(relevantEntries.filter((entry) =>
            entry.createdAt < entryMetadata.createdAt ||
            (entry.createdAt === entryMetadata.createdAt && entry.id <= entryMetadata.id)
          )),
        };
        
        // Wrap and yield (including lifecycle terminal entries)
        const wrappedDoc = this.wrapDocument(internalDoc);
        
        yield {
          changeEntryId: entryMetadata.id,
          doc: wrappedDoc,
          changeCreatedAt: entryMetadata.createdAt,
          changeCreatedByPublicKey: entryMetadata.createdByPublicKey,
        };
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
          em.entryType === "doc_delete" ||
          em.entryType === "doc_undelete"
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
      isDeleted: this.computeIsDeletedFromMetadata(relevantEntries.filter((candidate) =>
        candidate.createdAt < entry.createdAt ||
        (candidate.createdAt === entry.createdAt && candidate.id <= entry.id)
      )),
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
   * Streams conflict-analysis events for one or more documents.
   *
   * This is the UI/server friendly entry point for conflict analysis. It first
   * does a metadata-only preflight for each document, then only decrypts and
   * replays document changes when the DAG contains concurrency candidates. The
   * yielded DTOs intentionally expose MindooDB concepts only; callers never get
   * direct access to Automerge documents, patches, operation IDs, or objects.
   *
   * @param docIds Document IDs to analyze. Documents are processed sequentially
   *   so browser callers can render progress and stop early without a large
   *   burst of synchronous work.
   * @param options Controls quick/full mode, value detail level, cancellation,
   *   per-document conflict limits, and cooperative event-loop yielding.
   * @returns An async generator yielding progress, conflict, resolution, done,
   *   and error events.
   */
  async *analyzeDocumentConflicts(
    docIds: string[],
    options: DocumentConflictAnalysisOptions = {},
  ): AsyncGenerator<DocumentConflictAnalysisEvent, void, unknown> {
    const scanCheckpoint = await this.getConflictScanCheckpoint();
    const candidateDocIds = await this.resolveConflictAnalysisCandidateDocIds(docIds, options);
    const totalDocs = candidateDocIds.length;
    let scannedDocs = 0;
    const mode = options.mode ?? "quick";
    let lastYieldAt = Date.now();

    for (const docId of candidateDocIds) {
      this.throwIfConflictAnalysisAborted(options.signal);
      const docStartedAt = Date.now();
      yield { type: "docStart", docId };

      try {
        const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
        yield {
          type: "progress",
          scannedDocs,
          totalDocs,
          docId,
          scannedEntries: allEntryMetadata.length,
          message: `Scanned conflict metadata for document ${docId}`,
        };

        const plan = computeDocumentConflictAnalysisPlan(docId, allEntryMetadata);
        let conflictsFound = 0;
        let hadConflicts = false;

        if (plan.hasConcurrencyCandidates) {
          const maxConflictsPerDoc = options.maxConflictsPerDoc ?? (mode === "quick" ? 1 : undefined);
          const detection = await this.detectDocumentConflictsFromPlan(
            docId,
            plan,
            {
              ...options,
              mode,
              maxConflictsPerDoc,
            },
          );

          for (const conflict of detection.conflicts) {
            this.throwIfConflictAnalysisAborted(options.signal);
            hadConflicts = true;
            conflictsFound += conflict.paths.length;
            yield {
              type: "conflictDetected",
              conflict,
              quick: mode === "quick",
            };
            lastYieldAt = await this.maybeYieldForConflictAnalysis(options.yieldEveryMs, lastYieldAt);
          }

          if (mode === "full") {
            for (const resolution of detection.resolutions) {
              this.throwIfConflictAnalysisAborted(options.signal);
              yield resolution;
              lastYieldAt = await this.maybeYieldForConflictAnalysis(options.yieldEveryMs, lastYieldAt);
            }
          }
        }

        scannedDocs++;
        yield {
          type: "docDone",
          docId,
          hadConflicts,
          conflictsFound,
          entriesScanned: allEntryMetadata.length,
        };
        this.performanceCallback?.onHistoryOperation?.({
          operation: "analyzeDocumentConflicts",
          docId,
          time: Date.now() - docStartedAt,
          scannedEntries: allEntryMetadata.length,
          returnedEntries: conflictsFound,
          bounded: true,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        yield { type: "error", docId, error };
        scannedDocs++;
      }

      yield {
        type: "progress",
        scannedDocs,
        totalDocs,
        docId,
        message: `Completed conflict analysis for document ${docId}`,
      };
      lastYieldAt = await this.maybeYieldForConflictAnalysis(options.yieldEveryMs, lastYieldAt);
    }

    yield {
      type: "scanCheckpoint",
      checkpoint: scanCheckpoint,
    };
  }

  /**
   * Builds a complete conflict report for a single document.
   *
   * This is a convenience wrapper around `analyzeDocumentConflicts()`. It forces
   * full analysis mode, consumes the event stream internally, and returns a
   * stable report object suitable for server-side jobs or UI detail panels.
   *
   * @param docId Document ID to analyze.
   * @param options Report options. The wrapper ignores quick-mode limits because
   *   reports are intended to describe the full known conflict history.
   * @returns Aggregated conflict and resolution information for the document.
   */
  async getDocumentConflictReport(
    docId: string,
    options: DocumentConflictReportOptions = {},
  ): Promise<DocumentConflictReport> {
    const startedAt = Date.now();
    const report: DocumentConflictReport = {
      docId,
      hadConflicts: false,
      conflictsFound: 0,
      conflicts: [],
      resolutions: [],
      entriesScanned: 0,
      errors: [],
      scanCheckpoint: null,
    };

    for await (const event of this.analyzeDocumentConflicts([docId], {
      ...options,
      mode: "full",
    })) {
      if (event.type === "conflictDetected") {
        report.hadConflicts = true;
        report.conflicts.push(event.conflict);
        report.conflictsFound += event.conflict.paths.length;
      } else if (event.type === "conflictResolved") {
        report.resolutions.push(event);
      } else if (event.type === "docDone") {
        report.entriesScanned = event.entriesScanned;
      } else if (event.type === "error") {
        report.errors.push(event);
      } else if (event.type === "scanCheckpoint") {
        report.scanCheckpoint = event.checkpoint;
      }
    }

    this.performanceCallback?.onHistoryOperation?.({
      operation: "getDocumentConflictReport",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: report.entriesScanned,
      returnedEntries: report.conflictsFound,
      bounded: true,
    });
    return report;
  }

  /**
   * Resolves the value each conflicted path had at its merge base.
   *
   * For every query, the database identifies the heads that contributed to
   * the conflict (the merging entry's parents for `entry-after` /
   * `merge-deps` conflicts, or the active heads for `active-heads`
   * conflicts), computes the most recent common ancestor of those heads,
   * materializes the document at that ancestor, and reads the path.
   *
   * Queries that share a merge base are coalesced: the document is
   * materialized at most once per unique base entry.
   *
   * @param docId Document identifier the queries refer to.
   * @param queries One entry per (location, path) lookup the caller wants.
   * @returns A `DocumentConflictBaseValue` aligned 1:1 with `queries`.
   */
  async getDocumentConflictBaseValues(
    docId: string,
    queries: DocumentConflictBaseValueQuery[],
  ): Promise<DocumentConflictBaseValue[]> {
    const startedAt = Date.now();
    if (queries.length === 0) {
      this.performanceCallback?.onHistoryOperation?.({
        operation: "getDocumentConflictBaseValues",
        docId,
        time: Date.now() - startedAt,
        scannedEntries: 0,
        returnedEntries: 0,
        bounded: true,
      });
      return [];
    }

    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    const metadataById = new Map(allEntryMetadata.map((entry) => [entry.id, entry] as const));

    type GroupedQuery = {
      readonly originalIndex: number;
      readonly query: DocumentConflictBaseValueQuery;
    };
    type Group = {
      readonly parents: string[];
      readonly queries: GroupedQuery[];
    };

    const groups = new Map<string, Group>();
    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      const parents = this.resolveConflictBaseParents(query.location, metadataById);
      const key = parents.length === 0 ? "" : parents.slice().sort().join("|");
      let group = groups.get(key);
      if (!group) {
        group = { parents, queries: [] };
        groups.set(key, group);
      }
      group.queries.push({ originalIndex: index, query });
    }

    const results: DocumentConflictBaseValue[] = new Array(queries.length);

    for (const group of groups.values()) {
      if (group.parents.length === 0) {
        for (const grouped of group.queries) {
          results[grouped.originalIndex] = {
            pathString: grouped.query.pathString,
            baseEntryId: null,
            status: "missing-entry",
            preview: null,
          };
        }
        continue;
      }
      const baseEntryId = this.computeConflictMergeBaseEntryId(metadataById, group.parents);
      if (baseEntryId === null) {
        for (const grouped of group.queries) {
          results[grouped.originalIndex] = {
            pathString: grouped.query.pathString,
            baseEntryId: null,
            status: "no-base",
            preview: null,
          };
        }
        continue;
      }
      const internalDoc = await this.materializeBranchInternalDoc(docId, allEntryMetadata, baseEntryId);
      if (!internalDoc || internalDoc.isDeleted) {
        for (const grouped of group.queries) {
          results[grouped.originalIndex] = {
            pathString: grouped.query.pathString,
            baseEntryId,
            status: "no-prior-value",
            preview: null,
          };
        }
        continue;
      }
      for (const grouped of group.queries) {
        const value = this.readValueAtDocumentPath(internalDoc.doc, grouped.query.path);
        if (value === undefined) {
          results[grouped.originalIndex] = {
            pathString: grouped.query.pathString,
            baseEntryId,
            status: "no-prior-value",
            preview: null,
          };
        } else {
          results[grouped.originalIndex] = {
            pathString: grouped.query.pathString,
            baseEntryId,
            status: "available",
            preview: this.previewChangeValue(value),
            value: this.toJsonSafeConflictValue(value),
          };
        }
      }
    }

    this.performanceCallback?.onHistoryOperation?.({
      operation: "getDocumentConflictBaseValues",
      docId,
      time: Date.now() - startedAt,
      scannedEntries: allEntryMetadata.length,
      returnedEntries: results.length,
      bounded: true,
    });
    return results;
  }

  /**
   * Returns the head entry IDs whose merge base should be resolved for one
   * conflict location. Filters out IDs that aren't present in the local
   * metadata so callers don't try to materialize against missing entries.
   */
  private resolveConflictBaseParents(
    location: DocumentConflictLocation,
    metadataById: Map<string, StoreEntryMetadata>,
  ): string[] {
    if (location.kind === "active-heads") {
      return location.headEntryIds.filter((id) => metadataById.has(id));
    }
    if (!location.entryId) {
      return [];
    }
    const entry = metadataById.get(location.entryId);
    if (!entry) {
      return [];
    }
    return entry.dependencyIds.filter((id) => metadataById.has(id));
  }

  /**
   * Computes the most recent common ancestor of `parents` in the document's
   * dependency DAG.
   *
   * Returns the deepest common ancestor (an ancestor that is not itself a
   * proper ancestor of another common ancestor). If multiple deepest
   * candidates exist, the one with the highest `createdAt` wins so the UI
   * shows a base value as close to the conflict as possible.
   */
  private computeConflictMergeBaseEntryId(
    metadataById: Map<string, StoreEntryMetadata>,
    parents: string[],
  ): string | null {
    if (parents.length === 0) {
      return null;
    }
    if (parents.length === 1) {
      return parents[0];
    }

    const ancestorCache = new Map<string, Set<string>>();
    const collectAncestors = (startId: string): Set<string> => {
      const cached = ancestorCache.get(startId);
      if (cached) {
        return cached;
      }
      const visited = new Set<string>();
      const queue: string[] = [startId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (visited.has(id)) {
          continue;
        }
        visited.add(id);
        const meta = metadataById.get(id);
        if (!meta) {
          continue;
        }
        for (const dep of meta.dependencyIds) {
          if (!visited.has(dep)) {
            queue.push(dep);
          }
        }
      }
      ancestorCache.set(startId, visited);
      return visited;
    };

    let common: Set<string> | null = null;
    for (const parent of parents) {
      const ancestors = collectAncestors(parent);
      if (common === null) {
        common = new Set(ancestors);
      } else {
        const next = new Set<string>();
        for (const id of common) {
          if (ancestors.has(id)) {
            next.add(id);
          }
        }
        common = next;
      }
      if (common.size === 0) {
        return null;
      }
    }
    if (!common || common.size === 0) {
      return null;
    }

    const isProperAncestorOfAnother = new Set<string>();
    for (const id of common) {
      const ancestors = collectAncestors(id);
      for (const ancestorId of ancestors) {
        if (ancestorId !== id && common.has(ancestorId)) {
          isProperAncestorOfAnother.add(ancestorId);
        }
      }
    }

    const deepest: string[] = [];
    for (const id of common) {
      if (!isProperAncestorOfAnother.has(id)) {
        deepest.push(id);
      }
    }
    if (deepest.length === 0) {
      return null;
    }
    deepest.sort((a, b) => {
      const tA = metadataById.get(a)?.createdAt ?? 0;
      const tB = metadataById.get(b)?.createdAt ?? 0;
      if (tA !== tB) {
        return tB - tA;
      }
      return a.localeCompare(b);
    });
    return deepest[0];
  }

  /**
   * Captures the current local receipt/index position for future incremental
   * conflict scans.
   */
  async getConflictScanCheckpoint(): Promise<ConflictScanCheckpoint> {
    const latestCursor = this.getLatestChangeCursor();
    return {
      changeSeqAsOf: latestCursor?.changeSeq ?? 0,
      storeReceiptOrderAsOf: await this.getStoreMaxReceiptOrder(),
      takenAt: Date.now(),
    };
  }

  /**
   * Narrows scan work to documents whose indexed latest state changed after the
   * caller's checkpoint. When the caller asks for pre-existing unresolved
   * conflicts, every requested document remains a candidate because an old active
   * conflict may still need to be returned.
   */
  private async resolveConflictAnalysisCandidateDocIds(
    docIds: string[],
    options: DocumentConflictAnalysisOptions,
  ): Promise<string[]> {
    if (!options.since || options.includeUnresolvedFromBefore) {
      return docIds;
    }
    const requestedDocIds = new Set(docIds);
    const movedDocIds = new Set<string>();
    const cursor: ProcessChangesCursor = {
      changeSeq: options.since.changeSeqAsOf,
      lastModified: 0,
      docId: "",
    };
    for await (const summary of this.iterateChangeMetadataSince(cursor)) {
      if (requestedDocIds.has(summary.docId)) {
        movedDocIds.add(summary.docId);
      }
    }
    return docIds.filter((docId) => movedDocIds.has(docId));
  }

  /**
   * Finds the latest local store receipt order. This is intentionally metadata
   * only and works with stores that do not expose a direct max-receipt query.
   */
  private async getStoreMaxReceiptOrder(): Promise<number | undefined> {
    let maxReceiptOrder: number | undefined;
    const metadata = await this.scanAllMetadata(this.store);
    for (const entry of metadata) {
      if (typeof entry.receiptOrder !== "number") {
        continue;
      }
      maxReceiptOrder = maxReceiptOrder === undefined
        ? entry.receiptOrder
        : Math.max(maxReceiptOrder, entry.receiptOrder);
    }
    return maxReceiptOrder;
  }

  /**
   * Replays verified document changes and detects conflict/resolution events.
   *
   * The input `plan` is metadata-only and has already determined that analyzing
   * this document is worth the cost. This method performs the private Automerge
   * work: decrypting changes, replaying them in dependency order, inspecting
   * changed paths, and optionally resolving conflicting value summaries. All
   * Automerge-specific objects are converted to MindooDB DTOs before returning.
   *
   * Conflict detection has three phases:
   * 1. Before applying a change, inspect existing multi-head states. This catches
   *    conflicts that exist between active heads and conflicts that are about to
   *    be resolved by a merge/resolution change.
   * 2. After applying a change, inspect Automerge patches for changed paths and
   *    confirm conflicts with `getConflicts()` on those changed paths only.
   * 3. After replay completes, inspect remaining active heads so unresolved
   *    conflicts are still reported for documents that never wrote a merge change.
   *
   * @param docId Document being analyzed.
   * @param plan Metadata-only replay/concurrency plan for the document.
   * @param options Analysis options propagated from the public API.
   * @returns Conflict findings, resolution events, and the number of entries
   *   successfully replayed.
   */
  private async detectDocumentConflictsFromPlan(
    docId: string,
    plan: ReturnType<typeof computeDocumentConflictAnalysisPlan>,
    options: DocumentConflictAnalysisOptions,
  ): Promise<ConflictDetectionResult> {
    const verifiedChanges = await this.loadVerifiedReplayChanges(plan.replayEntries);
    const hashToEntryId = this.buildAutomergeHashToEntryId(plan.replayEntries, verifiedChanges);
    const activeConflictPaths = new Map<string, DocumentConflictPath>();
    const conflicts: DocumentConflictSummary[] = [];
    const resolutions: Array<Extract<DocumentConflictAnalysisEvent, { type: "conflictResolved" }>> = [];
    const maxConflictsPerDoc = options.maxConflictsPerDoc;
    let entriesApplied = 0;
    let doc = Automerge.init<MindooDocPayload>();

    for (const entryId of plan.orderedReplayEntryIds) {
      this.throwIfConflictAnalysisAborted(options.signal);
      const change = verifiedChanges.get(entryId);
      if (!change) {
        continue;
      }

      const beforeHeads = Automerge.getHeads(doc);
      // A multi-head state can already contain conflicts before the next change
      // is applied. This is especially important for resolution changes: the
      // conflict exists in the dependency heads and disappears after the write.
      if (beforeHeads.length > 1) {
        const alreadyReported = new Set([
          ...conflicts.flatMap((conflict) => conflict.paths.map((path) => path.pathString)),
          ...activeConflictPaths.keys(),
        ]);
        const preApplyConflictPaths = this.collectDocumentConflictPaths(
          doc,
          options.detail === "values",
        ).filter((path) => !alreadyReported.has(path.pathString));
        const conflictPathCount = conflicts.reduce((count, conflict) => count + conflict.paths.length, 0);
        const remainingBudget = maxConflictsPerDoc === undefined
          ? preApplyConflictPaths.length
          : Math.max(0, maxConflictsPerDoc - conflictPathCount);
        const boundedPreApplyConflictPaths = preApplyConflictPaths.slice(0, remainingBudget);
        if (boundedPreApplyConflictPaths.length > 0) {
          for (const path of boundedPreApplyConflictPaths) {
            activeConflictPaths.set(path.pathString, path);
          }
          if (this.shouldEmitConflictObservation(change.entry, options)) {
            conflicts.push({
              docId,
              location: {
              kind: change.entry.dependencyIds.length > 1 ? "merge-deps" : "active-heads",
              entryId: change.entry.id,
              createdAt: change.entry.createdAt,
              receiptOrder: change.entry.receiptOrder,
              createdByPublicKey: change.entry.createdByPublicKey,
              headEntryIds: beforeHeads
                .map((head) => hashToEntryId.get(head))
                .filter((headEntryId): headEntryId is string => typeof headEntryId === "string"),
              automergeHeads: [...beforeHeads],
              },
              paths: boundedPreApplyConflictPaths,
            });
          }
        }
      }
      const afterDoc = Automerge.loadIncremental(doc, change.changeBytes);
      const afterHeads = Automerge.getHeads(afterDoc);
      const patches = this.diffAutomergeHeads(afterDoc, beforeHeads, afterHeads);
      const detectedPaths = new Map<string, DocumentConflictPath>();

      // Patches tell us which paths changed, keeping analysis proportional to
      // the change size. We then confirm conflict state with getConflicts() for
      // those paths only, rather than walking arbitrary JSON after every change.
      for (const patch of patches) {
        const path = this.getConflictPatchPath(patch);
        if (!path) {
          continue;
        }
        if (this.isInternalConflictPath(path)) {
          continue;
        }
        const pathString = formatDocumentConflictPath(path);
        const action = this.getConflictPatchAction(patch);
        const isConflictPut = action === "put" && (
          this.isConflictPatch(patch) || this.hasDocumentConflictAtPath(afterDoc, path)
        );

        if (isConflictPut) {
          const conflictPath = this.buildDocumentConflictPath(
            afterDoc,
            path,
            options.detail === "values",
          );
          detectedPaths.set(pathString, conflictPath);
          activeConflictPaths.set(pathString, conflictPath);
          continue;
        }

        if ((action === "put" || action === "del") && activeConflictPaths.has(pathString)) {
          if (this.shouldEmitConflictObservation(change.entry, options)) {
            resolutions.push({
              type: "conflictResolved",
              docId,
              entryId: change.entry.id,
              createdAt: change.entry.createdAt,
              receiptOrder: change.entry.receiptOrder,
              createdByPublicKey: change.entry.createdByPublicKey,
              path: activeConflictPaths.get(pathString)!,
              automergeHash: change.automergeHash,
            });
          }
          activeConflictPaths.delete(pathString);
        }
      }

      if (detectedPaths.size > 0 && this.shouldEmitConflictObservation(change.entry, options)) {
        conflicts.push({
          docId,
          location: {
            kind: "entry-after",
            entryId: change.entry.id,
            createdAt: change.entry.createdAt,
            receiptOrder: change.entry.receiptOrder,
            createdByPublicKey: change.entry.createdByPublicKey,
            headEntryIds: afterHeads
              .map((head) => hashToEntryId.get(head))
              .filter((headEntryId): headEntryId is string => typeof headEntryId === "string"),
            automergeHeads: [...afterHeads],
          },
          paths: Array.from(detectedPaths.values()).sort((left, right) =>
            left.pathString.localeCompare(right.pathString),
          ),
        });
      }

      doc = afterDoc;
      entriesApplied++;

      const conflictPathCount = conflicts.reduce((count, conflict) => count + conflict.paths.length, 0);
      if (maxConflictsPerDoc !== undefined && conflictPathCount >= maxConflictsPerDoc) {
        break;
      }
    }

    // If the document still has multiple active heads after replay, there may
    // be unresolved conflicts with no later patch to surface them. Do one final
    // tree scan in that bounded case so active conflicts are visible.
    if (
      plan.activeHeadEntryIds.length > 1
      && (maxConflictsPerDoc === undefined
        || conflicts.reduce((count, conflict) => count + conflict.paths.length, 0) < maxConflictsPerDoc)
    ) {
      const alreadyReported = new Set(
        conflicts.flatMap((conflict) => conflict.paths.map((path) => path.pathString)),
      );
      const activeConflictPaths = this.collectDocumentConflictPaths(
        doc,
        options.detail === "values",
      ).filter((path) => !alreadyReported.has(path.pathString));
      const remainingBudget = maxConflictsPerDoc === undefined
        ? activeConflictPaths.length
        : Math.max(
          0,
          maxConflictsPerDoc - conflicts.reduce((count, conflict) => count + conflict.paths.length, 0),
        );
      const boundedActiveConflictPaths = activeConflictPaths.slice(0, remainingBudget);
      if (boundedActiveConflictPaths.length > 0) {
        const activeHeadEntries = plan.activeHeadEntryIds
          .map((entryId) => plan.replayById.get(entryId))
          .filter((entry): entry is StoreEntryMetadata => entry !== undefined);
        const latestActiveHeadEntry = activeHeadEntries
          .sort((left, right) => {
            const leftOrder = left.receiptOrder ?? left.createdAt;
            const rightOrder = right.receiptOrder ?? right.createdAt;
            return leftOrder !== rightOrder ? rightOrder - leftOrder : right.id.localeCompare(left.id);
          })[0];
        if (options.includeUnresolvedFromBefore || this.shouldEmitConflictObservation(latestActiveHeadEntry, options)) {
          conflicts.push({
          docId,
          location: {
            kind: "active-heads",
            entryId: latestActiveHeadEntry?.id,
            createdAt: latestActiveHeadEntry?.createdAt,
            receiptOrder: latestActiveHeadEntry?.receiptOrder,
            createdByPublicKey: latestActiveHeadEntry?.createdByPublicKey,
            headEntryIds: [...plan.activeHeadEntryIds],
            automergeHeads: Automerge.getHeads(doc),
          },
          paths: boundedActiveConflictPaths,
          });
        }
      }
    }

    return { conflicts, resolutions, entriesApplied };
  }

  /**
   * Applies incremental-scan visibility rules to conflict and resolution events.
   *
   * Receipt order is preferred because it represents local arrival. Created-at is
   * only a fallback for legacy metadata that predates receipt-order assignment.
   */
  private shouldEmitConflictObservation(
    entry: StoreEntryMetadata | undefined,
    options: DocumentConflictAnalysisOptions,
  ): boolean {
    if (!options.since) {
      return true;
    }
    if (!entry) {
      return options.includeUnresolvedFromBefore === true;
    }
    if (
      typeof entry.receiptOrder === "number"
      && typeof options.since.storeReceiptOrderAsOf === "number"
    ) {
      return entry.receiptOrder > options.since.storeReceiptOrderAsOf;
    }
    return entry.createdAt > options.since.takenAt;
  }

  /**
   * Loads, verifies, decrypts, and decodes replay changes for conflict analysis.
   *
   * This mirrors the security checks used by normal materialization paths:
   * admin-only databases ignore non-admin entries, signatures are verified
   * before decryption, and malformed/missing entries are skipped with warnings.
   *
   * @param replayEntries Metadata entries selected by the conflict planner.
   * @returns Map keyed by store entry ID containing decrypted change bytes and
   *   decoded Automerge hash/dependency metadata for private replay.
   */
  private async loadVerifiedReplayChanges(
    replayEntries: StoreEntryMetadata[],
  ): Promise<Map<string, VerifiedReplayChange>> {
    const loadedEntries = replayEntries.length > 0
      ? await this.store.getEntries(replayEntries.map((entry) => entry.id))
      : [];
    const entryById = new Map(loadedEntries.map((entry) => [entry.id, entry]));
    const result = new Map<string, VerifiedReplayChange>();

    for (const metadata of replayEntries) {
      const entry = entryById.get(metadata.id);
      if (!entry) {
        this.logger.warn(`Conflict analysis: entry ${metadata.id} not found in store, skipping`);
        continue;
      }
      if (this._isAdminOnlyDb && entry.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping conflict analysis entry ${entry.id} not signed by admin key`);
        continue;
      }
      const isValid = await this.tenant.verifySignature(
        entry.encryptedData,
        entry.signature,
        entry.createdByPublicKey,
      );
      if (!isValid) {
        this.logger.warn(`Invalid signature for conflict analysis entry ${entry.id}, skipping`);
        continue;
      }
      const changeBytes = await this.tenant.decryptPayload(
        entry.encryptedData,
        entry.decryptionKeyId,
      );
      const decodedChange = Automerge.decodeChange(changeBytes) as Record<string, unknown>;
      result.set(metadata.id, {
        entry: metadata,
        changeBytes,
        automergeHash: typeof decodedChange.hash === "string" ? decodedChange.hash : null,
        dependencyHashes: Array.isArray(decodedChange.deps)
          ? decodedChange.deps.filter((dep): dep is string => typeof dep === "string")
          : [],
      });
    }

    return result;
  }

  /**
   * Builds a private lookup from Automerge change hashes to MindooDB entry IDs.
   *
   * Public conflict DTOs use MindooDB entry IDs, while Automerge heads are
   * hashes. This lookup lets us translate internal head sets back to stable
   * store-entry references for UI and report consumers.
   *
   * @param replayEntries Store metadata for replay entries.
   * @param verifiedChanges Decrypted/decoded changes keyed by entry ID.
   * @returns Map from Automerge hash to MindooDB store entry ID.
   */
  private buildAutomergeHashToEntryId(
    replayEntries: StoreEntryMetadata[],
    verifiedChanges: Map<string, VerifiedReplayChange>,
  ): Map<string, string> {
    const result = new Map<string, string>();
    for (const entry of replayEntries) {
      const parsed = parseDocEntryId(entry.id);
      if (parsed) {
        result.set(parsed.automergeHash, entry.id);
      }
      const verified = verifiedChanges.get(entry.id);
      if (verified?.automergeHash) {
        result.set(verified.automergeHash, entry.id);
      }
    }
    return result;
  }

  /**
   * Calls Automerge's diff API through a defensive private adapter.
   *
   * The public API must not depend on Automerge patch types. This wrapper keeps
   * the cast and optional-method handling localized so a future Automerge API
   * change affects only this internal method.
   *
   * @param doc Materialized internal Automerge document containing both head sets.
   * @param beforeHeads Heads before applying the current change.
   * @param afterHeads Heads after applying the current change.
   * @returns Raw patch-like records for internal inspection only.
   */
  private diffAutomergeHeads(
    doc: AutomergeTypes.Doc<MindooDocPayload>,
    beforeHeads: string[],
    afterHeads: string[],
  ): Array<Record<string, unknown>> {
    const automergeApi = Automerge as unknown as {
      diff?: (
        doc: AutomergeTypes.Doc<MindooDocPayload>,
        before: string[],
        after: string[],
      ) => Array<Record<string, unknown>>;
    };
    if (typeof automergeApi.diff !== "function") {
      return [];
    }
    return automergeApi.diff(doc, beforeHeads, afterHeads);
  }

  /**
   * Reads a patch action without leaking Automerge patch types into the codebase.
   *
   * @param patch Raw patch-like record returned by the private diff adapter.
   * @returns Patch action string, or null when unavailable.
   */
  private getConflictPatchAction(patch: Record<string, unknown>): string | null {
    return typeof patch.action === "string" ? patch.action : null;
  }

  /**
   * Normalizes a raw patch path into a JSON-safe MindooDB path array.
   *
   * @param patch Raw patch-like record returned by the private diff adapter.
   * @returns A path made of string/number segments, or null for unsupported
   *   patch shapes.
   */
  private getConflictPatchPath(patch: Record<string, unknown>): Array<string | number> | null {
    const path = patch.path;
    if (!Array.isArray(path) || path.length === 0) {
      return null;
    }
    const normalized = path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    );
    return normalized.length === path.length ? normalized : null;
  }

  /**
   * Checks Automerge's optional conflict marker on a raw patch.
   *
   * Some conflict states are not surfaced solely by this flag, so callers also
   * verify changed paths with `hasDocumentConflictAtPath()`.
   *
   * @param patch Raw patch-like record returned by the private diff adapter.
   * @returns True when the patch explicitly says it wrote a conflicted value.
   */
  private isConflictPatch(patch: Record<string, unknown>): boolean {
    return patch.conflict === true;
  }

  /**
   * Filters MindooDB bookkeeping fields out of app-facing conflict results.
   *
   * `_lastModified` can conflict naturally because independent replicas update
   * it during every change. Reporting it would be noisy and not useful to app
   * developers analyzing their own JSON payload.
   *
   * @param path Candidate conflict path.
   * @returns True when the path belongs to MindooDB internals.
   */
  private isInternalConflictPath(path: Array<string | number>): boolean {
    return path[0] === "_lastModified";
  }

  /**
   * Confirms whether a specific document path currently has multiple values.
   *
   * This is the narrow, path-level use of Automerge conflict inspection. It is
   * called only for paths surfaced by patches or by the bounded active-head scan.
   *
   * @param doc Internal document or nested object containing the candidate path.
   * @param path Path relative to `doc`.
   * @returns True when Automerge reports more than one conflicting value.
   */
  private hasDocumentConflictAtPath(
    doc: AutomergeTypes.Doc<MindooDocPayload>,
    path: Array<string | number>,
  ): boolean {
    if (path.length === 0) {
      return false;
    }
    const prop = path[path.length - 1];
    const parent = this.readValueAtDocumentPath(doc, path.slice(0, -1));
    if (parent === undefined || parent === null) {
      return false;
    }
    const conflicts = Automerge.getConflicts(parent as never, prop as never);
    return !!conflicts && Object.keys(conflicts).length > 1;
  }

  /**
   * Converts a conflict path into the public DTO representation.
   *
   * @param doc Internal document used to optionally resolve value summaries.
   * @param path JSON-style path segments for the conflicted field.
   * @param includeValues Whether to include winner/loser value summaries.
   * @returns Public path DTO with optional conflict values.
   */
  private buildDocumentConflictPath(
    doc: AutomergeTypes.Doc<MindooDocPayload>,
    path: Array<string | number>,
    includeValues: boolean,
  ): DocumentConflictPath {
    const pathString = formatDocumentConflictPath(path);
    const result: DocumentConflictPath = { path: [...path], pathString };
    if (includeValues) {
      result.values = this.getDocumentConflictValueSummaries(doc, path);
    }
    return result;
  }

  /**
   * Scans a materialized document for current conflicts.
   *
   * This is intentionally used only for bounded multi-head states: before a
   * resolving change is applied and after replay if unresolved active heads
   * remain. Regular per-change analysis stays patch-driven for performance.
   *
   * @param doc Internal materialized document to inspect.
   * @param includeValues Whether to include value summaries in returned paths.
   * @returns Sorted conflict path DTOs.
   */
  private collectDocumentConflictPaths(
    doc: AutomergeTypes.Doc<MindooDocPayload>,
    includeValues: boolean,
  ): DocumentConflictPath[] {
    const results = new Map<string, DocumentConflictPath>();
    const seen = new WeakSet<object>();
    this.collectDocumentConflictPathsFromParent(doc, doc, [], includeValues, results, seen);
    return Array.from(results.values()).sort((left, right) =>
      left.pathString.localeCompare(right.pathString),
    );
  }

  /**
   * Recursive worker for `collectDocumentConflictPaths()`.
   *
   * @param root Root internal document used when value summaries need absolute
   *   paths.
   * @param parent Current object/array being inspected.
   * @param basePath Path from `root` to `parent`.
   * @param includeValues Whether to include value summaries.
   * @param results Mutable result map keyed by path string.
   * @param seen Object identity set used to avoid cycles/proxy revisits.
   */
  private collectDocumentConflictPathsFromParent(
    root: AutomergeTypes.Doc<MindooDocPayload>,
    parent: unknown,
    basePath: Array<string | number>,
    includeValues: boolean,
    results: Map<string, DocumentConflictPath>,
    seen: WeakSet<object>,
  ): void {
    if (parent === null || parent === undefined || typeof parent !== "object") {
      return;
    }
    if (seen.has(parent)) {
      return;
    }
    seen.add(parent);

    const keys: Array<string | number> = Array.isArray(parent)
      ? parent.map((_value, index) => index)
      : Object.keys(parent);

    for (const key of keys) {
      const path = [...basePath, key];
      if (this.isInternalConflictPath(path)) {
        continue;
      }
      if (this.hasDocumentConflictAtPath(parent as AutomergeTypes.Doc<MindooDocPayload>, [key])) {
        const conflictPath = this.buildDocumentConflictPath(
          root,
          path,
          includeValues,
        );
        results.set(conflictPath.pathString, conflictPath);
      }
      this.collectDocumentConflictPathsFromParent(
        root,
        (parent as Record<string | number, unknown>)[key],
        path,
        includeValues,
        results,
        seen,
      );
    }
  }

  /**
   * Reads winner/loser summaries for one conflicted path.
   *
   * Values are converted into JSON-safe summaries so callers can inspect them
   * without seeing Automerge-specific wrappers or mutable document objects.
   *
   * @param doc Internal document containing the conflict.
   * @param path Absolute path to the conflicted field.
   * @returns Stable list of conflict value summaries.
   */
  private getDocumentConflictValueSummaries(
    doc: AutomergeTypes.Doc<MindooDocPayload>,
    path: Array<string | number>,
  ): DocumentConflictValueSummary[] {
    if (path.length === 0) {
      return [];
    }
    const prop = path[path.length - 1];
    const parent = this.readValueAtDocumentPath(doc, path.slice(0, -1));
    if (parent === undefined || parent === null) {
      return [];
    }
    const conflicts = Automerge.getConflicts(parent as never, prop as never);
    if (!conflicts) {
      return [];
    }
    const winner = this.readValueAtDocumentPath(doc, path);
    const winnerFingerprint = this.fingerprintConflictValue(winner);
    return Object.entries(conflicts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([conflictId, value]) => ({
        conflictId,
        preview: this.previewChangeValue(value),
        value: this.toJsonSafeConflictValue(value),
        isWinner: this.fingerprintConflictValue(value) === winnerFingerprint,
      }));
  }

  /**
   * Reads a nested value using the public path representation.
   *
   * @param root Root object/document to read from.
   * @param path String/number path segments.
   * @returns The value at the path, or undefined when any segment is missing.
   */
  private readValueAtDocumentPath(root: unknown, path: Array<string | number>): unknown {
    let current = root;
    for (const segment of path) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = (current as Record<string | number, unknown>)[segment];
    }
    return current;
  }

  /**
   * Produces a stable comparison key for conflict winner detection.
   *
   * @param value Value to fingerprint.
   * @returns String key derived from the JSON-safe representation.
   */
  private fingerprintConflictValue(value: unknown): string {
    try {
      return JSON.stringify(this.toJsonSafeConflictValue(value));
    } catch {
      return String(value);
    }
  }

  /**
   * Converts arbitrary conflict values to bounded, JSON-safe data.
   *
   * This avoids exposing live Automerge objects and prevents very deep or cyclic
   * structures from overwhelming reports.
   *
   * @param value Value to convert.
   * @param depth Current recursion depth.
   * @param seen Objects already visited during this conversion.
   * @returns JSON-safe scalar, array/object subset, or compact placeholder.
   */
  private toJsonSafeConflictValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      return value;
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
      return undefined;
    }
    if (value instanceof Uint8Array) {
      return { type: "Uint8Array", byteLength: value.byteLength };
    }
    if (typeof value !== "object") {
      return String(value);
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (depth >= 4) {
      return this.previewChangeValue(value);
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => this.toJsonSafeConflictValue(item, depth + 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      result[key] = this.toJsonSafeConflictValue(child, depth + 1, seen);
    }
    return result;
  }

  /**
   * Throws when the caller cancels conflict analysis.
   *
   * @param signal Optional `AbortSignal` supplied through analysis options.
   */
  private throwIfConflictAnalysisAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Conflict analysis aborted");
    }
  }

  /**
   * Cooperatively yields to the event loop during long browser/server scans.
   *
   * @param yieldEveryMs Minimum elapsed time before yielding. Undefined disables
   *   cooperative yielding; `0` yields at every call site.
   * @param lastYieldAt Timestamp of the previous yield.
   * @returns Updated timestamp to carry into the next call.
   */
  private async maybeYieldForConflictAnalysis(
    yieldEveryMs: number | undefined,
    lastYieldAt: number,
  ): Promise<number> {
    if (yieldEveryMs === undefined || yieldEveryMs < 0) {
      return lastYieldAt;
    }
    const now = Date.now();
    if (now - lastYieldAt < yieldEveryMs) {
      return lastYieldAt;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return Date.now();
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
      if (entry.accessState === "visible" && !entry.isDeleted) {
        docIds.push(entry.docId);
      }
    }
    return docIds;
  }

  async getDeletedDocumentIds(): Promise<string[]> {
    const docIds: string[] = [];
    for (const entry of this.index) {
      if (entry.accessState === "visible" && entry.isDeleted) {
        docIds.push(entry.docId);
      }
    }
    return docIds;
  }

  async getAllDocumentIdsAtTimestamp(timestamp: number): Promise<string[]> {
    // findEntries() uses an exclusive upper bound (createdAt < creationDateUntil).
    // Query up to timestamp + 1 so entries created exactly at `timestamp` are included
    // for the strict checks below (createTime < timestamp, deleteTime > timestamp).
    let upperBoundExclusive =
      timestamp === Number.MAX_SAFE_INTEGER ? timestamp : timestamp + 1;
    if (this.timeTravelDate != null) {
      upperBoundExclusive = Math.min(upperBoundExclusive, this.timeTravelDate);
    }

    // We only need lifecycle metadata for this query. Changes and snapshots can
    // affect document contents, but create/delete/undelete determine existence.
    const [creates, deletes, undeletes] = await Promise.all([
      this.store.findEntries("doc_create", null, upperBoundExclusive),
      this.store.findEntries("doc_delete", null, upperBoundExclusive),
      this.store.findEntries("doc_undelete", null, upperBoundExclusive),
    ]);

    const lifecycleEntriesByDocId = new Map<string, StoreEntryMetadata[]>();
    const addLifecycleEntry = (entry: StoreEntryMetadata) => {
      // Group entries by document so each document's lifecycle can be evaluated
      // independently without materializing its Automerge state.
      const entries = lifecycleEntriesByDocId.get(entry.docId) ?? [];
      entries.push(entry);
      lifecycleEntriesByDocId.set(entry.docId, entries);
    };
    for (const entry of creates) {
      addLifecycleEntry(entry);
    }
    for (const entry of deletes) {
      addLifecycleEntry(entry);
    }
    for (const entry of undeletes) {
      addLifecycleEntry(entry);
    }

    const docIds: string[] = [];
    for (const [docId, lifecycleEntries] of lifecycleEntriesByDocId.entries()) {
      // Sort deterministically so same-timestamp lifecycle entries resolve the
      // same way on every replica.
      const ordered = lifecycleEntries.sort((a, b) =>
        a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id.localeCompare(b.id)
      );
      // A document cannot exist before its create entry, even if malformed or
      // partial metadata somehow contains later lifecycle entries.
      if (!ordered.some((entry) => entry.entryType === "doc_create" && entry.createdAt <= timestamp)) {
        continue;
      }
      const createEntry = ordered.find((entry) => entry.entryType === "doc_create");
      if (createEntry && !(await this.tenant.hasDecryptionKey(createEntry.decryptionKeyId))) {
        continue;
      }
      // Delete and undelete are terminal lifecycle markers. The latest one at
      // the timestamp decides whether the document existed then.
      const latestTerminal = ordered
        .filter((entry) => entry.entryType === "doc_delete" || entry.entryType === "doc_undelete")
        .at(-1);
      if (!latestTerminal || latestTerminal.entryType === "doc_undelete") {
        docIds.push(docId);
      }
    }
    
    return docIds;
  }

  async deleteDocument(docId: string, options: DeleteOptions = {}): Promise<void> {
    return this.deleteDocInternal(docId, options.signingKeyPair, options.signingKeyPassword);
  }

  async deleteDocumentWithSigningKey(
    docId: string,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void> {
    return this.deleteDocument(docId, { signingKeyPair, signingKeyPassword });
  }

  async undeleteDocument(docId: string, options: UndeleteOptions = {}): Promise<void> {
    return this.undeleteDocInternal(docId, options.signingKeyPair, options.signingKeyPassword);
  }

  private async assertLifecycleMutationAllowed(
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string,
  ): Promise<void> {
    this.assertWritable("document lifecycle mutation");
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    if ((signingKeyPair !== undefined) !== (signingKeyPassword !== undefined)) {
      throw new Error("Lifecycle mutation requires both signingKeyPair and signingKeyPassword");
    }
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomSigningKey
        ? signingKeyPair!.publicKey
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
  }

  /**
   * Write a delete or undelete lifecycle entry for an existing document.
   *
   * The document body is preserved; this method only writes a small Automerge
   * change that advances `_lastModified`, wraps it in the requested lifecycle
   * StoreEntry type, signs/encrypts it, and updates local caches/indexes.
   */
  private async writeLifecycleEntry(
    internalDoc: InternalDoc,
    entryType: "doc_delete" | "doc_undelete",
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string,
  ): Promise<void> {
    // Delete and undelete are encoded as normal Automerge changes so the DAG
    // keeps causal ancestry, while the StoreEntry type carries lifecycle intent.
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    const now = Date.now();
    const docId = internalDoc.id;

    // Lifecycle changes are intentionally non-destructive: they only bump
    // `_lastModified` and repair missing legacy attachment arrays. The document
    // body remains available for history and future undeletion.
    const newDoc = Automerge.change(
      internalDoc.doc,
      { time: now },
      (doc: MindooDocPayload) => {
        if (!Array.isArray(doc._attachments)) {
          doc._attachments = [];
        }
        doc._lastModified = now;
      },
    );

    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }

    const decodedChange = Automerge.decodeChange(changeBytes);
    const automergeHash = decodedChange.hash;
    const automergeDepHashes = decodedChange.deps || [];
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    // Convert Automerge dependency hashes back into store entry IDs so metadata
    // consumers can traverse the lifecycle DAG without decrypting payloads.
    const dependencyIds = await this.ensureAutomergeDepsResolved(docId, automergeDepHashes);

    let signature: Uint8Array;
    let createdByPublicKey: string;
    if (useCustomSigningKey) {
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair!, signingKeyPassword!);
      createdByPublicKey = signingKeyPair!.publicKey;
    } else {
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }

    // The encrypted Automerge change is the payload; the metadata classifies it
    // as a delete or undelete lifecycle entry for fast history/view queries.
    const entryMetadata: StoreEntryMetadata = {
      entryType,
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
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };

    await this.store.putEntries([fullEntry]);
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);

    // Keep the loaded document, cache, index, and sync dirty tracking in step
    // with the append-only store entry we just wrote.
    internalDoc.doc = newDoc;
    internalDoc.isDeleted = entryType === "doc_delete";
    internalDoc.lastModified = now;
    await this.storeCachedDocument(internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, internalDoc.isDeleted, internalDoc.decryptionKeyId, "visible");
    this.markDocDirty(docId);
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
    await this.assertLifecycleMutationAllowed(signingKeyPair, signingKeyPassword);
    
    // Get current document
    const internalDoc = await this.loadDocumentInternal(docId);
    if (!internalDoc || internalDoc.isDeleted) {
      throw new Error(`Document ${docId} not found or already deleted`);
    }
    await this.writeLifecycleEntry(internalDoc, "doc_delete", signingKeyPair, signingKeyPassword);
    this.logger.info(`Document ${docId} deleted successfully`);
  }

  private async undeleteDocInternal(
    docId: string,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<void> {
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    this.logger.debug(`Undeleting document ${docId}${useCustomSigningKey ? ' using custom signing key' : ''}`);
    await this.assertLifecycleMutationAllowed(signingKeyPair, signingKeyPassword);

    const internalDoc = await this.loadDocumentInternal(docId);
    if (!internalDoc) {
      throw new Error(`Document ${docId} not found`);
    }
    if (!internalDoc.isDeleted) {
      this.logger.debug(`Document ${docId} is already alive; undelete is a no-op`);
      return;
    }

    await this.writeLifecycleEntry(internalDoc, "doc_undelete", signingKeyPair, signingKeyPassword);
    this.logger.info(`Document ${docId} undeleted successfully`);
  }

  async changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    options: ChangeOptions = {}
  ): Promise<void> {
    return this.changeDocInternal(doc, changeFunc, options.signingKeyPair, options.signingKeyPassword);
  }

  async changeDocWithSigningKey(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void> {
    return this.changeDoc(doc, changeFunc, { signingKeyPair, signingKeyPassword });
  }

  async applyTextPatch(doc: MindooDoc, patch: MindooTextPatch): Promise<MindooTextPatchResult> {
    this.assertWritable("applyTextPatch");
    const docId = doc.getId();
    this.logger.debug(`===== applyTextPatch called for document ${docId} =====`);

    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const currentUser = await this.tenant.getCurrentUserId();
      if (currentUser.userSigningPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }

    let internalDoc = this.getCachedDocument(docId);
    if (!internalDoc) {
      const loadedDoc = await this.loadDocumentInternal(docId);
      if (!loadedDoc) {
        throw new Error(`Document ${docId} not found`);
      }
      internalDoc = loadedDoc;
    }

    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }

    this.validateTextPatch(patch);
    const now = Date.now();
    const headsBeforeChange = Automerge.getHeads(internalDoc.doc);
    const baseHeads = patch.baseHeads;
    const applyEdits = (automergeDoc: MindooDocPayload) => {
      this.ensureTextPath(automergeDoc, patch.path);
      for (const edit of patch.edits) {
        Automerge.splice(
          automergeDoc as AutomergeTypes.Doc<MindooDocPayload>,
          patch.path as AutomergeTypes.Prop[],
          edit.index,
          edit.deleteCount,
          edit.insert ?? "",
        );
      }
      automergeDoc._lastModified = now;
    };

    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    try {
      if (baseHeads && baseHeads.length > 0) {
        const result = Automerge.changeAt(
          internalDoc.doc,
          baseHeads as AutomergeTypes.Heads,
          applyEdits,
        );
        newDoc = result.newDoc as AutomergeTypes.Doc<MindooDocPayload>;
      } else {
        newDoc = Automerge.change(internalDoc.doc, applyEdits);
      }
      this.logger.debug(`Successfully applied text patch, new document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      this.logger.error(`Error applying text patch for document ${docId}:`, error);
      throw error;
    }

    await this.persistDocumentChange({
      internalDoc,
      newDoc,
      now,
      headsBeforeChange,
      useCustomKey: false,
      successMessage: "text patched",
    });

    const wrapped = this.wrapDocument(internalDoc);
    return {
      doc: wrapped,
      heads: wrapped.getHeads(),
      data: wrapped.getData(),
    };
  }

  async applyJsonPatch(doc: MindooDoc, patch: MindooJsonPatch): Promise<MindooJsonPatchResult> {
    this.assertWritable("applyJsonPatch");
    const docId = doc.getId();
    this.logger.debug(`===== applyJsonPatch called for document ${docId} =====`);

    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const currentUser = await this.tenant.getCurrentUserId();
      if (currentUser.userSigningPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }

    let internalDoc = this.getCachedDocument(docId);
    if (!internalDoc) {
      const loadedDoc = await this.loadDocumentInternal(docId);
      if (!loadedDoc) {
        throw new Error(`Document ${docId} not found`);
      }
      internalDoc = loadedDoc;
    }

    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }

    this.validateJsonPatch(patch);
    const now = Date.now();
    const headsBeforeChange = Automerge.getHeads(internalDoc.doc);
    const applyPatch = (automergeDoc: MindooDocPayload) => {
      this.applyJsonPatchOperations(automergeDoc, patch);
      automergeDoc._lastModified = now;
    };

    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    try {
      if (patch.baseHeads && patch.baseHeads.length > 0) {
        const result = Automerge.changeAt(
          internalDoc.doc,
          patch.baseHeads as AutomergeTypes.Heads,
          applyPatch,
        );
        newDoc = result.newDoc as AutomergeTypes.Doc<MindooDocPayload>;
      } else {
        newDoc = Automerge.change(internalDoc.doc, applyPatch);
      }
      this.logger.debug(`Successfully applied JSON patch, new document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      this.logger.error(`Error applying JSON patch for document ${docId}:`, error);
      throw error;
    }

    await this.persistDocumentChange({
      internalDoc,
      newDoc,
      now,
      headsBeforeChange,
      useCustomKey: false,
      successMessage: "JSON patched",
    });

    const wrapped = this.wrapDocument(internalDoc);
    return {
      doc: wrapped,
      heads: wrapped.getHeads(),
      data: wrapped.getData(),
    };
  }

  private async changeDocInternal(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<void> {
    this.assertWritable("changeDoc");
    const docId = doc.getId();
    if ((signingKeyPair !== undefined) !== (signingKeyPassword !== undefined)) {
      throw new Error("changeDoc: signingKeyPair and signingKeyPassword must be provided together");
    }
    const useCustomKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
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
      getHeads: () => Automerge.getHeads(internalDoc.doc),
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
          const [pendingRef] = pendingAttachmentAdditions.splice(pendingIndex, 1);
          await db.cleanupIncompleteAttachmentUpload(docId, pendingRef.attachmentId);
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
    try {
      await changeFunc(collectingDoc);
    } catch (error) {
      await Promise.all(
        pendingAttachmentAdditions.map((ref) =>
          this.cleanupIncompleteAttachmentUpload(docId, ref.attachmentId)
        )
      );
      throw error;
    }
    
    // Deactivate the callback guard - no more changes can be made via collectingDoc
    isCallbackActive = false;
    
    // Now apply the collected changes synchronously in Automerge.change()
    const headsBeforeChange = Automerge.getHeads(internalDoc.doc);
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
      await Promise.all(
        pendingAttachmentAdditions.map((ref) =>
          this.cleanupIncompleteAttachmentUpload(docId, ref.attachmentId)
        )
      );
      throw error;
    }
    
    try {
      await this.persistDocumentChange({
        internalDoc,
        newDoc,
        now,
        headsBeforeChange,
        useCustomKey: Boolean(useCustomKey),
        signingKeyPair,
        signingKeyPassword,
        successMessage: useCustomKey ? "changed with custom signing key" : "changed",
        attachmentIds: pendingAttachmentAdditions.map((ref) => ref.attachmentId),
      });
    } catch (error) {
      await Promise.all(
        pendingAttachmentAdditions.map((ref) =>
          this.cleanupIncompleteAttachmentUpload(docId, ref.attachmentId)
        )
      );
      throw error;
    }

    await Promise.all(
      pendingAttachmentAdditions.map((ref) =>
        this.clearPendingAttachmentUploadLedger(ref.attachmentId)
      )
    );
  }

  private validateTextPatch(patch: MindooTextPatch): void {
    if (!Array.isArray(patch.path) || patch.path.length === 0) {
      throw new Error("Text patch path must contain at least one segment");
    }
    for (const segment of patch.path) {
      if (typeof segment !== "string" && typeof segment !== "number") {
        throw new Error("Text patch path segments must be strings or numbers");
      }
    }
    if (!Array.isArray(patch.edits) || patch.edits.length === 0) {
      throw new Error("Text patch must include at least one edit");
    }
    for (const edit of patch.edits) {
      if (!Number.isInteger(edit.index) || edit.index < 0) {
        throw new Error("Text edit index must be a non-negative integer");
      }
      if (!Number.isInteger(edit.deleteCount) || edit.deleteCount < 0) {
        throw new Error("Text edit deleteCount must be a non-negative integer");
      }
      if (edit.insert !== undefined && typeof edit.insert !== "string") {
        throw new Error("Text edit insert value must be a string when provided");
      }
    }
  }

  private validateJsonPatch(patch: MindooJsonPatch): void {
    const operationCount = (patch.set?.length ?? 0)
      + (patch.unset?.length ?? 0)
      + (patch.listDelete?.length ?? 0)
      + (patch.listInsert?.length ?? 0);
    if (operationCount === 0) {
      throw new Error("JSON patch must include at least one operation");
    }
    for (const operation of patch.set ?? []) {
      this.validateJsonPath(operation.path, "JSON set");
    }
    for (const operation of patch.unset ?? []) {
      this.validateJsonPath(operation.path, "JSON unset");
    }
    for (const operation of patch.listDelete ?? []) {
      this.validateJsonPath(operation.path, "JSON listDelete");
      if (!Number.isInteger(operation.index) || operation.index < 0) {
        throw new Error("JSON listDelete index must be a non-negative integer");
      }
      if (!Number.isInteger(operation.deleteCount) || operation.deleteCount < 0) {
        throw new Error("JSON listDelete deleteCount must be a non-negative integer");
      }
    }
    for (const operation of patch.listInsert ?? []) {
      this.validateJsonPath(operation.path, "JSON listInsert");
      if (!Number.isInteger(operation.index) || operation.index < 0) {
        throw new Error("JSON listInsert index must be a non-negative integer");
      }
      if (!Array.isArray(operation.values)) {
        throw new Error("JSON listInsert values must be an array");
      }
    }
  }

  private validateJsonPath(path: Array<string | number>, label: string): void {
    if (!Array.isArray(path) || path.length === 0) {
      throw new Error(`${label} path must contain at least one segment`);
    }
    for (const segment of path) {
      if (typeof segment !== "string" && typeof segment !== "number") {
        throw new Error(`${label} path segments must be strings or numbers`);
      }
    }
  }

  private applyJsonPatchOperations(automergeDoc: MindooDocPayload, patch: MindooJsonPatch): void {
    for (const operation of patch.set ?? []) {
      this.setJsonValueAtPath(automergeDoc, operation.path, structuredClone(operation.value));
    }
    for (const operation of patch.unset ?? []) {
      this.unsetJsonValueAtPath(automergeDoc, operation.path);
    }
    for (const operation of patch.listDelete ?? []) {
      const list = this.readJsonListAtPath(automergeDoc, operation.path);
      list.splice(operation.index, operation.deleteCount);
    }
    for (const operation of patch.listInsert ?? []) {
      const list = this.readJsonListAtPath(automergeDoc, operation.path);
      list.splice(operation.index, 0, ...structuredClone(operation.values));
    }
  }

  private setJsonValueAtPath(target: MindooDocPayload, path: Array<string | number>, value: unknown): void {
    const parent = this.ensureJsonParentAtPath(target, path);
    parent[path[path.length - 1]] = value;
  }

  private unsetJsonValueAtPath(target: MindooDocPayload, path: Array<string | number>): void {
    const parent = this.readJsonParentAtPath(target, path);
    delete parent[path[path.length - 1]];
  }

  private readJsonListAtPath(target: MindooDocPayload, path: Array<string | number>): unknown[] {
    let value: any = target;
    for (const segment of path) {
      value = value?.[segment];
    }
    if (!Array.isArray(value)) {
      throw new Error(`Cannot apply JSON list operation to non-array value at '${path.map(String).join(".")}'`);
    }
    return value;
  }

  private ensureJsonParentAtPath(target: MindooDocPayload, path: Array<string | number>): Record<string | number, unknown> {
    let parent: any = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index];
      const nextSegment = path[index + 1];
      if (parent[segment] === undefined || parent[segment] === null) {
        parent[segment] = typeof nextSegment === "number" ? [] : {};
      }
      parent = parent[segment];
      if (parent === null || typeof parent !== "object") {
        throw new Error(`Cannot apply JSON patch through non-object path segment '${String(segment)}'`);
      }
    }
    return parent;
  }

  private readJsonParentAtPath(target: MindooDocPayload, path: Array<string | number>): Record<string | number, unknown> {
    let parent: any = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      parent = parent?.[path[index]];
      if (parent === null || typeof parent !== "object") {
        throw new Error(`Cannot resolve JSON patch path '${path.map(String).join(".")}'`);
      }
    }
    return parent;
  }

  private ensureTextPath(automergeDoc: MindooDocPayload, path: Array<string | number>): void {
    let target: any = automergeDoc;
    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i];
      const nextSegment = path[i + 1];
      if (target[segment] === undefined || target[segment] === null) {
        target[segment] = typeof nextSegment === "number" ? [] : {};
      }
      target = target[segment];
      if (target === null || typeof target !== "object") {
        throw new Error(`Cannot apply text patch through non-object path segment '${String(segment)}'`);
      }
    }

    const leaf = path[path.length - 1];
    const currentValue = target[leaf];
    if (currentValue === undefined || currentValue === null) {
      target[leaf] = "";
      return;
    }
    if (typeof currentValue !== "string") {
      throw new Error(`Cannot apply text patch to non-string value at '${path.map(String).join(".")}'`);
    }
  }

  private async persistDocumentChange(options: {
    internalDoc: InternalDoc;
    newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    now: number;
    headsBeforeChange?: string[];
    useCustomKey: boolean;
    signingKeyPair?: SigningKeyPair;
    signingKeyPassword?: string;
    successMessage: string;
    attachmentIds?: string[];
  }): Promise<void> {
    const { internalDoc, newDoc, now, headsBeforeChange, useCustomKey, signingKeyPair, signingKeyPassword, successMessage, attachmentIds } = options;
    const docId = internalDoc.id;
    this.logger.debug(`Getting change bytes from document ${docId}`);
    const changesSincePreviousHeads = headsBeforeChange
      ? Automerge.getChangesSince(newDoc, headsBeforeChange as AutomergeTypes.Heads)
      : [];
    if (changesSincePreviousHeads.length > 1) {
      throw new Error(`Expected one Automerge change, got ${changesSincePreviousHeads.length}`);
    }
    const changeBytes = changesSincePreviousHeads[0] ?? Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    this.logger.debug(`Got change bytes: ${changeBytes.length} bytes`);

    const decodedChange = Automerge.decodeChange(changeBytes);
    const automergeHash = decodedChange.hash;
    const automergeDepHashes = decodedChange.deps || [];
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    this.logger.debug(`Generated entry ID for change: ${entryId}`);
    const dependencyIds = await this.ensureAutomergeDepsResolved(docId, automergeDepHashes);

    let signature: Uint8Array;
    let createdByPublicKey: string;
    if (useCustomKey) {
      if (!signingKeyPair || !signingKeyPassword) {
        throw new Error("Custom signing requires both signingKeyPair and signingKeyPassword");
      }
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair, signingKeyPassword);
      createdByPublicKey = signingKeyPair.publicKey;
    } else {
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }

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
      attachmentIds: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
    };
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };

    await this.store.putEntries([fullEntry]);
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);

    internalDoc.doc = newDoc;
    internalDoc.lastModified = now;
    await this.storeCachedDocument(internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, internalDoc.isDeleted, internalDoc.decryptionKeyId, "visible");
    this.markDocDirty(docId);

    this.logger.info(`Document ${docId} ${successMessage} successfully`);
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
        (em) => this.isDocumentReplayEntry(em),
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
      const headEntryIds = await this.ensureAutomergeDepsResolved(docId, headHashes);
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
      accessState?: DocumentAccessState;
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
      const entry = indexSnapshot[i];
      if (entry.accessState === "inaccessible") {
        continue;
      }
      const docId = entry.docId;
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
      isDeleted: this.computeIsDeletedFromMetadata(replayEntriesForState),
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
        if (entry.accessState !== "visible") {
          continue;
        }
        
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
      (em) => this.isDocumentReplayEntry(em)
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
    
    const allDocMetadata = await this.scanAllMetadata(this.store, { docId });
    const isDeleted = this.computeIsDeletedFromMetadata(allDocMetadata);
    
    const updatedInternalDoc: InternalDoc = {
      id: docId,
      doc: updatedDoc,
      createdAt: cachedDoc.createdAt,
      lastModified,
      decryptionKeyId: cachedDoc.decryptionKeyId,
      isDeleted,
    };
    // Update cache
    await this.storeCachedDocument(updatedInternalDoc);
    this.markDocDirty(docId);
    
    return updatedInternalDoc;
  }

  /**
   * Try to satisfy a document load from the persisted L2 cache without
   * going through the full signature-verify + decrypt + Automerge replay
   * pipeline.
   *
   * Three outcomes:
   *
   * 1. **L2 miss / unusable** (no record, legacy v1 record, deserialize
   *    failure, no `cacheManager`, etc.): returns `null`. The caller
   *    falls through to the existing full-materialization path.
   *
   * 2. **L2 fresh hit** (`persistedChangeSeq === currentChangeSeq`):
   *    promote the deserialized doc to L1 and return it. No store
   *    traffic, no crypto, no Automerge replay. This is the common case
   *    for warm databases and is what makes view rebuilds fast.
   *
   * 3. **L2 stale hit** (`persistedChangeSeq < currentChangeSeq`): scan
   *    the doc's store metadata, identify entries whose `automergeHash`
   *    is *not* already in the persisted doc's history, and re-use the
   *    existing {@link applyNewEntriesToCachedDocument} pipeline to
   *    verify+decrypt+apply only those deltas. Pre-filtering by hash
   *    means we never pay signature/decrypt cost for changes already
   *    captured in the persisted Automerge state.
   *
   * Any unexpected error degrades gracefully to the full path - the L2
   * read path is purely an optimization and must never lose data.
   */
  private async tryLoadFromL2(docId: string): Promise<InternalDoc | null> {
    const store = this.cacheManager?.getStore() ?? null;
    if (!store) return null;

    const prefix = this.getCachePrefix();
    const key = `${prefix}/${docId}`;

    let bytes: Uint8Array | null;
    try {
      bytes = await store.get("doc", key);
    } catch (e) {
      this.logger.warn(`L2 read failed for ${docId}; falling back to full materialization: ${e}`);
      return null;
    }
    if (!bytes) return null;

    let deserialized: DeserializedCachedDoc | null;
    try {
      deserialized = this.deserializeDoc(bytes);
    } catch (e) {
      this.logger.warn(`L2 deserialize failed for ${docId}, evicting stale record: ${e}`);
      try {
        await store.delete("doc", key);
      } catch (deleteError) {
        this.logger.warn(`Failed to evict corrupt L2 record for ${docId}: ${deleteError}`);
      }
      return null;
    }
    if (deserialized === null) {
      // Legacy v1 record - fall through; the full path will rewrite a v2 record.
      return null;
    }

    const { internal, persistedChangeSeq } = deserialized;
    // L2 records persist the decrypted Automerge state. If the current
    // KeyBag cannot resolve the doc's key, scrub the cached copy and
    // refuse to surface it instead of returning plaintext for which the
    // caller no longer has authorization.
    if (!(await this.tenant.hasDecryptionKey(internal.decryptionKeyId))) {
      await this.purgeMaterializedDocument(docId);
      return null;
    }

    const indexEntryIdx = this.indexLookup.get(docId);
    if (indexEntryIdx === undefined) {
      // Doc isn't in the in-memory changefeed index. Either the cache is
      // ahead of the index (very rare race during initial restore) or the
      // L2 record is orphaned. Drop and fall through.
      try {
        await store.delete("doc", key);
      } catch (deleteError) {
        this.logger.warn(`Failed to evict orphaned L2 record for ${docId}: ${deleteError}`);
      }
      return null;
    }

    const currentChangeSeq = this.index[indexEntryIdx].changeSeq;

    // Fresh hit: index agrees with the persisted state.
    if (persistedChangeSeq === currentChangeSeq) {
      await this.storeCachedDocument(internal);
      return internal;
    }

    // L2 newer than index: should not happen in a well-behaved system,
    // but trust the persisted record and re-mark dirty so the next flush
    // re-anchors the changeSeq pointer.
    if (persistedChangeSeq > currentChangeSeq) {
      this.logger.warn(
        `L2 record for ${docId} reports changeSeq ${persistedChangeSeq} > index changeSeq ${currentChangeSeq}; trusting L2`
      );
      await this.storeCachedDocument(internal);
      this.markDocDirty(docId);
      return internal;
    }

    // Stale L2. Identify the entries the persisted doc is missing and
    // apply only those via the standard incremental path.
    let allMetadata: StoreEntryMetadata[];
    try {
      allMetadata = await this.scanAllMetadata(this.store, { docId });
    } catch (e) {
      this.logger.warn(`L2 stale-doc metadata scan failed for ${docId}: ${e}`);
      return null;
    }

    // Enumerate Automerge change hashes already in the persisted doc.
    const persistedHashes = new Set<string>();
    try {
      for (const ch of Automerge.getAllChanges(internal.doc)) {
        const decoded = Automerge.decodeChange(ch);
        persistedHashes.add(decoded.hash);
      }
    } catch (e) {
      this.logger.warn(`Failed to enumerate persisted changes for ${docId}: ${e}`);
      return null;
    }

    const missingMetadata = allMetadata.filter((em) => {
      const parsed = parseDocEntryId(em.id);
      if (!parsed) return true;
      return !persistedHashes.has(parsed.automergeHash);
    });

    if (missingMetadata.length === 0) {
      // No real deltas (changeSeq pointer drift only). Promote and return.
      await this.storeCachedDocument(internal);
      return internal;
    }

    let updated: InternalDoc | null;
    try {
      updated = await this.applyNewEntriesToCachedDocument(internal, missingMetadata);
    } catch (e) {
      this.logger.warn(`L2 incremental apply failed for ${docId}: ${e}`);
      return null;
    }

    if (updated === null) {
      // applyNewEntriesToCachedDocument returns null when no signed entries
      // produced a head change. Treat the persisted doc as authoritative
      // and put it in L1 ourselves (the helper only caches when it
      // actually applied work).
      await this.storeCachedDocument(internal);
      return internal;
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Background L2 warmer (Phase 4)
  // ---------------------------------------------------------------------------

  /**
   * Returns whether a background warmer pass is currently running.
   *
   * @see startBackgroundWarmer
   * @see stopBackgroundWarmer
   */
  isWarmerRunning(): boolean {
    return this.warmerPromise !== null;
  }

  /**
   * Start the L2 background warmer.
   *
   * Walks a snapshot of the in-memory document index and, for every
   * doc not already in L1, calls {@link tryLoadFromL2}. That path
   * either:
   *
   *  - hits L2 fresh and just promotes the doc to L1, or
   *  - hits L2 stale and applies missing deltas (re-flushed via the
   *    next CacheManager flush), or
   *  - falls through to full materialization for L2 misses, which then
   *    flushes a fresh L2 record via flush-before-evict.
   *
   * In all cases, after the warmer has visited every doc, every L2
   * record has the current `changeSeq + automergeHeads`. Subsequent
   * read-heavy workloads (most importantly virtual view rebuilds) can
   * then satisfy every doc lookup via the cheap L2 read path.
   *
   * Single-flight: if a warmer is already running, the existing promise
   * is returned. Yields to {@link warmerScheduler} between batches of
   * `warmerBatchSize` docs so the foreground stays responsive.
   *
   * Cancellable via {@link stopBackgroundWarmer} or by passing an
   * external {@link AbortSignal}. Cancellation is observed at batch
   * boundaries; the in-flight doc is allowed to complete.
   */
  startBackgroundWarmer(options?: StartBackgroundWarmerOptions): Promise<void> {
    if (this.warmerPromise) {
      // Single-flight: return the in-flight promise. We deliberately do
      // not honor a new external signal in this case - the caller can
      // either stopBackgroundWarmer() to kill the existing run and
      // re-start, or wait for the in-flight pass to finish.
      return this.warmerPromise;
    }

    const internalAbort = new AbortController();
    this.warmerAbort = internalAbort;

    // If the caller passed an external signal, propagate aborts.
    const externalSignal = options?.signal;
    let externalListener: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        internalAbort.abort();
      } else {
        externalListener = () => internalAbort.abort();
        externalSignal.addEventListener("abort", externalListener);
      }
    }

    const run = this.runBackgroundWarmer(internalAbort.signal, options?.onProgress).finally(() => {
      this.warmerPromise = null;
      this.warmerAbort = null;
      if (externalSignal && externalListener) {
        externalSignal.removeEventListener("abort", externalListener);
      }
    });
    this.warmerPromise = run;
    return run;
  }

  /**
   * Returns a snapshot of the most recent background warmer pass's
   * progress, or `null` if no warmer has ever run on this instance.
   *
   * The returned object is the live snapshot used internally by
   * {@link runBackgroundWarmer}; callers MUST NOT mutate it. The snapshot
   * is replaced (not mutated in place) on the next
   * {@link startBackgroundWarmer} call, so consumers polling this
   * method see consistent integer readings.
   *
   * @see startBackgroundWarmer
   */
  getBackgroundWarmerProgress(): BackgroundWarmerProgress | null {
    return this.warmerProgress;
  }

  /**
   * Cancel the in-flight warmer (if any) and wait for it to settle.
   * Safe to call when no warmer is running - returns a resolved
   * promise immediately.
   */
  async stopBackgroundWarmer(): Promise<void> {
    const inFlight = this.warmerPromise;
    if (!inFlight) return;
    this.warmerAbort?.abort();
    try {
      await inFlight;
    } catch {
      // Errors are already logged inside the warmer body. Swallow here
      // so callers waiting only for "warmer is no longer running" do
      // not have to wrap stopBackgroundWarmer in try/catch.
    }
  }

  /**
   * Body of one warmer pass. Pulled out so {@link startBackgroundWarmer}
   * can wrap it in single-flight + abort plumbing without nesting.
   *
   * Maintains `this.warmerProgress` as a fresh snapshot for
   * {@link getBackgroundWarmerProgress} consumers and invokes
   * `onProgress` once per scheduler yield (per `warmerBatchSize` docs)
   * plus once at the end of the pass with the terminal phase.
   */
  private async runBackgroundWarmer(
    signal: AbortSignal,
    onProgress?: (progress: BackgroundWarmerProgress) => void,
  ): Promise<void> {
    if (!this.cacheManager) {
      this.logger.debug("Warmer skipped: no cacheManager attached, no L2 to warm.");
      return;
    }

    // Snapshot the docId list so concurrent index updates don't shift
    // our iteration mid-pass. Iterating the index directly would also
    // work but a snapshot makes the loop's behavior easier to reason
    // about under sync activity.
    const docIds = this.index.map((entry) => entry.docId);
    const total = docIds.length;

    // Progress snapshot is replaced (not mutated in place) so polled
    // readers see consistent values. We initialize even when total=0
    // so the UI can display a "done" terminal state.
    this.warmerProgress = { processed: 0, total, phase: "warming" };
    const emitProgress = (progress: BackgroundWarmerProgress) => {
      this.warmerProgress = progress;
      if (!onProgress) return;
      try {
        onProgress(progress);
      } catch (e) {
        // A buggy progress consumer must not break the warmer.
        this.logger.warn(`Warmer onProgress callback threw: ${e}`);
      }
    };

    if (total === 0) {
      this.logger.debug("Warmer: nothing to warm, index is empty.");
      emitProgress({ processed: 0, total: 0, phase: "done" });
      return;
    }

    const startedAt = Date.now();
    let processed = 0;
    let warmed = 0;
    let skippedAlreadyHot = 0;
    let errored = 0;

    try {
      for (const docId of docIds) {
        if (signal.aborted) {
          this.logger.info(
            `Warmer: aborted after ${processed}/${total} docs (warmed=${warmed}, skipped=${skippedAlreadyHot})`
          );
          emitProgress({ processed, total, phase: "cancelled" });
          return;
        }

        processed++;

        if (this.docCache.has(docId)) {
          skippedAlreadyHot++;
        } else {
          try {
            const fromL2 = await this.tryLoadFromL2(docId);
            if (fromL2 === null) {
              // L2 miss -> full materialization. flush-before-evict on
              // the next L1 churn will turn this into an L2 record so
              // future reads are fast.
              await this.loadDocumentInternal(docId);
            }
            warmed++;
          } catch (e) {
            errored++;
            this.logger.warn(`Warmer: failed to warm doc ${docId}: ${e}`);
          }
        }

        if (processed % this.warmerBatchSize === 0) {
          // Emit progress BEFORE yielding so the UI updates while we
          // are off the critical path. Use the still-warming phase
          // since the loop may still have docs left.
          emitProgress({ processed, total, phase: "warming" });
          await this.warmerScheduler.yield();
        }
      }

      this.logger.info(
        `Warmer finished in ${Date.now() - startedAt}ms: processed=${processed}, ` +
          `warmed=${warmed}, alreadyHot=${skippedAlreadyHot}, errored=${errored}`
      );
      emitProgress({ processed, total, phase: "done" });
    } catch (e) {
      // Defensive: any unexpected error is logged and swallowed - the
      // warmer is purely an optimization. Surface the partial progress
      // as `cancelled` since the pass did not complete normally.
      this.logger.warn(`Warmer crashed: ${e}`);
      emitProgress({ processed, total, phase: "cancelled" });
    }
  }

  /**
   * Internal method to load a document from the content-addressed store
   */
  private async loadDocumentInternal(docId: string): Promise<InternalDoc | null> {
    const startedAt = Date.now();
    const cacheCheckStartedAt = Date.now();
    // Short-circuit on the visibility layer: a doc marked
    // `"inaccessible"` is logically absent for this database, regardless
    // of whether L1/L2 still hold a cached copy. This keeps the public
    // contract of `loadDocumentInternal` aligned with `getDocument` /
    // `getAllDocumentIds`.
    const indexEntryIdx = this.indexLookup.get(docId);
    if (indexEntryIdx !== undefined && this.index[indexEntryIdx].accessState === "inaccessible") {
      return null;
    }
    if (this.docCache.has(docId)) {
      this.logger.debug(`Document ${docId} found in cache, returning cached version`);
      const cached = this.getCachedDocument(docId)!;
      // Belt-and-braces: even if the index says visible, recheck the
      // KeyBag before returning plaintext. Catches races where a key
      // was just removed but the index has not been reconciled yet.
      if (!(await this.tenant.hasDecryptionKey(cached.decryptionKeyId))) {
        await this.purgeMaterializedDocument(docId);
        return null;
      }
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

    // L1 missed. Try the persistent L2 cache before falling through to
    // the full signature-verify + decrypt + Automerge-replay pipeline.
    // The L2 path either returns a ready-to-use InternalDoc (already
    // promoted into L1) or null - in which case we proceed below.
    const l2Doc = await this.tryLoadFromL2(docId);
    if (l2Doc !== null) {
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
      return l2Doc;
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
    
    const isDeleted = this.computeIsDeletedFromMetadata(allEntryMetadata);
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
    await this.storeCachedDocument(internalDoc);
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
      getHeads: () => Automerge.getHeads(internalDoc.doc),
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
        return db.getAttachmentForRefInternal(
          db.getAttachmentRefFromDoc(internalDoc, attachmentId),
        );
      },
      
      getAttachmentRange: async (
        attachmentId: string,
        startByte: number,
        endByte: number
      ): Promise<Uint8Array> => {
        return db.getAttachmentRangeForRefInternal(
          db.getAttachmentRefFromDoc(internalDoc, attachmentId),
          startByte,
          endByte,
        );
      },
      
      streamAttachment: (
        attachmentId: string,
        startOffset: number = 0
      ): AsyncGenerator<Uint8Array, void, unknown> => {
        return db.streamAttachmentForRefInternal(
          db.getAttachmentRefFromDoc(internalDoc, attachmentId),
          startOffset,
        );
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
    return this.getAttachmentRefFromDoc(internalDoc, attachmentId);
  }

  private getAttachmentRefFromDoc(internalDoc: InternalDoc, attachmentId: string): AttachmentReference {
    const payload = internalDoc.doc as unknown as MindooDocPayload;
    const attachments = (payload._attachments as AttachmentReference[]) || [];
    const ref = attachments.find(a => a.attachmentId === attachmentId);
    if (!ref) {
      throw new Error(`Attachment ${attachmentId} not found in document ${internalDoc.id}`);
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
    return await this.getAttachmentForRefInternal(ref);
  }

  private async getAttachmentForRefInternal(ref: AttachmentReference): Promise<Uint8Array> {
    const store = this.getEffectiveAttachmentStore();
    
    // Resolve dependency chain to get all chunk IDs in order (oldest first)
    const chunkIds = await store.resolveDependencies(ref.lastChunkId, { includeStart: true });
    this.logger.debug(`Resolved ${chunkIds.length} chunks for attachment ${ref.attachmentId}`);
    
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
    
    this.logger.debug(`Retrieved attachment ${ref.attachmentId}: ${result.length} bytes`);
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
    return await this.getAttachmentRangeForRefInternal(ref, startByte, endByte);
  }

  private async getAttachmentRangeForRefInternal(
    ref: AttachmentReference,
    startByte: number,
    endByte: number
  ): Promise<Uint8Array> {
    if (startByte < 0 || endByte <= startByte) {
      throw new Error(`Invalid byte range: [${startByte}, ${endByte})`);
    }

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
    
    this.logger.debug(`Retrieved attachment ${ref.attachmentId} range: ${result.length} bytes`);
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
    yield* this.streamAttachmentForRefInternal(ref, startOffset);
  }

  private async *streamAttachmentForRefInternal(
    ref: AttachmentReference,
    startOffset: number
  ): AsyncGenerator<Uint8Array, void, unknown> {
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
    
    this.logger.debug(`Finished streaming attachment ${ref.attachmentId}`);
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
        attachmentId,
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

  private pendingAttachmentUploadLedgerId(attachmentId: string): string {
    return `pending_upload_${attachmentId}`;
  }

  private async putEntriesWithRetry(
    store: ContentAddressedStore,
    entries: StoreEntry[],
    description: string
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= ATTACHMENT_WRITE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await store.putEntries(entries);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= ATTACHMENT_WRITE_RETRY_DELAYS_MS.length) {
          break;
        }
        this.logger.warn(
          `Attachment write ${description} failed; retrying batch (attempt ${attempt + 1})`,
          error
        );
        await new Promise((resolve) => setTimeout(resolve, ATTACHMENT_WRITE_RETRY_DELAYS_MS[attempt]));
      }
    }
    throw lastError;
  }

  private async createPendingAttachmentUploadLedger(
    docId: string,
    attachmentId: string,
    decryptionKeyId: string,
    createdAt: number,
    createdByPublicKey: string
  ): Promise<void> {
    const encryptedData = new Uint8Array(0);
    const contentHash = await computeContentHash(encryptedData, this.getSubtle());
    const signature = await this.tenant.signPayload(encryptedData);
    await this.putEntriesWithRetry(
      this.store,
      [{
        entryType: "pending_attachment_upload",
        id: this.pendingAttachmentUploadLedgerId(attachmentId),
        contentHash,
        docId,
        dependencyIds: [],
        createdAt,
        attachmentId,
        uploadStartedAt: Date.now(),
        createdByPublicKey,
        decryptionKeyId,
        signature,
        originalSize: 0,
        encryptedSize: 0,
        encryptedData,
      }],
      `pending ledger ${attachmentId}`
    );
  }

  private async clearPendingAttachmentUploadLedger(attachmentId: string): Promise<void> {
    const deleteEntriesById = this.store.deleteEntriesById;
    if (!deleteEntriesById) {
      return;
    }
    await deleteEntriesById.call(this.store, [this.pendingAttachmentUploadLedgerId(attachmentId)]);
  }

  private async cleanupIncompleteAttachmentUpload(docId: string, attachmentId: string): Promise<void> {
    const store = this.getEffectiveAttachmentStore();
    try {
      await store.deleteEntriesForAttachment?.(docId, attachmentId);
      await this.clearPendingAttachmentUploadLedger(attachmentId);
      this.logger.info(`Cleaned up incomplete attachment upload ${attachmentId}`);
    } catch (cleanupError) {
      this.logger.warn(
        `Failed to clean up incomplete attachment upload ${attachmentId}; boot recovery can retry`,
        cleanupError
      );
    }
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
    let totalSize = 0;
    let prevChunkId: string | null = null;
    let lastChunkId: string = "";
    let chunkCount = 0;
    const pendingEntries: StoreEntry[] = [];
    let pendingEncryptedBytes = 0;
    let ledgerCreated = false;

    const flushPendingEntries = async (force = false): Promise<void> => {
      if (pendingEntries.length === 0) {
        return;
      }
      if (!force && pendingEncryptedBytes < ATTACHMENT_WRITE_BATCH_BYTES) {
        return;
      }
      const batch = pendingEntries.splice(0, pendingEntries.length);
      pendingEncryptedBytes = 0;
      await this.putEntriesWithRetry(
        store,
        batch,
        `attachment ${attachmentId} (${batch.length} chunks)`
      );
    };

    // Helper to store a chunk
    const queueChunk = async (chunkData: Uint8Array): Promise<string> => {
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
        attachmentId,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };

      pendingEntries.push(chunkEntry);
      pendingEncryptedBytes += encryptedData.length;
      chunkCount++;
      await flushPendingEntries();
      
      return chunkId;
    };

    try {
      await this.createPendingAttachmentUploadLedger(
        docId,
        attachmentId,
        decryptionKeyId,
        createdAt,
        currentUser.userSigningPublicKey
      );
      ledgerCreated = true;

      const accumulator = new Uint8Array(this.chunkSizeBytes);
      let cursor = 0;
      const writeFilledChunk = async (chunkData: Uint8Array): Promise<void> => {
        lastChunkId = await queueChunk(chunkData);
        prevChunkId = lastChunkId;
        totalSize += chunkData.length;
      };

      // Process incoming data stream without reallocating the pending buffer.
      for await (const chunk of dataStream) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const writableBytes = Math.min(this.chunkSizeBytes - cursor, chunk.byteLength - offset);
          accumulator.set(chunk.subarray(offset, offset + writableBytes), cursor);
          cursor += writableBytes;
          offset += writableBytes;
          if (cursor === this.chunkSizeBytes) {
            await writeFilledChunk(accumulator.slice());
            cursor = 0;
          }
        }
      }

      // Store remaining data as final chunk (if any)
      if (cursor > 0) {
        await writeFilledChunk(accumulator.slice(0, cursor));
      }
      await flushPendingEntries(true);

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
    } catch (error) {
      if (ledgerCreated || chunkCount > 0) {
        await this.cleanupIncompleteAttachmentUpload(docId, attachmentId);
      }
      throw error;
    }
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
        attachmentId,
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
    this.assertWritable("pullChangesFrom");
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
    this.assertWritable("pushChangesTo");
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

