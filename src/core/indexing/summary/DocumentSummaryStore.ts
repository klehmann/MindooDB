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
  SummaryJournalSegment,
  SummaryStoreChanges,
  SummaryStorePosition,
} from "./types";
import { generateRandomUuid } from "../../utils/idGeneration";
import {
  computeSummaryConfigFingerprint,
  resolveSummaryConfig,
  sanitizeSummaryConfig,
  DB_SETUP_DOC_ID,
  SUMMARY_SETUP_FIELD,
} from "./types";
import { extractSummaryFields, isFieldPathCovered } from "./extractSummaryFields";

/**
 * Index builds read every document once: keep what they materialize out of
 * the persistent document cache (see IterateChangesOptions.persistLoadedDocuments).
 */
const SCAN = { persistLoadedDocuments: false } as const;

const DEFAULT_BUCKET_COUNT = 64;
/** Keep at most this many removals for delta readers (older readers rescan). */
const MAX_TOMBSTONES = 5000;
/** Sequence jump on restore (see lostSeqRanges). */
const LOST_SEQ_JUMP = 2 ** 30;
/**
 * Minimum time between periodic flushes while an update run is in progress.
 * A catch-up (initial replication, chunked sync ingest) dirties nearly every
 * bucket in every batch, so each flush would re-serialize the whole buffer;
 * the default CacheManager interval (5 s) would make that quadratic over a
 * long catch-up. Idle flushes and forced (shutdown) flushes are not deferred.
 */
