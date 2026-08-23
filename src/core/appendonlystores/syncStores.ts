/**
 * Store-to-store entry transfer (sync-v5).
 *
 * This is the reconciliation algorithm that moves {@link StoreEntry} blobs from
 * one {@link ContentAddressedStore} to another: persisted scan cursors, bloom
 * pre-screening, and parallel transfer batches. It works purely on encrypted
 * entries and never opens an Automerge document, which is what lets both the
 * client (`BaseMindooDB.pullChangesFrom` / `pushChangesTo`) and the server-side
 * peer replicator share one implementation instead of maintaining a second,
 * weaker server-to-server algorithm.
 *
 * ## Cursor invariant: strictly per (source, target) pair
 *
 * A cursor position is a `(receiptOrder, id)` pair, and `receiptOrder` is the
 * *local insertion order* of the store that produced it — it is assigned when
 * an entry lands in that store and is NOT part of the replicated entry data
 * (see `StampedWitnessFields` in `core/crypto/WitnessReceipt.ts`, which carries
 * only `receivedAt` / `receivedByPublicKey` / `receivedDateSignature`).
 *
 * Two servers holding the identical entry set therefore assign it different
 * receipt orders. A cursor is only meaningful for the exact pair of stores it
 * was recorded for, which is why {@link syncScanCursorKey} embeds both
 * identities and why cursors must never be shared, reused across peers, or
 * replicated. Getting this wrong silently skips entries.
 */

import type {
  ContentAddressedStore,
  StoreScanCursor,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreHead,
  RejectedPutEntry,
  PutEntriesAck,
} from "./types";
import { StoreKind } from "./types";
import type { StoreEntryMetadata } from "../types";
import type { SyncOptions } from "../types";
import { bloomMightContainId } from "./bloom";
import type { Logger } from "../logging";

/**
 * How far a previous sync between one (source, target) pair already scanned the
 * source, anchored to the epochs of both stores at that moment. An epoch change
 * on either side breaks the lineage and forces a full rescan.
 */
export interface SyncScanCursorRecord {
  sourceEpoch: string;
  targetEpoch: string;
  cursor: StoreScanCursor;
}

/**
 * Where {@link syncEntriesBetweenStores} keeps its scan cursors.
 *
 * `BaseMindooDB` backs this with the map persisted in its metadata checkpoint;
 * the server-side peer replicator backs it with a plain in-process map (a fresh
 * process simply starts with one full metadata scan and then skips via the
 * store head). Keys come from {@link syncScanCursorKey} — see the cursor
 * invariant in the module docs before adding another implementation.
 */
export interface SyncScanCursorStore {
  get(key: string): SyncScanCursorRecord | null;
  save(key: string, record: SyncScanCursorRecord): void;
  delete(key: string): void;
}

/**
 * What a caller does with entries the target refused per-entry
 * (signature-class rejections, sync-v5 §5.7.6).
 *
 * - `"advance"` — the persisted cursor moves past the rejected entry, so it is
 *   never offered again. Correct for **clients**: one locally corrupted or
 *   forged entry must not block a database's push sync forever.
 * - `"hold"` — the persisted cursor is clamped to just before the earliest
 *   rejected entry, so the next run re-offers it. Required for
 *   **server-to-server** replication: the most common rejection there is
 *   "author key not yet trusted", which resolves as soon as the peer has
 *   replicated the `directory` database. Advancing the cursor past those
 *   entries would drop them permanently and silently, leaving two servers
 *   divergent with no error anywhere.
 */
export type SyncRejectionPolicy = "advance" | "hold";

/** Everything {@link syncEntriesBetweenStores} needs from its host. */
export interface SyncStoresContext {
  logger: Logger;
  cursors: SyncScanCursorStore;
  /** Defaults to `"advance"` (client semantics). */
  rejectionPolicy?: SyncRejectionPolicy;
}

