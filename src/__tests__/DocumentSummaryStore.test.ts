import type { MindooDB } from "../core/types";
import { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import {
  buildSummaryEvaluationDoc,
  extractSummaryFields,
  getSummaryFieldValue,
  isFieldPathCovered,
} from "../core/indexing/summary/extractSummaryFields";
import {
  resolveSummaryConfig,
  sanitizeSummaryConfig,
  DB_SETUP_DOC_ID,
} from "../core/indexing/summary/types";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

/**
 * Coverage for the document summary buffer (docs/adhoc-queries.md):
 * extraction rules, incremental changefeed maintenance incl. tombstones,
 * bucket persistence/restore, and the config-fingerprint backfill with
 * interruption/resumption.
 */
describe("summary field extraction", () => {
  it("auto-includes scalar and scalar-array top-level fields", () => {
    const config = resolveSummaryConfig();
    const fields = extractSummaryFields(
      {
        name: "Alice",
        age: 42,
        active: true,
        nothing: null,
        tags: ["a", "b"],
        nested: { deep: 1 },
        mixedArray: [1, { x: 2 }],
        _internal: "hidden",
      },
      config
    );

    expect(fields).toEqual({
      name: "Alice",
      age: 42,
      active: true,
      nothing: null,
      tags: ["a", "b"],
    });
  });

  it("applies the size cap only to auto-included values", () => {
    const big = "x".repeat(50);
    const config = resolveSummaryConfig({ maxValueBytes: 20, include: ["bigIncluded"] });
    const fields = extractSummaryFields(
      { small: "ok", bigAuto: big, bigIncluded: big },
      config
    );

    expect(fields.small).toBe("ok");
    expect(fields.bigAuto).toBeUndefined();
    expect(fields.bigIncluded).toBe(big);
  });

  it("resolves explicit include paths (nested, non-scalar) under their dot-path key", () => {
    const config = resolveSummaryConfig({ include: ["meta.owner", "payload"] });
    const fields = extractSummaryFields(
      { meta: { owner: "bob" }, payload: { rich: [1, 2, 3] }, name: "x" },
      config
    );

    expect(fields["meta.owner"]).toBe("bob");
    expect(fields["payload"]).toEqual({ rich: [1, 2, 3] });
    expect(fields.name).toBe("x");
  });

  it("lets exclude win over auto-include and include (covering nested paths)", () => {
    const config = resolveSummaryConfig({
      include: ["secret.inner", "meta.owner"],
      exclude: ["secret", "name"],
    });
    const fields = extractSummaryFields(
      { name: "Alice", secret: { inner: "s" }, meta: { owner: "bob" } },
      config
    );

    expect(fields.name).toBeUndefined();
    expect(fields["secret.inner"]).toBeUndefined();
    expect(fields["meta.owner"]).toBe("bob");
  });

  it("reports configuration-level coverage for field paths", () => {
    const config = resolveSummaryConfig({ include: ["meta.owner"], exclude: ["secret"] });

    expect(isFieldPathCovered("name", config)).toBe(true);
    expect(isFieldPathCovered("name.sub", config)).toBe(true);
    expect(isFieldPathCovered("meta.owner", config)).toBe(true);
    expect(isFieldPathCovered("meta.owner.deep", config)).toBe(true);
    expect(isFieldPathCovered("secret", config)).toBe(false);
    expect(isFieldPathCovered("secret.inner", config)).toBe(false);
    expect(isFieldPathCovered("_internal", config)).toBe(false);

    const noAuto = resolveSummaryConfig({ autoInclude: false, include: ["meta.owner"] });
    expect(isFieldPathCovered("name", noAuto)).toBe(false);
    expect(isFieldPathCovered("meta.owner", noAuto)).toBe(true);
  });

  it("expands dot-path keys into nested objects for expression evaluation", () => {
    const flat = { name: "x", "meta.owner": "bob", "meta.tags": ["a"] };
    const doc = buildSummaryEvaluationDoc(flat);
    expect(doc).toEqual({ name: "x", meta: { owner: "bob", tags: ["a"] } });

    // No dot keys → same object, no copy
    const plain = { name: "x" };
    expect(buildSummaryEvaluationDoc(plain)).toBe(plain);
  });

  it("looks up summary values path-aware (flat dot-key first, then traversal)", () => {
    const fields = { name: "x", "meta.owner": "bob", info: { city: "Berlin" } };
    expect(getSummaryFieldValue(fields, "name")).toBe("x");
    expect(getSummaryFieldValue(fields, "meta.owner")).toBe("bob");
    expect(getSummaryFieldValue(fields, "info.city")).toBe("Berlin");
    expect(getSummaryFieldValue(fields, "missing.path")).toBeUndefined();
  });

  it("sanitizes untyped setup-document values into a SummaryConfig", () => {
    expect(sanitizeSummaryConfig(undefined)).toBeUndefined();
    expect(sanitizeSummaryConfig(null)).toBeUndefined();
    expect(sanitizeSummaryConfig("nope")).toBeUndefined();
    expect(sanitizeSummaryConfig([])).toBeUndefined();

    expect(
      sanitizeSummaryConfig({
        autoInclude: false,
        maxValueBytes: 512,
        include: ["meta.owner", 42, "tags"],
        exclude: "not-an-array",
        unknownProp: true,
      })
    ).toEqual({
      autoInclude: false,
      maxValueBytes: 512,
      include: ["meta.owner", "tags"],
    });
  });
});

describe("DocumentSummaryStore", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-summary");
    db = await ctx.tenant.openDB("summary-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  it("builds entries from the changefeed and maintains them incrementally", async () => {
    const id1 = await createDoc({ name: "Alice", amount: 10 });
    const id2 = await createDoc({ name: "Bob", amount: 20 });

    const summary = new DocumentSummaryStore(db);
    await summary.update();

    expect(summary.getSize()).toBe(2);
    expect(summary.getEntry(id1)?.fields).toMatchObject({ name: "Alice", amount: 10 });
    expect(summary.getEntry(id2)?.fields).toMatchObject({ name: "Bob", amount: 20 });
    expect(summary.getCoverage()).toBe("full");

    // Incremental: change one doc, add another — only the delta is consumed
    const doc1 = await db.getDocument(id1);
    await db.changeDoc(doc1, (d) => {
      d.getData().amount = 99;
    });
    const id3 = await createDoc({ name: "Carol" });

    await summary.update();
    expect(summary.getSize()).toBe(3);
    expect(summary.getEntry(id1)?.fields.amount).toBe(99);
    expect(summary.getEntry(id3)?.fields.name).toBe("Carol");
  }, 30000);

  it("removes entries for deleted documents (tombstones)", async () => {
    const id1 = await createDoc({ name: "Alice" });
    const id2 = await createDoc({ name: "Bob" });

    const summary = new DocumentSummaryStore(db);
    await summary.update();
    expect(summary.getSize()).toBe(2);

    await db.deleteDocument(id1);
    await summary.update();

    expect(summary.getSize()).toBe(1);
    expect(summary.getEntry(id1)).toBeUndefined();
    expect(summary.getEntry(id2)).toBeDefined();
  }, 30000);

  it("removes entries immediately via removeDocument (purge integration)", async () => {
    const id1 = await createDoc({ name: "Alice" });
    const summary = new DocumentSummaryStore(db);
    await summary.update();
    expect(summary.getEntry(id1)).toBeDefined();

    summary.removeDocument(id1);
    expect(summary.getEntry(id1)).toBeUndefined();
  }, 30000);

  it("supports interruption via onProgress and resumes from the cursor", async () => {
    for (let i = 0; i < 12; i++) {
      await createDoc({ name: `doc-${i}` });
    }

    const summary = new DocumentSummaryStore(db);
    await summary.update({
      applyBatchSize: 5,
      onProgress: () => false, // stop after the first batch
    });
    expect(summary.getSize()).toBe(5);

    await summary.update();
    expect(summary.getSize()).toBe(12);
  }, 30000);

  it("persists to bucket cache and restores without reprocessing the feed", async () => {
    const id1 = await createDoc({ name: "Alice", amount: 1 });
    await createDoc({ name: "Bob", amount: 2 });

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const summary1 = new DocumentSummaryStore(db);
    summary1.attachCache(cacheManager, "testdb/summary");
    await summary1.update();
    expect(summary1.hasDirtyState()).toBe(true);
    await cacheManager.flush();
    expect(summary1.hasDirtyState()).toBe(false);

    // Simulated restart: fresh store over the same cache
    const summary2 = new DocumentSummaryStore(db);
    summary2.attachCache(cacheManager, "testdb/summary");

    let processed = -1;
    await summary2.update({
      onProgress: (p) => {
        processed = p.processed;
      },
    });

    // Everything came from the cache; the changefeed had nothing new
    expect(processed).toBe(0);
    expect(summary2.getSize()).toBe(2);
    expect(summary2.getEntry(id1)?.fields).toMatchObject({ name: "Alice", amount: 1 });
    expect(summary2.getCoverage()).toBe("full");

    await cacheManager.dispose();
  }, 30000);

  it("re-extracts all entries after a runtime config change (backfill)", async () => {
    const id1 = await createDoc({ name: "Alice", secret: "s3cret" });

    const summary = new DocumentSummaryStore(db);
    await summary.update();
    expect(summary.getEntry(id1)?.fields.secret).toBe("s3cret");

    summary.setConfig({ exclude: ["secret"] });
    expect(summary.getCoverage()).toBe("rebuilding");
    expect(summary.isFieldCovered("secret")).toBe(false);

    await summary.update();
    expect(summary.getCoverage()).toBe("full");
    expect(summary.getEntry(id1)?.fields.secret).toBeUndefined();
    expect(summary.getEntry(id1)?.fields.name).toBe("Alice");
  }, 30000);

  it("schedules a backfill on restore when the config fingerprint differs, resumable after interruption", async () => {
    for (let i = 0; i < 10; i++) {
      await createDoc({ name: `doc-${i}`, secret: `s-${i}` });
    }

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const summary1 = new DocumentSummaryStore(db);
    summary1.attachCache(cacheManager, "testdb/summary");
    await summary1.update();
    await cacheManager.flush();

    // Restart with a DIFFERENT config: entries restore, backfill is scheduled
    const summary2 = new DocumentSummaryStore(db, { exclude: ["secret"] });
    summary2.attachCache(cacheManager, "testdb/summary");

    // Interrupt the backfill after the first batch: old entries stay usable
    await summary2.update({
      applyBatchSize: 4,
      onProgress: () => false,
    });
    expect(summary2.getCoverage()).toBe("rebuilding");
    expect(summary2.getSize()).toBe(10);

    // Resume and finish: all entries re-extracted without `secret`
    await summary2.update();
    expect(summary2.getCoverage()).toBe("full");
    for (const entry of summary2.getAllEntries()) {
      expect(entry.fields.secret).toBeUndefined();
      expect(entry.fields.name).toBeDefined();
    }

    await cacheManager.dispose();
  }, 30000);

  it("is lazily attached to BaseMindooDB via getSummaryStore", async () => {
    await createDoc({ name: "Alice" });

    const store1 = db.getSummaryStore!();
    const store2 = db.getSummaryStore!();
    expect(store1).toBe(store2);

    await store1.update();
    expect(store1.getSize()).toBe(1);
  }, 30000);
});

