import type { StoreEntryMetadata } from "./types";
import { topologicalByDependencies } from "./appendonlystores/MaterializationPlanner";

const CONFLICT_REPLAY_ENTRY_TYPES = new Set(["doc_create", "doc_change", "doc_delete", "doc_undelete"]);

function compareByCreatedAtThenId(left: StoreEntryMetadata, right: StoreEntryMetadata): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

export function isConflictReplayEntry(entry: StoreEntryMetadata): boolean {
  return CONFLICT_REPLAY_ENTRY_TYPES.has(entry.entryType);
}

function findActiveReplayHeads(replayEntries: StoreEntryMetadata[]): string[] {
  const replayIds = new Set(replayEntries.map((entry) => entry.id));
  const referenced = new Set<string>();
  for (const entry of replayEntries) {
    for (const dependencyId of entry.dependencyIds) {
      if (replayIds.has(dependencyId)) {
        referenced.add(dependencyId);
      }
    }
  }
  return replayEntries
    .filter((entry) => !referenced.has(entry.id))
    .sort(compareByCreatedAtThenId)
    .map((entry) => entry.id);
}

function buildChildIdsByEntryId(
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
      childIdsByEntryId.get(dependencyId)?.push(entry.id);
    }
  }
  for (const [entryId, childIds] of childIdsByEntryId.entries()) {
    childIds.sort((leftId, rightId) => {
      const left = replayById.get(leftId);
      const right = replayById.get(rightId);
      if (left && right) {
        return compareByCreatedAtThenId(left, right);
      }
      return leftId.localeCompare(rightId);
    });
    childIdsByEntryId.set(entryId, childIds);
  }
  return childIdsByEntryId;
}

export interface DocumentConflictAnalysisPlan {
  docId: string;
  replayEntries: StoreEntryMetadata[];
  replayById: Map<string, StoreEntryMetadata>;
  orderedReplayEntryIds: string[];
  activeHeadEntryIds: string[];
  forkEntryIds: string[];
  mergeEntryIds: string[];
  hasConcurrencyCandidates: boolean;
}

/**
 * Metadata-only plan for conflict analysis.
 *
 * The planner deliberately avoids decrypting document contents. It only
 * determines whether replaying payloads is likely to be useful and returns a
 * stable dependency-first order for the private conflict engine.
 */
export function computeDocumentConflictAnalysisPlan(
  docId: string,
  allEntriesForDoc: StoreEntryMetadata[],
): DocumentConflictAnalysisPlan {
  const replayEntries = allEntriesForDoc
    .filter(isConflictReplayEntry)
    .sort(compareByCreatedAtThenId);
  const replayById = new Map(replayEntries.map((entry) => [entry.id, entry]));
  const childIdsByEntryId = buildChildIdsByEntryId(replayEntries, replayById);
  const activeHeadEntryIds = findActiveReplayHeads(replayEntries);
  const forkEntryIds = replayEntries
    .filter((entry) => (childIdsByEntryId.get(entry.id)?.length ?? 0) > 1)
    .map((entry) => entry.id);
  const mergeEntryIds = replayEntries
    .filter((entry) => entry.dependencyIds.filter((dependencyId) => replayById.has(dependencyId)).length > 1)
    .map((entry) => entry.id);
  const orderedReplayEntryIds = topologicalByDependencies(
    new Set(replayEntries.map((entry) => entry.id)),
    replayById,
  );

  return {
    docId,
    replayEntries,
    replayById,
    orderedReplayEntryIds,
    activeHeadEntryIds,
    forkEntryIds,
    mergeEntryIds,
    hasConcurrencyCandidates:
      activeHeadEntryIds.length > 1 || forkEntryIds.length > 0 || mergeEntryIds.length > 0,
  };
}

export function formatDocumentConflictPath(path: Array<string | number>): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }
    if (result.length === 0) {
      return segment;
    }
    return `${result}.${segment}`;
  }, "");
}
