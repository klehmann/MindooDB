import type { MindooDB } from "../core/types";
import { createViewLanguage } from "../core/expressions";
import { MindooQueryError } from "../core/query/types";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

interface TaskDoc extends Record<string, unknown> {
  type: string;
  name: string;
  amount: number;
  meta: { owner: string };
  secret: string;
}

const v = createViewLanguage<TaskDoc>();

/**
 * Coverage for the ad-hoc query engine (`db.query()`): expression filters,
 * sorting (field + expression keys), paging, projection, the coverage
 * guardrails, and the `allowFullScan` escape hatch.
 */
describe("MindooQuery (db.query)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-query");
    db = await ctx.tenant.openDB("query-db");

    const rows: Array<Partial<TaskDoc>> = [
      { type: "task", name: "Alpha", amount: 30, meta: { owner: "alice" } },
      { type: "task", name: "Beta", amount: 10, meta: { owner: "bob" } },
      { type: "task", name: "Gamma", amount: 20, meta: { owner: "alice" } },
      { type: "note", name: "Delta", amount: 99, meta: { owner: "carol" } },
    ];
    for (const row of rows) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), row);
      });
    }
  }, 30000);

  it("filters with an expression and reports total + coverage", async () => {
    const result = await db.query!({
      filter: v.eq(v.field("type"), "task"),
    });

    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.coverage).toBe("full");
    const names = result.rows.map((r) => r.fields.name).sort();
    expect(names).toEqual(["Alpha", "Beta", "Gamma"]);
  }, 30000);

  it("sorts by field keys in both directions", async () => {
    const asc = await db.query!({
      filter: v.eq(v.field("type"), "task"),
      sortBy: [{ field: "amount", direction: "ascending" }],
    });
    expect(asc.rows.map((r) => r.fields.amount)).toEqual([10, 20, 30]);

    const desc = await db.query!({
      filter: v.eq(v.field("type"), "task"),
      sortBy: [{ field: "amount", direction: "descending" }],
    });
    expect(desc.rows.map((r) => r.fields.amount)).toEqual([30, 20, 10]);
  }, 30000);

  it("sorts by expression keys", async () => {
    // Sort by negated amount → same as descending by amount
    const result = await db.query!({
      filter: v.eq(v.field("type"), "task"),
      sortBy: [{ expression: v.sub(0, v.field("amount")), direction: "ascending" }],
    });
    expect(result.rows.map((r) => r.fields.amount)).toEqual([30, 20, 10]);
  }, 30000);

  it("pages with limit/offset while keeping the full total", async () => {
    const page = await db.query!({
      filter: v.eq(v.field("type"), "task"),
      sortBy: [{ field: "amount", direction: "ascending" }],
      offset: 1,
      limit: 1,
    });

    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].fields.amount).toBe(20);
  }, 30000);

  it("projects returned fields", async () => {
    const result = await db.query!({
      filter: v.eq(v.field("name"), "Alpha"),
      fields: ["name"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].fields).toEqual({ name: "Alpha" });
  }, 30000);

  it("queries nested fields when explicitly included in the summary config", async () => {
    db.getSummaryStore!({ include: ["meta.owner"] });

    const result = await db.query!({
      filter: v.eq(v.field("meta.owner"), "alice"),
    });

    expect(result.total).toBe(2);
  }, 30000);

  it("rejects filters on fields outside the summary coverage", async () => {
    db.getSummaryStore!({ exclude: ["secret"] });

    await expect(
      db.query!({ filter: v.eq(v.field("secret"), "x") })
    ).rejects.toThrow(MindooQueryError);
    await expect(
      db.query!({ filter: v.eq(v.field("secret"), "x") })
    ).rejects.toThrow(/secret/);
  }, 30000);

  it("rejects decrypt expressions without allowFullScan", async () => {
    await expect(
      db.query!({ filter: v.eq(v.decryptField("secret"), "x") })
    ).rejects.toThrow(/allowFullScan/);
  }, 30000);

  it("rejects view-tree operations with a clear error", async () => {
    await expect(
      db.query!({ filter: v.gt(v.childCount(), 0) })
    ).rejects.toThrow(/view-tree/);
  }, 30000);

  it("answers uncovered fields via allowFullScan (materialized documents)", async () => {
    db.getSummaryStore!({ exclude: ["secret"] });

    // `meta.owner` is not in the summary (no include), but the full scan
    // evaluates against the materialized document payload.
    const result = await db.query!(
      {
        filter: v.eq(v.field("meta.owner"), "alice"),
        sortBy: [{ field: "name", direction: "ascending" }],
      },
      { allowFullScan: true }
    );

    expect(result.coverage).toBe("full-scan");
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.fields.name)).toEqual(["Alpha", "Gamma"]);
  }, 30000);

  it("drops deleted documents from query results", async () => {
    const before = await db.query!({ filter: v.eq(v.field("type"), "task") });
    expect(before.total).toBe(3);

    const alphaRow = before.rows.find((r) => r.fields.name === "Alpha")!;
    await db.deleteDocument(alphaRow.docId);

    const after = await db.query!({ filter: v.eq(v.field("type"), "task") });
    expect(after.total).toBe(2);
    expect(after.rows.map((r) => r.fields.name).sort()).toEqual(["Beta", "Gamma"]);
  }, 30000);
});
