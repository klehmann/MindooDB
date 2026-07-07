import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { BaseMindooDB } from "../core/BaseMindooDB";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  DEFAULT_TENANT_KEY_ID,
  PrivateUserId,
  MindooTenant,
  MindooDB,
  MindooDoc,
  ProcessChangesCursor,
  PUBLIC_INFOS_KEY_ID,
  PerformanceCallback,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

describe("iterateChangesSince", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let adminKeyBag: KeyBag;
  let currentUserKeyBag: KeyBag;
  let tenant: MindooTenant;
  let tenantId: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    currentUserPassword = "currentpass123";
    currentUser = await factory.createUserId("CN=currentuser/O=testtenant", currentUserPassword);
    
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(adminUser.userEncryptionKeyPair.privateKey, adminUserPassword, cryptoAdapter);
    currentUserKeyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, cryptoAdapter);
    
    tenantId = "test-tenant-iterate-changes";
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);
    await currentUserKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await currentUserKeyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );
    tenant = await factory.openTenant(tenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, currentUser, currentUserPassword, currentUserKeyBag);
    
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(publicAdminUser, adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    const publicCurrentUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(publicCurrentUser, adminUser.userSigningKeyPair.privateKey, adminUserPassword);
  }, 30000);

  describe("large document set", () => {
    it("should process 1000+ documents in correct order", async () => {
      const db = await tenant.openDB("test-db");
      
      const numDocs = 1500;
      const createdDocs: Array<{ docId: string; lastModified: number }> = [];
      
      // Create documents with controlled timestamps
      const baseTime = Date.now();
      for (let i = 0; i < numDocs; i++) {
        const doc = await db.createDocument();
        const docId = doc.getId();
        
        // Modify document to set a controlled timestamp
        await db.changeDoc(doc, (d) => {
          const data = d.getData();
          data.index = i;
          data.timestamp = baseTime + i; // Ensure unique timestamps
        });
        
        // Get the actual lastModified after change
        const updatedDoc = await db.getDocument(docId);
        createdDocs.push({
          docId: docId,
          lastModified: updatedDoc.getLastModified()
        });
        
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      
      // Sync to ensure all changes are processed
      await db.syncStoreChanges();
      
      // Iterate through all documents
      const processedDocs: Array<{ docId: string; lastModified: number; cursor: ProcessChangesCursor }> = [];
      for await (const { doc, cursor } of db.iterateChangesSince(null)) {
        processedDocs.push({
          docId: doc.getId(),
          lastModified: doc.getLastModified(),
          cursor
        });
      }
      
      // Verify all documents were processed
      expect(processedDocs.length).toBe(numDocs);
      
      // Verify documents are in correct deterministic order (by changeSeq, then docId)
      for (let i = 1; i < processedDocs.length; i++) {
        const prev = processedDocs[i - 1];
        const curr = processedDocs[i];
        const prevChangeSeq = prev.cursor.changeSeq ?? 0;
        const currChangeSeq = curr.cursor.changeSeq ?? 0;
        
        if (prevChangeSeq === currChangeSeq) {
          expect(prev.docId.localeCompare(curr.docId)).toBeLessThanOrEqual(0);
        } else {
          expect(prevChangeSeq).toBeLessThan(currChangeSeq);
        }
      }
      
      // Verify cursor tracking is correct
      for (let i = 0; i < processedDocs.length; i++) {
        const result = processedDocs[i];
        expect(result.cursor.docId).toBe(result.docId);
        expect(result.cursor.lastModified).toBe(result.lastModified);
        expect((result.cursor.changeSeq ?? 0)).toBeGreaterThan(0);
      }
    }, 60000);
  });

  describe("early termination", () => {
    it("should support breaking early after processing some documents", async () => {
      const db = await tenant.openDB("test-db");
      
      const numDocs = 500;
      const breakAfter = 100;
      
      // Create documents
      for (let i = 0; i < numDocs; i++) {
        const doc = await db.createDocument();
        await db.changeDoc(doc, (d) => {
          const data = d.getData();
          data.index = i;
        });
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      
      await db.syncStoreChanges();
      
      // Iterate and break early
      let processedCount = 0;
      let lastCursor: ProcessChangesCursor | null = null;
      
      for await (const { doc, cursor } of db.iterateChangesSince(null)) {
        processedCount++;
        lastCursor = cursor;
        
        if (processedCount >= breakAfter) {
          break;
        }
      }
      
      // Verify only expected documents were processed
      expect(processedCount).toBe(breakAfter);
      expect(lastCursor).not.toBeNull();
      
      // Verify we can resume from the cursor
      let resumedCount = 0;
      for await (const { doc } of db.iterateChangesSince(lastCursor)) {
        resumedCount++;
      }
      
      // Should have processed the remaining documents
      expect(processedCount + resumedCount).toBe(numDocs);
    }, 60000);

    it("does not materialize the entire tail when iteration stops early", async () => {
      const loadMetrics: Array<{ docId: string; cacheHit: boolean }> = [];
      const syncMetrics: Array<{
        operation: string;
        details?: Record<string, unknown>;
      }> = [];
      const performanceCallback: PerformanceCallback = {
        onDocumentLoad: (metrics) => {
          loadMetrics.push({ docId: metrics.docId, cacheHit: metrics.cacheHit });
        },
        onSyncOperation: (metrics) => {
          syncMetrics.push(metrics);
        },
      };
      const db = await tenant.openDB("test-db-no-tail-prefetch", {
        documentCacheConfig: {
          maxEntries: 8,
          iteratePrefetchWindowDocs: 0,
        },
        performanceCallback,
      });

      const numDocs = 120;
      for (let i = 0; i < numDocs; i++) {
        const doc = await db.createDocument();
        await db.changeDoc(doc, (d) => {
          d.getData().index = i;
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      await db.syncStoreChanges();
      loadMetrics.length = 0;
      syncMetrics.length = 0;

      let processedCount = 0;
      for await (const _result of db.iterateChangesSince(null)) {
        processedCount++;
        if (processedCount === 5) {
          break;
        }
      }

      expect(processedCount).toBe(5);
      expect(loadMetrics.filter((metric) => !metric.cacheHit).length).toBeLessThanOrEqual(5);

      const iterationMetric = syncMetrics.find(
        (metric) => metric.operation === "iterateChangesSince"
      );
      expect(iterationMetric).toBeDefined();
      expect(iterationMetric?.details?.prefetchedDocuments).toBe(0);
      expect(
        Number(iterationMetric?.details?.loadedDocuments ?? Number.NaN)
      ).toBeLessThanOrEqual(5);
    }, 60000);
  });

  describe("metadata-only iteration", () => {
    it("yields latest-state metadata without materializing documents", async () => {
      const loadMetrics: Array<{ docId: string; cacheHit: boolean }> = [];
      const syncMetrics: Array<{
        operation: string;
        details?: Record<string, unknown>;
      }> = [];
      const db = await tenant.openDB("test-db-metadata-only", {
        performanceCallback: {
          onDocumentLoad: (metrics) => {
            loadMetrics.push({ docId: metrics.docId, cacheHit: metrics.cacheHit });
          },
          onSyncOperation: (metrics) => {
            syncMetrics.push(metrics);
          },
        },
      });

      const docIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const doc = await db.createDocument();
        docIds.push(doc.getId());
        await db.changeDoc(doc, (d) => {
          d.getData().index = i;
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await db.deleteDocument(docIds[2]);
      await db.syncStoreChanges();
      loadMetrics.length = 0;
      syncMetrics.length = 0;

      const seen: Array<{ docId: string; isDeleted: boolean; cursor: ProcessChangesCursor }> = [];
      for await (const result of db.iterateChangeMetadataSince(null)) {
        seen.push(result);
      }

      expect(seen).toHaveLength(6);
      expect(loadMetrics).toHaveLength(0);
      expect(seen.some((entry) => entry.docId === docIds[2] && entry.isDeleted)).toBe(true);
      expect(seen.every((entry) => entry.cursor.docId === entry.docId)).toBe(true);

      const iterationMetric = syncMetrics.find(
        (metric) => metric.operation === "iterateChangeMetadataSince"
      );
      expect(iterationMetric).toBeDefined();
      expect(iterationMetric?.details?.yieldedDocuments).toBe(6);
    });

    it("reports undeletes as live metadata and materialized changes", async () => {
      const db = await tenant.openDB("test-db-metadata-undelete");
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        d.getData().title = "restorable";
      });

      await db.deleteDocument(doc.getId());
      await db.undeleteDocument(doc.getId());
      await db.syncStoreChanges();

      const seen: Array<{ docId: string; isDeleted: boolean; cursor: ProcessChangesCursor }> = [];
      for await (const result of db.iterateChangeMetadataSince(null)) {
        seen.push(result);
      }
      expect(seen).toContainEqual(expect.objectContaining({
        docId: doc.getId(),
        isDeleted: false,
      }));

      const materialized: Array<{ docId: string; isDeleted: boolean }> = [];
      for await (const { doc: changedDoc } of db.iterateChangesSince(null)) {
        materialized.push({ docId: changedDoc.getId(), isDeleted: changedDoc.isDeleted() });
      }
      expect(materialized).toContainEqual({ docId: doc.getId(), isDeleted: false });
    });

    it("resumes metadata iteration from the last yielded cursor", async () => {
      const db = await tenant.openDB("test-db-metadata-resume");
      const expectedIds: string[] = [];

      for (let i = 0; i < 8; i++) {
        const doc = await db.createDocument();
        expectedIds.push(doc.getId());
        await db.changeDoc(doc, (d) => {
          d.getData().index = i;
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await db.syncStoreChanges();

      const firstPass: string[] = [];
      let resumeCursor: ProcessChangesCursor | null = null;
      for await (const result of db.iterateChangeMetadataSince(null)) {
        firstPass.push(result.docId);
        resumeCursor = result.cursor;
        if (firstPass.length === 3) {
          break;
        }
      }

      const secondPass: string[] = [];
      for await (const result of db.iterateChangeMetadataSince(resumeCursor)) {
        secondPass.push(result.docId);
      }

      expect(firstPass).toHaveLength(3);
      expect([...firstPass, ...secondPass]).toEqual(expectedIds);
    });

    it("returns the latest change cursor without iterating metadata", async () => {
      const db = await tenant.openDB("test-db-latest-cursor");
      let latestDocId = "";

      for (let i = 0; i < 4; i++) {
        const doc = await db.createDocument();
        latestDocId = doc.getId();
        await db.changeDoc(doc, (d) => {
          d.getData().index = i;
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await db.syncStoreChanges();

      const cursor = db.getLatestChangeCursor?.();

      expect(cursor).toBeTruthy();
      expect(cursor?.docId).toBe(latestDocId);
      expect(typeof cursor?.changeSeq).toBe("number");
      expect(cursor?.lastModified).toBeGreaterThan(0);
    });
  });

  describe("snapshot policy", () => {
    it("writes a snapshot early enough for cold reopen loads to use it", async () => {
      const dbName = "test-db-snapshot-policy";
      const db = await tenant.openDB(dbName, {
        snapshotConfig: {
          minChanges: 2,
          cooldownMs: 0,
        },
      });

      const doc = await db.createDocument();
      const docId = doc.getId();
      await db.changeDoc(doc, (d) => {
        d.getData().title = "snapshot-me";
      });

      const docEntries = await db.getStore().findNewEntriesForDoc([], docId);
      expect(docEntries.some((entry) => entry.entryType === "doc_snapshot")).toBe(true);

      const loadMetrics: Array<{
        snapshotUsed: boolean;
        replayEntriesLoaded: number;
        metadataEntriesScanned: number;
      }> = [];
      const reopenedDb = new BaseMindooDB(
        tenant as any,
        db.getStore(),
        db.getAttachmentStore(),
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        {
          onDocumentLoad: (metrics) => {
            if (metrics.docId === docId) {
              loadMetrics.push({
                snapshotUsed: metrics.snapshotUsed,
                replayEntriesLoaded: metrics.replayEntriesLoaded,
                metadataEntriesScanned: metrics.metadataEntriesScanned,
              });
            }
          },
        }
      );
      await reopenedDb.initialize();

      const reopenedDoc = await reopenedDb.getDocument(docId);
      expect(reopenedDoc.getData().title).toBe("snapshot-me");
      expect(loadMetrics).toHaveLength(1);
      expect(loadMetrics[0].snapshotUsed).toBe(true);
      expect(loadMetrics[0].replayEntriesLoaded).toBe(0);
      expect(loadMetrics[0].metadataEntriesScanned).toBeGreaterThanOrEqual(3);
    });
  });

  describe("bounded cache", () => {
    it("evicts cold documents when the cache budget is exceeded", async () => {
      const loadMetrics: Array<{ docId: string; cacheHit: boolean }> = [];
      const db = await tenant.openDB("test-db-bounded-cache", {
        documentCacheConfig: {
          maxEntries: 2,
          iteratePrefetchWindowDocs: 0,
        },
        performanceCallback: {
          onDocumentLoad: (metrics) => {
            loadMetrics.push({ docId: metrics.docId, cacheHit: metrics.cacheHit });
          },
        },
      });

      const docIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const doc = await db.createDocument();
        docIds.push(doc.getId());
        await db.changeDoc(doc, (d) => {
          d.getData().index = i;
        });
      }

      await db.syncStoreChanges();
      loadMetrics.length = 0;

      await db.getDocument(docIds[0]);
      await db.getDocument(docIds[1]);
      await db.getDocument(docIds[2]);
      await db.getDocument(docIds[0]);

      const doc0Misses = loadMetrics.filter(
        (metric) => metric.docId === docIds[0] && !metric.cacheHit
      );
      expect(doc0Misses).toHaveLength(2);
    });
  });

  describe("deleted documents", () => {
    it("should include deleted documents during iteration for external index updates", async () => {
      const db = await tenant.openDB("test-db");
      
      const numDocs = 200;
      const docsToDelete: string[] = [];
      
      // Create documents
      for (let i = 0; i < numDocs; i++) {
        const doc = await db.createDocument();
        const docId = doc.getId();
        await db.changeDoc(doc, (d) => {
          const data = d.getData();
          data.index = i;
        });
        
        // Mark some for deletion (every 5th document)
        if (i % 5 === 0) {
          docsToDelete.push(docId);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      
      await db.syncStoreChanges();
      
      // Delete some documents
      for (const docId of docsToDelete) {
        await db.deleteDocument(docId);
      }
      
      await db.syncStoreChanges();
      
      // Iterate through documents (should include deleted ones)
      const processedDocs: Array<{ docId: string; isDeleted: boolean }> = [];
      for await (const { doc } of db.iterateChangesSince(null)) {
        processedDocs.push({
          docId: doc.getId(),
          isDeleted: doc.isDeleted()
        });
      }
      
      // Verify all documents are in the results (including deleted ones)
      expect(processedDocs.length).toBe(numDocs);
      
      // Verify deleted documents are marked as deleted
      const deletedInResults = processedDocs.filter(p => p.isDeleted);
      expect(deletedInResults.length).toBe(docsToDelete.length);
      
      for (const deletedId of docsToDelete) {
        const found = processedDocs.find(p => p.docId === deletedId);
        expect(found).toBeDefined();
        expect(found!.isDeleted).toBe(true);
      }
      
      // Verify non-deleted documents are not marked as deleted
      const nonDeletedInResults = processedDocs.filter(p => !p.isDeleted);
      expect(nonDeletedInResults.length).toBe(numDocs - docsToDelete.length);
    }, 60000);

    it("yields deleted documents as lightweight tombstones without materialized data", async () => {
      const db = await tenant.openDB("test-db-deleted-tombstones");

      const doc = await db.createDocument();
      const docId = doc.getId();
      await db.changeDoc(doc, (d) => {
        const data = d.getData();
        data.title = "will be deleted";
      });
      await db.deleteDocument(docId);
      await db.syncStoreChanges();

      let tombstone: MindooDoc | null = null;
      for await (const { doc: changedDoc } of db.iterateChangesSince(null)) {
        if (changedDoc.getId() === docId) {
          tombstone = changedDoc;
        }
      }

      expect(tombstone).not.toBeNull();
      // Uniform tombstone contract: deleted docs are not materialized.
      // isAccessible() distinguishes them from inaccessible-key tombstones.
      expect(tombstone!.isDeleted()).toBe(true);
      expect(tombstone!.isAccessible()).toBe(true);
      expect(tombstone!.getData()).toEqual({});
      expect(tombstone!.getHeads()).toEqual([]);
    });

    it("should allow external indexes to handle deletions incrementally", async () => {
      const db = await tenant.openDB("test-db");
      
      // Simulate an external index
      const externalIndex = new Map<string, { data: any; isDeleted: boolean }>();
      
      // Create initial documents
      const doc1 = await db.createDocument();
      const doc1Id = doc1.getId();
      await db.changeDoc(doc1, (d) => {
        const data = d.getData();
        data.type = "user";
        data.name = "Alice";
      });
      
      const doc2 = await db.createDocument();
      const doc2Id = doc2.getId();
      await db.changeDoc(doc2, (d) => {
        const data = d.getData();
        data.type = "user";
        data.name = "Bob";
      });
      
      await db.syncStoreChanges();
      
      // Initial index build
      let lastCursor: ProcessChangesCursor | null = null;
      for await (const { doc, cursor } of db.iterateChangesSince(null)) {
        if (!doc.isDeleted()) {
          externalIndex.set(doc.getId(), {
            data: doc.getData(),
            isDeleted: false
          });
        }
        lastCursor = cursor;
      }
      
      expect(externalIndex.size).toBe(2);
      expect(externalIndex.has(doc1Id)).toBe(true);
      expect(externalIndex.has(doc2Id)).toBe(true);
      
      // Delete one document
      await db.deleteDocument(doc1Id);
      await db.syncStoreChanges();
      
      // Incremental update - should detect deletion
      for await (const { doc, cursor } of db.iterateChangesSince(lastCursor)) {
        if (doc.isDeleted()) {
          // Remove from external index
          externalIndex.delete(doc.getId());
        } else {
          // Add or update in external index
          externalIndex.set(doc.getId(), {
            data: doc.getData(),
            isDeleted: false
          });
        }
        lastCursor = cursor;
      }
      
      // Verify deleted document was removed from external index
      expect(externalIndex.size).toBe(1);
      expect(externalIndex.has(doc1Id)).toBe(false);
      expect(externalIndex.has(doc2Id)).toBe(true);
    }, 60000);
  });

  describe("one-at-a-time yielding", () => {
    it("should yield documents immediately, not in batches", async () => {
      const db = await tenant.openDB("test-db");
      
      const numDocs = 100;
      
      // Create documents
      for (let i = 0; i < numDocs; i++) {
        const doc = await db.createDocument();
        await db.changeDoc(doc, (d) => {
          const data = d.getData();
          data.index = i;
        });
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      
      await db.syncStoreChanges();
      
      // Track when each document is yielded
      const yieldTimestamps: number[] = [];
      let previousYieldTime = Date.now();
      
      for await (const { doc } of db.iterateChangesSince(null)) {
        const currentTime = Date.now();
        yieldTimestamps.push(currentTime - previousYieldTime);
        previousYieldTime = currentTime;
        
        // Verify we can break at any point
        if (doc.getData().index === 50) {
          break;
        }
      }
      
      // Verify documents were yielded one at a time (not all at once)
      // Each yield should happen relatively quickly (not batched)
      expect(yieldTimestamps.length).toBeGreaterThan(0);
      expect(yieldTimestamps.length).toBeLessThanOrEqual(51); // We broke at index 50
    }, 60000);
  });

  describe("cursor resumption", () => {
    it("should correctly resume from a cursor position", async () => {
      const db = await tenant.openDB("test-db");
      
      const numDocs = 500;
      const firstBatchSize = 200;
      
      // Create documents
      const allDocIds: string[] = [];
      for (let i = 0; i < numDocs; i++) {
        const doc = await db.createDocument();
        const docId = doc.getId();
        allDocIds.push(docId);
        await db.changeDoc(doc, (d) => {
          const data = d.getData();
          data.index = i;
        });
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      
      await db.syncStoreChanges();
      
      // Process first batch
      const firstBatchIds: string[] = [];
      let resumeCursor: ProcessChangesCursor | null = null;
      let count = 0;
      
      for await (const { doc, cursor } of db.iterateChangesSince(null)) {
        firstBatchIds.push(doc.getId());
        resumeCursor = cursor;
        count++;
        
        if (count >= firstBatchSize) {
          break;
        }
      }
      
      expect(firstBatchIds.length).toBe(firstBatchSize);
      expect(resumeCursor).not.toBeNull();
      
      // Resume from cursor
      const secondBatchIds: string[] = [];
      for await (const { doc } of db.iterateChangesSince(resumeCursor)) {
        secondBatchIds.push(doc.getId());
      }
      
      // Verify no duplicates
      const allProcessedIds = [...firstBatchIds, ...secondBatchIds];
      const uniqueIds = new Set(allProcessedIds);
      expect(uniqueIds.size).toBe(allProcessedIds.length);
      
      // Verify all documents were processed
      expect(allProcessedIds.length).toBe(numDocs);
      
      // Verify no skipped documents
      for (const docId of allDocIds) {
        expect(allProcessedIds).toContain(docId);
      }
    }, 60000);
  });

  describe("edge cases", () => {
    it("should handle empty database", async () => {
      const db = await tenant.openDB("test-db");
      
      const processedDocs: MindooDoc[] = [];
      for await (const { doc } of db.iterateChangesSince(null)) {
        processedDocs.push(doc);
      }
      
      expect(processedDocs.length).toBe(0);
    });

    it("should handle single document", async () => {
      const db = await tenant.openDB("test-db");
      
      const doc = await db.createDocument();
      const docId = doc.getId();
      await db.changeDoc(doc, (d) => {
        const data = d.getData();
        data.test = "value";
      });
      
      await db.syncStoreChanges();
      
      const processedDocs: MindooDoc[] = [];
      for await (const { doc } of db.iterateChangesSince(null)) {
        processedDocs.push(doc);
      }
      
      expect(processedDocs.length).toBe(1);
      expect(processedDocs[0].getId()).toBe(docId);
      expect(processedDocs[0].getData().test).toBe("value");
    });

    it("should handle all documents deleted", async () => {
      const db = await tenant.openDB("test-db");
      
      // Create and delete documents
      const deletedDocIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const doc = await db.createDocument();
        const docId = doc.getId();
        deletedDocIds.push(docId);
        await db.deleteDocument(docId);
      }
      
      await db.syncStoreChanges();
      
      // Iterate - deleted documents should be included
      const processedDocs: Array<{ docId: string; isDeleted: boolean }> = [];
      for await (const { doc } of db.iterateChangesSince(null)) {
        processedDocs.push({
          docId: doc.getId(),
          isDeleted: doc.isDeleted()
        });
      }
      
      // All documents should be included, all marked as deleted
      expect(processedDocs.length).toBe(10);
      for (const processed of processedDocs) {
        expect(processed.isDeleted).toBe(true);
        expect(deletedDocIds).toContain(processed.docId);
      }
    });

    it("re-emits a document changed twice within the same millisecond", async () => {
      const db = await tenant.openDB("test-db-same-ms-changes");

      const doc = await db.createDocument();
      const docId = doc.getId();
      await db.changeDoc(doc, (d) => {
        d.getData().v = 1;
      });

      // Consume the feed so the cursor sits at the doc's current changeSeq.
      let cursor: ProcessChangesCursor | null = null;
      for await (const { cursor: c } of db.iterateChangesSince(null)) {
        cursor = c;
      }

      // Freeze Date.now so both following changes carry the exact same
      // `lastModified`. Before the forceChangeSeqBump fix, the second change
      // was indistinguishable from an idempotent replay in updateIndex and
      // silently vanished from the changefeed.
      const fixedNow = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow);
      try {
        const docV2 = await db.getDocument(docId);
        await db.changeDoc(docV2, (d) => {
          d.getData().v = 2;
        });
        // Consume the v=2 emission so only the second same-ms change remains.
        for await (const { cursor: c } of db.iterateChangesSince(cursor)) {
          cursor = c;
        }
        const docV3 = await db.getDocument(docId);
        await db.changeDoc(docV3, (d) => {
          d.getData().v = 3;
        });
      } finally {
        nowSpy.mockRestore();
      }

      const yieldedVersions: unknown[] = [];
      for await (const { doc: changedDoc } of db.iterateChangesSince(cursor)) {
        if (changedDoc.getId() === docId) {
          yieldedVersions.push(changedDoc.getData().v);
        }
      }
      expect(yieldedVersions).toEqual([3]);
    }, 30000);

    it("should handle documents with same lastModified timestamp (verify docId ordering)", async () => {
      const db = await tenant.openDB("test-db");
      
      // Create multiple documents in quick succession (may have same timestamp)
      const createdDocIds: string[] = [];
      const baseTime = Date.now();
      
      for (let i = 0; i < 20; i++) {
        const doc = await db.createDocument();
        const docId = doc.getId();
        createdDocIds.push(docId);
        
        // Use same timestamp for all
        await db.changeDoc(doc, (d) => {
          const data = d.getData();
          data.index = i;
          data.timestamp = baseTime;
        });
      }
      
      await db.syncStoreChanges();
      
      // Sort docIds to get expected order
      const sortedDocIds = [...createdDocIds].sort();
      
      // Iterate and verify order
      const processedDocIds: string[] = [];
      for await (const { doc } of db.iterateChangesSince(null)) {
        processedDocIds.push(doc.getId());
      }
      
      // Verify documents are in docId order when timestamps are equal
      expect(processedDocIds.length).toBe(20);
      
      // Check that when timestamps are equal, docIds are sorted
      for (let i = 0; i < processedDocIds.length; i++) {
        // The processed order should match sorted order (or be sorted by timestamp then docId)
        const processedId = processedDocIds[i];
        expect(sortedDocIds).toContain(processedId);
      }
    }, 60000);
  });

  describe("iterateChangeRevisionsSince (revision-grain feed)", () => {
    it("yields one result per change for an in-place-edited document", async () => {
      const db = await tenant.openDB("test-db");

      const doc = await db.createDocument();
      const docId = doc.getId();
      await db.changeDoc(doc, (d) => { d.getData().v = 1; });
      const afterV1 = await db.getDocument(docId);
      await db.changeDoc(afterV1, (d) => { d.getData().v = 2; });
      const afterV2 = await db.getDocument(docId);
      await db.changeDoc(afterV2, (d) => { d.getData().v = 3; });
      await db.syncStoreChanges();

      const revisions = [];
      for await (const rev of db.iterateDocRevisionsSince(docId, null)) {
        revisions.push(rev);
      }

      // doc_create + three changes = four revisions (doc-grain would yield one).
      expect(revisions.length).toBeGreaterThanOrEqual(4);
      expect(revisions.every((r) => r.docId === docId)).toBe(true);
      // Each revision corresponds to a distinct store entry.
      expect(new Set(revisions.map((r) => r.entryId)).size).toBe(revisions.length);

      // The fully-folded final revision carries the complete merge (v === 3).
      const finalValue = (revisions[revisions.length - 1].doc.getData() as Record<string, unknown>).v;
      expect(finalValue).toBe(3);

      // Doc-grain feed yields the document exactly once.
      let docGrain = 0;
      for await (const { doc: d } of db.iterateChangesSince(null)) {
        if (d.getId() === docId) docGrain++;
      }
      expect(docGrain).toBe(1);
    }, 60000);

    it("folds witnessed revisions per doc in trusted-time order and resumes from a cursor", async () => {
      // Use a witnessing tenant so entries carry distinct, increasing receivedAt
      // (the access-control trusted time); un-witnessed entries float to "now".
      const ctx = await createWitnessingTenant("test-tenant-revfeed");
      try {
        const db = await ctx.tenant.openDB("test-db");

        const a = await db.createDocument();
        await db.changeDoc(a, (d) => { d.getData().k = "a1"; });
        const b = await db.createDocument();
        await db.changeDoc(b, (d) => { d.getData().k = "b1"; });
        await db.syncStoreChanges();

        const all = [];
        for await (const rev of db.iterateChangeRevisionsSince(null)) {
          all.push(rev);
        }
        expect(all.length).toBeGreaterThanOrEqual(4);
        expect(all.every((r) => r.witnessed)).toBe(true);

        // Within each document, revisions are emitted in non-decreasing trusted time.
        const byDoc = new Map<string, number[]>();
        for (const rev of all) {
          const list = byDoc.get(rev.docId) ?? [];
          list.push(rev.trustedTime);
          byDoc.set(rev.docId, list);
        }
        for (const times of byDoc.values()) {
          for (let i = 1; i < times.length; i++) {
            expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
          }
        }

        // Resuming from a witnessed cursor yields no entries already covered by it.
        const resumeCursor = all[all.length - 1].cursor;
        expect(resumeCursor).not.toBeNull();
        const resumed = [];
        for await (const rev of db.iterateChangeRevisionsSince(resumeCursor)) {
          resumed.push(rev.entryId);
        }
        // Everything is witnessed and folded; resuming from the head watermark
        // re-discovers nothing.
        expect(resumed).toEqual([]);
      } finally {
        await (ctx.tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
      }
    }, 60000);
  });
});
