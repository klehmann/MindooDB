import { expect, test } from "@playwright/test";

import {
  startTempSyncServer,
  type BrowserSyncServer,
} from "./fixtures/tempSyncServer";

test.describe("IndexedDBContentAddressedStore", () => {
  let server: BrowserSyncServer;

  test.beforeAll(async () => {
    server = await startTempSyncServer({
      tenantId: "indexeddb-store-test-tenant",
    });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  // -----------------------------------------------------------------------
  // Basic operations
  // -----------------------------------------------------------------------

  test("should store and retrieve entries by id", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string, dependencyIds: string[] = [], entryType = "doc_change") {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType, id, contentHash, docId, dependencyIds,
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("basic-ops", undefined, { basePath: prefix });

        try {
          const entry = createTestEntry("doc1", "id1", "content1");
          await store.putEntries([entry]);

          const retrieved = await store.getEntries(["id1"]);
          return {
            count: retrieved.length,
            id: retrieved[0].id,
            docId: retrieved[0].docId,
            dataMatch: JSON.stringify(Array.from(retrieved[0].encryptedData)) ===
                       JSON.stringify(Array.from(entry.encryptedData)),
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.count).toBe(1);
    expect(result.id).toBe("id1");
    expect(result.docId).toBe("doc1");
    expect(result.dataMatch).toBe(true);
  });

  test("should return empty array for non-existent ids", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("empty-test", undefined, { basePath: prefix });

        try {
          const retrieved = await store.getEntries(["non-existent"]);
          return { count: retrieved.length };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.count).toBe(0);
  });

  test("should check which ids exist with hasEntries", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("has-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "content1"),
            createTestEntry("doc1", "id2", "content2"),
          ]);

          const existing = await store.hasEntries(["id1", "id2", "id3"]);
          return {
            count: existing.length,
            hasId1: existing.includes("id1"),
            hasId2: existing.includes("id2"),
            hasId3: existing.includes("id3"),
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.count).toBe(2);
    expect(result.hasId1).toBe(true);
    expect(result.hasId2).toBe(true);
    expect(result.hasId3).toBe(false);
  });

  test("should get all entry ids", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("allids-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "content1"),
            createTestEntry("doc2", "id2", "content2"),
          ]);

          const allIds = await store.getAllIds();
          return {
            count: allIds.length,
            hasId1: allIds.includes("id1"),
            hasId2: allIds.includes("id2"),
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.count).toBe(2);
    expect(result.hasId1).toBe(true);
    expect(result.hasId2).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Content deduplication
  // -----------------------------------------------------------------------

  test("should deduplicate entries with same contentHash", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("dedup-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "same-content-hash"),
            createTestEntry("doc2", "id2", "same-content-hash"),
          ]);

          const r1 = await store.getEntries(["id1"]);
          const r2 = await store.getEntries(["id2"]);

          return {
            r1Count: r1.length,
            r2Count: r2.length,
            r1DocId: r1[0].docId,
            r2DocId: r2[0].docId,
            dataMatch:
              JSON.stringify(Array.from(r1[0].encryptedData)) ===
              JSON.stringify(Array.from(r2[0].encryptedData)),
            allIdsCount: (await store.getAllIds()).length,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.r1Count).toBe(1);
    expect(result.r2Count).toBe(1);
    expect(result.r1DocId).toBe("doc1");
    expect(result.r2DocId).toBe("doc2");
    expect(result.dataMatch).toBe(true);
    expect(result.allIdsCount).toBe(2);
  });

  test("should not overwrite entry with same id", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("noop-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([createTestEntry("doc1", "id1", "content1")]);
          await store.putEntries([createTestEntry("doc1", "id1", "content2")]);

          const retrieved = await store.getEntries(["id1"]);
          return { contentHash: retrieved[0].contentHash };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.contentHash).toBe("content1");
  });

  // -----------------------------------------------------------------------
  // Document-scoped queries
  // -----------------------------------------------------------------------

  test("should find new entries for specific document", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("docquery-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "c1"),
            createTestEntry("doc1", "id2", "c2"),
            createTestEntry("doc2", "id3", "c3"),
          ]);

          const newForDoc1 = await store.findNewEntriesForDoc(["id1"], "doc1");
          const newForDoc2 = await store.findNewEntriesForDoc([], "doc2");

          return {
            newForDoc1Count: newForDoc1.length,
            newForDoc1Id: newForDoc1[0]?.id,
            newForDoc2Count: newForDoc2.length,
            newForDoc2Id: newForDoc2[0]?.id,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.newForDoc1Count).toBe(1);
    expect(result.newForDoc1Id).toBe("id2");
    expect(result.newForDoc2Count).toBe(1);
    expect(result.newForDoc2Id).toBe("id3");
  });

  test("should find all new entries across documents", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("newentries-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "c1"),
            createTestEntry("doc2", "id2", "c2"),
          ]);

          const newEntries = await store.findNewEntries(["id1"]);
          return {
            count: newEntries.length,
            id: newEntries[0]?.id,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.count).toBe(1);
    expect(result.id).toBe("id2");
  });

  // -----------------------------------------------------------------------
  // Cursor-based scan
  // -----------------------------------------------------------------------

  test("should scan entries with cursor pagination", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string, createdAt: number) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt, createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("scan-test", undefined, { basePath: prefix });

        try {
          const now = Date.now();
          await store.putEntries([
            createTestEntry("doc1", "id1", "c1", now),
            createTestEntry("doc1", "id2", "c2", now + 1),
            createTestEntry("doc2", "id3", "c3", now + 2),
          ]);

          const page1 = await store.scanEntriesSince(null, 2);
          const page2 = await store.scanEntriesSince(page1.nextCursor, 2);

          return {
            page1Ids: page1.entries.map((e: any) => e.id),
            page1HasMore: page1.hasMore,
            page2Ids: page2.entries.map((e: any) => e.id),
            page2HasMore: page2.hasMore,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.page1Ids).toEqual(["id1", "id2"]);
    expect(result.page1HasMore).toBe(true);
    expect(result.page2Ids).toEqual(["id3"]);
    expect(result.page2HasMore).toBe(false);
  });

  test("should support doc filter in cursor scan", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("scanfilter-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("docA", "id1", "c1"),
            createTestEntry("docB", "id2", "c2"),
            createTestEntry("docA", "id3", "c3"),
          ]);

          const scanned = await store.scanEntriesSince(null, 100, {
            docId: "docA",
          });
          return {
            count: scanned.entries.length,
            allDocA: scanned.entries.every((e: any) => e.docId === "docA"),
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.count).toBe(2);
    expect(result.allDocA).toBe(true);
  });

  // -----------------------------------------------------------------------
  // findEntries with type and date filtering
  // -----------------------------------------------------------------------

  test("should find entries by type and date range", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("findentries-test", undefined, { basePath: prefix });

        try {
          const now = Date.now();
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          const mkEntry = (id: string, type: string, createdAt: number) => ({
            entryType: type, id, contentHash: "c-" + id, docId: "doc1",
            dependencyIds: [] as string[], createdAt,
            createdByPublicKey: "test-public-key", decryptionKeyId: "default",
            signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          });

          await store.putEntries([
            mkEntry("id1", "doc_create", now - 1000),
            mkEntry("id2", "doc_change", now),
            mkEntry("id3", "doc_create", now + 1000),
          ]);

          const allCreate = await store.findEntries("doc_create", null, null);
          const ranged = await store.findEntries("doc_create", now - 500, now + 500);

          return {
            allCreateCount: allCreate.length,
            rangedCount: ranged.length,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.allCreateCount).toBe(2);
    expect(result.rangedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Bloom filter with caching
  // -----------------------------------------------------------------------

  test("should include known IDs in bloom summary", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("bloom-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "c1"),
            createTestEntry("doc2", "id2", "c2"),
          ]);

          const summary = await store.getIdBloomSummary();
          return {
            version: summary.version,
            totalIds: summary.totalIds,
            hasBitsetBase64: typeof summary.bitsetBase64 === "string" && summary.bitsetBase64.length > 0,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.version).toBe("bloom-v1");
    expect(result.totalIds).toBe(2);
    expect(result.hasBitsetBase64).toBe(true);
  });

  test("should return cached bloom summary and invalidate on writes", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("bloom-cache-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([createTestEntry("doc1", "id1", "c1")]);

          const summary1 = await store.getIdBloomSummary();
          const summary2 = await store.getIdBloomSummary();
          const sameCache =
            summary1.bitsetBase64 === summary2.bitsetBase64 &&
            summary1.totalIds === summary2.totalIds;

          await store.putEntries([createTestEntry("doc2", "id2", "c2")]);
          const summary3 = await store.getIdBloomSummary();

          return {
            sameCache,
            summary1TotalIds: summary1.totalIds,
            summary3TotalIds: summary3.totalIds,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.sameCache).toBe(true);
    expect(result.summary1TotalIds).toBe(1);
    expect(result.summary3TotalIds).toBe(2);
  });

  // -----------------------------------------------------------------------
  // purgeDocHistory
  // -----------------------------------------------------------------------

  test("should remove all entries for a document", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("purge-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "content1"),
            createTestEntry("doc1", "id2", "content2"),
            createTestEntry("doc2", "id3", "content3"),
          ]);

          await store.purgeDocHistory("doc1");

          const doc1Entries = await store.getEntries(["id1", "id2"]);
          const doc2Entries = await store.getEntries(["id3"]);

          return {
            doc1Count: doc1Entries.length,
            doc2Count: doc2Entries.length,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.doc1Count).toBe(0);
    expect(result.doc2Count).toBe(1);
  });

  test("should clean up orphaned content after purge", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("purge-orphan-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            createTestEntry("doc1", "id1", "unique-content"),
            createTestEntry("doc2", "id2", "shared-content"),
            createTestEntry("doc1", "id3", "shared-content"),
          ]);

          await store.purgeDocHistory("doc1");

          const doc2 = await store.getEntries(["id2"]);
          const allIds = await store.getAllIds();

          return {
            doc2Count: doc2.length,
            doc2HasData: doc2[0]?.encryptedData?.length > 0,
            remainingIds: allIds.length,
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.doc2Count).toBe(1);
    expect(result.doc2HasData).toBe(true);
    expect(result.remainingIds).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Dependency resolution
  // -----------------------------------------------------------------------

  test("should resolve dependency chain", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
        function mkEntry(id: string, deps: string[]) {
          return {
            entryType: "doc_change", id, contentHash: "c-" + id, docId: "doc1",
            dependencyIds: deps, createdAt: Date.now(),
            createdByPublicKey: "test-public-key", decryptionKeyId: "default",
            signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("deps-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            mkEntry("id1", []),
            mkEntry("id2", ["id1"]),
            mkEntry("id3", ["id2"]),
          ]);

          const deps = await store.resolveDependencies("id3");
          return { deps };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.deps).toEqual(["id1", "id2", "id3"]);
  });

  test("should stop at specified entry type", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
        function mkEntry(id: string, deps: string[], type: string) {
          return {
            entryType: type, id, contentHash: "c-" + id, docId: "doc1",
            dependencyIds: deps, createdAt: Date.now(),
            createdByPublicKey: "test-public-key", decryptionKeyId: "default",
            signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const store = new IndexedDBContentAddressedStore("deps-stop-test", undefined, { basePath: prefix });

        try {
          await store.putEntries([
            mkEntry("id1", [], "doc_create"),
            mkEntry("id2", ["id1"], "doc_snapshot"),
            mkEntry("id3", ["id2"], "doc_change"),
          ]);

          const deps = await store.resolveDependencies("id3", {
            stopAtEntryType: "doc_snapshot",
          });
          return { deps };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.deps).toEqual(["id2", "id3"]);
  });

  // -----------------------------------------------------------------------
  // Multi-database isolation
  // -----------------------------------------------------------------------

  test("two stores with different dbId are isolated", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const storeA = new IndexedDBContentAddressedStore("db-A", undefined, { basePath: prefix });
        const storeB = new IndexedDBContentAddressedStore("db-B", undefined, { basePath: prefix });

        try {
          await storeA.putEntries([createTestEntry("doc1", "id1", "c1")]);
          await storeB.putEntries([createTestEntry("doc2", "id2", "c2")]);

          const aIds = await storeA.getAllIds();
          const bIds = await storeB.getAllIds();
          const aGet = await storeA.getEntries(["id2"]);
          const bGet = await storeB.getEntries(["id1"]);

          return {
            aIds,
            bIds,
            aCrossGet: aGet.length,
            bCrossGet: bGet.length,
          };
        } finally {
          await storeA.clearAllLocalData();
          await storeB.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.aIds).toEqual(["id1"]);
    expect(result.bIds).toEqual(["id2"]);
    expect(result.aCrossGet).toBe(0);
    expect(result.bCrossGet).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Persistence and clearAllLocalData
  // -----------------------------------------------------------------------

  test("should persist data across store re-open", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-persist-" + Date.now();

        const store1 = new IndexedDBContentAddressedStore("persist-db", undefined, { basePath: prefix });
        await store1.putEntries([createTestEntry("doc1", "id1", "c1")]);

        const store2 = new IndexedDBContentAddressedStore("persist-db", undefined, { basePath: prefix });
        const ids = await store2.getAllIds();
        const entries = await store2.getEntries(["id1"]);

        await store2.clearAllLocalData();

        return {
          idsCount: ids.length,
          entryId: entries[0]?.id,
          entryDocId: entries[0]?.docId,
        };
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.idsCount).toBe(1);
    expect(result.entryId).toBe("id1");
    expect(result.entryDocId).toBe("doc1");
  });

  test("clearAllLocalData should delete the IDB database", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const prefix = "test-clear-" + Date.now();

        const store = new IndexedDBContentAddressedStore("clear-db", undefined, { basePath: prefix });
        await store.putEntries([createTestEntry("doc1", "id1", "c1")]);
        const beforeIds = await store.getAllIds();

        await store.clearAllLocalData();

        const store2 = new IndexedDBContentAddressedStore("clear-db", undefined, { basePath: prefix });
        const afterIds = await store2.getAllIds();
        await store2.clearAllLocalData();

        return {
          beforeCount: beforeIds.length,
          afterCount: afterIds.length,
        };
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.beforeCount).toBe(1);
    expect(result.afterCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Persistence across page navigation
  // -----------------------------------------------------------------------

  test("should persist data across page navigation", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const prefix = `nav-persist-${Date.now()}`;

    await page.evaluate(
      async ({ browserBundleUrl, prefix }) => {
        function createTestEntry(docId: string, id: string, contentHash: string) {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType: "doc_change", id, contentHash, docId, dependencyIds: [] as string[],
            createdAt: Date.now(), createdByPublicKey: "test-public-key",
            decryptionKeyId: "default", signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4, encryptedSize: encryptedData.length, encryptedData,
          };
        }

        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const store = new IndexedDBContentAddressedStore("nav-db", undefined, { basePath: prefix });
        await store.putEntries([
          createTestEntry("doc1", "id1", "c1"),
          createTestEntry("doc2", "id2", "c2"),
        ]);
      },
      { browserBundleUrl: server.context.browserBundleUrl, prefix }
    );

    await page.goto("about:blank");
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl, prefix }) => {
        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;
        const store = new IndexedDBContentAddressedStore("nav-db", undefined, { basePath: prefix });

        try {
          const ids = await store.getAllIds();
          const entries = await store.getEntries(["id1", "id2"]);

          return {
            idsCount: ids.length,
            entriesCount: entries.length,
            ids: ids.sort(),
          };
        } finally {
          await store.clearAllLocalData();
        }
      },
      { browserBundleUrl: server.context.browserBundleUrl, prefix }
    );

    expect(result.idsCount).toBe(2);
    expect(result.entriesCount).toBe(2);
    expect(result.ids).toEqual(["id1", "id2"]);
  });
});
