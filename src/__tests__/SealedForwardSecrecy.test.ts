/**
 * Cryptographic checks for sealed documents and group documents, made with a
 * dishonest replica ({@link KeyHoarder}) instead of honest-client visibility,
 * and run for every role the WRITER can be in: whoever changed the recipients,
 * a member who learned about it through sync, the same member after a restart
 * (cold session cache), and a second device of a member.
 *
 * Property under test: after a reader was removed, nothing written afterwards
 * by ANY remaining member is decryptable with ANYTHING the removed reader ever
 * held. And for readers added with `history: "none"`: nothing written before.
 */
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { USER_DIRECTORY_DB_ID, type MindooDB, type MindooTenant } from "../core/types";
import { KeyHoarder } from "./_helpers/adversary";
import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

type WriterRole = "changed the recipients" | "learned by sync" | "learned by sync, restarted" | "second device";
const ROLES: WriterRole[] = ["changed the recipients", "learned by sync", "learned by sync, restarted", "second device"];

describe("sealed documents: what a removed or late reader can decrypt", () => {
  jest.setTimeout(600000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;
  let carolPhone: DeviceHandle;
  let dave: DeviceHandle;
  let counter = 0;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-forward-secrecy" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "laptop");
    dave = await addPerson(fixture, "dave", "laptop");
    await syncAll(fixture, "directory");
    for (const device of [alice, bob, carol, dave]) await publishUserKey(device);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    // Carol's second device: she approves it, so it holds her User-Key.
    carolPhone = await addDevice(fixture, carol, "carol-phone");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    carol.tenant.noteUserDirectoryFetched!();
    await carol.tenant.reconcileUserKeys!();
    const pending = (await carol.tenant.listPendingUserKeyDevices!()).find((p) => p.label === "carol-phone");
    await carol.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    carolPhone.tenant.noteUserDirectoryFetched!();
    await carolPhone.tenant.reconcileUserKeys!();
  });

  /** A fresh session of `device` on the same stores: nothing in the session key cache. */
  async function restarted(device: DeviceHandle): Promise<MindooTenant> {
    const factory = new BaseMindooTenantFactory(device.storeFactory, fixture.crypto);
    const tenant = await factory.openTenant(
      fixture.tenantId,
      fixture.adminUser.userSigningKeyPair.publicKey,
      fixture.adminUser.userEncryptionKeyPair.publicKey,
      device.user,
      device.password,
      device.keyBag,
    );
    await tenant.openDB(USER_DIRECTORY_DB_ID);
    await tenant.reconcileUserKeys!();
    return tenant;
  }

  /** The database the writer of `role` writes through (Alice changes recipients, Carol is the other member). */
  async function writerDb(role: WriterRole, dbId: string): Promise<MindooDB> {
    if (role === "changed the recipients") return alice.tenant.openDB(dbId);
    if (role === "learned by sync") return carol.tenant.openDB(dbId);
    if (role === "second device") return carolPhone.tenant.openDB(dbId);
    return (await restarted(carol)).openDB(dbId);
  }

  async function entryIds(hoarder: KeyHoarder, dbId: string, docId: string): Promise<Set<string>> {
    return new Set((await hoarder.entriesOf(dbId, docId)).map((entry) => entry.id));
  }

  describe.each(ROLES)("writer %s", (role) => {
    it("group document: messages written after a removal are not decryptable for the removed member", async () => {
      const dbId = `fs-group-${counter++}`;
      const db = await alice.tenant.openDB(dbId);
      const group = await db.createDocument({ recipients: [bob.username, carol.username], initialValues: { n: 1 } });
      const before = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "before" } });
      await syncAll(fixture, dbId);

      const evilBob = new KeyHoarder(bob);
      await (await bob.tenant.openDB(dbId)).syncStoreChanges();
      await evilBob.harvest(dbId, group.getId());
      // Control: the helper really decrypts what Bob was allowed to read.
      const beforeEntries = await evilBob.readableEntries(dbId, before.getId());
      expect(beforeEntries.length).toBeGreaterThan(0);
      expect(beforeEntries.every((entry) => entry.readable)).toBe(true);

      await db.removeRecipients!(group, [bob.username]);
      await syncAll(fixture, dbId);

      const writer = await writerDb(role, dbId);
      await writer.syncStoreChanges();
      const after = await writer.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "after" } });
      await syncAll(fixture, dbId);
      await evilBob.harvest(dbId, group.getId());

      const afterEntries = await evilBob.readableEntries(dbId, after.getId());
      expect(afterEntries.length).toBeGreaterThan(0);
      expect(afterEntries.filter((entry) => entry.readable)).toEqual([]);

      // Control: a remaining member's keys open it.
      const member = new KeyHoarder(carol);
      await member.harvest(dbId, group.getId());
      expect((await member.readableEntries(dbId, after.getId())).every((entry) => entry.readable)).toBe(true);
    });

    it("sealed document: changes written after a removal are not decryptable for the removed reader", async () => {
      const dbId = `fs-doc-${counter++}`;
      const db = await alice.tenant.openDB(dbId);
      const doc = await db.createDocument({ recipients: [bob.username, carol.username], initialValues: { text: "v1" } });
      await syncAll(fixture, dbId);

      const evilBob = new KeyHoarder(bob);
      await (await bob.tenant.openDB(dbId)).syncStoreChanges();
      await evilBob.harvest(dbId, doc.getId());
      expect((await evilBob.readableEntries(dbId, doc.getId())).every((entry) => entry.readable)).toBe(true);

      await db.removeRecipients!(doc, [bob.username]);
      await syncAll(fixture, dbId);
      const known = await entryIds(evilBob, dbId, doc.getId());

      const writer = await writerDb(role, dbId);
      await writer.syncStoreChanges();
      await writer.changeDoc(await writer.getDocument(doc.getId()), (d) => {
        d.getData().text = "secret after removal";
      });
      await syncAll(fixture, dbId);
      await evilBob.harvest(dbId, doc.getId());

      const written = await evilBob.newEntryIds(dbId, doc.getId(), known);
      expect(written.length).toBeGreaterThan(0);
      for (const id of written) {
        expect(await evilBob.canDecryptEntry(dbId, id)).toBe(false);
      }
    });

    it("group document: a member added with history none cannot decrypt older messages, whoever re-seals later", async () => {
      const dbId = `fs-late-${counter++}`;
      const db = await alice.tenant.openDB(dbId);
      const group = await db.createDocument({ recipients: [bob.username, carol.username], initialValues: { n: 1 } });
      const old = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "old" } });
      await syncAll(fixture, dbId);

      await db.addRecipients!(group, [dave.username], { history: "none" });
      await syncAll(fixture, dbId);

      // Any member with the whole history may change the list afterwards.
      const writer = await writerDb(role, dbId);
      await writer.syncStoreChanges();
      await writer.removeRecipients!(await writer.getDocument(group.getId()), [bob.username]);
      const fresh = await writer.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "fresh" } });
      await syncAll(fixture, dbId);

      const evilDave = new KeyHoarder(dave);
      await (await dave.tenant.openDB(dbId)).syncStoreChanges();
      await evilDave.harvest(dbId, group.getId());
      expect((await evilDave.readableEntries(dbId, old.getId())).filter((entry) => entry.readable)).toEqual([]);
      expect((await evilDave.readableEntries(dbId, fresh.getId())).every((entry) => entry.readable)).toBe(true);

      await writer.revealHistory!(await writer.getDocument(group.getId()), [dave.username]);
      await syncAll(fixture, dbId);
      await evilDave.harvest(dbId, group.getId());
      expect((await evilDave.readableEntries(dbId, old.getId())).every((entry) => entry.readable)).toBe(true);
    });
  });
});
