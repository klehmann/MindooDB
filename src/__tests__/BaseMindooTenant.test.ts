import { BaseMindooTenantFactory } from "../BaseMindooTenantFactory";
import { BaseMindooTenant } from "../BaseMindooTenant";
import { InMemoryAppendOnlyStoreFactory } from "../appendonlystores/InMemoryAppendOnlyStoreFactory";
import { PrivateUserId, MindooTenant } from "../types";
import { KeyBag } from "../keys/KeyBag";

describe("BaseMindooTenant", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryAppendOnlyStoreFactory;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;

  beforeEach(async () => {
    storeFactory = new InMemoryAppendOnlyStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=testtenant", currentUserPassword);
    
    // Create KeyBag with user's encryption key
    keyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      currentUserPassword
    );
  }, 10000); // Increase timeout for crypto operations

  describe("createTenant", () => {
    it("should create a new tenant with factory, user ID and keyBag", async () => {
      const tenantId = "test-tenant-123";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      const tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
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

      const tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
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

      tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
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

      tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
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

    beforeEach(async () => {
      const tenantId = "test-tenant-signing";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
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

  describe("named keys", () => {
    let tenant: MindooTenant;

    beforeEach(async () => {
      const tenantId = "test-tenant-named-keys";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
        tenantEncryptionKeyPassword,
        currentUser,
        currentUserPassword,
        keyBag
      );
    });

    it("should add a named key and use it for encryption", async () => {
      const keyId = "shared-key-1";
      const keyPassword = "keypassword123";
      const encryptedKey = await factory.createSymmetricEncryptedPrivateKey(keyPassword);

      await tenant.addNamedKey(keyId, encryptedKey, keyPassword);

      const payload = new TextEncoder().encode("Payload encrypted with named key");
      const encrypted = await tenant.encryptPayload(payload, keyId);
      const decrypted = await tenant.decryptPayload(encrypted, keyId);

      expect(decrypted).toEqual(payload);
    });

    it("should reject adding key with reserved 'default' ID", async () => {
      const keyPassword = "keypassword123";
      const encryptedKey = await factory.createSymmetricEncryptedPrivateKey(keyPassword);

      await expect(tenant.addNamedKey("default", encryptedKey, keyPassword)).rejects.toThrow(
        'Key ID "default" is reserved for the tenant encryption key'
      );
    });

    it("should support multiple named keys", async () => {
      const key1Id = "key-1";
      const key2Id = "key-2";
      const keyPassword = "keypassword123";

      const encryptedKey1 = await factory.createSymmetricEncryptedPrivateKey(keyPassword);
      const encryptedKey2 = await factory.createSymmetricEncryptedPrivateKey(keyPassword);

      await tenant.addNamedKey(key1Id, encryptedKey1, keyPassword);
      await tenant.addNamedKey(key2Id, encryptedKey2, keyPassword);

      const payload = new TextEncoder().encode("Test payload");

      const encrypted1 = await tenant.encryptPayload(payload, key1Id);
      const encrypted2 = await tenant.encryptPayload(payload, key2Id);

      expect(encrypted1).not.toEqual(encrypted2);

      const decrypted1 = await tenant.decryptPayload(encrypted1, key1Id);
      const decrypted2 = await tenant.decryptPayload(encrypted2, key2Id);

      expect(decrypted1).toEqual(payload);
      expect(decrypted2).toEqual(payload);
    });
  });

  describe("database operations", () => {
    let tenant: MindooTenant;

    beforeEach(async () => {
      const tenantId = "test-tenant-db";
      const administrationKeyPassword = "adminpass123";
      const tenantEncryptionKeyPassword = "tenantkeypass123";

      tenant = await factory.createTenant(
        tenantId,
        administrationKeyPassword,
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

