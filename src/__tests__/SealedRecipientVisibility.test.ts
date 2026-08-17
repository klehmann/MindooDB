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

describe("sealed recipient visibility", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-vis" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
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
    await db.changeDoc(doc, (d) => {
      d.getData().secret = false;
    });
    await syncAll(fixture, "vis");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    expect(await bobDb.getAllDocumentIds()).not.toContain(doc.getId());
  });
});
