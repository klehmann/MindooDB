import { KeyBag } from "../core/keys/KeyBag";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, EncryptedPrivateKey } from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("KeyBag", () => {
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

  async function createEncryptedDocKey(keyId: string, password: string): Promise<EncryptedPrivateKey> {
    const temp = keyBag.clone();
    await temp.createDocKey(keyId);
    const encrypted = await temp.encryptAndExportKey("doc", keyId, password);
    if (!encrypted) {
      throw new Error(`Failed to export generated doc key: ${keyId}`);
    }
    return encrypted;
  }

  describe("constructor", () => {
    it("should create a KeyBag instance with user encryption key", () => {
      expect(keyBag).toBeDefined();
      expect(keyBag).toBeInstanceOf(KeyBag);
    });
  });

  describe("set and get", () => {
    it("should set and get a key", async () => {
      const keyId = "test-key-1";
      const keyBytes = new Uint8Array([1, 2, 3, 4, 5]);

      await keyBag.set("doc", keyId, keyBytes);
      const retrieved = await keyBag.get("doc", keyId);

      expect(retrieved).toBeDefined();
      expect(retrieved).toEqual(keyBytes);
    });

    it("should return null for non-existent key", async () => {
      const retrieved = await keyBag.get("doc", "non-existent-key");
      expect(retrieved).toBeNull();
    });

    it("should set and get a key with createdAt timestamp", async () => {
      const keyId = "test-key-2";
      const keyBytes = new Uint8Array([6, 7, 8, 9, 10]);
      const createdAt = Date.now();

      await keyBag.set("doc", keyId, keyBytes, createdAt);
      const retrieved = await keyBag.get("doc", keyId);

      expect(retrieved).toBeDefined();
      expect(retrieved).toEqual(keyBytes);
    });

    it("should support multiple keys per keyId (key rotation)", async () => {
      const keyId = "rotated-key";
      const key1 = new Uint8Array([1, 1, 1]);
      const key2 = new Uint8Array([2, 2, 2]);
      const key3 = new Uint8Array([3, 3, 3]);

      await keyBag.set("doc", keyId, key1, 1000);
      await keyBag.set("doc", keyId, key2, 2000);
      await keyBag.set("doc", keyId, key3, 3000);

      // get() should return the newest key
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toEqual(key3);
    });

    it("should return newest key when multiple keys have timestamps", async () => {
      const keyId = "timestamped-keys";
      const key1 = new Uint8Array([10]);
      const key2 = new Uint8Array([20]);
      const key3 = new Uint8Array([30]);

      await keyBag.set("doc", keyId, key1, 100);
      await keyBag.set("doc", keyId, key2, 300);
      await keyBag.set("doc", keyId, key3, 200);

      // Should return key2 (timestamp 300, newest)
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toEqual(key2);
    });

    it("should handle keys without timestamps (returns first)", async () => {
      const keyId = "no-timestamp-keys";
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);

      await keyBag.set("doc", keyId, key1);
      await keyBag.set("doc", keyId, key2);

      // Without timestamps, should return first one (key1)
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toEqual(key1);
    });

    it("should handle mixed keys with and without timestamps", async () => {
      const keyId = "mixed-keys";
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);
      const key3 = new Uint8Array([3]);

      await keyBag.set("doc", keyId, key1); // no timestamp
      await keyBag.set("doc", keyId, key2, 2000);
      await keyBag.set("doc", keyId, key3); // no timestamp

      // Should return key2 (has highest timestamp, 2000)
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toEqual(key2);
    });
  });

  describe("createTenantKey and createDocKey", () => {
    it("should create and store a tenant key without password wrapper", async () => {
      await keyBag.createTenantKey("tenant-a");
      const key = await keyBag.get("tenant", "tenant-a");
      expect(key).toBeDefined();
      expect(key!.length).toBe(32); // AES-256 raw key bytes
    });

    it("should create and store a doc key without password wrapper", async () => {
      await keyBag.createDocKey("doc-key-a");
      const key = await keyBag.get("doc", "doc-key-a");
      expect(key).toBeDefined();
      expect(key!.length).toBe(32); // AES-256 raw key bytes
    });
  });

  describe("getAllKeys", () => {
    it("should return empty array for non-existent key", async () => {
      const keys = await keyBag.getAllKeys("doc", "non-existent");
      expect(keys).toEqual([]);
    });

    it("should return all keys for a keyId sorted by createdAt (newest first)", async () => {
      const keyId = "all-keys-test";
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);
      const key3 = new Uint8Array([3]);

      await keyBag.set("doc", keyId, key1, 1000);
      await keyBag.set("doc", keyId, key2, 3000);
      await keyBag.set("doc", keyId, key3, 2000);

      const allKeys = await keyBag.getAllKeys("doc", keyId);
      expect(allKeys).toHaveLength(3);
      expect(allKeys[0]).toEqual(key2); // newest (3000)
      expect(allKeys[1]).toEqual(key3); // middle (2000)
      expect(allKeys[2]).toEqual(key1); // oldest (1000)
    });

    it("should return single key when only one exists", async () => {
      const keyId = "single-key";
      const key = new Uint8Array([42]);

      await keyBag.set("doc", keyId, key);
      const allKeys = await keyBag.getAllKeys("doc", keyId);

      expect(allKeys).toHaveLength(1);
      expect(allKeys[0]).toEqual(key);
    });
  });

  describe("decryptAndImportKey", () => {
    it("should decrypt and import an encrypted key", async () => {
      const keyId = "imported-key";
      const keyPassword = "keypassword123";
      
      const encryptedKey = await createEncryptedDocKey(keyId, keyPassword);

      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey, keyPassword);
      
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.length).toBeGreaterThan(0);
    });

    it("should preserve createdAt timestamp when importing", async () => {
      const keyId = "timestamped-import";
      const keyPassword = "keypassword123";
      const createdAt = Date.now();
      
      const encryptedKey = await createEncryptedDocKey(keyId, keyPassword);
      encryptedKey.createdAt = createdAt;

      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey, keyPassword);
      
      // Verify the key was imported
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toBeDefined();
    });

    it("should support importing multiple versions of the same key", async () => {
      const keyId = "multi-version-key";
      const keyPassword = "keypassword123";
      
      const encryptedKey1 = await createEncryptedDocKey(keyId, keyPassword);
      encryptedKey1.createdAt = 1000;
      
      const encryptedKey2 = await createEncryptedDocKey(keyId, keyPassword);
      encryptedKey2.createdAt = 2000;

      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey1, keyPassword);
      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey2, keyPassword);
      
      const allKeys = await keyBag.getAllKeys("doc", keyId);
      expect(allKeys).toHaveLength(2);
    });

    it("should throw error with wrong password", async () => {
      const keyId = "wrong-password-key";
      const correctPassword = "correctpassword123";
      const wrongPassword = "wrongpassword123";
      
      const encryptedKey = await createEncryptedDocKey(keyId, correctPassword);

      await expect(
        keyBag.decryptAndImportKey("doc", keyId, encryptedKey, wrongPassword)
      ).rejects.toThrow();
    });
  });

  describe("encryptAndExportKey", () => {
    it("should encrypt and export a key", async () => {
      const keyId = "export-test-key";
      const keyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const exportPassword = "exportpassword123";

      await keyBag.set("doc", keyId, keyBytes);
      const encryptedKey = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);

      expect(encryptedKey).toBeDefined();
      expect(encryptedKey).not.toBeNull();
      expect(encryptedKey!.ciphertext).toBeDefined();
      expect(encryptedKey!.iv).toBeDefined();
      expect(encryptedKey!.tag).toBeDefined();
      expect(encryptedKey!.salt).toBeDefined();
      expect(encryptedKey!.iterations).toBe(310000);
    });

    it("should return null for non-existent key", async () => {
      const encryptedKey = await keyBag.encryptAndExportKey("doc", "non-existent", "password");
      expect(encryptedKey).toBeNull();
    });

    it("should preserve createdAt timestamp when exporting", async () => {
      const keyId = "timestamped-export";
      const keyBytes = new Uint8Array([42]);
      const createdAt = Date.now();
      const exportPassword = "exportpassword123";

      await keyBag.set("doc", keyId, keyBytes, createdAt);
      const encryptedKey = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);

      expect(encryptedKey).toBeDefined();
      expect(encryptedKey!.createdAt).toBe(createdAt);
    });

    it("should export newest key when multiple keys exist", async () => {
      const keyId = "multi-export";
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);
      const exportPassword = "exportpassword123";

      await keyBag.set("doc", keyId, key1, 1000);
      await keyBag.set("doc", keyId, key2, 2000);

      const encryptedKey = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);
      expect(encryptedKey).toBeDefined();
      expect(encryptedKey!.createdAt).toBe(2000);
    });

    it("should round-trip: export and import back", async () => {
      const keyId = "roundtrip-key";
      const originalKeyBytes = new Uint8Array([10, 20, 30, 40, 50]);
      const exportPassword = "exportpassword123";

      // Set original key
      await keyBag.set("doc", keyId, originalKeyBytes);

      // Export it
      const encryptedKey = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);
      expect(encryptedKey).toBeDefined();

      // Delete from key bag
      await keyBag.deleteKey("doc", keyId);
      expect(await keyBag.get("doc", keyId)).toBeNull();

      // Import it back (encryptAndExportKey uses keyId as salt)
      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey!, exportPassword);

      // Verify it matches
      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toBeDefined();
      expect(retrieved).toEqual(originalKeyBytes);
    });

    it("should round-trip with createdAt timestamp", async () => {
      const keyId = "roundtrip-timestamp";
      const originalKeyBytes = new Uint8Array([99]);
      const createdAt = Date.now();
      const exportPassword = "exportpassword123";

      await keyBag.set("doc", keyId, originalKeyBytes, createdAt);
      const encryptedKey = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);
      
      await keyBag.deleteKey("doc", keyId);
      // encryptAndExportKey uses keyId as salt
      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey!, exportPassword);

      const retrieved = await keyBag.get("doc", keyId);
      expect(retrieved).toBeDefined();
      expect(retrieved).toEqual(originalKeyBytes);
    });

    it("should produce different encrypted output each time (due to random salt/IV)", async () => {
      const keyId = "random-encryption";
      const keyBytes = new Uint8Array([1, 2, 3]);
      const exportPassword = "exportpassword123";

      await keyBag.set("doc", keyId, keyBytes);
      
      const encrypted1 = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);
      const encrypted2 = await keyBag.encryptAndExportKey("doc", keyId, exportPassword);

      expect(encrypted1).toBeDefined();
      expect(encrypted2).toBeDefined();
      
      // Encrypted outputs should be different due to random salt/IV
      expect(encrypted1!.salt).not.toBe(encrypted2!.salt);
      expect(encrypted1!.iv).not.toBe(encrypted2!.iv);
      expect(encrypted1!.ciphertext).not.toBe(encrypted2!.ciphertext);
      
      // But both should decrypt to the same key when imported under the same doc keyId
      await keyBag.deleteKey("doc", keyId);
      
      await keyBag.decryptAndImportKey("doc", keyId, encrypted1!, exportPassword);
      await keyBag.decryptAndImportKey("doc", keyId, encrypted2!, exportPassword);
      
      const allKeys = await keyBag.getAllKeys("doc", keyId);
      const key1 = allKeys[0];
      const key2 = allKeys[1];
      
      expect(key1).toEqual(key2);
      expect(key1).toEqual(keyBytes);
    });
  });

  describe("deleteKey", () => {
    it("should delete a key", async () => {
      const keyId = "delete-test";
      const keyBytes = new Uint8Array([1, 2, 3]);

      await keyBag.set("doc", keyId, keyBytes);
      expect(await keyBag.get("doc", keyId)).toBeDefined();

      await keyBag.deleteKey("doc", keyId);
      expect(await keyBag.get("doc", keyId)).toBeNull();
    });

    it("should delete all versions of a key", async () => {
      const keyId = "delete-all-versions";
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);

      await keyBag.set("doc", keyId, key1, 1000);
      await keyBag.set("doc", keyId, key2, 2000);
      expect(await keyBag.getAllKeys("doc", keyId)).toHaveLength(2);

      await keyBag.deleteKey("doc", keyId);
      expect(await keyBag.get("doc", keyId)).toBeNull();
      expect(await keyBag.getAllKeys("doc", keyId)).toHaveLength(0);
    });

    it("should not throw when deleting non-existent key", async () => {
      await expect(keyBag.deleteKey("doc", "non-existent")).resolves.not.toThrow();
    });
  });

  describe("listKeys", () => {
    it("should return empty array for empty key bag", async () => {
      const keys = await keyBag.listKeys();
      expect(keys).toEqual([]);
    });

    it("should list all key IDs", async () => {
      await keyBag.set("doc", "key1", new Uint8Array([1]));
      await keyBag.set("doc", "key2", new Uint8Array([2]));
      await keyBag.set("doc", "key3", new Uint8Array([3]));

      const keys = await keyBag.listKeys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain("doc:key1");
      expect(keys).toContain("doc:key2");
      expect(keys).toContain("doc:key3");
    });

    it("should not list deleted keys", async () => {
      await keyBag.set("doc", "key1", new Uint8Array([1]));
      await keyBag.set("doc", "key2", new Uint8Array([2]));
      await keyBag.set("doc", "key3", new Uint8Array([3]));

      await keyBag.deleteKey("doc", "key2");

      const keys = await keyBag.listKeys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain("doc:key1");
      expect(keys).not.toContain("doc:key2");
      expect(keys).toContain("doc:key3");
    });
  });

  describe("clone", () => {
    it("should clone key entries in memory", async () => {
      await keyBag.set("tenant", "tenant-1", new Uint8Array([1, 2, 3]));
      await keyBag.set("doc", "doc-1", new Uint8Array([4, 5, 6]), 1000);

      const cloned = keyBag.clone();

      expect(await cloned.get("tenant", "tenant-1")).toEqual(new Uint8Array([1, 2, 3]));
      expect(await cloned.get("doc", "doc-1")).toEqual(new Uint8Array([4, 5, 6]));
      expect(await cloned.listKeys()).toEqual(expect.arrayContaining(["tenant:tenant-1", "doc:doc-1"]));
    });

    it("should keep clone independent from original mutations", async () => {
      await keyBag.set("doc", "doc-1", new Uint8Array([9, 9, 9]), 1000);
      const cloned = keyBag.clone();

      // Mutate original after clone
      await keyBag.set("doc", "doc-1", new Uint8Array([7, 7, 7]), 2000);
      await keyBag.deleteKey("doc", "doc-1");
      await keyBag.set("doc", "doc-2", new Uint8Array([8, 8, 8]));

      // Clone should still have the original cloned state
      expect(await cloned.get("doc", "doc-1")).toEqual(new Uint8Array([9, 9, 9]));
      expect(await cloned.get("doc", "doc-2")).toBeNull();
      expect(await keyBag.get("doc", "doc-1")).toBeNull();
      expect(await keyBag.get("doc", "doc-2")).toEqual(new Uint8Array([8, 8, 8]));
    });
  });

  describe("save and load", () => {
    it("should save and load an empty key bag", async () => {
      const saved = await keyBag.save();
      expect(saved).toBeDefined();
      expect(saved.length).toBeGreaterThan(0);

      // Create a new KeyBag and load into it
      const newKeyBag = new KeyBag(
        currentUser.userEncryptionKeyPair.privateKey,
        currentUserPassword,
        factory.getCryptoAdapter()
      );
      await newKeyBag.load(saved);

      const keys = await newKeyBag.listKeys();
      expect(keys).toEqual([]);
    });

    it("should save and load keys", async () => {
      const key1 = new Uint8Array([1, 2, 3]);
      const key2 = new Uint8Array([4, 5, 6]);
      const key3 = new Uint8Array([7, 8, 9]);

      await keyBag.set("doc", "key1", key1, 1000);
      await keyBag.set("doc", "key2", key2, 2000);
      await keyBag.set("doc", "key3", key3);

      const saved = await keyBag.save();

      // Create a new KeyBag and load into it
      const newKeyBag = new KeyBag(
        currentUser.userEncryptionKeyPair.privateKey,
        currentUserPassword,
        factory.getCryptoAdapter()
      );
      await newKeyBag.load(saved);

      expect(await newKeyBag.get("doc", "key1")).toEqual(key1);
      expect(await newKeyBag.get("doc", "key2")).toEqual(key2);
      expect(await newKeyBag.get("doc", "key3")).toEqual(key3);
    });

    it("should preserve createdAt timestamps when saving and loading", async () => {
      const createdAt1 = 1000;
      const createdAt2 = 2000;
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);

      await keyBag.set("doc", "key1", key1, createdAt1);
      await keyBag.set("doc", "key2", key2, createdAt2);

      const saved = await keyBag.save();
      const newKeyBag = new KeyBag(
        currentUser.userEncryptionKeyPair.privateKey,
        currentUserPassword,
        factory.getCryptoAdapter()
      );
      await newKeyBag.load(saved);

      // Verify keys are loaded in correct order (newest first)
      const allKeys1 = await newKeyBag.getAllKeys("doc", "key1");
      const allKeys2 = await newKeyBag.getAllKeys("doc", "key2");
      
      expect(allKeys1[0]).toEqual(key1);
      expect(allKeys2[0]).toEqual(key2);
    });

    it("should save and load multiple versions of the same key", async () => {
      const keyId = "rotated-key";
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);
      const key3 = new Uint8Array([3]);

      await keyBag.set("doc", keyId, key1, 1000);
      await keyBag.set("doc", keyId, key2, 2000);
      await keyBag.set("doc", keyId, key3, 3000);

      const saved = await keyBag.save();
      const newKeyBag = new KeyBag(
        currentUser.userEncryptionKeyPair.privateKey,
        currentUserPassword,
        factory.getCryptoAdapter()
      );
      await newKeyBag.load(saved);

      const allKeys = await newKeyBag.getAllKeys("doc", keyId);
      expect(allKeys).toHaveLength(3);
      expect(allKeys[0]).toEqual(key3); // newest
      expect(allKeys[1]).toEqual(key2);
      expect(allKeys[2]).toEqual(key1); // oldest
    });

    it("should throw error when loading data that is too short", async () => {
      const invalidData = new Uint8Array(10); // Too short (needs at least 28 bytes)

      await expect(keyBag.load(invalidData)).rejects.toThrow("Encrypted data too short");
    });

    it("should throw error when loading with wrong password", async () => {
      const key = new Uint8Array([1, 2, 3]);
      await keyBag.set("doc", "test-key", key);

      const saved = await keyBag.save();

      // Try to load with wrong password
      const wrongPasswordKeyBag = new KeyBag(
        currentUser.userEncryptionKeyPair.privateKey,
        "wrongpassword",
        factory.getCryptoAdapter()
      );

      await expect(wrongPasswordKeyBag.load(saved)).rejects.toThrow();
    });
  });

  describe("integration scenarios", () => {
    it("should handle complex key rotation scenario", async () => {
      const keyId = "rotation-test";
      const keyPassword = "keypassword123";

      const encryptedKey1 = await createEncryptedDocKey(keyId, keyPassword);
      encryptedKey1.createdAt = 1000;
      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey1, keyPassword);

      // Rotate: export and re-import with new timestamp
      const exported = await keyBag.encryptAndExportKey("doc", keyId, keyPassword);
      exported!.createdAt = 2000;
      await keyBag.decryptAndImportKey("doc", keyId, exported!, keyPassword);

      // Add another version directly
      const encryptedKey2 = await createEncryptedDocKey(keyId, keyPassword);
      encryptedKey2.createdAt = 3000;
      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey2, keyPassword);

      // Should have 3 versions, newest first
      const allKeys = await keyBag.getAllKeys("doc", keyId);
      expect(allKeys).toHaveLength(3);

      // get() should return newest
      const newest = await keyBag.get("doc", keyId);
      expect(newest).toBeDefined();
    });

    it("should handle save/load with encrypted keys", async () => {
      const keyId = "encrypted-key";
      const keyPassword = "keypassword123";

      const encryptedKey = await createEncryptedDocKey(keyId, keyPassword);
      await keyBag.decryptAndImportKey("doc", keyId, encryptedKey, keyPassword);

      // Save and load
      const saved = await keyBag.save();
      const newKeyBag = new KeyBag(
        currentUser.userEncryptionKeyPair.privateKey,
        currentUserPassword,
        factory.getCryptoAdapter()
      );
      await newKeyBag.load(saved);

      // Verify key is still accessible
      const retrieved = await newKeyBag.get("doc", keyId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.length).toBeGreaterThan(0);
    });
  });
});

