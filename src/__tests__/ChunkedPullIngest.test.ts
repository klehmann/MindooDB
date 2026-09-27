import type { DbChangeEvent, MindooDB } from "../core/types";
import { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";
import { addPerson, makeTenant, type DeviceHandle } from "./_helpers/multiDevice";
import type { ContentAddressedStore } from "../core/types";

/**
 * Delay entry fetches like a network round trip. In-memory stores resolve on
 * microtasks only, so without it a pull never yields to the (macrotask-bound)
 * crypto of a concurrent materialization.
 */
function withNetworkLatency(store: ContentAddressedStore, ms: number): ContentAddressedStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "getEntries" && typeof value === "function") {
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A docs pull processes every transferred scan page right away, so the local
 * index and changefeed consumers (summary buffer) catch up chunk by chunk
 * while the transfer is still running, instead of in one burst at the end.
 */
describe("chunked pull ingest", () => {
  const DB_ID = "crm";
  let host: DeviceHandle;
  let device: DeviceHandle;
  let hostDb: MindooDB;

  beforeEach(async () => {
    const fixture = await makeTenant({ tenantId: "tenant-chunked-pull" });
    host = fixture.host;
    device = await addPerson(fixture, "bob");
    hostDb = await host.tenant.openDB(DB_ID);

    const deviceDirectory = await device.tenant.openDB("directory", { adminOnlyDb: true });
    await deviceDirectory.pullChangesFrom((await host.tenant.openDB("directory", { adminOnlyDb: true })).getStore());
  }, 60000);

  async function createDocs(count: number, prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const doc = await hostDb.createDocument();
      await hostDb.changeDoc(doc, (d) => {
        const data = d.getData();
        data.name = `${prefix}-${i}`;
        data.amount = i;
      });
      ids.push(doc.getId());
    }
    return ids;
  }

  it("emits one ingest event per transferred page and advances the index during the pull", async () => {
    await createDocs(12, "doc");
    const deviceDb = await device.tenant.openDB(DB_ID);

    const ingestEvents: DbChangeEvent[] = [];
    const indexSizesDuringPull: number[] = [];
    const unsubscribe = deviceDb.addChangeListener!((event) => {
      if (event.origin === "ingest") {
        ingestEvents.push(event);
      }
    });

    await deviceDb.pullChangesFrom(hostDb.getStore(), {
      pageSize: 4,
      onProgress: (progress) => {
        if (progress.phase === "transferring") {
          indexSizesDuringPull.push(deviceDb.countChangesSince!(null));
        }
      },
    });
    unsubscribe();

    // 12 docs × 2 entries (create + change) = 24 entries → 6 pages of 4.
    expect(ingestEvents.length).toBeGreaterThan(1);
    const docIdsSeen = new Set(ingestEvents.flatMap((e) => e.changes.map((c) => c.docId)));
    expect(docIdsSeen.size).toBe(12);
    // Documents became visible locally before the transfer finished.
    expect(indexSizesDuringPull.some((size) => size > 0 && size < 12)).toBe(true);

    const ids = await deviceDb.getAllDocumentIds();
    expect(ids).toHaveLength(12);
  }, 60000);

  it("converges when a document's entries are split across pages", async () => {
    const [first] = await createDocs(1, "first");
    await createDocs(6, "filler");
    // A later change to the first doc lands pages after its creation.
    const doc = await hostDb.getDocument(first);
    await hostDb.changeDoc(doc, (d) => {
      d.getData().name = "renamed";
      d.getData().amount = 999;
    });

    const deviceDb = await device.tenant.openDB(DB_ID);
    const summary = deviceDb.getSummaryStore!();
    // Without artificial latency the summary's materializations overlap the
    // ingest of later pages: a load that read a doc's metadata before its
    // next page was indexed must not end up in the document cache.
    await deviceDb.pullChangesFrom(hostDb.getStore(), { pageSize: 3 });

    const synced = await deviceDb.getDocument(first);
    expect(synced.getData().name).toBe("renamed");
    expect(synced.getData().amount).toBe(999);

    await summary.update();
    expect(summary.getSize()).toBe(7);
    expect(summary.getEntry(first)?.fields).toMatchObject({ name: "renamed", amount: 999 });
    // Every summary entry (and every read) reflects the complete history,
    // even for documents materialized while later pages were still arriving.
    for (const entry of summary.getAllEntries()) {
      expect(typeof entry.fields.name).toBe("string");
      const synced = await deviceDb.getDocument(entry.docId);
      expect(synced.getData().name).toBe(entry.fields.name);
    }

    const result = await deviceDb.query!({ filter: 'v.eq(v.field("amount"), 999)' });
    expect(result.rows.map((row) => row.docId)).toEqual([first]);
  }, 60000);

  it("lets an activated summary fill up while the pull is still transferring", async () => {
    await createDocs(15, "doc");
    const deviceDb = await device.tenant.openDB(DB_ID);
    const summary = deviceDb.getSummaryStore!();

    const summarySizesDuringPull: number[] = [];
    await deviceDb.pullChangesFrom(withNetworkLatency(hostDb.getStore(), 30), {
      pageSize: 5,
      onProgress: (progress) => {
        if (progress.phase === "transferring") {
          summarySizesDuringPull.push(summary.getSize());
        }
      },
    });

    // The auto-follow ran between pages, not only after the transfer.
    expect(summarySizesDuringPull.some((size) => size > 0 && size < 15)).toBe(true);

    await summary.update();
    expect(summary.getSize()).toBe(15);
  }, 60000);

  it("handles one-entry pages", async () => {
    await createDocs(3, "doc");
    const deviceDb = await device.tenant.openDB(DB_ID);
    const result = await deviceDb.pullChangesFrom(hostDb.getStore(), { pageSize: 1 });
    expect(result.cancelled).toBe(false);
    expect(await deviceDb.getAllDocumentIds()).toHaveLength(3);
  }, 60000);
});

