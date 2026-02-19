import {
  VirtualView,
  VirtualViewColumn,
  VirtualViewDataChange,
  VirtualViewEntryData,
  ColumnSorting,
} from "../core/indexing/virtualviews";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";

/**
 * Integration tests verifying that VirtualView correctly uses the local cache:
 * - Build a view, flush the cache, create a new VirtualView, restore from cache
 * - Verify version mismatch triggers a clean rebuild (cache ignored)
 * - Verify incremental changes work after cache restore
 */
describe("VirtualView cache integration", () => {
  function createColumns() {
    return [
      VirtualViewColumn.category("department", {
        title: "Department",
        sorting: ColumnSorting.ASCENDING,
      }),
      VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
    ];
  }

  function buildTestData(): VirtualViewDataChange {
    const change = new VirtualViewDataChange("test-origin");
    change.addEntry("doc1", { department: "Engineering", name: "Alice" });
    change.addEntry("doc2", { department: "Engineering", name: "Bob" });
    change.addEntry("doc3", { department: "Sales", name: "Charlie" });
    return change;
  }

  function countDocsInView(view: VirtualView): number {
    const root = view.getRoot();
    let total = 0;
    for (const cat of root.getChildCategories()) {
      total += cat.getChildDocumentCount();
    }
    return total;
  }

  it("should write cache data when view is populated and flushed", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const view = new VirtualView(createColumns());
    await view.setCacheManager(cacheManager, "contacts-by-dept", "v1");

    const change = buildTestData();
    view.applyChanges(change);

    expect(await cacheStore.list("vv")).toEqual([]);

    await cacheManager.flush();

    const keys = await cacheStore.list("vv");
    expect(keys.length).toBe(1);

    const raw = await cacheStore.get("vv", keys[0]);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeGreaterThan(10);

    await cacheManager.dispose();
  });

  it("should restore a VirtualView from cache via setCacheManager", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    // --- Phase 1: build and flush ---
    const view1 = new VirtualView(createColumns());
    await view1.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    view1.applyChanges(buildTestData());
    await cacheManager.flush();

    // --- Phase 2: create a new view — setCacheManager restores automatically ---
    const view2 = new VirtualView(createColumns());

    const getSpy = jest.spyOn(cacheStore, "get");

    const restored = await view2.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    expect(restored).toBe(true);

    expect(getSpy).toHaveBeenCalled();
    expect(getSpy.mock.calls.some(([type]) => type === "vv")).toBe(true);
    getSpy.mockRestore();

    const root = view2.getRoot();
    expect(root.getChildCount()).toBe(2); // Engineering, Sales categories

    expect(countDocsInView(view2)).toBe(3);

    await cacheManager.dispose();
  });

  it("should restore correct counts and structure from tree cache", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const view1 = new VirtualView(createColumns());
    await view1.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    view1.applyChanges(buildTestData());

    const root1 = view1.getRoot();
    const engCat1 = root1.getChildCategories().find(
      c => c.getColumnValue("department") === "Engineering"
    )!;
    const origDescendantDocCount = root1.getDescendantDocumentCount();
    const origEngDocCount = engCat1.getChildDocumentCount();

    await cacheManager.flush();

    const view2 = new VirtualView(createColumns());
    const restored = await view2.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    expect(restored).toBe(true);

    const root2 = view2.getRoot();
    expect(root2.getDescendantDocumentCount()).toBe(origDescendantDocCount);

    const engCat2 = root2.getChildCategories().find(
      c => c.getColumnValue("department") === "Engineering"
    )!;
    expect(engCat2.getChildDocumentCount()).toBe(origEngDocCount);

    const engDocs = engCat2.getChildDocuments();
    expect(engDocs.map(d => d.getColumnValue("name"))).toEqual(["Alice", "Bob"]);

    await cacheManager.dispose();
  });

  it("should reject cache with mismatched version", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const view1 = new VirtualView(createColumns());
    await view1.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    view1.applyChanges(buildTestData());
    await cacheManager.flush();

    const view2 = new VirtualView(createColumns());
    const restored = await view2.setCacheManager(cacheManager, "contacts-by-dept", "v2");
    expect(restored).toBe(false);

    expect(countDocsInView(view2)).toBe(0);

    await cacheManager.dispose();
  });

  it("should accept incremental changes after cache restore", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const view1 = new VirtualView(createColumns());
    await view1.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    view1.applyChanges(buildTestData());
    await cacheManager.flush();

    const view2 = new VirtualView(createColumns());
    const restored = await view2.setCacheManager(cacheManager, "contacts-by-dept", "v1");
    expect(restored).toBe(true);
    expect(countDocsInView(view2)).toBe(3);

    const moreData = new VirtualViewDataChange("test-origin");
    moreData.addEntry("doc4", { department: "Marketing", name: "Diana" });
    view2.applyChanges(moreData);

    expect(countDocsInView(view2)).toBe(4);

    const root = view2.getRoot();
    expect(root.getChildCount()).toBe(3); // Engineering, Marketing, Sales

    await cacheManager.dispose();
  });

  it("should return false from setCacheManager when no cache exists", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const view = new VirtualView(createColumns());
    const restored = await view.setCacheManager(cacheManager, "non-existent", "v1");
    expect(restored).toBe(false);
    expect(countDocsInView(view)).toBe(0);

    await cacheManager.dispose();
  });

  it("should mark view dirty after applyChanges", async () => {
    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const view = new VirtualView(createColumns());
    await view.setCacheManager(cacheManager, "dirty-test", "v1");

    expect(view.hasDirtyState()).toBe(false);

    view.applyChanges(buildTestData());
    expect(view.hasDirtyState()).toBe(true);

    await cacheManager.flush();
    expect(view.hasDirtyState()).toBe(false);

    await cacheManager.dispose();
  });
});
