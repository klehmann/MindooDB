import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { KeyBag } from "../core/keys/KeyBag";

describe("BaseMindooTenantFactory", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;

  beforeEach(() => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
  });

  describe("createUserId", () => {
    it("should create a user ID with signing and encryption key pairs", async () => {
      const username = "CN=testuser/O=testtenant";
      const password = "testpassword123";

      const privateUserId = await factory.createUserId(username, password);

      expect(privateUserId).toBeDefined();
      expect(privateUserId.username).toBe(username);
      expect(privateUserId.userSigningKeyPair).toBeDefined();
      expect(privateUserId.userSigningKeyPair.publicKey).toBeDefined();
      expect(privateUserId.userSigningKeyPair.privateKey).toBeDefined();
      expect(privateUserId.userEncryptionKeyPair).toBeDefined();
      expect(privateUserId.userEncryptionKeyPair.publicKey).toBeDefined();
      expect(privateUserId.userEncryptionKeyPair.privateKey).toBeDefined();

      // Verify public key format (PEM)
      expect(privateUserId.userSigningKeyPair.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
      expect(privateUserId.userSigningKeyPair.publicKey).toContain("-----END PUBLIC KEY-----");
      expect(privateUserId.userEncryptionKeyPair.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
      expect(privateUserId.userEncryptionKeyPair.publicKey).toContain("-----END PUBLIC KEY-----");

      // Verify encrypted private key structure
      const signingEncryptedKey = privateUserId.userSigningKeyPair.privateKey;
      expect(signingEncryptedKey.ciphertext).toBeDefined();
      expect(signingEncryptedKey.iv).toBeDefined();
      expect(signingEncryptedKey.tag).toBeDefined();
      expect(signingEncryptedKey.salt).toBeDefined();
      expect(signingEncryptedKey.iterations).toBe(310000);

      const encryptionEncryptedKey = privateUserId.userEncryptionKeyPair.privateKey;
      expect(encryptionEncryptedKey.ciphertext).toBeDefined();
      expect(encryptionEncryptedKey.iv).toBeDefined();
      expect(encryptionEncryptedKey.tag).toBeDefined();
      expect(encryptionEncryptedKey.salt).toBeDefined();
      expect(encryptionEncryptedKey.iterations).toBe(310000);
    });

    it("should create different key pairs for different users", async () => {
      const password = "testpassword123";
      const user1 = await factory.createUserId("CN=user1/O=tenant", password);
      const user2 = await factory.createUserId("CN=user2/O=tenant", password);

      expect(user1.userSigningKeyPair.publicKey).not.toBe(user2.userSigningKeyPair.publicKey);
      expect(user1.userEncryptionKeyPair.publicKey).not.toBe(user2.userEncryptionKeyPair.publicKey);
    });

    it("should create different encrypted keys even with the same password", async () => {
      const username = "CN=testuser/O=testtenant";
      const password = "testpassword123";

      const user1 = await factory.createUserId(username, password);
      const user2 = await factory.createUserId(username, password);

      // Even with the same password, the encrypted keys should be different due to random salt/IV
      expect(user1.userSigningKeyPair.privateKey.salt).not.toBe(user2.userSigningKeyPair.privateKey.salt);
      expect(user1.userSigningKeyPair.privateKey.iv).not.toBe(user2.userSigningKeyPair.privateKey.iv);
      expect(user1.userSigningKeyPair.privateKey.ciphertext).not.toBe(user2.userSigningKeyPair.privateKey.ciphertext);
    }, 30000);
  });

  describe("toPublicUserId", () => {
    it("should convert private user ID to public user ID", async () => {
      const username = "CN=testuser/O=testtenant";
      const password = "testpassword123";

      const privateUserId = await factory.createUserId(username, password);

      const publicUserId = factory.toPublicUserId(privateUserId);

      expect(publicUserId).toBeDefined();
      expect(publicUserId.username).toBe(username);
      expect(publicUserId.userSigningPublicKey).toBe(privateUserId.userSigningKeyPair.publicKey);
      expect(publicUserId.userEncryptionPublicKey).toBe(privateUserId.userEncryptionKeyPair.publicKey);

      // Verify private keys are not included
      expect((publicUserId as any).userSigningKeyPair).toBeUndefined();
      expect((publicUserId as any).userEncryptionKeyPair).toBeUndefined();
    });

    it("should preserve all public fields", async () => {
      const username = "CN=testuser/O=testtenant";
      const password = "testpassword123";

      const privateUserId = await factory.createUserId(username, password);
      const publicUserId = factory.toPublicUserId(privateUserId);

      expect(publicUserId.username).toBe(privateUserId.username);
      expect(publicUserId.userSigningPublicKey).toBe(privateUserId.userSigningKeyPair.publicKey);
      expect(publicUserId.userEncryptionPublicKey).toBe(privateUserId.userEncryptionKeyPair.publicKey);
    });
  });

  describe("openTenant", () => {
    it("should reject opening tenant with admin identity as current user", async () => {
      const tenantId = "tenant-open-guard";
      const adminPassword = "admin-password";
      const adminUser = await factory.createUserId("CN=admin/O=testtenant", adminPassword);
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.createTenantKey(tenantId);
      await keyBag.createDocKey("$publicinfos");

      await expect(
        factory.openTenant(
          tenantId,
          adminUser.userSigningKeyPair.publicKey,
          adminUser.userEncryptionKeyPair.publicKey,
          adminUser,
          adminPassword,
          keyBag
        )
      ).rejects.toThrow("currentUser must not be the administration identity");
    });

    it("should prevent opening databases when admin identity is used as current user", async () => {
      const tenantId = "tenant-open-db-guard";
      const adminPassword = "admin-password";
      const adminUser = await factory.createUserId("CN=admin/O=testtenant", adminPassword);
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.createTenantKey(tenantId);
      await keyBag.createDocKey("$publicinfos");

      await expect(
        (async () => {
          const tenant = await factory.openTenant(
            tenantId,
            adminUser.userSigningKeyPair.publicKey,
            adminUser.userEncryptionKeyPair.publicKey,
            adminUser,
            adminPassword,
            keyBag
          );
          await tenant.openDB("should-not-open");
        })()
      ).rejects.toThrow("currentUser must not be the administration identity");
    });
  });

  describe("createSigningKeyPair", () => {
    it("should create a signing key pair with Ed25519 public key and encrypted private key", async () => {
      const password = "testpassword123";

      const keyPair = await factory.createSigningKeyPair(password);

      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();

      // Verify public key format (PEM)
      expect(keyPair.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
      expect(keyPair.publicKey).toContain("-----END PUBLIC KEY-----");

      // Verify encrypted private key structure
      const encryptedKey = keyPair.privateKey;
      expect(encryptedKey.ciphertext).toBeDefined();
      expect(encryptedKey.iv).toBeDefined();
      expect(encryptedKey.tag).toBeDefined();
      expect(encryptedKey.salt).toBeDefined();
      expect(encryptedKey.iterations).toBe(310000);
    });

    it("should create different key pairs on each call", async () => {
      const password = "testpassword123";

      const keyPair1 = await factory.createSigningKeyPair(password);
      const keyPair2 = await factory.createSigningKeyPair(password);

      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
      expect(keyPair1.privateKey.salt).not.toBe(keyPair2.privateKey.salt);
      expect(keyPair1.privateKey.iv).not.toBe(keyPair2.privateKey.iv);
      expect(keyPair1.privateKey.ciphertext).not.toBe(keyPair2.privateKey.ciphertext);
    });

    it("should create valid Ed25519 public key format", async () => {
      const password = "testpassword123";
      const keyPair = await factory.createSigningKeyPair(password);

      // Ed25519 public keys in PEM format should have a specific structure
      const publicKeyLines = keyPair.publicKey.split("\n");
      expect(publicKeyLines[0]).toBe("-----BEGIN PUBLIC KEY-----");
      expect(publicKeyLines[publicKeyLines.length - 1]).toBe("-----END PUBLIC KEY-----");
      expect(publicKeyLines.length).toBeGreaterThan(2); // Should have base64 content
    });
  });

  describe("KeyBag symmetric key creation", () => {
    it("should create and store a document key (AES-256)", async () => {
      const user = await factory.createUserId("CN=testuser/O=testtenant", "testpassword123");
      const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "testpassword123", new NodeCryptoAdapter());

      await keyBag.createDocKey("test-doc-key");
      const key = await keyBag.get("doc", "test-doc-key");

      expect(key).toBeDefined();
      expect(key!.length).toBe(32);
    });

    it("should create different key material on each call", async () => {
      const user = await factory.createUserId("CN=testuser/O=testtenant", "testpassword123");
      const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "testpassword123", new NodeCryptoAdapter());

      await keyBag.createDocKey("test-doc-key");
      const key1 = await keyBag.get("doc", "test-doc-key");
      await keyBag.createDocKey("test-doc-key");
      const allKeys = await keyBag.getAllKeys("doc", "test-doc-key");

      expect(key1).toBeDefined();
      expect(allKeys.length).toBe(2);
      expect(allKeys[0]).not.toEqual(allKeys[1]);
    });
  });

  describe("createEncryptionKeyPair", () => {
    it("should create an encryption key pair with RSA-OAEP public key and encrypted private key", async () => {
      const password = "testpassword123";

      const keyPair = await factory.createEncryptionKeyPair(password);

      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();

      // Verify public key format (PEM)
      expect(keyPair.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
      expect(keyPair.publicKey).toContain("-----END PUBLIC KEY-----");

      // Verify encrypted private key structure
      const encryptedKey = keyPair.privateKey;
      expect(encryptedKey.ciphertext).toBeDefined();
      expect(encryptedKey.iv).toBeDefined();
      expect(encryptedKey.tag).toBeDefined();
      expect(encryptedKey.salt).toBeDefined();
      expect(encryptedKey.iterations).toBe(310000);
    });

    it("should create different key pairs on each call", async () => {
      const password = "testpassword123";

      const keyPair1 = await factory.createEncryptionKeyPair(password);
      const keyPair2 = await factory.createEncryptionKeyPair(password);

      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
      expect(keyPair1.privateKey.salt).not.toBe(keyPair2.privateKey.salt);
      expect(keyPair1.privateKey.iv).not.toBe(keyPair2.privateKey.iv);
      expect(keyPair1.privateKey.ciphertext).not.toBe(keyPair2.privateKey.ciphertext);
    });

    it("should create valid RSA-OAEP public key format", async () => {
      const password = "testpassword123";
      const keyPair = await factory.createEncryptionKeyPair(password);

      // RSA-OAEP public keys in PEM format should have a specific structure
      const publicKeyLines = keyPair.publicKey.split("\n");
      expect(publicKeyLines[0]).toBe("-----BEGIN PUBLIC KEY-----");
      expect(publicKeyLines[publicKeyLines.length - 1]).toBe("-----END PUBLIC KEY-----");
      expect(publicKeyLines.length).toBeGreaterThan(2); // Should have base64 content
    });

    it("should create 3072-bit RSA keys", async () => {
      const password = "testpassword123";
      const keyPair = await factory.createEncryptionKeyPair(password);

      // RSA-3072 keys should have a specific base64 length in PEM format
      // The public key should be longer than smaller key sizes
      const base64Content = keyPair.publicKey
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(/\n/g, "");
      
      // RSA-3072 public key in DER format encoded as base64 should be around 400+ characters
      expect(base64Content.length).toBeGreaterThan(400);
    });
  });

  describe("factory instantiation", () => {
    it("should instantiate with InMemoryContentAddressedStoreFactory and NodeCryptoAdapter", () => {
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

      expect(factory).toBeDefined();
      expect(factory).toBeInstanceOf(BaseMindooTenantFactory);
    });

    it("should be able to create keys with provided crypto adapter", async () => {
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

      expect(factory).toBeDefined();
      // Should be able to create keys without errors
      const keyPair = await factory.createSigningKeyPair("test");
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
    });
  });
});
