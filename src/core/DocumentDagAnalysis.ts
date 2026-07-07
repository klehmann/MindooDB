import type {
  DocumentDagAnalysisResult,
  DocumentDagBranchSummary,
  DocumentDagEntrySummary,
  StoreEntryMetadata,
} from "./types";
import { parseDocEntryId } from "./utils/idGeneration";
import { topologicalByDependencies } from "./appendonlystores/MaterializationPlanner";

const REPLAY_ENTRY_TYPES = new Set(["doc_create", "doc_change", "doc_delete", "doc_undelete"]);
const DAG_ENTRY_TYPES = new Set(["doc_create", "doc_change", "doc_delete", "doc_undelete", "doc_snapshot"]);
const LIFECYCLE_TERMINAL_ENTRY_TYPES = new Set(["doc_delete", "doc_undelete"]);

/**
 * Returns true when the entry participates in replaying a document state.
 *
 * Snapshots are DAG nodes too, but they are not replay entries because they act as
 * materialization shortcuts instead of incremental changes.
 */
function isReplayEntry(entry: StoreEntryMetadata): boolean {
  return REPLAY_ENTRY_TYPES.has(entry.entryType);
}

/**
 * Returns true for metadata that belongs in the document DAG analysis view.
 */
export function isDagEntry(entry: StoreEntryMetadata): boolean {
  return DAG_ENTRY_TYPES.has(entry.entryType);
}

/**
 * Stable chronological ordering used throughout DAG analysis and branch planning.
 */
function compareByCreatedAtThenId(left: StoreEntryMetadata, right: StoreEntryMetadata): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Orders entry ids using their metadata when available, falling back to lexical order.
 */
function compareEntryIdsByMetadata(
  replayById: Map<string, StoreEntryMetadata>,
  leftId: string,
  rightId: string,
): number {
  const left = replayById.get(leftId);
  const right = replayById.get(rightId);
  if (left && right) {
    return compareByCreatedAtThenId(left, right);
  }
  return leftId.localeCompare(rightId);
}

/**
 * Orders DAG entries causally: an entry never appears before one of its
 * dependencies, and concurrent entries (no path between them) are ordered by
 * `(createdAt, id)`.
 *
 * A plain chronological sort is NOT sufficient here: `createdAt` has
 * millisecond resolution, so a change and the delete that causally follows it
 * can carry the same timestamp — the id tie-break may then place the effect
 * before its cause, and timeline consumers (e.g. `entries.at(-1)` as "current
 * state") would read a stale lifecycle state.
 */
export function orderDagEntriesCausally(dagEntries: StoreEntryMetadata[]): StoreEntryMetadata[] {
  const byId = new Map(dagEntries.map((entry) => [entry.id, entry]));
  const depsOf = (entry: StoreEntryMetadata): string[] =>
    (entry.entryType === "doc_snapshot" ? getSnapshotRoots(entry) : entry.dependencyIds)
      .filter((dependencyId) => byId.has(dependencyId));

  const remainingDeps = new Map<string, number>();
  const childIds = new Map<string, string[]>();
  for (const entry of dagEntries) {
    const deps = depsOf(entry);
    remainingDeps.set(entry.id, deps.length);
    for (const dependencyId of deps) {
      const children = childIds.get(dependencyId) ?? [];
      children.push(entry.id);
      childIds.set(dependencyId, children);
    }
  }

  const ready = dagEntries
    .filter((entry) => remainingDeps.get(entry.id) === 0)
    .sort(compareByCreatedAtThenId);
  const result: StoreEntryMetadata[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    result.push(next);
    for (const childId of childIds.get(next.id) ?? []) {
      const left = (remainingDeps.get(childId) ?? 1) - 1;
      remainingDeps.set(childId, left);
      if (left === 0) {
        const child = byId.get(childId)!;
        const insertAt = ready.findIndex((entry) => compareByCreatedAtThenId(child, entry) < 0);
        if (insertAt === -1) {
          ready.push(child);
        } else {
          ready.splice(insertAt, 0, child);
        }
      }
    }
  }
  // Content-addressed DAGs cannot cycle; this only guards against malformed
  // metadata so the analysis stays total.
  if (result.length < dagEntries.length) {
    const emitted = new Set(result.map((entry) => entry.id));
    result.push(
      ...dagEntries
        .filter((entry) => !emitted.has(entry.id))
        .sort(compareByCreatedAtThenId),
    );
  }
  return result;
}

