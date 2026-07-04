import type { MindooDB } from "../types";
import type { DocumentSummaryStore } from "../indexing/summary/DocumentSummaryStore";
import { executeQuery } from "./executeQuery";
import type { MindooQuery, MindooQueryOptions, MindooQueryResult } from "./types";

/** Handle returned by `db.queryLive()`. */
export interface MindooQuerySubscription {
  /** Stop watching; no further `onResult` calls occur afterwards. */
  unsubscribe(): void;
  /**
   * Force a re-evaluation now. The result is delivered through `onResult`
   * even when it did not change (unlike change-triggered re-evaluations).
   */
  refresh(): Promise<void>;
}

/**
 * Fingerprint of a query result: docIds + lastModified in result order.
 * Any membership, ordering, or content change (content changes bump
 * `lastModified`) alters the fingerprint; changes to non-matching
 * documents cost only the scan, never an `onResult` call.
 */
function fingerprintResult(result: MindooQueryResult): string {
  const parts: string[] = [String(result.total)];
  for (const row of result.rows) {
    parts.push(`${row.docId}:${row.lastModified}`);
  }
  return parts.join("|");
}

/**
 * Live query: delivers the initial result, keeps the summary current via
 * the database's change listener, and re-evaluates the query after every
 * (coalesced) change event. `onResult` only fires when the result
 * fingerprint actually changed.
 *
 * Re-evaluations are single-flight with a pending flag, so bursts of
 * change events never queue up more than one follow-up run. Evaluation
 * errors are reported through `onError` (or logged to the console).
 */
export function executeQueryLive(
  db: MindooDB,
  summary: DocumentSummaryStore,
  query: MindooQuery,
  onResult: (result: MindooQueryResult) => void,
  options?: MindooQueryOptions & { onError?: (error: unknown) => void }
): MindooQuerySubscription {
  if (!db.addChangeListener) {
    throw new Error("This MindooDB instance does not support change listeners.");
  }

  let lastFingerprint: string | null = null;
  let unsubscribed = false;
  let running = false;
  let pending = false;

  const reportError = (error: unknown): void => {
    if (options?.onError) {
      options.onError(error);
    } else {
      console.warn("[MindooDB] queryLive evaluation failed:", error);
    }
  };

  const evaluate = async (force: boolean): Promise<void> => {
    const result = await executeQuery(db, summary, query, options);
    if (unsubscribed) {
      return;
    }
    const fingerprint = fingerprintResult(result);
    if (force || fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      onResult(result);
    }
  };

  const run = async (force: boolean): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        try {
          await evaluate(force);
        } catch (error) {
          reportError(error);
        }
        force = false;
      } while (pending && !unsubscribed);
    } finally {
      running = false;
    }
  };

  const removeListener = db.addChangeListener(() => {
    if (!unsubscribed) {
      void run(false);
    }
  });

  // Deliver the initial result asynchronously.
  void run(true);

  return {
    unsubscribe(): void {
      unsubscribed = true;
      removeListener();
    },
    async refresh(): Promise<void> {
      if (unsubscribed) {
        return;
      }
      await run(true);
    },
  };
}
