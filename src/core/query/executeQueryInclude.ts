import type { MindooDB } from "../types";
import type { MindooDBAppBooleanExpression, MindooDBAppExpression } from "../expressions/types";
import {
  analyzeExpressionRequirements,
  evaluateExpression,
  expressionToBoolean,
  findUnknownExpressionNode,
  formatMindooDBFormulaExpression,
  getReferencedFields,
  getReferencedParentFields,
  type ExpressionEvaluationContext,
} from "../expressions";
import type { DocumentSummaryStore } from "../indexing/summary/DocumentSummaryStore";
import { buildSummaryEvaluationDoc, getSummaryFieldValue } from "../indexing/summary/extractSummaryFields";
import {
  MindooQueryError,
  DEFAULT_INCLUDE_LIMIT,
  MAX_INCLUDE_DEPTH,
  type MindooQueryCoverage,
  type MindooQueryOptions,
  type MindooQueryRow,
  type MindooQuerySortKey,
  type ParsedMindooQueryInclude,
} from "./types";
import {
  compareCandidates,
  computeSortValues,
  mergeCoverage,
  projectFields,
  queryOrigin,
  type CandidateRow,
} from "./queryInternals";

/**
 * Nested lookups (`MindooQuery.include`): joining related documents onto
 * the rows a query returns.
 *
 * The one rule that shapes this whole module: a slot costs ONE additional
 * summary scan, never one query per parent row. Everything else — the
 * join-key requirement on include filters, hydrating only the paged rows,
 * grouping children by key before attaching — follows from it.
 */

/** One parent row an include slot is hydrated for. */
export interface IncludeParentBinding {
  /** The row the related documents are attached to (`row.includes[slot]`). */
  row: MindooQueryRow;
  /** The parent's document id. */
  docId: string;
  /**
   * The parent's UNPROJECTED evaluation doc. Join keys are read from here,
   * not from `row.fields`: a query projecting `fields: ["total"]` must
   * still be able to join on `customerId`.
   */
  doc: Record<string, unknown>;
}

/**
 * One side of a join equality. A document's id is metadata rather than a
 * summary field, so the two cases are read from different places and are
 * kept apart here instead of being folded into a magic path string.
 */
export type JoinKeySide =
  | { kind: "docId" }
  | { kind: "field"; path: string };

/** The equality an include filter was reduced to, plus what was left over. */
export interface JoinKeyPlan {
  /** What the join reads on the related document. */
  child: JoinKeySide;
  /** What the join reads on the parent row. */
  parent: JoinKeySide;
  /**
   * The conjuncts that do not reference the parent. They are applied as
   * an ordinary predicate while scanning the children, so they cost
   * nothing extra.
   */
  residualFilter: MindooDBAppBooleanExpression | null;
}

export type JoinKeyExtraction =
  | { ok: true; plan: JoinKeyPlan }
  | { ok: false; reason: string };

/** Splits nested `and` nodes into a flat list of conjuncts. */
function flattenConjuncts(expression: MindooDBAppExpression): MindooDBAppExpression[] {
  if (expression.kind === "operation" && expression.op === "and") {
    return expression.args.flatMap((arg) => flattenConjuncts(arg));
  }
  return [expression];
}

function combineConjuncts(conjuncts: MindooDBAppExpression[]): MindooDBAppBooleanExpression | null {
  if (conjuncts.length === 0) {
    return null;
  }
  if (conjuncts.length === 1) {
    return conjuncts[0] as MindooDBAppBooleanExpression;
  }
  return { kind: "operation", op: "and", args: conjuncts } as MindooDBAppBooleanExpression;
}

function referencesParent(expression: MindooDBAppExpression): boolean {
  return analyzeExpressionRequirements(expression).needsParentContext;
}

/**
 * Reduces an include filter to the one join equality the planner can
 * execute, plus the parent-free rest.
 *
 * Accepted: exactly one equality between a child term (`field(X)` or
 * `docId()`) and a parent term (`parent(Y)` or `parentDocId()`), in
 * either operand order, optionally ANDed with conditions that do not
 * mention the parent.
 * Rejected: everything else that references the parent — a range
 * comparison against a parent value, an `or` spanning parent terms, a
 * second parent equality. Those would each require evaluating the filter
 * once per (parent, child) pair, which turns a linear scan into a nested
 * loop; a slot over 200 paged parents and 10k children would be ~2M
 * evaluations. Rejecting them keeps the cost model of `query()` intact
 * and the failure obvious instead of silently slow.
 */
