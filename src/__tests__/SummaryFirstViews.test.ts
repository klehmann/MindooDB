import type { MindooDB } from "../core/types";
import {
  ColumnSorting,
  SelectedOnly,
  VirtualViewColumn,
  VirtualViewFactory,
} from "../core/indexing/virtualviews";
import type { VirtualView } from "../core/indexing/virtualviews";
import {
  createViewDataProvider,
  collectSummaryFallbackReasons,
} from "../core/indexing/createViewDataProvider";
import { MindooDBVirtualViewDataProvider } from "../core/indexing/virtualviews/MindooDBVirtualViewDataProvider";
import { SummaryVirtualViewDataProvider } from "../core/indexing/summary/SummaryVirtualViewDataProvider";
import type { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import { createViewLanguage } from "../core/expressions";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

interface PersonDoc extends Record<string, unknown> {
  name: string;
  department: string;
  salary: number;
}

const v = createViewLanguage<PersonDoc>();

async function seedDb(db: MindooDB, rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), row);
    });
  }
}

async function collectNames(view: VirtualView): Promise<unknown[]> {
  const nav = VirtualViewFactory.createNavigator(view).build().expandAll();
  const names: unknown[] = [];
  for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
    if (entry.isDocument()) {
      names.push(entry.getColumnValues().name);
    }
  }
  return names;
}

function getSingleProvider(view: VirtualView) {
  const providers = Array.from(view.getDataProviders());
  expect(providers).toHaveLength(1);
  return providers[0];
}

/**
 * Coverage for the summary-first data-provider selection: the async view
 * builds read from the document summary buffer by default and fall back
 * to materialized documents when the definition requires them (or when
 * `useFullDocuments` forces it) — plus the background summary auto-follow
 * that keeps the buffer current as changes arrive.
 */
describe("Summary-first view data providers", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-summary-first");
    db = await ctx.tenant.openDB("summary-first-db");
    await seedDb(db, [
      { name: "Alice", department: "Engineering", salary: 100 },
      { name: "Bob", department: "Sales", salary: 90 },
    ]);
  }, 30000);

  it("chooses the summary buffer for declarative view definitions", async () => {
    const columns = [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)];
    const { provider, source, fallbackReasons } = await createViewDataProvider({
      origin: "main",
      db,
      columns,
      filter: v.eq(v.field("department"), "Engineering"),
    });

    expect(source).toBe("summary");
    expect(fallbackReasons).toEqual([]);
    expect(provider).toBeInstanceOf(SummaryVirtualViewDataProvider);
  }, 30000);

  it("falls back to documents for JS valueFunction columns and JS filters", async () => {
    const jsColumn = await createViewDataProvider({
      origin: "main",
      db,
      columns: [
        new VirtualViewColumn({
          name: "upper",
          valueFunction: (doc) => String(doc.getData().name).toUpperCase(),
        }),
      ],
    });
    expect(jsColumn.source).toBe("documents");
    expect(jsColumn.fallbackReasons.join(" ")).toMatch(/valueFunction/);
    expect(jsColumn.provider).toBeInstanceOf(MindooDBVirtualViewDataProvider);

    const jsFilter = await createViewDataProvider({
      origin: "main",
      db,
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
      filter: (doc) => doc.getData().department === "Sales",
    });
    expect(jsFilter.source).toBe("documents");
    expect(jsFilter.fallbackReasons.join(" ")).toMatch(/JS function/);
  }, 30000);

  it("falls back to documents when a referenced field is not covered", async () => {
    // Restrict the summary to 'name' only.
    db.getSummaryStore!({ autoInclude: false, include: ["name"] });

    const reasons = await collectSummaryFallbackReasons({
      db,
      columns: [VirtualViewColumn.sorted("salary", ColumnSorting.DESCENDING)],
    });
    expect(reasons.join(" ")).toMatch(/"salary" is not covered/);

    const { source } = await createViewDataProvider({
      origin: "main",
      db,
      columns: [VirtualViewColumn.sorted("salary", ColumnSorting.DESCENDING)],
    });
    expect(source).toBe("documents");
  }, 30000);

  it("serves attachment expressions from the summary only when the projection is enabled", async () => {
    const columns = [
      new VirtualViewColumn({ name: "files", expression: v.attachmentCount() }),
    ];

    const withProjection = await createViewDataProvider({ origin: "main", db, columns });
    expect(withProjection.source).toBe("summary");

    db.getSummaryStore!({ includeAttachments: false });
    const withoutProjection = await createViewDataProvider({ origin: "main", db, columns });
    expect(withoutProjection.source).toBe("documents");
    expect(withoutProjection.fallbackReasons.join(" ")).toMatch(/_attachments/);
  }, 30000);

  it("honors useFullDocuments as an explicit override", async () => {
    const { provider, source, fallbackReasons } = await createViewDataProvider({
      origin: "main",
      db,
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
      useFullDocuments: true,
    });
    expect(source).toBe("documents");
    expect(fallbackReasons).toEqual([]);
    expect(provider).toBeInstanceOf(MindooDBVirtualViewDataProvider);
  }, 30000);

  it("buildAndUpdate uses the summary path by default and both paths agree", async () => {
    const summaryView = await VirtualViewFactory.createView()
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("main", db, v.eq(v.field("department"), "Engineering"))
      .buildAndUpdate();
    expect(getSingleProvider(summaryView)).toBeInstanceOf(SummaryVirtualViewDataProvider);
    expect(await collectNames(summaryView)).toEqual(["Alice"]);
    expect(summaryView.getDataSourceInfo("main")).toEqual({
      source: "summary",
      fallbackReasons: [],
    });

    const docView = await VirtualViewFactory.createView()
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("main", db, v.eq(v.field("department"), "Engineering"), {
        useFullDocuments: true,
      })
      .buildAndUpdate();
    expect(getSingleProvider(docView)).toBeInstanceOf(MindooDBVirtualViewDataProvider);
    expect(await collectNames(docView)).toEqual(["Alice"]);
    expect(docView.getDataSourceInfo("main")).toEqual({
      source: "documents",
      fallbackReasons: [],
    });
  }, 30000);

  it("build() without buildAndUpdate() also resolves summary-first", async () => {
    const view = await VirtualViewFactory.createView()
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("main", db, v.eq(v.field("department"), "Sales"))
      .build();
    expect(getSingleProvider(view)).toBeInstanceOf(SummaryVirtualViewDataProvider);
    await view.update();
    expect(await collectNames(view)).toEqual(["Bob"]);
  }, 30000);

  it("still supports legacy JS filter functions through buildAndUpdate", async () => {
    const view = await VirtualViewFactory.createView()
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("main", db, (doc) => doc.getData().department === "Sales")
      .buildAndUpdate();
    expect(getSingleProvider(view)).toBeInstanceOf(MindooDBVirtualViewDataProvider);
    expect(await collectNames(view)).toEqual(["Bob"]);
    const info = view.getDataSourceInfo("main");
    expect(info?.source).toBe("documents");
    expect(info?.fallbackReasons.join(" ")).toMatch(/JS function/);
  }, 30000);
});

