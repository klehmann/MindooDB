/**
 * A source store whose cursor lineage breaks while a sync is running (the
 * server moved the database to another backend, or reset it): scan pages
 * carry the store's epoch, and the client restarts with a full scan instead
 * of continuing with a cursor from the old numbering.
 */
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import type {
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
} from "../core/appendonlystores/types";
import {
  syncEntriesBetweenStores,
  type SyncScanCursorRecord,
  type SyncScanCursorStore,
} from "../core/appendonlystores/syncStores";
import type { Logger } from "../core/logging";
import type { ContentAddressedStore, StoreEntry } from "../core/types";

const silentLogger = {
  error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
} as unknown as Logger;

function createCursorStore(): SyncScanCursorStore {
  const records = new Map<string, SyncScanCursorRecord>();
  return {
    get: (key) => records.get(key) ?? null,
    save: (key, record) => void records.set(key, record),
    delete: (key) => void records.delete(key),
  };
}

function entry(id: string): StoreEntry {
  const encryptedData = new Uint8Array([1, 2, 3]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId: "doc1",
    dependencyIds: [],
    createdAt: 1000,
    createdByPublicKey: "test-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([4, 5]),
    originalSize: encryptedData.length,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

/**
 * A source that answers from `before` until its first scan page was served,
 * then from `after` (with a different epoch and numbering). Pages report the
 * epoch of the store that answered them, unless `withEpoch` is false (an old
 * server).
 */
function switchingSource(before: InMemoryContentAddressedStore, after: InMemoryContentAddressedStore, withEpoch = true) {
  let current: InMemoryContentAddressedStore = before;
  let scans = 0;
  const source = Object.create(after) as ContentAddressedStore;
  source.getStoreHead = () => current.getStoreHead();
  source.getEntries = (list: string[]) => current.getEntries(list);
  source.getAllIds = () => current.getAllIds();
  source.getIdBloomSummary = () => current.getIdBloomSummary();
  source.scanEntriesSince = async (cursor: StoreScanCursor | null, limit?: number, filters?: StoreScanFilters) => {
    const store = current;
    const page: StoreScanResult = await store.scanEntriesSince(cursor, limit, filters);
    if (++scans === 1) {
      current = after; // the move completes right after the first page
    }
    return withEpoch ? { ...page, epoch: (await store.getStoreHead()).epoch } : page;
  };
  return source;
}

async function storesWithSwitch() {
  const old = ids("e", 30);
  const before = new InMemoryContentAddressedStore("db", StoreKind.docs);
  await before.putEntries(old.map(entry));
  // The new numbering puts entries the old cursor has "passed" at the front.
  const after = new InMemoryContentAddressedStore("db", StoreKind.docs);
  await after.putEntries([...ids("n", 10), ...old].map(entry));
  return { before, after, all: [...ids("n", 10), ...old].sort() };
}

describe("sync when the source epoch changes mid-run", () => {
  it("restarts with a full scan and transfers everything", async () => {
    const { before, after, all } = await storesWithSwitch();
    expect((await before.getStoreHead()).epoch).not.toBe((await after.getStoreHead()).epoch);
    const target = new InMemoryContentAddressedStore("db", StoreKind.docs);

    const result = await syncEntriesBetweenStores(
      switchingSource(before, after),
      target,
      { pageSize: 10 },
      { logger: silentLogger, cursors: createCursorStore() },
    );

    expect((await target.getAllIds()).sort()).toEqual(all);
    expect(result.cancelled).toBe(false);
  });

  it("without page epochs (older servers) the run misses entries until the next sync", async () => {
    const { before, after, all } = await storesWithSwitch();
    const target = new InMemoryContentAddressedStore("db", StoreKind.docs);
    const cursors = createCursorStore();

    await syncEntriesBetweenStores(switchingSource(before, after, false), target, { pageSize: 10 }, {
      logger: silentLogger,
      cursors,
    });
    const afterFirstRun = (await target.getAllIds()).length;
    expect(afterFirstRun).toBeLessThan(all.length);

    // The next run sees the new epoch in the head and rescans fully.
    await syncEntriesBetweenStores(after, target, { pageSize: 10 }, { logger: silentLogger, cursors });
    expect((await target.getAllIds()).sort()).toEqual(all);
  });
});
