import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  PUBLIC_INFOS_KEY_ID,
  DEFAULT_TENANT_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { parseDocEntryId } from "../core/utils/idGeneration";

/**
 * Tests for `CreateOptions.assumeUniqueId`:
 * - a caller-provided random id keeps its value (no remapping) while the
 *   create follows the generated-ID path: ONE `doc_create` store entry with
 *   `initialValues` baked in — no deterministic seed + follow-up change pair
 * - works on both the single-create and the bulk `createDocuments` path
 * - validation: the flag requires a caller-provided `id`
 * - without the flag, the convergent custom-id behavior is unchanged
 * - replica sync of flag-created documents
 */
describe("createDocument with assumeUniqueId", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=uniqueid", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=uniqueid", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-uniqueid";
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
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  describe("validation", () => {
    it("rejects assumeUniqueId without a caller-provided id", async () => {
      await expect(
        db.createDocument({ assumeUniqueId: true }),
      ).rejects.toThrow(/assumeUniqueId requires a caller-provided id/i);
      await expect(
        db.createDocument({ idPrefix: "cls", assumeUniqueId: true }),
      ).rejects.toThrow(/assumeUniqueId requires a caller-provided id/i);
      await expect(
        db.createDocuments([{ assumeUniqueId: true }]),
      ).rejects.toThrow(/assumeUniqueId requires a caller-provided id/i);
    });

    it("still rejects initialValues with a custom id WITHOUT the flag (single create)", async () => {
      await expect(
        db.createDocument({ id: "lrn_fixedId1", initialValues: { name: "x" } }),
      ).rejects.toThrow(/initialValues is not supported together with a custom id/i);
    });
  });

  it("keeps the caller id and creates exactly ONE store entry with initialValues baked in", async () => {
    const id = "lrn_a1b2c3d4e5f60718293a4b5c";
    const doc = await db.createDocument({
      id,
      assumeUniqueId: true,
      initialValues: { type: "learner", name: "Kim" },
    });
    expect(doc.getId()).toBe(id);
    expect(doc.getData()).toMatchObject({ type: "learner", name: "Kim" });

    // Exactly one entry — no deterministic seed + follow-up change pair.
    const entryIds = (await db.getStore().getAllIds()).filter((eid) => eid.startsWith(`${id}_d_`));
    expect(entryIds.length).toBe(1);

    // The single entry is the doc_create (first change: no dependencies).
    const parsed = parseDocEntryId(entryIds[0]);
    expect(parsed).not.toBeNull();
    expect(parsed!.docId).toBe(id);
    expect(parsed!.depsFingerprint).toBe("0");

    // Values persist on reload, i.e. they are part of the doc_create change.
    const reloaded = await db.getDocument(id);
    expect(reloaded.getData()).toMatchObject({ type: "learner", name: "Kim" });
  }, 30000);

  it("bulk-creates cross-referencing documents with one entry each and stable ids", async () => {
    // Pre-generated random ids so documents can reference each other up front
    // (the demo-import pattern: class <-> learners are cyclic).
    const classId = "cls_0f1e2d3c4b5a690817263544";
    const learnerIds = ["lrn_00112233445566778899aabb", "lrn_ffeeddccbbaa998877665544"];

    const docs = await db.createDocuments([
      {
        id: classId,
        assumeUniqueId: true,
        initialValues: { type: "classGroup", name: "5b", learnerIds },
      },
      ...learnerIds.map((id, i) => ({
        id,
        assumeUniqueId: true,
        initialValues: { type: "learner", name: `L${i}`, classGroupIds: [classId] },
      })),
    ]);
    expect(docs.map((d) => d.getId())).toEqual([classId, ...learnerIds]);

    const allIds = await db.getStore().getAllIds();
    for (const doc of docs) {
      const entryIds = allIds.filter((eid) => eid.startsWith(`${doc.getId()}_d_`));
      expect(entryIds.length).toBe(1);
    }

    // References survived untouched.
    const cls = await db.getDocument(classId);
    expect(cls.getData().learnerIds).toEqual(learnerIds);
    const lrn = await db.getDocument(learnerIds[0]);
    expect(lrn.getData().classGroupIds).toEqual([classId]);
  }, 30000);

  it("keeps the two-entry convergent behavior on the bulk path WITHOUT the flag", async () => {
    const id = "cfg_convergentBulkDoc";
    await db.createDocuments([{ id, initialValues: { name: "settings" } }]);
    const entryIds = (await db.getStore().getAllIds()).filter((eid) => eid.startsWith(`${id}_d_`));
    // Deterministic seed doc_create + follow-up doc_change with the values.
    expect(entryIds.length).toBe(2);
  }, 30000);

  it("is idempotent: re-creating the same id returns the existing doc without a new entry", async () => {
    const id = "lrn_1234567890abcdef12345678";
    await db.createDocument({ id, assumeUniqueId: true, initialValues: { name: "first" } });
    const again = await db.createDocument({ id, assumeUniqueId: true, initialValues: { name: "second" } });
    expect(again.getData()).toMatchObject({ name: "first" });
    const entryIds = (await db.getStore().getAllIds()).filter((eid) => eid.startsWith(`${id}_d_`));
    expect(entryIds.length).toBe(1);
  }, 30000);

  it("syncs flag-created documents to another replica", async () => {
    const storeFactoryB = new InMemoryContentAddressedStoreFactory();
    const factoryB = new BaseMindooTenantFactory(storeFactoryB, new NodeCryptoAdapter());

    const userBPassword = "userBpass";
    const userB = await factoryB.createUserId("CN=replicaB/O=uniqueid", userBPassword);
    const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, userBPassword, factoryB.getCryptoAdapter());

    const tenantIdB = "test-tenant-uniqueid";
    // Reuse the same tenant keys on replica B so entries from A can be decrypted.
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
    const directoryA = await tenant.openDirectory();
    await directoryA.registerUser(factoryB.toPublicUserId(userB), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    const dirB = await tenantB.openDB("directory");
    const directoryAsDb = await tenant.openDB("directory");
    await dirB.pullChangesFrom(directoryAsDb.getStore());

    const dbA = db;
    const dbB = await tenantB.openDB("test-db");

    const docA = await dbA.createDocument({
      id: "lrn_syncMe0011223344556677",
      assumeUniqueId: true,
      initialValues: { type: "learner", name: "Kim" },
    });

    await dbB.pullChangesFrom(dbA.getStore());

    const docOnB = await dbB.getDocument(docA.getId());
    expect(docOnB.getData()).toMatchObject({ type: "learner", name: "Kim" });

    // Edits flow back after sync, proving shared Automerge ancestry.
    await dbB.changeDoc(docOnB, (d) => {
      d.getData().fromB = "hello-from-B";
    });
    await dbA.pullChangesFrom(dbB.getStore());
    const finalA = await dbA.getDocument(docA.getId());
    expect(finalA.getData()).toMatchObject({ name: "Kim", fromB: "hello-from-B" });
  }, 60000);
});
