import type { MindooDB, ProcessChangesCursor } from "../../types";
import type { LocalCacheStore } from "../../cache/LocalCacheStore";
import type { CacheManager, ICacheable } from "../../cache/CacheManager";
import type { VirtualViewUpdateOptions } from "../virtualviews/IVirtualViewDataProvider";
import type {
  DocumentSummaryEntry,
  ResolvedSummaryConfig,
  SummaryBucketPayload,
  SummaryConfig,
  SummaryCoverage,
  SummaryMetaPayload,
} from "./types";
import {
  computeSummaryConfigFingerprint,
  resolveSummaryConfig,
  sanitizeSummaryConfig,
  DB_SETUP_DOC_ID,
  SUMMARY_SETUP_FIELD,
} from "./types";
import { extractSummaryFields, isFieldPathCovered } from "./extractSummaryFields";

const DEFAULT_BUCKET_COUNT = 64;

/** Simple deterministic string hash (djb2) used for bucket assignment. */
function hashDocId(docId: string): number {
  let hash = 5381;
  for (let i = 0; i < docId.length; i++) {
    hash = ((hash << 5) + hash + docId.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * The document summary buffer: a changefeed-maintained, per-document map of
 * queryable field values (see docs/adhoc-queries.md).
 *
 * Ad-hoc queries and summary-backed views evaluate exclusively against this
 * store, so they never pay document materialization. The store is kept
 * up to date incrementally via `iterateChangesSince` (deleted/inaccessible
 * documents arrive as lightweight tombstones and are removed), persists in
 * encrypted buckets through the tenant's {@link LocalCacheStore}, and
 * survives configuration changes with a resumable backfill instead of any
 * document rewrite.
 */
export class DocumentSummaryStore implements ICacheable {
  private readonly db: MindooDB;
  private config: ResolvedSummaryConfig;
  private configFingerprint: string;
  /**
   * `true` when the configuration came from code (constructor arg or
   * `setConfig`). Without an explicit configuration the store follows the
   * `summarySetup` field of the synced {@link DB_SETUP_DOC_ID} document.
   */
  private hasExplicitConfig: boolean;
  /** Whether the setup document was already consulted (once per instance). */
  private setupDocSeeded: boolean = false;

  private entries: Map<string, DocumentSummaryEntry> = new Map();
  private cursor: ProcessChangesCursor | null = null;

  // --- persistence state ---
  private cacheManager: CacheManager | null = null;
  private cachePrefix: string | null = null;
  private readonly bucketCount: number = DEFAULT_BUCKET_COUNT;
  private dirtyBuckets: Set<number> = new Set();
  private metaDirty: boolean = false;
  private restorePromise: Promise<void> | null = null;
  private restored: boolean = false;

  // --- backfill state (config changed while entries already exist) ---
  private needsBackfill: boolean = false;
  private backfillCursor: ProcessChangesCursor | null = null;

  // --- single-flight update ---
  private updatePromise: Promise<void> | null = null;

  constructor(db: MindooDB, config?: SummaryConfig) {
    this.db = db;
    this.hasExplicitConfig = config !== undefined;
    this.config = resolveSummaryConfig(config);
    this.configFingerprint = computeSummaryConfigFingerprint(this.config);
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  getConfig(): ResolvedSummaryConfig {
    return this.config;
  }

  getConfigFingerprint(): string {
    return this.configFingerprint;
  }

  /**
   * Replace the summary configuration. When the fingerprint changes and
   * entries already exist, the store keeps serving the previous state and
   * schedules a resumable backfill that re-extracts all documents with the
   * new configuration on the next `update()` run.
   *
   * Calling this marks the configuration as explicit: the store stops
   * following the {@link DB_SETUP_DOC_ID} document.
   */
  setConfig(config?: SummaryConfig): void {
    this.hasExplicitConfig = true;
    this.applyConfig(config);
  }

  /** Shared config-swap logic for explicit and setup-document paths. */
  private applyConfig(config?: SummaryConfig): void {
    const resolved = resolveSummaryConfig(config);
    const fingerprint = computeSummaryConfigFingerprint(resolved);
    if (fingerprint === this.configFingerprint) {
      return;
    }
    this.config = resolved;
    this.configFingerprint = fingerprint;
    if (this.entries.size > 0 || this.cursor !== null) {
      this.scheduleBackfill();
    }
    this.metaDirty = true;
    this.cacheManager?.markDirty();
  }

  private scheduleBackfill(): void {
    this.needsBackfill = true;
    this.backfillCursor = null;
  }

  /**
   * Adopt the configuration from the synced {@link DB_SETUP_DOC_ID}
   * document (its `summarySetup` field) unless an explicit configuration
   * was provided in code. Runs once per instance, BEFORE the persisted
   * state is restored, so the fingerprint comparison on restore already
   * sees the setup-document configuration (a stale persisted fingerprint
   * then schedules the backfill exactly once).
   *
   * Later changes to the setup document — local edits or sync ingest —
   * arrive through the changefeed and are applied in `applyDocument`.
   */
  private async seedConfigFromSetupDoc(): Promise<void> {
    if (this.setupDocSeeded || this.hasExplicitConfig) {
      this.setupDocSeeded = true;
      return;
    }
    this.setupDocSeeded = true;
    try {
      const doc = await this.db.getDocument(DB_SETUP_DOC_ID);
      const config = sanitizeSummaryConfig(doc.getData()[SUMMARY_SETUP_FIELD]);
      if (config !== undefined) {
        this.applyConfig(config);
      }
    } catch {
      // No setup document (or not readable) → keep the default config.
    }
  }

  /**
   * Make sure the effective configuration is settled: consults the
   * {@link DB_SETUP_DOC_ID} document once (unless the config was provided
   * in code) and returns the resolved configuration. Callers that make
   * decisions based on coverage (e.g. the view data-provider factory)
   * should await this before calling {@link isFieldCovered}.
   */
  async ensureConfigLoaded(): Promise<ResolvedSummaryConfig> {
    await this.seedConfigFromSetupDoc();
    return this.config;
  }

  /**
   * Whether a field path can be answered from this summary (see
   * {@link isFieldPathCovered}). Coverage is configuration-level; individual
   * documents may still lack a value.
   */
  isFieldCovered(path: string): boolean {
    return isFieldPathCovered(path, this.config);
  }

  /**
   * `"full"` when all entries reflect the current configuration,
   * `"rebuilding"` while a configuration-change backfill is in progress.
   */
  getCoverage(): SummaryCoverage {
    return this.needsBackfill ? "rebuilding" : "full";
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  getEntry(docId: string): DocumentSummaryEntry | undefined {
    return this.entries.get(docId);
  }

  getAllEntries(): IterableIterator<DocumentSummaryEntry> {
    return this.entries.values();
  }

  getSize(): number {
    return this.entries.size;
  }

  getCursor(): ProcessChangesCursor | null {
    return this.cursor;
  }

  // ---------------------------------------------------------------------------
  // Incremental update
  // ---------------------------------------------------------------------------

  /**
   * Bring the summary up to date with the changefeed. Restores persisted
   * state on first use, then consumes `iterateChangesSince` from the saved
   * cursor and finally works down a pending configuration backfill.
   *
   * Accepts the same batching/progress/cancellation options as VirtualView
   * updates; an interrupted run resumes from the saved cursors.
   * Calls are single-flight: concurrent callers share one run.
   */
  async update(options?: VirtualViewUpdateOptions): Promise<void> {
    if (this.updatePromise) {
      return this.updatePromise;
    }
    this.updatePromise = this.runUpdate(options).finally(() => {
      this.updatePromise = null;
    });
    return this.updatePromise;
  }

  private async runUpdate(options?: VirtualViewUpdateOptions): Promise<void> {
    await this.seedConfigFromSetupDoc();
    await this.ensureRestored();

    const applyBatchSize = options?.applyBatchSize ?? 100;
    const onProgress = options?.onProgress;
    const signal = options?.signal;

    const countAfter = (cursor: ProcessChangesCursor | null): number =>
      this.db.countChangesSince?.(cursor) ?? 0;

    const total = onProgress
      ? countAfter(this.cursor) + (this.needsBackfill ? countAfter(this.backfillCursor) : 0)
      : 0;

    let processed = 0;
    let processedInBatch = 0;

    // Returns true when the run should stop after the current batch.
    const stopRequested = (): boolean => {
      const callbackStop =
        onProgress?.({ processed, total, origin: "summary" }) === false;
      return callbackStop || signal?.aborted === true;
    };

    if (signal?.aborted) {
      return;
    }

    // Pass 1: incremental changefeed consumption from the main cursor.
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor)) {
      this.applyDocument(doc.getId(), doc, cursor);
      this.cursor = cursor;
      processed++;
      processedInBatch++;

      if (processedInBatch >= applyBatchSize) {
        processedInBatch = 0;
        this.cacheManager?.markDirty();
        if (stopRequested()) {
          return;
        }
      }
    }

    // Pass 2: configuration backfill (re-extract everything with the new
    // config). The feed yields each document's latest state once, so plain
    // overwrites converge; docs changing mid-backfill are re-processed by
    // the next pass 1 anyway.
    if (this.needsBackfill) {
      for await (const { doc, cursor } of this.db.iterateChangesSince(this.backfillCursor)) {
        this.applyDocument(doc.getId(), doc, cursor);
        this.backfillCursor = cursor;
        processed++;
        processedInBatch++;

        if (processedInBatch >= applyBatchSize) {
          processedInBatch = 0;
          this.cacheManager?.markDirty();
          if (stopRequested()) {
            return;
          }
        }
      }
      this.needsBackfill = false;
      this.backfillCursor = null;
      this.metaDirty = true;
    }

    this.cacheManager?.markDirty();
    if (onProgress) {
      onProgress({ processed, total, origin: "summary" });
    }
  }

  private applyDocument(
    docId: string,
    doc: { isDeleted(): boolean; getData(): Record<string, unknown>; getLastModified(): number; getDecryptionKeyId(): string | null },
    cursor: ProcessChangesCursor
  ): void {
    if (docId === DB_SETUP_DOC_ID) {
      // The setup document configures the summary instead of appearing in
      // it. Config changes (also arriving via sync) schedule a backfill;
      // a deleted setup document falls back to the default config.
      if (!this.hasExplicitConfig) {
        const config = doc.isDeleted()
          ? undefined
          : sanitizeSummaryConfig(doc.getData()[SUMMARY_SETUP_FIELD]);
        this.applyConfig(config);
      }
      // Drop a stale entry left over from before the setup doc was skipped.
      if (this.entries.delete(docId)) {
        this.markBucketDirty(docId);
      }
      return;
    }

    if (doc.isDeleted()) {
      if (this.entries.delete(docId)) {
        this.markBucketDirty(docId);
      }
      return;
    }

    this.entries.set(docId, {
      docId,
      fields: extractSummaryFields(doc.getData(), this.config),
      lastModified: doc.getLastModified(),
      changeSeq: cursor.changeSeq ?? 0,
      decryptionKeyId: doc.getDecryptionKeyId(),
    });
    this.markBucketDirty(docId);
  }

  /**
   * Drop a document's summary entry immediately (called from the DB's purge
   * paths so plaintext field values never outlive key revocation/purges;
   * the changefeed tombstone would remove it anyway, but only on the next
   * update run).
   */
  removeDocument(docId: string): void {
    if (this.entries.delete(docId)) {
      this.markBucketDirty(docId);
      this.cacheManager?.markDirty();
    }
  }

  /** Drop all entries and cursors (e.g. after the underlying store was cleared). */
  reset(): void {
    this.entries.clear();
    this.cursor = null;
    this.needsBackfill = false;
    this.backfillCursor = null;
    for (let i = 0; i < this.bucketCount; i++) {
      this.dirtyBuckets.add(i);
    }
    this.metaDirty = true;
    this.cacheManager?.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Persistence (ICacheable)
  // ---------------------------------------------------------------------------

  /**
   * Attach cache persistence. `cachePrefix` scopes all records of this
   * summary (recommended: `<dbCachePrefix>/summary`). Registers with the
   * CacheManager for periodic flushing; the persisted state is restored
   * lazily on the first `update()` call.
   */
  attachCache(cacheManager: CacheManager, cachePrefix: string): void {
    this.cacheManager = cacheManager;
    this.cachePrefix = cachePrefix;
    cacheManager.register(this);
  }

  getCachePrefix(): string {
    return this.cachePrefix ?? "summary";
  }

  hasDirtyState(): boolean {
    return this.dirtyBuckets.size > 0 || this.metaDirty;
  }

  clearDirty(): void {
    this.dirtyBuckets.clear();
    this.metaDirty = false;
  }

  private bucketIndexFor(docId: string): number {
    return hashDocId(docId) % this.bucketCount;
  }

  private markBucketDirty(docId: string): void {
    this.dirtyBuckets.add(this.bucketIndexFor(docId));
    this.metaDirty = true;
  }

  async flushToCache(store: LocalCacheStore, _options?: { force?: boolean }): Promise<number> {
    const prefix = this.getCachePrefix();
    let written = 0;

    if (this.dirtyBuckets.size > 0) {
      // Group entries by bucket once, then rewrite only dirty buckets.
      const byBucket = new Map<number, DocumentSummaryEntry[]>();
      for (const entry of this.entries.values()) {
        const bucket = this.bucketIndexFor(entry.docId);
        if (!this.dirtyBuckets.has(bucket)) {
          continue;
        }
        let list = byBucket.get(bucket);
        if (!list) {
          list = [];
          byBucket.set(bucket, list);
        }
        list.push(entry);
      }

      for (const bucket of this.dirtyBuckets) {
        const payload: SummaryBucketPayload = { entries: byBucket.get(bucket) ?? [] };
        await store.put(
          "summary",
          `${prefix}/bucket/${bucket}`,
          new TextEncoder().encode(JSON.stringify(payload))
        );
        written++;
      }
    }

    const meta: SummaryMetaPayload = {
      cursor: this.cursor,
      configFingerprint: this.configFingerprint,
      bucketCount: this.bucketCount,
      needsBackfill: this.needsBackfill,
      backfillCursor: this.backfillCursor,
    };
    await store.put("summary", `${prefix}/meta`, new TextEncoder().encode(JSON.stringify(meta)));
    written++;

    return written;
  }

  private async ensureRestored(): Promise<void> {
    if (this.restored || !this.cacheManager) {
      this.restored = true;
      return;
    }
    if (!this.restorePromise) {
      this.restorePromise = this.restoreFromCache().finally(() => {
        this.restored = true;
      });
    }
    return this.restorePromise;
  }

  /**
   * Restore persisted state. A config-fingerprint mismatch keeps the
   * restored entries usable (extracted with the previous configuration)
   * and schedules a backfill instead of discarding them.
   */
  private async restoreFromCache(): Promise<void> {
    const store = this.cacheManager?.getStore();
    if (!store) {
      return;
    }
    const prefix = this.getCachePrefix();

    let meta: SummaryMetaPayload;
    try {
      const metaBytes = await store.get("summary", `${prefix}/meta`);
      if (!metaBytes) {
        return;
      }
      meta = JSON.parse(new TextDecoder().decode(metaBytes)) as SummaryMetaPayload;
    } catch {
      return;
    }

    const bucketCount = meta.bucketCount ?? DEFAULT_BUCKET_COUNT;
    const bucketIds: string[] = [];
    for (let i = 0; i < bucketCount; i++) {
      bucketIds.push(`${prefix}/bucket/${i}`);
    }

    try {
      const buckets = await store.getMany("summary", bucketIds);
      for (const bytes of buckets) {
        if (!bytes) {
          continue;
        }
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as SummaryBucketPayload;
        for (const entry of payload.entries ?? []) {
          this.entries.set(entry.docId, entry);
        }
      }
    } catch {
      // A corrupt bucket only loses cached summaries; the changefeed
      // rebuild below restores correctness.
      this.entries.clear();
      this.cursor = null;
      return;
    }

    this.cursor = meta.cursor ?? null;

    if (meta.configFingerprint !== this.configFingerprint) {
      // Entries were extracted with a different configuration: keep them
      // usable, re-extract everything in the background.
      this.scheduleBackfill();
      this.metaDirty = true;
    } else if (meta.needsBackfill) {
      // Resume an interrupted backfill where it left off.
      this.needsBackfill = true;
      this.backfillCursor = meta.backfillCursor ?? null;
    }
  }
}
