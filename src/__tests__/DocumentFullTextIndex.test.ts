import type { MindooDB } from "../core/types";
import { ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS } from "../core/types";
import { extractSummaryFields } from "../core/indexing/summary/extractSummaryFields";
import { resolveSummaryConfig } from "../core/indexing/summary/types";
import { DocumentFullTextIndex } from "../core/indexing/fulltext/DocumentFullTextIndex";
import { MiniSearchAdapter, createTokenizer } from "../core/indexing/fulltext/SearchEngineAdapter";
import {
  collectPlainText,
  extractFulltextFields,
} from "../core/indexing/fulltext/extractFulltextText";
import {
  computeFulltextConfigFingerprint,
  resolveFulltextConfig,
  sanitizeFulltextConfig,
} from "../core/indexing/fulltext/types";
import { MindooQueryError } from "../core/query/types";
import type { EphemeralSummaryView } from "../core/query/queryView";
import {
  ColumnSorting,
  SelectedOnly,
  VirtualViewColumn,
  VirtualViewFactory,
} from "../core/indexing/virtualviews";
import { createViewLanguage } from "../core/expressions";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { BaseMindooDB } from "../core/BaseMindooDB";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

/**
 * Coverage for the document full-text index (docs/fulltext-search.md):
 * plain-text extraction (incl. rich-text span shapes), the MiniSearch
 * engine adapter (dynamic fields, serialization roundtrip), changefeed
 * maintenance with tombstones, persistence/restore, config-fingerprint
 * backfill, dbsetup reconciliation, attachment extraction, and the
 * query-engine integration (text clause + textScore sorting).
 */
describe("full-text plain-text extraction", () => {
  it("collects text from strings, arrays, and nested objects", () => {
    expect(collectPlainText("hello world")).toBe("hello world");
    expect(collectPlainText(["alpha", "beta"])).toBe("alpha beta");
    expect(collectPlainText({ a: "one", b: { c: "two" } })).toBe("one two");
    expect(collectPlainText(42)).toBe("");
    expect(collectPlainText(true)).toBe("");
    expect(collectPlainText(null)).toBe("");
  });

  it("normalizes rich-text block markers to whitespace", () => {
    expect(collectPlainText("first\uFFFCsecond")).toBe("first second");
  });

  it("extracts text from rich-text span shapes", () => {
    const spans = [
      { type: "block", value: { tag: "paragraph" } },
      { type: "text", value: "Hello ", marks: { bold: true } },
      { type: "text", value: "world" },
      { type: "block", value: { tag: "paragraph" } },
      { type: "text", value: "Second paragraph" },
    ];
    expect(collectPlainText(spans)).toBe("Hello  world Second paragraph");

    expect(
      collectPlainText({ type: "immutableString", value: "tagged" })
    ).toBe("tagged");
  });

  it("auto mode indexes non-underscore top-level fields with text", () => {
    const config = resolveFulltextConfig({ enabled: true });
    const fields = extractFulltextFields(
      {
        title: "Quarterly report",
        body: "All numbers are up.",
        count: 42,
        _internal: "hidden",
        notes_encrypted: "AAAA",
        notes_encrypted_key: "k",
        tags: ["red", "green"],
      },
      config
    );
    expect(fields).toEqual({
      title: "Quarterly report",
      body: "All numbers are up.",
      tags: "red green",
    });
  });

  it("explicit include resolves nested paths and keeps only those", () => {
    const config = resolveFulltextConfig({ enabled: true, include: ["meta.abstract", "body"] });
    const fields = extractFulltextFields(
      { title: "ignored", body: "text body", meta: { abstract: "short summary" } },
      config
    );
    expect(fields).toEqual({
      "meta.abstract": "short summary",
      body: "text body",
    });
  });

  it("truncates values at maxFieldBytes instead of skipping them", () => {
    const config = resolveFulltextConfig({ enabled: true, maxFieldBytes: 10 });
    const fields = extractFulltextFields({ body: "0123456789ABCDEF" }, config);
    expect(fields.body).toBe("0123456789");
  });

  it("sanitizes untyped setup-document values into a FulltextConfig", () => {
    expect(sanitizeFulltextConfig(undefined)).toBeUndefined();
    expect(sanitizeFulltextConfig(null)).toBeUndefined();
    expect(sanitizeFulltextConfig("nope")).toBeUndefined();
    expect(sanitizeFulltextConfig([])).toBeUndefined();

    expect(
      sanitizeFulltextConfig({
        enabled: true,
        include: ["body", 42, "meta.abstract"],
        attachments: "yes",
        language: "de",
        maxFieldBytes: 4096,
        unknownProp: true,
      })
    ).toEqual({
      enabled: true,
      include: ["body", "meta.abstract"],
      language: "de",
      maxFieldBytes: 4096,
    });
  });

  it("includes language and format version in the fingerprint", () => {
    const base = computeFulltextConfigFingerprint(resolveFulltextConfig({ enabled: true }));
    const german = computeFulltextConfigFingerprint(
      resolveFulltextConfig({ enabled: true, language: "de" })
    );
    expect(base).not.toBe(german);
    expect(base).toContain("formatVersion");
  });
});

