import type { ProcessChangesCursor } from "../../types";
import type { IVirtualViewDataProvider, VirtualViewUpdateOptions } from "../virtualviews/IVirtualViewDataProvider";
import type { VirtualView } from "../virtualviews/VirtualView";
import type { VirtualViewColumn } from "../virtualviews/VirtualViewColumn";
import { VirtualViewDataChange } from "../virtualviews/VirtualViewDataChange";
import type { MindooDBAppBooleanExpression } from "../../expressions/types";
import {
  evaluateExpression,
  expressionToBoolean,
  type ExpressionEvaluationContext,
} from "../../expressions/evaluateExpression";
import { MindooQueryError, type MindooQueryTextClause } from "../../query/types";
import type { DocumentFullTextIndex } from "../fulltext/DocumentFullTextIndex";
import type { DocumentSummaryStore } from "./DocumentSummaryStore";
import { buildSummaryEvaluationDoc, getSummaryFieldValue } from "./extractSummaryFields";
import {
  findDrivingFolder,
  type FilingRefChanges,
  type IFilingAwareDataProvider,
} from "../virtualviews/VirtualViewFilingJoin";
import type { DocumentSummaryEntry, SummaryStorePosition } from "./types";

export interface SummaryVirtualViewDataProviderOptions {
  /** Unique origin identifier for this data provider */
  origin: string;

  /** The summary buffer to read entries from */
  summary: DocumentSummaryStore;

  /**
   * Optional expression filter (MindooDB expression language) selecting
   * which summary entries appear in the view.
   */
  filter?: MindooDBAppBooleanExpression;

  /**
   * Optional full-text pre-filter: only documents matching this search in
   * the given full-text index appear in the view (combined with `filter`
   * as a logical AND). The index is brought up to date on every provider
   * update; documents whose match state or normalized score changes are
   * re-evaluated even when their summary entry is unchanged. Matching
   * documents expose the pseudo-fields `_textScore` (normalized 0..1
   * relative to the best hit, rounded to 2 decimals) and `_textScoreRaw`
   * (engine-specific raw score) to filter and column expressions.
   */
  text?: {
    index: DocumentFullTextIndex;
    clause: MindooQueryTextClause;
  };

  /**
   * Physical identity `"<tenantId>/<dbId>"` of the summarized database.
   * Needed to match filing references (`folders()` / `inFolder()` against
   * stores joined with `withFilingStore`); without it the provider sees
   * every document as not filed.
   */
  dbKey?: string;
}

/**
 * VirtualView data provider backed by the {@link DocumentSummaryStore}
 * instead of document materialization — the engine behind ephemeral views
 * (`db.queryView()`).
 *
 * `update()` first brings the summary up to date (delegating batching/
 * progress/cancellation options), then feeds new/changed/removed summary
 * entries into the view. Column values are computed from summary fields:
 * declarative `expression` columns are evaluated per entry; columns
 * without an expression read the summary field of the same name. JS
 * `valueFunction` columns are NOT supported here (there is no materialized
 * document to pass them).
 */
export class SummaryVirtualViewDataProvider implements IVirtualViewDataProvider, IFilingAwareDataProvider {
  private readonly origin: string;
  private readonly summary: DocumentSummaryStore;
  private readonly filter: MindooDBAppBooleanExpression | null;
  private readonly text: SummaryVirtualViewDataProviderOptions["text"] | null;

  private view: VirtualView | null = null;
  /** Highest summary entry changeSeq already applied to the view. */
  private appliedPosition: SummaryStorePosition | null = null;
  /** Documents currently present in the view from this provider. */
  private knownDocIds: Set<string> = new Set();
  /**
   * Full-text scores of the previous update run (docId → rounded
   * normalized score). Needed to detect membership flips AND score changes
   * that happen WITHOUT a summary entry change (e.g. the index backfilling
   * after a config change, or a new top hit shifting the normalization),
   * which the changeSeq watermark alone would skip.
   */
  private lastTextScores: Map<string, number> | null = null;
  private readonly dbKey: string | null;
  /**
   * Documents (ids of this database) whose folder membership changed and
   * that must be re-evaluated on the next update even when their summary
   * entry is unchanged — the filing counterpart of `lastTextScores`.
   */
  private pendingFilingDocIds: Set<string> = new Set();
  /** Re-evaluate everything on the next update (first build, log overflow). */
  private pendingFilingAll: boolean = false;

