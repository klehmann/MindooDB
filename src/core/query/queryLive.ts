import type { MindooDB } from "../types";
import type { DocumentSummaryStore } from "../indexing/summary/DocumentSummaryStore";
import { executeQuery } from "./executeQuery";
import type {
  MindooQuery,
  MindooQueryInclude,
  MindooQueryOptions,
  MindooQueryResult,
  MindooQueryRow,
} from "./types";

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
 *
 * Full-text relevance scores participate ROUNDED (two decimals): adding
 * or removing documents shifts BM25 statistics slightly for every other
 * match, and re-pushing an unchanged result list over marginal score
 * drift would spam subscribers.
 *
 * Included rows participate recursively. Without that, editing a line
 * item would leave the invoice's own `lastModified` untouched and the
 * subscriber would never hear about a change to data it was handed.
 */
function fingerprintResult(result: MindooQueryResult): string {
  const parts: string[] = [String(result.total)];
  for (const row of result.rows) {
    appendRowFingerprint(parts, row);
  }
  return parts.join("|");
}

function appendRowFingerprint(parts: string[], row: MindooQueryRow): void {
  parts.push(
    row.textScore === undefined
      ? `${row.docId}:${row.lastModified}`
      : `${row.docId}:${row.lastModified}:${row.textScore.toFixed(2)}`
  );
  if (!row.includes) {
    return;
  }
  for (const [slot, slotValue] of Object.entries(row.includes)) {
    if (slotValue === null) {
      parts.push(`${slot}:-`);
      continue;
    }
    if (Array.isArray(slotValue)) {
      parts.push(`${slot}:${slotValue.length}`);
      for (const child of slotValue) {
        appendRowFingerprint(parts, child);
      }
      continue;
    }
    parts.push(`${slot}:1`);
    appendRowFingerprint(parts, slotValue);
  }
}

/**
 * Every database a query reads from: the root plus each `include.db`
 * (recursively; an include without one stays on its parent's database).
 * Deduplicated by instance, so two slots on the same database do not
 * install two listeners.
 */
function collectQueryDatabases(db: MindooDB, query: MindooQuery): MindooDB[] {
  const databases: MindooDB[] = [db];
  const seen = new Set<MindooDB>([db]);

  const walk = (includes: Record<string, MindooQueryInclude>, parentDb: MindooDB): void => {
    for (const include of Object.values(includes)) {
      const target = include.db ?? parentDb;
      if (!seen.has(target)) {
        seen.add(target);
        databases.push(target);
      }
      if (include.include) {
        walk(include.include, target);
      }
    }
  };

  if (query.include) {
    walk(query.include, db);
  }
  return databases;
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
  // A live query with includes is only live if it watches every database
  // it reads from — a changed customer must push just like a changed
  // invoice does.
  const databases = collectQueryDatabases(db, query);
  for (const database of databases) {
    if (!database.addChangeListener) {
      throw new Error("This MindooDB instance does not support change listeners.");
    }
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

  const removeListeners = databases.map((database) =>
    database.addChangeListener!(() => {
      if (!unsubscribed) {
        void run(false);
      }
    })
  );

  // Deliver the initial result asynchronously.
  void run(true);

  return {
    unsubscribe(): void {
      unsubscribed = true;
      for (const removeListener of removeListeners) {
        removeListener();
      }
    },
    async refresh(): Promise<void> {
      if (unsubscribed) {
        return;
      }
      await run(true);
    },
  };
}