/**
 * Prunes a metadata slice down to "grounded" entries: replay entries whose
 * causal ancestry is completely present within the slice (or vouched for by an
 * in-slice snapshot).
 *
 * Why: a timestamp slice (`createdAt <= t`) can contain an entry whose
 * dependency falls OUTSIDE the slice — cross-replica clock skew can give a
 * parent a later `createdAt` than its child, and partial syncs or rejected
 * puts can leave a child without its parent in the store. Automerge silently
 * stashes such changes (their payload never applies), but metadata-derived
 * state (`isDeleted`, head detection) would still count them, so document
 * content and lifecycle state could disagree. Pruning ungrounded entries
 * before planning/derivation makes both views agree by construction: the
 * state at `t` is the merge of all complete causal chains up to `t`.
 *
 * Snapshot handling: a `doc_snapshot` certifies the state it covers, including
 * entries that a history purge may have physically removed. Dependency ids
 * that resolve into snapshot-covered territory therefore count as satisfied,
 * and entries covered by a snapshot are grounded even if their own
 * dependencies were purged. Snapshots themselves are never pruned.
 *
 * @param sliceEntries All entry metadata in the slice (replay + snapshots;
 *                     other types pass through untouched).
 * @returns The slice with ungrounded replay entries removed. Returns the input
 *          array unchanged when everything is grounded (the common case).
 */
export function pruneToGroundedEntries(sliceEntries: StoreEntryMetadata[]): StoreEntryMetadata[] {
  const replayEntries = sliceEntries.filter(isReplayEntry);
  const replayById = new Map(replayEntries.map((entry) => [entry.id, entry]));

  // Ids vouched for by in-slice snapshots: the declared roots (which may be
  // purged) plus everything reachable from them through in-slice entries.
  const vouchedIds = new Set<string>();
  for (const entry of sliceEntries) {
    if (entry.entryType !== "doc_snapshot") {
      continue;
    }
    const stack = getSnapshotRoots(entry);
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (vouchedIds.has(currentId)) {
        continue;
      }
      vouchedIds.add(currentId);
      const covered = replayById.get(currentId);
      if (covered) {
        stack.push(...covered.dependencyIds);
      }
    }
  }

  // Seed: entries with a dependency that is neither in the slice nor vouched.
  // Then propagate ungroundedness downstream along child edges — an entry
  // resting on an ungrounded ancestor is itself ungrounded.
  const childIdsByEntryId = new Map<string, string[]>();
  const ungroundedIds = new Set<string>();
  const queue: string[] = [];
  for (const entry of replayEntries) {
    let hasMissingDependency = false;
    for (const dependencyId of entry.dependencyIds) {
      if (replayById.has(dependencyId)) {
        const children = childIdsByEntryId.get(dependencyId) ?? [];
        children.push(entry.id);
        childIdsByEntryId.set(dependencyId, children);
      } else if (!vouchedIds.has(dependencyId)) {
        hasMissingDependency = true;
      }
    }
    if (hasMissingDependency && !vouchedIds.has(entry.id)) {
      ungroundedIds.add(entry.id);
      queue.push(entry.id);
    }
  }
  while (queue.length > 0) {
    const currentId = queue.pop()!;
    for (const childId of childIdsByEntryId.get(currentId) ?? []) {
      if (!ungroundedIds.has(childId) && !vouchedIds.has(childId)) {
        ungroundedIds.add(childId);
        queue.push(childId);
      }
    }
  }

  if (ungroundedIds.size === 0) {
    return sliceEntries;
  }
  return sliceEntries.filter((entry) => !ungroundedIds.has(entry.id));
}

