import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, SigningKeyPair, ContentAddressedStoreFactory, ContentAddressedStore, EncryptedPrivateKey, PUBLIC_INFOS_KEY_ID, EncryptionKeyPair } from "../core/types";
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
  
  let adminSigningKeyPair: SigningKeyPair;
  let adminSigningKeyPassword: string;
  
  let tenantId: string;
  let tenantEncryptionKeyPassword: string;
  let tenantEncryptionKey: EncryptedPrivateKey; // Store the tenant encryption key so user2 can use the same one
  let adminEncryptionKeyPair: EncryptionKeyPair; // Store admin encryption key for user2 to use
  let publicInfosKey: EncryptedPrivateKey; // Store $publicinfos key for user2 to use
  let publicInfosKeyPassword: string;
  
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
    
    // Create admin signing key pair using factory1 (both factories can create keys)
    adminSigningKeyPassword = "adminsigningpass123";
    adminSigningKeyPair = await factory1.createSigningKeyPair(adminSigningKeyPassword);
    
    // Create admin encryption key pair (for encrypting usernames in directory)
    adminEncryptionKeyPair = await factory1.createEncryptionKeyPair("adminencpass123");
    
    // Create $publicinfos symmetric key (required for all servers/clients)
    publicInfosKeyPassword = "publicinfospass123";
    publicInfosKey = await factory1.createSymmetricEncryptedPrivateKey(publicInfosKeyPassword);
    
    // Add $publicinfos key to user1 KeyBag
    await user1KeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
    
    // Create tenant encryption key (store it so user2 can use the same one)
    tenantEncryptionKeyPassword = "tenantkeypass123";
    
    // Create tenant for user1 using factory1
    tenantId = "test-tenant-sync";
    tenant1 = await factory1.createTenant(tenantId,
      adminSigningKeyPair.publicKey,
      adminEncryptionKeyPair.publicKey,
      tenantEncryptionKeyPassword,
      user1,
      user1Password,
      user1KeyBag
    );
    tenantEncryptionKey = tenant1.getTenantEncryptionKey();
  }, 30000);

  it("should sync data from first user to second user using pullChangesFrom", async () => {
    // Step 1: User1 (admin) adds himself and user2 to the tenant
    const directory1 = await tenant1.openDirectory();
    const publicUser1 = factory1.toPublicUserId(user1);
    const publicUser2 = factory2.toPublicUserId(user2);
    
    // Register user1
    await directory1.registerUser(
      publicUser1,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
    );
    
    // Register user2
    await directory1.registerUser(
      publicUser2,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
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
    await user2KeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
    
    tenant2 = await factory2.openTenantWithKeys(
      tenantId,
      tenantEncryptionKey,
      tenantEncryptionKeyPassword,
      adminSigningKeyPair.publicKey,
      adminEncryptionKeyPair.publicKey,
      user2,
      user2Password,
      user2KeyBag
    );
    
    // Step 4: User2 opens "directory" and "contacts" databases (which are empty by default)
    const directory2 = await tenant2.openDB("directory");    
    const contactsDB2 = await tenant2.openDB("contacts");

    // Verify both databases are empty for user2
    const allDirectoryDocs2 = await directory2.getAllDocumentIds();
    const allContacts2 = await contactsDB2.getAllDocumentIds();
    expect(allDirectoryDocs2.length).toBe(0);
    expect(allContacts2.length).toBe(0);
    
    // Step 5: User2 uses pullChangesFrom to populate both underlying AppendOnlyStore's
    // Get the stores from user1's databases
    const directoryStore1 = (await tenant1.openDB("directory")).getStore();
    const contactsStore1 = (await tenant1.openDB("contacts")).getStore();
    
    // Pull changes from user1's stores to user2's stores
    await directory2.pullChangesFrom(directoryStore1);
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
    
    // Create admin keys
    const adminPass = "adminpass";
    const adminKeyPair = await f1.createSigningKeyPair(adminPass);
    const adminEncKeyPair = await f1.createEncryptionKeyPair("adminencpass");
    
    // Create $publicinfos symmetric key (required for all users)
    const pubInfosPass = "publicinfospass";
    const pubInfosKey = await f1.createSymmetricEncryptedPrivateKey(pubInfosPass);
    
    // Add $publicinfos key to all KeyBags
    await u1KeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, pubInfosKey, pubInfosPass);
    await u2KeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, pubInfosKey, pubInfosPass);
    await u3KeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, pubInfosKey, pubInfosPass);
    
    // Create tenant for user1
    const tid = "named-key-sync-test";
    const tenantKeyPass = "tenantpass";
    const t1 = await f1.createTenant(tid, adminKeyPair.publicKey, adminEncKeyPair.publicKey, tenantKeyPass, u1, u1Pass, u1KeyBag);
    const tenantKey = t1.getTenantEncryptionKey();
    
    // Register all 3 users in the directory
    const dir1 = await t1.openDirectory();
    await dir1.registerUser(f1.toPublicUserId(u1), adminKeyPair.privateKey, adminPass);
    await dir1.registerUser(f2.toPublicUserId(u2), adminKeyPair.privateKey, adminPass);
    await dir1.registerUser(f3.toPublicUserId(u3), adminKeyPair.privateKey, adminPass);
    
    // User1 creates a named symmetric key (shared only with User3, NOT User2)
    const namedKeyId = "secret-project-key";
    const namedKeyPassword = "secretkeypass";
    const namedEncryptedKey = await f1.createSymmetricEncryptedPrivateKey(namedKeyPassword);
    
    // Import the key into User1's KeyBag
    await u1KeyBag.decryptAndImportKey(namedKeyId, namedEncryptedKey, namedKeyPassword);
    
    // Import the key into User3's KeyBag (User3 has the key, User2 does NOT)
    await u3KeyBag.decryptAndImportKey(namedKeyId, namedEncryptedKey, namedKeyPassword);
    
    // User1 creates an encrypted document with the named key
    const secretDB1 = await t1.openDB("secrets");
    const secretDoc = await secretDB1.createEncryptedDocument(namedKeyId);
    const secretDocId = secretDoc.getId();
    
    await secretDB1.changeDoc(secretDoc, async (doc) => {
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
    const t2 = await f2.openTenantWithKeys(tid, tenantKey, tenantKeyPass, adminKeyPair.publicKey, adminEncKeyPair.publicKey, u2, u2Pass, u2KeyBag);
    const dir2 = await t2.openDB("directory");
    const secretDB2 = await t2.openDB("secrets");
    
    // User2 syncs directory from User1
    const dirStore1 = (await t1.openDB("directory")).getStore();
    await dir2.pullChangesFrom(dirStore1);
    
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
    const t3 = await f3.openTenantWithKeys(tid, tenantKey, tenantKeyPass, adminKeyPair.publicKey, adminEncKeyPair.publicKey, u3, u3Pass, u3KeyBag);
    const dir3 = await t3.openDB("directory");
    const secretDB3 = await t3.openDB("secrets");
    
    // User3 syncs directory from User2
    await dir3.pullChangesFrom(dir2.getStore());
    
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
    await secretDB3.changeDoc(secretDoc3, async (doc) => {
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
});

