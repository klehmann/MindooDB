import type { MindooDB } from "../core/types";
import {
  ColumnSorting,
  SelectedOnly,
  VirtualView,
  VirtualViewColumn,
  VirtualViewFactory,
} from "../core/indexing/virtualviews";
import { VirtualViewDataChange } from "../core/indexing/virtualviews/VirtualViewDataChange";
import { createViewDataProvider } from "../core/indexing/createViewDataProvider";
import { MindooDBVirtualViewDataProvider } from "../core/indexing/virtualviews/MindooDBVirtualViewDataProvider";
import { SummaryVirtualViewDataProvider } from "../core/indexing/summary/SummaryVirtualViewDataProvider";
import { isIdPrefixFilterCoveredByScope, resolveSummaryConfig, computeSummaryConfigFingerprint } from "../core/indexing/summary/types";
import { matchesAnyDocIdPrefix, normalizeDocIdPrefixes } from "../core/utils/idGeneration";
import { MindooQueryError } from "../core/query/types";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

/** Room/month-style ids: `m_r1_202610_<n>`, `m_r2_202611_<n>`, plus `chunk_<n>` noise. */
async function seed(db: MindooDB): Promise<void> {
  const rows: Array<[string, string]> = [
    ["m_r1_202610_1", "r1 oct a"],
    ["m_r1_202610_2", "r1 oct b"],
    ["m_r1_202611_1", "r1 nov"],
    ["m_r2_202611_1", "r2 nov"],
    ["chunk_1", "chunk one"],
    ["chunk_2", "chunk two"],
  ];
  await db.createDocuments(
    rows.map(([id, name]) => ({ id, assumeUniqueId: true, initialValues: { name } })),
  );
}

async function names(view: VirtualView): Promise<string[]> {
  const nav = VirtualViewFactory.createNavigator(view).build().expandAll();
  const result: string[] = [];
  for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
    if (entry.isDocument()) result.push(String(entry.getColumnValues().name));
  }
  return result.sort();
}

async function whenIdle(db: MindooDB): Promise<void> {
  await (db as unknown as { whenBackgroundIdle(): Promise<boolean> }).whenBackgroundIdle();
}

describe("id-prefix helpers", () => {
  it("normalizes single prefixes and lists", () => {
    expect(normalizeDocIdPrefixes(undefined)).toBeUndefined();
    expect(normalizeDocIdPrefixes("")).toBeUndefined();
    expect(normalizeDocIdPrefixes([])).toBeUndefined();
    expect(normalizeDocIdPrefixes(["a", ""])).toBeUndefined();
    expect(normalizeDocIdPrefixes("m_r1_")).toEqual(["m_r1"]);
    expect(normalizeDocIdPrefixes(["a", "a_", "b"])).toEqual(["a", "b"]);
  });

  it("matches any prefix on the `_` boundary", () => {
    expect(matchesAnyDocIdPrefix("m_r1_202610_1", ["m_r2", "m_r1_202610"])).toBe(true);
    expect(matchesAnyDocIdPrefix("m_r1_202610_1", ["m_r1_2026"])).toBe(false);
    expect(matchesAnyDocIdPrefix("m_r10_1", ["m_r1"])).toBe(false);
  });

  it("decides whether a filter lies inside a summary scope", () => {
    expect(isIdPrefixFilterCoveredByScope(undefined, null)).toBe(true);
    expect(isIdPrefixFilterCoveredByScope(undefined, ["m"])).toBe(false);
    expect(isIdPrefixFilterCoveredByScope(["m_r1", "m"], ["m"])).toBe(true);
    expect(isIdPrefixFilterCoveredByScope(["chunk"], ["m"])).toBe(false);
  });

  it("keeps the config fingerprint of unscoped summaries unchanged", () => {
    const fingerprint = computeSummaryConfigFingerprint(resolveSummaryConfig({}));
    expect(fingerprint).not.toContain("idPrefixes");
    expect(computeSummaryConfigFingerprint(resolveSummaryConfig({ idPrefixes: ["m"] }))).toContain("idPrefixes");
  });
});

describe("id-prefix filters on the changefeed", () => {
  let db: MindooDB;
  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-prefix-feed");
    db = await ctx.tenant.openDB("prefix-feed-db");
    await seed(db);
  }, 30000);

  it("iterates and counts a list of prefixes", async () => {
    const ids: string[] = [];
    for await (const { doc } of db.iterateChangesSince(null, { idPrefix: ["m_r1_202611", "m_r2"] })) {
      ids.push(doc.getId());
    }
    expect(ids.sort()).toEqual(["m_r1_202611_1", "m_r2_202611_1"]);
    expect(db.countChangesSince!(null, { idPrefix: ["m_r1_202611", "m_r2"] })).toBe(2);
    expect((await db.getAllDocumentIds({ idPrefix: ["chunk", "m_r2"] })).sort()).toEqual([
      "chunk_1",
      "chunk_2",
      "m_r2_202611_1",
    ]);
  }, 30000);
});