describe("tokenizer", () => {
  it("segments words and ignores punctuation", () => {
    const tokenize = createTokenizer("und");
    expect(tokenize("Hello, world! Foo-bar 123")).toEqual(
      expect.arrayContaining(["Hello", "world", "Foo", "bar", "123"])
    );
    expect(tokenize("...")).toEqual([]);
  });
});

describe("MiniSearchAdapter", () => {
  it("adds, searches (prefix, case-insensitive), and removes documents", () => {
    const engine = new MiniSearchAdapter("und");
    engine.add("doc-1", { title: "Zen and the Art of Motorcycle Maintenance" });
    engine.add("doc-2", { title: "The Art of Computer Programming" });

    let hits = engine.search("art");
    expect(hits.map((h) => h.docId).sort()).toEqual(["doc-1", "doc-2"]);

    // Prefix matching is on by default
    hits = engine.search("motorcy");
    expect(hits.map((h) => h.docId)).toEqual(["doc-1"]);

    // AND semantics by default
    hits = engine.search("art computer");
    expect(hits.map((h) => h.docId)).toEqual(["doc-2"]);

    engine.remove("doc-2");
    expect(engine.search("computer")).toEqual([]);
    expect(engine.getDocumentCount()).toBe(1);
  });

  it("re-adding a document replaces its previous content", () => {
    const engine = new MiniSearchAdapter("und");
    engine.add("doc-1", { body: "alpha" });
    engine.add("doc-1", { body: "beta" });
    expect(engine.search("alpha")).toEqual([]);
    expect(engine.search("beta").map((h) => h.docId)).toEqual(["doc-1"]);
    expect(engine.getDocumentCount()).toBe(1);
  });

  it("handles previously unseen field names (transparent rebuild)", () => {
    const engine = new MiniSearchAdapter("und");
    engine.add("doc-1", { title: "first document" });
    engine.add("doc-2", { summary: "second document" });

    expect(engine.search("document").map((h) => h.docId).sort()).toEqual(["doc-1", "doc-2"]);
    expect(engine.getFieldNames()).toEqual(["summary", "title"]);

    // Field-restricted search
    expect(engine.search("document", { fields: ["summary"] }).map((h) => h.docId)).toEqual([
      "doc-2",
    ]);
    // Unknown field → no matches
    expect(engine.search("document", { fields: ["nope"] })).toEqual([]);
  });

  it("serializes and restores the full engine state", () => {
    const engine = new MiniSearchAdapter("de");
    engine.add("doc-1", { body: "Der schnelle braune Fuchs" });
    engine.add("doc-2", { body: "springt über den faulen Hund" });

    const bytes = engine.serialize();
    const restored = new MiniSearchAdapter("de");
    restored.load(bytes);

    expect(restored.getDocumentCount()).toBe(2);
    expect(restored.search("fuchs").map((h) => h.docId)).toEqual(["doc-1"]);
    // New fields still work after restore (source texts survived)
    restored.add("doc-3", { extra: "Fuchs im Schnee" });
    expect(restored.search("fuchs").map((h) => h.docId).sort()).toEqual(["doc-1", "doc-3"]);
  });

  it("rejects payloads with a different language", () => {
    const engine = new MiniSearchAdapter("de");
    engine.add("doc-1", { body: "text" });
    const bytes = engine.serialize();

    const other = new MiniSearchAdapter("fr");
    expect(() => other.load(bytes)).toThrow(/language/);
  });
});

