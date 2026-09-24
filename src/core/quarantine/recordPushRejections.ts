/**
 * Turn what a push left behind into quarantine records.
 *
 * A client push uses the `"advance"` rejection policy: an entry the server
 * refuses is stepped over so the rest of the database keeps syncing. That is the
 * right trade — one refused entry must not stop a device from ever pushing
 * again — but it means the cursor will never offer that entry a second time. If
 * nothing writes it down at this moment, the change is gone with the process.
 *
 * This is the one place that happens, and it is deliberately *not* inside
 * `pushChangesTo`: the records live in `userdirectory`, so recording them is a
 * write to a different database than the one being pushed. A core sync call that
 * quietly wrote somewhere else would be a surprise to every caller, and an
 * expensive one — it would open the directory on every push. Callers that want
 * the records ask for them.
 */

import type { MindooDB, SigningKeyPair } from "../types";
import type { PutRejectionClass, RejectedPutEntry } from "../appendonlystores/types";
import { rejectionClassOf } from "../appendonlystores/types";
import { parseAttachmentChunkId, parseDocEntryId } from "../utils/idGeneration";
import { isQuarantineDocId, recordPushQuarantine } from "./QuarantineDocument";

/**
 * Stands in for the document of an entry whose id follows neither the document
 * nor the attachment scheme. Such an entry still has to be recorded — losing it
 * silently is the whole problem — and `$` cannot begin a real document id, so
 * this cannot collide with one.
 */
export const UNKNOWN_QUARANTINED_DOC_ID = "$unknown";

/** What {@link recordPushRejections} managed to write. */
export interface PushQuarantineResult {
  /** One per record written or extended. */
  recorded: Array<{
    documentId: string;
    rejectionClass: PutRejectionClass;
    entryCount: number;
  }>;
  /**
   * Refused entries that belong to a quarantine record themselves. Counted
   * rather than recorded: a record about a refused record would be refused in
   * turn, and each refusal would name a new document, so one server that turns
   * away `qtn_` writes could otherwise make a device generate them without end.
   */
  skippedOwnRecords: number;
  /** Records that could not be written, so a caller can log or retry them. */
  failures: Array<{
    documentId: string;
    rejectionClass: PutRejectionClass;
    error: string;
  }>;
}

/** Which document a refused entry belongs to. */
function documentIdOf(entryId: string): string {
  return (
    parseDocEntryId(entryId)?.docId ??
    parseAttachmentChunkId(entryId)?.docId ??
    UNKNOWN_QUARANTINED_DOC_ID
  );
}

/**
 * Write a quarantine record for every document a push was refused on.
 *
 * Grouped by (document, class) to match how the records are keyed, so a refusal
 * that took a document's whole causal tail with it becomes one record holding
 * many entry ids instead of one record per entry.
 *
 * Never throws: a device that cannot write the record has still lost the entry,
 * and a failure here must not turn a partially-successful push into a failed
 * one. Failures come back in {@link PushQuarantineResult.failures}.
 */
export async function recordPushRejections(input: {
  /** Id of the database whose push was refused. Not `userdirectory` as a rule. */
  dbid: string;
  /** The tenant's `userdirectory`, where the records live. */
  userdirectoryDb: MindooDB;
  /** What the push reported as refused. */
  rejected: readonly RejectedPutEntry[];
  /** Signing public key (PEM) of this device. */
  signingPublicKey: string;
  subtle: SubtleCrypto;
  signingKeyPair?: SigningKeyPair;
  signingKeyPassword?: string;
  now?: number;
}): Promise<PushQuarantineResult> {
  const result: PushQuarantineResult = {
    recorded: [],
    skippedOwnRecords: 0,
    failures: [],
  };
  if (input.rejected.length === 0) {
    return result;
  }

  const groups = new Map<
    string,
    {
      documentId: string;
      rejectionClass: PutRejectionClass;
      reason: string;
      entryIds: string[];
    }
  >();

  for (const entry of input.rejected) {
    const documentId = documentIdOf(entry.id);
    if (isQuarantineDocId(documentId)) {
      result.skippedOwnRecords += 1;
      continue;
    }
    const rejectionClass = rejectionClassOf(entry);
    const key = `${documentId}\u0000${rejectionClass}`;
    const group = groups.get(key);
    if (group) {
      group.entryIds.push(entry.id);
    } else {
      groups.set(key, {
        documentId,
        rejectionClass,
        // The first refusal's wording stands for the group: the target repeats
        // itself across a causal cascade, and the class is what differs.
        reason: entry.reason,
        entryIds: [entry.id],
      });
    }
  }

  for (const group of groups.values()) {
    try {
      await recordPushQuarantine({
        db: input.userdirectoryDb,
        signingPublicKey: input.signingPublicKey,
        dbid: input.dbid,
        quarantinedDocId: group.documentId,
        rejectionClass: group.rejectionClass,
        reason: group.reason,
        entryIds: group.entryIds,
        subtle: input.subtle,
        signingKeyPair: input.signingKeyPair,
        signingKeyPassword: input.signingKeyPassword,
        now: input.now,
      });
      result.recorded.push({
        documentId: group.documentId,
        rejectionClass: group.rejectionClass,
        entryCount: group.entryIds.length,
      });
    } catch (error) {
      result.failures.push({
        documentId: group.documentId,
        rejectionClass: group.rejectionClass,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
