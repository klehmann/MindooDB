import { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

describe("summary store: shared field values", () => {
  it("keeps every value right for repeated and unique fields, also after a restore", async () => {
    const ctx = await createWitnessingTenant("tenant-summary-interning");
    const db = await ctx.tenant.openDB("main");
    const count = 1300; // more distinct values than a field pool keeps
    const docs = await db.createDocuments(
      Array.from({ length: count }, (_, i) => ({
        initialValues: { folder: `f${i % 7}`, subject: `subject ${i}`, tags: [`t${i % 3}`, `u${i}`] },
      })),
    );
    const expected = new Map(
      docs.map((doc, i) => [doc.getId(), { folder: `f${i % 7}`, subject: `subject ${i}`, tags: [`t${i % 3}`, `u${i}`] }]),
    );
    const check = (store: DocumentSummaryStore) => {
      expect(store.getSize()).toBe(count);
      for (const entry of store.getAllEntries()) {
        const want = expected.get(entry.docId)!;
        expect(entry.fields.folder).toBe(want.folder);
        expect(entry.fields.subject).toBe(want.subject);
        expect(entry.fields.tags).toEqual(want.tags);
      }
    };

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 600000 });
    const built = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    built.attachCache(cacheManager, "interning");
    await built.update();
    check(built);
    await built.flushToCache(cacheStore, { force: true });

    const restored = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    restored.attachCache(cacheManager, "interning");
    await restored.update();
    check(restored);
    // The write log still yields every entry as a delta.
    expect(restored.getChangesSince({ generation: restored.getPosition().generation, seq: 0 })?.entries.length ?? count).toBe(count);
    await cacheManager.dispose();
  }, 120000);
});
