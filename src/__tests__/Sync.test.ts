import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, SigningKeyPair, ContentAddressedStoreFactory, ContentAddressedStore, EncryptedPrivateKey } from "../core/types";
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
    
    // Create tenant encryption key (store it so user2 can use the same one)
    tenantEncryptionKeyPassword = "tenantkeypass123";
    
    // Create tenant for user1 using factory1
    tenantId = "test-tenant-sync";
    tenant1 = await factory1.createTenant(tenantId,
      adminSigningKeyPair.publicKey,
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
    // User2 needs the same tenant encryption key and admin public key (reuse the one from beforeEach)
    // User2 uses factory2 which has its own separate store factory
    tenant2 = await factory2.openTenantWithKeys(
      tenantId,
      tenantEncryptionKey,
      tenantEncryptionKeyPassword,
      adminSigningKeyPair.publicKey,
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
});

