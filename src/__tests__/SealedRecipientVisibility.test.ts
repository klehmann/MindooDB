import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID, type MindooDB, type StoreEntry } from "../core/types";
import { newestRecipientBlock } from "../core/userkeys/recipients";
import { ColumnSorting, VirtualViewFactory } from "../core/indexing/virtualviews";
import { DocumentNotFoundError } from "../core/errors";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

async function publishedFingerprint(device: DeviceHandle): Promise<string> {
  const published = await device.tenant.getUserKeyManager().publishedUserKeyFor(device.username);
  if (!published || published.pending) {
    throw new Error(`Expected an approved User-Key for ${device.username}`);
  }
  return published.fingerprint;
}

async function storeEntriesForDoc(db: MindooDB, docId: string): Promise<StoreEntry[]> {
  const metas = await db.getStore().findNewEntriesForDoc([], docId);
  const ordered = [...metas].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  return db.getStore().getEntries(ordered.map((meta) => meta.id));
}

function wrapFingerprints(entries: StoreEntry[]): string[] {
  const block = newestRecipientBlock(entries);
  return (block?.wraps ?? []).map((wrap) => wrap.keyFingerprint).sort();
}

describe("sealed recipient visibility", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-vis" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await publishUserKey(carol);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("writes User-Key wraps (not device identity keys) to the content-addressed store", async () => {
    const db = await alice.tenant.openDB("store-create");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    const entries = await storeEntriesForDoc(db, doc.getId());
    const create = entries.find((entry) => entry.entryType === "doc_create");
    expect(create?.recipients?.epoch).toBe(1);
    expect(create?.decryptionKeyId).toBe(`$sealed:${doc.getId()}`);
    const expected = [
      await publishedFingerprint(alice),
      await publishedFingerprint(bob),
    ].sort();
    expect(wrapFingerprints(entries)).toEqual(expected);
    expect(create?.recipients?.wraps.every((wrap) => wrap.kind === "user")).toBe(true);
  });

  it("add copies wraps without rotating; remove rotates and drops the removed wrap", async () => {
    const db = await alice.tenant.openDB("store-mutate");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    const added = await db.addRecipients!(doc, [carol.username]);
    expect(added.rotated).toBe(false);
    expect(newestRecipientBlock(await storeEntriesForDoc(db, doc.getId()))?.epoch).toBe(1);

    const removed = await db.removeRecipients!(doc, [bob.username]);
    expect(removed.rotated).toBe(true);
    const afterRemove = await storeEntriesForDoc(db, doc.getId());
    const newest = newestRecipientBlock(afterRemove);
    expect(newest?.epoch).toBe(2);
    const fingerprints = wrapFingerprints(afterRemove);
    expect(fingerprints).toContain(await publishedFingerprint(alice));
    expect(fingerprints).toContain(await publishedFingerprint(carol));
    expect(fingerprints).not.toContain(await publishedFingerprint(bob));
    expect(newest?.wraps.every((wrap) => wrap.kind === "user")).toBe(true);
    expect(fingerprints).toHaveLength(2);
  });

  it("readers can change; non-recipients and removed readers cannot", async () => {
    const db = await alice.tenant.openDB("rw");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1, department: "Restricted", rank: 1 },
    });
    await syncAll(fixture, "rw");

    const bobDb = await bob.tenant.openDB("rw");
    const bobDoc = await bobDb.getDocument(doc.getId());
    await bobDb.changeDoc(bobDoc, (target) => {
      target.getData().n = 2;
    });
    await syncAll(fixture, "rw");
    expect((await db.getDocument(doc.getId())).getData().n).toBe(2);

    const carolDb = await carol.tenant.openDB("rw");
    await carolDb.syncStoreChanges();
    expect(await carolDb.getAllDocumentIds()).not.toContain(doc.getId());
    await expect(carolDb.getDocument(doc.getId())).rejects.toThrow(DocumentNotFoundError);

    await db.removeRecipients!(doc, [bob.username]);
    await syncAll(fixture, "rw");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    expect(await bobDb.getAllDocumentIds()).not.toContain(doc.getId());
    await expect(bobDb.getDocument(doc.getId())).rejects.toThrow(DocumentNotFoundError);
    await expect(
      bobDb.changeDoc(bobDoc, (target) => {
        target.getData().n = 99;
      }),
    ).rejects.toThrow(DocumentNotFoundError);

    await db.changeDoc(doc, (target) => {
      target.getData().n = 3;
    });
    await syncAll(fixture, "rw");
    expect((await db.getDocument(doc.getId())).getData().n).toBe(3);
  });

  it("hides from the index, changefeed, and virtual views on remove, and reappears on add", async () => {
    const db = await alice.tenant.openDB("views");
    const doc = await db.createDocument({
      recipients: [],
      initialValues: { title: "Project Alpha", department: "Restricted", rank: 1 },
    });
    await syncAll(fixture, "views");
    const bobDb = await bob.tenant.openDB("views");
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("department", { sorting: ColumnSorting.ASCENDING })
      .addSortedColumn("rank", ColumnSorting.ASCENDING)
      .withDB("views", bobDb)
      .buildAndUpdate();
    expect(await bobDb.getAllDocumentIds()).toEqual([]);
    expect(view.getRoot().getChildCategories()).toHaveLength(0);

    await db.addRecipients!(doc, [bob.username]);
    await syncAll(fixture, "views");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    await view.update();
    expect(await bobDb.getAllDocumentIds()).toContain(doc.getId());
    const revealed = await bobDb.getDocument(doc.getId());
    expect(revealed.isAccessible()).toBe(true);
    expect(revealed.getData().title).toBe("Project Alpha");
    expect(view.getRoot().getChildCategories().map((entry) => entry.getCategoryValue())).toEqual([
      "Restricted",
    ]);
    expect(view.getRoot().getChildCategories()[0].getChildDocuments()).toHaveLength(1);

    const beforePurgeCursor = bobDb.getLatestChangeCursor?.() ?? null;
    await db.removeRecipients!(doc, [bob.username]);
    await syncAll(fixture, "views");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    await view.update();

    expect(await bobDb.getAllDocumentIds()).not.toContain(doc.getId());
    await expect(bobDb.getDocument(doc.getId())).rejects.toThrow(DocumentNotFoundError);
    expect(view.getRoot().getChildCategories()).toHaveLength(0);

    const purgeChanges = [];
    for await (const change of bobDb.iterateChangesSince(beforePurgeCursor)) {
      purgeChanges.push(change);
    }
    expect(purgeChanges.some((change) => change.doc.getId() === doc.getId())).toBe(true);
    const tombstone = purgeChanges.find((change) => change.doc.getId() === doc.getId())!;
    expect(tombstone.doc.isDeleted()).toBe(true);
    expect(tombstone.doc.isAccessible()).toBe(false);
    expect(tombstone.doc.getData()).toEqual({});

    await db.addRecipients!(doc, [bob.username]);
    await syncAll(fixture, "views");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    await view.update();
    expect(await bobDb.getAllDocumentIds()).toContain(doc.getId());
    expect((await bobDb.getDocument(doc.getId())).getData().title).toBe("Project Alpha");
    expect(view.getRoot().getChildCategories()[0].getChildDocuments().map((entry) => entry.docId)).toEqual([
      doc.getId(),
    ]);
  });

  it("reconcileKeyVisibility reveals on add and hides on remove", async () => {
    const db = await alice.tenant.openDB("vis");
    const doc = await db.createDocument({
      recipients: [],
      initialValues: { secret: true },
    });
    await syncAll(fixture, "vis");
    const bobDb = await bob.tenant.openDB("vis");
    expect(await bobDb.getAllDocumentIds()).toEqual([]);

    await db.addRecipients!(doc, [bob.username]);
    await syncAll(fixture, "vis");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    expect(await bobDb.getAllDocumentIds()).toContain(doc.getId());

    await db.removeRecipients!(doc, [bob.username]);
    await syncAll(fixture, "vis");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    expect(await bobDb.getAllDocumentIds()).not.toContain(doc.getId());
  });
});
