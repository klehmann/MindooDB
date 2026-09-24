/**
 * Offer quarantined entries to the server again.
 *
 * The push cursor has long since moved past these entries, so nothing will ever
 * offer them on its own — that is the whole reason the records exist. Re-submit
 * therefore goes straight to the target store with the specific entries, rather
 * than rewinding the cursor: rewinding would re-scan the entire database to find
 * a handful of entries, and would drag every *other* entry behind that position
 * back through the refusal that made the cursor advance in the first place.
 *
 * ## Not every record may be tried again
 *
 * Filtered through {@link isResubmittableRejection}, and one of the exclusions is
 * a matter of correctness rather than thrift: a `"purged"` refusal means the
 * document's history was deliberately erased, so re-offering the entry is an
 * attempt to undo that erasure. This function must never do it, whether it is
 * called by a scheduler or by someone pressing a button.
 */

import type {
  ContentAddressedStore,
  PutRejectionClass,
  RejectedPutEntry,
} from "../appendonlystores/types";
import { isResubmittableRejection } from "../appendonlystores/types";
import { normalizePutResult } from "../appendonlystores/syncStores";
import type { MindooDB, StoreEntry } from "../types";
import { clearQuarantineRecord, type QuarantineRecordDoc } from "./QuarantineDocument";

/**
 * How many records one pass tries.
 *
 * A pass runs whenever the tenant directory changes, and a record that still
 * fails costs a round trip to learn nothing new. The budget keeps a backlog from
 * turning every directory write into a burst of pushes; the remainder is tried
 * by the next pass.
 */
export const DEFAULT_MAX_RESUBMIT_RECORDS = 25;

/** What happened to one record. */
export interface ResubmitOutcome {
  /** The `qtn_` document this came from. */
  recordDocId: string;
  documentId: string;
  rejectionClass: PutRejectionClass;
  /** Entries the target took this time. */
  accepted: string[];
  /** Entries refused again. */
  refused: RejectedPutEntry[];
  /** Entries no longer in the local store, so nothing can be offered for them. */
  missing: string[];
  /** Whether the record was withdrawn. */
  cleared: boolean;
  /** Set when the attempt itself failed, rather than the entries being refused. */
  error?: string;
}

export interface ResubmitResult {
  outcomes: ResubmitOutcome[];
  /**
   * Records whose class rules out another attempt — permanently refused, or
   * about a document that was purged on purpose.
   */
  skippedFinal: number;
  /** Records left for the next pass by {@link DEFAULT_MAX_RESUBMIT_RECORDS}. */
  notAttempted: number;
}

/**
 * Re-offer the entries named by `records`, all of which must describe the
 * database that `localStore` and `remoteStore` are two ends of.
 *
 * A record is withdrawn only when nothing about it is refused any more. A record
 * that is *partly* accepted is deliberately left standing rather than rewritten
 * to name fewer entries: rewriting it is a write, a write is something to push,
 * and a push is what brings this function round again. It over-reports until the
 * rest passes too, which is the cheaper of the two inaccuracies.
 *
 * Never throws — a re-submit is a background courtesy, and one unreachable
 * server must not take the caller down with it.
 */
export async function resubmitQuarantinedEntries(input: {
  /** Records about one database. */
  records: readonly QuarantineRecordDoc[];
  localStore: ContentAddressedStore;
  remoteStore: ContentAddressedStore;
  /** Where the records live, so accepted ones can be withdrawn. */
  userdirectoryDb: MindooDB;
  subtle: SubtleCrypto;
  maxRecords?: number;
}): Promise<ResubmitResult> {
  const budget = input.maxRecords ?? DEFAULT_MAX_RESUBMIT_RECORDS;
  const result: ResubmitResult = { outcomes: [], skippedFinal: 0, notAttempted: 0 };

  const candidates: QuarantineRecordDoc[] = [];
  for (const record of input.records) {
    if (isResubmittableRejection(record.rejectionClass)) {
      candidates.push(record);
    } else {
      result.skippedFinal += 1;
    }
  }
  if (candidates.length > budget) {
    result.notAttempted = candidates.length - budget;
    candidates.length = budget;
  }

  for (const record of candidates) {
    const outcome: ResubmitOutcome = {
      recordDocId: record.docId,
      documentId: record.quarantinedDocId,
      rejectionClass: record.rejectionClass,
      accepted: [],
      refused: [],
      missing: [],
      cleared: false,
    };
    result.outcomes.push(outcome);

    try {
      const entries = await input.localStore.getEntries([...record.entryIds]);
      const found = new Map(entries.map((entry: StoreEntry) => [entry.id, entry]));
      outcome.missing = record.entryIds.filter((id) => !found.has(id));
      if (entries.length === 0) {
        // Every entry is gone locally. Nothing can ever be offered for this
        // record, so leaving it would make it permanent.
        await clearRecord(input, record);
        outcome.cleared = true;
        continue;
      }

      const { receipts, batchRejected } = normalizePutResult(
        await input.remoteStore.putEntries(entries),
      );
      // Without this the entries stay provisional locally even though the target
      // has now witnessed them, and their trusted time never settles.
      if (receipts.length > 0 && input.localStore.applyWitnessReceipts) {
        await input.localStore.applyWitnessReceipts(receipts);
      }

      const refusedIds = new Set(batchRejected.map((entry) => entry.id));
      outcome.refused = batchRejected;
      outcome.accepted = entries
        .map((entry: StoreEntry) => entry.id)
        .filter((id: string) => !refusedIds.has(id));

      if (outcome.refused.length === 0) {
        await clearRecord(input, record);
        outcome.cleared = true;
      }
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
  }

  return result;
}

async function clearRecord(
  input: { userdirectoryDb: MindooDB; subtle: SubtleCrypto },
  record: QuarantineRecordDoc,
): Promise<void> {
  await clearQuarantineRecord({
    db: input.userdirectoryDb,
    key: {
      signingKeyFingerprint: record.signingKeyFingerprint,
      dbid: record.dbid,
      quarantinedDocId: record.quarantinedDocId,
      rejectionClass: record.rejectionClass,
    },
    subtle: input.subtle,
  });
}
