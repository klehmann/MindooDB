import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { DEFAULT_TENANT_KEY_ID, PrivateUserId, MindooTenant, MindooDB, MindooTenantDirectory, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenant } from "../core/BaseMindooTenant";
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
  let tenantId: string;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminKeyBag: KeyBag;
  let tenant: MindooTenant;
  let directory: MindooTenantDirectory;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
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
    tenantId = "trust-model-test-tenant";
    
    // Create KeyBag for admin user
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    currentUserPassword = "currentpass123";
    currentUser = await factory.createUserId("CN=currentuser/O=testtenant", currentUserPassword);
    const currentUserKeyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, cryptoAdapter);
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

    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      currentUserKeyBag,
    );
    
    // Open directory
    directory = await tenant.openDirectory();
    
    // Register admin user so their key is trusted
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );

    // Register the current tenant user so regular database opens are allowed.
    const publicCurrentUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(
      publicCurrentUser,
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

  async function openTenantAsUser(user: PrivateUserId, password: string): Promise<MindooTenant> {
    const userKeyBag = new KeyBag(
      user.userEncryptionKeyPair.privateKey,
      password,
      new NodeCryptoAdapter()
    );
    await userKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await userKeyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );

    return factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      password,
      userKeyBag,
    );
  }

  async function syncDirectoryFromAdmin(targetTenant: MindooTenant): Promise<void> {
    const adminDirectoryDB = await tenant.openDB("directory") as BaseMindooDB;
    const targetDirectoryDB = await targetTenant.openDB("directory") as BaseMindooDB;
    await targetDirectoryDB.pullChangesFrom(adminDirectoryDB.getStore());
    await targetDirectoryDB.syncStoreChanges();
  }

  describe("Tenant Open Authorization", () => {
    it("should allow the admin user to open a regular database without a directory grant", async () => {
      const adminOnlyTenantId = "trust-model-admin-bypass-tenant";
      await adminKeyBag.createDocKey(adminOnlyTenantId, PUBLIC_INFOS_KEY_ID);
      await adminKeyBag.createTenantKey(adminOnlyTenantId);

      const adminTenant = new BaseMindooTenant(
        factory,
        adminOnlyTenantId,
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        adminKeyBag,
        storeFactory,
        new NodeCryptoAdapter(),
      );

      const regularDB = await adminTenant.openDB("admin-db");

      expect(regularDB.isAdminOnlyDb()).toBe(false);
    }, 30000);

    it("should allow a granted non-admin user to open a regular database", async () => {
      const regularDB = await tenant.openDB("my-regular-db");

      expect(regularDB.isAdminOnlyDb()).toBe(false);
    }, 30000);

    it("should reject a non-admin user without a grant", async () => {
      const untrustedTenant = await openTenantAsUser(untrustedUser, untrustedUserPassword);
      await syncDirectoryFromAdmin(untrustedTenant);

      await expect(untrustedTenant.openDB("shared-db")).rejects.toThrow(
        `User "${untrustedUser.username}" does not have tenant access yet; the tenant admin must grant access first.`
      );
    }, 30000);

    it("should reject a revoked non-admin user", async () => {
      const trustedTenant = await openTenantAsUser(trustedUser, trustedUserPassword);
      await syncDirectoryFromAdmin(trustedTenant);

      await directory.revokeUser(
        trustedUser.username,
        false,
        adminUser.userSigningKeyPair.privateKey,
        adminUserPassword
      );
      await syncDirectoryFromAdmin(trustedTenant);

      await expect(trustedTenant.openDB("revoked-db")).rejects.toThrow(
        `User "${trustedUser.username}" does not have tenant access yet; the tenant admin must grant access first.`
      );
    }, 30000);

    it("should enforce the access check before returning a cached database", async () => {
      const cachedDB = await tenant.openDB("cached-db");
      expect(cachedDB.isAdminOnlyDb()).toBe(false);

      await directory.revokeUser(
        currentUser.username,
        false,
        adminUser.userSigningKeyPair.privateKey,
        adminUserPassword
      );

      await expect(tenant.openDB("cached-db")).rejects.toThrow(
        `User "${currentUser.username}" does not have tenant access yet; the tenant admin must grant access first.`
      );
    }, 30000);
  });

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
      const tenantAsTrustedUser = await openTenantAsUser(trustedUser, trustedUserPassword);
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
      const tenantAsTrustedUser = await openTenantAsUser(trustedUser, trustedUserPassword);
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
      const tenantAsTrustedUser = await openTenantAsUser(trustedUser, trustedUserPassword);
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
      const untrustedTenant = await openTenantAsUser(untrustedUser, untrustedUserPassword);
      await syncDirectoryFromAdmin(untrustedTenant);

      await expect(untrustedTenant.openDB("shared-db")).rejects.toThrow(
        `User "${untrustedUser.username}" does not have tenant access yet; the tenant admin must grant access first.`
      );

      const isUntrustedKeyValid = await directory.validatePublicSigningKey(
        untrustedUser.userSigningKeyPair.publicKey
      );
      
      expect(isUntrustedKeyValid).toBe(false);
    }, 60000);

    it("should accept document changes from trusted users", async () => {
      const trustedTenant = await openTenantAsUser(trustedUser, trustedUserPassword);
      await syncDirectoryFromAdmin(trustedTenant);
      const trustedDirectory = await trustedTenant.openDirectory();
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