/**
 * Summary persistence while an update run is in flight: periodic flushes are
 * throttled, and state that changes during a flush's writes stays dirty.
 */
describe("summary flush during catch-up", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-summary-flush");
    db = await ctx.tenant.openDB("flush-db");
    for (let i = 0; i < 6; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        d.getData().name = `doc-${i}`;
      });
    }
  }, 30000);

  it("defers periodic flushes while an update runs, but not forced ones", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });
    const summary = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 60000 });
    summary.attachCache(cacheManager, "flushdb/summary");

    let flushResults: number[] = [];
    let forcedWritten = -1;
    await summary.update({
      applyBatchSize: 2,
      onProgress: () => {
        // Called mid-run (update in flight): first flush lands, later ones
        // within the interval are deferred.
        void summary.flushToCache(cacheStore).then((n) => flushResults.push(n));
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushResults[0]).toBeGreaterThan(0);
    expect(flushResults.slice(1).every((n) => n === 0)).toBe(true);
    expect(summary.hasDirtyState()).toBe(true);

    // A forced flush (shutdown) is never deferred.
    const pending = summary.update();
    forcedWritten = await summary.flushToCache(cacheStore, { force: true });
    await pending;
    expect(forcedWritten).toBeGreaterThan(0);

    flushResults = [];
    await cacheManager.dispose();
  }, 30000);

  it("keeps buckets dirty that change while a flush is writing", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    let releasePut: (() => void) | null = null;
    const originalPut = cacheStore.put.bind(cacheStore);
    let blockNextPut = true;
    cacheStore.put = async (type, id, value) => {
      if (blockNextPut) {
        blockNextPut = false;
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
      }
      return originalPut(type, id, value);
    };
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });
    const summary = new DocumentSummaryStore(db);
    summary.attachCache(cacheManager, "flushdb/summary");
    await summary.update();

    const flushing = cacheManager.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releasePut).not.toBeNull();

    // A new document arrives and is summarized while the flush is blocked.
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "late";
    });
    await summary.update();

    releasePut!();
    await flushing;

    // The late change was not part of the flushed snapshot: still dirty.
    expect(summary.hasDirtyState()).toBe(true);
    await cacheManager.flush();
    expect(summary.hasDirtyState()).toBe(false);

    // A restart restores it from the cache without re-reading the feed.
    const restored = new DocumentSummaryStore(db);
    restored.attachCache(cacheManager, "flushdb/summary");
    let processed = -1;
    await restored.update({ onProgress: (p) => { processed = p.processed; } });
    expect(processed).toBe(0);
    expect(restored.getEntry(doc.getId())?.fields.name).toBe("late");

    await cacheManager.dispose();
  }, 30000);
});