/**
 * Resolves the replay roots covered by a snapshot.
 *
 * Newer snapshots store explicit root entry ids. Older metadata may only expose
 * `dependencyIds`, so this helper keeps both shapes working.
 */
function getSnapshotRoots(entry: StoreEntryMetadata): string[] {
  if (entry.snapshotHeadEntryIds && entry.snapshotHeadEntryIds.length > 0) {
    return [...entry.snapshotHeadEntryIds];
  }
  return [...entry.dependencyIds];
}

/**
 * Collects the full ancestor set for one replay head by walking dependencies upward.
 */
function collectReplayAncestors(
  replayById: Map<string, StoreEntryMetadata>,
  startEntryId: string,
): Set<string> {
  const visited = new Set<string>();
  const stack = [startEntryId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    const entry = replayById.get(currentId);
    if (!entry) {
      continue;
    }
    visited.add(currentId);
    for (const depId of entry.dependencyIds) {
      if (!visited.has(depId)) {
        stack.push(depId);
      }
    }
  }
  return visited;
}

/**
 * Determines whether the latest lifecycle terminal reachable from the active
 * replay heads leaves the document deleted.
 *
 * When multiple terminal entries survive on concurrent branches, the entry with
 * the latest `createdAt` wins; `id` breaks timestamp ties deterministically.
 */
export function isDeletedFromHeads(
  headEntryIds: string[],
  replayById: Map<string, StoreEntryMetadata>,
): boolean {
  const reachableTerminalIds = new Set<string>();
  for (const headEntryId of headEntryIds) {
    // Only lifecycle terminal entries reachable from active heads can affect
    // the document's current alive/deleted state.
    const ancestors = collectReplayAncestors(replayById, headEntryId);
    for (const entryId of ancestors) {
      const entry = replayById.get(entryId);
      if (entry && LIFECYCLE_TERMINAL_ENTRY_TYPES.has(entry.entryType)) {
        reachableTerminalIds.add(entryId);
      }
    }
  }

  if (reachableTerminalIds.size === 0) {
    return false;
  }

  const terminalIds = Array.from(reachableTerminalIds);
  const survivingTerminalIds = terminalIds.filter((candidateId) => {
    // If a later terminal entry depends on this candidate, the candidate has
    // been causally superseded and should not compete in the final latest-wins
    // comparison. Concurrent terminals survive this pruning step.
    for (const otherId of terminalIds) {
      if (otherId === candidateId) {
        continue;
      }
      if (collectReplayAncestors(replayById, otherId).has(candidateId)) {
        return false;
      }
    }
    return true;
  });

  // Remaining terminals are concurrent branch outcomes. Pick the deterministic
  // latest one so every replica derives the same lifecycle state from metadata.
  const latestTerminal = survivingTerminalIds
    .map((entryId) => replayById.get(entryId))
    .filter((entry): entry is StoreEntryMetadata => entry !== undefined)
    .sort(compareByCreatedAtThenId)
    .at(-1);

  return latestTerminal?.entryType === "doc_delete";
}

/**
 * Finds the replay heads that are still active at the selected timestamp.
 *
 * A replay head is any replay entry that is not referenced as a dependency by
 * another replay entry in the filtered slice.
 */
function findActiveReplayHeads(replayEntries: StoreEntryMetadata[]): string[] {
  const replayIds = new Set(replayEntries.map((entry) => entry.id));
  const referenced = new Set<string>();
  for (const entry of replayEntries) {
    for (const depId of entry.dependencyIds) {
      if (replayIds.has(depId)) {
        referenced.add(depId);
      }
    }
  }
  return replayEntries
    .filter((entry) => !referenced.has(entry.id))
    .sort(compareByCreatedAtThenId)
    .map((entry) => entry.id);
}

