import type { MindooDB } from "../core/types";
import type { BaseMindooDB } from "../core/BaseMindooDB";
import {
  ColumnSorting,
  SelectedOnly,
  VirtualViewFactory,
  type VirtualView,
} from "../core/indexing/virtualviews";
import { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import { createViewLanguage } from "../core/expressions";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

const v = createViewLanguage<{ type: string; subject: string; folder: string; n: number }>();

async function createDoc(db: MindooDB, values: Record<string, unknown>): Promise<string> {
  const doc = await db.createDocument();
  await db.changeDoc(doc, (d) => {
    Object.assign(d.getData(), values);
  });
  return doc.getId();
}

async function change(db: MindooDB, docId: string, values: Record<string, unknown>): Promise<void> {
  const doc = await db.getDocument(docId);
  await db.changeDoc(doc, (d) => {
    Object.assign(d.getData(), values);
  });
}

async function rows(view: VirtualView): Promise<string[]> {
  const nav = VirtualViewFactory.createNavigator(view).build().expandAll();
  const result: string[] = [];
  for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
    if (entry.isDocument()) {
      const parent = entry.getParent();
      const category = parent && parent.getParent() ? String(parent.getCategoryValue()) : "-";
      result.push(`${category} > ${entry.getColumnValues().subject}`);
    }
  }
  return result;
}

function buildView(db: MindooDB) {
  return VirtualViewFactory.createView()
    .addCategoryColumn("folder")
    .addSortedColumn("n", ColumnSorting.ASCENDING)
    .addDisplayColumn("subject")
    .withDB("main", db, v.eq(v.field("type"), "message"))
    .build();
}

describe("DocumentSummaryStore.getChangesSince", () => {
  let db: MindooDB;
  beforeEach(async () => {
    const ctx = await createWitnessingTenant("tenant-summary-delta");
    db = await ctx.tenant.openDB("main");
  }, 30000);

  it("returns only the entries written and removed after a position", async () => {
    const a = await createDoc(db, { type: "message", subject: "a", n: 1 });
    const b = await createDoc(db, { type: "message", subject: "b", n: 2 });
    const c = await createDoc(db, { type: "message", subject: "c", n: 3 });
    const summary = db.getSummaryStore!();
    await summary.update();
    const p1 = summary.getPosition();
    expect(summary.getChangesSince(p1)).toMatchObject({ entries: [], removedDocIds: [] });

    await change(db, b, { subject: "b2" });
    await change(db, b, { subject: "b3" });
    await db.deleteDocument(c);
    await summary.update();
    const delta = summary.getChangesSince(p1)!;
    expect(delta.entries.map((e) => [e.docId, e.fields.subject])).toEqual([[b, "b3"]]);
    expect(delta.removedDocIds).toEqual([c]);
    expect(delta.seq).toBe(summary.getPosition().seq);
    expect(summary.getChangesSince(null)).toBeNull();
    expect(summary.getChangesSince({ generation: "other", seq: 0 })).toBeNull();

    // Removing a document from the summary directly (purge path) counts too.
    const p2 = summary.getPosition();
    summary.removeDocument(a);
    expect(summary.getChangesSince(p2)!.removedDocIds).toEqual([a]);

    summary.reset();
    expect(summary.getChangesSince(p2)).toBeNull();
  }, 60000);

  it("never hands out a sequence number twice after restoring an older cache state", async () => {
    const a = await createDoc(db, { type: "message", subject: "a", n: 1 });
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 600000 });
    const s1 = new DocumentSummaryStore(db);
    s1.attachCache(cacheManager, "delta-restore");
    await s1.update();
    const persisted = s1.getPosition();
    await s1.flushToCache(cacheStore, { force: true });

    // The first store goes on (a reader sees that) — then the process dies.
    await change(db, a, { subject: "a2" });
    await s1.update();
    const unpersisted = s1.getPosition();
    expect(unpersisted.seq).toBeGreaterThan(persisted.seq);

    const s2 = new DocumentSummaryStore(db);
    s2.attachCache(cacheManager, "delta-restore");
    await createDoc(db, { type: "message", subject: "b", n: 2 });
    await s2.update();
    // A reader at the persisted position gets a delta; one that saw the
    // lost run's sequence numbers has to rescan.
    expect(s2.getChangesSince(persisted)).not.toBeNull();
    expect(s2.getChangesSince(persisted)!.entries.map((e) => e.fields.subject).sort()).toEqual(["a2", "b"]);
    expect(s2.getChangesSince(unpersisted)).toBeNull();
    await cacheManager.dispose();
  }, 60000);
});

