import type { MindooDB } from "../core/types";
import {
  ColumnSorting,
  SelectedOnly,
  VirtualViewColumn,
  VirtualViewFactory,
} from "../core/indexing/virtualviews";
import type { EphemeralSummaryView } from "../core/query/queryView";
import { queryViewAcross } from "../core/query/queryView";
import { createViewLanguage } from "../core/expressions";
import { MindooQueryError } from "../core/query/types";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

interface PersonDoc extends Record<string, unknown> {
  department: string;
  name: string;
  salary: number;
}

const v = createViewLanguage<PersonDoc>();

/**
 * Coverage for ephemeral, summary-backed views (`db.queryView()`):
 * construction from a declarative definition, expression columns,
 * dynamic re-sorting over the same summary, incremental maintenance,
 * and dispose semantics.
 */
describe("Ephemeral summary views (db.queryView)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-queryview");
    db = await ctx.tenant.openDB("queryview-db");

    const rows: Array<Partial<PersonDoc>> = [
      { department: "Engineering", name: "Alice", salary: 100 },
      { department: "Engineering", name: "Bob", salary: 90 },
      { department: "Sales", name: "Charlie", salary: 80 },
    ];
    for (const row of rows) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), row);
      });
    }
  }, 30000);

  async function collectRows(view: EphemeralSummaryView): Promise<Array<Record<string, unknown>>> {
    const nav = VirtualViewFactory.createNavigator(view.getView()).build().expandAll();
    const rows: Array<Record<string, unknown>> = [];
    for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
      if (entry.isDocument()) {
        rows.push(entry.getColumnValues());
      }
    }
    return rows;
  }

  it("builds a categorized, sorted view from summary entries", async () => {
    const view = await db.queryView!({
      columns: [
        VirtualViewColumn.category("department"),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ],
    });

    expect(view.getView().getRoot().getDescendantDocumentCount()).toBe(3);
    const rows = await collectRows(view);
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Charlie"]);
    view.dispose();
  }, 30000);

  it("filters entries with an expression", async () => {
    const view = await db.queryView!({
      filter: v.eq(v.field("department"), "Engineering"),
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });

    const rows = await collectRows(view);
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob"]);
    view.dispose();
  }, 30000);

  it("evaluates declarative expression columns", async () => {
    const view = await db.queryView!({
      columns: [
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
        new VirtualViewColumn({
          name: "doubleSalary",
          expression: v.mul(v.field("salary"), 2),
        }),
      ],
    });

    const rows = await collectRows(view);
    expect(rows.map((r) => r.doubleSalary)).toEqual([200, 180, 160]);
    view.dispose();
  }, 30000);

  it("re-sorts dynamically over the same summary via resort()", async () => {
    const view = await db.queryView!({
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    expect((await collectRows(view)).map((r) => r.name)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);

    await view.resort({
      columns: [VirtualViewColumn.sorted("salary", ColumnSorting.DESCENDING)],
    });
    expect((await collectRows(view)).map((r) => r.salary)).toEqual([100, 90, 80]);
    view.dispose();
  }, 30000);

  it("keeps up with document changes and deletions on update()", async () => {
    const view = await db.queryView!({
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    expect(view.getView().getRoot().getDescendantDocumentCount()).toBe(3);

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), { department: "Sales", name: "Dora", salary: 70 });
    });
    await view.update();
    expect(view.getView().getRoot().getDescendantDocumentCount()).toBe(4);

    await db.deleteDocument(doc.getId());
    await view.update();
    expect(view.getView().getRoot().getDescendantDocumentCount()).toBe(3);
    view.dispose();
  }, 30000);

  it("rejects JS valueFunction columns (summary views are declarative-only)", async () => {
    await expect(
      db.queryView!({
        columns: [
          new VirtualViewColumn({
            name: "computed",
            valueFunction: () => "x",
          }),
        ],
      })
    ).rejects.toThrow(/valueFunction/);
  }, 30000);

  it("rejects filters referencing uncovered fields", async () => {
    db.getSummaryStore!({ exclude: ["salary"] });

    await expect(
      db.queryView!({
        filter: v.gt(v.field("salary"), 50),
        columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
      })
    ).rejects.toThrow(MindooQueryError);
  }, 30000);

  it("guards against use after dispose()", async () => {
    const view = await db.queryView!({
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    view.dispose();
    expect(view.isDisposed()).toBe(true);
    await expect(view.update()).rejects.toThrow(/disposed/);
  }, 30000);
});

