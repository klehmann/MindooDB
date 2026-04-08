import type { StoreEntryMetadata } from "../types";
import type {
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
} from "./types";

/**
 * Shared, metadata-only planner for causal document materialization.
 *
 * Why this exists:
 * - local and remote stores need the same causal replay behavior
 * - planner must work without decrypting payloads
 * - replay order must be deterministic across runs
 *
 * Core invariant:
 * - `entryIdsToApply` contains exactly the replay entries needed to reconstruct
 *   latest state that are not already covered by the selected snapshot.
 */
const DOC_REPLAY_TYPES = new Set(["doc_create", "doc_change", "doc_delete"]);

/**
 * Returns true for entry types that can influence Automerge latest state replay.
 */
function isReplayEntry(meta: StoreEntryMetadata): boolean {
  return DOC_REPLAY_TYPES.has(meta.entryType);
}

/**
 * Computes latest-state heads and all replay entries causally reachable from them.
 *
 * `latestReachable` intentionally excludes unrelated historical branches that are
 * not ancestors of current heads, so coverage/replay decisions only operate on
 * data needed for latest state materialization.
 */
function buildLatestStateReachability(
  replayEntries: StoreEntryMetadata[],
): { latestHeads: string[]; latestReachable: Set<string> } {
  const byId = new Map<string, StoreEntryMetadata>();
  const referenced = new Set<string>();
  for (const entry of replayEntries) {
    byId.set(entry.id, entry);
  }
  for (const entry of replayEntries) {
    for (const depId of entry.dependencyIds) {
      if (byId.has(depId)) {
        referenced.add(depId);
      }
    }
  }

  // Heads are entries that are not referenced as dependencies by any other replay entry.
  const latestHeads = replayEntries
    .filter((e) => !referenced.has(e.id))
    .map((e) => e.id);

  const latestReachable = new Set<string>();
  const stack = [...latestHeads];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (latestReachable.has(id)) {
      continue;
    }
    latestReachable.add(id);
    const entry = byId.get(id);
    if (!entry) {
      continue;
    }
    for (const depId of entry.dependencyIds) {
      if (byId.has(depId) && !latestReachable.has(depId)) {
        stack.push(depId);
      }
    }
  }

  return { latestHeads, latestReachable };
}

/**
 * Computes replay entries covered by the given snapshot.
 *
 * Coverage roots are chosen in this order:
 * 1) explicit `snapshotHeadEntryIds` (preferred; most accurate)
 * 2) snapshot `dependencyIds` (compatibility fallback)
 */
function coveredBySnapshot(
  snapshot: StoreEntryMetadata | null,
  replayById: Map<string, StoreEntryMetadata>,
): Set<string> {
  if (!snapshot) {
    return new Set<string>();
  }

  const roots = snapshot.snapshotHeadEntryIds && snapshot.snapshotHeadEntryIds.length > 0
    ? snapshot.snapshotHeadEntryIds
    : snapshot.dependencyIds;

  const covered = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (covered.has(id)) {
      continue;
    }
    const entry = replayById.get(id);
    if (!entry) {
      continue;
    }
    covered.add(id);
    for (const depId of entry.dependencyIds) {
      if (!covered.has(depId)) {
        stack.push(depId);
      }
    }
  }
  return covered;
}

/**
 * Produces a stable, dependency-first ordering of replay entries using
 * Kahn's algorithm for topological sorting.
 *
 * The caller passes a set of entry IDs that need to be replayed (the
 * "uncovered" set from {@link computeDocumentMaterializationPlan}) and the
 * full metadata map so the function can inspect each entry's
 * `dependencyIds`.  The result is an array where every entry appears
 * *after* all of its causal predecessors, which is the order
 * `Automerge.applyChanges` requires to apply changes correctly.
 *
 * **Why Kahn's algorithm?**  It processes nodes in BFS order starting from
 * roots (entries with no in-set dependencies), decrementing the in-degree
 * of each dependent as its predecessors are emitted.  This naturally
 * produces a valid topological order for any DAG.
 *
 * **Determinism:** When multiple entries become ready at the same time
 * (in-degree drops to zero simultaneously), the queue is sorted
 * lexicographically before the next dequeue.  This guarantees the same
 * output regardless of `Set` or `Map` iteration order, which can vary
 * across JavaScript engines and process runs.
 *
 * **Cycle safety:** In a well-formed Automerge DAG, cycles are impossible.
 * However, if corrupted metadata somehow introduces a cycle, the algorithm
 * detects it (ordered.length < ids.size) and falls back to a simple
 * lexicographic sort so the caller still receives a complete list rather
 * than a partial one.
 *
 * @param ids        The entry IDs to sort (typically the uncovered set).
 * @param replayById Lookup map from entry ID to its metadata, used to
 *                   read `dependencyIds` for graph edges.
 * @returns Entry IDs in dependency-first order suitable for sequential
 *          application to an Automerge document.
 */
