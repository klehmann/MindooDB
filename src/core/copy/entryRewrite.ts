/**
 * Pure entry-rewriting helpers shared by the graft and replay strategies.
 *
 * @internal
 * @module
 */

import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../types";

/**
 * The entry types that make up a document's revision graph. `doc_snapshot` is
 * included deliberately: after a dense sync it can be the only entry a peer
 * holds for a document, so skipping it would silently drop content.
 */
export const DOCUMENT_DAG_ENTRY_TYPES: ReadonlySet<StoreEntryType> = new Set<StoreEntryType>([
  "doc_create",
  "doc_change",
  "doc_delete",
  "doc_undelete",
  "doc_snapshot",
]);

/** True when the entry is part of the document revision graph. */
export function isDocumentDagEntry(entry: StoreEntryMetadata): boolean {
  return DOCUMENT_DAG_ENTRY_TYPES.has(entry.entryType);
}

/**
 * Re-point an entry id from one document to another.
 *
 * Every entry id — document (`<docId>_d_<depsFingerprint>_<automergeHash>`) and
 * attachment chunk (`<docId>_a_<fileUuid7>_<chunkUuid>`) alike — begins with the
 * document id followed by `_`, so re-homing an entry is a prefix swap.
 *
 * This is exact rather than a shortcut, and it is what makes a replay cheap:
 * the deps fingerprint is `SHA-256` over the sorted *Automerge* dependency
 * hashes, which a copy never changes, and the Automerge hash is a property of
 * the change bytes, which a copy reuses verbatim. So the re-derived id is
 * identical to what `generateDocEntryId()` would return under the new document
 * id — without decrypting or decoding anything — and it is deterministic, which
 * is what lets an interrupted copy resume by simply running again.
 *
 * Ids that do not carry the source prefix (a dependency on a foreign entry)
 * are returned unchanged.
 */
export function remapEntryId(
  entryId: string,
  sourceDocId: string,
  targetDocId: string,
): string {
  if (sourceDocId === targetDocId) return entryId;
  if (!entryId.startsWith(`${sourceDocId}_`)) return entryId;
  return `${targetDocId}${entryId.slice(sourceDocId.length)}`;
}

/**
 * Remove the server's witness receipt from a copied entry.
 *
 * The receipt signature binds the database id (see `crypto/WitnessReceipt.ts`),
 * so carrying it into a different database would fail verification and
 * quarantine the entry as `invalid_witness_receipt`. Stripped entries are
 * provisional until the target database is pushed and re-witnessed.
 *
 * `receiptOrder` goes too: it is a per-store sequence the receiving store
 * assigns, meaningless in another one.
 */
export function stripWitnessReceipt<T extends StoreEntryMetadata>(entry: T): T {
  const {
    receivedAt: _receivedAt,
    receivedByPublicKey: _receivedByPublicKey,
    receivedDateSignature: _receivedDateSignature,
    receiptOrder: _receiptOrder,
    ...rest
  } = entry;
  return rest as T;
}

/** Sum the encrypted payload sizes of a batch, for progress and result totals. */
export function sumEncryptedSize(entries: StoreEntry[]): number {
  return entries.reduce((total, entry) => total + entry.encryptedSize, 0);
}