/**
 * Builds `entryId -> childEntryIds` for replay entries so the visualization layer can
 * traverse the graph in both directions.
 */
function buildReplayChildIds(
  replayEntries: StoreEntryMetadata[],
  replayById: Map<string, StoreEntryMetadata>,
): Map<string, string[]> {
  const childIdsByEntryId = new Map<string, string[]>();
  for (const entry of replayEntries) {
    childIdsByEntryId.set(entry.id, []);
  }
  for (const entry of replayEntries) {
    for (const dependencyId of entry.dependencyIds) {
      if (!replayById.has(dependencyId)) {
        continue;
      }
      const childIds = childIdsByEntryId.get(dependencyId);
      if (!childIds) {
        continue;
      }
      childIds.push(entry.id);
    }
  }
  for (const [entryId, childIds] of childIdsByEntryId.entries()) {
    childIds.sort((leftId, rightId) => compareEntryIdsByMetadata(replayById, leftId, rightId));
    childIdsByEntryId.set(entryId, childIds);
  }
  return childIdsByEntryId;
}

/**
 * Internal result of the historical lane planner used by the DAG explorer.
 *
 * These fields preserve merged/forked strands visually even after the document has
 * converged back to a single active head.
 */
interface HistoricalLanePlan {
  graphLaneIds: string[];
  childEntryIdsByEntryId: Map<string, string[]>;
  primaryGraphLaneIdByEntryId: Map<string, string>;
  graphLaneIdsByEntryId: Map<string, string[]>;
  mergeEntryIds: Set<string>;
  forkEntryIds: Set<string>;
}

/**
 * Assigns stable visual lanes to the replay graph.
 *
 * The planner starts from surviving heads, walks backwards through the dependency
 * graph, and keeps lane membership for merge/fork history so Haven can render
 * Git-like strands instead of collapsing everything into current-head lanes.
 */
function buildHistoricalLanePlan(
  replayEntries: StoreEntryMetadata[],
  replayById: Map<string, StoreEntryMetadata>,
  activeHeadEntryIds: string[],
): HistoricalLanePlan {
  const childEntryIdsByEntryId = buildReplayChildIds(replayEntries, replayById);
  const primaryGraphLaneIdByEntryId = new Map<string, string>();
  const laneMembershipByEntryId = new Map<string, Set<string>>();
  const mergeEntryIds = new Set<string>();
  const forkEntryIds = new Set<string>();
  const graphLaneIds: string[] = [];
  let nextLaneIndex = 0;

  const createLaneId = () => {
    const laneId = `lane-${nextLaneIndex++}`;
    graphLaneIds.push(laneId);
    return laneId;
  };

  const ensureLaneMembership = (entryId: string, laneId: string) => {
    let membership = laneMembershipByEntryId.get(entryId);
    if (!membership) {
      membership = new Set<string>();
      laneMembershipByEntryId.set(entryId, membership);
    }
    membership.add(laneId);
    if (!primaryGraphLaneIdByEntryId.has(entryId)) {
      primaryGraphLaneIdByEntryId.set(entryId, laneId);
    }
  };

  const sortedHeadEntryIds = [...activeHeadEntryIds].sort((leftId, rightId) =>
    compareEntryIdsByMetadata(replayById, leftId, rightId),
  );
  for (const headEntryId of sortedHeadEntryIds) {
    ensureLaneMembership(headEntryId, createLaneId());
  }

  const reverseChronologicalReplayEntries = [...replayEntries].sort((left, right) =>
    compareByCreatedAtThenId(right, left),
  );

  for (const entry of reverseChronologicalReplayEntries) {
    if (!primaryGraphLaneIdByEntryId.has(entry.id)) {
      ensureLaneMembership(entry.id, createLaneId());
    }

    const dependencyEntryIds = entry.dependencyIds
      .filter((dependencyId) => replayById.has(dependencyId))
      .sort((leftId, rightId) => compareEntryIdsByMetadata(replayById, leftId, rightId));
    const childEntryIds = childEntryIdsByEntryId.get(entry.id) ?? [];

    if (dependencyEntryIds.length > 1) {
      mergeEntryIds.add(entry.id);
    }
    if (childEntryIds.length > 1) {
      forkEntryIds.add(entry.id);
    }

    const primaryLaneId = primaryGraphLaneIdByEntryId.get(entry.id)!;
    dependencyEntryIds.forEach((dependencyId, index) => {
      const laneId = index === 0
        ? primaryLaneId
        : primaryGraphLaneIdByEntryId.get(dependencyId) ?? createLaneId();
      ensureLaneMembership(dependencyId, laneId);
      if (index > 0) {
        ensureLaneMembership(entry.id, laneId);
      }
    });
  }

  return {
    graphLaneIds,
    childEntryIdsByEntryId,
    primaryGraphLaneIdByEntryId,
    graphLaneIdsByEntryId: new Map(
      Array.from(laneMembershipByEntryId.entries()).map(([entryId, memberships]) => [
        entryId,
        [...memberships].sort((leftId, rightId) => graphLaneIds.indexOf(leftId) - graphLaneIds.indexOf(rightId)),
      ]),
    ),
    mergeEntryIds,
    forkEntryIds,
  };
}