describe("DocumentFullTextIndex", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-fulltext");
    db = await ctx.tenant.openDB("fulltext-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  it("stays empty while disabled (default config)", async () => {
    await createDoc({ body: "searchable text" });

    const index = new DocumentFullTextIndex(db);
    await index.update();
    expect(index.getSize()).toBe(0);
    await expect(index.search("searchable")).rejects.toThrow(/not enabled/);
  }, 30000);

  it("builds from the changefeed and maintains entries incrementally", async () => {
    const id1 = await createDoc({ title: "Invoice March", body: "Total is 100 EUR" });
    const id2 = await createDoc({ title: "Meeting notes", body: "Discussed the roadmap" });

    const index = new DocumentFullTextIndex(db, { enabled: true });
    const result = await index.search("roadmap");
    expect(result.hits.map((h) => h.docId)).toEqual([id2]);
    expect(result.coverage).toBe("full");
    expect(index.getSize()).toBe(2);

    // Incremental: change one doc, add another — only the delta is consumed
    const doc1 = await db.getDocument(id1);
    await db.changeDoc(doc1, (d) => {
      d.getData().body = "Total is 200 EUR, roadmap attached";
    });
    const id3 = await createDoc({ title: "Roadmap 2027" });

    const updated = await index.search("roadmap");
    expect(updated.hits.map((h) => h.docId).sort()).toEqual([id1, id2, id3].sort());
  }, 30000);

  it("removes deleted documents (tombstones) and purged documents", async () => {
    const id1 = await createDoc({ body: "alpha content" });
    const id2 = await createDoc({ body: "alpha and beta" });

    const index = new DocumentFullTextIndex(db, { enabled: true });
    await index.update();
    expect(index.getSize()).toBe(2);

    await db.deleteDocument(id1);
    const result = await index.search("alpha");
    expect(result.hits.map((h) => h.docId)).toEqual([id2]);

    index.removeDocument(id2);
    expect(index.getSize()).toBe(0);
  }, 30000);

  it("persists to cache and restores without reprocessing the feed", async () => {
    const id1 = await createDoc({ body: "persistent content" });
    await createDoc({ body: "more persistent words" });

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const index1 = new DocumentFullTextIndex(db, { enabled: true });
    index1.attachCache(cacheManager, "testdb/fulltext");
    await index1.update();
    expect(index1.hasDirtyState()).toBe(true);
    await cacheManager.flush();
    expect(index1.hasDirtyState()).toBe(false);

    // Simulated restart: fresh index over the same cache
    const index2 = new DocumentFullTextIndex(db, { enabled: true });
    index2.attachCache(cacheManager, "testdb/fulltext");

    let processed = -1;
    await index2.update({
      onProgress: (p) => {
        processed = p.processed;
      },
    });

    // Everything came from the cache; the changefeed had nothing new
    expect(processed).toBe(0);
    expect(index2.getSize()).toBe(2);
    expect((await index2.search("persistent")).hits.map((h) => h.docId)).toContain(id1);

    await cacheManager.dispose();
  }, 30000);

  it("schedules a rebuild on restore when the config fingerprint differs", async () => {
    await createDoc({ body: "fingerprint test content" });

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 60000 });

    const index1 = new DocumentFullTextIndex(db, { enabled: true });
    index1.attachCache(cacheManager, "testdb/fulltext");
    await index1.update();
    await cacheManager.flush();

    // Restart with a different language: index starts empty and rebuilds
    const index2 = new DocumentFullTextIndex(db, { enabled: true, language: "de" });
    index2.attachCache(cacheManager, "testdb/fulltext");
    const result = await index2.search("fingerprint");
    expect(result.hits).toHaveLength(1);
    expect(result.coverage).toBe("full");

    await cacheManager.dispose();
  }, 30000);

  it("re-indexes after a runtime config change (backfill)", async () => {
    const id1 = await createDoc({ title: "visible title", body: "hidden body" });

    const index = new DocumentFullTextIndex(db, { enabled: true });
    await index.update();
    expect((await index.search("hidden")).hits.map((h) => h.docId)).toEqual([id1]);

    index.setConfig({ enabled: true, include: ["title"] });
    const afterChange = await index.search("hidden");
    expect(afterChange.hits).toEqual([]);
    expect((await index.search("visible")).hits.map((h) => h.docId)).toEqual([id1]);
    expect(index.getCoverage()).toBe("full");
  }, 30000);

  it("extracts rich-text field content (Automerge spans)", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().title = "Rich text doc";
    });
    await db.applyRichTextPatch(doc, {
      path: ["content"],
      spans: [
        { type: "block", value: { type: { type: "immutableString", value: "paragraph" } } },
        { type: "text", value: "The quick brown fox jumps over the lazy dog." },
      ],
    });

    const index = new DocumentFullTextIndex(db, { enabled: true });
    const result = await index.search("quick fox");
    expect(result.hits.map((h) => h.docId)).toEqual([doc.getId()]);
  }, 30000);

  it("indexes attachment text through registered extractors", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, async (d) => {
      d.getData().title = "Doc with attachment";
      await d.addAttachment(
        new TextEncoder().encode("Attachment payload with searchable pineapple"),
        "notes.txt",
        "text/plain"
      );
    });

    db.registerAttachmentTextExtractor!({
      supports: (mimeType) => mimeType === "text/plain",
      extract: async (bytes) => new TextDecoder().decode(bytes),
    });

    const index = db.getFullTextIndex!({ enabled: true, attachments: true });
    const result = await index.search("pineapple");
    expect(result.hits.map((h) => h.docId)).toEqual([doc.getId()]);

    // Attachment text lives under the synthetic _attachments field
    const fieldResult = await index.search("pineapple", { fields: ["_attachments"] });
    expect(fieldResult.hits).toHaveLength(1);
    const noField = await index.search("pineapple", { fields: ["title"] });
    expect(noField.hits).toHaveLength(0);
  }, 30000);
});

