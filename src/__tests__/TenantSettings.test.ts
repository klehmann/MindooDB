import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDoc, SigningKeyPair } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Tenant and DB Settings", () => {
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
    
    // Create admin signing key pair (administration key)
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
    
    // Create tenant
    tenantId = "test-tenant-settings";
    tenant = await factory.openTenantWithKeys(
      tenantId,
      tenantEncryptionKey,
      tenantEncryptionKeyPassword,
      adminSigningKeyPair.publicKey,
      adminUser,
      adminUserPassword,
      adminKeyBag
    );
    
    // Register the admin user in the directory so their key is trusted
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
    );
  }, 30000);

  describe("Tenant Settings", () => {
    it("should return null when no tenant settings exist", async () => {
      const directory = await tenant.openDirectory();
      const settings = await directory.getTenantSettings();
      
      expect(settings).toBeNull();
    });

    it("should create new tenant settings document", async () => {
      const directory = await tenant.openDirectory();
      
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 100 * 1024 * 1024; // 100MB
          data.maxTotalAttachmentSize = 10 * 1024 * 1024 * 1024; // 10GB
          data.tokenExpirationMinutes = 15;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const settings = await directory.getTenantSettings();
      expect(settings).not.toBeNull();
      
      const data = settings!.getData();
      expect(data.form).toBe("tenantsettings");
      expect(data.maxAttachmentSizePerFile).toBe(100 * 1024 * 1024);
      expect(data.maxTotalAttachmentSize).toBe(10 * 1024 * 1024 * 1024);
      expect(data.tokenExpirationMinutes).toBe(15);
    });

    it("should update existing tenant settings", async () => {
      const directory = await tenant.openDirectory();
      
      // Create initial settings
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 50 * 1024 * 1024; // 50MB
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const firstSettings = await directory.getTenantSettings();
      const firstDocId = firstSettings!.getId();
      
      // Update settings
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 200 * 1024 * 1024; // 200MB
          data.maxTotalAttachmentSize = 20 * 1024 * 1024 * 1024; // 20GB
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const updatedSettings = await directory.getTenantSettings();
      expect(updatedSettings).not.toBeNull();
      expect(updatedSettings!.getId()).toBe(firstDocId); // Same document
      
      const data = updatedSettings!.getData();
      expect(data.form).toBe("tenantsettings");
      expect(data.maxAttachmentSizePerFile).toBe(200 * 1024 * 1024);
      expect(data.maxTotalAttachmentSize).toBe(20 * 1024 * 1024 * 1024);
    });

    it("should always set form field to tenantsettings", async () => {
      const directory = await tenant.openDirectory();
      
      // Try to change form field in callback
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.form = "wrongform"; // Try to change it
          data.maxAttachmentSizePerFile = 100 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const settings = await directory.getTenantSettings();
      const data = settings!.getData();
      
      // Form should be overwritten to "tenantsettings"
      expect(data.form).toBe("tenantsettings");
      expect(data.maxAttachmentSizePerFile).toBe(100 * 1024 * 1024);
    });

    it("should cache tenant settings", async () => {
      const directory = await tenant.openDirectory();
      
      // Create settings
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 100 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get settings multiple times - should use cache
      const settings1 = await directory.getTenantSettings();
      const settings2 = await directory.getTenantSettings();
      
      expect(settings1).toBe(settings2); // Same object reference (cached)
      expect(settings1!.getId()).toBe(settings2!.getId());
    });
  });

  describe("DB Settings", () => {
    const testDbId = "test-db-1";

    it("should return null when no DB settings exist", async () => {
      const directory = await tenant.openDirectory();
      const settings = await directory.getDBSettings(testDbId);
      
      expect(settings).toBeNull();
    });

    it("should create new DB settings document", async () => {
      const directory = await tenant.openDirectory();
      
      await directory.changeDBSettings(
        testDbId,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxDocumentSize = 5 * 1024 * 1024; // 5MB
          data.maxDocuments = 10000;
          data.maxChangesPerDocument = 100000;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const settings = await directory.getDBSettings(testDbId);
      expect(settings).not.toBeNull();
      
      const data = settings!.getData();
      expect(data.form).toBe("dbsettings");
      expect(data.dbid).toBe(testDbId);
      expect(data.maxDocumentSize).toBe(5 * 1024 * 1024);
      expect(data.maxDocuments).toBe(10000);
      expect(data.maxChangesPerDocument).toBe(100000);
    });

    it("should update existing DB settings", async () => {
      const directory = await tenant.openDirectory();
      
      // Create initial settings
      await directory.changeDBSettings(
        testDbId,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxDocumentSize = 1 * 1024 * 1024; // 1MB
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const firstSettings = await directory.getDBSettings(testDbId);
      const firstDocId = firstSettings!.getId();
      
      // Update settings
      await directory.changeDBSettings(
        testDbId,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxDocumentSize = 10 * 1024 * 1024; // 10MB
          data.maxDocuments = 50000;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const updatedSettings = await directory.getDBSettings(testDbId);
      expect(updatedSettings).not.toBeNull();
      expect(updatedSettings!.getId()).toBe(firstDocId); // Same document
      
      const data = updatedSettings!.getData();
      expect(data.form).toBe("dbsettings");
      expect(data.dbid).toBe(testDbId);
      expect(data.maxDocumentSize).toBe(10 * 1024 * 1024);
      expect(data.maxDocuments).toBe(50000);
    });

    it("should always set form and dbid fields correctly", async () => {
      const directory = await tenant.openDirectory();
      
      // Try to change form and dbid fields in callback
      await directory.changeDBSettings(
        testDbId,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.form = "wrongform"; // Try to change it
          data.dbid = "wrong-db-id"; // Try to change it
          data.maxDocumentSize = 5 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const settings = await directory.getDBSettings(testDbId);
      const data = settings!.getData();
      
      // Form and dbid should be overwritten to correct values
      expect(data.form).toBe("dbsettings");
      expect(data.dbid).toBe(testDbId);
      expect(data.maxDocumentSize).toBe(5 * 1024 * 1024);
    });

    it("should support multiple DB settings for different databases", async () => {
      const directory = await tenant.openDirectory();
      const dbId1 = "db-1";
      const dbId2 = "db-2";
      
      // Create settings for first DB
      await directory.changeDBSettings(
        dbId1,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxDocumentSize = 1 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Create settings for second DB
      await directory.changeDBSettings(
        dbId2,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxDocumentSize = 2 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const settings1 = await directory.getDBSettings(dbId1);
      const settings2 = await directory.getDBSettings(dbId2);
      
      expect(settings1).not.toBeNull();
      expect(settings2).not.toBeNull();
      expect(settings1!.getId()).not.toBe(settings2!.getId()); // Different documents
      
      expect(settings1!.getData().dbid).toBe(dbId1);
      expect(settings2!.getData().dbid).toBe(dbId2);
      expect(settings1!.getData().maxDocumentSize).toBe(1 * 1024 * 1024);
      expect(settings2!.getData().maxDocumentSize).toBe(2 * 1024 * 1024);
    });

    it("should cache DB settings", async () => {
      const directory = await tenant.openDirectory();
      
      // Create settings
      await directory.changeDBSettings(
        testDbId,
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxDocumentSize = 5 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get settings multiple times - should use cache
      const settings1 = await directory.getDBSettings(testDbId);
      const settings2 = await directory.getDBSettings(testDbId);
      
      expect(settings1).toBe(settings2); // Same object reference (cached)
      expect(settings1!.getId()).toBe(settings2!.getId());
    });
  });

  describe("Settings Sync and Cache Invalidation", () => {
    it("should update cache when directory changes are synced", async () => {
      const directory = await tenant.openDirectory();
      
      // Create settings
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 100 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get settings (populates cache)
      const settings1 = await directory.getTenantSettings();
      expect(settings1).not.toBeNull();
      
      // Update settings from another "client" perspective
      // (simulate by directly modifying through directory)
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 200 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get settings again - should reflect updated value
      const settings2 = await directory.getTenantSettings();
      expect(settings2).not.toBeNull();
      expect(settings2!.getData().maxAttachmentSizePerFile).toBe(200 * 1024 * 1024);
    });

    it("should handle Automerge merging of concurrent settings changes", async () => {
      const directory = await tenant.openDirectory();
      
      // Create initial settings
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 100 * 1024 * 1024;
          data.maxTotalAttachmentSize = 10 * 1024 * 1024 * 1024;
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const settingsDoc = await directory.getTenantSettings();
      expect(settingsDoc).not.toBeNull();
      
      // Simulate concurrent changes by making two updates
      // (In real scenario, these would come from different clients)
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.maxAttachmentSizePerFile = 150 * 1024 * 1024; // Update field 1
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.changeTenantSettings(
        async (doc: MindooDoc) => {
          const data = doc.getData();
          data.tokenExpirationMinutes = 30; // Update different field
        },
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Both changes should be merged
      const finalSettings = await directory.getTenantSettings();
      const data = finalSettings!.getData();
      expect(data.maxAttachmentSizePerFile).toBe(150 * 1024 * 1024);
      expect(data.maxTotalAttachmentSize).toBe(10 * 1024 * 1024 * 1024);
      expect(data.tokenExpirationMinutes).toBe(30);
    });
  });
});
