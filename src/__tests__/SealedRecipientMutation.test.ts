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

describe("sealed recipient mutation", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-mut" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await publishUserKey(carol);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("add grants the whole history without rotating; remove rotates", async () => {
    const db = await alice.tenant.openDB("share");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    await db.changeDoc(doc, (d) => {
      d.getData().n = 2;
    });
    const added = await db.addRecipients!(doc, [carol.username]);
    expect(added.rotated).toBe(false);
    expect(added.added.length).toBeGreaterThan(0);

    await syncAll(fixture, "share");
    const carolDb = await carol.tenant.openDB("share");
    const carolDoc = await carolDb.getDocument(doc.getId());
    expect(carolDoc.getData().n).toBe(2);

    const removed = await db.removeRecipients!(doc, [bob.username]);
    expect(removed.rotated).toBe(true);
    expect(doc.getRecipients().map((r) => r.label)).not.toContain(bob.username);
    await db.changeDoc(doc, (d) => {
      d.getData().n = 3;
    });
    await syncAll(fixture, "share");
    const bobDb = await bob.tenant.openDB("share");
    await bobDb.syncStoreChanges();
    await bobDb.reconcileKeyVisibility();
    await expect(bobDb.getDocument(doc.getId())).rejects.toThrow();
    expect(await bobDb.getAllDocumentIds()).not.toContain(doc.getId());
  });

  it("setRecipients diffs adds and removes", async () => {
    const db = await alice.tenant.openDB("set");
    const doc = await db.createDocument({
      recipients: [bob.username],
    });
    const result = await db.setRecipients!(doc, [carol.username]);
    expect(result.rotated).toBe(true);
    const labels = doc.getRecipients().map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining([alice.username, carol.username]));
    expect(labels).not.toContain(bob.username);
  });

  it("canonicalizes mixed-case usernames in _encryptFor and isEncryptedFor", async () => {
    const db = await alice.tenant.openDB("canon");
    const doc = await db.createDocument({
      recipients: [`cn=${bob.username.split("/")[0].slice(3)}/o=${fixture.tenantId.toUpperCase()}`],
    });
    const canonicalBob = `CN=bob/O=${fixture.tenantId.toLowerCase()}`;
    const encryptFor = (doc.getData() as { _encryptFor: Record<string, unknown> })._encryptFor;
    expect(encryptFor[canonicalBob]).toBeDefined();
    expect(doc.isEncryptedFor(bob.username)).toBe(true);
    expect(doc.isEncryptedFor([`cn=bob/o=${fixture.tenantId}`, alice.username])).toBe(true);
    expect(doc.isEncryptedFor(carol.username)).toBe(false);
    expect(() => doc.isEncryptedFor("bob")).toThrow(/organization/i);

    await db.addRecipients!(doc, [`cn=carol/o=${fixture.tenantId}`]);
    expect(doc.isEncryptedFor([`cn=carol/o=${fixture.tenantId}`])).toBe(true);

    await db.removeRecipients!(doc, ["CN=BOB/O=" + fixture.tenantId.toUpperCase()]);
    expect(doc.isEncryptedFor(bob.username)).toBe(false);
    expect(doc.isEncryptedFor(carol.username)).toBe(true);
  });
});
