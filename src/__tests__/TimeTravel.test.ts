import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { MindooDB, MindooDoc, PUBLIC_INFOS_KEY_ID } from "../core/types";
import type { StoreEntryMetadata } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("TimeTravel", () => {
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let factory: BaseMindooTenantFactory;
  let tenant: any;
  let db: MindooDB;
  let user: any;
  let userPassword: string;
  let adminUser: any;
  let adminUserPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    const cryptoAdapter = new NodeCryptoAdapter();
    factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
    
    userPassword = "userpass123";
    user = await factory.createUserId("CN=user/O=testtenant", userPassword);
    const userKeyBag = new KeyBag(
      user.userEncryptionKeyPair.privateKey,
      userPassword,
      cryptoAdapter
    );
    
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    const tenantId = "test-tenant";
    await userKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await userKeyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      userKeyBag
    );
    
    // Register the user in the directory so their public key is trusted
    const directory = await tenant.openDirectory();
    const publicUser = factory.toPublicUserId(user);
    await directory.registerUser(
      publicUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
    
    db = await tenant.openDB("test-db");
  }, 30000);

  describe("getDocumentAtTimestamp", () => {
    it("should retrieve document at different timestamps", async () => {
      // Create document
      const doc = await db.createDocument();
      const docId = doc.getId();
      const timestamps: number[] = [];
      
      // Record initial timestamp
      timestamps.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Modify document multiple times
      for (let i = 1; i <= 5; i++) {
        await db.changeDoc(doc, (d) => {
          d.getData().version = i;
          d.getData().modifiedAt = Date.now();
        });
        timestamps.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Verify current state
      const currentDoc = await db.getDocument(docId);
      expect(currentDoc.getData().version).toBe(5);
      
      // Test time travel to each version
      for (let i = 0; i < timestamps.length; i++) {
        const historicalDoc = await db.getDocumentAtTimestamp(docId, timestamps[i]);
        expect(historicalDoc).not.toBeNull();
        if (i === 0) {
          // First version might not have version field yet
          expect(historicalDoc!.getData().version).toBeUndefined();
        } else {
          expect(historicalDoc!.getData().version).toBe(i);
        }
      }
      
      // Test timestamp before document creation
      const beforeCreation = await db.getDocumentAtTimestamp(docId, timestamps[0] - 1000);
      expect(beforeCreation).toBeNull();
    });

    it("should handle deleted documents correctly", async () => {
      const doc = await db.createDocument();
      const docId = doc.getId();
      const createTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await db.changeDoc(doc, (d) => {
        d.getData().status = "active";
      });
      const modifyTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await db.deleteDocument(docId);
      const deleteTime = Date.now();

      expect(await db.getAllDocumentIds()).not.toContain(docId);
      expect(await db.getDeletedDocumentIds()).toContain(docId);
      
      // Document should exist before deletion
      const beforeDelete = await db.getDocumentAtTimestamp(docId, modifyTime);
      expect(beforeDelete).not.toBeNull();
      expect(beforeDelete!.getData().status).toBe("active");
      expect(beforeDelete!.isDeleted()).toBe(false);
      
      // Document should be marked as deleted at deletion time (not null)
      const atDelete = await db.getDocumentAtTimestamp(docId, deleteTime);
      expect(atDelete).not.toBeNull();
      expect(atDelete!.isDeleted()).toBe(true);
    });

    it("should ignore attachment entries when reconstructing a historical document", async () => {
      const doc = await db.createDocument();
      const docId = doc.getId();

      await db.changeDoc(doc, (d) => {
        d.getData().version = 1;
      });
      const versionOneTime = Date.now();

      await new Promise((resolve) => setTimeout(resolve, 10));

      await db.changeDoc(doc, async (d) => {
        await d.addAttachment(
          new Uint8Array([1, 2, 3, 4]),
          "history.bin",
          "application/octet-stream",
        );
      });

      const historicalDoc = await db.getDocumentAtTimestamp(docId, versionOneTime);
      expect(historicalDoc).not.toBeNull();
      expect(historicalDoc!.getData().version).toBe(1);
    });

    it("should reconstruct history correctly when snapshots exist", async () => {
      const snapshotDb = await tenant.openDB("time-travel-snapshots", {
        snapshotConfig: {
          minChanges: 1,
          cooldownMs: 0,
        },
      });

      const doc = await snapshotDb.createDocument();
      const docId = doc.getId();
      const timestamps: number[] = [];

      for (let i = 1; i <= 3; i++) {
        await snapshotDb.changeDoc(doc, (d: MindooDoc) => {
          d.getData().version = i;
        });
        timestamps.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const snapshots = (await snapshotDb.getStore().findEntries("doc_snapshot", null, null))
        .filter((entry: StoreEntryMetadata) => entry.docId === docId);
      expect(snapshots.length).toBeGreaterThan(0);

      for (let i = 0; i < timestamps.length; i++) {
        const historicalDoc = await snapshotDb.getDocumentAtTimestamp(docId, timestamps[i]);
        expect(historicalDoc).not.toBeNull();
        expect(historicalDoc!.getData().version).toBe(i + 1);
      }
    });
  });

  describe("iterateDocumentHistory", () => {
    it("should traverse document history from origin to latest", async () => {
      const doc = await db.createDocument();
      const docId = doc.getId();
      
      // Make multiple modifications
      const expectedVersions: Array<{ version: number; author: string }> = [];
      
      for (let i = 1; i <= 5; i++) {
        await db.changeDoc(doc, (d) => {
          d.getData().version = i;
          d.getData().data = `change-${i}`;
        });
        expectedVersions.push({ version: i, author: user.userSigningKeyPair.publicKey });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Traverse history
      const history: Array<{ doc: MindooDoc; changeCreatedAt: number; changeCreatedByPublicKey: string }> = [];
      for await (const result of db.iterateDocumentHistory(docId)) {
        history.push(result);
      }
      
      // Verify we got all versions
      expect(history.length).toBeGreaterThanOrEqual(5);
      
      // Verify versions are in order
      for (let i = 0; i < expectedVersions.length; i++) {
        const hist = history[i + 1]; // +1 because first entry is doc_create
        expect(hist.doc.getData().version).toBe(expectedVersions[i].version);
        expect(hist.changeCreatedByPublicKey).toBe(expectedVersions[i].author);
      }
      
      // Verify documents are independent (different objects, can be stored separately)
      // Check that they are different object references
      expect(history[1].doc).not.toBe(history[2].doc);
      // Check that they have different data
      expect(history[1].doc.getData().version).not.toBe(history[2].doc.getData().version);
    });

    it("should yield independent document clones", async () => {
      const doc = await db.createDocument();
      const docId = doc.getId();
      
      await db.changeDoc(doc, (d) => {
        d.getData().value = 1;
      });
      
      await db.changeDoc(doc, (d) => {
        d.getData().value = 2;
      });
      
      // Collect all history versions
      const versions: MindooDoc[] = [];
      for await (const { doc: histDoc } of db.iterateDocumentHistory(docId)) {
        versions.push(histDoc);
      }
      
      // Verify we can store them in array
      expect(versions.length).toBeGreaterThanOrEqual(2);
      
      // Verify independence - they are different objects
      expect(versions[0]).not.toBe(versions[1]);
      // Verify they have different data values
      const values = versions
        .map((version) => version.getData().value)
        .filter((value): value is number => typeof value === "number");
      const firstValue = values[values.length - 2];
      const secondValue = values[values.length - 1];
      expect(firstValue).toBe(1);
      expect(secondValue).toBe(2);
      expect(firstValue).not.toBe(secondValue);
    });

    it("should include change metadata (timestamp and author)", async () => {
      const beforeCreateTime = Date.now();
      const doc = await db.createDocument();
      const docId = doc.getId();
      const afterCreateTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const beforeModifyTime = Date.now();
      await db.changeDoc(doc, (d) => {
        d.getData().modified = true;
      });
      const afterModifyTime = Date.now();
      
      const history: Array<{ changeCreatedAt: number; changeCreatedByPublicKey: string }> = [];
      for await (const result of db.iterateDocumentHistory(docId)) {
        history.push({
          changeCreatedAt: result.changeCreatedAt,
          changeCreatedByPublicKey: result.changeCreatedByPublicKey,
        });
      }
      
      expect(history.length).toBeGreaterThanOrEqual(2);
      // First entry should be between beforeCreateTime and afterCreateTime
      expect(history[0].changeCreatedAt).toBeGreaterThanOrEqual(beforeCreateTime);
      expect(history[0].changeCreatedAt).toBeLessThanOrEqual(afterCreateTime);
      // Last entry should be between beforeModifyTime and afterModifyTime
      expect(history[history.length - 1].changeCreatedAt).toBeGreaterThanOrEqual(beforeModifyTime);
      expect(history[history.length - 1].changeCreatedAt).toBeLessThanOrEqual(afterModifyTime);
      expect(history[0].changeCreatedByPublicKey).toBe(user.userSigningKeyPair.publicKey);
    });

    it("should include delete entries in history", async () => {
      const doc = await db.createDocument();
      const docId = doc.getId();
      
      await db.changeDoc(doc, (d) => {
        d.getData().status = "active";
      });
      
      await db.deleteDocument(docId);
      
      // History should include deletion
      const history: MindooDoc[] = [];
      const yieldedEntryIds: string[] = [];
      for await (const { doc: histDoc, changeEntryId } of db.iterateDocumentHistory(docId)) {
        history.push(histDoc);
        yieldedEntryIds.push(changeEntryId);
      }
      
      if (history.length < 3) {
        // Diagnostic for a rare full-suite-only flake: embed the store state
        // and a retry pass in the thrown error so the jest failure summary
        // shows exactly which entry was skipped and whether it is transient.
        const storeMeta = await db.getStore().findNewEntriesForDoc([], docId);
        const retryEntryIds: string[] = [];
        for await (const { changeEntryId } of db.iterateDocumentHistory(docId)) {
          retryEntryIds.push(changeEntryId);
        }
        const diag = {
          docId,
          storeEntries: storeMeta.map((m) => ({
            t: m.entryType,
            id: m.id,
            createdAt: m.createdAt,
            receiptOrder: m.receiptOrder,
          })),
          firstPassYields: yieldedEntryIds,
          retryPassYields: retryEntryIds,
        };
        throw new Error(
          `[HISTORY-DELETE-REPRO] expected >=3 history states, got ${history.length}:\n${JSON.stringify(diag, null, 2)}`,
        );
      }
      
      // History should include create, active state before deletion, and deleted state.
      expect(history.length).toBeGreaterThanOrEqual(3);
      // Last entry should be the deleted state
      expect(history[history.length - 1].isDeleted()).toBe(true);
      // Second to last should be the active state before deletion
      expect(history[history.length - 2].getData().status).toBe("active");
      expect(history[history.length - 2].isDeleted()).toBe(false);
    });

    it("should page history metadata without materializing every version", async () => {
      const doc = await db.createDocument();
      const docId = doc.getId();

      for (let i = 1; i <= 5; i++) {
        await db.changeDoc(doc, (d) => {
          d.getData().version = i;
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const page1 = await db.getDocumentHistoryPage(docId, { limit: 3 });
      expect(page1.entries).toHaveLength(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.entries[0].entryType).toBe("doc_create");
      expect(page1.entries[1].entryType).toBe("doc_change");

      const page2 = await db.getDocumentHistoryPage(docId, {
        cursor: page1.nextCursor,
        limit: 3,
      });
      expect(page2.entries.length).toBeGreaterThanOrEqual(3);
      expect(page2.entries[0].changeCreatedAt).toBeGreaterThanOrEqual(
        page1.entries[2].changeCreatedAt
      );
    });
  });

  describe("getAllDocumentIdsAtTimestamp", () => {
    test("should return documents that existed at timestamp", async () => {
      // Create multiple documents at different times
      const doc1 = await db.createDocument();
      const doc1Id = doc1.getId();
      const time1 = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const doc2 = await db.createDocument();
      const doc2Id = doc2.getId();
      const time2 = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const doc3 = await db.createDocument();
      const doc3Id = doc3.getId();
      const time3 = Date.now();
      
      // At time1, only doc1 should exist
      const idsAtTime1 = await db.getAllDocumentIdsAtTimestamp(time1);
      expect(idsAtTime1).toContain(doc1Id);
      expect(idsAtTime1).not.toContain(doc2Id);
      expect(idsAtTime1).not.toContain(doc3Id);
      
      // At time2, doc1 and doc2 should exist
      const idsAtTime2 = await db.getAllDocumentIdsAtTimestamp(time2);
      expect(idsAtTime2).toContain(doc1Id);
      expect(idsAtTime2).toContain(doc2Id);
      expect(idsAtTime2).not.toContain(doc3Id);
      
      // At time3, all three should exist
      const idsAtTime3 = await db.getAllDocumentIdsAtTimestamp(time3);
      expect(idsAtTime3).toContain(doc1Id);
      expect(idsAtTime3).toContain(doc2Id);
      expect(idsAtTime3).toContain(doc3Id);
    });
    
    test("should exclude deleted documents after deletion timestamp", async () => {
      const doc1 = await db.createDocument();
      const doc1Id = doc1.getId();
      const createTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await db.deleteDocument(doc1Id);
      const deleteTime = Date.now();
      
      // Before deletion, document should exist
      const idsBeforeDelete = await db.getAllDocumentIdsAtTimestamp(createTime + 5);
      expect(idsBeforeDelete).toContain(doc1Id);
      
      // At deletion time, document should not exist
      const idsAtDelete = await db.getAllDocumentIdsAtTimestamp(deleteTime);
      expect(idsAtDelete).not.toContain(doc1Id);
      
      // After deletion, document should not exist
      const idsAfterDelete = await db.getAllDocumentIdsAtTimestamp(deleteTime + 1000);
      expect(idsAfterDelete).not.toContain(doc1Id);
    });

    test("should include documents again after undelete timestamp", async () => {
      const doc1 = await db.createDocument();
      const doc1Id = doc1.getId();
      const createTime = Date.now();

      await new Promise(resolve => setTimeout(resolve, 10));
      await db.deleteDocument(doc1Id);
      const deleteTime = Date.now();

      await new Promise(resolve => setTimeout(resolve, 10));
      await db.undeleteDocument(doc1Id);
      const undeleteTime = Date.now();

      expect(await db.getAllDocumentIdsAtTimestamp(createTime)).toContain(doc1Id);
      expect(await db.getAllDocumentIdsAtTimestamp(deleteTime)).not.toContain(doc1Id);
      expect(await db.getAllDocumentIdsAtTimestamp(undeleteTime)).toContain(doc1Id);
    });
    
    test("should return empty array for timestamp before any documents", async () => {
      const doc1 = await db.createDocument();
      const createTime = Date.now();
      
      const idsBeforeCreation = await db.getAllDocumentIdsAtTimestamp(createTime - 1000);
      expect(idsBeforeCreation).toEqual([]);
    });
    
    test("should handle documents with multiple creates and deletes", async () => {
      // This test would require creating a document, deleting it, then recreating it
      // which may not be directly supported, but tests the logic for multiple entries
      const doc1 = await db.createDocument();
      const doc1Id = doc1.getId();
      const createTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await db.deleteDocument(doc1Id);
      const deleteTime = Date.now();
      
      // At a time between create and delete, document should exist
      const idsBetween = await db.getAllDocumentIdsAtTimestamp(createTime + 5);
      expect(idsBetween).toContain(doc1Id);
      
      // After delete, document should not exist
      const idsAfter = await db.getAllDocumentIdsAtTimestamp(deleteTime + 5);
      expect(idsAfter).not.toContain(doc1Id);
    });
  });

  describe("causal determinism at tied timestamps", () => {
    // All lifecycle entries in these tests intentionally share a single
    // semantic instant (or carry deliberately skewed timestamps). The state at
    // a timestamp must then be derived from the dependency DAG — never from an
    // id tie-break — so every replica and both timestamp APIs agree.

    test("same-instant delete→undelete resolves causally: undelete wins", async () => {
      const base = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(base);
      try {
        // Several docs so an id-lexicographic "latest terminal" coin flip
        // cannot pass by luck.
        const docIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          const doc = await db.createDocument();
          docIds.push(doc.getId());
          await db.deleteDocument(doc.getId());
          await db.undeleteDocument(doc.getId());
        }
        const ids = await db.getAllDocumentIdsAtTimestamp(base);
        for (const docId of docIds) {
          expect(ids).toContain(docId);
          const at = await db.getDocumentAtTimestamp(docId, base);
          expect(at).not.toBeNull();
          expect(at!.isDeleted()).toBe(false);
        }
      } finally {
        nowSpy.mockRestore();
      }
    });

    test("same-instant change→delete resolves causally: delete wins", async () => {
      const base = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(base);
      try {
        const docIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          const doc = await db.createDocument();
          docIds.push(doc.getId());
          await db.changeDoc(doc, (d) => {
            d.getData().status = "active";
          });
          await db.deleteDocument(doc.getId());
        }
        const ids = await db.getAllDocumentIdsAtTimestamp(base);
        for (const docId of docIds) {
          expect(ids).not.toContain(docId);
          const at = await db.getDocumentAtTimestamp(docId, base);
          expect(at).not.toBeNull();
          expect(at!.isDeleted()).toBe(true);
        }
      } finally {
        nowSpy.mockRestore();
      }
    });

    test("prunes entries whose causal parents lie outside the timestamp slice", async () => {
      const base = Date.now();
      const nowSpy = jest.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(base);
        const doc = await db.createDocument();
        const docId = doc.getId();
        nowSpy.mockReturnValue(base + 2000);
        await db.changeDoc(doc, (d) => {
          d.getData().status = "active";
        });
        // Skewed replica clock: the delete causally follows the change but
        // carries an EARLIER timestamp.
        nowSpy.mockReturnValue(base + 1000);
        await db.deleteDocument(docId);

        // At base+1500 the slice contains create(base) and delete(base+1000)
        // but NOT the delete's parent change(base+2000). The ungrounded delete
        // must not count: the doc is alive in its create-state, and both
        // timestamp APIs agree.
        const at = await db.getDocumentAtTimestamp(docId, base + 1500);
        expect(at).not.toBeNull();
        expect(at!.isDeleted()).toBe(false);
        expect(await db.getAllDocumentIdsAtTimestamp(base + 1500)).toContain(docId);

        // At base+2000 the full causal chain is inside the slice: delete wins.
        const atFull = await db.getDocumentAtTimestamp(docId, base + 2000);
        expect(atFull).not.toBeNull();
        expect(atFull!.isDeleted()).toBe(true);
        expect(await db.getAllDocumentIdsAtTimestamp(base + 2000)).not.toContain(docId);
      } finally {
        nowSpy.mockRestore();
      }
    });

    test("returns null when only ungrounded entries fall inside the slice", async () => {
      const base = Date.now();
      const nowSpy = jest.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(base + 5000);
        const doc = await db.createDocument();
        const docId = doc.getId();
        nowSpy.mockReturnValue(base + 3000);
        await db.changeDoc(doc, (d) => {
          d.getData().status = "active";
        });

        // At base+4000 only the change(base+3000) is inside the slice; its
        // parent create(base+5000) is not. No complete causal chain exists at
        // that instant, so the document did not exist yet.
        expect(await db.getDocumentAtTimestamp(docId, base + 4000)).toBeNull();
        expect(await db.getAllDocumentIdsAtTimestamp(base + 4000)).not.toContain(docId);

        // Once the create is inside the slice, the merged state appears.
        const atFull = await db.getDocumentAtTimestamp(docId, base + 5000);
        expect(atFull).not.toBeNull();
        expect(atFull!.getData().status).toBe("active");
      } finally {
        nowSpy.mockRestore();
      }
    });

    test("history iteration and paging use causal order for same-instant entries", async () => {
      const base = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(base);
      try {
        const doc = await db.createDocument();
        const docId = doc.getId();
        await db.changeDoc(doc, (d) => {
          d.getData().step = 1;
        });
        await db.deleteDocument(docId);

        const states: { entryId: string; isDeleted: boolean }[] = [];
        for await (const { changeEntryId, doc: histDoc } of db.iterateDocumentHistory(docId)) {
          states.push({ entryId: changeEntryId, isDeleted: histDoc.isDeleted() });
        }
        expect(states.length).toBeGreaterThanOrEqual(3);
        expect(states[0].isDeleted).toBe(false);
        expect(states[states.length - 1].isDeleted).toBe(true);

        // The metadata-only paging API must agree with the iterator's order.
        const page = await db.getDocumentHistoryPage(docId, { limit: 10 });
        expect(page.entries.map((entry) => entry.entryId)).toEqual(
          states.map((state) => state.entryId),
        );
        expect(page.entries[0].entryType).toBe("doc_create");
        expect(page.entries[page.entries.length - 1].entryType).toBe("doc_delete");
        expect(page.entries[page.entries.length - 1].isDeleted).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
