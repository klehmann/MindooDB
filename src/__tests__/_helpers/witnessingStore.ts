import { InMemoryContentAddressedStore } from "../../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreEntry,
  StoreEntryMetadata,
  StoreKind,
} from "../../core/types";

/**
 * Test-only in-memory store that simulates a witness: it stamps a `receivedAt`
 * (the access-control trusted time) on every entry as it is persisted, using a
 * monotonic per-store clock so trusted time equals receipt order (distinct and
 * increasing). This lets time-travel tests exercise the witnessed path
 * deterministically without standing up a real witness/server.
 *
 * It also exposes test hooks to rewrite an entry's `receivedAt` out of order and
 * to re-stamp an entry with a fresh `receiptOrder` (modeling the witness
 * write-back path), so out-of-trusted-time-order arrivals and re-stamps can be
 * simulated.
 */
export class WitnessingInMemoryContentAddressedStore extends InMemoryContentAddressedStore {
  private witnessClock = 0;
  /** When false, entries are persisted un-witnessed (no receivedAt). */
  witnessingEnabled = true;

  override async putEntries(entries: StoreEntry[]): Promise<void> {
    const stamped = entries.map((entry) => {
      if (entry.receivedAt !== undefined || !this.witnessingEnabled) {
        return entry;
      }
      return { ...entry, receivedAt: this.nextWitnessTime() };
    });
    return super.putEntries(stamped);
  }

  /** The next monotonic witness timestamp. */
  nextWitnessTime(): number {
    return ++this.witnessClock;
  }

  /** Internal metadata map of the base store (test-only access). */
  private metaMap(): Map<string, StoreEntryMetadata> {
    return (this as unknown as { entries: Map<string, StoreEntryMetadata> }).entries;
  }

  private invalidateSortCache(): void {
    (this as unknown as { sortedEntriesCache: unknown }).sortedEntriesCache = null;
  }

  /** Overwrite an entry's `receivedAt` (e.g. to create an out-of-order arrival). */
  forceReceivedAt(entryId: string, receivedAt: number): void {
    const meta = this.metaMap().get(entryId);
    if (!meta) throw new Error(`forceReceivedAt: entry ${entryId} not found`);
    meta.receivedAt = receivedAt;
    this.invalidateSortCache();
  }

  /** Make an entry un-witnessed again (clear its `receivedAt`). */
  clearReceivedAt(entryId: string): void {
    const meta = this.metaMap().get(entryId);
    if (!meta) throw new Error(`clearReceivedAt: entry ${entryId} not found`);
    delete meta.receivedAt;
    this.invalidateSortCache();
  }

  /**
   * Strip an entry's `entryVersion` so it looks like a pre-witness LEGACY entry
   * (written before the witness era). A legacy un-witnessed entry resolves its
   * trusted time to its stable `createdAt`, unlike a versioned un-witnessed
   * entry which floats to the provisional `now`. See
   * `core/storeEntryTime.ts` `entryTrustedTime` / `isProvisional`.
   */
  clearEntryVersion(entryId: string): void {
    const meta = this.metaMap().get(entryId);
    if (!meta) throw new Error(`clearEntryVersion: entry ${entryId} not found`);
    delete meta.entryVersion;
    this.invalidateSortCache();
  }

  /**
   * Re-stamp an entry as witnessed and move it to the tail of `receiptOrder`,
   * modeling the witness write-back (re-put) path so the revision feed's
   * receiptOrder cursor re-discovers it on the next scan.
   */
  restampWithFreshReceiptOrder(entryId: string, receivedAt: number): void {
    const meta = this.metaMap().get(entryId);
    if (!meta) throw new Error(`restampWithFreshReceiptOrder: entry ${entryId} not found`);
    meta.receivedAt = receivedAt;
    const self = this as unknown as { nextReceiptOrder: number };
    meta.receiptOrder = self.nextReceiptOrder++;
    this.invalidateSortCache();
  }
}

/** Store factory producing {@link WitnessingInMemoryContentAddressedStore} doc stores. */
export class WitnessingInMemoryContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  /** Doc stores created so far, keyed by db id (for test inspection / stamping). */
  readonly docStores = new Map<string, WitnessingInMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    const docStore = new WitnessingInMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options);
    this.docStores.set(dbId, docStore);
    return {
      docStore,
      attachmentStore: new WitnessingInMemoryContentAddressedStore(
        dbId,
        StoreKind.attachments,
        undefined,
        options,
      ),
    };
  }
}
