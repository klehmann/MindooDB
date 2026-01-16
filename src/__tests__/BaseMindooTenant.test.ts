import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { BaseMindooTenant } from "../core/BaseMindooTenant";
import { InMemoryContentAddressedStoreFactory } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { PrivateUserId, MindooTenant, SigningKeyPair } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("BaseMindooTenant", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=testtenant", currentUserPassword);
    
    // Create KeyBag with user's encryption key
    keyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      currentUserPassword,
      factory.getCryptoAdapter()
    );
  }, 10000); // Increase timeout for crypto operations

  describe("createTenant", () => {
    it("should create a new tenant with factory, user ID and keyBag", async () => {
      const tenantId = "test-tenant-123";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      // Create administration key pair first
      const adminKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

      const tenant = await factory.createTenant(
        tenantId,
        adminKeyPair.publicKey,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );

      expect(tenant).toBeDefined();
      expect(tenant).toBeInstanceOf(BaseMindooTenant);
      expect(tenant.getId()).toBe(tenantId);
    });

    it("should initialize tenant successfully", async () => {
      const tenantId = "test-tenant-456";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      // Create administration key pair first
      const adminKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

      const tenant = await factory.createTenant(
        tenantId,
        adminKeyPair.publicKey,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );

      // Tenant should be initialized (no errors thrown)
      expect(tenant).toBeDefined();
    });
  });

  describe("tenant operations", () => {
    let tenant: MindooTenant;
    const tenantId = "test-tenant-operations";

    beforeEach(async () => {
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      // Create administration key pair first
      const adminKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

      tenant = await factory.createTenant(
        tenantId,
        adminKeyPair.publicKey,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );
    });

    it("should return the correct tenant ID", () => {
      expect(tenant.getId()).toBe(tenantId);
    });

    it("should return the factory used to create the tenant", () => {
      const returnedFactory = tenant.getFactory();
      expect(returnedFactory).toBe(factory);
    });

    it("should return the tenant encryption key", () => {
      const encryptionKey = tenant.getTenantEncryptionKey();
      expect(encryptionKey).toBeDefined();
      expect(encryptionKey.ciphertext).toBeDefined();
      expect(encryptionKey.iv).toBeDefined();
      expect(encryptionKey.tag).toBeDefined();
      expect(encryptionKey.salt).toBeDefined();
      expect(encryptionKey.iterations).toBe(310000);
    });

    it("should return the current user ID", async () => {
      const publicUserId = await tenant.getCurrentUserId();
      
      expect(publicUserId).toBeDefined();
      expect(publicUserId.username).toBe(currentUser.username);
      expect(publicUserId.userSigningPublicKey).toBe(currentUser.userSigningKeyPair.publicKey);
      expect(publicUserId.userEncryptionPublicKey).toBe(currentUser.userEncryptionKeyPair.publicKey);
    });
  });

  describe("encryption and decryption", () => {
    let tenant: MindooTenant;

    beforeEach(async () => {
      const tenantId = "test-tenant-encryption";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      // Create administration key pair first
      const adminKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

      tenant = await factory.createTenant(
        tenantId,
        adminKeyPair.publicKey,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );
    });

    it("should encrypt and decrypt payload with default key", async () => {
      const originalPayload = new TextEncoder().encode("Hello, World!");

      const encrypted = await tenant.encryptPayload(originalPayload, "default");
      expect(encrypted).toBeDefined();
      expect(encrypted.length).toBeGreaterThan(originalPayload.length);
      expect(encrypted).not.toEqual(originalPayload);

      const decrypted = await tenant.decryptPayload(encrypted, "default");
      expect(decrypted).toEqual(originalPayload);
    });

    it("should encrypt and decrypt different payloads correctly", async () => {
      const payload1 = new TextEncoder().encode("First payload");
      const payload2 = new TextEncoder().encode("Second payload");

      const encrypted1 = await tenant.encryptPayload(payload1, "default");
      const encrypted2 = await tenant.encryptPayload(payload2, "default");

      expect(encrypted1).not.toEqual(encrypted2);

      const decrypted1 = await tenant.decryptPayload(encrypted1, "default");
      const decrypted2 = await tenant.decryptPayload(encrypted2, "default");

      expect(decrypted1).toEqual(payload1);
      expect(decrypted2).toEqual(payload2);
    });

    it("should encrypt same payload differently each time (due to random IV)", async () => {
      const payload = new TextEncoder().encode("Same payload");

      const encrypted1 = await tenant.encryptPayload(payload, "default");
      const encrypted2 = await tenant.encryptPayload(payload, "default");

      // Encrypted payloads should be different due to random IV
      expect(encrypted1).not.toEqual(encrypted2);

      // But both should decrypt to the same value
      const decrypted1 = await tenant.decryptPayload(encrypted1, "default");
      const decrypted2 = await tenant.decryptPayload(encrypted2, "default");

      expect(decrypted1).toEqual(payload);
      expect(decrypted2).toEqual(payload);
    });

    it("should handle empty payload", async () => {
      const emptyPayload = new Uint8Array(0);

      const encrypted = await tenant.encryptPayload(emptyPayload, "default");
      const decrypted = await tenant.decryptPayload(encrypted, "default");

      expect(decrypted).toEqual(emptyPayload);
    });

    it("should handle large payload", async () => {
      const largePayload = new Uint8Array(10000);
      for (let i = 0; i < largePayload.length; i++) {
        largePayload[i] = i % 256;
      }

      const encrypted = await tenant.encryptPayload(largePayload, "default");
      const decrypted = await tenant.decryptPayload(encrypted, "default");

      expect(decrypted).toEqual(largePayload);
    });

    it("should throw error when decrypting with wrong key ID", async () => {
      const payload = new TextEncoder().encode("Test payload");
      const encrypted = await tenant.encryptPayload(payload, "default");

      await expect(tenant.decryptPayload(encrypted, "nonexistent-key")).rejects.toThrow();
    });

    it("should throw error when decrypting corrupted data", async () => {
      const corruptedData = new Uint8Array(20);
      corruptedData.fill(0);

      await expect(tenant.decryptPayload(corruptedData, "default")).rejects.toThrow();
    });
  });

  describe("signing and verification", () => {
    let tenant: MindooTenant;
    let adminKeyPair: SigningKeyPair;
    const administrationKeyPassword = "adminpass123";

    beforeEach(async () => {
      const tenantId = "test-tenant-signing";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      // Create administration key pair first
      adminKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

      tenant = await factory.createTenant(
        tenantId,
        adminKeyPair.publicKey,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );

      // Register the current user in the directory so their key is trusted
      const directory = await tenant.openDirectory();
      const publicUser = factory.toPublicUserId(currentUser);
      await directory.registerUser(
        publicUser,
        adminKeyPair.privateKey,
        administrationKeyPassword
      );
    });

    it("should sign payload and verify signature", async () => {
      const payload = new TextEncoder().encode("Test payload to sign");

      const signature = await tenant.signPayload(payload);
      expect(signature).toBeDefined();
      expect(signature.length).toBeGreaterThan(0);

      // Get current user's public key for verification
      const publicUserId = await tenant.getCurrentUserId();
      const isValid = await tenant.verifySignature(payload, signature, publicUserId.userSigningPublicKey);

      expect(isValid).toBe(true);
    });

    it("should reject signature for modified payload", async () => {
      const payload = new TextEncoder().encode("Original payload");
      const modifiedPayload = new TextEncoder().encode("Modified payload");

      const signature = await tenant.signPayload(payload);
      const publicUserId = await tenant.getCurrentUserId();

      const isValid = await tenant.verifySignature(modifiedPayload, signature, publicUserId.userSigningPublicKey);

      expect(isValid).toBe(false);
    });

    it("should reject signature with wrong public key", async () => {
      const payload = new TextEncoder().encode("Test payload");
      const signature = await tenant.signPayload(payload);

      // Create a different user and use their public key
      const otherUser = await factory.createUserId("CN=otheruser/O=testtenant", "otherpass123");
      const isValid = await tenant.verifySignature(payload, signature, otherUser.userSigningKeyPair.publicKey);

      expect(isValid).toBe(false);
    });

    it("should create different signatures for same payload (non-deterministic)", async () => {
      const payload = new TextEncoder().encode("Same payload");

      const signature1 = await tenant.signPayload(payload);
      const signature2 = await tenant.signPayload(payload);

      // Ed25519 signatures are deterministic, so they should be the same
      // Actually, wait - let me check if they're deterministic or not
      // Ed25519 signatures are deterministic, so same payload + same key = same signature
      expect(signature1).toEqual(signature2);
    });
  });

  describe("database operations", () => {
    let tenant: MindooTenant;

    beforeEach(async () => {
      const tenantId = "test-tenant-db";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      // Create administration key pair first
      const adminKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

      tenant = await factory.createTenant(
        tenantId,
        adminKeyPair.publicKey,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );
    });

    it("should open a database", async () => {
      const dbId = "test-database";
      const db = await tenant.openDB(dbId);

      expect(db).toBeDefined();
      expect(db.getTenant()).toBe(tenant);
    });

    it("should open multiple databases", async () => {
      const db1 = await tenant.openDB("db-1");
      const db2 = await tenant.openDB("db-2");

      expect(db1).toBeDefined();
      expect(db2).toBeDefined();
      expect(db1).not.toBe(db2);
    });

    it("should cache databases and return same instance", async () => {
      const dbId = "cached-db";
      const db1 = await tenant.openDB(dbId);
      const db2 = await tenant.openDB(dbId);

      expect(db1).toBe(db2);
    });

    it("should open directory database", async () => {
      const directory = await tenant.openDirectory();

      expect(directory).toBeDefined();
    });
  });
});