  constructor(options: SummaryVirtualViewDataProviderOptions) {
    this.origin = options.origin;
    this.summary = options.summary;
    this.filter = options.filter ?? null;
    this.text = options.text ?? null;
    this.dbKey = options.dbKey ?? null;
  }

  onFilingChanges(changes: FilingRefChanges): void {
    if (changes === "all") {
      this.pendingFilingAll = true;
      this.pendingFilingDocIds.clear();
      return;
    }
    if (this.pendingFilingAll || !this.dbKey) {
      return;
    }
    const prefix = `${this.dbKey}/`;
    for (const ref of changes) {
      if (ref.startsWith(prefix)) {
        this.pendingFilingDocIds.add(ref.slice(prefix.length));
      }
    }
  }

  /** Build the `folders()` lookup for one document. */
  private foldersLookup(docId: string): ((store: string) => readonly string[]) | undefined {
    const join = this.view?.getFilingJoin();
    if (!join || !this.dbKey) {
      return undefined;
    }
    const physRef = `${this.dbKey}/${docId}`;
    return (store: string) => join.foldersOf(store, physRef);
  }

  /**
   * The summary entries to look at in this run:
   * - without a usable delta (first run, summary rebuilt): every entry;
   * - with a delta: the entries written since the last run plus documents
   *   that must be re-checked (`forced`: folder or text-match changes);
   * - when the filter is driven by one folder (`inFolder(store, id)` as
   *   (part of a top-level AND) filter): that folder's members (plus
   *   `forced`, plus known rows on a full run), skipping members that did
   *   not change when a delta exists.
   */
  private *candidateEntries(
    forced: ReadonlySet<string>,
    delta: { entries: DocumentSummaryEntry[]; changed: ReadonlySet<string> } | null,
  ): Iterable<DocumentSummaryEntry> {
    const join = this.view?.getFilingJoin();
    const driving = findDrivingFolder(this.filter);
    if (!driving || !join || !join.has(driving.store) || !this.dbKey) {
      if (!delta) {
        yield* this.summary.getAllEntries();
        return;
      }
      yield* delta.entries;
      for (const docId of forced) {
        if (!delta.changed.has(docId)) {
          const entry = this.summary.getEntry(docId);
          if (entry) yield entry;
        }
      }
      return;
    }
    const prefix = `${this.dbKey}/`;
    const docIds = new Set<string>();
    for (const ref of join.membersOf(driving.store, driving.folderId)) {
      if (ref.startsWith(prefix)) {
        const docId = ref.slice(prefix.length);
        if (!delta || delta.changed.has(docId)) {
          docIds.add(docId);
        }
      }
    }
    for (const docId of forced) {
      docIds.add(docId);
    }
    if (!delta) {
      for (const docId of this.knownDocIds) {
        docIds.add(docId);
      }
    }
    for (const docId of docIds) {
      const entry = this.summary.getEntry(docId);
      if (entry) {
        yield entry;
      }
    }
  }

  getOrigin(): string {
    return this.origin;
  }

  init(view: VirtualView): void {
    this.view = view;
    for (const column of view.getColumns()) {
      if (column.valueFunction && !column.expression) {
        throw new Error(
          `Column '${column.name}' uses a JS valueFunction, which summary-backed views do not support — ` +
          `use a declarative 'expression' instead.`
        );
      }
    }
  }