export interface SyncStoresResult {
  transferred: number;
  transferredBytes?: number;
  scanned: number;
  cancelled: boolean;
  rejected?: RejectedPutEntry[];
  /**
   * True when {@link SyncRejectionPolicy} `"hold"` clamped the persisted cursor
   * because entries were rejected. The caller should retry this pair (with
   * backoff) and surface it — under the hold policy this is the visible
   * precursor of divergence.
   */
  cursorHeldForRetry?: boolean;
}

/**
 * Default window of transfer batches running in parallel (sync-v5, phase 4).
 * Kept small: each in-flight batch holds one decrypted page of entries in
 * memory, and HTTP/2 multiplexes the requests over a single connection anyway.
 */
const DEFAULT_MAX_CONCURRENT_TRANSFER_BATCHES = 3;

/**
 * Default `getEntries` batch size for document stores.
 *
 * Intentionally smaller than the metadata scan `pageSize` (1000): a full scan
 * page transferred as one `putEntries` call serializes to a multi-megabyte JSON
 * body whose upload cannot report progress, risks the HTTP timeout on slow
 * uplinks (each retry restarts the whole body), and can exceed the remote JSON
 * body limit. Smaller batches keep progress events frequent and make each POST
 * cheap to retry.
 */
const DEFAULT_DOCS_TRANSFER_BATCH_SIZE = 250;

/** Stable identity for a store in the persisted sync-cursor map. */
export function syncStoreIdentity(store: ContentAddressedStore): string {
  return store.getCacheIdentity?.() ?? `${store.getId()}/${store.getStoreKind()}`;
}

/** Key for a scan cursor: one record per (source, target) pair. */
export function syncScanCursorKey(
  sourceStore: ContentAddressedStore,
  targetStore: ContentAddressedStore,
): string {
  return `${syncStoreIdentity(sourceStore)}->${syncStoreIdentity(targetStore)}`;
}

export function setSyncAbortSignalOnStore(
  store: ContentAddressedStore,
  signal?: AbortSignal,
): void {
  if ("setSyncAbortSignal" in store && typeof (store as any).setSyncAbortSignal === "function") {
    (store as any).setSyncAbortSignal(signal);
  }
}

/**
 * Fetch a store's head descriptor (`{ epoch, maxReceiptOrder }`), returning null
 * when the store (or the remote server behind it) does not support it or the
 * request fails. A null head simply disables the persisted-cursor fast path.
 */
export async function getStoreHeadSafe(
  store: ContentAddressedStore,
  logger: Logger,
): Promise<StoreHead | null> {
  if (typeof store.getStoreHead !== "function") {
    return null;
  }
  try {
    return await store.getStoreHead();
  } catch (error) {
    logger.debug("Store head unavailable, falling back to full scan", error);
    return null;
  }
}

/**
 * Fetch a store's bloom filter summary, returning null if unsupported or on
 * error. Used on the target for missing-id pre-screening (callers fall back to
 * exact checks) and on the source for the total-entry-count progress
 * denominator.
 */
export async function getStoreBloomSummary(
  store: ContentAddressedStore,
  logger: Logger,
): Promise<StoreIdBloomSummary | null> {
  if (typeof store.getIdBloomSummary !== "function") {
    return null;
  }
  try {
    return await store.getIdBloomSummary();
  } catch (error) {
    logger.warn("Failed to get bloom summary from store, falling back to exact checks", error);
    return null;
  }
}

/**
 * From a list of candidate IDs, return only those the target store is missing.
 * Uses bloom-filter pre-screening when available, then falls back to exact
 * `hasEntries` for the uncertain set.
 */
export async function filterMissingIds(
  targetStore: ContentAddressedStore,
  candidateIds: string[],
  bloom: StoreIdBloomSummary | null,
): Promise<string[]> {
  let definitelyMissing: string[] = [];
  let maybeExisting: string[] = candidateIds;

  if (bloom) {
    definitelyMissing = [];
    maybeExisting = [];
    for (const id of candidateIds) {
      if (bloomMightContainId(bloom, id)) {
        maybeExisting.push(id);
      } else {
        definitelyMissing.push(id);
      }
    }
  }

  let missingIds = definitelyMissing;
  if (maybeExisting.length > 0) {
    const existing = await targetStore.hasEntries(maybeExisting);
    const existingSet = new Set(existing);
    missingIds = missingIds.concat(maybeExisting.filter((id) => !existingSet.has(id)));
  }
  return missingIds;
}

