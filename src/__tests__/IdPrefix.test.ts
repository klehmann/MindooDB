import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  PUBLIC_INFOS_KEY_ID,
  DEFAULT_TENANT_KEY_ID,
  DOC_ID_PREFIX_REGEX,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { parseDocEntryId } from "../core/utils/idGeneration";

/**
 * Tests for `CreateOptions.idPrefix`:
 * - prefix validation and mutual exclusivity with `id`
 * - MindooDB-generated `<prefix>_<22-char-base62>` ids
 * - a single `doc_create` store entry with `initialValues` baked in
 *   (no deterministic seed + follow-up change like the custom-id path)
 * - replica sync of prefix-created documents
 * - lexicographic time-ordering of generated ids
 */
describe("createDocument with idPrefix", () => {
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
    adminUser = await factory.createUserId("CN=admin/O=idprefix", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=idprefix", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-idprefix";
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
    it("accepts prefixes matching DOC_ID_PREFIX_REGEX", () => {
      for (const good of ["a", "cls", "term", "Z9", "abcdefghij"]) {
        expect(DOC_ID_PREFIX_REGEX.test(good)).toBe(true);
      }
    });

    it.each(["", "1cls", "cls_", "with_underscore", "abcdefghijk", "über", "a-b", "a.b"])(
      "rejects invalid idPrefix %j",
      async (badPrefix) => {
        await expect(db.createDocument({ idPrefix: badPrefix })).rejects.toThrow(
          /invalid idPrefix/i,
        );
      },
    );

    it("rejects id and idPrefix together", async () => {
      await expect(
        db.createDocument({ id: "AppSettings", idPrefix: "cls" }),
      ).rejects.toThrow(/mutually exclusive/i);
    });

    it("rejects invalid inputs in createDocuments before any write", async () => {
      await expect(
        db.createDocuments([{ idPrefix: "ok" }, { idPrefix: "not_ok" }]),
      ).rejects.toThrow(/invalid idPrefix/i);
      await expect(
        db.createDocuments([{ id: "Fixed", idPrefix: "cls" }]),
      ).rejects.toThrow(/mutually exclusive/i);
    });
  });

  it("generates ids of the form <prefix>_<22-char-base62>", async () => {
    const doc = await db.createDocument({ idPrefix: "cls" });
    expect(doc.getId()).toMatch(/^cls_[0-9A-Za-z]{22}$/);

    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded.getId()).toBe(doc.getId());
  }, 30000);

  it("creates exactly ONE store entry with initialValues baked into the doc_create", async () => {
    const doc = await db.createDocument({
      idPrefix: "cls",
      initialValues: { type: "classGroup", name: "5b" },
    });
    const docId = doc.getId();
    expect(doc.getData()).toMatchObject({ type: "classGroup", name: "5b" });

    // Exactly one entry for this document — no seed + follow-up change pair.
    const entryIds = (await db.getStore().getAllIds()).filter((id) => id.startsWith(`${docId}_d_`));
    expect(entryIds.length).toBe(1);

    // The single entry is the doc_create and round-trips through parseDocEntryId.
    const parsed = parseDocEntryId(entryIds[0]);
    expect(parsed).not.toBeNull();
    expect(parsed!.docId).toBe(docId);
    // First change of a document has no dependencies.
    expect(parsed!.depsFingerprint).toBe("0");

    // Values persist on reload, i.e. they are part of the doc_create change.
    const reloaded = await db.getDocument(docId);
    expect(reloaded.getData()).toMatchObject({ type: "classGroup", name: "5b" });
  }, 30000);

  it("creates one store entry per document on the bulk path as well", async () => {
    const docs = await db.createDocuments([
      { idPrefix: "cls", initialValues: { name: "A" } },
      { idPrefix: "cls", initialValues: { name: "B" } },
    ]);
    expect(docs).toHaveLength(2);
    const allIds = await db.getStore().getAllIds();
    for (const doc of docs) {
      expect(doc.getId()).toMatch(/^cls_[0-9A-Za-z]{22}$/);
      const entryIds = allIds.filter((id) => id.startsWith(`${doc.getId()}_d_`));
      expect(entryIds.length).toBe(1);
    }
    expect(docs[0].getId()).not.toBe(docs[1].getId());
  }, 30000);

  it("generates lexicographically increasing ids for consecutive creates with the same prefix", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const doc = await db.createDocument({ idPrefix: "sort" });
      ids.push(doc.getId());
      // Ensure consecutive creates land in different UUID7 milliseconds so the
      // assertion doesn't depend on the uuid library's intra-ms counter.
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  }, 30000);

  it("syncs prefix-created documents to another replica", async () => {
    const storeFactoryB = new InMemoryContentAddressedStoreFactory();
    const factoryB = new BaseMindooTenantFactory(storeFactoryB, new NodeCryptoAdapter());

    const userBPassword = "userBpass";
    const userB = await factoryB.createUserId("CN=replicaB/O=idprefix", userBPassword);
    const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, userBPassword, factoryB.getCryptoAdapter());

    const tenantIdB = "test-tenant-idprefix";
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
      idPrefix: "cls",
      initialValues: { type: "classGroup", name: "5b" },
    });

    await dbB.pullChangesFrom(dbA.getStore());

    const docOnB = await dbB.getDocument(docA.getId());
    expect(docOnB.getData()).toMatchObject({ type: "classGroup", name: "5b" });

    // Edits flow back after sync, proving shared Automerge ancestry.
    await dbB.changeDoc(docOnB, (d) => {
      d.getData().fromB = "hello-from-B";
    });
    await dbA.pullChangesFrom(dbB.getStore());
    const finalA = await dbA.getDocument(docA.getId());
    expect(finalA.getData()).toMatchObject({ name: "5b", fromB: "hello-from-B" });
  }, 60000);

  it("still generates plain (unprefixed) sortable base62 ids by default", async () => {
    const a = await db.createDocument();
    const b = await db.createDocument();
    expect(a.getId()).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(b.getId()).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(a.getId()).not.toBe(b.getId());
  }, 30000);
});
