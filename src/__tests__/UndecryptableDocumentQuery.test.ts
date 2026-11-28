/**
 * Delegation per account: Hedy may read the group of Ada's Stalwart account,
 * not the group of Ada's Mindoo Mail account, and both live in one database.
 * Documents she cannot decrypt must drop out of her queries instead of making
 * every query of the database fail with SymmetricKeyNotFoundError.
 */
import { SymmetricKeyNotFoundError } from "../core/errors";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { addPerson, makeTenant, syncAll, type DeviceHandle, type MultiDeviceFixture } from "./_helpers/multiDevice";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

const FILTER = `v.eq(v.field("type"), v.string("mail"))`;

describe("documents a replica cannot decrypt and queries", () => {
  jest.setTimeout(240000);
  let fixture: MultiDeviceFixture;
  let ada: DeviceHandle;
  let hedy: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-undecryptable-query" });
    ada = await addPerson(fixture, "ada", "laptop");
    hedy = await addPerson(fixture, "hedy", "pc");
    await syncAll(fixture, "directory");
    await publishUserKey(ada);
    await publishUserKey(hedy);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    ada.tenant.noteUserDirectoryFetched!();
    await ada.tenant.reconcileUserKeys!();
    hedy.tenant.noteUserDirectoryFetched!();
    await hedy.tenant.reconcileUserKeys!();
  });

  it("queries the delegated account's documents and skips the other account's", async () => {
    const db = await ada.tenant.openDB("mail");
    const own = await db.createDocument({ id: "group_mindoomail", assumeUniqueId: true, recipients: [ada.username], initialValues: { type: "group" } });
    const shared = await db.createDocument({ id: "group_stalwart", assumeUniqueId: true, recipients: [ada.username, hedy.username], initialValues: { type: "group" } });
    for (let i = 0; i < 3; i++) {
      await db.createDocument({ id: `mm_${i}`, assumeUniqueId: true, groupKeyDocId: own.getId(), initialValues: { type: "mail", n: `mm${i}` } });
      await db.createDocument({ id: `st_${i}`, assumeUniqueId: true, groupKeyDocId: shared.getId(), initialValues: { type: "mail", n: `st${i}` } });
    }
    await syncAll(fixture, "mail");

    const hedyDb = await hedy.tenant.openDB("mail");
    await hedyDb.syncStoreChanges();
    const result = await hedyDb.query({ filter: FILTER, fields: ["n"], limit: 100 });
    expect(result.rows.map((row) => row.docId).sort()).toEqual(["st_0", "st_1", "st_2"]);
  });
});

describe("delegation of one account, granted afterwards with history", () => {
  jest.setTimeout(240000);

  it("lets the delegate query the shared account while the other account's group and deposit key stay closed", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-undecryptable-delegation" });
    const ada = await addPerson(fixture, "ada", "laptop");
    const hedy = await addPerson(fixture, "hedy", "pc");
    await syncAll(fixture, "directory");
    for (const device of [ada, hedy]) await publishUserKey(device);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    for (const device of [ada, hedy]) {
      device.tenant.noteUserDirectoryFetched!();
      await device.tenant.reconcileUserKeys!();
    }

    const db = await ada.tenant.openDB("mailbox");
    const stalwart = await db.createDocument({ id: "mgrp_a", assumeUniqueId: true, recipients: [ada.username], initialValues: { type: "group" } });
    const mindooMail = await db.createDocument({ id: "mgrp_b", assumeUniqueId: true, recipients: [ada.username], initialValues: { type: "group" } });
    await db.createDocument({ id: "dkey_b", assumeUniqueId: true, groupKeyDocId: mindooMail.getId(), initialValues: { type: "depositkey" } });
    for (let i = 0; i < 2; i++) {
      await db.createDocument({ id: `a_${i}`, assumeUniqueId: true, groupKeyDocId: stalwart.getId(), initialValues: { type: "mail", n: `a${i}` } });
      await db.createDocument({ id: `b_${i}`, assumeUniqueId: true, groupKeyDocId: mindooMail.getId(), initialValues: { type: "mail", n: `b${i}` } });
    }
    await db.addRecipients!(await db.getDocument(stalwart.getId()), [hedy.username], { history: "all" });
    await syncAll(fixture, "mailbox");

    const hedyDb = await hedy.tenant.openDB("mailbox");
    await hedyDb.syncStoreChanges();
    const all = await hedyDb.query({ fields: ["type"], limit: 100 });
    expect(all.rows.map((row) => row.docId).sort()).toEqual(["a_0", "a_1", "mgrp_a"]);
    const mails = await hedyDb.query({ filter: FILTER, fields: ["n"], limit: 100 });
    expect(mails.rows.map((row) => row.docId).sort()).toEqual(["a_0", "a_1"]);
  });
});

describe("a readable-looking document whose key is missing", () => {
  jest.setTimeout(240000);

  it("drops out of queries, full-text and listings; the others stay queryable", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-undecryptable-load" });
    const alice = await addPerson(fixture, "alice", "laptop");
    const bob = await addPerson(fixture, "bob", "pc");
    await syncAll(fixture, "directory");
    const db = await alice.tenant.openDB("notes");
    for (const id of ["n_1", "n_2", "n_3"]) {
      await db.createDocument({ id, assumeUniqueId: true, initialValues: { type: "mail", n: id, text: `hello ${id}` } });
    }
    await syncAll(fixture, "notes");

    const bobDb = await bob.tenant.openDB("notes");
    await bobDb.syncStoreChanges();
    // The index says n_2 is readable, its load finds no key (as with a key
    // series that only partly arrived).
    const internals = bobDb as unknown as {
      docCache: Map<string, unknown>;
      loadDocumentInternal: (docId: string, ...rest: unknown[]) => Promise<unknown>;
    };
    internals.docCache.clear();
    const load = internals.loadDocumentInternal.bind(bobDb);
    internals.loadDocumentInternal = async (docId: string, ...rest: unknown[]) => {
      if (docId === "n_2") throw new SymmetricKeyNotFoundError("$sealed:group_other");
      return load(docId, ...rest);
    };

    const result = await bobDb.query({ filter: FILTER, fields: ["n"], limit: 100 });
    expect(result.rows.map((row) => row.docId).sort()).toEqual(["n_1", "n_3"]);
    expect(await bobDb.getAllDocumentIds()).not.toContain("n_2");
    expect(bobDb.getInaccessibleDocumentCount?.()).toBe(1);
  });
});
