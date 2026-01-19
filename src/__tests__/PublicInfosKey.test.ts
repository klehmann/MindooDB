import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, SigningKeyPair, MindooTenantDirectory, PUBLIC_INFOS_KEY_ID, EncryptionKeyPair, EncryptedPrivateKey, MindooDoc } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Tests for the $publicinfos key system.
 * 
 * The $publicinfos key enables servers to verify user access without having
 * full tenant data access. This is critical for:
 * 1. Servers that store and replicate encrypted data without decryption capability
 * 2. Access control verification without exposing business data
 * 
 * Key design decisions tested here:
 * - grantaccess/revokeaccess documents are encrypted with $publicinfos key
 * - username is stored as username_hash (SHA-256) and username_encrypted (RSA)
 * - Only admin can decrypt username_encrypted via their RSA private key
 */
describe("$publicinfos Key System", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminSigningKeyPair: SigningKeyPair;
  let adminSigningKeyPassword: string;
  let adminEncryptionKeyPair: EncryptionKeyPair;
  let tenantId: string;
  let tenantEncryptionKey: EncryptedPrivateKey;
  let tenantEncryptionKeyPassword: string;
  let publicInfosKey: EncryptedPrivateKey;
  let publicInfosKeyPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    // Create admin user
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    // Create admin signing key pair (administration key)
    adminSigningKeyPassword = "adminsigningpass123";
    adminSigningKeyPair = await factory.createSigningKeyPair(adminSigningKeyPassword);
    
    // Create admin encryption key pair (for encrypting usernames in directory)
    adminEncryptionKeyPair = await factory.createEncryptionKeyPair("adminencpass123");
    
    // Create tenant encryption key
    tenantEncryptionKeyPassword = "tenantkeypass123";
    tenantEncryptionKey = await factory.createSymmetricEncryptedPrivateKey(tenantEncryptionKeyPassword);
    
    // Create $publicinfos symmetric key
    publicInfosKeyPassword = "publicinfospass123";
    publicInfosKey = await factory.createSymmetricEncryptedPrivateKey(publicInfosKeyPassword);
    
    tenantId = "publicinfos-test-tenant";
  }, 30000);

  describe("Server with only $publicinfos key", () => {
    it("should be able to validate signing keys with only $publicinfos key", async () => {
      // Create a "full client" KeyBag with both default and $publicinfos keys
      const fullClientKeyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await fullClientKeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      // Create tenant with full client
      const fullClientTenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        fullClientKeyBag
      );
      
      // Register admin user
      const fullClientDirectory = await fullClientTenant.openDirectory();
      const publicAdminUser = factory.toPublicUserId(adminUser);
      await fullClientDirectory.registerUser(
        publicAdminUser,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Create a "server" that only has the $publicinfos key (no default key)
      const serverUser = await factory.createUserId("CN=server/O=testtenant", "serverpass");
      const serverKeyBag = new KeyBag(
        serverUser.userEncryptionKeyPair.privateKey,
        "serverpass",
        new NodeCryptoAdapter()
      );
      // Server only gets $publicinfos key, NOT the default tenant key
      await serverKeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      // Register server user via full client (admin operation)
      const publicServerUser = factory.toPublicUserId(serverUser);
      await fullClientDirectory.registerUser(
        publicServerUser,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Create tenant instance for server
      const serverTenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        serverUser,
        "serverpass",
        serverKeyBag
      );
      
      // Sync directory data from full client to server
      const serverDirectory = await serverTenant.openDirectory();
      const serverDirectoryDB = await serverTenant.openDB("directory");
      const fullClientDirectoryDB = await fullClientTenant.openDB("directory");
      await serverDirectoryDB.pullChangesFrom(fullClientDirectoryDB.getStore());
      
      // Server should be able to validate the admin's signing key
      const isAdminKeyValid = await serverDirectory.validatePublicSigningKey(
        adminUser.userSigningKeyPair.publicKey
      );
      expect(isAdminKeyValid).toBe(true);
      
      // Server should be able to validate its own signing key
      const isServerKeyValid = await serverDirectory.validatePublicSigningKey(
        serverUser.userSigningKeyPair.publicKey
      );
      expect(isServerKeyValid).toBe(true);
      
      // Server should reject unknown keys
      const unknownUser = await factory.createUserId("CN=unknown/O=testtenant", "unknownpass");
      const isUnknownKeyValid = await serverDirectory.validatePublicSigningKey(
        unknownUser.userSigningKeyPair.publicKey
      );
      expect(isUnknownKeyValid).toBe(false);
    }, 60000);
  });

  describe("Document structure", () => {
    it("grantaccess documents should have username_hash and username_encrypted", async () => {
      // Create full client
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      const tenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        keyBag
      );
      
      // Register a user
      const directory = await tenant.openDirectory();
      const regularUser = await factory.createUserId("CN=regularuser/O=testtenant", "regularpass");
      const publicRegularUser = factory.toPublicUserId(regularUser);
      
      await directory.registerUser(
        publicRegularUser,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Read the directory database to check document structure
      const directoryDB = await tenant.openDB("directory");
      await directoryDB.syncStoreChanges();
      
      // Find the grantaccess document
      let grantAccessDoc: MindooDoc | null = null;
      for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
        const data = doc.getData();
        if (data.form === "useroperation" && 
            data.type === "grantaccess" &&
            data.userSigningPublicKey === regularUser.userSigningKeyPair.publicKey) {
          grantAccessDoc = doc;
          break;
        }
      }
      
      expect(grantAccessDoc).not.toBeNull();
      const data = grantAccessDoc!.getData();
      
      // Verify username_hash exists and is a valid SHA-256 hash (64 hex chars)
      expect(data.username_hash).toBeDefined();
      expect(typeof data.username_hash).toBe("string");
      expect((data.username_hash as string).length).toBe(64);
      expect(/^[a-f0-9]+$/.test(data.username_hash as string)).toBe(true);
      
      // Verify username_encrypted exists and is base64 encoded
      expect(data.username_encrypted).toBeDefined();
      expect(typeof data.username_encrypted).toBe("string");
      expect((data.username_encrypted as string).length).toBeGreaterThan(0);
      
      // Verify the old username field does NOT exist
      expect(data.username).toBeUndefined();
      
      // Verify user keys are still present
      expect(data.userSigningPublicKey).toBe(regularUser.userSigningKeyPair.publicKey);
      expect(data.userEncryptionPublicKey).toBe(regularUser.userEncryptionKeyPair.publicKey);
    }, 60000);
    
    it("username_hash should be deterministic (revoke and re-register produces same hash)", async () => {
      // Create full client
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      const tenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        keyBag
      );
      
      const directory = await tenant.openDirectory();
      
      // Register user
      const user = await factory.createUserId("CN=sameuser/O=testtenant", "pass1");
      const publicUser = factory.toPublicUserId(user);
      
      await directory.registerUser(
        publicUser,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get the hash from first registration
      const directoryDB = await tenant.openDB("directory");
      await directoryDB.syncStoreChanges();
      
      let firstHash: string | null = null;
      for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
        const data = doc.getData();
        if (data.form === "useroperation" && 
            data.type === "grantaccess" &&
            data.userSigningPublicKey === user.userSigningKeyPair.publicKey) {
          firstHash = data.username_hash as string;
          break;
        }
      }
      expect(firstHash).not.toBeNull();
      
      // Revoke user
      await directory.revokeUser(
        publicUser.username,
        false,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Re-register user (same keys, so allowed)
      await directory.registerUser(
        publicUser,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Sync and get all grantaccess hashes
      await directoryDB.syncStoreChanges();
      
      const hashes: string[] = [];
      for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
        const data = doc.getData();
        if (data.form === "useroperation" && 
            data.type === "grantaccess" &&
            data.userSigningPublicKey === user.userSigningKeyPair.publicKey) {
          hashes.push(data.username_hash as string);
        }
      }
      
      // Should have 2 grantaccess docs (original + re-registration after revoke)
      expect(hashes.length).toBe(2);
      // Both should have same hash (deterministic)
      expect(hashes[0]).toBe(hashes[1]);
      expect(hashes[0]).toBe(firstHash);
    }, 60000);
    
    it("should reject registration of same username (case-insensitive) with different keys", async () => {
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      const tenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        keyBag
      );
      
      const directory = await tenant.openDirectory();
      
      // Register first user
      const lowerUser = await factory.createUserId("CN=testuser/O=testtenant", "pass1");
      await directory.registerUser(
        factory.toPublicUserId(lowerUser),
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Try to register different user with same username (different case) - should throw
      const upperUser = await factory.createUserId("CN=TESTUSER/O=TESTTENANT", "pass2");
      await expect(directory.registerUser(
        factory.toPublicUserId(upperUser),
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      )).rejects.toThrow("same username (case-insensitive)");
    }, 60000);
    
    it("should skip re-registration of same user with same keys", async () => {
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      const tenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        keyBag
      );
      
      const directory = await tenant.openDirectory();
      
      // Register user
      const user = await factory.createUserId("CN=testuser/O=testtenant", "pass1");
      const publicUser = factory.toPublicUserId(user);
      
      await directory.registerUser(
        publicUser,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Re-register same user with same keys (different case username) - should succeed (no-op)
      const publicUserUpperCase = {
        ...publicUser,
        username: "CN=TESTUSER/O=TESTTENANT"
      };
      
      await directory.registerUser(
        publicUserUpperCase,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Should still only have 1 grantaccess document
      const directoryDB = await tenant.openDB("directory");
      await directoryDB.syncStoreChanges();
      
      let grantAccessCount = 0;
      for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
        const data = doc.getData();
        if (data.form === "useroperation" && data.type === "grantaccess") {
          grantAccessCount++;
        }
      }
      
      expect(grantAccessCount).toBe(1);
    }, 60000);
  });

  describe("Group management with $publicinfos", () => {
    it("group documents should have members_hashes and members_encrypted", async () => {
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      const tenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        keyBag
      );
      
      const directory = await tenant.openDirectory();
      
      // Register admin first
      await directory.registerUser(
        factory.toPublicUserId(adminUser),
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Create a group with members
      const groupName = "developers";
      const members = ["CN=alice/O=testtenant", "CN=bob/O=testtenant"];
      
      await directory.addUsersToGroup(
        groupName,
        members,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Read the directory database to check group document structure
      const directoryDB = await tenant.openDB("directory");
      await directoryDB.syncStoreChanges();
      
      let groupDoc: MindooDoc | null = null;
      for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
        const data = doc.getData();
        if (data.form === "group" && data.type === "group" && data.groupName === groupName) {
          groupDoc = doc;
          break;
        }
      }
      
      expect(groupDoc).not.toBeNull();
      const data = groupDoc!.getData();
      
      // Verify members_hashes exists and contains 2 hashes
      expect(data.members_hashes).toBeDefined();
      expect(Array.isArray(data.members_hashes)).toBe(true);
      const membersHashes = data.members_hashes as string[];
      expect(membersHashes.length).toBe(2);
      
      // Each hash should be a valid SHA-256 hash
      for (const hash of membersHashes) {
        expect(typeof hash).toBe("string");
        expect(hash.length).toBe(64);
        expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
      }
      
      // Verify members_encrypted exists and contains 2 encrypted values
      expect(data.members_encrypted).toBeDefined();
      expect(Array.isArray(data.members_encrypted)).toBe(true);
      const membersEncrypted = data.members_encrypted as string[];
      expect(membersEncrypted.length).toBe(2);
      
      // Verify the old members field does NOT exist
      expect(data.members).toBeUndefined();
    }, 60000);
    
    it("getGroupMembers should return member hashes for lookups", async () => {
      const keyBag = new KeyBag(
        adminUser.userEncryptionKeyPair.privateKey,
        adminUserPassword,
        new NodeCryptoAdapter()
      );
      await keyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, publicInfosKeyPassword);
      
      const tenant = await factory.openTenantWithKeys(
        tenantId,
        tenantEncryptionKey,
        tenantEncryptionKeyPassword,
        adminSigningKeyPair.publicKey,
        adminEncryptionKeyPair.publicKey,
        adminUser,
        adminUserPassword,
        keyBag
      );
      
      const directory = await tenant.openDirectory();
      
      // Register admin
      await directory.registerUser(
        factory.toPublicUserId(adminUser),
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Create a group
      const groupName = "testers";
      const members = ["CN=tester1/O=testtenant"];
      
      await directory.addUsersToGroup(
        groupName,
        members,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // getGroupMembers now returns hashes, not actual usernames
      const returnedMembers = await directory.getGroupMembers(groupName);
      
      expect(returnedMembers.length).toBe(1);
      // The returned value should be a hash (64 hex chars), not the username
      expect(returnedMembers[0].length).toBe(64);
      expect(/^[a-f0-9]+$/.test(returnedMembers[0])).toBe(true);
      expect(returnedMembers[0]).not.toBe("CN=tester1/O=testtenant");
    }, 60000);
  });
});
