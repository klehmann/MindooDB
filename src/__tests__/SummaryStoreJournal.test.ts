import type { MindooDB } from "../core/types";
import { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

async function change(db: MindooDB, docId: string, values: Record<string, unknown>): Promise<void> {
  const doc = await db.getDocument(docId);
  await db.changeDoc(doc, (d) => {
    Object.assign(d.getData(), values);
  });
}

function fields(store: DocumentSummaryStore): Record<string, unknown> {
  return Object.fromEntries(Array.from(store.getAllEntries(), (entry) => [entry.docId, entry.fields.subject]));
}

describe("summary cache: snapshot + journal", () => {
  let db: MindooDB;
  let ids: string[];
  beforeEach(async () => {
    const ctx = await createWitnessingTenant("tenant-summary-journal");
    db = await ctx.tenant.openDB("main");
    const docs = await db.createDocuments(
      Array.from({ length: 600 }, (_, i) => ({ initialValues: { subject: `s${i}`, body: "x".repeat(200) } })),
    );
    ids = docs.map((doc) => doc.getId());
  }, 60000);

  it("appends the changed entries instead of rewriting buckets, and restores", async () => {
    const store = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(store, { flushIntervalMs: 600000 });
    const s1 = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    s1.attachCache(cacheManager, "sum");
    await s1.update();
    await s1.flushToCache(store); // first flush: buckets + meta

    const put = jest.spyOn(store, "put");
    await change(db, ids[0], { subject: "changed" });
    await db.deleteDocument(ids[1]);
    await s1.update();
    await s1.flushToCache(store);
    expect(put.mock.calls.map(([type]) => type)).toEqual(["summaryj"]);
    const segmentBytes = (put.mock.calls[0][2] as Uint8Array).length;
    put.mockRestore();
    const bucketBytes = (await store.get("summary", "sum/bucket/0"))!.length;
    // One changed entry + one removal versus a whole bucket (~1/64 of 600).
    expect(segmentBytes).toBeLessThan(bucketBytes);

    const s2 = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    s2.attachCache(cacheManager, "sum");
    await s2.update();
    expect(fields(s2)).toEqual(fields(s1));
    expect(fields(s2)[ids[0]]).toBe("changed");
    expect(fields(s2)[ids[1]]).toBeUndefined();
    await cacheManager.dispose();
  }, 60000);

  it("keeps two writers apart and survives a failed write", async () => {
    const store = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(store, { flushIntervalMs: 600000 });
    const a = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    const b = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    a.attachCache(cacheManager, "two");
    b.attachCache(cacheManager, "two");
    await a.update();
    await b.update();
    await a.flushToCache(store);
    await b.flushToCache(store); // b's snapshot replaces a's
    await change(db, ids[2], { subject: "by a" });
    await a.update();
    await a.flushToCache(store);
    await b.flushToCache(store); // b behind: older cursor, own chain
    await change(db, ids[3], { subject: "later" });
    await b.update();
    const put = jest.spyOn(store, "put").mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
    await expect(b.flushToCache(store)).rejects.toThrow(/ENOSPC/);
    put.mockRestore();
    await b.flushToCache(store);

    const c = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    c.attachCache(cacheManager, "two");
    await c.update();
    expect(fields(c)[ids[2]]).toBe("by a");
    expect(fields(c)[ids[3]]).toBe("later");
    expect(Object.keys(fields(c))).toHaveLength(600);
    await cacheManager.dispose();
  }, 60000);
});