describe("summary views read deltas instead of scanning", () => {
  it("does not scan the summary after the first run and stays correct", async () => {
    const ctx = await createWitnessingTenant("tenant-summary-delta-view");
    const db = await ctx.tenant.openDB("main");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await createDoc(db, { type: "message", subject: `m${i}`, folder: i % 2 ? "odd" : "even", n: i }));
    }
    await createDoc(db, { type: "note", subject: "not a message", folder: "even", n: 99 });
    const view = await buildView(db);
    await view.update();
    expect((await rows(view)).length).toBe(12);

    const scan = jest.spyOn(db.getSummaryStore!(), "getAllEntries");
    await change(db, ids[0], { folder: "odd", subject: "m0 moved" });
    await change(db, ids[1], { type: "note" }); // leaves the view
    await db.deleteDocument(ids[2]);
    const fresh = await createDoc(db, { type: "message", subject: "fresh", folder: "even", n: 100 });
    await view.update();
    expect(scan).not.toHaveBeenCalled();
    const result = await rows(view);
    expect(result).toContain("odd > m0 moved");
    expect(result).not.toContain("odd > m1");
    expect(result).not.toContain("even > m2");
    expect(result).toContain("even > fresh");
    expect(result.length).toBe(11);
    expect(fresh).toBeTruthy();
  }, 60000);

  it("re-evaluates entries re-extracted by a configuration backfill", async () => {
    const ctx = await createWitnessingTenant("tenant-summary-delta-backfill");
    const db = await ctx.tenant.openDB("main");
    await createDoc(db, { type: "message", subject: "x", folder: "f", n: 1, extra: "hidden" });
    const summary = db.getSummaryStore!({ autoInclude: false, include: ["type", "subject", "folder", "n"] });
    await summary.update();
    const position = summary.getPosition();
    summary.setConfig({ autoInclude: false, include: ["type", "subject", "folder", "n", "extra"] });
    await summary.update();
    const delta = summary.getChangesSince(position)!;
    expect(delta.entries.map((e) => e.fields.extra)).toEqual(["hidden"]);
  }, 60000);
});

describe("view cache: snapshot + change journal", () => {
  it("appends journal segments, replays them on restore and compacts", async () => {
    const ctx = await createWitnessingTenant("tenant-view-journal");
    const db = await ctx.tenant.openDB("main");
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(await createDoc(db, { type: "message", subject: `m${i}`, folder: `f${i % 3}`, n: i }));
    }
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 600000 });
    (db as unknown as BaseMindooDB).setCacheManager(cacheManager);
    const view = await buildView(db);
    await view.setCacheManager(cacheManager, "journal-view", "v1", { minCacheFlushIntervalMs: 0 });
    await view.update();
    await view.flushToCache(cacheStore);
    expect(await cacheStore.list("vv")).toHaveLength(1);
    expect(await cacheStore.list("vvj")).toHaveLength(0);

    // Small changes: journal segments, the snapshot stays untouched.
    const put = jest.spyOn(cacheStore, "put");
    await change(db, ids[0], { subject: "m0 changed" });
    await view.update();
    await view.flushToCache(cacheStore);
    await db.deleteDocument(ids[1]);
    await view.update();
    await view.flushToCache(cacheStore);
    expect(put.mock.calls.map(([type]) => type)).toEqual(["vvj", "vvj"]);
    expect(await cacheStore.list("vvj")).toHaveLength(2);
    put.mockRestore();

    const expected = await rows(view);
    const restoredView = await buildView(db);
    expect(await restoredView.setCacheManager(cacheManager, "journal-view", "v1")).toBe(true);
    expect(await rows(restoredView)).toEqual(expected);
    // The replayed provider cursors make the next update incremental and exact.
    await change(db, ids[3], { subject: "m3 after restore" });
    await restoredView.update();
    await view.update();
    expect(await rows(restoredView)).toEqual(await rows(view));

    // Beyond 100 journal entries (min threshold) a snapshot is written and
    // the segments are dropped.
    for (let round = 0; round < 4; round++) {
      for (let i = 4; i < 30; i++) {
        await change(db, ids[i], { subject: `m${i} r${round}` });
      }
      await view.update();
      await view.flushToCache(cacheStore);
    }
    expect(await cacheStore.list("vvj")).toHaveLength(0);

    // Forced flush ("on close") always writes the snapshot.
    await change(db, ids[5], { subject: "last" });
    await view.update();
    await view.flushToCache(cacheStore);
    expect(await cacheStore.list("vvj")).toHaveLength(1);
    await view.flushToCache(cacheStore, { force: true });
    expect(await cacheStore.list("vvj")).toHaveLength(0);
    const finalView = await buildView(db);
    expect(await finalView.setCacheManager(cacheManager, "journal-view", "v1")).toBe(true);
    expect(await rows(finalView)).toEqual(await rows(view));
    await cacheManager.dispose();
  }, 120000);

  it("stops replaying at a missing segment and catches up through the providers", async () => {
    const ctx = await createWitnessingTenant("tenant-view-journal-gap");
    const db = await ctx.tenant.openDB("main");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await createDoc(db, { type: "message", subject: `m${i}`, folder: "f", n: i }));
    }
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 600000 });
    const view = await buildView(db);
    await view.setCacheManager(cacheManager, "gap-view", "v1", { minCacheFlushIntervalMs: 0 });
    await view.update();
    await view.flushToCache(cacheStore);
    for (const i of [0, 1, 2]) {
      await change(db, ids[i], { subject: `m${i} changed` });
      await view.update();
      await view.flushToCache(cacheStore);
    }
    const segments = (await cacheStore.list("vvj")).sort();
    expect(segments).toHaveLength(3);
    await cacheStore.delete("vvj", segments[1]);

    const restored = await buildView(db);
    expect(await restored.setCacheManager(cacheManager, "gap-view", "v1")).toBe(true);
    await restored.update();
    expect(await rows(restored)).toEqual(await rows(view));
    await cacheManager.dispose();
  }, 60000);
});
