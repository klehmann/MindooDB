import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { DEFAULT_TENANT_KEY_ID, PrivateUserId, MindooTenant, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Group mail addresses (distribution lists)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminKeyBag: KeyBag;
  let tenant: MindooTenant;
  let tenantId: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    // Create admin user (signing + encryption keys used for tenant administration)
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    // Create KeyBag for admin user
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    tenantId = "test-tenant-groups";
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);
    const currentUser = await factory.createUserId("CN=currentuser/O=testtenant", "currentpass123");
    const currentUserKeyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, "currentpass123", cryptoAdapter);
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
    tenant = await factory.openTenant(tenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, currentUser, "currentpass123", currentUserKeyBag);
    
    // Register the admin user in the directory so their key is trusted
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
  }, 30000);

  it("sets, reads, lists and removes a group's mail address", async () => {
    const directory = await tenant.openDirectory();
    const key = adminUser.userSigningKeyPair.privateKey;
    await directory.addUsersToGroup("Sales", ["CN=ada/O=testtenant", "CN=bob/O=testtenant"], key, adminUserPassword);
    await directory.addUsersToGroup("Support", ["CN=carl/O=testtenant"], key, adminUserPassword);
    expect(await directory.getGroupMailAddress!("sales")).toBeNull();

    await directory.setGroupMailAddress!("Sales", " Sales@Example.COM ", key, adminUserPassword);
    expect(await directory.getGroupMailAddress!("SALES")).toBe("sales@example.com");
    expect(await directory.listGroupMailAddresses!()).toEqual([{ groupName: "sales", address: "sales@example.com" }]);
    // Members stay as they were.
    expect((await directory.getGroupMembers("sales")).sort()).toEqual(["CN=ada/O=testtenant", "CN=bob/O=testtenant"]);

    await directory.setGroupMailAddress!("sales", null, key, adminUserPassword);
    expect(await directory.getGroupMailAddress!("sales")).toBeNull();
    expect(await directory.listGroupMailAddresses!()).toEqual([]);
  });

  it("refuses an invalid address and an unknown group", async () => {
    const directory = await tenant.openDirectory();
    const key = adminUser.userSigningKeyPair.privateKey;
    await directory.addUsersToGroup("team", ["CN=ada/O=testtenant"], key, adminUserPassword);
    await expect(directory.setGroupMailAddress!("team", "not-an-address", key, adminUserPassword)).rejects.toThrow(/not a mail address/);
    await expect(directory.setGroupMailAddress!("nobody", "x@example.com", key, adminUserPassword)).rejects.toThrow(/does not exist/);
  });

  it("keeps the address out of the group document's plain fields", async () => {
    const directory = await tenant.openDirectory();
    const key = adminUser.userSigningKeyPair.privateKey;
    await directory.addUsersToGroup("hidden", ["CN=ada/O=testtenant"], key, adminUserPassword);
    await directory.setGroupMailAddress!("hidden", "hidden@example.com", key, adminUserPassword);
    const db = await tenant.openDB("directory", { adminOnlyDb: true });
    for (const id of await db.getAllDocumentIds()) {
      const data = (await db.getDocument(id)).getData() as Record<string, unknown>;
      if (data.groupName === "hidden") {
        expect(JSON.stringify(data)).not.toContain("hidden@example.com");
        expect(typeof data.mail_encrypted).toBe("string");
      }
    }
  });
});
