import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { MindooDB, MindooTenant, PrivateUserId, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { ColumnSorting, VirtualViewFactory } from "../core/indexing/virtualviews";

describe("VirtualView indexing across document lifecycle changes", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=viewlifecycle", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=user/O=viewlifecycle", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-view-lifecycle";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      keyBag,
    );

    const directory = await tenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(currentUser),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
    db = await tenant.openDB("employees");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  async function createEmployee(name: string, department: string) {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (mutable) => {
      const data = mutable.getData();
      data.name = name;
      data.department = department;
      data.active = true;
    });
    return doc.getId();
  }

  async function createView() {
    return await VirtualViewFactory.createView()
      .addCategoryColumn("department", { sorting: ColumnSorting.ASCENDING })
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("employees", db)
      .buildAndUpdate();
  }

  function collectNamesByCategory(view: Awaited<ReturnType<typeof createView>>) {
    const result: Record<string, string[]> = {};
    for (const category of view.getRoot().getChildCategories()) {
      const categoryName = String(category.getCategoryValue());
      result[categoryName] = category
        .getChildDocuments()
        .map((entry) => String(entry.getColumnValue("name")));
    }
    return result;
  }

  it("removes deleted documents and re-adds them after undelete", async () => {
    await createEmployee("Alice", "Sales");
    const bobId = await createEmployee("Bob", "Sales");
    await createEmployee("Charlie", "Engineering");
    const view = await createView();

    expect(collectNamesByCategory(view)).toMatchObject({
      Engineering: ["Charlie"],
      Sales: ["Alice", "Bob"],
    });

    await db.deleteDocument(bobId);
    await view.update();
    expect(collectNamesByCategory(view)).toMatchObject({
      Engineering: ["Charlie"],
      Sales: ["Alice"],
    });

    await db.undeleteDocument(bobId);
    await view.update();
    expect(collectNamesByCategory(view)).toMatchObject({
      Engineering: ["Charlie"],
      Sales: ["Alice", "Bob"],
    });
  }, 30000);

  it("uses the final alive state when delete and undelete occur before the next view update", async () => {
    const bobId = await createEmployee("Bob", "Sales");
    const view = await createView();

    await db.deleteDocument(bobId);
    await db.undeleteDocument(bobId);
    await view.update();

    expect(collectNamesByCategory(view)).toMatchObject({
      Sales: ["Bob"],
    });
  }, 30000);

  it("recomputes filter-dependent view membership from the restored body", async () => {
    const bobId = await createEmployee("Bob", "Sales");
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("department", { sorting: ColumnSorting.ASCENDING })
      .addSortedColumn("name", ColumnSorting.ASCENDING)
      .withDB("employees", db, (doc) => doc.getData().active === true)
      .buildAndUpdate();

    await db.deleteDocument(bobId);
    await view.update();
    expect(collectNamesByCategory(view).Sales ?? []).toEqual([]);

    await db.undeleteDocument(bobId);
    await view.update();
    expect(collectNamesByCategory(view).Sales).toEqual(["Bob"]);

    const bob = await db.getDocument(bobId);
    await db.changeDoc(bob, (mutable) => {
      mutable.getData().active = false;
    });
    await db.deleteDocument(bobId);
    await db.undeleteDocument(bobId);
    await view.update();
    expect(collectNamesByCategory(view).Sales ?? []).toEqual([]);
  }, 30000);
});
