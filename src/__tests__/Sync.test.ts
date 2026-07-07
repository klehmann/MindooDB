import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, MindooDoc, ContentAddressedStoreFactory, ContentAddressedStore, DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, SyncProgress } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("sync test", () => {
  let storeFactory1: InMemoryContentAddressedStoreFactory; // Store factory for user1
  let storeFactory2: InMemoryContentAddressedStoreFactory; // Store factory for user2
  let factory1: BaseMindooTenantFactory; // Factory for user1
  let factory2: BaseMindooTenantFactory; // Factory for user2
  
  let user1: PrivateUserId;
  let user1Password: string;
  let user1KeyBag: KeyBag;
  
  let user2: PrivateUserId;
  let user2Password: string;
  let user2KeyBag: KeyBag;
  
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  
  let tenantId: string;
  let tenantEncryptionKey: Uint8Array; // Store the tenant key bytes so user2 can use the same one
  let publicInfosKey: Uint8Array; // Store $publicinfos key bytes for user2 to use
  
  let tenant1: MindooTenant; // Tenant instance for user1
  let tenant2: MindooTenant; // Tenant instance for user2

  beforeEach(async () => {
    // Create separate store factories for each user
    // This simulates two separate clients/servers that need to sync
    storeFactory1 = new InMemoryContentAddressedStoreFactory();
    storeFactory2 = new InMemoryContentAddressedStoreFactory();
    
    const cryptoAdapter = new NodeCryptoAdapter();
    // Create separate factories for each user
    factory1 = new BaseMindooTenantFactory(storeFactory1, cryptoAdapter);
    factory2 = new BaseMindooTenantFactory(storeFactory2, cryptoAdapter);
    
    // Create user1 (admin user with access to admin key) using factory1
    user1Password = "user1pass123";
    user1 = await factory1.createUserId("CN=user1/O=testtenant", user1Password);
    user1KeyBag = new KeyBag(
      user1.userEncryptionKeyPair.privateKey,
      user1Password,
      cryptoAdapter
    );
    
    // Create user2 (regular user) using factory2
    user2Password = "user2pass123";
    user2 = await factory2.createUserId("CN=user2/O=testtenant", user2Password);
    user2KeyBag = new KeyBag(
      user2.userEncryptionKeyPair.privateKey,
      user2Password,
      cryptoAdapter
    );
    
    // Create admin user (signing + encryption keys used for tenant administration)
    adminUserPassword = "adminpass123";
    adminUser = await factory1.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    tenantId = "test-tenant-sync";
    // Create $publicinfos symmetric key (required for all servers/clients)
    await user1KeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    publicInfosKey = (await user1KeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    
    // Create tenant encryption key (store it so user2 can use the same one)
    // Create tenant for user1 using factory1
    await user1KeyBag.createTenantKey(tenantId);
    tenantEncryptionKey = (await user1KeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;
    tenant1 = await factory1.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user1,
      user1Password,
      user1KeyBag
    );
  }, 30000);

  it("should sync data from first user to second user using pullChangesFrom", async () => {
    // Step 1: User1 (admin) adds himself and user2 to the tenant
    const directory1 = await tenant1.openDirectory();
    const publicUser1 = factory1.toPublicUserId(user1);
    const publicUser2 = factory2.toPublicUserId(user2);
    
    // Register user1
    await directory1.registerUser(
      publicUser1,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
    
    // Register user2
    await directory1.registerUser(
      publicUser2,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
    
    // Step 2: User1 opens "contacts" database and creates one contact document
    const contactsDB1 = await tenant1.openDB("contacts");
    
    const contactDoc = await contactsDB1.createDocument();
    await contactsDB1.changeDoc(contactDoc, async (doc) => {
      const data = doc.getData();
      data.name = "John Doe";
      data.email = "john.doe@example.com";
      data.phone = "+1234567890";
    });
    
    // Verify user1 can see the contact
    const allContacts1 = await contactsDB1.getAllDocumentIds();
    expect(allContacts1.length).toBe(1);
    
    // Step 3: User2 sets up the tenant on his side
    // User2 needs the same tenant encryption key, admin keys, and $publicinfos key
    // User2 uses factory2 which has its own separate store factory
    
    // Add $publicinfos key to user2 KeyBag
    await user2KeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await user2KeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantEncryptionKey);
    
    tenant2 = await factory2.openTenant(tenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, user2, user2Password, user2KeyBag);
    
    // Step 4: User2 opens the directory database, which is allowed before access is known
    const directory2 = await tenant2.openDB("directory");

    // Verify the directory is empty for user2 before syncing
    const allDirectoryDocs2 = await directory2.getAllDocumentIds();
    expect(allDirectoryDocs2.length).toBe(0);

    // Step 5: User2 uses pullChangesFrom to populate the directory store first
    // Get the stores from user1's databases
    const directoryStore1 = (await tenant1.openDB("directory")).getStore();
    const contactsStore1 = (await tenant1.openDB("contacts")).getStore();
    
    // Pull the directory first so tenant access is granted before opening regular DBs
    await directory2.pullChangesFrom(directoryStore1);
    const contactsDB2 = await tenant2.openDB("contacts");
    await contactsDB2.pullChangesFrom(contactsStore1);
    
    // Step 6: Verify user2 can now see the data
    const allDirectoryDocs2After = await directory2.getAllDocumentIds();
    const allContacts2After = await contactsDB2.getAllDocumentIds();
    
    // User2 should now see the directory entries (user1 and user2 registrations)
    expect(allDirectoryDocs2After.length).toBeGreaterThan(0);
    
    // User2 should now see the contact document
    expect(allContacts2After.length).toBe(1);
    
    // Verify the contact document content
    const contactDocId = allContacts2After[0];
    expect(contactDocId).toBe(contactDoc.getId());
    const contactDoc2 = await contactsDB2.getDocument(contactDocId);
    const contactData = contactDoc2.getData();
    expect(contactData.name).toBe("John Doe");
    expect(contactData.email).toBe("john.doe@example.com");
    expect(contactData.phone).toBe("+1234567890");
    
    // Step 7: User2 modifies the contact document
    await contactsDB2.changeDoc(contactDoc2, async (doc) => {
      const data = doc.getData();
      data.name = "John Smith"; // Changed name
      data.email = "john.smith@example.com"; // Changed email
      data.phone = "+9876543210"; // Changed phone
      data.address = "123 Main St"; // Added new field
    });
    
    // Verify user2 sees the updated document
    const updatedContactDoc2 = await contactsDB2.getDocument(contactDocId);
    const updatedContactData2 = updatedContactDoc2.getData();
    expect(updatedContactData2.name).toBe("John Smith");
    expect(updatedContactData2.email).toBe("john.smith@example.com");
    expect(updatedContactData2.phone).toBe("+9876543210");
    expect(updatedContactData2.address).toBe("123 Main St");
    
    // Step 8: User2 pushes changes back to user1's store
    // Reuse the contactsStore1 that was already retrieved in Step 5
    // Push changes from user2's store to user1's store
    await contactsDB2.pushChangesTo(contactsStore1);
    
    // Step 9: User1 syncs his store to process the new changes
    await contactsDB1.syncStoreChanges();
    
    // Step 10: User1 refetches the document and verifies it has the updated content
    const updatedContactDoc1 = await contactsDB1.getDocument(contactDocId);
    const updatedContactData1 = updatedContactDoc1.getData();
    
    // Verify all the changes made by user2 are visible to user1
    expect(updatedContactData1.name).toBe("John Smith");
    expect(updatedContactData1.email).toBe("john.smith@example.com");
    expect(updatedContactData1.phone).toBe("+9876543210");
    expect(updatedContactData1.address).toBe("123 Main St");
    
    // Verify the document ID is still the same
    expect(updatedContactDoc1.getId()).toBe(contactDocId);
    
    // Verify the lastModified timestamp has been updated
    expect(updatedContactDoc1.getLastModified()).toBeGreaterThan(contactDoc.getLastModified());
  });

  it("should sync encrypted document through intermediate user who does not have the decryption key", async () => {
    // This test verifies:
    // 1. User1 creates a document encrypted with a named symmetric key
    // 2. User1 shares the key only with User3 (not User2)
    // 3. User2 syncs the encrypted entries (but can't read the document)
    // 4. User3 syncs from User2 and can read the document
    // 5. User3 modifies the document
    // 6. Changes sync back through User2 to User1

    const cryptoAdapter = new NodeCryptoAdapter();
    
    // Create 3 separate store factories (simulating 3 different clients)
    const sf1 = new InMemoryContentAddressedStoreFactory();
    const sf2 = new InMemoryContentAddressedStoreFactory();
    const sf3 = new InMemoryContentAddressedStoreFactory();
    
    const f1 = new BaseMindooTenantFactory(sf1, cryptoAdapter);
    const f2 = new BaseMindooTenantFactory(sf2, cryptoAdapter);
    const f3 = new BaseMindooTenantFactory(sf3, cryptoAdapter);
    
    // Create 3 users
    const u1Pass = "user1pass";
    const u1 = await f1.createUserId("CN=user1/O=test", u1Pass);
    const u1KeyBag = new KeyBag(u1.userEncryptionKeyPair.privateKey, u1Pass, cryptoAdapter);
    
    const u2Pass = "user2pass";
    const u2 = await f2.createUserId("CN=user2/O=test", u2Pass);
    const u2KeyBag = new KeyBag(u2.userEncryptionKeyPair.privateKey, u2Pass, cryptoAdapter);
    
    const u3Pass = "user3pass";
    const u3 = await f3.createUserId("CN=user3/O=test", u3Pass);
    const u3KeyBag = new KeyBag(u3.userEncryptionKeyPair.privateKey, u3Pass, cryptoAdapter);
    
    // Create admin user (signing + encryption keys used for tenant administration)
    const adminPass = "adminpass";
    const adminUser = await f1.createUserId("CN=admin/O=test", adminPass);
    
    // Create tenant for user1
    const tid = "named-key-sync-test";
    // Create $publicinfos symmetric key (required for all users)
    await u1KeyBag.createDocKey(tid, PUBLIC_INFOS_KEY_ID);
    const pubInfosKey = (await u1KeyBag.get("doc", tid, PUBLIC_INFOS_KEY_ID))!;
    
    // Add $publicinfos key to all KeyBags
    await u2KeyBag.set("doc", tid, PUBLIC_INFOS_KEY_ID, pubInfosKey);
    await u3KeyBag.set("doc", tid, PUBLIC_INFOS_KEY_ID, pubInfosKey);
    
    await u1KeyBag.createTenantKey(tid);
    const tenantKey = (await u1KeyBag.get("doc", tid, DEFAULT_TENANT_KEY_ID))!;
    const t1 = await f1.openTenant(
      tid,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      u1,
      u1Pass,
      u1KeyBag
    );
    
    // Register all 3 users in the directory
    const dir1 = await t1.openDirectory();
    await dir1.registerUser(f1.toPublicUserId(u1), adminUser.userSigningKeyPair.privateKey, adminPass);
    await dir1.registerUser(f2.toPublicUserId(u2), adminUser.userSigningKeyPair.privateKey, adminPass);
    await dir1.registerUser(f3.toPublicUserId(u3), adminUser.userSigningKeyPair.privateKey, adminPass);
    
    // User1 creates a named symmetric key (shared only with User3, NOT User2)
    const namedKeyId = "secret-project-key";
    await u1KeyBag.createDocKey(tid, namedKeyId);
    const namedKey = (await u1KeyBag.get("doc", tid, namedKeyId))!;

    // Import the key into User3's KeyBag (User3 has the key, User2 does NOT)
    await u3KeyBag.set("doc", tid, namedKeyId, namedKey);
    
    // User1 creates an encrypted document with the named key
    const secretDB1 = await t1.openDB("secrets");
    const secretDoc = await secretDB1.createEncryptedDocument(namedKeyId);
    const secretDocId = secretDoc.getId();
    
    await secretDB1.changeDoc(secretDoc, async (doc: MindooDoc) => {
      const data = doc.getData();
      data.title = "Project Alpha";
      data.content = "This is confidential information";
      data.createdBy = "user1";
    });
    
    // Verify User1 can see the document
    const allSecrets1 = await secretDB1.getAllDocumentIds();
    expect(allSecrets1.length).toBe(1);
    expect(allSecrets1[0]).toBe(secretDocId);
    
    // User2 sets up tenant (does NOT have the named key in their KeyBag)
    await u2KeyBag.set("doc", tid, DEFAULT_TENANT_KEY_ID, tenantKey);
    const t2 = await f2.openTenant(tid, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, u2, u2Pass, u2KeyBag);
    const dir2 = await t2.openDB("directory");
    
    // User2 syncs directory from User1
    const dirStore1 = (await t1.openDB("directory")).getStore();
    await dir2.pullChangesFrom(dirStore1);
    
    const secretDB2 = await t2.openDB("secrets");
    
    // User2 syncs secrets database from User1
    // This should NOT throw - the encrypted entries are stored, but the document is skipped
    const secretsStore1 = secretDB1.getStore();
    await secretDB2.pullChangesFrom(secretsStore1);
    
    // User2 should NOT see the secret document (can't decrypt it)
    const allSecrets2 = await secretDB2.getAllDocumentIds();
    expect(allSecrets2.length).toBe(0);
    
    // But the entries ARE in User2's store (verify via store API)
    const store2Ids = await secretDB2.getStore().getAllIds();
    expect(store2Ids.length).toBeGreaterThan(0);
    
    // User3 sets up tenant (HAS the named key in their KeyBag)
    await u3KeyBag.set("doc", tid, DEFAULT_TENANT_KEY_ID, tenantKey);
    const t3 = await f3.openTenant(tid, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, u3, u3Pass, u3KeyBag);
    const dir3 = await t3.openDB("directory");
    
    // User3 syncs directory from User2
    await dir3.pullChangesFrom(dir2.getStore());
    
    const secretDB3 = await t3.openDB("secrets");
    
    // User3 syncs secrets database from User2's store
    await secretDB3.pullChangesFrom(secretDB2.getStore());
    
    // User3 SHOULD see the secret document (has the decryption key)
    const allSecrets3 = await secretDB3.getAllDocumentIds();
    expect(allSecrets3.length).toBe(1);
    expect(allSecrets3[0]).toBe(secretDocId);
    
    // Verify User3 can read the document content
    const secretDoc3 = await secretDB3.getDocument(secretDocId);
    const secretData3 = secretDoc3.getData();
    expect(secretData3.title).toBe("Project Alpha");
    expect(secretData3.content).toBe("This is confidential information");
    expect(secretData3.createdBy).toBe("user1");
    
    // User3 modifies the document
    await secretDB3.changeDoc(secretDoc3, async (doc: MindooDoc) => {
      const data = doc.getData();
      data.content = "Updated by User3";
      data.modifiedBy = "user3";
    });
    
    // Verify User3 sees the updated content
    const updatedSecretDoc3 = await secretDB3.getDocument(secretDocId);
    expect(updatedSecretDoc3.getData().content).toBe("Updated by User3");
    expect(updatedSecretDoc3.getData().modifiedBy).toBe("user3");
    
    // User3 pushes changes to User2's store
    await secretDB3.pushChangesTo(secretDB2.getStore());
    
    // User2 syncs (still can't see the document, but entries are updated)
    await secretDB2.syncStoreChanges();
    const allSecrets2AfterSync = await secretDB2.getAllDocumentIds();
    expect(allSecrets2AfterSync.length).toBe(0); // Still can't decrypt
    
    // User2 pushes changes to User1's store
    await secretDB2.pushChangesTo(secretsStore1);
    
    // User1 syncs to process the new changes
    await secretDB1.syncStoreChanges();
    
    // User1 should see User3's changes
    const finalSecretDoc1 = await secretDB1.getDocument(secretDocId);
    const finalSecretData1 = finalSecretDoc1.getData();
    expect(finalSecretData1.title).toBe("Project Alpha");
    expect(finalSecretData1.content).toBe("Updated by User3");
    expect(finalSecretData1.createdBy).toBe("user1");
    expect(finalSecretData1.modifiedBy).toBe("user3");
  }, 60000);

  async function setupTenant2AndPull() {
    const directory1 = await tenant1.openDirectory();
    const publicUser1 = factory1.toPublicUserId(user1);
    const publicUser2 = factory2.toPublicUserId(user2);
    await directory1.registerUser(publicUser1, adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    await directory1.registerUser(publicUser2, adminUser.userSigningKeyPair.privateKey, adminUserPassword);

    await user2KeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await user2KeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantEncryptionKey);
    tenant2 = await factory2.openTenant(tenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, user2, user2Password, user2KeyBag);

    const directory2 = await tenant2.openDB("directory");
    const directoryStore1 = (await tenant1.openDB("directory")).getStore();
    await directory2.pullChangesFrom(directoryStore1);

    return { directory1, directory2 };
  }

  it("pullChangesFrom should return SyncResult with transferred count", async () => {
    await setupTenant2AndPull();

    const contactsDB1 = await tenant1.openDB("contacts");
    const contactDoc = await contactsDB1.createDocument();
    await contactsDB1.changeDoc(contactDoc, async (doc) => {
      const data = doc.getData();
      data.name = "Test Contact";
    });

    const contactsDB2 = await tenant2.openDB("contacts");
    const contactsStore1 = contactsDB1.getStore();

    const result = await contactsDB2.pullChangesFrom(contactsStore1);
    expect(result.transferredEntries).toBeGreaterThan(0);
    expect(result.cancelled).toBe(false);

    const result2 = await contactsDB2.pullChangesFrom(contactsStore1);
    expect(result2.transferredEntries).toBe(0);
    expect(result2.cancelled).toBe(false);
  });

  it("pullChangesFrom should emit progress callbacks", async () => {
    await setupTenant2AndPull();

    const contactsDB1 = await tenant1.openDB("contacts");
    const contactDoc = await contactsDB1.createDocument();
    await contactsDB1.changeDoc(contactDoc, async (doc) => {
      const data = doc.getData();
      data.name = "Progress Test";
    });

    const contactsDB2 = await tenant2.openDB("contacts");
    const contactsStore1 = contactsDB1.getStore();

    const progressEvents: SyncProgress[] = [];
    const result = await contactsDB2.pullChangesFrom(contactsStore1, {
      onProgress: (progress) => progressEvents.push({ ...progress }),
    });

    expect(result.transferredEntries).toBeGreaterThan(0);
    expect(progressEvents.length).toBeGreaterThan(0);

    const phases = progressEvents.map((e) => e.phase);
    expect(phases).toContain('transferring');
    expect(phases).toContain('complete');

    const lastEvent = progressEvents[progressEvents.length - 1];
    expect(lastEvent.phase).toBe('complete');
    expect(lastEvent.transferredEntries).toBeGreaterThan(0);
  });

  it("pullChangesFrom should expose transfer batch progress for chunked syncs", async () => {
    await setupTenant2AndPull();

    const contactsDB1 = await tenant1.openDB("contacts");
    for (let i = 0; i < 4; i++) {
      const doc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(doc, async (d) => {
        d.getData().name = `Chunked Contact ${i}`;
      });
    }

    const contactsDB2 = await tenant2.openDB("contacts");
    const contactsStore1 = contactsDB1.getStore();
    const progressEvents: SyncProgress[] = [];

    const result = await contactsDB2.pullChangesFrom(contactsStore1, {
      pageSize: 1000,
      transferBatchSize: 2,
      onProgress: (progress) => progressEvents.push({ ...progress }),
    });

    expect(result.cancelled).toBe(false);
    const transferEvents = progressEvents.filter((event) => event.currentTransferBatch !== undefined);
    expect(transferEvents.length).toBeGreaterThan(1);
    expect(transferEvents.some((event) => event.totalTransferBatches && event.totalTransferBatches > 1)).toBe(true);
    expect(transferEvents.every((event) => event.transferBatchSize === 2)).toBe(true);
  });

  it("pullChangesFrom should keep partial counts when cancelled between transfer batches", async () => {
    await setupTenant2AndPull();

    const contactsDB1 = await tenant1.openDB("contacts");
    for (let i = 0; i < 5; i++) {
      const doc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(doc, async (d) => {
        d.getData().name = `Cancel Contact ${i}`;
      });
    }

    const contactsDB2 = await tenant2.openDB("contacts");
    const contactsStore1 = contactsDB1.getStore();
    const controller = new AbortController();

    const result = await contactsDB2.pullChangesFrom(contactsStore1, {
      pageSize: 1000,
      transferBatchSize: 2,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.currentTransferBatch === 1 && progress.transferredEntries > 0) {
          controller.abort();
        }
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.transferredEntries).toBeGreaterThan(0);
  });

  it("pullChangesFrom should support cancellation via AbortSignal", async () => {
    await setupTenant2AndPull();

    const contactsDB1 = await tenant1.openDB("contacts");
    for (let i = 0; i < 5; i++) {
      const doc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(doc, async (d) => {
        const data = d.getData();
        data.name = `Contact ${i}`;
      });
    }

    const contactsDB2 = await tenant2.openDB("contacts");
    const contactsStore1 = contactsDB1.getStore();

    const controller = new AbortController();
    controller.abort();

    const result = await contactsDB2.pullChangesFrom(contactsStore1, {
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
  });

  it("should accept a MindooDB instance instead of a store", async () => {
    await setupTenant2AndPull();

    const contactsDB1 = await tenant1.openDB("contacts");
    const contactDoc = await contactsDB1.createDocument();
    await contactsDB1.changeDoc(contactDoc, async (doc) => {
      const data = doc.getData();
      data.name = "MindooDB Sync Test";
    });

    const contactsDB2 = await tenant2.openDB("contacts");

    const result = await contactsDB2.pullChangesFrom(contactsDB1);
    expect(result.transferredEntries).toBeGreaterThan(0);
    expect(result.cancelled).toBe(false);

    const allContacts2 = await contactsDB2.getAllDocumentIds();
    expect(allContacts2.length).toBe(1);

    const contactDoc2 = await contactsDB2.getDocument(allContacts2[0]);
    expect(contactDoc2.getData().name).toBe("MindooDB Sync Test");
  });

  // --- sync-v5 phase 1: persisted scan cursor + store-head skip ---

  describe("persisted sync cursor (sync-v5 phase 1)", () => {
    /** Wrap a store's scanEntriesSince with a call counter. */
    function instrumentScan(store: ContentAddressedStore): () => number {
      const originalScan = store.scanEntriesSince!.bind(store);
      let calls = 0;
      store.scanEntriesSince = async (cursor, limit, filters) => {
        calls++;
        return originalScan(cursor, limit, filters);
      };
      return () => calls;
    }

    it("idle re-sync skips the metadata scan entirely (0 scan pages)", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      const contactDoc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(contactDoc, async (doc) => {
        doc.getData().name = "Cursor Test";
      });

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();

      // First pull transfers and persists the scan cursor.
      const first = await contactsDB2.pullChangesFrom(contactsStore1);
      expect(first.transferredEntries).toBeGreaterThan(0);

      // Second pull with an unchanged source head must not scan at all.
      const scanCalls = instrumentScan(contactsStore1);
      const second = await contactsDB2.pullChangesFrom(contactsStore1);
      expect(second.transferredEntries).toBe(0);
      expect(second.cancelled).toBe(false);
      expect(scanCalls()).toBe(0);
    });

    it("resumes the scan from the persisted cursor when the source has new entries", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      const doc1 = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(doc1, async (d) => {
        d.getData().name = "First";
      });

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();
      await contactsDB2.pullChangesFrom(contactsStore1);

      // New source entries after the cursor was persisted.
      const doc2 = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(doc2, async (d) => {
        d.getData().name = "Second";
      });

      // The resumed scan must start at the persisted cursor, i.e. only see
      // the entries added after the first pull.
      const originalScan = contactsStore1.scanEntriesSince!.bind(contactsStore1);
      const firstScanCursors: Array<number | undefined> = [];
      contactsStore1.scanEntriesSince = async (cursor, limit, filters) => {
        firstScanCursors.push(cursor?.receiptOrder);
        return originalScan(cursor, limit, filters);
      };

      const result = await contactsDB2.pullChangesFrom(contactsStore1);
      expect(result.transferredEntries).toBeGreaterThan(0);
      expect(firstScanCursors.length).toBeGreaterThan(0);
      // Resumed, not restarted: the first scan call carries the persisted cursor.
      expect(firstScanCursors[0]).toBeDefined();
      expect(firstScanCursors[0]!).toBeGreaterThan(0);

      const allContacts2 = await contactsDB2.getAllDocumentIds();
      expect(allContacts2.length).toBe(2);
    });

    it("epoch change on the source discards the cursor and forces a full re-scan", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      const contactDoc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(contactDoc, async (doc) => {
        doc.getData().name = "Epoch Test";
      });

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();
      await contactsDB2.pullChangesFrom(contactsStore1);

      // Simulate a store reset / receipt-order migration on the source:
      // same data, new epoch.
      const originalGetStoreHead = contactsStore1.getStoreHead!.bind(contactsStore1);
      contactsStore1.getStoreHead = async () => {
        const head = await originalGetStoreHead();
        return { ...head, epoch: "rotated-epoch" };
      };

      const scanCalls = instrumentScan(contactsStore1);
      const result = await contactsDB2.pullChangesFrom(contactsStore1);
      // Nothing new to transfer, but the scan must run again from scratch.
      expect(result.transferredEntries).toBe(0);
      expect(scanCalls()).toBeGreaterThan(0);
    });

    it("forceFullScan bypasses the persisted cursor", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      const contactDoc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(contactDoc, async (doc) => {
        doc.getData().name = "Force Scan Test";
      });

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();
      await contactsDB2.pullChangesFrom(contactsStore1);

      const scanCalls = instrumentScan(contactsStore1);

      // Without forceFullScan this would be a 0-scan skip (see idle test).
      const result = await contactsDB2.pullChangesFrom(contactsStore1, {
        forceFullScan: true,
      });
      expect(result.transferredEntries).toBe(0);
      expect(scanCalls()).toBeGreaterThan(0);
    });

    it("in-memory stores expose a store head that rotates on clearAllLocalData", async () => {
      await setupTenant2AndPull();
      const contactsDB1 = await tenant1.openDB("contacts");
      const store = contactsDB1.getStore();

      const headBefore = await store.getStoreHead!();
      expect(typeof headBefore.epoch).toBe("string");
      expect(headBefore.epoch.length).toBeGreaterThan(0);

      const doc = await contactsDB1.createDocument();
      await contactsDB1.changeDoc(doc, async (d) => {
        d.getData().name = "Head Test";
      });

      const headAfterWrite = await store.getStoreHead!();
      expect(headAfterWrite.epoch).toBe(headBefore.epoch);
      expect(headAfterWrite.maxReceiptOrder).toBeGreaterThan(headBefore.maxReceiptOrder);

      await store.clearAllLocalData!();
      const headAfterReset = await store.getStoreHead!();
      expect(headAfterReset.epoch).not.toBe(headBefore.epoch);
    });
  });

  // --- sync-v5 phase 4: parallel transfer batches ---

  describe("parallel transfer batches (sync-v5 phase 4)", () => {
    /**
     * Wrap a store's getEntries with an artificial delay and record the peak
     * number of concurrent in-flight calls.
     */
    function instrumentGetEntries(store: ContentAddressedStore, delayMs: number) {
      const originalGetEntries = store.getEntries.bind(store);
      let inFlight = 0;
      let peak = 0;
      store.getEntries = async (ids: string[]) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return await originalGetEntries(ids);
        } finally {
          inFlight--;
        }
      };
      return () => peak;
    }

    async function createContacts(db: MindooDB, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const doc = await db.createDocument();
        await db.changeDoc(doc, async (d) => {
          d.getData().name = `Parallel Contact ${i}`;
        });
      }
    }

    it("runs transfer batches concurrently up to maxConcurrentBatches", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      await createContacts(contactsDB1, 6);

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();
      const peakConcurrency = instrumentGetEntries(contactsStore1, 25);

      const result = await contactsDB2.pullChangesFrom(contactsStore1, {
        pageSize: 1000,
        transferBatchSize: 1,
        maxConcurrentBatches: 3,
      });

      expect(result.cancelled).toBe(false);
      expect(result.transferredEntries).toBeGreaterThanOrEqual(6);
      expect(peakConcurrency()).toBeGreaterThanOrEqual(2);
      expect(peakConcurrency()).toBeLessThanOrEqual(3);

      const allContacts2 = await contactsDB2.getAllDocumentIds();
      expect(allContacts2.length).toBe(6);
    });

    it("maxConcurrentBatches=1 keeps transfers strictly sequential", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      await createContacts(contactsDB1, 4);

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();
      const peakConcurrency = instrumentGetEntries(contactsStore1, 10);

      const result = await contactsDB2.pullChangesFrom(contactsStore1, {
        pageSize: 1000,
        transferBatchSize: 1,
        maxConcurrentBatches: 1,
      });

      expect(result.cancelled).toBe(false);
      expect(peakConcurrency()).toBe(1);
    });

    it("abort during parallel batches keeps partial counts and cancels cleanly", async () => {
      await setupTenant2AndPull();

      const contactsDB1 = await tenant1.openDB("contacts");
      await createContacts(contactsDB1, 8);

      const contactsDB2 = await tenant2.openDB("contacts");
      const contactsStore1 = contactsDB1.getStore();
      instrumentGetEntries(contactsStore1, 10);

      const controller = new AbortController();
      const result = await contactsDB2.pullChangesFrom(contactsStore1, {
        pageSize: 1000,
        transferBatchSize: 1,
        maxConcurrentBatches: 3,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.transferredEntries > 0 && !controller.signal.aborted) {
            controller.abort();
          }
        },
      });

      expect(result.cancelled).toBe(true);
      expect(result.transferredEntries).toBeGreaterThan(0);
      // Not everything can have made it across before the abort.
      const store2Ids = await contactsDB2.getStore().getAllIds();
      const store1Ids = await contactsStore1.getAllIds();
      expect(store2Ids.length).toBeLessThan(store1Ids.length);
    });
  });

  // --- sync-v5: per-entry rejection on push ---

  describe("per-entry rejection on push (sync-v5)", () => {
    it("push completes despite a rejected entry and reports it in the SyncResult", async () => {
      // Register user1 so the tenant allows opening content databases.
      const directory1 = await tenant1.openDirectory();
      await directory1.registerUser(
        factory1.toPublicUserId(user1),
        adminUser.userSigningKeyPair.privateKey,
        adminUserPassword,
      );

      const contactsDB1 = await tenant1.openDB("contacts");
      for (let i = 0; i < 3; i++) {
        const doc = await contactsDB1.createDocument();
        await contactsDB1.changeDoc(doc, async (d) => {
          d.getData().name = `Rejection Contact ${i}`;
        });
      }

      const sourceStore = contactsDB1.getStore();
      const allSourceIds = await sourceStore.getAllIds();
      expect(allSourceIds.length).toBeGreaterThan(2);
      // Pick one arbitrary entry the "server" will refuse (e.g. because its
      // author signature does not verify on the remote side).
      const rejectId = allSourceIds[1];

      // Push target that behaves like a sync-v5 server: it skips the poisoned
      // entry per entry (reporting it in the ack) instead of failing the batch.
      const target = new InMemoryContentAddressedStoreFactory().createStore("contacts").docStore;
      const originalPut = target.putEntries.bind(target);
      target.putEntries = async (entries) => {
        const accepted = entries.filter((e) => e.id !== rejectId);
        await originalPut(accepted);
        return {
          receipts: [],
          rejected: entries
            .filter((e) => e.id === rejectId)
            .map((e) => ({ id: e.id, reason: `Entry ${e.id} has an invalid author signature` })),
        };
      };

      const result = await contactsDB1.pushChangesTo(target);

      // The push ran to completion: everything except the rejected entry made it.
      expect(result.cancelled).toBe(false);
      expect(result.transferredEntries).toBe(allSourceIds.length - 1);
      expect(result.rejectedEntries).toEqual([
        { id: rejectId, reason: expect.stringContaining("invalid author signature") },
      ]);

      const targetIds = await target.getAllIds();
      expect(targetIds).not.toContain(rejectId);
      expect(targetIds.length).toBe(allSourceIds.length - 1);
    });
  });
});

