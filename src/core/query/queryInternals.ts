import type { MindooDB } from "../types";
import { evaluateExpression, type ExpressionEvaluationContext } from "../expressions";
import { getSummaryFieldValue } from "../indexing/summary/extractSummaryFields";
import { compareValues } from "../indexing/virtualviews/types";
import type { MindooQueryCoverage, MindooQueryRow, MindooQuerySortKey, ParsedMindooQuery } from "./types";

/**
 * Pieces shared by the root query scan ({@link executeQuery}) and the
 * nested include hydration ({@link hydrateQueryIncludes}).
 *
 * They live here rather than in `executeQuery.ts` so both paths sort and
 * project through the SAME code: an included row must be built exactly
 * like a root row, otherwise projection or ordering semantics drift apart
 * between the two levels of the same result.
 */

/** A row plus its scan-internal bookkeeping, used while a scan is in progress. */
export type CandidateRow = MindooQueryRow & {
  sortValues: unknown[];
  /**
   * The document's UNPROJECTED values in evaluation form. Kept alongside
   * the (possibly projected) `fields` because include hydration reads
   * join keys from it — projecting the result must not break the join.
   */
  evaluationDoc: Record<string, unknown>;
};

/**
 * Effective sort keys of a query: an explicit `sortBy` wins; a `text`
 * clause without one defaults to relevance ranking (best score first).
 */
export function effectiveSortKeys(query: ParsedMindooQuery): MindooQuerySortKey[] {
  if (query.sortBy && query.sortBy.length > 0) {
    return query.sortBy;
  }
  if (query.text) {
    return [{ special: "textScore", direction: "descending" }];
  }
  return [];
}

export function sortDirectionDescending(sortKey: MindooQuerySortKey): boolean {
  return sortKey.direction === "descending";
}

export function computeSortValues(
  sortKeys: MindooQuerySortKey[],
  context: ExpressionEvaluationContext,
  textScore?: number
): unknown[] {
  return sortKeys.map((sortKey) => {
    if (sortKey.special === "textScore") {
      return textScore ?? 0;
    }
    if (sortKey.expression) {
      return evaluateExpression(sortKey.expression, context);
    }
    // Plain field sort keys resolve against the evaluation doc, which also
    // carries the mirrored managed fields (`_lastModified`, `_attachments`).
    return getSummaryFieldValue(context.doc, sortKey.field ?? "");
  });
}

/**
 * Orders two candidates by their precomputed sort values, falling back to
 * the document id so equal keys still produce a stable, reproducible
 * order.
 */
export function compareCandidates(
  left: CandidateRow,
  right: CandidateRow,
  sortKeys: MindooQuerySortKey[]
): number {
  for (let i = 0; i < sortKeys.length; i++) {
    const result = compareValues(left.sortValues[i], right.sortValues[i], sortDirectionDescending(sortKeys[i]));
    if (result !== 0) {
      return result;
    }
  }
  return left.docId.localeCompare(right.docId);
}

export function projectFields(
  fields: Record<string, unknown>,
  projection?: string[]
): Record<string, unknown> {
  if (!projection) {
    return fields;
  }
  const projected: Record<string, unknown> = {};
  for (const path of projection) {
    const value = getSummaryFieldValue(fields, path);
    if (value !== undefined) {
      projected[path] = value;
    }
  }
  return projected;
}

export function queryOrigin(db: MindooDB): string {
  return `${db.getTenant().getId()}/${db.getStore().getId()}`;
}

/**
 * Merges the coverage of several data sources into the one reported for
 * the result. Anything less than complete wins: a query joining a current
 * summary with one that is still backfilling may be missing rows, and
 * saying `"full"` there would be the most misleading answer available.
 */
export function mergeCoverage(
  current: MindooQueryCoverage,
  next: MindooQueryCoverage
): MindooQueryCoverage {
  if (current === "rebuilding" || next === "rebuilding") {
    return "rebuilding";
  }
  if (current === "full-scan" || next === "full-scan") {
    return "full-scan";
  }
  return "full";
}