  async update(options?: VirtualViewUpdateOptions): Promise<void> {
    if (!this.view) {
      throw new Error("Data provider not initialized - call init() first");
    }
    const view = this.view;

    // Keep the underlying summary current first; the expensive part
    // (changefeed consumption) honors the caller's progress/cancel options.
    await this.summary.update(options);
    if (options?.signal?.aborted) {
      return;
    }

    // Full-text pre-filter: bring the index up to date and resolve the
    // match set once per run. Documents whose membership flipped OR whose
    // normalized score changed since the last run must be re-evaluated
    // even when their summary entry is unchanged (index backfills change
    // matches without changeSeq bumps; a new top hit shifts the
    // normalization of every other score).
    let textScores: Map<string, number> | null = null;
    let textScoresRaw: Map<string, number> | null = null;
    let flippedTextMatches: Set<string> | null = null;
    if (this.text) {
      await this.text.index.update(options);
      if (options?.signal?.aborted) {
        return;
      }
      if (!this.text.index.isEnabled()) {
        throw new MindooQueryError(
          `View has a text clause, but full-text indexing is not enabled for this database ` +
          `(enable it via setFulltextSetup({ enabled: true }), see docs/fulltext-search.md).`,
          "fulltext-not-enabled"
        );
      }
      const clause = this.text.clause;
      const { hits } = this.text.index.searchSync(clause.query, {
        fields: clause.fields,
        prefix: clause.prefix,
        fuzzy: clause.fuzzy,
        combineWith: clause.combineWith,
      });
      // Normalize relative to the best hit of this run (hits are sorted
      // best-first): the top hit scores 1.0, everything else 0..1. Clamped
      // defensively (BM25 IDF can go negative in degenerate corpora) and
      // rounded to 2 decimals so tiny BM25 shifts don't churn
      // threshold-based category formulas on every update.
      const maxScore = hits.length > 0 ? hits[0].score : 0;
      textScores = new Map();
      textScoresRaw = new Map();
      for (const hit of hits) {
        const ratio = maxScore > 0 ? hit.score / maxScore : hit.score === maxScore ? 1 : 0;
        const normalized = Math.round(Math.min(1, Math.max(0, ratio)) * 100) / 100;
        textScores.set(hit.docId, normalized);
        textScoresRaw.set(hit.docId, hit.score);
      }
      if (this.lastTextScores) {
        flippedTextMatches = new Set<string>();
        for (const [docId, score] of textScores) {
          if (this.lastTextScores.get(docId) !== score) {
            flippedTextMatches.add(docId);
          }
        }
        for (const docId of this.lastTextScores.keys()) {
          if (!textScores.has(docId)) {
            flippedTextMatches.add(docId);
          }
        }
      }
    }

    const columns = view.getColumns();
    const change = new VirtualViewDataChange(this.origin);

    // Filing changes consumed by this run (re-checked even when their
    // summary entry is unchanged; see onFilingChanges).
    const filingAll = this.pendingFilingAll;
    const filingDocIds = this.pendingFilingDocIds;
    this.pendingFilingAll = false;
    this.pendingFilingDocIds = new Set();

    // Incremental read: only the entries the summary wrote since the last
    // run (O(changes) instead of a scan of every entry). Without a usable
    // position (first run, summary rebuilt, too far behind) or when
    // everything must be re-checked, the run evaluates every entry.
    const position = this.summary.getPosition();
    const storeDelta = filingAll ? null : this.summary.getChangesSince(this.appliedPosition);
    const delta = storeDelta
      ? { entries: storeDelta.entries, changed: new Set(storeDelta.entries.map((entry) => entry.docId)) }
      : null;
    const forced = new Set<string>(filingDocIds);
    for (const docId of flippedTextMatches ?? []) {
      forced.add(docId);
    }

    for (const entry of this.candidateEntries(forced, delta)) {
      let evaluationDoc = buildSummaryEvaluationDoc(entry.fields, entry.lastModified);
      // Mirror the full-text relevance as managed pseudo-fields (like
      // `_lastModified`), so column/category formulas can grade match
      // quality: `_textScore` is normalized 0..1 relative to the best hit
      // of this search run, `_textScoreRaw` is the engine's raw score.
      // Copy before extending — buildSummaryEvaluationDoc may return the
      // stored field map itself.
      if (textScores !== null && textScores.has(entry.docId)) {
        evaluationDoc = {
          ...evaluationDoc,
          _textScore: textScores.get(entry.docId),
          _textScoreRaw: textScoresRaw!.get(entry.docId),
        };
      }
      const context: ExpressionEvaluationContext = {
        doc: evaluationDoc,
        values: {},
        origin: this.origin,
        docId: entry.docId,
        lastModifiedAt: new Date(entry.lastModified).toISOString(),
        decryptionKeyId: entry.decryptionKeyId,
        variables: {},
        folders: this.foldersLookup(entry.docId),
      };

      const passesFilter =
        (textScores === null || textScores.has(entry.docId)) &&
        (!this.filter || expressionToBoolean(evaluateExpression(this.filter, context)));

      if (passesFilter) {
        change.addEntry(
          entry.docId,
          this.computeColumnValues(columns, context),
          entry.decryptionKeyId ?? undefined
        );
        this.knownDocIds.add(entry.docId);
      } else if (this.knownDocIds.has(entry.docId)) {
        change.removeEntry(entry.docId);
        this.knownDocIds.delete(entry.docId);
      }
    }

    // Entries that vanished from the summary map entirely (tombstones/
    // purges). Documents that merely stopped matching the filter were
    // re-evaluated above (their entry changed, or they were forced).
    const removalCandidates: Iterable<string> = storeDelta
      ? [...storeDelta.removedDocIds, ...forced]
      : Array.from(this.knownDocIds);
    for (const docId of removalCandidates) {
      if (this.knownDocIds.has(docId) && !this.summary.getEntry(docId)) {
        change.removeEntry(docId);
        this.knownDocIds.delete(docId);
      }
    }

    if (change.hasChanges()) {
      view.applyChanges(change);
    }
    this.appliedPosition = position;
    this.lastTextScores = textScores;
  }

