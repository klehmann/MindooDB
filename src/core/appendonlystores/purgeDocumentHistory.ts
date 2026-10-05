/**
 * Store-level document-history purge (docs/accesscontrol.md §13).
 *
 * A purge physically removes one document's entries from a database's docs
 * store and its attachment chunks from the attachment store. The docs store is
 * simple: a document's entries belong to it alone. Attachment chunks are not:
 *
 * - **Entries.** Duplicating a document inside the same database re-prefixes
 *   the copy's chunks, but the copy's *history* keeps pointing at the source's
 *   chunk ids (see `copy/attachments.ts`). Purging the source's chunks
 *   unconditionally would break attachment time travel on the copy. Those
 *   references are visible without decryption: every document entry carries
 *   its complete attachment set in the signed cleartext `attachmentRefs`.
 * - **Content.** With deterministic attachment encryption, identical bytes
 *   under the same key produce identical ciphertext, so two documents can share
 *   one content blob. The stores release a blob only when its last entry goes
 *   (reference counting by content hash), which this module relies on.
 *
 * Usable without decryption keys, so both the sync server and clients run the
 * same code.
 *
 * @module
 */

import type { ContentAddressedStore } from "./types";
import type { StoreEntryMetadata } from "../types";

/** What {@link purgeDocumentHistoryFromStores} removed and kept. */
export interface DocumentHistoryPurgeOutcome {
  /** Entries removed from the docs store. */
  docEntriesPurged: number;
  /** Attachment chunks of the document removed from the attachment store. */
  attachmentChunksPurged: number;
  /**
   * Attachment chunks of the document that were kept because another
   * document's history still references them.
   */
  attachmentChunksRetained: number;
}

/**
 * Ids of `ownChunks` that another document still references: a chunk chain
 * whose head appears in some other document's `attachmentRefs`, followed back
 * through its dependencies.
 *
 * Chunk chains never cross documents (appends depend on the attachment's own
 * previous chunk and copies re-map the dependencies with the ids), so the walk
 * stays inside `ownChunks`.
 */
async function findChunksReferencedElsewhere(
  docsStore: ContentAddressedStore,
  docId: string,
  ownChunks: StoreEntryMetadata[],
): Promise<Set<string>> {
  const ownById = new Map(ownChunks.map((entry) => [entry.id, entry]));
  const pending: string[] = [];
  for (const entry of await docsStore.findNewEntries([])) {
    if (entry.docId === docId) {
      continue;
    }
    for (const ref of entry.attachmentRefs ?? []) {
      if (ownById.has(ref.lastChunkId)) {
        pending.push(ref.lastChunkId);
      }
    }
  }

  const retained = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (retained.has(id)) {
      continue;
    }
    const chunk = ownById.get(id);
    if (!chunk) {
      continue;
    }
    retained.add(id);
    pending.push(...chunk.dependencyIds);
  }
  return retained;
}

/**
 * Physically purge one document's history from a database's stores.
 *
 * Removes every docs-store entry of the document and every attachment chunk of
 * it that no other document references. Idempotent: a second call finds
 * nothing (or only the retained chunks) and changes nothing.
 *
 * @param stores The database's docs store and, when it has one, its attachment
 *   store.
 * @param docId The document to purge.
 */
export async function purgeDocumentHistoryFromStores(
  stores: {
    docsStore: ContentAddressedStore;
    attachmentStore?: ContentAddressedStore | null;
  },
  docId: string,
): Promise<DocumentHistoryPurgeOutcome> {
  const { docsStore, attachmentStore } = stores;
  let attachmentChunksPurged = 0;
  let attachmentChunksRetained = 0;

  if (attachmentStore && attachmentStore !== docsStore) {
    const ownChunks = await attachmentStore.findNewEntriesForDoc([], docId);
    if (ownChunks.length > 0) {
      const retained = await findChunksReferencedElsewhere(docsStore, docId, ownChunks);
      if (retained.size === 0) {
        await attachmentStore.purgeDocHistory(docId);
        attachmentChunksPurged = ownChunks.length;
      } else {
        if (typeof attachmentStore.deleteEntriesById !== "function") {
          throw new Error(
            `Cannot purge attachments of ${docId}: ${retained.size} chunk(s) are shared ` +
              `with other documents and the attachment store cannot delete entries by id`,
          );
        }
        attachmentChunksPurged = await attachmentStore.deleteEntriesById(
          ownChunks.filter((entry) => !retained.has(entry.id)).map((entry) => entry.id),
        );
        attachmentChunksRetained = retained.size;
      }
    }
  }

  const docEntries = await docsStore.findNewEntriesForDoc([], docId);
  if (docEntries.length > 0) {
    await docsStore.purgeDocHistory(docId);
  }

  return {
    docEntriesPurged: docEntries.length,
    attachmentChunksPurged,
    attachmentChunksRetained,
  };
}