describe("Summary auto-follow", () => {
  async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("condition not met in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Peek at the private store WITHOUT lazily creating it. */
  function peekSummaryStore(db: MindooDB): DocumentSummaryStore | null {
    return (db as unknown as { summaryStore: DocumentSummaryStore | null }).summaryStore;
  }

  it("keeps an existing summary store current without explicit update()", async () => {
    const ctx = await createWitnessingTenant("test-tenant-autofollow");
    const db = await ctx.tenant.openDB("autofollow-db");
    const summary = db.getSummaryStore!();
    await summary.update();
    expect(summary.getSize()).toBe(0);

    await seedDb(db, [{ name: "Alice" }, { name: "Bob" }]);
    // No explicit update() call — the coalesced change event triggers a
    // background catch-up run.
    await waitFor(() => summary.getSize() === 2);
  }, 30000);

  it("activates the summary store when a dbsetup config appears", async () => {
    const ctx = await createWitnessingTenant("test-tenant-autoactivate");
    const db = await ctx.tenant.openDB("autoactivate-db");
    expect(peekSummaryStore(db)).toBeNull();

    await db.setSummarySetup!({ autoInclude: true });
    await seedDb(db, [{ name: "Alice" }, { name: "Bob" }]);

    // The dbsetup change auto-creates the store; subsequent events keep it
    // current — all without any query/getSummaryStore call.
    await waitFor(() => (peekSummaryStore(db)?.getSize() ?? 0) === 2);
  }, 30000);

  it("does not activate anything without a dbsetup config", async () => {
    const ctx = await createWitnessingTenant("test-tenant-noactivate");
    const db = await ctx.tenant.openDB("noactivate-db");
    await seedDb(db, [{ name: "Alice" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(peekSummaryStore(db)).toBeNull();
  }, 30000);

  it("can be disabled and re-enabled", async () => {
    const ctx = await createWitnessingTenant("test-tenant-autodisable");
    const db = await ctx.tenant.openDB("autodisable-db");
    const summary = db.getSummaryStore!();
    await summary.update();

    db.setSummaryAutoUpdateEnabled!(false);
    await seedDb(db, [{ name: "Alice" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(summary.getSize()).toBe(0);

    // Re-enabling schedules a catch-up immediately.
    db.setSummaryAutoUpdateEnabled!(true);
    const start = Date.now();
    while (summary.getSize() !== 1) {
      if (Date.now() - start > 5000) {
        throw new Error("summary did not catch up after re-enable");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, 30000);
});