describe("attachment extraction results (setAttachmentExtractedText)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-extraction");
    db = await ctx.tenant.openDB("extraction-db");
  }, 30000);

  async function createDocWithAttachment(
    content: string,
    fileName = "scan.png",
    mimeType = "image/png"
  ): Promise<{ docId: string; attachmentId: string }> {
    const doc = await db.createDocument();
    let attachmentId = "";
    await db.changeDoc(doc, async (d) => {
      d.getData().title = "Doc with attachment";
      const ref = await d.addAttachment(
        new TextEncoder().encode(content),
        fileName,
        mimeType
      );
      attachmentId = ref.attachmentId;
    });
    return { docId: doc.getId(), attachmentId };
  }

  it("persists the result at the attachment entry and indexes it without extractors", async () => {
    const { docId, attachmentId } = await createDocWithAttachment("binary image bytes");

    const doc = await db.getDocument(docId);
    await db.changeDoc(doc, (d) => {
      d.setAttachmentExtractedText(attachmentId, {
        text: "OCR found the word aardvark in this scan",
        engine: "test-ocr@1:deu+eng",
      });
    });

    const [ref] = (await db.getDocument(docId)).getAttachments();
    expect(ref.extractedText).toBe("OCR found the word aardvark in this scan");
    expect(ref.extractionStatus).toBe("done");
    expect(ref.extractionEngine).toBe("test-ocr@1:deu+eng");
    expect(typeof ref.extractedAt).toBe("number");

    // No extractor registered, no `attachments: true` — persisted text is
    // still searchable under the synthetic _attachments field.
    const index = new DocumentFullTextIndex(db, { enabled: true });
    const result = await index.search("aardvark");
    expect(result.hits.map((h) => h.docId)).toEqual([docId]);
    const fieldResult = await index.search("aardvark", { fields: ["_attachments"] });
    expect(fieldResult.hits).toHaveLength(1);
  }, 30000);

  it("suppresses extractor runs for attachments with a persisted result or marker", async () => {
    const persisted = await createDocWithAttachment("payload one", "a.txt", "text/plain");
    const failed = await createDocWithAttachment("payload two", "b.txt", "text/plain");
    const untouched = await createDocWithAttachment(
      "extractor should read this cucumber",
      "c.txt",
      "text/plain"
    );

    const doc1 = await db.getDocument(persisted.docId);
    await db.changeDoc(doc1, (d) => {
      d.setAttachmentExtractedText(persisted.attachmentId, { text: "persisted mango text" });
    });
    const doc2 = await db.getDocument(failed.docId);
    await db.changeDoc(doc2, (d) => {
      d.setAttachmentExtractedText(failed.attachmentId, { text: null, status: "failed" });
    });

    const extractedIds: string[] = [];
    db.registerAttachmentTextExtractor!({
      supports: (mimeType) => mimeType === "text/plain",
      extract: async (bytes) => {
        const text = new TextDecoder().decode(bytes);
        extractedIds.push(text);
        return text;
      },
    });

    const index = db.getFullTextIndex!({ enabled: true, attachments: true });
    expect((await index.search("mango")).hits.map((h) => h.docId)).toEqual([persisted.docId]);
    expect((await index.search("cucumber")).hits.map((h) => h.docId)).toEqual([untouched.docId]);
    // Extractor only ran for the attachment without persisted result/marker
    expect(extractedIds).toEqual(["extractor should read this cucumber"]);
    // The failed-marker attachment contributed nothing
    expect((await index.search("payload")).hits).toEqual([]);
  }, 30000);

  it("clears a persisted result with text: null", async () => {
    const { docId, attachmentId } = await createDocWithAttachment("bytes");
    const doc = await db.getDocument(docId);
    await db.changeDoc(doc, (d) => {
      d.setAttachmentExtractedText(attachmentId, { text: "temporary zebra text" });
    });

    const index = new DocumentFullTextIndex(db, { enabled: true });
    expect((await index.search("zebra")).hits).toHaveLength(1);

    await db.changeDoc(await db.getDocument(docId), (d) => {
      d.setAttachmentExtractedText(attachmentId, { text: null });
    });
    const [ref] = (await db.getDocument(docId)).getAttachments();
    expect(ref.extractedText).toBeUndefined();
    expect(ref.extractionStatus).toBeUndefined();
    expect(ref.extractionEngine).toBeUndefined();
    expect(ref.extractedAt).toBeUndefined();

    expect((await index.search("zebra")).hits).toEqual([]);
  }, 30000);

  it("caps persisted text and validates the attachment id and callback context", async () => {
    const { docId, attachmentId } = await createDocWithAttachment("bytes");
    const doc = await db.getDocument(docId);

    await db.changeDoc(doc, (d) => {
      d.setAttachmentExtractedText(attachmentId, {
        text: "x".repeat(ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS + 500),
      });
      expect(() =>
        d.setAttachmentExtractedText("no-such-attachment", { text: "y" })
      ).toThrow(/not found/);
    });
    const [ref] = (await db.getDocument(docId)).getAttachments();
    expect(ref.extractedText!.length).toBe(ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS);

    // Outside changeDoc the read-only wrapper rejects the call
    expect(() =>
      (doc as any).setAttachmentExtractedText(attachmentId, { text: "z" })
    ).toThrow(/changeDoc/);
  }, 30000);

  it("projects hasExtractedText (but never the text) into the summary attachment info", async () => {
    const { docId, attachmentId } = await createDocWithAttachment("bytes");
    await db.changeDoc(await db.getDocument(docId), (d) => {
      d.setAttachmentExtractedText(attachmentId, { text: "summary projection check" });
    });

    const data = (await db.getDocument(docId)).getData();
    const fields = extractSummaryFields(
      data as Record<string, unknown>,
      resolveSummaryConfig()
    );
    const projected = fields["_attachments"] as Array<Record<string, unknown>>;
    expect(projected).toHaveLength(1);
    expect(projected[0].hasExtractedText).toBe(true);
    expect(projected[0].extractedText).toBeUndefined();
  }, 30000);
});

