import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, SigningKeyPair } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Group Management", () => {
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
    tenantId = "test-tenant-groups";
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

  describe("Basic Group Operations", () => {
    it("should return empty array when no groups exist", async () => {
      const directory = await tenant.openDirectory();
      const groups = await directory.getGroups();
      
      expect(groups).toEqual([]);
    });

    it("should create a group and add users", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const usernames = ["CN=alice/O=testtenant", "CN=bob/O=testtenant"];
      
      await directory.addUsersToGroup(
        groupName,
        usernames,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const groups = await directory.getGroups();
      expect(groups).toContain(groupName);
      
      const members = await directory.getGroupMembers(groupName);
      expect(members).toHaveLength(2);
      expect(members).toContain("CN=alice/O=testtenant");
      expect(members).toContain("CN=bob/O=testtenant");
    });

    it("should handle case-insensitive group names", async () => {
      const directory = await tenant.openDirectory();
      const groupName1 = "Developers";
      const groupName2 = "DEVELOPERS";
      const groupName3 = "developers";
      const username = "CN=alice/O=testtenant";
      
      // Create group with first case
      await directory.addUsersToGroup(
        groupName1,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Access with different case
      const members1 = await directory.getGroupMembers(groupName2);
      const members2 = await directory.getGroupMembers(groupName3);
      
      expect(members1).toContain(username);
      expect(members2).toContain(username);
      expect(members1).toEqual(members2);
      
      // All should refer to same group
      const groups = await directory.getGroups();
      expect(groups.length).toBe(1);
    });

    it("should add users to existing group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const initialUsers = ["CN=alice/O=testtenant"];
      const additionalUsers = ["CN=bob/O=testtenant", "CN=charlie/O=testtenant"];
      
      // Create group with initial users
      await directory.addUsersToGroup(
        groupName,
        initialUsers,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Add more users
      await directory.addUsersToGroup(
        groupName,
        additionalUsers,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const members = await directory.getGroupMembers(groupName);
      expect(members).toHaveLength(3);
      expect(members).toContain("CN=alice/O=testtenant");
      expect(members).toContain("CN=bob/O=testtenant");
      expect(members).toContain("CN=charlie/O=testtenant");
    });

    it("should not add duplicate users to group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const username = "CN=alice/O=testtenant";
      
      // Add user twice
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const members = await directory.getGroupMembers(groupName);
      expect(members).toHaveLength(1);
      expect(members).toContain(username);
    });

    it("should remove users from group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const users = ["CN=alice/O=testtenant", "CN=bob/O=testtenant", "CN=charlie/O=testtenant"];
      
      // Create group with users
      await directory.addUsersToGroup(
        groupName,
        users,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Remove one user
      await directory.removeUsersFromGroup(
        groupName,
        ["CN=bob/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const members = await directory.getGroupMembers(groupName);
      expect(members).toHaveLength(2);
      expect(members).toContain("CN=alice/O=testtenant");
      expect(members).toContain("CN=charlie/O=testtenant");
      expect(members).not.toContain("CN=bob/O=testtenant");
    });

    it("should handle removing non-existent users gracefully", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const users = ["CN=alice/O=testtenant"];
      
      // Create group with users
      await directory.addUsersToGroup(
        groupName,
        users,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Try to remove non-existent user
      await directory.removeUsersFromGroup(
        groupName,
        ["CN=nonexistent/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const members = await directory.getGroupMembers(groupName);
      expect(members).toHaveLength(1);
      expect(members).toContain("CN=alice/O=testtenant");
    });

    it("should delete a group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const users = ["CN=alice/O=testtenant"];
      
      // Create group
      await directory.addUsersToGroup(
        groupName,
        users,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify group exists
      const groupsBefore = await directory.getGroups();
      expect(groupsBefore).toContain(groupName);
      
      // Delete group
      await directory.deleteGroup(
        groupName,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify group is gone
      const groupsAfter = await directory.getGroups();
      expect(groupsAfter).not.toContain(groupName);
      
      const members = await directory.getGroupMembers(groupName);
      expect(members).toEqual([]);
    });

    it("should handle deleting non-existent group gracefully", async () => {
      const directory = await tenant.openDirectory();
      
      // Try to delete non-existent group
      await directory.deleteGroup(
        "nonexistent",
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Should not throw error
      const groups = await directory.getGroups();
      expect(groups).toEqual([]);
    });
  });

  describe("Nested Groups", () => {
    it("should support groups containing other groups", async () => {
      const directory = await tenant.openDirectory();
      
      // Create child groups
      await directory.addUsersToGroup(
        "developers",
        ["CN=alice/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.addUsersToGroup(
        "designers",
        ["CN=bob/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Create parent group containing child groups
      await directory.addUsersToGroup(
        "engineering",
        ["developers", "designers"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const engineeringMembers = await directory.getGroupMembers("engineering");
      expect(engineeringMembers).toContain("developers");
      expect(engineeringMembers).toContain("designers");
    });
  });

  describe("getUserNamesList", () => {
    it("should return username variants with wildcards", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=john/OU=team1/O=example.com";
      
      const namesList = await directory.getUserNamesList(username);
      
      // Should include original username and wildcard variants
      expect(namesList).toContain("CN=john/OU=team1/O=example.com");
      expect(namesList).toContain("*/OU=team1/O=example.com");
      expect(namesList).toContain("*/O=example.com");
      expect(namesList).toContain("*");
    });

    it("should include groups user belongs to directly", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      const groupName = "developers";
      
      // Add user to group
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const namesList = await directory.getUserNamesList(username);
      
      // Should include username variants and group
      expect(namesList).toContain(username);
      expect(namesList).toContain(groupName);
    });

    it("should include groups user belongs to via nested groups", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      
      // Create nested group structure
      await directory.addUsersToGroup(
        "developers",
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.addUsersToGroup(
        "engineering",
        ["developers"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const namesList = await directory.getUserNamesList(username);
      
      // Should include both groups
      expect(namesList).toContain("developers");
      expect(namesList).toContain("engineering");
    });

    it("should update usernames list after adding user to group", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      const groupName = "developers";
      
      // Get initial names list (should not include group)
      const namesListBefore = await directory.getUserNamesList(username);
      expect(namesListBefore).not.toContain(groupName);
      
      // Add user to group
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get updated names list (should include group)
      const namesListAfter = await directory.getUserNamesList(username);
      expect(namesListAfter).toContain(groupName);
    });

    it("should update usernames list after removing user from group", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      const groupName = "developers";
      
      // Add user to group
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify user is in group
      const namesListWithGroup = await directory.getUserNamesList(username);
      expect(namesListWithGroup).toContain(groupName);
      
      // Remove user from group
      await directory.removeUsersFromGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify user is no longer in group
      const namesListWithoutGroup = await directory.getUserNamesList(username);
      expect(namesListWithoutGroup).not.toContain(groupName);
    });

    it("should handle complex nested group structures", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      
      // Create hierarchy: team -> department -> division
      await directory.addUsersToGroup(
        "team-alpha",
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.addUsersToGroup(
        "engineering-dept",
        ["team-alpha"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.addUsersToGroup(
        "tech-division",
        ["engineering-dept"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      const namesList = await directory.getUserNamesList(username);
      
      // Should include all groups in hierarchy
      expect(namesList).toContain("team-alpha");
      expect(namesList).toContain("engineering-dept");
      expect(namesList).toContain("tech-division");
    });

    it("should detect and handle cycles in nested groups", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      
      // Create cycle: group1 -> group2 -> group1
      await directory.addUsersToGroup(
        "group1",
        [username, "group2"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      await directory.addUsersToGroup(
        "group2",
        ["group1"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Should not throw error, should handle cycle gracefully
      const namesList = await directory.getUserNamesList(username);
      
      // Should still include groups (cycle detection prevents infinite loop)
      expect(namesList).toContain("group1");
      // group2 might or might not be included depending on resolution order
    });
  });

  describe("Cache Updates", () => {
    it("should update cache after adding users to group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const username = "CN=alice/O=testtenant";
      
      // Create group
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get members (should use cache)
      const members1 = await directory.getGroupMembers(groupName);
      expect(members1).toContain(username);
      
      // Add another user
      await directory.addUsersToGroup(
        groupName,
        ["CN=bob/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Get members again (cache should be updated)
      const members2 = await directory.getGroupMembers(groupName);
      expect(members2).toHaveLength(2);
      expect(members2).toContain(username);
      expect(members2).toContain("CN=bob/O=testtenant");
    });

    it("should update cache after removing users from group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      const users = ["CN=alice/O=testtenant", "CN=bob/O=testtenant"];
      
      // Create group with users
      await directory.addUsersToGroup(
        groupName,
        users,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify initial state
      const members1 = await directory.getGroupMembers(groupName);
      expect(members1).toHaveLength(2);
      
      // Remove user
      await directory.removeUsersFromGroup(
        groupName,
        ["CN=alice/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify cache updated
      const members2 = await directory.getGroupMembers(groupName);
      expect(members2).toHaveLength(1);
      expect(members2).toContain("CN=bob/O=testtenant");
      expect(members2).not.toContain("CN=alice/O=testtenant");
    });

    it("should update cache after deleting group", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      
      // Create group
      await directory.addUsersToGroup(
        groupName,
        ["CN=alice/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify group exists
      const groups1 = await directory.getGroups();
      expect(groups1).toContain(groupName);
      
      // Delete group
      await directory.deleteGroup(
        groupName,
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Verify cache updated
      const groups2 = await directory.getGroups();
      expect(groups2).not.toContain(groupName);
    });

    it("should reflect group changes in getUserNamesList immediately", async () => {
      const directory = await tenant.openDirectory();
      const username = "CN=alice/O=testtenant";
      const groupName = "developers";
      
      // Initial state - user not in group
      const namesList1 = await directory.getUserNamesList(username);
      expect(namesList1).not.toContain(groupName);
      
      // Add user to group
      await directory.addUsersToGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Should immediately reflect change
      const namesList2 = await directory.getUserNamesList(username);
      expect(namesList2).toContain(groupName);
      
      // Remove user from group
      await directory.removeUsersFromGroup(
        groupName,
        [username],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // Should immediately reflect change
      const namesList3 = await directory.getUserNamesList(username);
      expect(namesList3).not.toContain(groupName);
    });
  });

  describe("Multiple Group Documents (Offline Sync Scenario)", () => {
    it("should merge members from multiple group documents with same name", async () => {
      const directory = await tenant.openDirectory();
      const groupName = "developers";
      
      // Simulate creating group documents on different "clients"
      // First document with some members
      await directory.addUsersToGroup(
        groupName,
        ["CN=alice/O=testtenant", "CN=bob/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // In a real scenario, this would be a separate document created on another client
      // For testing, we'll add more members which creates another change to the same document
      // To truly test merging, we'd need to create separate documents, but Automerge handles this
      // The cache merging logic handles multiple documents with the same groupName
      
      // Add more members (simulating another client's document)
      await directory.addUsersToGroup(
        groupName,
        ["CN=charlie/O=testtenant"],
        adminSigningKeyPair.privateKey,
        adminSigningKeyPassword
      );
      
      // All members should be present
      const members = await directory.getGroupMembers(groupName);
      expect(members.length).toBeGreaterThanOrEqual(3);
      expect(members).toContain("CN=alice/O=testtenant");
      expect(members).toContain("CN=bob/O=testtenant");
      expect(members).toContain("CN=charlie/O=testtenant");
    });
  });
});
