/**
 * Refuse entries of purged documents at the moment they would be stored.
 *
 * A purge removes a document's history from the replicas that executed it, but
 * every replica that has not (yet) done so still holds the entries and offers
 * them on the next sync. The sync server already rejects such pushes
 * (`ServerNetworkContentAddressedStore`, rejection class `"purged"`); this
 * guard applies the same rule wherever entries are *pulled into* a store:
 * client pulls and server-to-server pull replication.
 *
 * The guard wraps the receiving store and filters `putEntries`. Rejected
 * entries are reported as `"purged"` in a {@link PutEntriesAck}, which the sync
 * loop already understands: the class is not self-resolving, so the scan cursor
 * moves past them and they are never offered again.
 *
 * @module
 */

import type { ContentAddressedStore, PutEntriesAck, RejectedPutEntry } from "./types";
import { normalizePutResult } from "./syncStores";
import type { StoreEntry, StoreEntryMetadata } from "../types";
import type { Logger } from "../logging";

/** Supplies the ids of the documents purged from the guarded database. */
export type PurgedDocumentIdsResolver = () => Promise<ReadonlySet<string>>;

/**
 * Wrap `store` so `putEntries` refuses entries whose `docId` is purged. Every
 * other member is the original store's, so store identity (sync cursor keys,
 * `getId`, `getCacheIdentity`) is unchanged.
 *
 * The resolver runs lazily, once per wrapper, on the first `putEntries` call:
 * a sync that transfers nothing costs nothing. A failing resolver lets entries
 * through (logged) rather than blocking the sync; the purge reconcile removes
 * whatever slipped in.
 */
export function guardStoreAgainstPurgedDocuments(
  store: ContentAddressedStore,
  resolvePurgedDocIds: PurgedDocumentIdsResolver,
  logger?: Logger,
): ContentAddressedStore {
  let purgedDocIds: Promise<ReadonlySet<string>> | null = null;
  const loadPurgedDocIds = (): Promise<ReadonlySet<string>> => {
    purgedDocIds ??= resolvePurgedDocIds().catch((error) => {
      logger?.warn(
        `Could not resolve purged documents for ${store.getId()}/${store.getStoreKind()}; not filtering: ${error}`,
      );
      return new Set<string>();
    });
    return purgedDocIds;
  };

  const putEntries = async (
    entries: StoreEntry[],
  ): Promise<void | StoreEntryMetadata[] | PutEntriesAck> => {
    const purged = await loadPurgedDocIds();
    if (purged.size === 0) {
      return store.putEntries(entries);
    }
    const accepted: StoreEntry[] = [];
    const refused: RejectedPutEntry[] = [];
    for (const entry of entries) {
      if (entry.docId && purged.has(entry.docId)) {
        refused.push({
          id: entry.id,
          reason: `Entry ${entry.id} belongs to a purged document and may not be stored`,
          rejectionClass: "purged",
        });
      } else {
        accepted.push(entry);
      }
    }
    if (refused.length === 0) {
      return store.putEntries(entries);
    }
    logger?.info(
      `Refused ${refused.length} entr${refused.length === 1 ? "y" : "ies"} of purged documents for ${store.getId()}/${store.getStoreKind()}`,
    );
    const result = accepted.length > 0 ? await store.putEntries(accepted) : undefined;
    const { receipts, batchRejected } = normalizePutResult(result);
    return { receipts, rejected: [...batchRejected, ...refused] };
  };

  return new Proxy(store, {
    get(target, property) {
      if (property === "putEntries") {
        return putEntries;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
