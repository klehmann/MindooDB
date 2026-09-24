/**
 * One list for both kinds of quarantine.
 *
 * A change can be held back in two directions, and from the user's side they are
 * the same complaint — "something I have is not where it should be, and nobody
 * is retrying it":
 *
 * - **inbound** — an entry arrived here (over peer-to-peer sync, usually) and
 *   was refused at materialization, so it sits in the local store without
 *   affecting any document. Recorded in the metadata checkpoint, local to this
 *   device, keyed per document. See `QuarantineRecord`.
 * - **outbound** — an entry was written here and the server refused to ingest
 *   it, so the push moved on without it. Recorded as a `qtn_` document in
 *   `userdirectory`, which syncs to the whole tenant. See
 *   {@link QuarantineRecordDoc}.
 *
 * The two live in different places for good reasons — an inbound refusal is a
 * local verdict that every replica reaches on its own and would be pointless to
 * broadcast, whereas an outbound one is exactly what other members need to see —
 * but a user looking for a missing change does not know which of the two
 * happened. So the storage stays split and the *reading* is unified here.
 *
 * ## Why the directions keep their own vocabulary
 *
 * Their reasons are genuinely different: an inbound refusal names the check that
 * failed on this device (`tier2_denied`, `cascade_dependent`, …), an outbound one
 * names what the server said (`policy`, `purged`, …). Flattening both into one
 * enum would invent equivalences that do not hold, so {@link QuarantineViewRecord}
 * is a discriminated union: `direction` tells a caller which vocabulary `reason`
 * is drawn from, and which fields are even present.
 */

import type { QuarantineRecord, QuarantineReason } from "../accesscontrol/materializationGuard";
import type { PutRejectionClass } from "../appendonlystores/types";
import { MAX_QUARANTINED_ENTRY_IDS, type QuarantineRecordDoc } from "./QuarantineDocument";

/** Which way the refused change was going. */
export type QuarantineDirection = "inbound" | "outbound";

/** What both directions can answer. */
interface QuarantineViewCommon {
  /** Database the refused entries belong to. */
  dbid: string;
  /** Document the refused entries belong to. */
  documentId: string;
  /** The refusing side's own wording, for the audit view. */
  detail: string;
  /** Refused entry ids, capped at {@link MAX_QUARANTINED_ENTRY_IDS}. */
  entryIds: string[];
  /** How many refused entries did not fit into {@link entryIds}. */
  omittedEntryCount: number;
  /** When this refusal was first seen. */
  firstSeenAt: number;
  /** When it was last confirmed. */
  updatedAt: number;
}

/**
 * One row of the unified quarantine view: all the entries of one document held
 * back for one reason, in one direction.
 */
export type QuarantineViewRecord =
  | (QuarantineViewCommon & {
      direction: "inbound";
      /** Which materialization check refused the entries on this device. */
      reason: QuarantineReason;
    })
  | (QuarantineViewCommon & {
      direction: "outbound";
      /** How the target classified its refusal. */
      reason: PutRejectionClass;
      /** Fingerprint of the signing key whose push was refused. */
      signingKeyFingerprint: string;
      /** The `qtn_` document holding this record, so a caller can withdraw it. */
      recordDocId: string;
    });

/**
 * Fold the local materialization log into view rows.
 *
 * The log holds one record per entry, because an inbound refusal is decided per
 * entry; the view groups them per (database, document, reason) so one poisoned
 * entry dragging fifty dependents along reads as one problem rather than
 * fifty-one — matching how the outbound records are already shaped.
 */
export function inboundQuarantineView(
  log: readonly QuarantineRecord[],
): QuarantineViewRecord[] {
  const rows = new Map<string, QuarantineViewRecord & { direction: "inbound" }>();
  for (const rec of log) {
    const key = `${rec.dbid}\u0000${rec.docId}\u0000${rec.reason}`;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, {
        direction: "inbound",
        dbid: rec.dbid,
        documentId: rec.docId,
        reason: rec.reason,
        detail: rec.detail,
        entryIds: [rec.entryId],
        omittedEntryCount: 0,
        firstSeenAt: rec.recordedAt,
        updatedAt: rec.recordedAt,
      });
      continue;
    }
    if (existing.entryIds.length < MAX_QUARANTINED_ENTRY_IDS) {
      existing.entryIds.push(rec.entryId);
    } else {
      existing.omittedEntryCount += 1;
    }
    existing.firstSeenAt = Math.min(existing.firstSeenAt, rec.recordedAt);
    existing.updatedAt = Math.max(existing.updatedAt, rec.recordedAt);
  }
  return [...rows.values()];
}

/** Turn verified `qtn_` records into view rows. */
export function outboundQuarantineView(
  records: readonly QuarantineRecordDoc[],
): QuarantineViewRecord[] {
  return records.map((rec) => ({
    direction: "outbound" as const,
    dbid: rec.dbid,
    documentId: rec.quarantinedDocId,
    reason: rec.rejectionClass,
    detail: rec.reason,
    entryIds: [...rec.entryIds],
    omittedEntryCount: rec.omittedEntryCount,
    firstSeenAt: rec.firstSeenAt,
    updatedAt: rec.updatedAt,
    signingKeyFingerprint: rec.signingKeyFingerprint,
    recordDocId: rec.docId,
  }));
}

/**
 * The whole quarantine view, newest first.
 *
 * Newest first because the list is read when a change has gone missing, and the
 * change someone is looking for is almost always the last one they made.
 */
export function mergeQuarantineViews(
  ...groups: readonly (readonly QuarantineViewRecord[])[]
): QuarantineViewRecord[] {
  const merged = groups.flat();
  merged.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      a.dbid.localeCompare(b.dbid) ||
      a.documentId.localeCompare(b.documentId) ||
      a.reason.localeCompare(b.reason),
  );
  return merged;
}
