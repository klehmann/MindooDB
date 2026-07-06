import type { MindooDB, MindooDoc, ProcessChangesCursor } from "../../types";
import type { LocalCacheStore } from "../../cache/LocalCacheStore";
import type { CacheManager, ICacheable } from "../../cache/CacheManager";
import type { VirtualViewUpdateOptions } from "../virtualviews/IVirtualViewDataProvider";
import { DB_SETUP_DOC_ID } from "../summary/types";
import type {
  AttachmentTextExtractor,
  FulltextConfig,
  FulltextCoverage,
  FulltextMetaPayload,
  FulltextSearchOptions,
  FulltextSearchResult,
  ResolvedFulltextConfig,
} from "./types";
import {
  FULLTEXT_ATTACHMENT_FIELD,
  FULLTEXT_SETUP_FIELD,
  computeFulltextConfigFingerprint,
  resolveFulltextConfig,
  sanitizeFulltextConfig,
} from "./types";
import { extractFulltextFields } from "./extractFulltextText";
import { MiniSearchAdapter, type SearchEngineAdapter } from "./SearchEngineAdapter";

/**
 * Attachments above this size are skipped during text extraction: they
 * would have to be fully materialized in memory, and extractable text
 * that large exceeds any sensible per-field cap anyway.
 */
const MAX_ATTACHMENT_EXTRACT_BYTES = 16 * 1024 * 1024;

/**
 * The document full-text index: a changefeed-maintained, encrypted-at-rest
 * search index over extracted document text (see docs/fulltext-search.md).
 *
 * Sits next to the {@link DocumentSummaryStore} as a second derived index:
 * same changefeed pipeline (cursor, resumable backfill, config
 * fingerprint), same encrypted persistence through the tenant's
 * {@link LocalCacheStore}, same `dbsetup` reconciliation (field
 * `fulltextSetup`). Unlike the summary it is OPT-IN (`enabled: true`);
 * text is extracted from the materialized documents the changefeed yields
 * anyway — including long-text and rich-text fields that must stay out of
 * the RAM-resident summary buffer.
 *
 * E2EE note: the index is built client-side from decrypted content, so
 * devices whose KeyBag lacks certain decryption keys index (and find)
 * fewer documents. Purge paths remove entries immediately so plaintext
 * tokens never outlive key revocation.
 */
export class DocumentFullTextIndex implements ICacheable {
  private readonly db: MindooDB;
  private config: ResolvedFulltextConfig;
  private configFingerprint: string;
  /**
   * `true` when the configuration came from code (constructor arg or
   * `setConfig`). Without an explicit configuration the index follows the
   * `fulltextSetup` field of the synced {@link DB_SETUP_DOC_ID} document.
   */
  private hasExplicitConfig: boolean;
  /** Whether the setup document was already consulted (once per instance). */
  private setupDocSeeded: boolean = false;

  private engine: SearchEngineAdapter;
  private cursor: ProcessChangesCursor | null = null;

  /**
   * Attachment text extractors, provided by the host environment (see
   * `MindooDB.registerAttachmentTextExtractor`). Read lazily so
   * registrations after index creation are honored for subsequently
   * indexed documents.
   */
  private readonly getAttachmentExtractors: () => AttachmentTextExtractor[];

  // --- persistence state ---
  private cacheManager: CacheManager | null = null;
  private cachePrefix: string | null = null;
  private engineDirty: boolean = false;
  private metaDirty: boolean = false;
  private restorePromise: Promise<void> | null = null;
  private restored: boolean = false;

  // --- backfill state (config changed while the index already has content) ---
  private needsBackfill: boolean = false;
  private backfillCursor: ProcessChangesCursor | null = null;

  // --- single-flight update ---
  private updatePromise: Promise<void> | null = null;

  constructor(
    db: MindooDB,
    config?: FulltextConfig,
    options?: { getAttachmentExtractors?: () => AttachmentTextExtractor[] }
  ) {
    this.db = db;
    this.hasExplicitConfig = config !== undefined;
    this.config = resolveFulltextConfig(config);
    this.configFingerprint = computeFulltextConfigFingerprint(this.config);
    this.getAttachmentExtractors = options?.getAttachmentExtractors ?? (() => []);
    this.engine = this.createEngine();
  }

