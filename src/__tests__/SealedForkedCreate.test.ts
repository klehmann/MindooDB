/**
 * A sealed document created twice under the same id with `assumeUniqueId`
 * (two concurrent writers on one device, or two devices) has two `doc_create`
 * entries, each sealed with its own document key. Both keys have to be found:
 * before, the key series held only one, so loading the document failed with
 * SymmetricKeyNotFoundError and so did every query of its database (the
 * summary update loads every changed document and stops at the first error).
 * Seen in Haven: two runs of the internal-mail executor wrote the same
 * `ostatus_…` document at once, and the user's outbox showed nothing again.
 */
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { USER_DIRECTORY_DB_ID, type MindooDB, type MindooTenant } from "../core/types";
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

const FILTER = `v.or(v.eq(v.field("type"), v.string("outgoing")), v.eq(v.field("type"), v.string("outgoingstatus")))`;

async function rows(db: MindooDB): Promise<Array<{ docId: string; n: unknown }>> {
  const result = await db.query({ filter: FILTER, fields: ["type", "n"], limit: 100 });
  return result.rows.map((row) => ({ docId: row.docId, n: row.fields.n })).sort((a, b) => a.docId.localeCompare(b.docId));
}

describe("sealed document with two doc_create entries", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let laptop: DeviceHandle;
  let phone: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-forked-create" });
    laptop = await addPerson(fixture, "alice", "laptop");
    await syncAll(fixture, "directory");
    await publishUserKey(laptop);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    phone = await addDevice(fixture, laptop, "alice-phone");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    laptop.tenant.noteUserDirectoryFetched!();
    await laptop.tenant.reconcileUserKeys!();
    const pending = (await laptop.tenant.listPendingUserKeyDevices!()).find((p) => p.label === "alice-phone");
    await laptop.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    phone.tenant.noteUserDirectoryFetched!();
    await phone.tenant.reconcileUserKeys!();
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

  it("stays readable and queryable on the writer, after a restart and on another device", async () => {
    const db = await laptop.tenant.openDB("outbox");
    const id = "ostatus_forked";
    const create = (n: string) =>
      db.createDocument({ id, assumeUniqueId: true, recipients: [laptop.username], initialValues: { type: "outgoingstatus", n } });
    await Promise.all([create("one"), create("two")]);
    const creates = (await db.getStore().findNewEntriesForDoc([], id)).filter((m) => m.entryType === "doc_create");
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((m) => m.recipients?.bundle)).size).toBe(2);

    await db.createDocument({ id: "mout_first", assumeUniqueId: true, recipients: [laptop.username], initialValues: { type: "outgoing", n: "first" } });
    await syncAll(fixture, "outbox");
    const phoneDb = await phone.tenant.openDB("outbox");
    await phoneDb.createDocument({ id: "mout_phone", assumeUniqueId: true, recipients: [laptop.username], initialValues: { type: "outgoing", n: "phone" } });
    await syncAll(fixture, "outbox");

    const expected = ["mout_first", "mout_phone", id];
    expect((await rows(db)).map((row) => row.docId)).toEqual(expected);
    expect((await rows(phoneDb)).map((row) => row.docId)).toEqual(expected);
    expect(["one", "two"]).toContain((await phoneDb.getDocument(id)).getData().n);

    const cold = await (await restarted(laptop)).openDB("outbox");
    expect((await rows(cold)).map((row) => row.docId)).toEqual(expected);
    // Both devices converge on the same value, and the document can still be changed.
    expect((await cold.getDocument(id)).getData().n).toBe((await phoneDb.getDocument(id)).getData().n);
    await cold.changeDoc(await cold.getDocument(id), (d) => {
      d.getData().state = "sent";
    });
    expect((await cold.getDocument(id)).getData().state).toBe("sent");
  });
});
