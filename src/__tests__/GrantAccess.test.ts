import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDoc, ProcessChangesCursor, SigningKeyPair } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("granting tenant access", () => {
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
  let regularUser: PrivateUserId;
  let regularUserPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    // Create admin user
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    // Create admin signing key pair (this is the "admin signing id")
    adminSigningKeyPassword = "adminsigningpass123";
    adminSigningKeyPair = await factory.createSigningKeyPair(adminSigningKeyPassword);
    
    // Create tenant encryption key
    tenantEncryptionKeyPassword = "tenantkeypass123";
    const tenantEncryptionKey = await factory.createSymmetricEncryptedPrivateKey(tenantEncryptionKeyPassword);
    
    // Create KeyBag for admin user
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    // Create tenant using openTenantWithKeys with our admin signing key as the administration key
    tenantId = "test-tenant-process-changes";
    tenant = await factory.openTenantWithKeys(
      tenantId,
      tenantEncryptionKey,
      tenantEncryptionKeyPassword,
      adminSigningKeyPair.publicKey, // Use admin signing key as administration public key
      adminUser,
      adminUserPassword,
      adminKeyBag
    );
    
    // Create regular user
    regularUserPassword = "regularpass123";
    regularUser = await factory.createUserId("CN=regularuser/O=testtenant", regularUserPassword);
    
    // Register the admin user in the directory so their key is trusted when verifying signatures
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
    );
  }, 30000); // Increase timeout for crypto operations

  it("should find the document where access was granted using processChangesSince", async () => {
    // Grant access to the regular user (register them)
    const directory = await tenant.openDirectory();
    const publicRegularUser = factory.toPublicUserId(regularUser);
    
    await directory.registerUser(
      publicRegularUser,
      adminSigningKeyPair.privateKey, // Use admin signing key as administration private key
      adminSigningKeyPassword
    );
    
    // Get the directory database
    const directoryDB = await tenant.openDB("directory");
    
    // Sync changes to make sure everything is processed
    await directoryDB.syncStoreChanges();
    
    // Use generator-based iterateChangesSince to find documents
    const initialCursor: ProcessChangesCursor | null = null;
    const foundDocuments: Array<{ doc: MindooDoc; cursor: ProcessChangesCursor }> = [];
    
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(initialCursor, 100)) {
      foundDocuments.push({ doc, cursor });
    }
    
    // Verify we found at least one document
    expect(foundDocuments.length).toBeGreaterThan(0);
    
    // Find the document where access was granted
    const accessGrantDoc = foundDocuments.find(({ doc }) => {
      const data = doc.getData();
      return data.form === "useroperation" && 
             data.type === "grantaccess" && 
             data.username === regularUser.username;
    });
    
    // Verify we found the access grant document
    expect(accessGrantDoc).toBeDefined();
    expect(accessGrantDoc!.doc).toBeDefined();
    
    // Verify the document content
    const docData = accessGrantDoc!.doc.getData();
    expect(docData.form).toBe("useroperation");
    expect(docData.type).toBe("grantaccess");
    expect(docData.username).toBe(regularUser.username);
    expect(docData.userSigningPublicKey).toBe(regularUser.userSigningKeyPair.publicKey);
    expect(docData.userEncryptionPublicKey).toBe(regularUser.userEncryptionKeyPair.publicKey);
    
    // Note: Admin signature verification is now done at entry level via adminOnlyDb flag
    // The directory database only accepts entries signed by the administration key.
    // This means if the document exists, it was signed by the admin - no need for
    // document-level adminSignature fields.
    
    // Verify the document ID and timestamps
    expect(accessGrantDoc!.doc.getId()).toBeDefined();
    expect(accessGrantDoc!.doc.getCreatedAt()).toBeGreaterThan(0);
    expect(accessGrantDoc!.doc.getLastModified()).toBeGreaterThan(0);
    expect(accessGrantDoc!.doc.isDeleted()).toBe(false);
    
    console.log(`Found access grant document: ${accessGrantDoc!.doc.getId()}`);
    console.log(`Document created at: ${new Date(accessGrantDoc!.doc.getCreatedAt()).toISOString()}`);
    console.log(`Document last modified at: ${new Date(accessGrantDoc!.doc.getLastModified()).toISOString()}`);
  });
});


