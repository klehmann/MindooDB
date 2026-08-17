import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DEFAULT_TENANT_KEY_ID,
  DIRECTORY_DB_ID,
  MindooTenant,
  OpenStoreOptions,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(
          dbId,
          StoreKind.attachments,
          undefined,
          options,
        ),
      });
    }
    return this.stores.get(dbId)!;
  }
}

describe("userdirectory as a system database", () => {
  const tenantId = "tenant-userdir-db";
  const crypto = new NodeCryptoAdapter();
  const adminPassword = "adminpass123";
  const alicePassword = "alicepass123";

  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  let admin: PrivateUserId;
  let adminKeyBag: KeyBag;
  let alice: PrivateUserId;
  let aliceTenant: MindooTenant;
  let aliceHash: string;

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, crypto);
    admin = await factory.createUserId("CN=admin/O=udb", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=udb", alicePassword);
    const aliceKeyBag = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, crypto);
    await aliceKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await aliceKeyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );

    aliceTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      aliceKeyBag,
    );
    const directory = await aliceTenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(admin),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await directory.registerUser(
      factory.toPublicUserId(alice),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    aliceHash = await directory.getUsernameHash!(alice.username);
  }, 120000);

  it("lets a normal user open userdirectory and create a document, but not write directory", async () => {
    const userDb = await aliceTenant.openDB(USER_DIRECTORY_DB_ID);
    expect(userDb.isAdminOnlyDb()).toBe(false);
    const doc = await userDb.createDocument({
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash },
    });
    expect(doc.getData().username_hash).toBe(aliceHash);

    const directoryDb = await aliceTenant.openDB(DIRECTORY_DB_ID);
    expect(directoryDb.isAdminOnlyDb()).toBe(true);
    await expect(directoryDb.createDocument()).rejects.toThrow(
      /Admin-only database: only the admin key can modify data/,
    );
  }, 120000);

  it("stays openable when the tenant database list is restricted", async () => {
    const directory = await aliceTenant.openDirectory();
    await directory.setDefaultAccessPolicy!(
      { databaseCreationPolicy: "directory-restricted", allowedDbIds: ["main"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await expect(aliceTenant.openDB(USER_DIRECTORY_DB_ID)).resolves.toBeDefined();
    await expect(aliceTenant.openDB("other")).rejects.toThrow(
      /not in the tenant's allowed database list/,
    );
    expect(await directory.isDatabaseAllowed!(USER_DIRECTORY_DB_ID)).toBe(true);
    expect(await directory.listKnownDBIds()).toEqual(
      expect.arrayContaining([DIRECTORY_DB_ID, USER_DIRECTORY_DB_ID]),
    );
  }, 120000);

  it("clears the local userdirectory copy on wipeLocalTenant", async () => {
    const userDb = await aliceTenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await userDb.createDocument({
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash, marker: "wipe-me" },
    });
    const docId = doc.getId();
    expect(await userDb.getAllDocumentIds()).toContain(docId);

    await aliceTenant.wipeLocalTenant!();

    const store = storeFactory.createStore(USER_DIRECTORY_DB_ID).docStore;
    const remaining = await store.findNewEntriesForDoc([], docId);
    expect(remaining).toHaveLength(0);
  }, 120000);
});