/**
 * Scores a snapshot by how many entries of a branch it covers.
 */
function scoreSnapshotCoverage(
  snapshot: StoreEntryMetadata,
  replayById: Map<string, StoreEntryMetadata>,
  branchAncestors: Set<string>,
): number {
  return collectSnapshotCoveredIds(snapshot, replayById, branchAncestors).size;
}

/**
 * Returns the subset of branch entries that are already represented by a snapshot.
 */
function collectSnapshotCoveredIds(
  snapshot: StoreEntryMetadata,
  replayById: Map<string, StoreEntryMetadata>,
  branchAncestors: Set<string>,
): Set<string> {
  const covered = new Set<string>();
  const stack = getSnapshotRoots(snapshot);
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (covered.has(currentId) || !branchAncestors.has(currentId)) {
      continue;
    }
    const entry = replayById.get(currentId);
    if (!entry) {
      continue;
    }
    covered.add(currentId);
    for (const depId of entry.dependencyIds) {
      if (!covered.has(depId)) {
        stack.push(depId);
      }
    }
  }
  return covered;
}

/**
 * Chooses the best snapshot that can serve as the starting point for a branch replay.
 *
 * Only snapshots whose roots are part of the branch are eligible. Among those, the
 * snapshot with the highest coverage wins, with newer snapshots breaking ties.
 */
export function chooseBestBranchSnapshot(
  snapshots: StoreEntryMetadata[],
  replayById: Map<string, StoreEntryMetadata>,
  branchAncestors: Set<string>,
): StoreEntryMetadata | null {
  let bestSnapshot: StoreEntryMetadata | null = null;
  let bestCoveredCount = -1;
  for (const snapshot of snapshots) {
    const roots = getSnapshotRoots(snapshot);
    if (roots.length === 0 || !roots.every((rootId) => branchAncestors.has(rootId))) {
      continue;
    }
    const coveredCount = scoreSnapshotCoverage(snapshot, replayById, branchAncestors);
    if (
      coveredCount > bestCoveredCount
      || (
        coveredCount === bestCoveredCount
        && bestSnapshot !== null
        && snapshot.createdAt > bestSnapshot.createdAt
      )
    ) {
      bestSnapshot = snapshot;
      bestCoveredCount = coveredCount;
    }
    if (bestSnapshot === null) {
      bestSnapshot = snapshot;
      bestCoveredCount = coveredCount;
    }
  }
  return bestSnapshot;
}

/**
 * Summarizes one active branch/head for the DAG sidebar and branch materialization UI.
 */