/**
 * Normalize the polymorphic putEntries result (`void`, receipts array, or
 * structured {@link PutEntriesAck}) into receipts + per-entry rejections.
 */
function normalizePutResult(
  putResult: void | StoreEntryMetadata[] | PutEntriesAck,
): { receipts: StoreEntryMetadata[]; batchRejected: RejectedPutEntry[] } {
  if (Array.isArray(putResult)) {
    return { receipts: putResult, batchRejected: [] };
  }
  if (putResult && typeof putResult === "object") {
    return {
      receipts: putResult.receipts ?? [],
      batchRejected: putResult.rejected ?? [],
    };
  }
  return { receipts: [], batchRejected: [] };
}

/**
 * Determine how many entry IDs to fetch per `getEntries` call during sync.
 *
 * Intentionally separate from the metadata scan `pageSize` so scanning can page
 * through large ID lists quickly while the heavier payload downloads use a
 * smaller batch to keep progress responsive and cancellation timely.
 *
 * Priority: explicit option > attachment default (100) > docs default (250,
 * capped by pageSize).
 */
function resolveTransferBatchSize(options?: SyncOptions): number {
  if (options?.transferBatchSize && options.transferBatchSize > 0) {
    return options.transferBatchSize;
  }
  if (options?.storeKind === StoreKind.attachments) {
    return 100;
  }
  return Math.min(options?.pageSize ?? 1000, DEFAULT_DOCS_TRANSFER_BATCH_SIZE);
}

/**
 * Transfer a set of entry IDs from source to target in fixed-size batches,
 * emitting progress and checking for cancellation between each batch.
 *
 * Callers collect the IDs that need transferring, then delegate here instead of
 * issuing one monolithic `getEntries`. This keeps progress updates frequent,
 * lets cancellation interrupt between batches, and keeps each server-side
 * `getEntries` + encryption unit small enough to avoid socket timeouts.
 *
 * Returns partial progress on cancellation so callers can report how much was
 * actually transferred before the abort.
 */