describe("extractionSetup (dbsetup document)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-extrsetup");
    db = await ctx.tenant.openDB("extrsetup-db");
  }, 30000);

  it("roundtrips through the setup document, idempotently", async () => {
    expect(await db.getExtractionSetup!()).toBeNull();

    await db.setExtractionSetup!({ enabled: true, languages: ["deu", "eng"] });
    expect(await db.getExtractionSetup!()).toEqual({
      enabled: true,
      languages: ["deu", "eng"],
    });

    // Idempotent: rewriting the same config creates no new revision
    const before = (await db.getDocument("dbsetup")).getHeads();
    await db.setExtractionSetup!({ enabled: true, languages: ["deu", "eng"] });
    const after = (await db.getDocument("dbsetup")).getHeads();
    expect(after).toEqual(before);

    await db.setExtractionSetup!(null);
    expect(await db.getExtractionSetup!()).toBeNull();
  }, 30000);

  it("sanitizes unknown fields and invalid values", async () => {
    await db.setExtractionSetup!({
      enabled: true,
      languages: ["deu", 42 as unknown as string],
      mimeTypes: ["image/", "" as string],
      maxCharsPerAttachment: 5000.9,
      bogus: "dropped",
    } as never);
    expect(await db.getExtractionSetup!()).toEqual({
      enabled: true,
      languages: ["deu"],
      mimeTypes: ["image/"],
      maxCharsPerAttachment: 5000,
    });
  }, 30000);
});