export function extractJoinKey(filter: MindooDBAppBooleanExpression): JoinKeyExtraction {
  const conjuncts = flattenConjuncts(filter);
  const parentConjuncts = conjuncts.filter((conjunct) => referencesParent(conjunct));
  const parentFree = conjuncts.filter((conjunct) => !referencesParent(conjunct));

  if (parentConjuncts.length === 0) {
    return {
      ok: false,
      reason:
        "it does not reference the parent document. Add the join condition " +
        'v.eq(v.field("<child field>"), v.parentDocId()) (or use localKey)',
    };
  }
  if (parentConjuncts.length > 1) {
    return {
      ok: false,
      reason:
        `it references the parent document in ${parentConjuncts.length} separate conditions. ` +
        "Exactly one parent equality can be used as the join key",
    };
  }

  const join = parentConjuncts[0]!;
  if (join.kind !== "operation" || join.op !== "eq" || join.args.length !== 2) {
    return {
      ok: false,
      reason:
        `the condition referencing the parent is not an equality: ${formatMindooDBFormulaExpression(join)}. ` +
        'Only v.eq(v.field("<child field>"), v.parentDocId()) and friends can be used as the join key',
    };
  }

  const [left, right] = join.args as [MindooDBAppExpression, MindooDBAppExpression];
  const plan =
    joinSides(left, right) ??
    joinSides(right, left) ??
    null;
  if (!plan) {
    return {
      ok: false,
      reason:
        `the join equality compares ${formatMindooDBFormulaExpression(join)}. ` +
        "One side must read the related document (v.field(...) or v.docId()), " +
        "the other the parent (v.parent(...) or v.parentDocId())",
    };
  }

  return {
    ok: true,
    plan: { ...plan, residualFilter: combineConjuncts(parentFree) },
  };
}

/** Reads an expression as the child side of a join equality. */
function childJoinSide(expression: MindooDBAppExpression): JoinKeySide | null {
  if (expression.kind === "field") {
    return { kind: "field", path: expression.path };
  }
  if (expression.kind === "operation" && expression.op === "docId") {
    return { kind: "docId" };
  }
  return null;
}

/** Reads an expression as the parent side of a join equality. */
function parentJoinSide(expression: MindooDBAppExpression): JoinKeySide | null {
  if (expression.kind === "parent") {
    return { kind: "field", path: expression.path };
  }
  if (expression.kind === "operation" && expression.op === "parentDocId") {
    return { kind: "docId" };
  }
  return null;
}

/** Pairs the two operands of an equality in the given order, if they fit. */
function joinSides(
  childCandidate: MindooDBAppExpression,
  parentCandidate: MindooDBAppExpression
): Pick<JoinKeyPlan, "child" | "parent"> | null {
  const child = childJoinSide(childCandidate);
  const parent = parentJoinSide(parentCandidate);
  return child && parent ? { child, parent } : null;
}

/** Builds the join plan of a slot from `localKey` and/or `filter`. */
function planInclude(slot: string, include: ParsedMindooQueryInclude): JoinKeyPlan {
  if (include.localKey !== undefined) {
    // `localKey` already IS the join key, so an additional filter must not
    // introduce a second one — it can only narrow the children further.
    if (include.filter && referencesParent(include.filter)) {
      throw new MindooQueryError(
        `Include "${slot}" combines localKey with a filter that also references the parent document. ` +
        "Use either localKey or a parent join condition, not both."
      );
    }
    return {
      child: { kind: "docId" },
      parent: { kind: "field", path: include.localKey },
      residualFilter: include.filter ?? null,
    };
  }

  const extraction = extractJoinKey(include.filter!);
  if (!extraction.ok) {
    throw new MindooQueryError(`Include "${slot}" cannot be joined because ${extraction.reason}.`);
  }
  return extraction.plan;
}

/**
 * Structural validation of the include tree, run before any scanning so a
 * malformed query fails immediately rather than after the root scan.
 */