export async function transferEntriesInBatches(
  sourceStore: ContentAddressedStore,
  targetStore: ContentAddressedStore,
  entryIds: string[],
  options: SyncOptions | undefined,
  state: {
    transferred: number;
    transferredBytes: number;
    scanned: number;
    totalSourceEntries?: number;
    currentPage?: number;
  },
  logger: Logger,
): Promise<{
  transferred: number;
  transferredBytes: number;
  cancelled: boolean;
  rejected: RejectedPutEntry[];
}> {
  if (entryIds.length === 0) {
    return {
      transferred: state.transferred,
      transferredBytes: state.transferredBytes,
      cancelled: false,
      rejected: [],
    };
  }

  const onProgress = options?.onProgress;
  const signal = options?.signal;
  const transferBatchSize = resolveTransferBatchSize(options);
  const totalTransferBatches = Math.max(1, Math.ceil(entryIds.length / transferBatchSize));
  // Parallel transfer window (sync-v5, phase 4): each batch is one getEntries +
  // putEntries round trip; a small window of concurrent batches overlaps
  // network latency and server-side crypto. Witness receipts are applied per
  // batch and are order-independent.
  const maxConcurrent = Math.min(
    Math.max(
      1,
      Math.floor(options?.maxConcurrentBatches ?? DEFAULT_MAX_CONCURRENT_TRANSFER_BATCHES),
    ),
    totalTransferBatches,
  );
  let transferred = state.transferred;
  let transferredBytes = state.transferredBytes;
  let cancelled = false;
  let firstError: unknown = null;
  let nextBatchIndex = 0;
  // Per-entry rejections reported by a witnessing target (sync-v5): the push
  // continues, the rejected entries are surfaced to the caller.
  const rejected: RejectedPutEntry[] = [];

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (firstError || cancelled || signal?.aborted) {
        if (signal?.aborted) cancelled = true;
        return;
      }
      const batchIndex = nextBatchIndex++;
      const offset = batchIndex * transferBatchSize;
      if (offset >= entryIds.length) {
        return;
      }

      const currentTransferBatch = batchIndex + 1;
      const batchIds = entryIds.slice(offset, offset + transferBatchSize);
      const pageSummary = state.currentPage ? `page ${state.currentPage}, ` : "";
      onProgress?.({
        phase: "transferring",
        message: `Transferring batch ${currentTransferBatch}/${totalTransferBatches} (${batchIds.length} entries, ${pageSummary}scanned ${state.scanned})...`,
        transferredEntries: transferred,
        transferredBytes,
        scannedEntries: state.scanned,
        totalSourceEntries: state.totalSourceEntries,
        currentPage: state.currentPage,
        currentTransferBatch,
        totalTransferBatches,
        transferBatchSize,
      });

      try {
        const batchEntries = await sourceStore.getEntries(batchIds);
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        const putResult = await targetStore.putEntries(batchEntries);
        // On push, the remote (witnessing) target returns receipts for accepted
        // entries; persist them back onto the local source so the revision feed
        // re-anchors them from the provisional head to their committed
        // `receivedAt` (docs/accesscontrol.md §5.3). Pull targets return void.
        // sync-v5 targets return a structured ack that additionally carries
        // per-entry rejections (signature-class failures the remote skipped).
        const { receipts, batchRejected } = normalizePutResult(putResult);
        if (receipts.length > 0 && sourceStore.applyWitnessReceipts) {
          await sourceStore.applyWitnessReceipts(receipts);
        }
        const rejectedIds =
          batchRejected.length > 0 ? new Set(batchRejected.map((entry) => entry.id)) : null;
        if (rejectedIds) {
          rejected.push(...batchRejected);
          logger.warn(
            `Target rejected ${batchRejected.length} of ${batchEntries.length} entries in transfer batch ${currentTransferBatch}/${totalTransferBatches}`,
          );
        }
        for (const entry of batchEntries) {
          if (rejectedIds?.has(entry.id)) {
            continue;
          }
          transferredBytes += entry.encryptedSize ?? entry.encryptedData.length;
        }
        transferred += batchEntries.length - batchRejected.length;
      } catch (error) {
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        if (!firstError) {
          firstError = error;
        }
        return;
      }

      onProgress?.({
        phase: "transferring",
        message: `Transferred ${transferred} entries after batch ${currentTransferBatch}/${totalTransferBatches}`,
        transferredEntries: transferred,
        transferredBytes,
        scannedEntries: state.scanned,
        totalSourceEntries: state.totalSourceEntries,
        currentPage: state.currentPage,
        currentTransferBatch,
        totalTransferBatches,
        transferBatchSize,
      });
    }
  };

  await Promise.all(Array.from({ length: maxConcurrent }, () => runWorker()));

  if (signal?.aborted || cancelled) {
    return { transferred, transferredBytes, cancelled: true, rejected };
  }
  if (firstError) {
    throw firstError;
  }
  return { transferred, transferredBytes, cancelled: false, rejected };
}

function supportsCursorScan(store: ContentAddressedStore): boolean {
  return typeof store.scanEntriesSince === "function";
}

/**
 * Reconcile `targetStore` with `sourceStore`: find the entries the target is
 * missing and transfer them.
 *
 * Takes the persisted-cursor fast path when the source supports
 * `scanEntriesSince`, otherwise falls back to the `getAllIds` + `findNewEntries`
 * path for older stores.
 */
