import { createViewDataProvider } from "../core/indexing/createViewDataProvider";
import { createViewLanguage } from "../core/expressions";
import type { MindooDB } from "../core/types";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

const v = createViewLanguage();

/**
 * A nested object field (`crm: { title, folders }`) is not auto-included in the
 * summary. Queries and views over its paths used to be served from the summary
 * anyway and silently matched nothing; they now fail loudly (queries) or fall
 * back to documents (views) until the paths are explicitly included.
 */
describe("summary coverage of nested fields", () => {
  let db: MindooDB;

  beforeAll(async () => {
    const ctx = await createWitnessingTenant("test-tenant-nested-coverage");
    db = await ctx.tenant.openDB("nested-coverage-db");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), { form: "sheet", crm: { title: "Budget", folders: ["Customers\\Miller", "Finance"] } });
    });
  }, 30000);

  const query = () => db.query!({ filter: v.exists(v.field("crm.title")), fields: ["crm.title", "crm.folders"] });

  it("refuses a summary query over a nested path that is not included, instead of matching nothing", async () => {
    await expect(query()).rejects.toThrow(/"crm.title" is not covered/);
    await expect(db.query!({ filter: v.exists(v.field("crm.title")) }, { allowFullScan: true })).resolves.toMatchObject({
      total: 1,
    });
  }, 30000);

  it("lets views fall back to documents for such paths", async () => {
    const { source, fallbackReasons } = await createViewDataProvider({
      origin: "main",
      db,
      columns: [],
      filter: v.exists(v.field("crm.title")),
    });
    expect(source).toBe("documents");
    expect(fallbackReasons.join(" ")).toMatch(/crm.title/);
  }, 30000);

  it("answers from the summary once the paths are included", async () => {
    await db.setSummarySetup!({ include: ["crm.title", "crm.folders"] });
    let result = await query();
    for (let attempt = 0; attempt < 40 && result.total === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = await query();
    }
    expect(result.total).toBe(1);
    expect(result.rows[0]?.fields).toEqual({ "crm.title": "Budget", "crm.folders": ["Customers\\Miller", "Finance"] });

    const { source } = await createViewDataProvider({
      origin: "main",
      db,
      columns: [],
      filter: v.exists(v.field("crm.title")),
    });
    expect(source).toBe("summary");
  }, 30000);
});
