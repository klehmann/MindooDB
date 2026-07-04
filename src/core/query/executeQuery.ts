import type { MindooDB, MindooDoc } from "../types";
import type { MindooDBAppExpression } from "../expressions/types";
import {
  analyzeExpressionRequirements,
  collectDecryptRequests,
  evaluateExpression,
  expressionToBoolean,
  getReferencedFields,
  type DecryptRequest,
  type ExpressionEvaluationContext,
} from "../expressions";
import { decryptEncryptedField } from "../crypto/encryptedFields";
import type { DocumentSummaryStore } from "../indexing/summary/DocumentSummaryStore";
import { buildSummaryEvaluationDoc, getSummaryFieldValue } from "../indexing/summary/extractSummaryFields";
import { compareValues } from "../indexing/virtualviews/types";
import {
  MindooQueryError,
  type MindooQuery,
  type MindooQueryOptions,
  type MindooQueryResult,
  type MindooQueryRow,
  type MindooQuerySortKey,
} from "./types";

type CandidateRow = MindooQueryRow & {
  sortValues: unknown[];
};

/** All expressions a query references (filter + expression sort keys). */
function collectQueryExpressions(query: MindooQuery): MindooDBAppExpression[] {
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
  }
}

function sortDirectionDescending(sortKey: MindooQuerySortKey): boolean {
  return sortKey.direction === "descending";
}

function computeSortValues(
  sortKeys: MindooQuerySortKey[],
  fields: Record<string, unknown>,
  context: ExpressionEvaluationContext
): unknown[] {
  return sortKeys.map((sortKey) => {
    if (sortKey.expression) {
      return evaluateExpression(sortKey.expression, context);
    }
    return getSummaryFieldValue(fields, sortKey.field ?? "");
  });
}

function sortAndPage(candidates: CandidateRow[], query: MindooQuery): { rows: MindooQueryRow[]; total: number } {
  const sortKeys = query.sortBy ?? [];
  if (sortKeys.length > 0) {
    candidates.sort((left, right) => {
      for (let i = 0; i < sortKeys.length; i++) {
        const result = compareValues(
          left.sortValues[i],
          right.sortValues[i],
          sortDirectionDescending(sortKeys[i])
        );
        if (result !== 0) {
          return result;
        }
      }
      return left.docId.localeCompare(right.docId);
    });
  }

  const total = candidates.length;
  const offset = Math.max(0, query.offset ?? 0);
  const limit = query.limit;
  const paged = limit === undefined
    ? candidates.slice(offset)
    : candidates.slice(offset, offset + Math.max(0, limit));

  return {
    rows: paged.map(({ docId, fields, lastModified }) => ({ docId, fields, lastModified })),
    total,
  };
}

function projectFields(fields: Record<string, unknown>, projection?: string[]): Record<string, unknown> {
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

function queryOrigin(db: MindooDB): string {
  return `${db.getTenant().getId()}/${db.getStore().getId()}`;
}

/**
 * Execute an ad-hoc query against the document summary buffer.
 *
 * Ensures the summary is up to date (passing through progress/cancellation
 * options), verifies that every referenced field is covered by the summary
 * configuration, then filters/sorts/pages the in-memory summary entries.
 * Documents are never materialized on this path.
 */
export async function executeQuery(
  db: MindooDB,
  summary: DocumentSummaryStore,
  query: MindooQuery,
  options?: MindooQueryOptions
): Promise<MindooQueryResult> {
  const expressions = collectQueryExpressions(query);

  if (options?.allowFullScan) {
    validateQueryExpressions(expressions, true);
    return executeFullScanQuery(db, query, expressions, options);
  }

  validateQueryExpressions(expressions, false);

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

  await summary.update(options);
  if (options?.signal?.aborted) {
    throw new MindooQueryError("Query aborted while updating the summary buffer.");
  }

  const origin = queryOrigin(db);
  const sortKeys = query.sortBy ?? [];
  const candidates: CandidateRow[] = [];

  for (const entry of summary.getAllEntries()) {
    const evaluationDoc = buildSummaryEvaluationDoc(entry.fields);
    const context: ExpressionEvaluationContext = {
      doc: evaluationDoc,
      values: {},
      origin,
      decryptionKeyId: entry.decryptionKeyId,
      variables: {},
    };

    if (query.filter && !expressionToBoolean(evaluateExpression(query.filter, context))) {
      continue;
    }

    candidates.push({
      docId: entry.docId,
      fields: projectFields(entry.fields, query.fields),
      lastModified: entry.lastModified,
      sortValues: computeSortValues(sortKeys, entry.fields, context),
    });
  }

  const { rows, total } = sortAndPage(candidates, query);
  return { rows, total, coverage: summary.getCoverage() };
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
  query: MindooQuery,
  expressions: MindooDBAppExpression[],
  options?: MindooQueryOptions
): Promise<MindooQueryResult> {
  const origin = queryOrigin(db);
  const sortKeys = query.sortBy ?? [];
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
    const data = mindooDoc.getData() as Record<string, unknown>;
    const baseContext: ExpressionEvaluationContext = {
      doc: data,
      values: {},
      origin,
      createdAt: new Date(mindooDoc.getCreatedAt()).toISOString(),
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
      sortValues: computeSortValues(sortKeys, data, context),
    });
  }

  const { rows, total: matchTotal } = sortAndPage(candidates, query);
  return { rows, total: matchTotal, coverage: "full-scan" };
}
