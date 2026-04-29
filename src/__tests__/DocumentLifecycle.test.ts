import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  DEFAULT_TENANT_KEY_ID,
  MindooDB,
  MindooTenant,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("document lifecycle delete and undelete", () => {
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
    adminUser = await factory.createUserId("CN=admin/O=lifecycle", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=user/O=lifecycle", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-lifecycle";
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
    db = await tenant.openDB("lifecycle-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("deletes non-destructively and restores the same body on undelete", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (mutable) => {
      mutable.getData().title = "Keep me";
      mutable.getData().nested = { value: 42 };
    });

    await db.deleteDocument(doc.getId());
    const deleted = [...(await db.getDeletedDocumentIds())];
    expect(deleted).toContain(doc.getId());
    await expect(db.getDocument(doc.getId())).rejects.toThrow(/deleted/);

    const deletedSnapshot = (await db.getDocumentAtTimestamp(doc.getId(), Date.now()))!;
    expect(deletedSnapshot.isDeleted()).toBe(true);
    expect(deletedSnapshot.getData()).toMatchObject({
      title: "Keep me",
      nested: { value: 42 },
    });
    expect(deletedSnapshot.getData()._deleted).toBeUndefined();

    await db.undeleteDocument(doc.getId());
    const restored = await db.getDocument(doc.getId());
    expect(restored.isDeleted()).toBe(false);
    expect(restored.getData()).toMatchObject({
      title: "Keep me",
      nested: { value: 42 },
    });
    expect(await db.getAllDocumentIds()).toContain(doc.getId());
    expect(await db.getDeletedDocumentIds()).not.toContain(doc.getId());
  }, 30000);

  it("supports repeated delete and undelete cycles", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (mutable) => {
      mutable.getData().counter = 1;
    });

    await db.deleteDocument(doc.getId());
    await db.undeleteDocument(doc.getId());
    await db.deleteDocument(doc.getId());
    await db.undeleteDocument(doc.getId());

    const restored = await db.getDocument(doc.getId());
    expect(restored.isDeleted()).toBe(false);
    expect(restored.getData().counter).toBe(1);
  }, 30000);

  it("is idempotent when undeleting a live document", async () => {
    const doc = await db.createDocument();
    const entriesBefore = await db.getStore().findEntries("doc_undelete", null, null);

    await db.undeleteDocument(doc.getId());

    const entriesAfter = await db.getStore().findEntries("doc_undelete", null, null);
    expect(entriesAfter).toHaveLength(entriesBefore.length);
    expect((await db.getDocument(doc.getId())).isDeleted()).toBe(false);
  }, 30000);

  it("throws when undeleting an unknown document", async () => {
    await expect(db.undeleteDocument("MissingDoc")).rejects.toThrow(/not found/);
  }, 30000);

  it("uses createDocument({ id }) to resurrect tombstoned custom-id documents", async () => {
    const doc = await db.createDocument({ id: "AppSettings" });
    await db.changeDoc(doc, (mutable) => {
      mutable.getData().theme = "dark";
    });
    await db.deleteDocument("AppSettings");

    const resurrected = await db.createDocument({ id: "AppSettings" });
    expect(resurrected.getId()).toBe("AppSettings");
    expect(resurrected.isDeleted()).toBe(false);
    expect(resurrected.getData().theme).toBe("dark");
  }, 30000);

  it("resolves concurrent lifecycle terminals by latest createdAt", async () => {
    const storeFactoryB = new InMemoryContentAddressedStoreFactory();
    const factoryB = new BaseMindooTenantFactory(storeFactoryB, new NodeCryptoAdapter());
    const userBPassword = "userBpass";
    const userB = await factoryB.createUserId("CN=replicaB/O=lifecycle", userBPassword);
    const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, userBPassword, factoryB.getCryptoAdapter());
    const tenantId = tenant.getId();
    await keyBagB.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await keyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    await keyBagB.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    const tenantB = await factoryB.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      userB,
      userBPassword,
      keyBagB,
    );

    const directoryA = await tenant.openDirectory();
    await directoryA.registerUser(factoryB.toPublicUserId(userB), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    const dirA = await tenant.openDB("directory");
    const dirB = await tenantB.openDB("directory");
    await dirB.pullChangesFrom(dirA.getStore());

    const dbA = db;
    const dbB = await tenantB.openDB("lifecycle-db");
    const doc = await dbA.createDocument({ id: "SharedLifecycle" });
    await dbB.pullChangesFrom(dbA.getStore());

    await dbA.deleteDocument(doc.getId());
    await dbB.pullChangesFrom(dbA.getStore());
    await new Promise((resolve) => setTimeout(resolve, 2));
    await dbB.undeleteDocument(doc.getId());
    await dbA.pullChangesFrom(dbB.getStore());

    const restored = await dbA.getDocument(doc.getId());
    expect(restored.isDeleted()).toBe(false);
  }, 60000);
});