export function validateQueryIncludes(
  includes: Record<string, ParsedMindooQueryInclude>,
  depth = 1,
  slotPath = ""
): void {
  for (const [slot, include] of Object.entries(includes)) {
    const label = slotPath ? `${slotPath}.${slot}` : slot;

    if (slot.trim() === "") {
      throw new MindooQueryError("Include slot names must not be empty.");
    }
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new MindooQueryError(
        `Include "${label}" nests ${depth} levels deep, more than the maximum of ${MAX_INCLUDE_DEPTH}.`
      );
    }
    if (include.cardinality !== "one" && include.cardinality !== "many") {
      throw new MindooQueryError(
        `Include "${label}" needs an explicit cardinality of "one" or "many" ` +
        `(got ${JSON.stringify(include.cardinality)}).`
      );
    }
    if (include.localKey === undefined && include.filter === undefined) {
      throw new MindooQueryError(
        `Include "${label}" needs a localKey or a filter to relate documents to the parent row.`
      );
    }
    if (include.localKey !== undefined && include.localKey.trim() === "") {
      throw new MindooQueryError(`Include "${label}" has an empty localKey.`);
    }
    if (include.cardinality === "one") {
      if (include.sortBy !== undefined) {
        throw new MindooQueryError(
          `Include "${label}" has cardinality "one", which resolves to a single row — sortBy is meaningless there.`
        );
      }
      if (include.limit !== undefined) {
        throw new MindooQueryError(
          `Include "${label}" has cardinality "one", which resolves to a single row — limit is meaningless there.`
        );
      }
    }
    if (include.limit !== undefined && (!Number.isFinite(include.limit) || include.limit < 0)) {
      throw new MindooQueryError(`Include "${label}" has an invalid limit (${include.limit}).`);
    }
    if (include.db && !include.db.getSummaryStore) {
      throw new MindooQueryError(
        `Include "${label}" points at a MindooDB instance without a summary buffer, which cannot answer queries.`
      );
    }

    for (const sortKey of include.sortBy ?? []) {
      if (sortKey.special === "textScore") {
        throw new MindooQueryError(
          `Include "${label}" sorts by textScore, but includes have no text clause to score against.`
        );
      }
      if (sortKey.expression && referencesParent(sortKey.expression)) {
        throw new MindooQueryError(
          `Include "${label}" sorts by an expression referencing the parent document. ` +
          "Sorting applies to the related documents only."
        );
      }
    }

    if (include.filter) {
      validateIncludeFilter(label, include.filter);
    }

    if (include.include) {
      validateQueryIncludes(include.include, depth + 1, label);
    }
  }
}

function validateIncludeFilter(label: string, filter: MindooDBAppBooleanExpression): void {
  const unknown = findUnknownExpressionNode(filter);
  if (unknown !== null) {
    throw new MindooQueryError(
      `Include "${label}" has a filter containing ${unknown}, which the expression language does not define. ` +
      "Build expressions with createViewLanguage() (or pass the filter as formula source text)."
    );
  }
  const requirements = analyzeExpressionRequirements(filter);
  if (requirements.needsViewContext) {
    throw new MindooQueryError(
      `Include "${label}" has a filter using view-tree operations ` +
      `(${requirements.viewContextOperations.join(", ")}); these only evaluate inside a materialized view.`
    );
  }
  if (requirements.needsDecryption) {
    throw new MindooQueryError(
      `Include "${label}" has a filter referencing encrypted fields (decrypt), ` +
      "which the summary buffer does not store."
    );
  }
}

/** Reads the join value of a parent row for the planned parent side. */
function readParentJoinValue(parent: IncludeParentBinding, side: JoinKeySide): unknown {
  return side.kind === "docId" ? parent.docId : getSummaryFieldValue(parent.doc, side.path);
}

/** Reads the join value of a candidate child for the planned child side. */
function readChildJoinValue(
  docId: string,
  evaluationDoc: Record<string, unknown>,
  side: JoinKeySide
): unknown {
  return side.kind === "docId" ? docId : getSummaryFieldValue(evaluationDoc, side.path);
}

/**
 * A join value may be a list (`memberIds: ["u_1", "u_2"]`), in which case
 * every element joins independently — that is what makes `localKey` work
 * for "this document references several others".
 */
function joinValuesOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined && item !== null);
  }
  return [value];
}

function assertNotAborted(options: MindooQueryOptions | undefined, slot: string): void {
  if (options?.signal?.aborted) {
    throw new MindooQueryError(`Query aborted while resolving include "${slot}".`);
  }
}

function resolveIncludeSummary(db: MindooDB, label: string): DocumentSummaryStore {
  if (!db.getSummaryStore) {
    throw new MindooQueryError(
      `Include "${label}" points at a MindooDB instance without a summary buffer, which cannot answer queries.`
    );
  }
  return db.getSummaryStore();
}