describe("fulltextSetup (dbsetup document)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-ftsetup");
    db = await ctx.tenant.openDB("ftsetup-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  it("round-trips the config via setFulltextSetup/getFulltextSetup", async () => {
    expect(await db.getFulltextSetup!()).toBeNull();

    await db.setFulltextSetup!({ enabled: true, include: ["body"], language: "de" });
    expect(await db.getFulltextSetup!()).toEqual({
      enabled: true,
      include: ["body"],
      language: "de",
    });

    await db.setFulltextSetup!(null);
    expect(await db.getFulltextSetup!()).toBeNull();
  }, 30000);

  it("setFulltextSetup is a no-op write when the config is unchanged", async () => {
    await db.setFulltextSetup!({ enabled: true, language: "de" });
    const historyBefore = await db.getDocumentHistoryPage("dbsetup");

    // Same config again (different object identity) must not create a revision.
    await db.setFulltextSetup!({ enabled: true, language: "de" });
    const historyAfter = await db.getDocumentHistoryPage("dbsetup");
    expect(historyAfter.entries.length).toBe(historyBefore.entries.length);

    // An actual change writes again.
    await db.setFulltextSetup!({ enabled: true, language: "en" });
    expect((await db.getFulltextSetup!())?.language).toBe("en");
  }, 30000);

  it("seeds the config from the setup document when none is passed in code", async () => {
    await db.setFulltextSetup!({ enabled: true });
    const id1 = await createDoc({ body: "setup seeded content" });

    const index = new DocumentFullTextIndex(db);
    const result = await index.search("seeded");
    expect(result.hits.map((h) => h.docId)).toEqual([id1]);
  }, 30000);

  it("applies setup-document changes through the changefeed with a rebuild", async () => {
    await db.setFulltextSetup!({ enabled: true });
    const id1 = await createDoc({ title: "only title", body: "searchable body" });

    const index = new DocumentFullTextIndex(db);
    expect((await index.search("searchable")).hits.map((h) => h.docId)).toEqual([id1]);

    // Restrict indexing to the title via the synced setup document
    await db.setFulltextSetup!({ enabled: true, include: ["title"] });
    expect((await index.search("searchable")).hits).toEqual([]);
    expect((await index.search("title")).hits.map((h) => h.docId)).toEqual([id1]);
  }, 30000);

  it("keeps the setup document itself out of the index", async () => {
    await db.setFulltextSetup!({ enabled: true });
    await createDoc({ body: "regular doc" });

    const index = new DocumentFullTextIndex(db);
    await index.update();
    expect(index.getSize()).toBe(1);
  }, 30000);

  it("db.searchText() works end-to-end via getFullTextIndex", async () => {
    await db.setFulltextSetup!({ enabled: true });
    const id1 = await createDoc({ body: "endtoend search target" });

    const result = await db.searchText!("endtoend");
    expect(result.hits.map((h) => h.docId)).toEqual([id1]);
  }, 30000);
});

describe("full-text open-time auto-activation", () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Timed out waiting for condition");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("activates the index at open when the setup document enables it", async () => {
    const ctx = await createWitnessingTenant("test-tenant-ftopen");
    const db = await ctx.tenant.openDB("ftopen-db");
    await db.setFulltextSetup!({ enabled: true });
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().body = "opentime searchable content";
    });

    // Simulated restart: a fresh instance over the same stores. No
    // change events arrive and no search runs — the open-time probe
    // alone must activate the index from the persisted setup document.
    const db2 = new BaseMindooDB(
      ctx.tenant as any,
      db.getStore(),
      db.getAttachmentStore(),
    );
    expect((db2 as any).fulltextIndex).toBeNull();
    await db2.initialize();

    await waitFor(() => (db2 as any).fulltextIndex !== null);
    const index = (db2 as any).fulltextIndex as DocumentFullTextIndex;
    await waitFor(() => index.getSize() === 1);
    const result = await index.search("opentime");
    expect(result.hits.map((h) => h.docId)).toEqual([doc.getId()]);
  }, 30000);

  it("stays inactive at open when the setup document does not enable it", async () => {
    const ctx = await createWitnessingTenant("test-tenant-ftopen-off");
    const db = await ctx.tenant.openDB("ftopenoff-db");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().body = "should not be indexed";
    });

    const db2 = new BaseMindooDB(
      ctx.tenant as any,
      db.getStore(),
      db.getAttachmentStore(),
    );
    await db2.initialize();

    // Give the fire-and-forget probe time to settle, then verify no
    // index was created (fulltextSetup is absent).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((db2 as any).fulltextIndex).toBeNull();
  }, 30000);
});

