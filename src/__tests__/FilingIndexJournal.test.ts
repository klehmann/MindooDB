import type { MindooDB } from "../core/types";
import { FilingIndex } from "../core/filing";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

/** A fresh index instance over the same cache key (another tab / a restart). */
async function freshIndex(db: MindooDB, cacheManager: CacheManager, prefix: string): Promise<FilingIndex> {
  const filing = db.filing!("mail");
  const idPrefix = (await filing.getIndex()).getCachePrefix().split("/").pop()!;
  const index = new FilingIndex(db, "mail", idPrefix);
  index.attachCache(cacheManager, prefix);
  return index;
}

describe("filing index cache: snapshot + journal", () => {
  let db: MindooDB;
  beforeEach(async () => {
    const ctx = await createWitnessingTenant("tenant-filing-journal");
    db = await ctx.tenant.openDB("mail");
  }, 30000);

  it("appends small journal segments and restores snapshot + journal", async () => {
    const filing = db.filing!("mail");
    for (let i = 0; i < 30; i++) {
      await filing.add(`doc_${i}`, i % 2 ? "odd" : "even");
    }
    const store = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(store, { flushIntervalMs: 600000 });
    const index = await freshIndex(db, cacheManager, "journal-index");
    await index.update();
    await index.flushToCache(store); // first flush: snapshot
    expect(await store.list("filing")).toEqual(["journal-index"]);
    const snapshotSize = (await store.get("filing", "journal-index"))!.length;

    const put = jest.spyOn(store, "put");
    await filing.move("doc_0", { from: "even", to: "done" });
    await filing.createFolder({ name: "Done", folderId: "done" });
    await index.update();
    await index.flushToCache(store);
    expect(put.mock.calls.map(([type]) => type)).toEqual(["filingj"]);
    expect((put.mock.calls[0][2] as Uint8Array).length).toBeLessThan(snapshotSize / 3);
    put.mockRestore();

    const restored = await freshIndex(db, cacheManager, "journal-index");
    await restored.update();
    const physical = (docId: string) => `${db.getTenant().getId()}/mail/${docId}`;
    expect(restored.foldersOf(physical("doc_0"))).toEqual(["done"]);
    expect(restored.foldersOf(physical("doc_1"))).toEqual(["odd"]);
    expect(restored.getFolder("done")?.name).toBe("Done");
    expect(restored.membersOf("even")).toHaveLength(14);
    await cacheManager.dispose();
  }, 60000);

  it("keeps two writers on one key apart and survives a failed write", async () => {
    const filing = db.filing!("mail");
    await filing.add("doc_a", "inbox");
    const store = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(store, { flushIntervalMs: 600000 });
    const a = await freshIndex(db, cacheManager, "two-writers");
    const b = await freshIndex(db, cacheManager, "two-writers");
    await a.update();
    await b.update();
    await a.flushToCache(store);
    await b.flushToCache(store); // b's snapshot replaces a's
    await filing.add("doc_b", "inbox");
    await a.update();
    await a.flushToCache(store); // a's chain (no longer continued by the snapshot)
    await b.flushToCache(store); // b: nothing new, older cursor
    await filing.add("doc_c", "inbox");
    await b.update();
    const put = jest.spyOn(store, "put").mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
    await expect(b.flushToCache(store)).rejects.toThrow(/ENOSPC/);
    put.mockRestore();
    await b.flushToCache(store); // retried with the pending changes

    const restored = await freshIndex(db, cacheManager, "two-writers");
    await restored.update();
    expect(restored.membersOf("inbox").map((ref) => ref.split("/").pop()).sort()).toEqual(["doc_a", "doc_b", "doc_c"]);
    await cacheManager.dispose();
  }, 60000);
});