function buildBranchSummary(
  headEntryId: string,
  replayById: Map<string, StoreEntryMetadata>,
  snapshots: StoreEntryMetadata[],
): DocumentDagBranchSummary | null {
  const headEntry = replayById.get(headEntryId);
  if (!headEntry) {
    return null;
  }
  const branchAncestors = collectReplayAncestors(replayById, headEntryId);
  const compatibleSnapshot = chooseBestBranchSnapshot(snapshots, replayById, branchAncestors);
  const orderedAncestors = Array.from(branchAncestors)
    .map((entryId) => replayById.get(entryId))
    .filter((entry): entry is StoreEntryMetadata => entry !== undefined)
    .sort(compareByCreatedAtThenId)
    .map((entry) => entry.id);
  return {
    headEntryId,
    headCreatedAt: headEntry.createdAt,
    headCreatedByPublicKey: headEntry.createdByPublicKey,
    ancestorEntryIds: orderedAncestors,
    compatibleSnapshotEntryId: compatibleSnapshot?.id ?? null,
    compatibleSnapshotCreatedAt: compatibleSnapshot?.createdAt ?? null,
    isDeleted: isDeletedFromHeads([headEntryId], replayById),
  };
}

/**
 * Computes the full DAG analysis payload used by Haven's explorer.
 *
 * The result intentionally contains both:
 * - current-head-derived branch information for reconstruction/materialization
 * - dependency-graph-derived lane information for historical visualization
 */
export function computeDocumentDagAnalysis(
  docId: string,
  allEntriesForDoc: StoreEntryMetadata[],
  timestamp: number,
): DocumentDagAnalysisResult {
  const dagEntries = orderDagEntriesCausally(allEntriesForDoc.filter(isDagEntry));
  const replayEntries = dagEntries.filter(isReplayEntry);
  const replayById = new Map(replayEntries.map((entry) => [entry.id, entry]));
  const snapshots = dagEntries.filter((entry) => entry.entryType === "doc_snapshot");
  const activeHeadEntryIds = findActiveReplayHeads(replayEntries);
  const historicalLanePlan = buildHistoricalLanePlan(replayEntries, replayById, activeHeadEntryIds);
  const ancestorSetsByHead = new Map<string, Set<string>>();
  for (const headEntryId of activeHeadEntryIds) {
    ancestorSetsByHead.set(headEntryId, collectReplayAncestors(replayById, headEntryId));
  }

  const entries: DocumentDagEntrySummary[] = dagEntries.map((entry) => {
    const parsed = parseDocEntryId(entry.id);
    const branchHeadEntryIds = activeHeadEntryIds.filter((headEntryId) => {
      if (entry.entryType === "doc_snapshot") {
        const roots = getSnapshotRoots(entry);
        return roots.length > 0 && roots.every((rootId) => ancestorSetsByHead.get(headEntryId)?.has(rootId));
      }
      return ancestorSetsByHead.get(headEntryId)?.has(entry.id) ?? false;
    });
    const lifecycleHeadEntryIds = entry.entryType === "doc_snapshot"
      ? getSnapshotRoots(entry)
      : [entry.id];
    const liveStateAfter = isDeletedFromHeads(lifecycleHeadEntryIds, replayById)
      ? "deleted"
      : "alive";
    return {
      entryId: entry.id,
      entryType: entry.entryType,
      createdAt: entry.createdAt,
      createdByPublicKey: entry.createdByPublicKey,
      automergeActorId: null,
      dependencyIds: [...entry.dependencyIds],
      childEntryIds: historicalLanePlan.childEntryIdsByEntryId.get(entry.id) ?? [],
      snapshotHeadEntryIds: [...(entry.snapshotHeadEntryIds ?? [])],
      snapshotHeadHashes: [...(entry.snapshotHeadHashes ?? [])],
      automergeHash: parsed?.automergeHash ?? null,
      isActiveHead: activeHeadEntryIds.includes(entry.id),
      isDeleted: liveStateAfter === "deleted",
      isUndelete: entry.entryType === "doc_undelete",
      liveStateAfter,
      branchHeadEntryIds,
      graphLaneIds: entry.entryType === "doc_snapshot"
        ? getSnapshotRoots(entry)
          .map((rootEntryId) => historicalLanePlan.primaryGraphLaneIdByEntryId.get(rootEntryId))
          .filter((laneId): laneId is string => laneId !== undefined)
        : historicalLanePlan.graphLaneIdsByEntryId.get(entry.id) ?? [],
      primaryGraphLaneId: entry.entryType === "doc_snapshot"
        ? getSnapshotRoots(entry)
          .map((rootEntryId) => historicalLanePlan.primaryGraphLaneIdByEntryId.get(rootEntryId))
          .find((laneId): laneId is string => laneId !== undefined) ?? null
        : historicalLanePlan.primaryGraphLaneIdByEntryId.get(entry.id) ?? null,
      isMergePoint: entry.entryType === "doc_snapshot"
        ? getSnapshotRoots(entry).filter((rootEntryId) => replayById.has(rootEntryId)).length > 1
        : historicalLanePlan.mergeEntryIds.has(entry.id),
      isForkPoint: entry.entryType === "doc_snapshot"
        ? false
        : historicalLanePlan.forkEntryIds.has(entry.id),
    };
  });

  const branches = activeHeadEntryIds
    .map((headEntryId) => buildBranchSummary(headEntryId, replayById, snapshots))
    .filter((branch): branch is DocumentDagBranchSummary => branch !== null);

  return {
    docId,
    timestamp,
    activeHeadEntryIds,
    graphLaneIds: historicalLanePlan.graphLaneIds,
    entries,
    branches,
  };
}

