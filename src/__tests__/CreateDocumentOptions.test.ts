import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  MindooDoc,
  PUBLIC_INFOS_KEY_ID,
  DEFAULT_TENANT_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Tests for the new `createDocument(options?: CreateOptions)` API:
 * - caller-provided document ids
 * - validation of the custom id format
 * - idempotent re-creation
 * - Automerge convergence between independent replicas using the same custom id
 * - parity with the deprecated `createEncryptedDocument` /
 *   `createDocumentWithSigningKey` methods, which now delegate to
 *   `createDocument`
 */
describe("createDocument with CreateOptions", () => {
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
    adminUser = await factory.createUserId("CN=admin/O=customidtest", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=customidtest", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-customid";
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
    const publicUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(publicUser, adminUser.userSigningKeyPair.privateKey, adminUserPassword);

    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("returns a document with the caller-provided id and round-trips through getDocument", async () => {
    const doc = await db.createDocument({ id: "AppSettings" });
    expect(doc.getId()).toBe("AppSettings");

    await db.changeDoc(doc, (d) => {
      d.getData().theme = "dark";
    });

    const reloaded = await db.getDocument("AppSettings");
    expect(reloaded.getId()).toBe("AppSettings");
    expect(reloaded.getData().theme).toBe("dark");
  }, 30000);

  it.each(["1bad", "bad-name", "bad.id", "bad|id", ""])(
    "rejects invalid custom document id %j",
    async (badId) => {
      await expect(db.createDocument({ id: badId })).rejects.toThrow(
        /invalid document id/i,
      );
    },
  );

  it("accepts ids that exercise the full allowed character set", async () => {
    const doc = await db.createDocument({ id: "A_b9_X" });
    expect(doc.getId()).toBe("A_b9_X");
  }, 30000);

  it("is idempotent when the document already exists locally", async () => {
    const first = await db.createDocument({ id: "AppSettings" });
    await db.changeDoc(first, (d) => {
      d.getData().count = 1;
    });

    const second = await db.createDocument({ id: "AppSettings" });
    expect(second.getId()).toBe("AppSettings");
    // The second create returns the existing document untouched, including
    // any state we set after the first create.
    expect(second.getData().count).toBe(1);
  }, 30000);

  it("undeletes a tombstoned custom-id document instead of creating a replacement", async () => {
    const first = await db.createDocument({ id: "AppSettings" });
    await db.changeDoc(first, (d) => {
      d.getData().count = 1;
    });
    await db.deleteDocument("AppSettings");

    const second = await db.createDocument({ id: "AppSettings" });
    expect(second.getId()).toBe("AppSettings");
    expect(second.isDeleted()).toBe(false);
    expect(second.getData().count).toBe(1);
    expect(await db.getAllDocumentIds()).toContain("AppSettings");
  }, 30000);

  it("converges when two independent replicas create the same custom id", async () => {
    // Build a second, independent DB instance against a separate in-memory
    // store factory but using the same tenant identity, so we can validate
    // that two replicas creating "AppSettings" can sync each other's edits.
    const storeFactoryB = new InMemoryContentAddressedStoreFactory();
    const factoryB = new BaseMindooTenantFactory(storeFactoryB, new NodeCryptoAdapter());

    const userBPassword = "userBpass";
    const userB = await factoryB.createUserId("CN=replicaB/O=customidtest", userBPassword);
    const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, userBPassword, factoryB.getCryptoAdapter());

    const tenantIdB = "test-tenant-customid";
    // Reuse the same admin and tenant key on replica B so the encrypted
    // entries from replica A can be decrypted on replica B.
    const tenantKey = (await keyBag.get("doc", tenantIdB, DEFAULT_TENANT_KEY_ID))!;
    const publicInfosKey = (await keyBag.get("doc", tenantIdB, PUBLIC_INFOS_KEY_ID))!;
    await keyBagB.set("doc", tenantIdB, DEFAULT_TENANT_KEY_ID, tenantKey);
    await keyBagB.set("doc", tenantIdB, PUBLIC_INFOS_KEY_ID, publicInfosKey);

    const tenantB = await factoryB.openTenant(
      tenantIdB,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      userB,
      userBPassword,
      keyBagB,
    );

    // Pull directory so replica B's user is recognized
    const directoryA = await tenant.openDirectory();
    await directoryA.registerUser(factoryB.toPublicUserId(userB), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    const dirB = await tenantB.openDB("directory");
    const directoryAsDb = await tenant.openDB("directory");
    await dirB.pullChangesFrom(directoryAsDb.getStore());

    const dbA = db;
    const dbB = await tenantB.openDB("test-db");

    const docA = await dbA.createDocument({ id: "AppSettings" });
    const docB = await dbB.createDocument({ id: "AppSettings" });

    expect(docA.getId()).toBe("AppSettings");
    expect(docB.getId()).toBe("AppSettings");

    // Each replica makes a different change to the same logical document.
    await dbA.changeDoc(docA, (d) => {
      d.getData().fromA = "hello-from-A";
    });
    await dbB.changeDoc(docB, (d) => {
      d.getData().fromB = "hello-from-B";
    });

    // Sync the two stores in both directions.
    await dbB.pullChangesFrom(dbA.getStore());
    await dbA.pullChangesFrom(dbB.getStore());

    const finalA = await dbA.getDocument("AppSettings");
    const finalB = await dbB.getDocument("AppSettings");
    // After convergence, both replicas should observe both edits, proving the
    // initial doc_create entries shared Automerge ancestry.
    expect(finalA.getData()).toMatchObject({ fromA: "hello-from-A", fromB: "hello-from-B" });
    expect(finalB.getData()).toMatchObject({ fromA: "hello-from-A", fromB: "hello-from-B" });
  }, 60000);

  it("preserves the legacy createEncryptedDocument behavior via the decryptionKeyId option", async () => {
    const namedKeyId = "team-key";
    await keyBag.createDocKey(tenant.getId(), namedKeyId);

    const doc = await db.createDocument({ decryptionKeyId: namedKeyId });
    expect(doc.getDecryptionKeyId()).toBe(namedKeyId);
  }, 30000);

  it("preserves the legacy createDocumentWithSigningKey behavior via signingKeyPair/signingKeyPassword", async () => {
    // Compare against the deprecated wrapper: both flows must return a usable
    // document with the given decryption key. Detailed admin-only enforcement
    // is covered by TrustModel.test.ts; here we only assert that the
    // CreateOptions surface accepts the same arguments without throwing.
    const doc = await db.createDocument({
      signingKeyPair: adminUser.userSigningKeyPair,
      signingKeyPassword: adminUserPassword,
    });
    expect(doc.getId()).toBeDefined();
    expect(doc.getDecryptionKeyId()).toBe("default");
  }, 30000);

  it("rejects partial signing-key options", async () => {
    await expect(db.createDocument({ signingKeyPair: adminUser.userSigningKeyPair })).rejects.toThrow(
      /signingKeyPair and signingKeyPassword must be provided together/,
    );
    await expect(db.createDocument({ signingKeyPassword: adminUserPassword })).rejects.toThrow(
      /signingKeyPair and signingKeyPassword must be provided together/,
    );
  }, 30000);

  it("produces a stable doc_create entry id for custom-id documents across separate DB instances", async () => {
    const storeFactoryB = new InMemoryContentAddressedStoreFactory();
    const factoryB = new BaseMindooTenantFactory(storeFactoryB, new NodeCryptoAdapter());

    const userBPassword = "userBpass";
    const userB = await factoryB.createUserId("CN=replicaB/O=customidtest", userBPassword);
    const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, userBPassword, factoryB.getCryptoAdapter());

    const tenantIdB = "test-tenant-customid";
    const tenantKey = (await keyBag.get("doc", tenantIdB, DEFAULT_TENANT_KEY_ID))!;
    const publicInfosKey = (await keyBag.get("doc", tenantIdB, PUBLIC_INFOS_KEY_ID))!;
    await keyBagB.set("doc", tenantIdB, DEFAULT_TENANT_KEY_ID, tenantKey);
    await keyBagB.set("doc", tenantIdB, PUBLIC_INFOS_KEY_ID, publicInfosKey);

    const tenantB = await factoryB.openTenant(
      tenantIdB,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      userB,
      userBPassword,
      keyBagB,
    );
    // Bootstrap directory on replica B
    const directoryA = await tenant.openDirectory();
    await directoryA.registerUser(factoryB.toPublicUserId(userB), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    const dirB = await tenantB.openDB("directory");
    const directoryAsDb = await tenant.openDB("directory");
    await dirB.pullChangesFrom(directoryAsDb.getStore());

    const dbA = db;
    const dbB = await tenantB.openDB("test-db");

    await dbA.createDocument({ id: "AppSettings" });
    await dbB.createDocument({ id: "AppSettings" });

    const idsA = (await dbA.getStore().getAllIds()).filter((id) => id.startsWith("AppSettings_d_"));
    const idsB = (await dbB.getStore().getAllIds()).filter((id) => id.startsWith("AppSettings_d_"));

    // Both stores should have produced exactly the same doc_create entry id,
    // proving the underlying Automerge change hash is stable across replicas.
    expect(idsA.length).toBe(1);
    expect(idsB.length).toBe(1);
    expect(idsA[0]).toBe(idsB[0]);
  }, 60000);

  it("still rejects custom-id creation in admin-only databases when the current user isn't admin", async () => {
    // Reuse the admin-only `directory` DB which validates signing key.
    // The default `tenant` was opened with the admin user; create a
    // tenant under a non-admin user to exercise the validation path.
    const otherUserPassword = "otherpass";
    const otherUser = await factory.createUserId("CN=other/O=customidtest", otherUserPassword);
    const otherKeyBag = new KeyBag(
      otherUser.userEncryptionKeyPair.privateKey,
      otherUserPassword,
      factory.getCryptoAdapter(),
    );
    const tenantKey = (await keyBag.get("doc", tenant.getId(), DEFAULT_TENANT_KEY_ID))!;
    const publicInfosKey = (await keyBag.get("doc", tenant.getId(), PUBLIC_INFOS_KEY_ID))!;
    await otherKeyBag.set("doc", tenant.getId(), DEFAULT_TENANT_KEY_ID, tenantKey);
    await otherKeyBag.set("doc", tenant.getId(), PUBLIC_INFOS_KEY_ID, publicInfosKey);
    const otherTenant = await factory.openTenant(
      tenant.getId(),
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      otherUser,
      otherUserPassword,
      otherKeyBag,
    );
    const directoryDb = await otherTenant.openDB("directory");
    await expect(directoryDb.createDocument({ id: "DirEntry" })).rejects.toThrow();
  }, 30000);

  it("returns an existing UUID7 document is not affected by id-only existence check", async () => {
    // Sanity check: createDocument() without options still generates UUID7
    // and does not consult the existing-doc check path.
    const a = await db.createDocument();
    const b = await db.createDocument();
    expect(a.getId()).not.toBe(b.getId());
  }, 30000);
});