describe("id-prefix filters on views", () => {
  let db: MindooDB;
  const columns = [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)];

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-prefix-views");
    db = await ctx.tenant.openDB("prefix-views-db");
    await seed(db);
  }, 30000);

  it("document views only scan the prefix", async () => {
    const spy = jest.spyOn(db, "iterateChangesSince");
    const view = await VirtualViewFactory.createView()
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("main", db, undefined, { useFullDocuments: true, idPrefix: "m_r1" })
      .buildAndUpdate();
    expect(await names(view)).toEqual(["r1 nov", "r1 oct a", "r1 oct b"]);
    expect(spy.mock.calls.some(([, options]) => JSON.stringify(options?.idPrefix) === '["m_r1"]')).toBe(true);
  }, 30000);

  it("summary views filter by prefix and follow new documents", async () => {
    const view = await VirtualViewFactory.createView()
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("main", db, undefined, { idPrefix: ["m_r1_202610", "m_r2"] })
      .buildAndUpdate();
    expect(view.getDataSourceInfo("main")?.source).toBe("summary");
    expect(await names(view)).toEqual(["r1 oct a", "r1 oct b", "r2 nov"]);

    await db.createDocuments([
      { id: "m_r2_202612_1", assumeUniqueId: true, initialValues: { name: "r2 dec" } },
      { id: "m_r3_202612_1", assumeUniqueId: true, initialValues: { name: "r3 dec" } },
    ]);
    await view.update();
    expect(await names(view)).toEqual(["r1 oct a", "r1 oct b", "r2 dec", "r2 nov"]);
  }, 30000);

  it("db.query and db.queryView honor idPrefix", async () => {
    const result = await db.query!({ idPrefix: "chunk", sortBy: [{ field: "name" }] });
    expect(result.rows.map((row) => row.docId)).toEqual(["chunk_1", "chunk_2"]);

    const full = await db.query!({ idPrefix: ["m_r2"] }, { allowFullScan: true });
    expect(full.rows.map((row) => row.docId)).toEqual(["m_r2_202611_1"]);

    const ephemeral = await db.queryView!({ idPrefix: "m_r1_202611", columns });
    await ephemeral.update();
    expect(await names(ephemeral.getView())).toEqual(["r1 nov"]);
  }, 30000);

  it("drops restored rows outside a changed prefix filter", async () => {
    const view = new VirtualView(columns);
    const provider = new MindooDBVirtualViewDataProvider({ origin: "main", db, idPrefix: "chunk" });
    provider.init(view);
    view.addDataProvider(provider);
    // Simulate a cache written by the same view with idPrefix "m_r2".
    const restored = new VirtualViewDataChange("main");
    restored.addEntry("m_r2_202611_1", { name: "r2 nov" });
    view.applyChanges(restored);
    provider.importCacheState({ cursor: null, knownDocIds: ["m_r2_202611_1"], idPrefixes: ["m_r2"] });

    await view.update();
    expect(await names(view)).toEqual(["chunk one", "chunk two"]);
  }, 30000);
});

describe("summary id-prefix scope (dbsetup)", () => {
  let db: MindooDB;
  const columns = [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)];

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-prefix-scope");
    db = await ctx.tenant.openDB("prefix-scope-db");
    await seed(db);
  }, 30000);

  it("only summarizes documents inside the scope and never loads the rest", async () => {
    await db.setSummarySetup!({ idPrefixes: ["m"] });
    const summary = db.getSummaryStore!();
    const spy = jest.spyOn(db, "iterateChangesSince");
    await summary.update();
    expect(summary.getIdPrefixScope()).toEqual(["m"]);
    expect([...summary.getAllEntries()].map((entry) => entry.docId).sort()).toEqual([
      "m_r1_202610_1",
      "m_r1_202610_2",
      "m_r1_202611_1",
      "m_r2_202611_1",
    ]);
    for (const [, options] of spy.mock.calls) {
      expect(options?.idPrefix).toEqual(["m", "dbsetup"]);
    }
  }, 30000);

  it("routes queries and views by scope coverage", async () => {
    await db.setSummarySetup!({ idPrefixes: ["m"] });
    await db.getSummaryStore!().update();

    expect((await db.query!({ idPrefix: "m_r2" })).rows.map((row) => row.docId)).toEqual(["m_r2_202611_1"]);
    await expect(db.query!({})).rejects.toThrow(MindooQueryError);
    await expect(db.query!({ idPrefix: "chunk" })).rejects.toThrow(/only covers documents with id prefix "m"/);
    expect((await db.query!({ idPrefix: "chunk" }, { allowFullScan: true })).total).toBe(2);

    const inside = await createViewDataProvider({ origin: "main", db, columns, idPrefix: "m_r1" });
    expect(inside.source).toBe("summary");
    expect(inside.provider).toBeInstanceOf(SummaryVirtualViewDataProvider);

    const outside = await createViewDataProvider({ origin: "main", db, columns, idPrefix: "chunk" });
    expect(outside.source).toBe("documents");
    expect(outside.fallbackReasons.join(" ")).toMatch(/outside the summary scope/);

    const unfiltered = await createViewDataProvider({ origin: "main", db, columns });
    expect(unfiltered.source).toBe("documents");
    expect(unfiltered.fallbackReasons.join(" ")).toMatch(/only covers id prefixes/);

    await expect(Promise.resolve().then(() => db.queryView!({ idPrefix: "chunk", columns }))).rejects.toThrow(MindooQueryError);
  }, 30000);

  it("prunes on narrowing and backfills on widening", async () => {
    const summary = db.getSummaryStore!();
    await summary.update();
    expect(summary.getSize()).toBe(6);

    await db.setSummarySetup!({ idPrefixes: ["m_r1"] });
    await summary.update();
    await whenIdle(db);
    expect([...summary.getAllEntries()].map((entry) => entry.docId).sort()).toEqual([
      "m_r1_202610_1",
      "m_r1_202610_2",
      "m_r1_202611_1",
    ]);

    await db.setSummarySetup!({ idPrefixes: ["m_r1", "chunk"] });
    await summary.update();
    await whenIdle(db);
    expect(summary.getSize()).toBe(5);
    expect(summary.getCoverage()).toBe("full");

    await db.setSummarySetup!(null);
    await summary.update();
    await whenIdle(db);
    expect(summary.getSize()).toBe(6);
  }, 30000);
});
