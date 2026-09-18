import type { MindooDBAppBooleanExpression, MindooDBAppExpression } from "../expressions/types";
import type { SummaryCoverage } from "../indexing/summary/types";
import type { VirtualViewUpdateOptions } from "../indexing/virtualviews/IVirtualViewDataProvider";
import type { MindooDB } from "../types";

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
 * Whether an include slot resolves to a single related row or a list of
 * them. Always explicit: a lookup that happens to match exactly one
 * document today must not silently change shape tomorrow, so `"one"`
 * with more than one match is an error rather than an implicit array.
 */
export type MindooQueryIncludeCardinality = "one" | "many";

/**
 * Default `limit` of a `"many"` include slot — the cap that keeps one
 * pathological parent (a customer with 50k invoices) from dominating a
 * result. Raise it per slot when you really want more.
 */
export const DEFAULT_INCLUDE_LIMIT = 200;

/**
 * Maximum include nesting, counting the query's own `include` as level 1
 * (so `invoice → customer → address` is level 2). A guard against
 * accidentally exponential join plans, not a fundamental limit.
 */
export const MAX_INCLUDE_DEPTH = 3;

/**
 * One nested lookup of a {@link MindooQuery} (see docs/adhoc-queries.md).
 *
 * Related documents are joined onto every paged result row under
 * `MindooQueryRow.includes[slot]`. The join runs as ONE additional
 * summary scan per slot, never a query per parent row.
 */
export interface MindooQueryInclude {
  /**
   * Database to look the related documents up in. Omit for the same
   * database as the parent query. This is a runtime handle, not an id —
   * the only part of a query object that is not plain JSON.
   */
  db?: MindooDB;
  /** Required: `"one"` yields a row or `null`, `"many"` yields an array. */
  cardinality: MindooQueryIncludeCardinality;
  /**
   * Shorthand join: match children whose `docId` equals this PARENT field
   * (or, when the parent value is an array, is contained in it). Sugar for
   * `filter: v.eq(v.field("docId"), v.parent(localKey))`; combined with an
   * explicit `filter` via logical AND.
   */
  localKey?: string;
  /**
   * Join condition, or its formula source text. Must contain exactly one
   * parent equality — `v.eq(v.field(childPath), v.parent(parentPath))`
   * in either operand order — optionally ANDed with conditions that do
   * not reference the parent (those are applied as plain child
   * predicates). Everything else is rejected: the equality is what lets
   * the engine answer the slot with a single indexed scan instead of a
   * nested loop over parents x children.
   */
  filter?: MindooDBAppBooleanExpression | string;
  /** Projection for the related rows; defaults to all summary fields. */
  fields?: string[];
  /** Ordering within one parent's list. `"many"` only; defaults to `docId`. */
  sortBy?: MindooQuerySortKey[];
  /** Max related rows per parent. `"many"` only; defaults to {@link DEFAULT_INCLUDE_LIMIT}. */
  limit?: number;
  /** Nested lookups on the related rows (see {@link MAX_INCLUDE_DEPTH}). */
  include?: Record<string, MindooQueryInclude>;
}

/**
 * An ad-hoc query over the document summary buffer (see
 * docs/adhoc-queries.md).
 *
 * The filter IS an expression of the MindooDB expression language — built
 * with `createViewLanguage()` — so query definitions are plain JSON and
 * travel safely across process boundaries.
 */
export interface MindooQuery {
  /**
   * Boolean expression, or the formula source text of one (e.g.
   * `'v.eq(v.field("type"), "invoice")'`), which `query()` parses for you —
   * the same convenience the app SDK offers, so a query object written for
   * one works with the other.
   */
  filter?: MindooDBAppBooleanExpression | string;
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
  /**
   * Nested lookups: related documents joined onto every returned row
   * under {@link MindooQueryRow.includes}, keyed by slot name. Slot names
   * are free-form — they live in their own object, so none of them can
   * collide with `docId` / `fields` / `lastModified`.
   *
   * Hydration happens AFTER `sortBy`/`limit`/`offset`, so only the rows
   * actually returned are joined; `total` stays the unpaged match count
   * of the root query.
   */
  include?: Record<string, MindooQueryInclude>;
}

/** A {@link MindooQueryInclude} whose formula-source filter has been parsed. */
export type ParsedMindooQueryInclude = Omit<MindooQueryInclude, "filter" | "include"> & {
  filter?: MindooDBAppBooleanExpression;
  include?: Record<string, ParsedMindooQueryInclude>;
};

/** A {@link MindooQuery} whose formula-source filters have been parsed. */
export type ParsedMindooQuery = Omit<MindooQuery, "filter" | "include"> & {
  filter?: MindooDBAppBooleanExpression;
  include?: Record<string, ParsedMindooQueryInclude>;
};

export interface MindooQueryOptions extends VirtualViewUpdateOptions {
  /**
   * Escape hatch: materialize every document via the changefeed instead of
   * querying the summary buffer. Removes the summary coverage requirement
   * and allows `decrypt` expressions, but costs a full document scan —
   * document as expensive, use only for one-off/administrative queries.
   */
  allowFullScan?: boolean;
}

/**
 * The related rows joined onto one result row, keyed by include slot
 * name: a row (or `null`) for `cardinality: "one"`, an array for
 * `"many"`.
 */
export type MindooQueryIncludeSlots = Record<string, MindooQueryRow | MindooQueryRow[] | null>;

export interface MindooQueryRow<TIncludes extends MindooQueryIncludeSlots = MindooQueryIncludeSlots> {
  docId: string;
  fields: Record<string, unknown>;
  lastModified: number;
  /**
   * Relevance score of the query's `text` clause (higher = better
   * match). Only present when the query had a `text` clause.
   */
  textScore?: number;
  /**
   * Related rows from the query's {@link MindooQuery.include} lookups.
   * Absent when the query had no `include`, so results of plain queries
   * keep exactly the shape they always had.
   *
   * Included rows are ordinary rows, so a nested lookup reads as
   * `row.includes.customer.includes.address` — the same rule at every
   * level. The slots live in their own object rather than next to
   * `docId`/`fields` so that no relation name can collide with the
   * protocol and this row's top level stays free for future engine data.
   *
   * The generic parameter is a convenience for callers who want precise
   * slot types (`db.query<{ lines: MindooQueryRow[] }>({…})`); it is not
   * inferred from the `include` object.
   */
  includes?: TIncludes;
}

/**
 * Which data answered the query: `"full"`/`"rebuilding"` from the summary
 * buffer (see {@link SummaryCoverage}), `"full-scan"` when documents were
 * materialized via `allowFullScan`.
 */
export type MindooQueryCoverage = SummaryCoverage | "full-scan";

export interface MindooQueryResult<TIncludes extends MindooQueryIncludeSlots = MindooQueryIncludeSlots> {
  rows: MindooQueryRow<TIncludes>[];
  /** Number of matching documents before `offset`/`limit` were applied. */
  total: number;
  /**
   * Which data answered the query. With `include` lookups this is the
   * MINIMUM over every involved summary — one child summary still
   * backfilling makes the whole result `"rebuilding"`.
   */
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