/** Verifies that both sides of the join are answerable from their summaries. */
function checkIncludeCoverage(
  label: string,
  plan: JoinKeyPlan,
  include: ParsedMindooQueryInclude,
  childSummary: DocumentSummaryStore,
  parentSummary: DocumentSummaryStore
): void {
  const childPaths = new Set<string>();
  if (plan.child.kind === "field") {
    childPaths.add(plan.child.path);
  }
  if (plan.residualFilter) {
    for (const path of getReferencedFields(plan.residualFilter)) {
      childPaths.add(path);
    }
  }
  for (const sortKey of include.sortBy ?? []) {
    if (sortKey.expression) {
      for (const path of getReferencedFields(sortKey.expression)) {
        childPaths.add(path);
      }
    } else if (sortKey.field) {
      childPaths.add(sortKey.field);
    }
  }
  for (const path of childPaths) {
    if (!childSummary.isFieldCovered(path)) {
      throw new MindooQueryError(
        `Include "${label}" references field "${path}", which is not covered by the summary configuration ` +
        "of the database it looks up (check include/exclude in SummaryConfig)."
      );
    }
  }

  // Parent-side paths are checked against the PARENT summary: that is the
  // buffer the join value is actually read from.
  const parentPaths = new Set<string>();
  if (plan.parent.kind === "field") {
    parentPaths.add(plan.parent.path);
  }
  if (include.filter) {
    for (const path of getReferencedParentFields(include.filter)) {
      parentPaths.add(path);
    }
  }
  for (const path of parentPaths) {
    if (!parentSummary.isFieldCovered(path)) {
      throw new MindooQueryError(
        `Include "${label}" reads parent field "${path}", which is not covered by the summary configuration ` +
        "of the parent database (check include/exclude in SummaryConfig)."
      );
    }
  }
}

/** One related document that survived the scan, ready to be attached. */
interface ChildCandidate extends CandidateRow {
  /** Parent join values this child matched (a child can match several). */
  keys: unknown[];
}

function includeSortKeys(include: ParsedMindooQueryInclude): MindooQuerySortKey[] {
  return include.sortBy ?? [];
}

/**
 * Hydrates one level of include slots onto already-paged parent rows.
 *
 * Per slot: bring the target summary up to date, scan it once, keep the
 * children whose join value hits one of the parents' keys, group them,
 * and attach. Nested slots recurse on the attached rows, which are by
 * then themselves a set of paged parents.
 *
 * @returns the merged coverage of every summary this level touched.
 */
export async function hydrateQueryIncludes(params: {
  parentDb: MindooDB;
  parentSummary: DocumentSummaryStore;
  includes: Record<string, ParsedMindooQueryInclude>;
  parents: IncludeParentBinding[];
  depth: number;
  options?: MindooQueryOptions;
  slotPath?: string;
}): Promise<MindooQueryCoverage> {
  const { parentDb, parentSummary, includes, parents, depth, options, slotPath = "" } = params;
  let coverage: MindooQueryCoverage = "full";

  for (const [slot, include] of Object.entries(includes)) {
    const label = slotPath ? `${slotPath}.${slot}` : slot;
    const plan = planInclude(label, include);

    const childDb = include.db ?? parentDb;
    const childSummary = resolveIncludeSummary(childDb, label);
    checkIncludeCoverage(label, plan, include, childSummary, parentSummary);

    // Empty parent page: no keys to look up, but the slot must still exist
    // on every (zero) row — and nested levels have nothing to do either.
    if (parents.length === 0) {
      continue;
    }

    await childSummary.update(options);
    assertNotAborted(options, label);
    coverage = mergeCoverage(coverage, childSummary.getCoverage());

    // Unique join keys of the current page. A Map keyed by the raw value
    // matches the strict equality semantics of v.eq (1 and "1" differ).
    const parentsByKey = new Map<unknown, IncludeParentBinding[]>();
    for (const parent of parents) {
      for (const key of joinValuesOf(readParentJoinValue(parent, plan.parent))) {
        const bucket = parentsByKey.get(key);
        if (bucket) {
          bucket.push(parent);
        } else {
          parentsByKey.set(key, [parent]);
        }
      }
    }

    const childrenByKey = new Map<unknown, ChildCandidate[]>();
    if (parentsByKey.size > 0) {
      const origin = queryOrigin(childDb);
      const sortKeys = includeSortKeys(include);

      for (const entry of childSummary.getAllEntries()) {
        const evaluationDoc = buildSummaryEvaluationDoc(entry.fields, entry.lastModified);
        const matchedKeys = joinValuesOf(
          readChildJoinValue(entry.docId, evaluationDoc, plan.child)
        ).filter((key) => parentsByKey.has(key));
        if (matchedKeys.length === 0) {
          continue;
        }

        const context: ExpressionEvaluationContext = {
          doc: evaluationDoc,
          values: {},
          origin,
          docId: entry.docId,
          lastModifiedAt: new Date(entry.lastModified).toISOString(),
          decryptionKeyId: entry.decryptionKeyId,
          variables: {},
        };
        if (plan.residualFilter && !expressionToBoolean(evaluateExpression(plan.residualFilter, context))) {
          continue;
        }

        const candidate: ChildCandidate = {
          docId: entry.docId,
          fields: projectFields(evaluationDoc, include.fields),
          lastModified: entry.lastModified,
          sortValues: computeSortValues(sortKeys, context),
          evaluationDoc,
          keys: matchedKeys,
        };
        for (const key of matchedKeys) {
          const bucket = childrenByKey.get(key);
          if (bucket) {
            bucket.push(candidate);
          } else {
            childrenByKey.set(key, [candidate]);
          }
        }
      }
    }

    const childParents = attachIncludeSlot(slot, label, include, plan, parents, childrenByKey);

    if (include.include && childParents.length > 0) {
      const nestedCoverage = await hydrateQueryIncludes({
        parentDb: childDb,
        parentSummary: childSummary,
        includes: include.include,
        parents: childParents,
        depth: depth + 1,
        options,
        slotPath: label,
      });
      coverage = mergeCoverage(coverage, nestedCoverage);
    }
  }

  return coverage;
}