describe("dbsetup design document", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-dbsetup");
    db = await ctx.tenant.openDB("dbsetup-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  it("round-trips the config via setSummarySetup/getSummarySetup", async () => {
    expect(await db.getSummarySetup!()).toBeNull();

    await db.setSummarySetup!({ exclude: ["secret"], include: ["meta.owner"] });
    expect(await db.getSummarySetup!()).toEqual({
      exclude: ["secret"],
      include: ["meta.owner"],
    });

    // The config lives in a regular document with the fixed ID
    const setupDoc = await db.getDocument(DB_SETUP_DOC_ID);
    expect(setupDoc.getData().summarySetup).toBeDefined();

    await db.setSummarySetup!(null);
    expect(await db.getSummarySetup!()).toBeNull();
  }, 30000);

  it("seeds the summary config from the setup document when none is passed in code", async () => {
    await db.setSummarySetup!({ exclude: ["secret"] });
    const id1 = await createDoc({ name: "Alice", secret: "s3cret" });

    const summary = new DocumentSummaryStore(db);
    await summary.update();

    expect(summary.getEntry(id1)?.fields.name).toBe("Alice");
    expect(summary.getEntry(id1)?.fields.secret).toBeUndefined();
    expect(summary.isFieldCovered("secret")).toBe(false);
  }, 30000);

  it("ignores the setup document when an explicit config was passed", async () => {
    await db.setSummarySetup!({ exclude: ["name"] });
    const id1 = await createDoc({ name: "Alice" });

    const summary = new DocumentSummaryStore(db, {});
    await summary.update();

    expect(summary.getEntry(id1)?.fields.name).toBe("Alice");
  }, 30000);

  it("applies setup-document changes through the changefeed with a backfill", async () => {
    const id1 = await createDoc({ name: "Alice", secret: "s3cret" });

    const summary = new DocumentSummaryStore(db);
    await summary.update();
    expect(summary.getEntry(id1)?.fields.secret).toBe("s3cret");

    // Changing the setup doc arrives like any other document change
    await db.setSummarySetup!({ exclude: ["secret"] });
    await summary.update();

    expect(summary.getCoverage()).toBe("full");
    expect(summary.getEntry(id1)?.fields.secret).toBeUndefined();
    expect(summary.getEntry(id1)?.fields.name).toBe("Alice");

    // Removing the config falls back to the default auto-include rules
    await db.setSummarySetup!(null);
    await summary.update();
    expect(summary.getEntry(id1)?.fields.secret).toBe("s3cret");
  }, 30000);

  it("keeps the setup document itself out of the summary", async () => {
    await db.setSummarySetup!({ exclude: ["secret"] });
    await createDoc({ name: "Alice" });

    const summary = new DocumentSummaryStore(db);
    await summary.update();

    expect(summary.getSize()).toBe(1);
    expect(summary.getEntry(DB_SETUP_DOC_ID)).toBeUndefined();
  }, 30000);
});