  private createEngine(): SearchEngineAdapter {
    return new MiniSearchAdapter(this.config.language, this.config.include);
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  getConfig(): ResolvedFulltextConfig {
    return this.config;
  }

  getConfigFingerprint(): string {
    return this.configFingerprint;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Replace the full-text configuration. When the fingerprint changes,
   * the engine is recreated (tokenizer/language and field extraction may
   * differ) and a resumable backfill re-indexes all documents on the next
   * `update()` run. Until the backfill finishes the index reports
   * `"rebuilding"` and serves the (growing) partial result.
   *
   * Calling this marks the configuration as explicit: the index stops
   * following the {@link DB_SETUP_DOC_ID} document.
   */
  setConfig(config?: FulltextConfig): void {
    this.hasExplicitConfig = true;
    this.applyConfig(config);
  }

  /** Shared config-swap logic for explicit and setup-document paths. */
  private applyConfig(config?: FulltextConfig): void {
    const resolved = resolveFulltextConfig(config);
    const fingerprint = computeFulltextConfigFingerprint(resolved);
    if (fingerprint === this.configFingerprint) {
      return;
    }
    const hadContent = this.engine.getDocumentCount() > 0 || this.cursor !== null;
    this.config = resolved;
    this.configFingerprint = fingerprint;
    // Unlike the summary the engine state is tokenizer-dependent, so a
    // config change always starts over with a fresh engine.
    this.engine = this.createEngine();
    this.engineDirty = true;
    if (hadContent && this.config.enabled) {
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
   * document (its `fulltextSetup` field) unless an explicit configuration
   * was provided in code. Runs once per instance, BEFORE the persisted
   * state is restored, so the fingerprint comparison on restore already
   * sees the setup-document configuration.
   */
  private async seedConfigFromSetupDoc(): Promise<void> {
    if (this.setupDocSeeded || this.hasExplicitConfig) {
      this.setupDocSeeded = true;
      return;
    }
    this.setupDocSeeded = true;
    await this.reloadConfigFromSetupDoc();
  }

  /** Fresh read of the setup document (no-op with an explicit config). */
  private async reloadConfigFromSetupDoc(): Promise<void> {
    if (this.hasExplicitConfig) {
      return;
    }
    try {
      const doc = await this.db.getDocument(DB_SETUP_DOC_ID);
      const config = sanitizeFulltextConfig(doc.getData()[FULLTEXT_SETUP_FIELD]);
      this.applyConfig(config);
    } catch {
      // No setup document (or not readable) → keep the current config.
    }
  }

  /**
   * Make sure the effective configuration is settled: consults the
   * {@link DB_SETUP_DOC_ID} document once (unless the config was provided
   * in code) and returns the resolved configuration.
   */
  async ensureConfigLoaded(): Promise<ResolvedFulltextConfig> {
    await this.seedConfigFromSetupDoc();
    return this.config;
  }

  /**
   * `"full"` when the index reflects the current configuration,
   * `"rebuilding"` while a configuration-change backfill is in progress.
   */
  getCoverage(): FulltextCoverage {
    return this.needsBackfill ? "rebuilding" : "full";
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  getSize(): number {
    return this.engine.getDocumentCount();
  }

  getCursor(): ProcessChangesCursor | null {
    return this.cursor;
  }

  /** Index field names currently known (document paths + `_attachments`). */
  getFieldNames(): string[] {
    return this.engine.getFieldNames();
  }

  /**
   * Full-text search. Brings the index up to date first (same catch-up
   * semantics as queries against the summary buffer), then returns
   * matching documents best-score-first.
   *
   * @throws Error when full-text indexing is not enabled for this
   *   database (neither via `fulltextSetup` nor an explicit config).
   */
  async search(
    query: string,
    options?: FulltextSearchOptions & VirtualViewUpdateOptions
  ): Promise<FulltextSearchResult> {
    await this.update(options);
    if (!this.config.enabled) {
      throw new Error(
        `Full-text search is not enabled for this database. ` +
        `Enable it via setFulltextSetup({ enabled: true }) or pass an explicit config to getFullTextIndex().`
      );
    }
    return {
      hits: this.engine.search(query, options),
      coverage: this.getCoverage(),
    };
  }

  /**
   * Search without a catch-up run — evaluates against the current index
   * state. Used by the query engine, which coordinates update passes
   * itself.
   */
  searchSync(query: string, options?: FulltextSearchOptions): FulltextSearchResult {
    return {
      hits: this.engine.search(query, options),
      coverage: this.getCoverage(),
    };
  }

  // ---------------------------------------------------------------------------
  // Incremental update
  // ---------------------------------------------------------------------------

  /**
   * Bring the index up to date with the changefeed. Restores persisted
   * state on first use, then consumes `iterateChangesSince` from the
   * saved cursor and finally works down a pending configuration backfill.
   * While the configuration has `enabled: false` this is a cheap no-op
   * (one setup-document read to detect a later enable).
   *
   * Accepts the same batching/progress/cancellation options as summary
   * updates; an interrupted run resumes from the saved cursors. Calls are
   * single-flight: concurrent callers share one run.
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

    if (!this.config.enabled) {
      // Disabled: don't touch the changefeed (that would materialize
      // documents for nothing). Re-check the setup document so an enable
      // arriving via sync is picked up by the next update call.
      await this.reloadConfigFromSetupDoc();
      if (!this.config.enabled) {
        return;
      }
    }

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
        onProgress?.({ processed, total, origin: "fulltext" }) === false;
      return callbackStop || signal?.aborted === true;
    };

    if (signal?.aborted) {
      return;
    }

    // Pass 1: incremental changefeed consumption from the main cursor.
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor)) {
      await this.applyDocument(doc.getId(), doc as MindooDoc);
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
      if (!this.config.enabled) {
        // A dbsetup change in the feed disabled the index: stop consuming.
        return;
      }
    }

    // Pass 2: configuration backfill (re-index everything with the new
    // config/engine). The feed yields each document's latest state once,
    // so plain re-adds converge; docs changing mid-backfill are
    // re-processed by the next pass 1 anyway.
    if (this.needsBackfill) {
      for await (const { doc, cursor } of this.db.iterateChangesSince(this.backfillCursor)) {
        await this.applyDocument(doc.getId(), doc as MindooDoc);
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
        if (!this.config.enabled) {
          return;
        }
      }
      this.needsBackfill = false;
      this.backfillCursor = null;
      this.metaDirty = true;
    }

    this.cacheManager?.markDirty();
    if (onProgress) {
      onProgress({ processed, total, origin: "fulltext" });
    }
  }

  private async applyDocument(docId: string, doc: MindooDoc): Promise<void> {
    if (docId === DB_SETUP_DOC_ID) {
      // The setup document configures the index instead of appearing in
      // it. Config changes (also arriving via sync) recreate the engine
      // and schedule a backfill; a deleted setup document falls back to
      // the default (disabled) config.
      if (!this.hasExplicitConfig) {
        const config = doc.isDeleted()
          ? undefined
          : sanitizeFulltextConfig(doc.getData()[FULLTEXT_SETUP_FIELD]);
        this.applyConfig(config);
      }
      if (this.engine.has(docId)) {
        this.engine.remove(docId);
        this.markEngineDirty();
      }
      return;
    }

    if (doc.isDeleted()) {
      if (this.engine.has(docId)) {
        this.engine.remove(docId);
        this.markEngineDirty();
      }
      return;
    }

    const fields = extractFulltextFields(
      doc.getData() as Record<string, unknown>,
      this.config
    );

    const attachmentText = await this.collectAttachmentText(doc);
    if (attachmentText !== null) {
      fields[FULLTEXT_ATTACHMENT_FIELD] = attachmentText;
    }

    if (Object.keys(fields).length === 0) {
      if (this.engine.has(docId)) {
        this.engine.remove(docId);
        this.markEngineDirty();
      }
      return;
    }

    this.engine.add(docId, fields);
    this.markEngineDirty();
  }

  /**
   * Collect the searchable text of a document's attachments into the
   * synthetic {@link FULLTEXT_ATTACHMENT_FIELD} (capped at
   * `maxFieldBytes` like every other index field). Two sources feed it:
   *
   * 1. **Persisted extraction results** (`extractedText` on the
   *    attachment entry, written via
   *    `MindooDoc.setAttachmentExtractedText()`, e.g. by Haven's OCR
   *    service). These are always indexed — the text is already there,
   *    costs nothing, and is obviously meant to be searchable.
   * 2. **Registered extractors** (cheap formats: plain text, PDF text
   *    layer, Office) — only when `config.attachments` is enabled, and
   *    only for attachments without a persisted result (a persisted
   *    "failed"/"skipped" marker also suppresses the extractor run).
   *
   * Extraction failures skip the attachment — a broken PDF must never
   * stall the changefeed pipeline.
   */
  private async collectAttachmentText(doc: MindooDoc): Promise<string | null> {
    if (typeof doc.getAttachments !== "function") {
      return null;
    }
    const attachments = doc.getAttachments();
    if (attachments.length === 0) {
      return null;
    }
    const extractors = this.config.attachments ? this.getAttachmentExtractors() : [];

    const parts: string[] = [];
    let budget = this.config.maxFieldBytes;
    for (const attachment of attachments) {
      if (budget <= 0) {
        break;
      }

      // Source 1: persisted extraction result at the attachment entry.
      if (typeof attachment.extractedText === "string") {
        const persisted = attachment.extractedText;
        if (persisted.trim().length > 0) {
          const clipped = persisted.length > budget ? persisted.slice(0, budget) : persisted;
          parts.push(clipped);
          budget -= clipped.length;
        }
        continue;
      }
      if (attachment.extractionStatus !== undefined) {
        // "failed"/"skipped" marker without text: deliberate outcome —
        // don't burn extractor time on it.
        continue;
      }

      // Source 2: registered extractors (config.attachments only).
      if (extractors.length === 0) {
        continue;
      }
      if (attachment.size > MAX_ATTACHMENT_EXTRACT_BYTES) {
        continue;
      }
      const extractor = extractors.find((candidate) =>
        candidate.supports(attachment.mimeType ?? "", attachment.fileName ?? "")
      );
      if (!extractor) {
        continue;
      }
      try {
        const bytes = await doc.getAttachment(attachment.attachmentId);
        const text = await extractor.extract(bytes, {
          mimeType: attachment.mimeType ?? "",
          fileName: attachment.fileName ?? "",
        });
        if (text && text.trim().length > 0) {
          const clipped = text.length > budget ? text.slice(0, budget) : text;
          parts.push(clipped);
          budget -= clipped.length;
        }
      } catch {
        // Skip unreadable/unsupported attachments; document fields are
        // still indexed.
      }
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }

  /**
   * Drop a document's index entry immediately (called from the DB's purge
   * paths so extracted plaintext tokens never outlive key
   * revocation/purges; the changefeed tombstone would remove it anyway,
   * but only on the next update run).
   */
  removeDocument(docId: string): void {
    if (this.engine.has(docId)) {
      this.engine.remove(docId);
      this.markEngineDirty();
      this.cacheManager?.markDirty();
    }
  }

  /** Drop all indexed content and cursors (e.g. after the underlying store was cleared). */
  reset(): void {
    this.engine.clear();
    this.cursor = null;
    this.needsBackfill = false;
    this.backfillCursor = null;
    this.engineDirty = true;
    this.metaDirty = true;
    this.cacheManager?.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Persistence (ICacheable)
  // ---------------------------------------------------------------------------

  /**
   * Attach cache persistence. `cachePrefix` scopes all records of this
   * index (recommended: `<dbCachePrefix>/fulltext`). Registers with the
   * CacheManager for periodic flushing; the persisted state is restored
   * lazily on the first `update()` call.
   */
  attachCache(cacheManager: CacheManager, cachePrefix: string): void {
    this.cacheManager = cacheManager;
    this.cachePrefix = cachePrefix;
    cacheManager.register(this);
  }

  getCachePrefix(): string {
    return this.cachePrefix ?? "fulltext";
  }

  hasDirtyState(): boolean {
    return this.engineDirty || this.metaDirty;
  }

  clearDirty(): void {
    this.engineDirty = false;
    this.metaDirty = false;
  }

  private markEngineDirty(): void {
    this.engineDirty = true;
    this.metaDirty = true;
  }

  async flushToCache(store: LocalCacheStore, _options?: { force?: boolean }): Promise<number> {
    const prefix = this.getCachePrefix();
    let written = 0;

    if (this.engineDirty) {
      await store.put("fulltext", `${prefix}/engine`, this.engine.serialize());
      written++;
    }

    const meta: FulltextMetaPayload = {
      cursor: this.cursor,
      configFingerprint: this.configFingerprint,
      needsBackfill: this.needsBackfill,
      backfillCursor: this.backfillCursor,
    };
    await store.put("fulltext", `${prefix}/meta`, new TextEncoder().encode(JSON.stringify(meta)));
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
   * Restore persisted state. Unlike the summary, index content is only
   * usable when the config fingerprint matches exactly (tokenization is
   * config-dependent); a mismatch or unreadable blob starts empty and
   * schedules a full backfill instead.
   */
  private async restoreFromCache(): Promise<void> {
    const store = this.cacheManager?.getStore();
    if (!store) {
      return;
    }
    const prefix = this.getCachePrefix();

    let meta: FulltextMetaPayload;
    try {
      const metaBytes = await store.get("fulltext", `${prefix}/meta`);
      if (!metaBytes) {
        return;
      }
      meta = JSON.parse(new TextDecoder().decode(metaBytes)) as FulltextMetaPayload;
    } catch {
      return;
    }

    if (meta.configFingerprint !== this.configFingerprint) {
      // Index was built with a different configuration/engine version:
      // start empty, re-index everything in the background.
      this.scheduleBackfill();
      this.metaDirty = true;
      return;
    }

    try {
      const engineBytes = await store.get("fulltext", `${prefix}/engine`);
      if (engineBytes) {
        this.engine.load(engineBytes);
      }
    } catch {
      // A corrupt blob only loses the cached index; rebuild from the feed.
      this.engine = this.createEngine();
      this.cursor = null;
      this.scheduleBackfill();
      this.metaDirty = true;
      return;
    }

    this.cursor = meta.cursor ?? null;

    if (meta.needsBackfill) {
      // Resume an interrupted backfill where it left off.
      this.needsBackfill = true;
      this.backfillCursor = meta.backfillCursor ?? null;
    }
  }
}
