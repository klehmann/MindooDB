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
import type { DocumentSummaryStore } from "./DocumentSummaryStore";
import { buildSummaryEvaluationDoc, getSummaryFieldValue } from "./extractSummaryFields";

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
export class SummaryVirtualViewDataProvider implements IVirtualViewDataProvider {
  private readonly origin: string;
  private readonly summary: DocumentSummaryStore;
  private readonly filter: MindooDBAppBooleanExpression | null;

  private view: VirtualView | null = null;
  /** Highest summary entry changeSeq already applied to the view. */
  private appliedChangeSeq: number = -1;
  /** Documents currently present in the view from this provider. */
  private knownDocIds: Set<string> = new Set();

  constructor(options: SummaryVirtualViewDataProviderOptions) {
    this.origin = options.origin;
    this.summary = options.summary;
    this.filter = options.filter ?? null;
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

    const columns = view.getColumns();
    const change = new VirtualViewDataChange(this.origin);
    let maxSeenChangeSeq = this.appliedChangeSeq;
    const presentDocIds = new Set<string>();

    for (const entry of this.summary.getAllEntries()) {
      // Record existence BEFORE the incremental skip: presentDocIds means
      // "still in the summary", not "processed in this run", so the removal
      // sweep below never drops unchanged (skipped) documents.
      presentDocIds.add(entry.docId);
      // Incremental watermark: entries at or below the already-applied
      // changefeed sequence are unchanged and already sit in the view with
      // correct column values — recomputing them would make every update a
      // full rebuild.
      if (entry.changeSeq <= this.appliedChangeSeq) {
        continue;
      }
      maxSeenChangeSeq = Math.max(maxSeenChangeSeq, entry.changeSeq);

      const evaluationDoc = buildSummaryEvaluationDoc(entry.fields, entry.lastModified);
      const context: ExpressionEvaluationContext = {
        doc: evaluationDoc,
        values: {},
        origin: this.origin,
        decryptionKeyId: entry.decryptionKeyId,
        variables: {},
      };

      const passesFilter =
        !this.filter || expressionToBoolean(evaluateExpression(this.filter, context));

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
    // purges). Documents that merely stopped matching the filter are
    // handled by the else-if branch above instead — their changeSeq rose
    // above the watermark, so they were re-evaluated in this run.
    for (const docId of this.knownDocIds) {
      if (!presentDocIds.has(docId)) {
        change.removeEntry(docId);
        this.knownDocIds.delete(docId);
      }
    }

    if (change.hasChanges()) {
      view.applyChanges(change);
    }
    this.appliedChangeSeq = maxSeenChangeSeq;
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
    this.appliedChangeSeq = -1;
    this.knownDocIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Cache serialization (ephemeral views are typically not cached, but the
  // provider supports it for symmetry with the MindooDB provider)
  // ---------------------------------------------------------------------------

  exportCacheState(): unknown {
    return {
      appliedChangeSeq: this.appliedChangeSeq,
      knownDocIds: Array.from(this.knownDocIds),
    };
  }

  importCacheState(state: unknown): void {
    const s = state as { appliedChangeSeq?: number; knownDocIds?: string[]; cursor?: ProcessChangesCursor | null };
    this.appliedChangeSeq = s.appliedChangeSeq ?? -1;
    if (s.knownDocIds) {
      this.knownDocIds = new Set(s.knownDocIds);
    }
  }
}
