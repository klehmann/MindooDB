import type { StoreEntryMetadata } from "../types";
import type { StoreScanCursor, StoreScanFilters, StoreScanResult } from "./types";

/**
 * Shared helpers for cursor-based metadata scans over content-addressed
 * stores. All stores order scans by `(receiptOrder ASC, id ASC)`; these
 * utilities implement the doc-scoped fast path so a `docId`-filtered scan
 * costs O(entries of that document) instead of O(entries in the store).
 */

/** Canonical scan ordering: `(receiptOrder ?? 0) ASC, id ASC`. */
export function compareByReceiptOrderAndId(
  a: StoreEntryMetadata,
  b: StoreEntryMetadata,
): number {
  const orderA = a.receiptOrder ?? 0;
  const orderB = b.receiptOrder ?? 0;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether `meta` sorts strictly after the (exclusive) scan cursor. */
export function isAfterScanCursor(
  meta: StoreEntryMetadata,
  cursor: StoreScanCursor,
): boolean {
  const order = meta.receiptOrder ?? 0;
  return (
    order > cursor.receiptOrder ||
    (order === cursor.receiptOrder && meta.id > cursor.id)
  );
}

/**
 * Test whether a metadata entry passes the given scan filters
 * (docId, entryTypes whitelist, creation-date range).
 */
export function metadataMatchesScanFilters(
  meta: StoreEntryMetadata,
  filters?: StoreScanFilters,
): boolean {
  if (filters?.docId && meta.docId !== filters.docId) {
    return false;
  }
  if (
    filters?.entryTypes &&
    filters.entryTypes.length > 0 &&
    !filters.entryTypes.includes(meta.entryType)
  ) {
    return false;
  }
  if (
    filters?.creationDateFrom !== undefined &&
    filters.creationDateFrom !== null &&
    meta.createdAt < filters.creationDateFrom
  ) {
    return false;
  }
  if (
    filters?.creationDateUntil !== undefined &&
    filters.creationDateUntil !== null &&
    meta.createdAt >= filters.creationDateUntil
  ) {
    return false;
  }
  return true;
}

/**
 * Doc-scoped implementation of `scanEntriesSince`: takes the (unsorted)
 * metadata of a single document — resolved through a store's docId index —
 * and applies the canonical scan ordering, cursor, remaining filters and
 * limit. The result contract matches the full-store scan exactly
 * (`entries` in `(receiptOrder, id)` order, `nextCursor` pointing at the
 * last returned entry, `hasMore` when further matching entries exist).
 */
export function scanDocScopedEntries(
  docEntries: StoreEntryMetadata[],
  cursor: StoreScanCursor | null,
  limit: number,
  filters?: StoreScanFilters,
): StoreScanResult {
  const sorted = [...docEntries].sort(compareByReceiptOrderAndId);

  const page: StoreEntryMetadata[] = [];
  let hasMore = false;
  for (const meta of sorted) {
    if (cursor !== null && !isAfterScanCursor(meta, cursor)) {
      continue;
    }
    if (!metadataMatchesScanFilters(meta, filters)) {
      continue;
    }
    if (page.length < limit) {
      page.push(meta);
    } else {
      hasMore = true;
      break;
    }
  }

  const last = page.length > 0 ? page[page.length - 1] : null;
  return {
    entries: page,
    nextCursor: last ? { receiptOrder: last.receiptOrder ?? 0, id: last.id } : cursor,
    hasMore,
  };
}
