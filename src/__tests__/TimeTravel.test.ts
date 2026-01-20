import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { MindooDB, MindooDoc, SigningKeyPair, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("TimeTravel", () => {
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let factory: BaseMindooTenantFactory;
  let tenant: any;
  let db: MindooDB;
  let user: any;
  let userPassword: string;
  let adminSigningKeyPair: SigningKeyPair;
  let adminSigningKeyPassword: string;

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
    
    adminSigningKeyPassword = "adminsigningpass123";
    adminSigningKeyPair = await factory.createSigningKeyPair(adminSigningKeyPassword);
    
    const adminEncryptionKeyPair = await factory.createEncryptionKeyPair("adminencpass123");
    const publicInfosKey = await factory.createSymmetricEncryptedPrivateKey("publicinfospass123");
    await userKeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, "publicinfospass123");
    
    tenant = await factory.createTenant(
      "test-tenant",
      adminSigningKeyPair.publicKey,
      adminEncryptionKeyPair.publicKey,
      "tenantkeypass123",
      user,
      userPassword,
      userKeyBag
    );
    
    // Register the user in the directory so their public key is trusted
    const directory = await tenant.openDirectory();
    const publicUser = factory.toPublicUserId(user);
    await directory.registerUser(
      publicUser,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
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
      const firstValue = versions[versions.length - 2].getData().value;
      const secondValue = versions[versions.length - 1].getData().value;
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
      for await (const { doc: histDoc } of db.iterateDocumentHistory(docId)) {
        history.push(histDoc);
      }
      
      // Should have at least create + one change + delete entry
      expect(history.length).toBeGreaterThanOrEqual(3);
      // Last entry should be the deleted state
      expect(history[history.length - 1].isDeleted()).toBe(true);
      // Second to last should be the active state before deletion
      expect(history[history.length - 2].getData().status).toBe("active");
      expect(history[history.length - 2].isDeleted()).toBe(false);
    });
  });
});