/**
 * Writes the grouped children into `row.includes[slot]` and returns the
 * attached rows as parent bindings for the next nesting level.
 *
 * Every attachment gets its OWN row object even when two parents matched
 * the same document: nested hydration writes into these rows, and sharing
 * one object would make a nested slot of one parent visible on another.
 */
function attachIncludeSlot(
  slot: string,
  label: string,
  include: ParsedMindooQueryInclude,
  plan: JoinKeyPlan,
  parents: IncludeParentBinding[],
  childrenByKey: Map<unknown, ChildCandidate[]>
): IncludeParentBinding[] {
  const sortKeys = includeSortKeys(include);
  const limit = include.limit ?? DEFAULT_INCLUDE_LIMIT;
  const nextParents: IncludeParentBinding[] = [];

  for (const parent of parents) {
    const seen = new Set<string>();
    const matches: ChildCandidate[] = [];
    for (const key of joinValuesOf(readParentJoinValue(parent, plan.parent))) {
      for (const candidate of childrenByKey.get(key) ?? []) {
        // A parent whose join value is an array can reach the same child
        // through two entries; it is still one related document.
        if (seen.has(candidate.docId)) {
          continue;
        }
        seen.add(candidate.docId);
        matches.push(candidate);
      }
    }

    const slots = (parent.row.includes ??= {});

    if (include.cardinality === "one") {
      if (matches.length > 1) {
        const sample = matches.slice(0, 3).map((match) => match.docId).join(", ");
        throw new MindooQueryError(
          `Include "${label}" has cardinality "one", but document "${parent.docId}" matched ` +
          `${matches.length} related documents (${sample}${matches.length > 3 ? ", …" : ""}). ` +
          'Use cardinality "many" if several matches are expected.'
        );
      }
      if (matches.length === 0) {
        slots[slot] = null;
        continue;
      }
      const row = toIncludedRow(matches[0]!);
      slots[slot] = row;
      nextParents.push({ row, docId: matches[0]!.docId, doc: matches[0]!.evaluationDoc });
      continue;
    }

    matches.sort((left, right) => compareCandidates(left, right, sortKeys));
    const rows: MindooQueryRow[] = [];
    for (const candidate of matches.slice(0, limit)) {
      const row = toIncludedRow(candidate);
      rows.push(row);
      nextParents.push({ row, docId: candidate.docId, doc: candidate.evaluationDoc });
    }
    slots[slot] = rows;
  }

  return nextParents;
}

/** Strips the scan-internal bookkeeping off a candidate. */
function toIncludedRow(candidate: ChildCandidate): MindooQueryRow {
  return {
    docId: candidate.docId,
    fields: candidate.fields,
    lastModified: candidate.lastModified,
  };
}
