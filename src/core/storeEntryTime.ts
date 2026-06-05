import type { StoreEntryMetadata } from "./types";

/**
 * Shared trusted-time / provisional helpers for store entries.
 *
 * These centralize the version-aware trusted-time rule (see
 * {@link StoreEntryMetadata.entryVersion}) so the changefeed, document
 * materialization, the access-control judgment site, and the per-document
 * "awaiting witness" flag all agree on what a store entry's trusted time is
 * and whether it is still provisional.
 */

/**
 * Whether an entry is "provisional": versioned (written in the witness-aware
 * era) but not yet witnessed, so its trusted time is the wall-clock `now` and
 * will move until a trusted witness stamps it with a `receivedAt`.
 *
 * Legacy entries (no {@link StoreEntryMetadata.entryVersion}) are NOT
 * provisional even when un-witnessed: they were written before the witness era,
 * are already synced within the tenant, and will never be witnessed — their
 * trusted time is stable at `createdAt`.
 */
export function isProvisional(meta: StoreEntryMetadata): boolean {
  return meta.receivedAt === undefined && meta.entryVersion !== undefined;
}

/**
 * Whether an entry was written in the witness-aware era (carries an
 * {@link StoreEntryMetadata.entryVersion}). Legacy entries predate witnessing
 * and are never `versioned`.
 */
export function isVersioned(meta: StoreEntryMetadata): boolean {
  return meta.entryVersion !== undefined;
}

/**
 * Doc-level witness state derived from all of a document's replay entries.
 *
 * - `awaitingWitness`: at least one entry is provisional (versioned but not yet
 *   witnessed) — the document was created/edited locally and is still waiting to
 *   be pushed to a trusted server.
 * - `witnessed`: the document is witness-era (has at least one versioned entry)
 *   AND no entry is still provisional — every versioned entry carries a
 *   `receivedAt`. Legacy documents (no versioned entries) are neither
 *   `awaitingWitness` nor `witnessed`.
 *
 * The two flags are mutually exclusive and computed from the same predicates as
 * the trusted-time rule so they cannot drift.
 */
export function metadataWitnessState(
  metas: StoreEntryMetadata[],
): { awaitingWitness: boolean; witnessed: boolean } {
  const awaitingWitness = metas.some(isProvisional);
  const witnessed = !awaitingWitness && metas.some(isVersioned);
  return { awaitingWitness, witnessed };
}

/**
 * The trusted time (ms since epoch) used to order an entry on the changefeed
 * and to pick the directory node it is judged against.
 *
 * - **Witnessed** (`receivedAt` present): the provable acceptance time.
 * - **Versioned + un-witnessed** (provisional): the provided `now` — the entry
 *   floats to the provisional head and cannot claim a historical slot.
 * - **Legacy + un-witnessed**: the entry's own `createdAt` — a stable
 *   historical position (it predates witnessing and will never be witnessed).
 */
export function entryTrustedTime(meta: StoreEntryMetadata, now: number): number {
  if (meta.receivedAt !== undefined) {
    return meta.receivedAt;
  }
  return meta.entryVersion !== undefined ? now : meta.createdAt;
}
