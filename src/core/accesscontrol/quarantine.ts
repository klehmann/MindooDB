import { QuarantineRecord } from "./materializationGuard";

/**
 * Deterministic cascade-quarantine engine (docs/accesscontrol.md §10).
 *
 * When an entry is quarantined, every entry that causally depends on it
 * (transitively, via Automerge change deps) must also be quarantined — a
 * replica never materializes a change whose ancestor it rejected. The accepted
 * set is therefore always a **causally-closed prefix**, identical across
 * replicas that have synced to the same point.
 *
 * This module is a pure function of (entries, per-entry verdict): no I/O, no
 * wall clock. The verdict callback supplies the Tier 2 / op-type / snapshot
 * decision for an entry that has no quarantined ancestors; the cascade is
 * handled here. Keeping it pure is what guarantees cross-replica convergence.
 */

/** Minimal entry shape the cascade engine needs. */
export interface QuarantineCandidate {
  /** Store entry id. */
  id: string;
  /** Document id. */
  docId: string;
  /** Entry ids this entry causally depends on (Automerge deps, store ids). */
  dependencyIds: string[];
  /** Signed operation type. */
  entryType: string;
  /** Trusted time (`receivedAt ?? createdAt`); used only for stable ordering. */
  trustedTime: number;
}

/** A verdict for a single entry whose ancestors were all accepted. */
export interface EntryVerdict {
  /** Whether the entry is accepted (materialized). */
  accepted: boolean;
  /** When rejected, the audit record (without cascade bookkeeping). */
  record?: Omit<QuarantineRecord, "recordedAt" | "causedByEntryId">;
}

/** Result of {@link computeAcceptedSet}. */
export interface AcceptedSetResult {
  /** Ids that are accepted (and may be materialized), in input order. */
  acceptedIds: string[];
  /** Ids that are quarantined (direct violation or cascade). */
  quarantinedIds: string[];
  /** Audit records for every quarantined entry. */
  records: QuarantineRecord[];
}

/**
 * Deterministic order for evaluation: ascending trusted time, then entry id as
 * a stable tie-breaker. Mirrors the directory/materialization ordering so every
 * replica evaluates entries in the same sequence (§10).
 */
export function sortForEvaluation<T extends QuarantineCandidate>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) =>
    a.trustedTime === b.trustedTime ? a.id.localeCompare(b.id) : a.trustedTime - b.trustedTime
  );
}

/**
 * Compute the causally-closed accepted set and the quarantine records.
 *
 * Entries are evaluated in deterministic trusted-time order. An entry is
 * quarantined if (a) any of its dependencies was quarantined (cascade), or
 * (b) the verdict callback rejects it. Cascade quarantines reference the first
 * quarantined ancestor that caused them, for the audit trail.
 *
 * @param entries The candidate entries (any order; sorted internally).
 * @param verdictFor Decides an entry assuming its ancestors are all accepted.
 *   Only called for entries with no quarantined dependency.
 * @param now Wall-clock timestamp for audit records (not used in any decision).
 */
export function computeAcceptedSet(
  entries: readonly QuarantineCandidate[],
  verdictFor: (entry: QuarantineCandidate) => EntryVerdict,
  now: number
): AcceptedSetResult {
  const ordered = sortForEvaluation(entries);
  const acceptedIds: string[] = [];
  const quarantinedIds: string[] = [];
  const records: QuarantineRecord[] = [];

  // entry id -> the quarantined-ancestor id that taints it (for cascades).
  const taintedBy = new Map<string, string>();
  const quarantined = new Set<string>();

  for (const entry of ordered) {
    // Cascade: if any dependency is quarantined, this entry is too (§10).
    const taintingDep = entry.dependencyIds.find((dep) => quarantined.has(dep));
    if (taintingDep) {
      const rootCause = taintedBy.get(taintingDep) ?? taintingDep;
      quarantined.add(entry.id);
      quarantinedIds.push(entry.id);
      taintedBy.set(entry.id, rootCause);
      records.push({
        entryId: entry.id,
        docId: entry.docId,
        dbid: "",
        entryType: entry.entryType,
        reason: "cascade_dependent",
        detail: `causally depends on quarantined entry ${taintingDep}`,
        trustedTime: entry.trustedTime,
        recordedAt: now,
        causedByEntryId: rootCause,
      });
      continue;
    }

    const verdict = verdictFor(entry);
    if (verdict.accepted) {
      acceptedIds.push(entry.id);
    } else {
      quarantined.add(entry.id);
      quarantinedIds.push(entry.id);
      taintedBy.set(entry.id, entry.id);
      records.push({
        recordedAt: now,
        ...(verdict.record ?? {
          entryId: entry.id,
          docId: entry.docId,
          dbid: "",
          entryType: entry.entryType,
          reason: "tier2_denied",
          detail: "rejected by access policy",
          trustedTime: entry.trustedTime,
        }),
      });
    }
  }

  return { acceptedIds, quarantinedIds, records };
}
