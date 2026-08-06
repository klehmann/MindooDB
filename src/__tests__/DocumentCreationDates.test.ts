import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  MindooDB,
  MindooTenant,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * `listDocumentCreationDates()` orders documents by the author time of their
 * `doc_create` entry, which the changefeed index (last-modification based)
 * cannot provide. The two properties worth pinning down are that the order is
 * chronological rather than id-collation order, and that existence/deletion is
 * evaluated for the instant the database instance represents — a document
 * deleted after a time-travel cutoff still exists at that cutoff.
 */
describe("listDocumentCreationDates", () => {
  const DB_ID = "creation-dates-db";

  let factory: BaseMindooTenantFactory;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const adminPassword = "adminpass123";
    const adminUser: PrivateUserId = await factory.createUserId(
      "CN=admin/O=creationdates",
      adminPassword,
    );
    const userPassword = "userpassword123";
    const currentUser: PrivateUserId = await factory.createUserId(
      "CN=user/O=creationdates",
      userPassword,
    );
    const keyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      userPassword,
      factory.getCryptoAdapter(),
    );

    const tenantId = "test-tenant-creation-dates";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      userPassword,
      keyBag,
    );
    const directory = await tenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(currentUser),
      adminUser.userSigningKeyPair.privateKey,
      adminPassword,
    );
    db = await tenant.openDB(DB_ID);
  }, 30000);

  afterEach(async () => {
    await (
      tenant as unknown as { disposeCacheManager?: () => Promise<void> }
    ).disposeCacheManager?.();
  });

  /** Entries carry millisecond timestamps, so separate the creates. */
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async function createNote(title: string): Promise<string> {
    const doc = await db.createDocument({ idPrefix: "note" });
    await db.changeDoc(doc, (mutable) => {
      mutable.getData().title = title;
    });
    await tick();
    return doc.getId();
  }

  it("orders documents by creation date in both directions", async () => {
    const first = await createNote("first");
    const second = await createNote("second");
    const third = await createNote("third");

    const ascending = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(ascending.map((entry) => entry.docId)).toEqual([first, second, third]);
    expect(ascending[0].createdAt).toBeLessThan(ascending[1].createdAt);
    expect(ascending[1].createdAt).toBeLessThan(ascending[2].createdAt);

    const descending = await db.listDocumentCreationDates({
      idPrefix: "note",
      order: "desc",
    });
    expect(descending.map((entry) => entry.docId)).toEqual([third, second, first]);
  }, 30000);

  it("dates a document by its creation, not by its last change", async () => {
    const first = await createNote("first");
    const second = await createNote("second");

    // Touching the older document must not move it to the end of the list.
    await db.changeDoc(await db.getDocument(first), (mutable) => {
      mutable.getData().title = "first, edited";
    });

    const listed = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(listed.map((entry) => entry.docId)).toEqual([first, second]);
  }, 30000);

  it("narrows to an id prefix", async () => {
    const note = await createNote("note");
    const other = await db.createDocument({ idPrefix: "task" });

    const listed = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(listed.map((entry) => entry.docId)).toEqual([note]);
    expect(
      (await db.listDocumentCreationDates()).map((entry) => entry.docId),
    ).toEqual(expect.arrayContaining([note, other.getId()]));
  }, 30000);

  it("separates deleted from existing documents and keeps their creation date", async () => {
    const first = await createNote("first");
    const second = await createNote("second");
    const third = await createNote("third");

    const createdAtBeforeDelete = (
      await db.listDocumentCreationDates({ idPrefix: "note" })
    ).find((entry) => entry.docId === second)!.createdAt;
    await db.deleteDocument(second);

    const existing = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(existing.map((entry) => entry.docId)).toEqual([first, third]);
    expect(existing.every((entry) => !entry.isDeleted)).toBe(true);

    const deleted = await db.listDocumentCreationDates({
      idPrefix: "note",
      include: "deleted",
    });
    expect(deleted.map((entry) => entry.docId)).toEqual([second]);
    expect(deleted[0].isDeleted).toBe(true);
    // A delete is a new entry, but the creation date is the create entry's.
    expect(deleted[0].createdAt).toBe(createdAtBeforeDelete);

    const all = await db.listDocumentCreationDates({
      idPrefix: "note",
      include: "all",
    });
    expect(all.map((entry) => entry.docId)).toEqual([first, second, third]);
    expect(all.map((entry) => entry.isDeleted)).toEqual([false, true, false]);
  }, 30000);

  it("lists an undeleted document as existing again", async () => {
    const first = await createNote("first");
    const second = await createNote("second");

    await db.deleteDocument(first);
    await db.undeleteDocument(first);

    const existing = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(existing.map((entry) => entry.docId)).toEqual([first, second]);
    expect(
      await db.listDocumentCreationDates({ idPrefix: "note", include: "deleted" }),
    ).toEqual([]);
  }, 30000);

  it("evaluates existence and deletion at a time-travel cutoff", async () => {
    const first = await createNote("first");
    const second = await createNote("second");
    await tick();
    const cutoff = Date.now();
    await tick();

    const third = await createNote("third");
    await db.deleteDocument(second);

    const liveExisting = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(liveExisting.map((entry) => entry.docId)).toEqual([first, third]);

    const historicDb = await tenant.openDB(DB_ID, { timeTravelDate: cutoff });
    // At the cutoff the third document does not exist yet, and the second one
    // is not deleted yet — its delete entry is younger than the cutoff.
    const historicExisting = await historicDb.listDocumentCreationDates({
      idPrefix: "note",
    });
    expect(historicExisting.map((entry) => entry.docId)).toEqual([first, second]);
    expect(
      await historicDb.listDocumentCreationDates({
        idPrefix: "note",
        include: "deleted",
      }),
    ).toEqual([]);
  }, 30000);

  it("lists a document deleted before the cutoff as deleted there", async () => {
    const first = await createNote("first");
    await db.deleteDocument(first);
    await tick();
    const cutoff = Date.now();
    await tick();
    await db.undeleteDocument(first);

    expect(
      (await db.listDocumentCreationDates({ idPrefix: "note" })).map(
        (entry) => entry.docId,
      ),
    ).toEqual([first]);

    const historicDb = await tenant.openDB(DB_ID, { timeTravelDate: cutoff });
    expect(await historicDb.listDocumentCreationDates({ idPrefix: "note" })).toEqual([]);
    const historicDeleted = await historicDb.listDocumentCreationDates({
      idPrefix: "note",
      include: "deleted",
    });
    expect(historicDeleted.map((entry) => entry.docId)).toEqual([first]);
  }, 30000);

  it("reads creation dates from entry metadata alone", async () => {
    await createNote("first");
    await createNote("second");

    const store = db.getStore();
    const scanSpy = jest.spyOn(store, "scanEntriesSince");
    const getEntriesSpy = jest.spyOn(store, "getEntries");

    const listed = await db.listDocumentCreationDates({ idPrefix: "note" });
    expect(listed).toHaveLength(2);

    // No payload is fetched: creation dates come from the scan filtered to the
    // origin entry types, which is what keeps this affordable over a network.
    expect(getEntriesSpy).not.toHaveBeenCalled();
    expect(scanSpy).toHaveBeenCalled();
    for (const call of scanSpy.mock.calls) {
      expect(call[2]?.entryTypes).toEqual(["doc_create", "doc_snapshot"]);
    }
  }, 30000);
});