describe("query integration (text clause)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-ftquery");
    db = await ctx.tenant.openDB("ftquery-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  it("throws fulltext-not-enabled without an enabled index", async () => {
    await createDoc({ body: "text" });
    await expect(
      db.query!({ text: { query: "text" } })
    ).rejects.toMatchObject({ name: "MindooQueryError", code: "fulltext-not-enabled" });
  }, 30000);

  it("combines text clause and filter, sorted by textScore by default", async () => {
    await db.setFulltextSetup!({ enabled: true });
    const id1 = await createDoc({
      type: "article",
      body: "solar power and solar panels, solar everywhere",
    });
    const id2 = await createDoc({ type: "article", body: "a single mention of solar" });
    const id3 = await createDoc({ type: "note", body: "solar solar solar" });
    await createDoc({ type: "article", body: "wind energy only" });

    const result = await db.query!({
      text: { query: "solar" },
      filter: {
        kind: "operation",
        op: "eq",
        args: [
          { kind: "field", path: "type" },
          { kind: "literal", value: "article" },
        ],
      },
    });

    expect(result.rows.map((r) => r.docId).sort()).toEqual([id1, id2].sort());
    // Default ordering: best score first (exact ranking is up to BM25 —
    // e.g. field-length normalization — so only assert the sort contract)
    expect(result.rows[0].textScore).toBeGreaterThanOrEqual(result.rows[1].textScore!);
    expect(result.rows.every((r) => typeof r.textScore === "number")).toBe(true);
    expect(result.rows.map((r) => r.docId)).not.toContain(id3);
    expect(result.total).toBe(2);
  }, 30000);

  it("supports explicit textScore sort keys and field-restricted matching", async () => {
    await db.setFulltextSetup!({ enabled: true });
    const id1 = await createDoc({ title: "budget report", body: "nothing here" });
    const id2 = await createDoc({ title: "unrelated", body: "budget budget budget" });

    const titleOnly = await db.query!({
      text: { query: "budget", fields: ["title"] },
    });
    expect(titleOnly.rows.map((r) => r.docId)).toEqual([id1]);

    const ascending = await db.query!({
      text: { query: "budget" },
      sortBy: [{ special: "textScore", direction: "ascending" }],
    });
    expect(ascending.rows.map((r) => r.docId)).toEqual(
      [...(await db.query!({ text: { query: "budget" } })).rows.map((r) => r.docId)].reverse()
    );
    expect(ascending.rows.map((r) => r.docId).sort()).toEqual([id1, id2].sort());
  }, 30000);

  it("delivers live query updates when new documents match the text clause", async () => {
    await db.setFulltextSetup!({ enabled: true });
    await createDoc({ body: "first matching quasar" });

    const results: string[][] = [];
    await new Promise<void>((resolve, reject) => {
      let sawInitial = false;
      const subscription = db.queryLive!(
        { text: { query: "quasar" } },
        (result) => {
          results.push(result.rows.map((r) => r.docId));
          if (!sawInitial) {
            sawInitial = true;
            void createDoc({ body: "second quasar sighting" });
            return;
          }
          subscription.unsubscribe();
          resolve();
        },
        { onError: reject }
      );
      setTimeout(() => reject(new Error("timed out waiting for live query update")), 20000);
    });

    expect(results[0]).toHaveLength(1);
    expect(results[results.length - 1]).toHaveLength(2);
  }, 30000);

  it("propagates MindooQueryError code through db.query", async () => {
    await createDoc({ body: "text" });
    try {
      await db.query!({ text: { query: "text" } });
      throw new Error("expected MindooQueryError");
    } catch (error) {
      expect(error).toBeInstanceOf(MindooQueryError);
      expect((error as MindooQueryError).code).toBe("fulltext-not-enabled");
    }
  }, 30000);
});

