import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Tests for the bulk document operations `createDocuments()` and
 * `deleteDocuments()`.
 *
 * These are the batched counterparts of `createDocument()`/`deleteDocument()`:
 * all produced store entries are written through one `putEntries()` call.
 * The semantics must stay equivalent to the per-document APIs, including the
 * bulk-only extension that custom-id documents may carry `initialValues`
 * (applied as a follow-up `doc_change` entry in the same batch).
 */
describe("bulk document operations", () => {
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
    adminUser = await factory.createUserId("CN=admin/O=bulkops", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=bulkops", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-bulkops";
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
    db = await tenant.openDB("test-db-bulk");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("creates many uuid7 documents with initial values in one batch", async () => {
    const inputs = Array.from({ length: 25 }, (_, i) => ({
      initialValues: { type: "note", title: `Note ${i}`, position: i },
    }));
    const docs = await db.createDocuments(inputs);
    expect(docs).toHaveLength(25);

    // Results are in input order and carry the seeded values.
    for (let i = 0; i < docs.length; i++) {
      const data = docs[i].getData();
      expect(data.title).toBe(`Note ${i}`);
      expect(data.position).toBe(i);
    }

    // Values must persist on reload (i.e. they are part of the stored entries).
    const reloaded = await db.getDocument(docs[7].getId());
    expect(reloaded.getData()).toMatchObject({ type: "note", title: "Note 7", position: 7 });

    // All documents are visible in the index.
    const allIds = await db.getAllDocumentIds();
    for (const doc of docs) {
      expect(allIds).toContain(doc.getId());
    }
  }, 30000);

  it("creates custom-id documents WITH initialValues in one batch (bulk-only extension)", async () => {
    const docs = await db.createDocuments([
      { id: "BulkSettings", initialValues: { theme: "dark" } },
      { id: "BulkProfile", initialValues: { name: "ACME" } },
    ]);
    expect(docs[0].getId()).toBe("BulkSettings");
    expect(docs[0].getData().theme).toBe("dark");
    expect(docs[1].getId()).toBe("BulkProfile");
    expect(docs[1].getData().name).toBe("ACME");

    // Persisted state must contain the values (create seed + value change).
    const reloaded = await db.getDocument("BulkSettings");
    expect(reloaded.getData().theme).toBe("dark");
  }, 30000);

  it("keeps custom-id documents mergeable with single-create replicas (shared seed ancestry)", async () => {
    const [doc] = await db.createDocuments([
      { id: "SharedAncestry", initialValues: { origin: "bulk" } },
    ]);
    // The document's first change must be the deterministic seed change, so
    // a doc_create entry id identical to the single-create path is produced.
    const singleCreated = await db.createDocument({ id: "SharedAncestry" });
    // Idempotent: returns the same document rather than diverging.
    expect(singleCreated.getId()).toBe(doc.getId());
    expect(singleCreated.getData().origin).toBe("bulk");
  }, 30000);

  it("is idempotent for existing custom ids and applies initialValues as follow-up change", async () => {
    const first = await db.createDocument({ id: "ExistingDoc" });
    await db.changeDoc(first, (d) => {
      (d.getData() as Record<string, unknown>).counter = 1;
    });

    const [again] = await db.createDocuments([
      { id: "ExistingDoc", initialValues: { extra: "value" } },
    ]);
    expect(again.getId()).toBe("ExistingDoc");
    const data = (await db.getDocument("ExistingDoc")).getData();
    // Existing state is preserved, initialValues applied on top.
    expect(data.counter).toBe(1);
    expect(data.extra).toBe("value");
  }, 30000);

  it("ignores reserved/internal field names and undefined values in bulk initialValues", async () => {
    const [doc, customDoc] = await db.createDocuments([
      {
        initialValues: {
          _attachments: ["malicious"],
          _private: 1,
          ok: "yes",
          // Optional app fields arrive as explicit `undefined` (not a valid
          // Automerge/JSON value) and must be treated as "not set".
          skipped: undefined,
        } as Record<string, unknown>,
      },
      { id: "UndefinedValues", initialValues: { ok: "yes", skipped: undefined } as Record<string, unknown> },
    ]);
    const data = doc.getData();
    expect(data.ok).toBe("yes");
    expect(data._attachments).toEqual([]);
    expect(data._private).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(data, "skipped")).toBe(false);

    const customData = customDoc.getData();
    expect(customData.ok).toBe("yes");
    expect(Object.prototype.hasOwnProperty.call(customData, "skipped")).toBe(false);
  }, 30000);

  it("rejects the whole batch on an invalid custom id without writing anything", async () => {
    const before = (await db.getAllDocumentIds()).length;
    await expect(
      db.createDocuments([
        { initialValues: { a: 1 } },
        { id: "invalid id with spaces" },
      ]),
    ).rejects.toThrow(/invalid document id/i);
    expect((await db.getAllDocumentIds()).length).toBe(before);
  }, 30000);

  it("returns an empty array for an empty batch", async () => {
    await expect(db.createDocuments([])).resolves.toEqual([]);
  }, 30000);

  it("bulk-deletes documents in one batch and skips missing/deleted ones", async () => {
    const docs = await db.createDocuments(
      Array.from({ length: 10 }, (_, i) => ({ initialValues: { n: i } })),
    );
    const ids = docs.map((d) => d.getId());

    // Delete one of them up front so the bulk call has to skip it.
    await db.deleteDocument(ids[3]);

    await db.deleteDocuments([...ids, "00000000-0000-0000-0000-000000000000"]);

    const remaining = await db.getAllDocumentIds();
    for (const id of ids) {
      expect(remaining).not.toContain(id);
    }
    const deletedIds = await db.getDeletedDocumentIds();
    for (const id of ids) {
      expect(deletedIds).toContain(id);
    }
  }, 30000);

  it("bulk-deleted documents can be undeleted again", async () => {
    const [doc] = await db.createDocuments([{ initialValues: { keep: true } }]);
    await db.deleteDocuments([doc.getId()]);
    await db.undeleteDocument(doc.getId());
    const restored = await db.getDocument(doc.getId());
    expect(restored.getData().keep).toBe(true);
  }, 30000);

  it("survives a fresh reload of the database (entries fully persisted)", async () => {
    const docs = await db.createDocuments([
      { id: "ReloadCheck", initialValues: { v: 42 } },
      { initialValues: { v: 43 } },
    ]);
    const uuidDocId = docs[1].getId();

    // Re-open the database from the same tenant: state must be rebuilt from
    // the store entries alone (no reliance on the L1 cache).
    const db2 = await tenant.openDB("test-db-bulk");
    const reloadedCustom = await db2.getDocument("ReloadCheck");
    expect(reloadedCustom.getData().v).toBe(42);
    const reloadedUuid = await db2.getDocument(uuidDocId);
    expect(reloadedUuid.getData().v).toBe(43);
  }, 30000);
});