describe("Ephemeral views across databases and tenants (queryViewAcross)", () => {
  async function seedDb(db: MindooDB, rows: Array<Record<string, unknown>>): Promise<void> {
    for (const row of rows) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), row);
      });
    }
  }

  async function collectRows(view: EphemeralSummaryView): Promise<Array<Record<string, unknown>>> {
    const nav = VirtualViewFactory.createNavigator(view.getView()).build().expandAll();
    const rows: Array<Record<string, unknown>> = [];
    for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
      if (entry.isDocument()) {
        rows.push(entry.getColumnValues());
      }
    }
    return rows;
  }

  it("combines two databases of the same tenant into one sorted view", async () => {
    const ctx = await createWitnessingTenant("test-tenant-crossdb");
    const dbA = await ctx.tenant.openDB("crossdb-a");
    const dbB = await ctx.tenant.openDB("crossdb-b");
    await seedDb(dbA, [
      { name: "Alice", region: "EU" },
      { name: "Dora", region: "US" },
    ]);
    await seedDb(dbB, [
      { name: "Bob", region: "EU" },
      { name: "Charlie", region: "US" },
    ]);

    const view = await queryViewAcross(
      [{ db: dbA }, { db: dbB }],
      {
        columns: [
          VirtualViewColumn.category("region"),
          VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
        ],
      }
    );

    // Entries from both databases, merged and sorted within categories
    expect(view.getView().getRoot().getDescendantDocumentCount()).toBe(4);
    const rows = await collectRows(view);
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Charlie", "Dora"]);

    // Both origins are present as distinct data providers
    const origins = Array.from(view.getView().getDataProviders()).map((p) => p.getOrigin());
    expect(new Set(origins).size).toBe(2);
    view.dispose();
  }, 30000);

  it("combines databases from DIFFERENT tenants", async () => {
    const ctx1 = await createWitnessingTenant("test-tenant-cross-1");
    const ctx2 = await createWitnessingTenant("test-tenant-cross-2");
    const db1 = await ctx1.tenant.openDB("cross-tenant-db");
    const db2 = await ctx2.tenant.openDB("cross-tenant-db");
    await seedDb(db1, [{ name: "Tenant1-Doc" }]);
    await seedDb(db2, [{ name: "Tenant2-Doc" }]);

    const view = await queryViewAcross(
      [{ db: db1 }, { db: db2 }],
      { columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)] }
    );

    const rows = await collectRows(view);
    expect(rows.map((r) => r.name)).toEqual(["Tenant1-Doc", "Tenant2-Doc"]);
    view.dispose();
  }, 30000);

  it("applies per-source filters (overriding the shared filter)", async () => {
    const ctx = await createWitnessingTenant("test-tenant-crossfilter");
    const dbA = await ctx.tenant.openDB("crossfilter-a");
    const dbB = await ctx.tenant.openDB("crossfilter-b");
    await seedDb(dbA, [
      { name: "A-task", type: "task" },
      { name: "A-note", type: "note" },
    ]);
    await seedDb(dbB, [
      { name: "B-task", type: "task" },
      { name: "B-note", type: "note" },
    ]);

    const view = await queryViewAcross(
      [
        { db: dbA }, // uses the shared filter (tasks only)
        { db: dbB, filter: v.eq(v.field("type"), "note") }, // per-source override
      ],
      {
        filter: v.eq(v.field("type"), "task"),
        columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
      }
    );

    const rows = await collectRows(view);
    expect(rows.map((r) => r.name)).toEqual(["A-task", "B-note"]);
    view.dispose();
  }, 30000);

  it("resorts across all sources and stays live-bound on every source db", async () => {
    const ctx = await createWitnessingTenant("test-tenant-crosslive");
    const dbA = await ctx.tenant.openDB("crosslive-a");
    const dbB = await ctx.tenant.openDB("crosslive-b");
    await seedDb(dbA, [{ name: "Alice", salary: 100 }]);
    await seedDb(dbB, [{ name: "Bob", salary: 200 }]);

    const view = await queryViewAcross(
      [{ db: dbA }, { db: dbB }],
      { columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)] }
    );
    view.bindTo();

    await view.resort({
      columns: [VirtualViewColumn.sorted("salary", ColumnSorting.DESCENDING)],
    });
    expect((await collectRows(view)).map((r) => r.salary)).toEqual([200, 100]);

    // A write in EITHER source database reaches the rebound view
    await seedDb(dbB, [{ name: "Carol", salary: 300 }]);
    const start = Date.now();
    while (view.getView().getRoot().getDescendantDocumentCount() < 3) {
      if (Date.now() - start > 5000) {
        throw new Error("live update across sources did not arrive");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await collectRows(view)).map((r) => r.salary)).toEqual([300, 200, 100]);
    view.dispose();
  }, 30000);

  it("rejects duplicate origins when combining the same database twice", async () => {
    const ctx = await createWitnessingTenant("test-tenant-crossdup");
    const dbA = await ctx.tenant.openDB("crossdup-a");

    await expect(
      queryViewAcross(
        [{ db: dbA }, { db: dbA }],
        { columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)] }
      )
    ).rejects.toThrow(/Duplicate view source origin/);

    // With distinct explicit origins the same database can appear twice
    const view = await queryViewAcross(
      [
        { db: dbA, origin: "left" },
        { db: dbA, origin: "right" },
      ],
      { columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)] }
    );
    view.dispose();
  }, 30000);
});
