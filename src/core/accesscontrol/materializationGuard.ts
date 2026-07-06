import { RuleType } from "./types";

/**
 * Pure helpers for client-side materialization defenses (docs/accesscontrol.md
 * §10): mandatory snapshot head verification, op-type re-derivation, and the
 * shape of the quarantine/audit log.
 *
 * Everything here is a pure function of its inputs so the materialization path
 * stays deterministic across replicas — the property that makes "quarantine on
 * receipt" safe under eventual consistency (§10).
 */

/** Why an entry was quarantined (for the audit log and tests). */
export type QuarantineReason =
  | "tier2_denied"
  | "tier1_recheck_denied"
  | "snapshot_head_mismatch"
  | "snapshot_untrusted_head"
  | "op_type_mismatch"
  | "cascade_dependent"
  | "invalid_signature"
  | "invalid_witness_receipt"
  // Transient: validation could not be completed (e.g. directory/witness
  // adapter temporarily unavailable or threw). The entry is excluded from this
  // materialization (fail closed), but the result is NOT cached so the next
  // load retries and self-heals once the dependency recovers (audit finding #2).
  | "directory_unavailable";

/**
 * One entry in the per-tenant quarantine/audit log (§10). Kept deliberately
 * small and serializable so it can be surfaced in Haven's audit view and
 * persisted alongside the store.
 */
export interface QuarantineRecord {
  /** Store entry id that was quarantined. */
  entryId: string;
  /** Document the entry belonged to. */
  docId: string;
  /** Database id (sync context). */
  dbid: string;
  /** Signed operation type of the entry. */
  entryType: string;
  /** Why it was quarantined. */
  reason: QuarantineReason;
  /** Human-readable detail (e.g. the matched rule id / decision reason). */
  detail: string;
  /** Trusted time of the entry (`receivedAt ?? createdAt`). */
  trustedTime: number;
  /** When the quarantine decision was recorded locally (wall clock, audit only). */
  recordedAt: number;
  /** For cascades, the ancestor entry id that triggered this quarantine. */
  causedByEntryId?: string;
}

/**
 * Mandatory snapshot head verification (§10, "Snapshots"). A `doc_snapshot` is
 * only trustworthy if the Automerge heads of the **decoded** snapshot exactly
 * equal the covered dep heads declared in the store entry's
 * `snapshotHeadHashes`. This prevents a snapshot from smuggling content the
 * author was not allowed to write under the guise of a checkpoint.
 *
 * The comparison is order-independent (heads are a set) and exact (no missing
 * or extra heads allowed).
 *
 * @param decodedHeads Automerge heads of the decoded snapshot document.
 * @param declaredHeads `snapshotHeadHashes` from the signed store metadata.
 * @returns true iff the two describe the identical set of heads.
 */
export function snapshotHeadsMatch(
  decodedHeads: readonly string[],
  declaredHeads: readonly string[] | undefined
): boolean {
  const declared = declaredHeads ?? [];
  if (decodedHeads.length !== declared.length) return false;
  const declaredSet = new Set(declared);
  if (declaredSet.size !== declared.length) {
    // Duplicate declared heads are malformed; require a clean set.
    return false;
  }
  for (const head of decodedHeads) {
    if (!declaredSet.has(head)) return false;
  }
  return true;
}

/** Inputs needed to re-derive an entry's operation type from its decoded change. */
export interface OpTypeDerivationInput {
  /**
   * Whether this change is the document's genesis change (no in-document
   * Automerge parents). The first change of a document is a `doc_create`.
   */
  isGenesis: boolean;
  /** Whether the document was deleted in the `before` (pre-change) state. */
  beforeDeleted: boolean;
  /** Whether the document is deleted in the `after` (post-change) state. */
  afterDeleted: boolean;
}

/**
 * Re-derive the operation type from the decoded change + lifecycle transition,
 * independent of the signed `entryType` (§10, defense in depth). Used to reject
 * an entry whose signed `entryType` was relabeled (e.g. a `doc_delete` disguised
 * as a `doc_change` to dodge a delete rule).
 *
 * Derivation:
 * - genesis change → `doc_create`
 * - not-deleted → deleted → `doc_delete`
 * - deleted → not-deleted → `doc_undelete`
 * - otherwise → `doc_change`
 *
 * `doc_snapshot` is not a data-change and is derived/validated separately
 * (snapshot head match), so it is not produced here.
 */
export function deriveDataOpType(input: OpTypeDerivationInput): RuleType {
  if (input.isGenesis) return "doc_create";
  if (!input.beforeDeleted && input.afterDeleted) return "doc_delete";
  if (input.beforeDeleted && !input.afterDeleted) return "doc_undelete";
  return "doc_change";
}

/**
 * Whether a signed `entryType` is consistent with the type re-derived from the
 * decoded change (§10). A `doc_create` and `doc_change` are *both* acceptable
 * labels for a genesis-or-normal mutation only when they agree; delete and
 * undelete must match exactly. We treat any disagreement as a mismatch (the
 * safe, fail-closed choice).
 */
export function opTypeMatches(signedEntryType: string, derived: RuleType): boolean {
  return signedEntryType === derived;
}
