import type { MindooDBAppBooleanExpression, MindooDBAppExpression } from "../expressions/types";
import type { SummaryCoverage } from "../indexing/summary/types";
import type { VirtualViewUpdateOptions } from "../indexing/virtualviews/IVirtualViewDataProvider";

/**
 * One sort key of a {@link MindooQuery}. Either a plain summary field
 * path, a computed expression (evaluated per row before comparison), or a
 * special pseudo-key (`{ special: "textScore" }` sorts by the full-text
 * relevance score of the {@link MindooQuery.text} clause).
 */
export interface MindooQuerySortKey {
  field?: string;
  expression?: MindooDBAppExpression;
  /**
   * `"textScore"`: sort by the relevance score of the query's `text`
   * clause (only meaningful together with one). Direction defaults to the
   * regular `direction` field — note that for pure relevance ranking you
   * usually want `descending` (best match first), which is also the
   * implicit default ordering when a `text` clause is present and no
   * `sortBy` was given.
   */
  special?: "textScore";
  direction?: "ascending" | "descending";
}

/**
 * Full-text clause of a {@link MindooQuery}: matches documents through
 * the database's full-text index (see docs/fulltext-search.md) and makes
 * a relevance score available for sorting (`{ special: "textScore" }`).
 * Requires full-text indexing to be enabled for the database — otherwise
 * the query fails with `fulltext-not-enabled` (no silent full scan).
 */
export interface MindooQueryTextClause {
  /** The search string (tokenized like indexed content). */
  query: string;
  /**
   * Restrict matching to these index fields (document field paths, plus
   * the synthetic `_attachments` field). Default: all indexed fields.
   */
  fields?: string[];
  /** Match term prefixes (`"drag"` matches `"dragon"`). Default: `true`. */
  prefix?: boolean;
  /** Fuzzy matching tolerance (see `FulltextSearchOptions.fuzzy`). Default: `false`. */
  fuzzy?: boolean | number;
  /** How multiple terms combine: `"AND"` (default) or `"OR"`. */
  combineWith?: "AND" | "OR";
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
  /**
   * Full-text clause: additionally require documents to match this
   * full-text search (combined with `filter` as a logical AND). Adds a
   * relevance score per row (`MindooQueryRow.textScore`); without an
   * explicit `sortBy`, results are ordered best score first.
   */
  text?: MindooQueryTextClause;
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
  /**
   * Relevance score of the query's `text` clause (higher = better
   * match). Only present when the query had a `text` clause.
   */
  textScore?: number;
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
 * Machine-readable reason codes for {@link MindooQueryError}. Currently
 * only `"fulltext-not-enabled"` (a `text` clause on a database without an
 * enabled full-text index) is distinguished; other failures carry no code.
 */
export type MindooQueryErrorCode = "fulltext-not-enabled";

/**
 * Thrown for queries that cannot be answered: referenced fields outside the
 * summary coverage, `decrypt`/view-tree expressions without
 * `allowFullScan`, a `text` clause without an enabled full-text index,
 * or an aborted run.
 */
export class MindooQueryError extends Error {
  /** Machine-readable reason, when one is defined for the failure. */
  readonly code?: MindooQueryErrorCode;

  constructor(message: string, code?: MindooQueryErrorCode) {
    super(message);
    this.name = "MindooQueryError";
    this.code = code;
  }
}