const DEFAULT_MIN_FLUSH_INTERVAL_DURING_UPDATE_MS = 30000;

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

  // --- modification sequence (delta reads, see getChangesSince) ---
  private generation: string = generateRandomUuid();
  private updateSeq: number = 0;
  /** [updateSeq, docId] in write order; may hold stale pairs (compacted lazily). */
  private seqLog: Array<[number, string]> = [];
  private tombstones: Array<[number, string]> = [];
  /** Readers older than this seq cannot get all removals: they rescan. */
  private tombstoneHorizon: number = 0;
  /**
   * Sequence ranges a previous process may have handed out without
   * persisting them (it crashed after a reader saw them). On restore the
   * sequence jumps past such a range; readers positioned inside it rescan.
   */
  private lostSeqRanges: Array<[number, number]> = [];

  // --- persistence state ---
  private cacheManager: CacheManager | null = null;
  private cachePrefix: string | null = null;
  private readonly bucketCount: number = DEFAULT_BUCKET_COUNT;
  /** Buckets changed since the last snapshot (rewritten by the next snapshot). */
  private dirtyBuckets: Set<number> = new Set();
  // Journal (see flushToCache): entries changed since the last flush.
  private journalPending: Map<string, DocumentSummaryEntry | null> = new Map();
  private pendingTombstones: Array<[number, string]> = [];
  /** Whether this instance wrote the current snapshot (else the next flush writes one). */
  private ownSnapshot: boolean = false;
  private journalEntriesSinceSnapshot: number = 0;
  private nextJournalSegment: number = 0;
  private readonly journalWriterId: string = generateRandomUuid().replace(/-/g, "").slice(0, 12);
  private metaDirty: boolean = false;
  /** Timestamp of the last completed (non-deferred) flush. */
  private lastFlushAt: number = 0;
  /**
   * Set by `flushToCache` once it has taken over the dirty state (or
   * deliberately deferred it), so the CacheManager's follow-up `clearDirty`
   * does not wipe state that became dirty while the flush was awaiting I/O.
   */
  private flushHandledDirty: boolean = false;
  private readonly minFlushIntervalDuringUpdateMs: number;
  private restorePromise: Promise<void> | null = null;
  private restored: boolean = false;

  // --- backfill state (config changed while entries already exist) ---
  private needsBackfill: boolean = false;
  private backfillCursor: ProcessChangesCursor | null = null;
  /** Bumped by every scheduleBackfill, so a running backfill sees it was restarted. */
  private backfillGeneration: number = 0;

  // --- single-flight update ---
  private updatePromise: Promise<void> | null = null;

  constructor(
    db: MindooDB,
    config?: SummaryConfig,
    options?: { minFlushIntervalDuringUpdateMs?: number },
  ) {
    this.db = db;
    this.minFlushIntervalDuringUpdateMs = Math.max(
      0,
      options?.minFlushIntervalDuringUpdateMs ?? DEFAULT_MIN_FLUSH_INTERVAL_DURING_UPDATE_MS,
    );
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
    this.backfillGeneration++;
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
   * Calls are single-flight: concurrent callers share one run. A caller that
   * finds a run in flight waits for it and then starts a follow-up run when
   * the changefeed moved on meanwhile (the in-flight run iterates a snapshot
   * taken when it started, e.g. before the latest sync page was ingested), so
   * the promise never resolves on a state older than the call.
   */
  async update(options?: VirtualViewUpdateOptions): Promise<void> {
    if (this.updatePromise) {
      while (this.updatePromise) {
        try {
          await this.updatePromise;
        } catch {
          // The follow-up run below reports its own errors.
        }
      }
      if (this.isCaughtUp()) {
        return;
      }
    }
    this.updatePromise = this.runUpdate(options).finally(() => {
      this.updatePromise = null;
    });
    return this.updatePromise;
  }

  /** Whether the last run consumed the whole changefeed and no backfill is pending. */
  private isCaughtUp(): boolean {
    if (!this.restored || this.needsBackfill) {
      return false;
    }
    const remaining = this.db.countChangesSince?.(this.cursor);
    return remaining !== undefined && remaining === 0;
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
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor, SCAN)) {
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
    // the next pass 1 anyway. A config change during the backfill
    // (setConfig, or the setup doc in the feed) schedules a new one from the
    // start; the loop then restarts instead of finishing the old one and
    // clearing needsBackfill with the earlier docs not re-extracted.
    while (this.needsBackfill) {
      const generation = this.backfillGeneration;
      let restarted = false;
      for await (const { doc, cursor } of this.db.iterateChangesSince(this.backfillCursor, SCAN)) {
        this.applyDocument(doc.getId(), doc, cursor);
        if (generation !== this.backfillGeneration) {
          restarted = true;
          break;
        }
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
      if (!restarted) {
        this.needsBackfill = false;
        this.backfillCursor = null;
        this.metaDirty = true;
      }
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
        this.recordRemoval(docId);
        this.markBucketDirty(docId);
      }
      return;
    }

    if (doc.isDeleted()) {
      if (this.entries.delete(docId)) {
        this.recordRemoval(docId);
        this.markBucketDirty(docId);
      }
      return;
    }

    const updateSeq = ++this.updateSeq;
    this.entries.set(docId, {
      docId,
      fields: extractSummaryFields(doc.getData(), this.config),
      lastModified: doc.getLastModified(),
      changeSeq: cursor.changeSeq ?? 0,
      decryptionKeyId: doc.getDecryptionKeyId(),
      updateSeq,
    });
    this.seqLog.push([updateSeq, docId]);
    this.markBucketDirty(docId);
  }

  private recordRemoval(docId: string): void {
    const seq = ++this.updateSeq;
    this.tombstones.push([seq, docId]);
    this.pendingTombstones.push([seq, docId]);
    if (this.tombstones.length > MAX_TOMBSTONES) {
      const dropped = this.tombstones.splice(0, this.tombstones.length - MAX_TOMBSTONES);
      this.tombstoneHorizon = dropped[dropped.length - 1][0];
    }
    this.metaDirty = true;
  }

  /** Current position of the modification sequence. */
  getPosition(): SummaryStorePosition {
    return { generation: this.generation, seq: this.updateSeq };
  }

  /**
   * Entries written and documents removed after `position` — what an
   * incremental reader (a summary-backed view) has to process instead of
   * scanning every entry. Returns `null` when no delta is possible (no or
   * foreign position, or removals already dropped from the bounded
   * tombstone list): the reader then rescans everything once.
   *
   * O(changes) after the first call (a lazily compacted write log).
   */
  getChangesSince(position: SummaryStorePosition | null): SummaryStoreChanges | null {
    if (
      !position ||
      position.generation !== this.generation ||
      position.seq < this.tombstoneHorizon ||
      position.seq > this.updateSeq ||
      this.lostSeqRanges.some(([start, end]) => position.seq > start && position.seq <= end)
    ) {
      return null;
    }
    const current = this.getPosition();
    if (position.seq >= this.updateSeq) {
      return { ...current, entries: [], removedDocIds: [] };
    }
    this.compactSeqLog();
    // First log index with seq > position.seq (log is ordered by seq).
    let lo = 0;
    let hi = this.seqLog.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.seqLog[mid][0] > position.seq) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    const entries: DocumentSummaryEntry[] = [];
    for (let i = lo; i < this.seqLog.length; i++) {
      const [seq, docId] = this.seqLog[i];
      const entry = this.entries.get(docId);
      // Only the latest write of a document counts (older pairs are stale).
      if (entry && entry.updateSeq === seq) {
        entries.push(entry);
      }
    }
    const removedDocIds: string[] = [];
    for (let i = this.tombstones.length - 1; i >= 0 && this.tombstones[i][0] > position.seq; i--) {
      const docId = this.tombstones[i][1];
      if (!this.entries.has(docId)) {
        removedDocIds.push(docId);
      }
    }
    return { ...current, entries, removedDocIds };
  }

  /** Drop stale log pairs once they make up more than half of the log. */
  private compactSeqLog(): void {
    if (this.seqLog.length <= 1024 || this.seqLog.length < this.entries.size * 2) {
      return;
    }
    this.seqLog = this.seqLog.filter(([seq, docId]) => this.entries.get(docId)?.updateSeq === seq);
  }

  /** Rebuild the write log from the entries (after restoring from the cache). */
  private rebuildSeqLog(): void {
    const log: Array<[number, string]> = [];
    for (const entry of this.entries.values()) {
      if (typeof entry.updateSeq === "number") {
        log.push([entry.updateSeq, entry.docId]);
      }
    }
    log.sort((a, b) => a[0] - b[0]);
    this.seqLog = log;
  }

  /**
   * Drop a document's summary entry immediately (called from the DB's purge
   * paths so plaintext field values never outlive key revocation/purges;
   * the changefeed tombstone would remove it anyway, but only on the next
   * update run).
   */
  removeDocument(docId: string): void {
    if (this.entries.delete(docId)) {
      this.recordRemoval(docId);
      this.markBucketDirty(docId);
      this.cacheManager?.markDirty();
    }
  }

  /** Drop all entries and cursors (e.g. after the underlying store was cleared). */
  reset(): void {
    this.entries.clear();
    this.cursor = null;
    // Delta readers must rescan: start a new modification generation.
    this.generation = generateRandomUuid();
    this.updateSeq = 0;
    this.seqLog = [];
    this.tombstones = [];
    this.tombstoneHorizon = 0;
    this.lostSeqRanges = [];
    this.needsBackfill = false;
    this.backfillCursor = null;
    for (let i = 0; i < this.bucketCount; i++) {
      this.dirtyBuckets.add(i);
    }
    // Everything changed: the next flush writes a full snapshot.
    this.ownSnapshot = false;
    this.journalPending.clear();
    this.pendingTombstones = [];
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
    return this.journalPending.size > 0 || this.metaDirty || (!this.ownSnapshot && this.dirtyBuckets.size > 0);
  }

  clearDirty(): void {
    if (this.flushHandledDirty) {
      // Follow-up of a flush that already took (or deferred) its snapshot:
      // anything dirty now changed during the flush and must stay dirty.
      this.flushHandledDirty = false;
      return;
    }
    this.discardDirtyState();
  }

  /**
   * Unconditionally drop all dirty markers (unlike {@link clearDirty}, which
   * after a flush only acknowledges that flush). Used when the persisted
   * records are about to be deleted and must not be rewritten.
   */
  discardDirtyState(): void {
    this.dirtyBuckets.clear();
    this.journalPending.clear();
    this.pendingTombstones = [];
    this.metaDirty = false;
    this.flushHandledDirty = false;
  }

  private bucketIndexFor(docId: string): number {
    return hashDocId(docId) % this.bucketCount;
  }

  private markBucketDirty(docId: string): void {
    this.dirtyBuckets.add(this.bucketIndexFor(docId));
    this.journalPending.set(docId, this.entries.get(docId) ?? null);
    this.metaDirty = true;
  }

  async flushToCache(store: LocalCacheStore, options?: { force?: boolean }): Promise<number> {
    if (
      !options?.force &&
      this.updatePromise !== null &&
      Date.now() - this.lastFlushAt < this.minFlushIntervalDuringUpdateMs
    ) {
      // Mid catch-up: defer, keep the dirty state, and re-arm the cache
      // manager so the state lands on a later cycle (or right after the run,
      // which marks dirty when it finishes).
      this.flushHandledDirty = true;
      this.cacheManager?.markDirty();
      return 0;
    }

    // Snapshot + journal: normally only the entries changed since the last
    // flush are appended as a small segment (`summaryj`); the dirty buckets
    // and meta (the snapshot) are rewritten when this instance has no
    // snapshot of its own yet (also right after a restore), when the
    // journal outgrows 10 % of the buffer (min. 500 entries), and on forced
    // flushes (close). Chains are per writer, like the view cache.
    const prefix = this.getCachePrefix();
    const wantSnapshot =
      options?.force === true ||
      !this.ownSnapshot ||
      this.journalEntriesSinceSnapshot + this.journalPending.size > Math.max(500, this.entries.size * 0.1);
    if (!wantSnapshot) {
      return this.flushJournalSegment(store, prefix);
    }

    // Snapshot everything synchronously before the first await: bucket
    // payloads and the meta cursor must describe the same state, and entries
    // an update run changes while the writes are in flight must stay dirty
    // for the next flush instead of being cleared with this one.
    const bucketsToWrite = this.dirtyBuckets;
    this.dirtyBuckets = new Set();
    const pendingAtSnapshot = this.journalPending;
    const tombstonesAtSnapshot = this.pendingTombstones;
    this.journalPending = new Map();
    this.pendingTombstones = [];
    const journalBase = this.nextJournalSegment;
    this.metaDirty = false;
    this.flushHandledDirty = true;

    const byBucket = new Map<number, DocumentSummaryEntry[]>();
    if (bucketsToWrite.size > 0) {
      // Group entries by bucket once, then rewrite only dirty buckets.
      for (const entry of this.entries.values()) {
        const bucket = this.bucketIndexFor(entry.docId);
        if (!bucketsToWrite.has(bucket)) {
          continue;
        }
        let list = byBucket.get(bucket);
        if (!list) {
          list = [];
          byBucket.set(bucket, list);
        }
        list.push(entry);
      }
    }
    const meta: SummaryMetaPayload = {
      cursor: this.cursor,
      configFingerprint: this.configFingerprint,
      bucketCount: this.bucketCount,
      needsBackfill: this.needsBackfill,
      backfillCursor: this.backfillCursor,
      generation: this.generation,
      updateSeq: this.updateSeq,
      tombstoneHorizon: this.tombstoneHorizon,
      tombstones: this.tombstones,
      lostSeqRanges: this.lostSeqRanges,
      journalWriter: this.journalWriterId,
      journalBase,
    };

    let written = 0;
    try {
      for (const bucket of bucketsToWrite) {
        const payload: SummaryBucketPayload = { entries: byBucket.get(bucket) ?? [] };
        await store.put(
          "summary",
          `${prefix}/bucket/${bucket}`,
          new TextEncoder().encode(JSON.stringify(payload))
        );
        written++;
      }
      await store.put("summary", `${prefix}/meta`, new TextEncoder().encode(JSON.stringify(meta)));
      written++;
    } catch (error) {
      // Nothing is lost: re-dirty the snapshot for the next attempt. The
      // CacheManager skips clearDirty on errors, so reset the handoff flag.
      for (const bucket of bucketsToWrite) {
        this.dirtyBuckets.add(bucket);
      }
      this.restorePending(pendingAtSnapshot, tombstonesAtSnapshot);
      this.metaDirty = true;
      this.flushHandledDirty = false;
      throw error;
    }

    this.ownSnapshot = true;
    this.journalEntriesSinceSnapshot = 0;
    try {
      const journalPrefix = `${prefix}/journal/`;
      for (const id of await store.list("summaryj")) {
        if (id.startsWith(journalPrefix)) await store.delete("summaryj", id);
      }
    } catch {
      // Stale segments are ignored on restore (other chain or before the base).
    }
    this.lastFlushAt = Date.now();
    return written;
  }

  /** Append the entries changed since the last flush as one journal segment. */
  private async flushJournalSegment(store: LocalCacheStore, prefix: string): Promise<number> {
    const pending = this.journalPending;
    const tombstones = this.pendingTombstones;
    this.journalPending = new Map();
    this.pendingTombstones = [];
    this.metaDirty = false;
    this.flushHandledDirty = true;
    const segment: SummaryJournalSegment = {
      entries: [],
      removed: [],
      tombstones,
      meta: {
        cursor: this.cursor,
        configFingerprint: this.configFingerprint,
        bucketCount: this.bucketCount,
        needsBackfill: this.needsBackfill,
        backfillCursor: this.backfillCursor,
        generation: this.generation,
        updateSeq: this.updateSeq,
        tombstoneHorizon: this.tombstoneHorizon,
        lostSeqRanges: this.lostSeqRanges,
      },
    };
    for (const [docId, entry] of pending) {
      if (entry) segment.entries.push(entry);
      else segment.removed.push(docId);
    }
    const segmentNo = this.nextJournalSegment;
    try {
      await store.put(
        "summaryj",
        `${prefix}/journal/${this.journalWriterId}/${String(segmentNo).padStart(10, "0")}`,
        new TextEncoder().encode(JSON.stringify(segment)),
      );
    } catch (error) {
      // Nothing is lost: keep the changes for the next flush.
      this.restorePending(pending, tombstones);
      this.metaDirty = true;
      this.flushHandledDirty = false;
      throw error;
    }
    this.nextJournalSegment = segmentNo + 1;
    this.journalEntriesSinceSnapshot += pending.size;
    this.lastFlushAt = Date.now();
    return 1;
  }

  /** Put changes of a failed write back in front of what changed meanwhile. */
  private restorePending(pending: Map<string, DocumentSummaryEntry | null>, tombstones: Array<[number, string]>): void {
    for (const [docId, entry] of pending) {
      if (!this.journalPending.has(docId)) {
        this.journalPending.set(docId, entry);
      }
    }
    this.pendingTombstones = [...tombstones, ...this.pendingTombstones];
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

    // Replay the journal chain continuing this snapshot: entries, removals
    // and the newest meta (a missing or unreadable segment ends the replay;
    // the changefeed catches up from the last good cursor).
    if (typeof meta.journalWriter === "string") {
      try {
        const chainPrefix = `${prefix}/journal/${meta.journalWriter}/`;
        const base = meta.journalBase ?? 0;
        const numbers = (await store.list("summaryj"))
          .filter((id) => id.startsWith(chainPrefix))
          .map((id) => Number(id.slice(chainPrefix.length)))
          .filter((n) => Number.isInteger(n) && n >= base)
          .sort((a, b) => a - b);
        let expected = base;
        for (const n of numbers) {
          if (n !== expected) break;
          const bytes = await store.get("summaryj", `${chainPrefix}${String(n).padStart(10, "0")}`);
          if (!bytes) break;
          const segment = JSON.parse(new TextDecoder().decode(bytes)) as SummaryJournalSegment;
          for (const entry of segment.entries) {
            this.entries.set(entry.docId, entry);
            this.dirtyBuckets.add(this.bucketIndexFor(entry.docId));
          }
          for (const docId of segment.removed) {
            this.entries.delete(docId);
            this.dirtyBuckets.add(this.bucketIndexFor(docId));
          }
          let tombstones = [...(meta.tombstones ?? []), ...(segment.tombstones ?? [])];
          let horizon = segment.meta.tombstoneHorizon ?? meta.tombstoneHorizon ?? 0;
          if (tombstones.length > MAX_TOMBSTONES) {
            const dropped = tombstones.splice(0, tombstones.length - MAX_TOMBSTONES);
            horizon = Math.max(horizon, dropped[dropped.length - 1][0]);
          }
          meta = { ...segment.meta, tombstones, tombstoneHorizon: horizon };
          expected = n + 1;
        }
      } catch {
        // Keep what was replayed.
      }
    }
    // This instance continues with its own chain: its first flush writes a
    // snapshot (the buckets the replay touched plus meta).
    this.ownSnapshot = false;

    this.cursor = meta.cursor ?? null;
    if (typeof meta.generation === "string" && typeof meta.updateSeq === "number") {
      this.generation = meta.generation;
      this.updateSeq = meta.updateSeq;
      this.tombstoneHorizon = meta.tombstoneHorizon ?? 0;
      this.tombstones = meta.tombstones ?? [];
      // Entries written after the meta record (crash between bucket and meta
      // writes) may carry higher seqs: never hand out a seq twice.
      for (const entry of this.entries.values()) {
        if (typeof entry.updateSeq === "number" && entry.updateSeq > this.updateSeq) {
          this.updateSeq = entry.updateSeq;
        }
      }
      // The previous process may have handed out (and readers may have
      // seen) seqs after the persisted state: never reuse them.
      this.lostSeqRanges = [...(meta.lostSeqRanges ?? []), [this.updateSeq, this.updateSeq + LOST_SEQ_JUMP]];
      if (this.lostSeqRanges.length > 20) {
        const dropped = this.lostSeqRanges.splice(0, this.lostSeqRanges.length - 20);
        this.tombstoneHorizon = Math.max(this.tombstoneHorizon, dropped[dropped.length - 1][1]);
      }
      this.updateSeq += LOST_SEQ_JUMP;
      this.metaDirty = true;
    } else {
      // Cache of an older version: no usable sequence, readers rescan once.
      this.generation = generateRandomUuid();
      this.updateSeq = 0;
      for (const entry of this.entries.values()) {
        delete entry.updateSeq;
      }
    }
    this.rebuildSeqLog();

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