export function topologicalByDependencies(
  ids: Set<string>,
  replayById: Map<string, StoreEntryMetadata>,
): string[] {
  // ── Build the in-degree and reverse-adjacency structures ──────────
  // `indegree`   — for each id, how many of its dependencies are also in `ids`
  // `dependents` — for each id, which other ids in the set depend on it
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const id of ids) {
    const entry = replayById.get(id);
    if (!entry) {
      continue;
    }
    for (const depId of entry.dependencyIds) {
      if (!ids.has(depId)) {
        // Dependency is outside the uncovered set (already covered by
        // the snapshot or not part of the latest-state DAG) — skip it.
        continue;
      }
      indegree.set(id, (indegree.get(id) || 0) + 1);
      dependents.get(depId)!.push(id);
    }
  }

  // ── Kahn's BFS ────────────────────────────────────────────────────
  // Seed the queue with root entries (in-degree 0 within the set).
  const queue = Array.from(ids).filter((id) => (indegree.get(id) || 0) === 0);
  queue.sort();
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const dep of dependents.get(id) || []) {
      const next = (indegree.get(dep) || 0) - 1;
      indegree.set(dep, next);
      if (next === 0) {
        queue.push(dep);
      }
    }
    // Re-sort after adding newly ready entries to maintain determinism.
    queue.sort();
  }

  // ── Cycle fallback ────────────────────────────────────────────────
  if (ordered.length !== ids.size) {
    return Array.from(ids).sort();
  }
  return ordered;
}

/**
 * Computes a causal materialization plan for one document.
 *
 * Given all store entries for a document, this function answers two questions:
 *
 * 1. **Which snapshot should we load first?**
 *    The planner evaluates every `doc_snapshot` entry and selects the one whose
 *    causal coverage overlaps the most with the entries needed for the latest
 *    document state.  A snapshot that covers 90% of the DAG means only 10%
 *    of entries need to be replayed — a large win for documents with long
 *    histories.  When two snapshots cover the same number of latest-state
 *    entries, the newer one (by `createdAt`) wins as a deterministic
 *    tie-breaker.  Correctness never depends on timestamps.
 *
 * 2. **Which change entries must be replayed on top of that snapshot?**
 *    Every entry in the latest-state DAG that is *not* causally covered by
 *    the selected snapshot is collected and sorted in dependency-first
 *    (topological) order.  This is the minimal set of Automerge changes
 *    the caller must decrypt and apply to reach the current document state.
 *
 * Snapshot selection strategy:
 * - Choose the snapshot with maximal overlap against `latestReachable`.
 * - Break equal-coverage ties by newer `createdAt` (optimization only).
 * - If no snapshots exist, all replay entries are returned (full rebuild).
 *
 * Attachment entries (`attachment_chunk`) are never included — the planner
 * operates exclusively on `doc_create`, `doc_change`, and `doc_delete`
 * entries (the types tracked by `DOC_REPLAY_TYPES`).
 *
 * @param docId            The document to plan for.
 * @param allEntriesForDoc Every entry metadata record for this document,
 *                         including snapshots and attachments (attachments
 *                         are filtered out internally).
 * @param options          Pass `{ includeDiagnostics: true }` to populate the
 *                         `diagnostics` field with head IDs and coverage counts.
 * @returns A plan containing the snapshot to load (if any) and the ordered
 *          list of entry IDs to apply afterwards.
 */
