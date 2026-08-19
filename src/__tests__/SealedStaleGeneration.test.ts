import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

describe("sealed stale generation", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-stale" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("a removed reader sees the document disappear instead of a GCM exception", async () => {
    const db = await alice.tenant.openDB("stale");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { v: 1 },
    });
    await syncAll(fixture, "stale");
    const bobDb = await bob.tenant.openDB("stale");
    expect(await bobDb.getDocument(doc.getId())).toBeDefined();

    await db.removeRecipients!(doc, [bob.username]);
    await db.changeDoc(doc, (d) => {
      d.getData().v = 2;
    });
    await syncAll(fixture, "stale");
    await bobDb.syncStoreChanges();
    await expect(bobDb.getDocument(doc.getId())).rejects.toThrow();
    const ids = await bobDb.getAllDocumentIds();
    expect(ids).not.toContain(doc.getId());
  });

  it("removal alone hides the document: no follow-up content change required", async () => {
    const db = await alice.tenant.openDB("carrier");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { v: 1 },
    });
    await syncAll(fixture, "carrier");
    const bobDb = await bob.tenant.openDB("carrier");
    expect(await bobDb.getAllDocumentIds()).toContain(doc.getId());

    // The recipient mutation is itself the carrier entry: it persists as a
    // doc_change encrypted under the freshly rotated generation, so the
    // removed reader has something undecryptable to sync straight away.
    await db.removeRecipients!(doc, [bob.username]);
    await syncAll(fixture, "carrier");

    // No changeDoc and no explicit reconcileKeyVisibility(): the plain sync
    // that syncAll already performed must be enough to hide the document.
    expect(await bobDb.getAllDocumentIds()).not.toContain(doc.getId());
    await expect(bobDb.getDocument(doc.getId())).rejects.toThrow();
  });
});