export async function syncEntriesBetweenStores(
  sourceStore: ContentAddressedStore,
  targetStore: ContentAddressedStore,
  options: SyncOptions | undefined,
  ctx: SyncStoresContext,
): Promise<SyncStoresResult> {
  const { logger, cursors } = ctx;
  const holdCursorOnRejection = ctx.rejectionPolicy === "hold";
  let transferred = 0;
  let transferredBytes = 0;
  let scanned = 0;
  // Per-entry rejections reported by a witnessing target (sync-v5): the sync
  // completes; rejected entries are surfaced to the caller as warnings.
  const rejected: RejectedPutEntry[] = [];
  const onProgress = options?.onProgress;
  const pageSize = options?.pageSize ?? 1000;
  const signal = options?.signal;

  if (supportsCursorScan(sourceStore)) {
    // Persisted-cursor fast path (sync-v5, phase 1): resume the metadata scan
    // where the previous sync between this (source, target) pair left off — or
    // skip the sync entirely when the source head shows nothing new. The heads
    // are fetched up front (cheap; one request per side for network stores) and
    // also anchor the epochs persisted with the cursor.
    const cursorKey = syncScanCursorKey(sourceStore, targetStore);
    const persisted = options?.forceFullScan ? null : cursors.get(cursorKey);
    const [sourceHead, targetHead] = await Promise.all([
      getStoreHeadSafe(sourceStore, logger),
      getStoreHeadSafe(targetStore, logger),
    ]);

    let cursor: StoreScanCursor | null = null;
    if (persisted && sourceHead && targetHead) {
      if (
        persisted.sourceEpoch === sourceHead.epoch &&
        persisted.targetEpoch === targetHead.epoch
      ) {
        if (sourceHead.maxReceiptOrder <= persisted.cursor.receiptOrder) {
          logger.debug(
            `Sync skip: source head ${sourceHead.maxReceiptOrder} already covered by persisted cursor (${cursorKey})`,
          );
          onProgress?.({
            phase: "preparing",
            message: "Source unchanged since last sync, nothing to scan",
            transferredEntries: 0,
            scannedEntries: 0,
          });
          return { transferred: 0, scanned: 0, cancelled: false };
        }
        cursor = persisted.cursor;
        logger.debug(
          `Resuming sync scan from persisted cursor receiptOrder=${cursor.receiptOrder} (${cursorKey})`,
        );
      } else {
        // Epoch change on either side: the cursor lineage is broken (store
        // reset / receipt-order migration) — full rescan.
        logger.info(
          `Sync cursor epoch changed for ${cursorKey}, discarding persisted cursor and re-scanning`,
        );
        cursors.delete(cursorKey);
      }
    }

    // Under the "hold" rejection policy this pins the cursor to the position
    // immediately before the earliest rejected entry, so the next run re-offers
    // it instead of skipping it forever. Null means "nothing rejected yet".
    let heldCursor: StoreScanCursor | null = null;
    let cursorIsHeld = false;

    const persistScanCursor = (finalCursor: StoreScanCursor | null): void => {
      const effective = cursorIsHeld ? heldCursor : finalCursor;
      if (effective && sourceHead && targetHead) {
        cursors.save(cursorKey, {
          sourceEpoch: sourceHead.epoch,
          targetEpoch: targetHead.epoch,
          cursor: effective,
        });
      }
    };

    const targetBloom = await getStoreBloomSummary(targetStore, logger);
    // Fixed progress denominator: the SOURCE's total entry count. The cursor
    // scan below examines every source entry, so scannedEntries/totalSourceEntries
    // is a real completion ratio. (Local stores serve this from a cached bloom
    // summary; network stores answer with one extra request.) The target bloom
    // stays dedicated to missing-id pre-screening.
    const sourceBloom = await getStoreBloomSummary(sourceStore, logger);
    const totalSourceEstimate = sourceBloom?.totalIds;

    onProgress?.({
      phase: "preparing",
      message: "Preparing to sync entries...",
      transferredEntries: 0,
      scannedEntries: 0,
      totalSourceEntries: totalSourceEstimate,
    });

    // Upper scan bound: the source head captured BEFORE the scan started.
    // Pushing to a witnessing target re-anchors the just-transferred entries to
    // a fresh receiptOrder on the source (applyWitnessReceipts), i.e. past the
    // running cursor — without this bound the scan would re-discover its own
    // transfers and never terminate (first-sync loop). Entries beyond the bound
    // (re-anchored or written concurrently) are picked up by the next sync.
    const scanUpperBound = sourceHead?.maxReceiptOrder;
    // IDs already transferred in this sync session. Guards against re-pushing
    // entries the scan re-discovers when the target bloom snapshot is stale
    // (fetched once up front; empty on a first sync, so it would classify every
    // re-discovered id as "definitely missing" and skip the exact hasEntries
    // check).
    const transferredThisSync = new Set<string>();

    let currentPage = 0;
    // Scan-page pipelining (sync-v5, phase 4): while page N is being filtered
    // and transferred, page N+1 is already being fetched.
    let nextPagePromise: Promise<StoreScanResult> | null = null;
    const discardPrefetch = (): void => {
      // Swallow errors of an in-flight prefetch we will never consume
      // (abort/cancel paths) to avoid unhandled rejections.
      nextPagePromise?.catch(() => {});
      nextPagePromise = null;
    };
    while (true) {
      if (signal?.aborted) {
        discardPrefetch();
        persistScanCursor(cursor);
        return {
          transferred,
          transferredBytes,
          scanned,
          cancelled: true,
          rejected,
          cursorHeldForRetry: cursorIsHeld,
        };
      }

      const cursorAtPageStart = cursor;
      const page: StoreScanResult = nextPagePromise
        ? await nextPagePromise
        : await sourceStore.scanEntriesSince!(cursor, pageSize);
      nextPagePromise = page.hasMore
        ? sourceStore.scanEntriesSince!(page.nextCursor, pageSize)
        : null;
      currentPage++;

      // Clamp the page to the scan bound. Pages are ordered by
      // (receiptOrder, id), so everything past the first out-of-bound entry is
      // out of bound as well.
      let pageEntries = page.entries;
      let reachedScanBound = false;
      if (scanUpperBound !== undefined && pageEntries.length > 0) {
        const inBound = pageEntries.filter((m) => (m.receiptOrder ?? 0) <= scanUpperBound);
        if (inBound.length < pageEntries.length) {
          reachedScanBound = true;
          pageEntries = inBound;
        }
      }
      scanned += pageEntries.length;

      if (signal?.aborted) {
        discardPrefetch();
        persistScanCursor(cursor);
        return {
          transferred,
          transferredBytes,
          scanned,
          cancelled: true,
          rejected,
          cursorHeldForRetry: cursorIsHeld,
        };
      }

      if (pageEntries.length > 0) {
        onProgress?.({
          phase: "transferring",
          message: `Scanned ${scanned} entries, checking for changes (page ${currentPage})...`,
          transferredEntries: transferred,
          scannedEntries: scanned,
          totalSourceEntries: totalSourceEstimate,
          currentPage,
        });

        const ids = pageEntries.map((m) => m.id).filter((id) => !transferredThisSync.has(id));
        const missingIds =
          ids.length > 0 ? await filterMissingIds(targetStore, ids, targetBloom) : [];

        if (signal?.aborted) {
          discardPrefetch();
          persistScanCursor(cursor);
          return {
            transferred,
            transferredBytes,
            scanned,
            cancelled: true,
            rejected,
            cursorHeldForRetry: cursorIsHeld,
          };
        }

        if (missingIds.length > 0) {
          const transferResult = await transferEntriesInBatches(
            sourceStore,
            targetStore,
            missingIds,
            options,
            {
              transferred,
              transferredBytes,
              scanned,
              totalSourceEntries: totalSourceEstimate,
              currentPage,
            },
            logger,
          );
          transferred = transferResult.transferred;
          transferredBytes = transferResult.transferredBytes;
          rejected.push(...transferResult.rejected);

          // Clamp the cursor at the first rejection so the retry actually
          // re-offers the entry. Only the earliest one matters: everything
          // after it is re-scanned anyway.
          if (holdCursorOnRejection && transferResult.rejected.length > 0 && !cursorIsHeld) {
            const rejectedIds = new Set(transferResult.rejected.map((entry) => entry.id));
            const firstRejectedIndex = pageEntries.findIndex((m) => rejectedIds.has(m.id));
            if (firstRejectedIndex >= 0) {
              cursorIsHeld = true;
              const previous =
                firstRejectedIndex > 0 ? pageEntries[firstRejectedIndex - 1] : null;
              heldCursor = previous
                ? { receiptOrder: previous.receiptOrder ?? 0, id: previous.id }
                : cursorAtPageStart;
              logger.warn(
                `Holding sync cursor at receiptOrder=${heldCursor?.receiptOrder ?? "start"} for ${cursorKey}: ` +
                  `${transferResult.rejected.length} entr${transferResult.rejected.length === 1 ? "y was" : "ies were"} rejected and must be retried`,
              );
            }
          }

          if (transferResult.cancelled) {
            // The current page's transfer did not complete: persist the
            // boundary of the last fully transferred page instead.
            discardPrefetch();
            persistScanCursor(cursor);
            return {
              transferred,
              transferredBytes,
              scanned,
              cancelled: true,
              rejected,
              cursorHeldForRetry: cursorIsHeld,
            };
          }
          for (const id of missingIds) {
            transferredThisSync.add(id);
          }
        }
      }

      onProgress?.({
        phase: "transferring",
        message: `Transferred ${transferred} entries (page ${currentPage}, scanned ${scanned})`,
        transferredEntries: transferred,
        transferredBytes,
        scannedEntries: scanned,
        totalSourceEntries: totalSourceEstimate,
        currentPage,
      });

      if (reachedScanBound) {
        // Persist the last in-bound position (NOT page.nextCursor, which
        // already points into the out-of-bound tail): a concurrent write that
        // landed between the bound and the re-anchored tail must be scanned by
        // the next sync.
        const lastInBound = pageEntries.length > 0 ? pageEntries[pageEntries.length - 1] : null;
        if (lastInBound) {
          cursor = { receiptOrder: lastInBound.receiptOrder ?? 0, id: lastInBound.id };
        }
        discardPrefetch();
        break;
      }

      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }
    persistScanCursor(cursor);
    return {
      transferred,
      transferredBytes,
      scanned,
      cancelled: false,
      rejected,
      cursorHeldForRetry: cursorIsHeld,
    };
  }

  onProgress?.({
    phase: "preparing",
    message: "Finding new entries...",
    transferredEntries: 0,
    scannedEntries: 0,
  });

  const targetIds = await targetStore.getAllIds();
  const sourceNewMetadata = await sourceStore.findNewEntries(targetIds);
  if (sourceNewMetadata.length === 0) {
    return { transferred: 0, scanned: 0, cancelled: false };
  }

  if (options?.signal?.aborted) {
    return { transferred: 0, scanned: 0, cancelled: true };
  }

  onProgress?.({
    phase: "transferring",
    message: `Transferring ${sourceNewMetadata.length} entries...`,
    transferredEntries: transferred,
    scannedEntries: sourceNewMetadata.length,
    totalSourceEntries: sourceNewMetadata.length,
  });

  const transferResult = await transferEntriesInBatches(
    sourceStore,
    targetStore,
    sourceNewMetadata.map((m) => m.id),
    options,
    {
      transferred,
      transferredBytes,
      scanned: sourceNewMetadata.length,
      totalSourceEntries: sourceNewMetadata.length,
    },
    logger,
  );
  transferred = transferResult.transferred;
  transferredBytes = transferResult.transferredBytes;
  rejected.push(...transferResult.rejected);
  if (transferResult.cancelled) {
    return {
      transferred,
      transferredBytes,
      scanned: sourceNewMetadata.length,
      cancelled: true,
      rejected,
    };
  }

  onProgress?.({
    phase: "transferring",
    message: `Transferred ${transferred} entries`,
    transferredEntries: transferred,
    transferredBytes,
    scannedEntries: sourceNewMetadata.length,
    totalSourceEntries: sourceNewMetadata.length,
  });

  return {
    transferred,
    transferredBytes,
    scanned: sourceNewMetadata.length,
    cancelled: false,
    rejected,
  };
}
