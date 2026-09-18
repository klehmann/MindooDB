import type { MindooDB, MindooDoc } from "../types";
import type { MindooDBAppExpression } from "../expressions/types";
import {
  analyzeExpressionRequirements,
  collectDecryptRequests,
  evaluateExpression,
  expressionToBoolean,
  findUnknownExpressionNode,
  getReferencedFields,
  parseMindooDBFormulaBooleanExpression,
  type DecryptRequest,
  type ExpressionEvaluationContext,
} from "../expressions";
import { decryptEncryptedField } from "../crypto/encryptedFields";
import type { DocumentSummaryStore } from "../indexing/summary/DocumentSummaryStore";
import { buildSummaryEvaluationDoc } from "../indexing/summary/extractSummaryFields";
import type { DocumentFullTextIndex } from "../indexing/fulltext/DocumentFullTextIndex";
import {
  MindooQueryError,
  type MindooQuery,
  type MindooQueryInclude,
  type ParsedMindooQuery,
  type ParsedMindooQueryInclude,
  type MindooQueryOptions,
  type MindooQueryResult,
  type MindooQueryRow,
  type MindooQuerySortKey,
} from "./types";
import {
  compareCandidates,
  computeSortValues,
  effectiveSortKeys,
  mergeCoverage,
  projectFields,
  queryOrigin,
  type CandidateRow,
} from "./queryInternals";
import {
  hydrateQueryIncludes,
  validateQueryIncludes,
  type IncludeParentBinding,
} from "./executeQueryInclude";

/**
 * Resolve and prepare the full-text index for a query with a `text`
 * clause: brings the index up to date, verifies indexing is enabled, and
 * returns the docId→score map of the matching documents. Queries on
 * databases without an enabled full-text index fail with
 * `fulltext-not-enabled` — there is deliberately no silent fallback scan
 * over document bodies.
 */
async function resolveTextClauseScores(
  db: MindooDB,
  query: ParsedMindooQuery,
  options?: MindooQueryOptions
): Promise<{ scores: Map<string, number>; index: DocumentFullTextIndex } | null> {
  const text = query.text;
  if (!text) {
    return null;
  }
  if (!db.getFullTextIndex) {
    throw new MindooQueryError(
      `This MindooDB instance does not support full-text search.`,
      "fulltext-not-enabled"
    );
  }
  const index = db.getFullTextIndex();
  await index.update(options);
  if (!index.isEnabled()) {
    throw new MindooQueryError(
      `Query has a text clause, but full-text indexing is not enabled for this database ` +
      `(enable it via setFulltextSetup({ enabled: true }), see docs/fulltext-search.md).`,
      "fulltext-not-enabled"
    );
  }
  const { hits } = index.searchSync(text.query, {
    fields: text.fields,
    prefix: text.prefix,
    fuzzy: text.fuzzy,
    combineWith: text.combineWith,
  });
  const scores = new Map<string, number>();
  for (const hit of hits) {
    scores.set(hit.docId, hit.score);
  }
  return { scores, index };
}

/**
 * Turn a caller's query into one the evaluator can run: formula source text
 * becomes an expression, and anything that is neither is rejected here.
 *
 * Both matter for the same reason. The evaluator returns `undefined` for a
 * node it does not recognize, and `undefined` as a filter means "no match" —
 * so a filter handed over as source text, or built by hand with a typo,
 * used to come back as an empty result set with `coverage: "full"`, which
 * reads exactly like a correct query over data that isn't there.
 */
function parseQuery(query: MindooQuery): ParsedMindooQuery {
  return {
    ...query,
    filter: parseFilter(query.filter, "Query filter"),
    include: query.include ? parseIncludes(query.include, "") : undefined,
  } as ParsedMindooQuery;
}