/**
 * Materialization instructions for reconstructing the document state of one branch head.
 */
export interface DocumentDagBranchPlan {
  docId: string;
  headEntryId: string;
  headCreatedAt: number;
  headCreatedByPublicKey: string;
  snapshotEntryId: string | null;
  entryIdsToApply: string[];
  branchEntryIds: string[];
}

/**
 * Builds the replay plan needed to reconstruct one branch-local document state.
 *
 * The plan identifies an optional compatible snapshot, the uncovered replay entries
 * that still need to be applied, and the full ordered ancestor set for the branch.
 */
export function computeBranchMaterializationPlan(
  docId: string,
  allEntriesForDoc: StoreEntryMetadata[],
  headEntryId: string,
): DocumentDagBranchPlan | null {
  const dagEntries = allEntriesForDoc.filter(isDagEntry);
  const replayEntries = dagEntries.filter(isReplayEntry);
  const replayById = new Map(replayEntries.map((entry) => [entry.id, entry]));
  const headEntry = replayById.get(headEntryId);
  if (!headEntry) {
    return null;
  }
  const branchAncestors = collectReplayAncestors(replayById, headEntryId);
  const snapshots = dagEntries.filter((entry) => entry.entryType === "doc_snapshot");
  const bestSnapshot = chooseBestBranchSnapshot(snapshots, replayById, branchAncestors);
  const coveredIds = bestSnapshot
    ? collectSnapshotCoveredIds(bestSnapshot, replayById, branchAncestors)
    : new Set<string>();
  const uncoveredIds = new Set<string>();
  for (const entryId of branchAncestors) {
    if (!coveredIds.has(entryId)) {
      uncoveredIds.add(entryId);
    }
  }
  const entryIdsToApply = topologicalByDependencies(uncoveredIds, replayById);
  const branchEntryIds = Array.from(branchAncestors)
    .map((entryId) => replayById.get(entryId))
    .filter((entry): entry is StoreEntryMetadata => entry !== undefined)
    .sort(compareByCreatedAtThenId)
    .map((entry) => entry.id);
  return {
    docId,
    headEntryId,
    headCreatedAt: headEntry.createdAt,
    headCreatedByPublicKey: headEntry.createdByPublicKey,
    snapshotEntryId: bestSnapshot?.id ?? null,
    entryIdsToApply,
    branchEntryIds,
  };
}
