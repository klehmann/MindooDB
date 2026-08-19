import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { isSealedKeyId } from "../core/userkeys/sealedTypes";

describe("sealed document recipients", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-create" });
    alice = await addPerson(fixture, "alice", "laptop");
    await alice.factory.ensureUserKeyPair!(alice.user, alice.password);
    await syncAll(fixture, "directory");
    alice.tenant.noteUserDirectoryFetched!();
    await alice.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("recipients: [] seals only to the author", async () => {
    const db = await alice.tenant.openDB("prefs");
    const doc = await db.createDocument({ recipients: [] });
    expect(doc.isSealed()).toBe(true);
    expect(isSealedKeyId(doc.getDecryptionKeyId())).toBe(true);
    expect(doc.getRecipients()).toHaveLength(1);
    expect(doc.getRecipients()[0].label).toBe(alice.username);
  });

  it("named recipients can read; others cannot", async () => {
    const bob = await addPerson(fixture, "bob", "desk");
    await bob.factory.ensureUserKeyPair!(bob.user, bob.password);
    await syncAll(fixture, "directory");
    bob.tenant.noteUserDirectoryFetched!();
    await bob.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const db = await alice.tenant.openDB("shared");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    await syncAll(fixture, "shared");
    const bobDb = await bob.tenant.openDB("shared");
    const bobDoc = await bobDb.getDocument(doc.getId());
    expect(bobDoc.getData().n).toBe(1);

    const carol = await addPerson(fixture, "carol", "phone");
    await carol.factory.ensureUserKeyPair!(carol.user, carol.password);
    await syncAll(fixture, "directory");
    carol.tenant.noteUserDirectoryFetched!();
    await carol.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    await syncAll(fixture, "shared");
    const carolDb = await carol.tenant.openDB("shared");
    expect(await carolDb.getAllDocumentIds()).not.toContain(doc.getId());
  });

  it("iterateDocumentHistory decrypts after the session DEK is dropped", async () => {
    const db = await alice.tenant.openDB("history-sealed");
    const doc = await db.createDocument({
      recipients: [],
      initialValues: { n: 7 },
    });
    alice.tenant.rememberSealedGenerations!(doc.getDecryptionKeyId(), []);
    const history: Array<{ n: unknown }> = [];
    for await (const entry of db.iterateDocumentHistory(doc.getId())) {
      history.push({ n: entry.doc.getData().n });
    }
    expect(history).toEqual([{ n: 7 }]);
  });

  it("named recipients can iterate history without a session DEK", async () => {
    const bob = await addPerson(fixture, "bob-history", "desk");
    await bob.factory.ensureUserKeyPair!(bob.user, bob.password);
    await syncAll(fixture, "directory");
    bob.tenant.noteUserDirectoryFetched!();
    await bob.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const db = await alice.tenant.openDB("shared-history");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 2 },
    });
    await syncAll(fixture, "shared-history");
    const bobDb = await bob.tenant.openDB("shared-history");
    const history: Array<{ n: unknown }> = [];
    for await (const entry of bobDb.iterateDocumentHistory(doc.getId())) {
      history.push({ n: entry.doc.getData().n });
    }
    expect(history).toEqual([{ n: 2 }]);
  });

  it("rejects an empty list with includeSelf: false", async () => {
    const db = await alice.tenant.openDB("dropbox");
    await expect(
      db.createDocument({
        recipients: [],
        recipientOptions: { includeSelf: false },
      }),
    ).rejects.toThrow(/nobody can read/);
  });

  it("rejects a username that cannot be canonicalized", async () => {
    const db = await alice.tenant.openDB("bare-names");
    await expect(
      db.createDocument({
        recipients: ["hr"],
      }),
    ).rejects.toThrow(/organization/i);
  });
});