  private computeColumnValues(
    columns: VirtualViewColumn[],
    context: ExpressionEvaluationContext
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const column of columns) {
      if (column.expression) {
        values[column.name] = evaluateExpression(column.expression, { ...context, values });
      } else {
        // The evaluation doc carries the extracted fields plus the mirrored
        // managed fields (`_lastModified`, slim `_attachments`).
        values[column.name] = getSummaryFieldValue(context.doc, column.name);
      }
    }
    return values;
  }

  reset(): void {
    this.appliedPosition = null;
    this.knownDocIds.clear();
    this.lastTextScores = null;
    this.pendingFilingAll = false;
    this.pendingFilingDocIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Cache serialization (ephemeral views are typically not cached, but the
  // provider supports it for symmetry with the MindooDB provider)
  // ---------------------------------------------------------------------------

  exportCacheState(): unknown {
    return {
      appliedPosition: this.appliedPosition,
      knownDocIds: Array.from(this.knownDocIds),
      pendingFilingAll: this.pendingFilingAll || undefined,
      pendingFilingDocIds: this.pendingFilingDocIds.size > 0 ? Array.from(this.pendingFilingDocIds) : undefined,
    };
  }

  importCacheState(state: unknown): void {
    const s = state as {
      appliedPosition?: SummaryStorePosition | null;
      knownDocIds?: string[];
      cursor?: ProcessChangesCursor | null;
      pendingFilingAll?: boolean;
      pendingFilingDocIds?: string[];
    };
    // Older caches stored a changefeed watermark instead: rescan once.
    this.appliedPosition =
      s.appliedPosition && typeof s.appliedPosition.generation === "string" ? { ...s.appliedPosition } : null;
    if (s.knownDocIds) {
      this.knownDocIds = new Set(s.knownDocIds);
    }
    this.pendingFilingAll = s.pendingFilingAll === true;
    this.pendingFilingDocIds = new Set(s.pendingFilingDocIds ?? []);
  }
}