function parseFilter(
  filter: MindooQuery["filter"],
  label: string
): ParsedMindooQuery["filter"] {
  if (typeof filter !== "string") {
    return filter;
  }
  try {
    return parseMindooDBFormulaBooleanExpression(filter);
  } catch (error) {
    throw new MindooQueryError(
      `${label} is not valid formula source: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Formula-source filters are supported at every include level, not just the root. */
function parseIncludes(
  includes: Record<string, MindooQueryInclude>,
  slotPath: string
): Record<string, ParsedMindooQueryInclude> {
  const parsed: Record<string, ParsedMindooQueryInclude> = {};
  for (const [slot, include] of Object.entries(includes)) {
    const label = slotPath ? `${slotPath}.${slot}` : slot;
    parsed[slot] = {
      ...include,
      filter: parseFilter(include.filter, `Filter of include "${label}"`),
      include: include.include ? parseIncludes(include.include, label) : undefined,
    };
  }
  return parsed;
}

/** All expressions a query references (filter + expression sort keys). */
function collectQueryExpressions(query: ParsedMindooQuery): MindooDBAppExpression[] {
  const expressions: MindooDBAppExpression[] = [];
  if (query.filter) {
    expressions.push(query.filter);
  }
  for (const sortKey of query.sortBy ?? []) {
    if (sortKey.expression) {
      expressions.push(sortKey.expression);
    }
  }
  return expressions;
}

/**
 * Guardrails shared by both execution paths: view-tree operations are never
 * answerable outside a materialized view, `decrypt` only with a full scan.
 */
function validateQueryExpressions(expressions: MindooDBAppExpression[], allowFullScan: boolean): void {
  for (const expression of expressions) {
    const unknown = findUnknownExpressionNode(expression);
    if (unknown !== null) {
      throw new MindooQueryError(
        `Query expression contains ${unknown}, which the expression language does not define. ` +
        `Build expressions with createViewLanguage() (or pass the filter as formula source text).`
      );
    }
    const requirements = analyzeExpressionRequirements(expression);
    if (requirements.needsViewContext) {
      throw new MindooQueryError(
        `Query expressions cannot use view-tree operations (${requirements.viewContextOperations.join(", ")}); ` +
        `these only evaluate inside a materialized view (use db.queryView() with categories instead).`
      );
    }
    if (requirements.needsDecryption && !allowFullScan) {
      throw new MindooQueryError(
        `Query expressions reference encrypted fields (decrypt), which the summary buffer does not store. ` +
        `Re-run with allowFullScan: true to evaluate them against materialized documents (expensive).`
      );
    }
    if (requirements.needsParentContext) {
      throw new MindooQueryError(
        `Query expressions cannot use v.parent(); there is no parent document at the top level of a query. ` +
        `It only resolves inside the filter of an include lookup.`
      );
    }
  }
}

/**
 * Sorts, pages, and turns candidates into result rows. The paged
 * candidates are returned alongside so include hydration can reach their
 * unprojected values without scanning again.
 */
function sortAndPage(
  candidates: CandidateRow[],
  query: ParsedMindooQuery,
  sortKeys: MindooQuerySortKey[]
): { rows: MindooQueryRow[]; total: number; paged: CandidateRow[] } {
  if (sortKeys.length > 0) {
    candidates.sort((left, right) => compareCandidates(left, right, sortKeys));
  }

  const total = candidates.length;
  const offset = Math.max(0, query.offset ?? 0);
  const limit = query.limit;
  const paged = limit === undefined
    ? candidates.slice(offset)
    : candidates.slice(offset, offset + Math.max(0, limit));

  return {
    rows: paged.map(({ docId, fields, lastModified, textScore }) =>
      textScore === undefined
        ? { docId, fields, lastModified }
        : { docId, fields, lastModified, textScore }
    ),
    total,
    paged,
  };
}

/**
 * Execute an ad-hoc query against the document summary buffer.
 *
 * Ensures the summary is up to date (passing through progress/cancellation
 * options), verifies that every referenced field is covered by the summary
 * configuration, then filters/sorts/pages the in-memory summary entries.
 * Documents are never materialized on this path.
 *
 * A `text` clause additionally restricts matches through the full-text
 * index (which is brought up to date first) and provides the relevance
 * score for `{ special: "textScore" }` sorting — the default ordering
 * when a `text` clause is present without an explicit `sortBy`.
 */
export async function executeQuery(
  db: MindooDB,
  summary: DocumentSummaryStore,
  input: MindooQuery,
  options?: MindooQueryOptions
): Promise<MindooQueryResult> {
  const query = parseQuery(input);
  const expressions = collectQueryExpressions(query);

  if (options?.allowFullScan) {
    if (query.include) {
      throw new MindooQueryError(
        `Queries cannot combine allowFullScan with include lookups: includes are answered from the ` +
        `summary buffer of every involved database, which is exactly what allowFullScan bypasses.`
      );
    }
    validateQueryExpressions(expressions, true);
    return executeFullScanQuery(db, query, expressions, options);
  }

  validateQueryExpressions(expressions, false);
  if (query.include) {
    validateQueryIncludes(query.include);
  }

  // Coverage check: every field referenced by filter/sort expressions and
  // plain-field sort keys must be answerable from the summary.
  const referencedPaths = new Set<string>();
  for (const expression of expressions) {
    for (const path of getReferencedFields(expression)) {
      referencedPaths.add(path);
    }
  }
  for (const sortKey of query.sortBy ?? []) {
    if (!sortKey.expression && sortKey.field) {
      referencedPaths.add(sortKey.field);
    }
  }
  for (const path of referencedPaths) {
    if (!summary.isFieldCovered(path)) {
      throw new MindooQueryError(
        `Field "${path}" is not covered by the summary configuration ` +
        `(check include/exclude in SummaryConfig, or re-run with allowFullScan: true).`
      );
    }
  }

  const textMatch = await resolveTextClauseScores(db, query, options);
  if (options?.signal?.aborted) {
    throw new MindooQueryError("Query aborted while updating the full-text index.");
  }

  await summary.update(options);
  if (options?.signal?.aborted) {
    throw new MindooQueryError("Query aborted while updating the summary buffer.");
  }

  const origin = queryOrigin(db);
  const sortKeys = effectiveSortKeys(query);
  const candidates: CandidateRow[] = [];

  for (const entry of summary.getAllEntries()) {
    let textScore: number | undefined;
    if (textMatch) {
      textScore = textMatch.scores.get(entry.docId);
      if (textScore === undefined) {
        continue;
      }
    }

    const evaluationDoc = buildSummaryEvaluationDoc(entry.fields, entry.lastModified);
    const context: ExpressionEvaluationContext = {
      doc: evaluationDoc,
      values: {},
      origin,
      docId: entry.docId,
      lastModifiedAt: new Date(entry.lastModified).toISOString(),
      decryptionKeyId: entry.decryptionKeyId,
      variables: {},
    };

    if (query.filter && !expressionToBoolean(evaluateExpression(query.filter, context))) {
      continue;
    }

    candidates.push({
      docId: entry.docId,
      fields: projectFields(evaluationDoc, query.fields),
      lastModified: entry.lastModified,
      textScore,
      sortValues: computeSortValues(sortKeys, context, textScore),
      evaluationDoc,
    });
  }

  const { rows, total, paged } = sortAndPage(candidates, query, sortKeys);
  // Coverage is the minimum of the summary and full-text coverage: while
  // either side is still backfilling, results may be incomplete.
  let coverage: MindooQueryResult["coverage"] =
    textMatch && textMatch.index.getCoverage() === "rebuilding"
      ? "rebuilding"
      : summary.getCoverage();

  // Includes are hydrated AFTER paging: only the rows actually returned
  // get related documents, so a `limit: 20` page costs 20 rows' worth of
  // joins regardless of how many documents matched.
  if (query.include) {
    const parents: IncludeParentBinding[] = rows.map((row, index) => ({
      row,
      docId: row.docId,
      doc: paged[index]!.evaluationDoc,
    }));
    const includeCoverage = await hydrateQueryIncludes({
      parentDb: db,
      parentSummary: summary,
      includes: query.include,
      parents,
      depth: 1,
      options,
    });
    coverage = mergeCoverage(coverage, includeCoverage);
  }

  return { rows, total, coverage };
}

/** Resolve the plaintext for every `decrypt` node before evaluating a document. */
async function resolveDecryptedFields(
  db: MindooDB,
  requests: DecryptRequest[],
  data: Record<string, unknown>,
  context: ExpressionEvaluationContext
): Promise<Record<string, unknown> | undefined> {
  if (requests.length === 0) {
    return undefined;
  }
  const decrypted: Record<string, unknown> = {};
  for (const request of requests) {
    if (request.field in decrypted) {
      continue;
    }
    const keyOverride = request.key
      ? String(evaluateExpression(request.key, context) ?? "") || null
      : null;
    decrypted[request.field] = await decryptEncryptedField(
      db.getTenant(),
      data,
      request.field,
      keyOverride
    );
  }
  return decrypted;
}

/**
 * The `allowFullScan` path: materialize every document via the changefeed
 * and evaluate expressions against the full document payload (including
 * `decrypt` nodes, resolved against the tenant key bag). Expensive by
 * design — the summary path is the default for a reason.
 */
async function executeFullScanQuery(
  db: MindooDB,
  query: ParsedMindooQuery,
  expressions: MindooDBAppExpression[],
  options?: MindooQueryOptions
): Promise<MindooQueryResult> {
  // The text clause is answered by the full-text index even on the
  // full-scan path — scanning document bodies cannot compute relevance
  // scores, and the index requirement stays consistent between paths.
  const textMatch = await resolveTextClauseScores(db, query, options);

  const origin = queryOrigin(db);
  const sortKeys = effectiveSortKeys(query);
  const decryptRequests: DecryptRequest[] = [];
  for (const expression of expressions) {
    decryptRequests.push(...collectDecryptRequests(expression));
  }

  const onProgress = options?.onProgress;
  const signal = options?.signal;
  const total = onProgress ? (db.countChangesSince?.(null) ?? 0) : 0;
  let processed = 0;

  const candidates: CandidateRow[] = [];

  for await (const { doc } of db.iterateChangesSince(null)) {
    processed++;
    if (signal?.aborted) {
      throw new MindooQueryError("Query aborted during full scan.");
    }
    if (onProgress && onProgress({ processed, total, origin }) === false) {
      throw new MindooQueryError("Query cancelled by progress callback during full scan.");
    }
    if (doc.isDeleted()) {
      continue;
    }

    const mindooDoc = doc as MindooDoc;

    let textScore: number | undefined;
    if (textMatch) {
      textScore = textMatch.scores.get(mindooDoc.getId());
      if (textScore === undefined) {
        continue;
      }
    }

    const data = mindooDoc.getData() as Record<string, unknown>;
    const baseContext: ExpressionEvaluationContext = {
      doc: data,
      values: {},
      origin,
      docId: mindooDoc.getId(),
      createdAt: new Date(mindooDoc.getCreatedAt()).toISOString(),
      lastModifiedAt: new Date(mindooDoc.getLastModified()).toISOString(),
      decryptionKeyId: mindooDoc.getDecryptionKeyId(),
      witnessed: mindooDoc.isWitnessed(),
      awaitingWitness: mindooDoc.isAwaitingWitness(),
      variables: {},
    };
    const decrypted = await resolveDecryptedFields(db, decryptRequests, data, baseContext);
    const context: ExpressionEvaluationContext = { ...baseContext, decrypted };

    if (query.filter && !expressionToBoolean(evaluateExpression(query.filter, context))) {
      continue;
    }

    candidates.push({
      docId: mindooDoc.getId(),
      fields: projectFields(data, query.fields),
      lastModified: mindooDoc.getLastModified(),
      textScore,
      sortValues: computeSortValues(sortKeys, context, textScore),
      evaluationDoc: data,
    });
  }

  const { rows, total: matchTotal } = sortAndPage(candidates, query, sortKeys);
  return { rows, total: matchTotal, coverage: "full-scan" };
}
