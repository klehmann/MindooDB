/**
 * Bulk document copy — and, with `mode: "history"` plus `targetDocId: "same"`
 * plus `authorship: "preserve"`, the database sharding primitive.
 *
 * The per-document API is the wrong shape for moving thousands of documents:
 * each call would scan the source store's metadata again. This path selects the
 * documents in one pass and then reuses the per-document engine, sharing one
 * progress reporter so the totals accumulate across the whole run.
 *
 * Errors are per-document rather than fatal: the run continues and reports what
 * failed, mirroring how `pushChangesTo` reports `rejectedEntries`. Because every
 * produced entry id is deterministic, re-running after a failure or a
 * cancellation transfers only what is still missing.
 *
 * @module
 */

import { matchesDocIdPrefix } from "../utils/idGeneration";
import type { DocHistoryPurgeRequest } from "../accesscontrol/types";
import type { CopyEngineHost } from "./host";
import { DIRECTORY_DB_ID } from "./feasibility";
import { CopyProgressReporter, copyDocument } from "./copyDocument";
import type {
  CopyDocumentFailure,
  CopyDocumentResult,
  CopyDocumentSelector,
  CopyDocumentsOptions,
  CopyDocumentsResult,
} from "./types";

/** How many entries one metadata scan page pulls when a cursor scan is available. */
const SCAN_PAGE_SIZE = 1000;

/**
 * Collect the source document ids a selector matches.
 *
 * Prefix selection reads store metadata only — never a payload — which is what
 * keeps a shard keyless. Only the ids are retained, so the working set stays
 * proportional to the document count rather than the entry count even on a
 * store with millions of entries.
 */
async function selectDocIds(
  source: CopyEngineHost,
  selector: CopyDocumentSelector,
): Promise<string[]> {
  const selected = new Set<string>(selector.docIds ?? []);

  const prefixes =
    selector.idPrefix === undefined
      ? []
      : Array.isArray(selector.idPrefix)
        ? selector.idPrefix
        : [selector.idPrefix];

  if (prefixes.length > 0) {
    const matches = (docId: string): boolean =>
      prefixes.some((prefix) => matchesDocIdPrefix(docId, prefix));

    const store = source.store;
    if (store.scanEntriesSince) {
      let cursor = null as Parameters<NonNullable<typeof store.scanEntriesSince>>[0];
      for (;;) {
        const page = await store.scanEntriesSince(cursor, SCAN_PAGE_SIZE);
        for (const entry of page.entries) {
          if (matches(entry.docId)) selected.add(entry.docId);
        }
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } else {
      for (const entry of await store.findNewEntries([])) {
        if (matches(entry.docId)) selected.add(entry.docId);
      }
    }
  }

  return [...selected].sort();
}

/** Copy many documents into another database in one pass. */
export async function copyDocuments(
  source: CopyEngineHost,
  target: CopyEngineHost,
  selector: CopyDocumentSelector,
  options: CopyDocumentsOptions = {},
): Promise<CopyDocumentsResult> {
  if (
    (selector.docIds === undefined || selector.docIds.length === 0) &&
    selector.idPrefix === undefined
  ) {
    throw new Error(
      "copyDocumentsTo requires a selector with at least one of docIds or idPrefix.",
    );
  }
  for (const [role, host] of [
    ["source", source],
    ["target", target],
  ] as const) {
    if (host.store.getId() === DIRECTORY_DB_ID) {
      throw new Error(
        `The tenant directory database cannot be used as a copy ${role}.`,
      );
    }
  }

  const reporter = new CopyProgressReporter(options.onProgress);
  reporter.emit("preparing", "Selecting documents to copy");

  const docIds = await selectDocIds(source, selector);
  reporter.totalDocuments = docIds.length;
  reporter.documentsCompleted = 0;
  reporter.emit("planning", `Selected ${docIds.length} documents to copy`);

  const documents: CopyDocumentResult[] = [];
  const failed: CopyDocumentFailure[] = [];
  let cancelled = false;

  for (const docId of docIds) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    try {
      const result = await copyDocument(
        source,
        target,
        docId,
        { ...options, targetDocId: options.targetDocId ?? "new" },
        reporter,
      );
      documents.push(result);
      if (result.cancelled) {
        cancelled = true;
        break;
      }
    } catch (error) {
      failed.push({
        docId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    reporter.documentsCompleted = (reporter.documentsCompleted ?? 0) + 1;
  }

  reporter.currentDocId = undefined;
  reporter.emit(
    "complete",
    `Copied ${documents.length} of ${docIds.length} documents` +
      (failed.length > 0 ? `, ${failed.length} failed` : ""),
  );

  return {
    documents,
    copiedDocIds: documents
      .filter((result) => !result.cancelled)
      .map((result) => result.sourceDocId),
    failed,
    copiedEntries: reporter.copiedEntries,
    copiedBytes: reporter.copiedBytes,
    copiedAttachments: reporter.copiedAttachments,
    cancelled,
  };
}

/**
 * Turn a completed shard into the purge request that reclaims the source.
 *
 * No new purge machinery is involved: this only shapes the result for the
 * existing pipeline. The admin publishes the returned request into the
 * directory database, and the server's `executePendingPurges` denylists each
 * document id before deleting it, so a stale replica cannot re-push into the
 * gap.
 *
 * Two ordering rules matter and are not enforceable here:
 *
 * 1. Publish only after the shard target has been pushed **and witnessed**.
 *    Copied entries are provisional until they are re-witnessed, and a purge is
 *    irreversible.
 * 2. `dbId` must name the **source** database. The denylist is keyed by
 *    database id, which is precisely why purging the source leaves the shard
 *    target — holding the same document ids under a different database id —
 *    untouched.
 *
 * For a very large shard, split {@link CopyDocumentsResult.copiedDocIds} across
 * several requests: the id list lives inside a single directory document, and
 * idempotency is tracked per `requestId`.
 */
export function buildDocHistoryPurgeRequest(
  result: CopyDocumentsResult,
  options: {
    /** The SOURCE database to reclaim. Never the shard target. */
    dbId: string;
    /** Unique id for this request; also forms the directory document id. */
    requestId: string;
    /** Signing key of the admin preparing the request. */
    preparedByPublicKey: string;
    /** Optional human-readable justification, encrypted by the admin on save. */
    reason?: string;
    /** Optional explicit tenant id, when the request is prepared out of band. */
    tenantId?: string;
  },
): DocHistoryPurgeRequest {
  if (result.copiedDocIds.length === 0) {
    throw new Error(
      "Refusing to build a purge request from a copy that moved no documents.",
    );
  }
  if (result.failed.length > 0) {
    throw new Error(
      `Refusing to build a purge request: ${result.failed.length} document(s) failed to copy ` +
        `(${result.failed.map((failure) => failure.docId).join(", ")}). ` +
        "Re-run the copy until it completes cleanly, or build the request from a filtered id list.",
    );
  }
  return {
    v: 1,
    tenantId: options.tenantId,
    requestId: options.requestId,
    dbId: options.dbId,
    docIds: result.copiedDocIds,
    reason: options.reason,
    preparedByPublicKey: options.preparedByPublicKey,
  };
}
