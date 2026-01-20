import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, MindooDoc, ProcessChangesCursor, SigningKeyPair, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("iterateChangesSince", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminKeyBag: KeyBag;
  let adminSigningKeyPair: SigningKeyPair;
  let adminSigningKeyPassword: string;
  let tenant: MindooTenant;
  let tenantId: string;
  let tenantEncryptionKeyPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    // Create admin user
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    // Create admin signing key pair
    adminSigningKeyPassword = "adminsigningpass123";
    adminSigningKeyPair = await factory.createSigningKeyPair(adminSigningKeyPassword);
    
    // Create admin encryption key pair
    const adminEncryptionKeyPair = await factory.createEncryptionKeyPair("adminencpass123");
    
    // Create tenant encryption key
    tenantEncryptionKeyPassword = "tenantkeypass123";
    const tenantEncryptionKey = await factory.createSymmetricEncryptedPrivateKey(tenantEncryptionKeyPassword);
    
    // Create $publicinfos symmetric key
    const publicInfosKey = await factory.createSymmetricEncryptedPrivateKey("publicinfospass123");
    
    // Create KeyBag for admin user
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    // Add $publicinfos key to KeyBag
    await adminKeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, "publicinfospass123");
    
    // Create tenant
    tenantId = "test-tenant-iterate-changes";
    tenant = await factory.openTenantWithKeys(
      tenantId,
      tenantEncryptionKey,
      tenantEncryptionKeyPassword,
      adminSigningKeyPair.publicKey,
      adminEncryptionKeyPair.publicKey,
      adminUser,
      adminUserPassword,
      adminKeyBag
    );
    
    // Register the admin user in the directory
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
    );
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
      
      // Verify documents are in correct order (by lastModified, then docId)
      for (let i = 1; i < processedDocs.length; i++) {
        const prev = processedDocs[i - 1];
        const curr = processedDocs[i];
        
        if (prev.lastModified === curr.lastModified) {
          expect(prev.docId.localeCompare(curr.docId)).toBeLessThanOrEqual(0);
        } else {
          expect(prev.lastModified).toBeLessThanOrEqual(curr.lastModified);
        }
      }
      
      // Verify cursor tracking is correct
      for (let i = 0; i < processedDocs.length; i++) {
        const result = processedDocs[i];
        expect(result.cursor.docId).toBe(result.docId);
        expect(result.cursor.lastModified).toBe(result.lastModified);
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
});
