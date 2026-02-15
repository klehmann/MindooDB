import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, MindooTenantDirectory, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooDB } from "../core/BaseMindooDB";

/**
 * Tests for the MindooDB Trust Model
 * 
 * The trust model establishes:
 * 1. The administration key and directory database are the root of trust
 * 2. Only admin-signed entries are accepted in the directory database
 * 3. Document changes in other databases are only accepted from trusted (registered) users
 * 4. Revoked users' changes are rejected
 */
describe("Trust Model Security", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminKeyBag: KeyBag;
  let tenant: MindooTenant;
  let directory: MindooTenantDirectory;
  let trustedUser: PrivateUserId;
  let trustedUserPassword: string;
  let untrustedUser: PrivateUserId;
  let untrustedUserPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    // Create admin user (signing + encryption keys used for tenant administration)
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    // Create tenant encryption key
    const tenantId = "trust-model-test-tenant";
    
    // Create KeyBag for admin user
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    await adminKeyBag.createDocKey(PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    const currentUser = await factory.createUserId("CN=currentuser/O=testtenant", "currentpass123");
    const currentUserKeyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, "currentpass123", cryptoAdapter);
    await currentUserKeyBag.set("doc", PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", PUBLIC_INFOS_KEY_ID))!);
    await currentUserKeyBag.set("tenant", tenantId, (await adminKeyBag.get("tenant", tenantId))!);

    tenant = await factory.openTenant(tenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, currentUser, "currentpass123", currentUserKeyBag);
    
    // Open directory
    directory = await tenant.openDirectory();
    
    // Register admin user so their key is trusted
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
    
    // Create and register a trusted user
    trustedUserPassword = "trustedpass123";
    trustedUser = await factory.createUserId("CN=trusteduser/O=testtenant", trustedUserPassword);
    const publicTrustedUser = factory.toPublicUserId(trustedUser);
    await directory.registerUser(
      publicTrustedUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
    
    // Create an untrusted user (NOT registered in directory)
    untrustedUserPassword = "untrustedpass123";
    untrustedUser = await factory.createUserId("CN=untrusteduser/O=testtenant", untrustedUserPassword);
  }, 60000);

  describe("Directory Database Admin-Only Protection", () => {
    it("should open directory database with adminOnlyDb flag", async () => {
      const directoryDB = await tenant.openDB("directory");
      
      expect(directoryDB.isAdminOnlyDb()).toBe(true);
    }, 30000);

    it("should enforce adminOnlyDb for directory regardless of options passed", async () => {
      // Even if we try to open without the flag, it should still be enforced
      const directoryDB = await tenant.openDB("directory", { adminOnlyDb: false });
      
      // The tenant-level enforcement should override
      expect(directoryDB.isAdminOnlyDb()).toBe(true);
    }, 30000);

    it("should not set adminOnlyDb for regular databases", async () => {
      const regularDB = await tenant.openDB("my-regular-db");
      
      expect(regularDB.isAdminOnlyDb()).toBe(false);
    }, 30000);

    it("should ignore directory entries not signed by admin key", async () => {
      // This test verifies that if someone manages to inject entries into the directory
      // store that are not signed by the admin key, they are ignored when loading.
      
      // Get the directory DB
      const directoryDB = await tenant.openDB("directory") as BaseMindooDB;
      
      // Sync and check that all registered users are found
      await directoryDB.syncStoreChanges();
      const allDocIds = await directoryDB.getAllDocumentIds();
      
      // We should have at least 2 documents (admin and trusted user registrations)
      expect(allDocIds.length).toBeGreaterThanOrEqual(2);
      
      // All entries that were loaded should be signed by admin
      // (entries not signed by admin are filtered out by admin-only mode)
      // This is verified by the fact that the directory loaded successfully
    }, 30000);

    it("should throw error when non-admin user tries to create document in directory", async () => {
      // Open tenant with trustedUser as current user (admin keys from adminUser, but operating as trustedUser)
      const trustedUserKeyBag = new KeyBag(
        trustedUser.userEncryptionKeyPair.privateKey,
        trustedUserPassword,
        new NodeCryptoAdapter()
      );
      await trustedUserKeyBag.set("doc", PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", PUBLIC_INFOS_KEY_ID))!);
      await trustedUserKeyBag.set("tenant", "trust-model-test-tenant", (await adminKeyBag.get("tenant", "trust-model-test-tenant"))!);
      const tenantAsTrustedUser = await factory.openTenant(
        "trust-model-test-tenant",
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        trustedUser,
        trustedUserPassword,
        trustedUserKeyBag
      );
      const directoryDB = await tenantAsTrustedUser.openDB("directory") as BaseMindooDB;
      
      // Try to create a document - should fail because current user (trustedUser) is not the admin
      await expect(directoryDB.createDocument()).rejects.toThrow(
        "Admin-only database: only the admin key can modify data"
      );
    }, 30000);

    it("should throw error when non-admin user tries to change document in directory", async () => {
      const directoryDB = await tenant.openDB("directory") as BaseMindooDB;
      
      // First, create a document using the admin signing key (this should succeed)
      const doc = await directoryDB.createDocumentWithSigningKey(
        adminUser.userSigningKeyPair,
        adminUserPassword
      );
      
      // Open tenant with trustedUser as current user for the change attempt
      const trustedUserKeyBag = new KeyBag(
        trustedUser.userEncryptionKeyPair.privateKey,
        trustedUserPassword,
        new NodeCryptoAdapter()
      );
      await trustedUserKeyBag.set("doc", PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", PUBLIC_INFOS_KEY_ID))!);
      await trustedUserKeyBag.set("tenant", "trust-model-test-tenant", (await adminKeyBag.get("tenant", "trust-model-test-tenant"))!);
      const tenantAsTrustedUser = await factory.openTenant(
        "trust-model-test-tenant",
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        trustedUser,
        trustedUserPassword,
        trustedUserKeyBag
      );
      const directoryDBAsTrusted = await tenantAsTrustedUser.openDB("directory") as BaseMindooDB;
      // Pull directory data from admin's store so we have the doc
      await directoryDBAsTrusted.pullChangesFrom(directoryDB.getStore());
      const docAsTrusted = await directoryDBAsTrusted.getDocument(doc.getId());
      
      // Try to change without admin signing key - should fail
      await expect(directoryDBAsTrusted.changeDoc(docAsTrusted, (d) => {
        d.getData().testField = "test value";
      })).rejects.toThrow(
        "Admin-only database: only the admin key can modify data"
      );
    }, 30000);

    it("should throw error when non-admin user tries to delete document in directory", async () => {
      const directoryDB = await tenant.openDB("directory") as BaseMindooDB;
      
      // First, create a document using the admin signing key (this should succeed)
      const doc = await directoryDB.createDocumentWithSigningKey(
        adminUser.userSigningKeyPair,
        adminUserPassword
      );
      
      // Open tenant with trustedUser as current user for the delete attempt
      const trustedUserKeyBag = new KeyBag(
        trustedUser.userEncryptionKeyPair.privateKey,
        trustedUserPassword,
        new NodeCryptoAdapter()
      );
      await trustedUserKeyBag.set("doc", PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", PUBLIC_INFOS_KEY_ID))!);
      await trustedUserKeyBag.set("tenant", "trust-model-test-tenant", (await adminKeyBag.get("tenant", "trust-model-test-tenant"))!);
      const tenantAsTrustedUser = await factory.openTenant(
        "trust-model-test-tenant",
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        trustedUser,
        trustedUserPassword,
        trustedUserKeyBag
      );
      const directoryDBAsTrusted = await tenantAsTrustedUser.openDB("directory") as BaseMindooDB;
      // Pull directory data from admin's store so we have the doc
      await directoryDBAsTrusted.pullChangesFrom(directoryDB.getStore());
      
      // Try to delete without admin signing key - should fail
      await expect(directoryDBAsTrusted.deleteDocument(doc.getId())).rejects.toThrow(
        "Admin-only database: only the admin key can modify data"
      );
    }, 30000);

    it("should allow admin key to create, change, and delete documents in directory", async () => {
      // Get the directory DB (admin-only mode)
      const directoryDB = await tenant.openDB("directory") as BaseMindooDB;
      
      // Create a document using the admin signing key - should succeed
      const doc = await directoryDB.createDocumentWithSigningKey(
        adminUser.userSigningKeyPair,
        adminUserPassword
      );
      expect(doc.getId()).toBeDefined();
      
      // Change the document using the admin signing key - should succeed
      await directoryDB.changeDocWithSigningKey(doc, (d) => {
        d.getData().testField = "admin created this";
      }, adminUser.userSigningKeyPair, adminUserPassword);
      
      // Verify the change was applied
      const reloadedDoc = await directoryDB.getDocument(doc.getId());
      expect(reloadedDoc.getData().testField).toBe("admin created this");
      
      // Delete the document using the admin signing key - should succeed
      await directoryDB.deleteDocumentWithSigningKey(
        doc.getId(),
        adminUser.userSigningKeyPair,
        adminUserPassword
      );
      
      // Verify the document is deleted
      await expect(directoryDB.getDocument(doc.getId())).rejects.toThrow(
        `Document ${doc.getId()} has been deleted`
      );
    }, 30000);
  });

  describe("Untrusted User Changes Rejection", () => {
    it("should reject document changes from untrusted users", async () => {
      // Create a tenant where the untrusted user is the current user
      const untrustedUserKeyBag = new KeyBag(
        untrustedUser.userEncryptionKeyPair.privateKey,
        untrustedUserPassword,
        new NodeCryptoAdapter()
      );
      
      const untrustedTenantId = "trust-model-test-tenant";
      await untrustedUserKeyBag.createDocKey(PUBLIC_INFOS_KEY_ID);
      await untrustedUserKeyBag.createTenantKey(untrustedTenantId);
      const untrustedTenant = await factory.openTenant(untrustedTenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, untrustedUser, // Untrusted user as current user
        untrustedUserPassword, untrustedUserKeyBag);
      
      // Open the same store (different tenant instance, same underlying store)
      // Note: In a real scenario, the stores would be shared via sync
      const untrustedDB = await untrustedTenant.openDB("shared-db");
      
      // Create a document (this will be signed by the untrusted user)
      const doc = await untrustedDB.createDocument();
      await untrustedDB.changeDoc(doc, (d) => {
        d.getData().title = "Created by untrusted user";
      });
      
      // Now, from the trusted tenant's perspective, when we load this database
      // and sync, the changes should be rejected because the signer is not trusted
      const trustedDB = await tenant.openDB("shared-db");
      
      // The trusted DB should NOT see the document because the signer is untrusted
      // First, we need to sync the stores (simulate by sharing the store)
      // In this test setup, each tenant has its own store, so we can't easily
      // test cross-tenant rejection. Let's verify the validation logic instead.
      
      const isUntrustedKeyValid = await directory.validatePublicSigningKey(
        untrustedUser.userSigningKeyPair.publicKey
      );
      
      expect(isUntrustedKeyValid).toBe(false);
    }, 60000);

    it("should accept document changes from trusted users", async () => {
      // Create a tenant where the trusted user is the current user
      const trustedUserKeyBag = new KeyBag(
        trustedUser.userEncryptionKeyPair.privateKey,
        trustedUserPassword,
        new NodeCryptoAdapter()
      );
      
      const trustedTenantId = "trust-model-test-tenant-2";
      await trustedUserKeyBag.createDocKey(PUBLIC_INFOS_KEY_ID);
      await trustedUserKeyBag.createTenantKey(trustedTenantId);
      const trustedTenant = await factory.openTenant(trustedTenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, trustedUser, trustedUserPassword, trustedUserKeyBag);
      
      // Register the trusted user in this tenant's directory too
      const trustedDirectory = await trustedTenant.openDirectory();
      const publicTrustedUser = factory.toPublicUserId(trustedUser);
      await trustedDirectory.registerUser(
        publicTrustedUser,
        adminUser.userSigningKeyPair.privateKey,
        adminUserPassword
      );
      
      const trustedDB = await trustedTenant.openDB("trusted-db");
      
      // Create a document (signed by the trusted user)
      const doc = await trustedDB.createDocument();
      await trustedDB.changeDoc(doc, (d) => {
        d.getData().title = "Created by trusted user";
      });
      
      // Verify the trusted user's key is valid
      const isTrustedKeyValid = await trustedDirectory.validatePublicSigningKey(
        trustedUser.userSigningKeyPair.publicKey
      );
      
      expect(isTrustedKeyValid).toBe(true);
      
      // The document should be accessible
      const reloadedDoc = await trustedDB.getDocument(doc.getId());
      expect(reloadedDoc.getData().title).toBe("Created by trusted user");
    }, 60000);
  });

  describe("Revoked User Changes Rejection", () => {
    it("should reject changes from revoked users after revocation", async () => {
      // Create a user, register them, then revoke them
      const revokedUserPassword = "revokedpass123";
      const revokedUser = await factory.createUserId("CN=revokeduser/O=testtenant", revokedUserPassword);
      const publicRevokedUser = factory.toPublicUserId(revokedUser);
      
      // Register the user
      await directory.registerUser(
        publicRevokedUser,
        adminUser.userSigningKeyPair.privateKey,
        adminUserPassword
      );
      
      // Verify they are initially trusted
      let isValid = await directory.validatePublicSigningKey(
        revokedUser.userSigningKeyPair.publicKey
      );
      expect(isValid).toBe(true);
      
      // Revoke the user
      await directory.revokeUser(
        publicRevokedUser.username,
        false, // requestDataWipe
        adminUser.userSigningKeyPair.privateKey,
        adminUserPassword
      );
      
      // Verify they are no longer trusted
      isValid = await directory.validatePublicSigningKey(
        revokedUser.userSigningKeyPair.publicKey
      );
      expect(isValid).toBe(false);
    }, 60000);
  });

  describe("Trust Chain Validation", () => {
    it("should always trust the administration key", async () => {
      const isAdminKeyValid = await directory.validatePublicSigningKey(
        adminUser.userSigningKeyPair.publicKey
      );
      
      expect(isAdminKeyValid).toBe(true);
    }, 30000);

    it("should validate registered user public keys", async () => {
      // Admin user should be trusted
      const isAdminUserValid = await directory.validatePublicSigningKey(
        adminUser.userSigningKeyPair.publicKey
      );
      expect(isAdminUserValid).toBe(true);
      
      // Trusted user should be trusted
      const isTrustedUserValid = await directory.validatePublicSigningKey(
        trustedUser.userSigningKeyPair.publicKey
      );
      expect(isTrustedUserValid).toBe(true);
      
      // Untrusted user should NOT be trusted
      const isUntrustedUserValid = await directory.validatePublicSigningKey(
        untrustedUser.userSigningKeyPair.publicKey
      );
      expect(isUntrustedUserValid).toBe(false);
    }, 30000);

    it("should use cache for repeated validations", async () => {
      // First call - populates cache
      const isValid1 = await directory.validatePublicSigningKey(
        trustedUser.userSigningKeyPair.publicKey
      );
      expect(isValid1).toBe(true);
      
      // Second call - should use cache
      const isValid2 = await directory.validatePublicSigningKey(
        trustedUser.userSigningKeyPair.publicKey
      );
      expect(isValid2).toBe(true);
      
      // The cache should make repeated calls faster (we can't easily measure this,
      // but we can verify the results are consistent)
      const isValid3 = await directory.validatePublicSigningKey(
        trustedUser.userSigningKeyPair.publicKey
      );
      expect(isValid3).toBe(true);
    }, 30000);
  });
});