export function computeDocumentMaterializationPlan(
  docId: string,
  allEntriesForDoc: StoreEntryMetadata[],
  options?: MaterializationPlanOptions,
): DocumentMaterializationPlan {

  // ── Step 1: Partition entries ──────────────────────────────────────
  // Replay entries are the doc-lifecycle entries (create/change/delete) that
  // form the Automerge DAG.  Snapshots are evaluated separately as candidate
  // starting points.
  const replayEntries = allEntriesForDoc.filter(isReplayEntry);
  const replayById = new Map<string, StoreEntryMetadata>(replayEntries.map((e) => [e.id, e]));
  const snapshots = allEntriesForDoc.filter((e) => e.entryType === "doc_snapshot");

  // ── Step 2: Handle empty replay set ─────────────────────────────────
  // After a dense sync the local store may contain only a snapshot with no
  // individual change entries.  In that case select the newest snapshot so
  // the caller can still load the document state.
  if (replayEntries.length === 0) {
    if (snapshots.length > 0) {
      const best = snapshots.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      return {
        docId,
        snapshotEntryId: best.id,
        entryIdsToApply: [],
        diagnostics: options?.includeDiagnostics
          ? { headEntryIds: [], coveredLatestEntryCount: 0, uncoveredLatestEntryCount: 0 }
          : undefined,
      };
    }
    return {
      docId,
      snapshotEntryId: null,
      entryIdsToApply: [],
      diagnostics: options?.includeDiagnostics
        ? { headEntryIds: [], coveredLatestEntryCount: 0, uncoveredLatestEntryCount: 0 }
        : undefined,
    };
  }

  // ── Step 3: Build latest-state reachability ───────────────────────
  // Identify the DAG heads (entries with no dependents) and walk backward
  // to collect every entry causally needed for the current document state.
  const { latestHeads, latestReachable } = buildLatestStateReachability(replayEntries);

  // ── Step 4: Score each snapshot by how many latest-state entries it covers
  let bestSnapshot: StoreEntryMetadata | null = null;
  let bestCoveredCount = -1;

  for (const snapshot of snapshots) {
    const covered = coveredBySnapshot(snapshot, replayById);
    let coveredLatest = 0;
    for (const id of latestReachable) {
      if (covered.has(id)) {
        coveredLatest++;
      }
    }
    if (
      coveredLatest > bestCoveredCount ||
      (coveredLatest === bestCoveredCount && bestSnapshot && snapshot.createdAt > bestSnapshot.createdAt)
    ) {
      bestSnapshot = snapshot;
      bestCoveredCount = coveredLatest;
    }
    if (!bestSnapshot) {
      bestSnapshot = snapshot;
      bestCoveredCount = coveredLatest;
    }
  }

  // ── Step 5: Compute the uncovered set ─────────────────────────────
  // These are the entries that the selected snapshot does NOT already include.
  // If no snapshot was selected, the entire latestReachable set is uncovered.
  const covered = coveredBySnapshot(bestSnapshot, replayById);
  const uncovered = new Set<string>();
  for (const id of latestReachable) {
    if (!covered.has(id)) {
      uncovered.add(id);
    }
  }

  // ── Step 6: Sort uncovered entries in dependency-first order ──────
  // This guarantees that Automerge.applyChanges sees each change only after
  // all of its causal predecessors have already been applied.
  const entryIdsToApply = topologicalByDependencies(uncovered, replayById);

  return {
    docId,
    snapshotEntryId: bestSnapshot ? bestSnapshot.id : null,
    entryIdsToApply,
    diagnostics: options?.includeDiagnostics
      ? {
          headEntryIds: latestHeads,
          coveredLatestEntryCount: bestCoveredCount < 0 ? 0 : bestCoveredCount,
          uncoveredLatestEntryCount: uncovered.size,
        }
      : undefined,
  };
}

/**
 * Computes plans for many documents in one metadata pass.
 *
 * Batch planning is important for networked stores to reduce request/response
 * chattiness during startup and dense sync operations.
 */
export function computeBatchMaterializationPlan(
  allEntries: StoreEntryMetadata[],
  docIds: string[],
  options?: MaterializationPlanOptions,
): DocumentMaterializationBatchPlan {
  const byDoc = new Map<string, StoreEntryMetadata[]>();
  for (const entry of allEntries) {
    if (!byDoc.has(entry.docId)) {
      byDoc.set(entry.docId, []);
    }
    byDoc.get(entry.docId)!.push(entry);
  }

  const plans = docIds.map((docId) =>
    computeDocumentMaterializationPlan(docId, byDoc.get(docId) || [], options),
  );

  return { plans };
}