describe("ephemeral view integration (text pre-filter)", () => {
  let db: MindooDB;
  const v = createViewLanguage<{ type: string; name: string; body: string }>();

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-ftview");
    db = await ctx.tenant.openDB("ftview-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  async function collectNames(view: EphemeralSummaryView): Promise<string[]> {
    const nav = VirtualViewFactory.createNavigator(view.getView()).build().expandAll();
    const names: string[] = [];
    for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
      if (entry.isDocument()) {
        names.push(String(entry.getColumnValues().name));
      }
    }
    return names;
  }

  it("pre-filters the view source with a text clause (AND with the filter)", async () => {
    await db.setFulltextSetup!({ enabled: true });
    await createDoc({ type: "article", name: "match1", body: "solar power plants" });
    await createDoc({ type: "article", name: "match2", body: "more solar farms" });
    await createDoc({ type: "article", name: "nomatch", body: "wind energy only" });
    await createDoc({ type: "note", name: "wrongtype", body: "solar notes" });

    const view = await db.queryView!({
      text: { query: "solar" },
      filter: v.eq(v.field("type"), "article"),
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });

    expect(await collectNames(view)).toEqual(["match1", "match2"]);
    view.dispose();
  }, 30000);

  it("keeps the text pre-filter up to date on incremental updates", async () => {
    await db.setFulltextSetup!({ enabled: true });
    await createDoc({ type: "article", name: "first", body: "comet sighting" });

    const view = await db.queryView!({
      text: { query: "comet" },
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    expect(await collectNames(view)).toEqual(["first"]);

    // A new matching document joins the view...
    await createDoc({ type: "article", name: "second", body: "another comet" });
    await view.update();
    expect(await collectNames(view)).toEqual(["first", "second"]);

    // ...and an edit that removes the match drops the document again.
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), { type: "article", name: "third", body: "comet three" });
    });
    await view.update();
    expect(await collectNames(view)).toEqual(["first", "second", "third"]);

    await db.changeDoc(doc, (d) => {
      d.getData().body = "no more celestial bodies";
    });
    await view.update();
    expect(await collectNames(view)).toEqual(["first", "second"]);
    view.dispose();
  }, 30000);

  it("supports changing the text clause via resort()", async () => {
    await db.setFulltextSetup!({ enabled: true });
    await createDoc({ type: "article", name: "a", body: "apples and pears" });
    await createDoc({ type: "article", name: "b", body: "bananas only" });

    const view = await db.queryView!({
      text: { query: "apples" },
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    expect(await collectNames(view)).toEqual(["a"]);

    await view.resort({
      text: { query: "bananas" },
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    expect(await collectNames(view)).toEqual(["b"]);
    view.dispose();
  }, 30000);

  it("throws fulltext-not-enabled when the view has a text clause without an enabled index", async () => {
    await createDoc({ type: "article", name: "x", body: "anything" });
    await expect(
      db.queryView!({
        text: { query: "anything" },
        columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
      })
    ).rejects.toMatchObject({ name: "MindooQueryError", code: "fulltext-not-enabled" });
  }, 30000);

  describe("text score pseudo-fields (_textScore / _textScoreRaw)", () => {
    const vs = createViewLanguage<{
      type: string;
      name: string;
      body: string;
      _textScore: number;
      _textScoreRaw: number;
    }>();

    async function collectColumns(
      view: EphemeralSummaryView
    ): Promise<Array<Record<string, unknown>>> {
      const nav = VirtualViewFactory.createNavigator(view.getView()).build().expandAll();
      const rows: Array<Record<string, unknown>> = [];
      for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
        if (entry.isDocument()) {
          rows.push(entry.getColumnValues());
        }
      }
      return rows;
    }

    it("exposes normalized and raw scores to column and category formulas", async () => {
      await db.setFulltextSetup!({ enabled: true });
      await createDoc({
        type: "article",
        name: "top",
        body: "solar power for solar homes: solar panels, solar storage and solar grids",
      });
      await createDoc({
        type: "article",
        name: "weak",
        body: "a report that briefly mentions solar energy among wind, hydro and geothermal sources",
      });

      const view = await db.queryView!({
        text: { query: "solar" },
        columns: [
          new VirtualViewColumn({
            name: "quality",
            isCategory: true,
            sorting: ColumnSorting.ASCENDING,
            expression: vs.ifElse(
              vs.gte(vs.field("_textScore"), 0.8), "sehr guter Treffer",
              vs.gte(vs.field("_textScore"), 0.5), "guter Treffer",
              "schlechter Treffer",
            ),
          }),
          VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
          new VirtualViewColumn({ name: "score", expression: vs.field("_textScore") }),
          new VirtualViewColumn({ name: "raw", expression: vs.field("_textScoreRaw") }),
        ],
      });

      const rows = await collectColumns(view);
      const byName = new Map(rows.map((row) => [String(row.name), row]));
      // The best hit is always normalized to exactly 1.0.
      expect(byName.get("top")!.score).toBe(1);
      expect(byName.get("top")!.quality).toBe("sehr guter Treffer");
      const weak = byName.get("weak")!;
      expect(weak.score).toBeGreaterThan(0);
      expect(weak.score).toBeLessThan(1);
      // Raw scores are engine-specific but present and consistent in order.
      expect(byName.get("top")!.raw as number).toBeGreaterThan(weak.raw as number);
      view.dispose();
    }, 30000);

    it("re-evaluates unchanged documents when a new top hit shifts their normalized score", async () => {
      await db.setFulltextSetup!({ enabled: true });
      await createDoc({
        type: "article",
        name: "first",
        body: "we saw a meteor shower tonight over the hills and it was a beautiful sight to behold",
      });

      const view = await db.queryView!({
        text: { query: "meteor" },
        columns: [
          VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
          new VirtualViewColumn({ name: "score", expression: vs.field("_textScore") }),
        ],
      });
      let rows = await collectColumns(view);
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(1);

      // A stronger hit arrives: "first" is unchanged in the summary, but
      // its normalized score drops and must be recomputed anyway.
      await createDoc({
        type: "article",
        name: "second",
        body: "meteor observation log: the meteor camera recorded one meteor fragment and a second meteor trail",
      });
      await view.update();
      rows = await collectColumns(view);
      const byName = new Map(rows.map((row) => [String(row.name), row]));
      expect(byName.get("second")!.score).toBe(1);
      expect(byName.get("first")!.score as number).toBeLessThan(1);
      view.dispose();
    }, 30000);

    it("rejects _textScore references when the view has no text clause", async () => {
      await db.setFulltextSetup!({ enabled: true });
      await createDoc({ type: "article", name: "x", body: "anything" });
      await expect(
        db.queryView!({
          columns: [
            new VirtualViewColumn({ name: "score", expression: vs.field("_textScore") }),
          ],
        })
      ).rejects.toMatchObject({ name: "MindooQueryError" });
    }, 30000);
  });
});
