import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { formatCanonicalUsernameLabel } from "../core/userid/canonicalUsername";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

describe("sealed recipient concurrency", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-conc" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await publishUserKey(carol);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("offline remove of Bob and add of Carol both survive; remove wins a concurrent re-add", async () => {
    const db = await alice.tenant.openDB("conc");
    const doc = await db.createDocument({
      id: "shared_note",
      assumeUniqueId: true,
      recipients: [bob.username],
      initialValues: { body: "hello" },
    });
    await syncAll(fixture, "conc");

    const bobDb = await bob.tenant.openDB("conc");
    const bobDoc = await bobDb.getDocument("shared_note");

    await db.removeRecipients!(doc, [bob.username]);
    await bobDb.addRecipients!(bobDoc!, [carol.username]);

    await syncAll(fixture, "conc");
    const after = await db.getDocument("shared_note");
    const recipients = after!.getRecipients();
    const labels = recipients.map((r) => r.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        formatCanonicalUsernameLabel(alice.username),
        formatCanonicalUsernameLabel(carol.username),
      ]),
    );
    const bobLabel = formatCanonicalUsernameLabel(bob.username);
    const bobEntry = Object.values(
      (after!.getData() as { _encryptFor?: Record<string, { removedAt?: number; label?: string }> })._encryptFor ?? {},
    ).find((e) => e.label === bobLabel);
    expect(bobEntry?.removedAt).toBeDefined();
  });
});
