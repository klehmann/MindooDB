import type { MindooDBAppBooleanExpression, MindooDBAppExpression } from "../expressions/types";
import type { SummaryCoverage } from "../indexing/summary/types";
import type { VirtualViewUpdateOptions } from "../indexing/virtualviews/IVirtualViewDataProvider";

/**
 * One sort key of a {@link MindooQuery}. Either a plain summary field path
 * or a computed expression (evaluated per row before comparison).
 */
export interface MindooQuerySortKey {
  field?: string;
  expression?: MindooDBAppExpression;
  direction?: "ascending" | "descending";
}

/**
 * An ad-hoc query over the document summary buffer (see
 * docs/adhoc-queries.md).
 *
 * The filter IS an expression of the MindooDB expression language — built
 * with `createViewLanguage()` or parsed from formula text with
 * `parseMindooDBFormulaBooleanExpression()` — so query definitions are
 * plain JSON and travel safely across process boundaries.
 */
export interface MindooQuery {
  filter?: MindooDBAppBooleanExpression;
  sortBy?: MindooQuerySortKey[];
  limit?: number;
  offset?: number;
  /**
   * Projection: restrict the fields returned per row. Defaults to all
   * summary fields of the matching document.
   */
  fields?: string[];
}

export interface MindooQueryOptions extends VirtualViewUpdateOptions {
  /**
   * Escape hatch: materialize every document via the changefeed instead of
   * querying the summary buffer. Removes the summary coverage requirement
   * and allows `decrypt` expressions, but costs a full document scan —
   * document as expensive, use only for one-off/administrative queries.
   */
  allowFullScan?: boolean;
}

export interface MindooQueryRow {
  docId: string;
  fields: Record<string, unknown>;
  lastModified: number;
}

/**
 * Which data answered the query: `"full"`/`"rebuilding"` from the summary
 * buffer (see {@link SummaryCoverage}), `"full-scan"` when documents were
 * materialized via `allowFullScan`.
 */
export type MindooQueryCoverage = SummaryCoverage | "full-scan";

export interface MindooQueryResult {
  rows: MindooQueryRow[];
  /** Number of matching documents before `offset`/`limit` were applied. */
  total: number;
  coverage: MindooQueryCoverage;
}

/**
 * Thrown for queries that cannot be answered: referenced fields outside the
 * summary coverage, `decrypt`/view-tree expressions without
 * `allowFullScan`, or an aborted run.
 */
export class MindooQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MindooQueryError";
  }
}
