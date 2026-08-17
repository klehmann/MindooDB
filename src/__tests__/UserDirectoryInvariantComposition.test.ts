import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DEFAULT_TENANT_KEY_ID,
  MindooTenant,
  OpenStoreOptions,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { AccessDeniedError } from "../core/accesscontrol/AccessDeniedError";

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

describe("userdirectory invariant composition with ACL", () => {
  const tenantId = "tenant-userdir-acl";
  const crypto = new NodeCryptoAdapter();
  const adminPassword = "adminpass123";
  const alicePassword = "alicepass123";
  const bobPassword = "bobpass123";

  let factory: BaseMindooTenantFactory;
  let admin: PrivateUserId;
  let adminKeyBag: KeyBag;
  let alice: PrivateUserId;
  let bob: PrivateUserId;
  let aliceTenant: MindooTenant;
  let bobTenant: MindooTenant;
  let aliceHash: string;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, crypto);
    await kb.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await kb.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );
    return kb;
  }

  beforeEach(async () => {
    const storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, crypto);
    admin = await factory.createUserId("CN=admin/O=uacl", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);
    alice = await factory.createUserId("CN=alice/O=uacl", alicePassword);
    bob = await factory.createUserId("CN=bob/O=uacl", bobPassword);

    aliceTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      await keyBagFor(alice, alicePassword),
    );
    bobTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      bob,
      bobPassword,
      await keyBagFor(bob, bobPassword),
    );
    const directory = await aliceTenant.openDirectory();
    for (const u of [admin, alice, bob]) {
      await directory.registerUser(
        factory.toPublicUserId(u),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }
    aliceHash = await directory.getUsernameHash!(alice.username);
  }, 120000);

  it("does not let an $everyone allow rule on doc_change weaken the invariant", async () => {
    const directory = await aliceTenant.openDirectory();
    await directory.setDefaultAccessPolicy!(
      {},
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await directory.createAccessRule!(
      {
        ruleId: "ud_change_everyone",
        type: "doc_change",
        dbid: USER_DIRECTORY_DB_ID,
        action: "allow",
        users_hashes: ["$everyone"],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const aliceDb = await aliceTenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await aliceDb.createDocument({
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash, marker: "owned" },
    });
    const bobDb = await bobTenant.openDB(USER_DIRECTORY_DB_ID);
    const bobView = await bobDb.getDocument(doc.getId());
    await expect(
      bobDb.changeDoc(bobView, (d) => {
        d.getData().marker = "hijacked";
      }),
    ).rejects.toThrow(/userdirectory: only the owning person can change/);
  }, 120000);

  it("lets an extra deny policy tighten create further", async () => {
    const directory = await aliceTenant.openDirectory();
    await directory.setDefaultAccessPolicy!(
      {},
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await directory.setDatabaseAccessPolicy!(
      USER_DIRECTORY_DB_ID,
      { denyDocCreate: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const aliceDb = await aliceTenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(
      aliceDb.createDocument({
        decryptionKeyId: PUBLIC_INFOS_KEY_ID,
        initialValues: { username_hash: aliceHash },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  }, 120000);

  it("behaves the same without any ACL configuration", async () => {
    const aliceDb = await aliceTenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await aliceDb.createDocument({
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash, marker: "plain" },
    });
    expect(doc.getData().marker).toBe("plain");
    const bobDb = await bobTenant.openDB(USER_DIRECTORY_DB_ID);
    const bobView = await bobDb.getDocument(doc.getId());
    await expect(
      bobDb.changeDoc(bobView, (d) => {
        d.getData().marker = "no";
      }),
    ).rejects.toThrow(/userdirectory: only the owning person can change/);
  }, 120000);
});
