/**
 * Deposit keys (userkeys/depositKeys.ts, docs/userkeys.md §6.8): a depositor
 * seals deliveries to a group's deposit key, which it cannot read itself; the
 * group's members read them, including members added later (with the history),
 * and members removed from the group lose them like any group document.
 */
import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID, type MindooDB } from "../core/types";
import { DocumentNotFoundError } from "../core/errors";
import { depositKeyDocId } from "../core/userkeys/depositKeys";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

async function visibleIds(db: MindooDB): Promise<string[]> {
  await db.syncStoreChanges();
  return (await db.getAllDocumentIds()).sort();
}

let counter = 0;
async function deliver(db: MindooDB, publicKeyPem: string, text: string): Promise<string> {
  const id = `memo_t${++counter}`;
  await db.createDocument({
    id,
    assumeUniqueId: true,
    recipients: [{ devicePem: publicKeyPem, label: "mbox" }],
    recipientOptions: { includeSelf: false },
    initialValues: { text },
  });
  return id;
}

async function textOf(db: MindooDB, id: string): Promise<string> {
  return String((await db.getDocument(id)).getData().text);
}

describe("group deposit keys", () => {
  jest.setTimeout(300000);

  let fixture: MultiDeviceFixture;
  let jane: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;
  let gateway: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-deposit-keys" });
    jane = await addPerson(fixture, "jane", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    gateway = await addPerson(fixture, "gateway", "server");
    await syncAll(fixture, "directory");
    for (const device of [jane, bob, carol, gateway]) await publishUserKey(device);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("members read deliveries, the depositor and outsiders do not", async () => {
    const dbId = "mbox-basic";
    const db = await jane.tenant.openDB(dbId);
    const group = await db.createDocument({ recipients: [], initialValues: { name: "Mailbox" } });
    const key = await db.createDepositKey!(group.getId());
    expect(key.docId).toBe(depositKeyDocId(key.fingerprint));
    expect((await db.listDepositKeys!()).map((k) => k.fingerprint)).toEqual([key.fingerprint]);
    await syncAll(fixture, dbId);

    const gatewayDb = await gateway.tenant.openDB(dbId);
    // The depositor sees neither the group nor the deposit key.
    expect(await visibleIds(gatewayDb)).toEqual([]);
    const memo = await deliver(gatewayDb, key.publicKeyPem, "hello jane");
    await syncAll(fixture, dbId);

    expect(await visibleIds(db)).toContain(memo);
    expect(await textOf(db, memo)).toBe("hello jane");
    // Not readable for a non-member. (The writing session itself keeps the
    // document key it generated until it is restarted, as for every
    // `includeSelf: false` document; it had the plaintext anyway.)
    const carolDb = await carol.tenant.openDB(dbId);
    expect(await visibleIds(carolDb)).toEqual([]);
    await expect(carolDb.getDocument(memo)).rejects.toThrow(DocumentNotFoundError);
  });

  it("a member added with the history reads earlier and later deliveries, in one first sync", async () => {
    const dbId = "mbox-add";
    const db = await jane.tenant.openDB(dbId);
    const group = await db.createDocument({ recipients: [], initialValues: { name: "Mailbox" } });
    const key = await db.createDepositKey!(group.getId());
    await syncAll(fixture, dbId);
    const gatewayDb = await gateway.tenant.openDB(dbId);
    const early = await deliver(gatewayDb, key.publicKeyPem, "early");
    await syncAll(fixture, dbId);

    await db.addRecipients!(group, [bob.username]);
    const late = await deliver(gatewayDb, key.publicKeyPem, "late");
    await syncAll(fixture, dbId);

    const bobDb = await bob.tenant.openDB(dbId);
    const ids = await visibleIds(bobDb);
    expect(ids).toEqual(expect.arrayContaining([group.getId(), key.docId, early, late]));
    expect(await textOf(bobDb, early)).toBe("early");
    expect(await textOf(bobDb, late)).toBe("late");
  });

  it("a member added without the history reads only deliveries to a newer deposit key", async () => {
    const dbId = "mbox-nohistory";
    const db = await jane.tenant.openDB(dbId);
    const group = await db.createDocument({ recipients: [], initialValues: { name: "Mailbox" } });
    const oldKey = await db.createDepositKey!(group.getId());
    await syncAll(fixture, dbId);
    const gatewayDb = await gateway.tenant.openDB(dbId);
    const before = await deliver(gatewayDb, oldKey.publicKeyPem, "before");
    await syncAll(fixture, dbId);

    await db.addRecipients!(group, [carol.username], { history: "none" });
    const newKey = await db.createDepositKey!(group.getId());
    await syncAll(fixture, dbId);
    const after = await deliver(gatewayDb, newKey.publicKeyPem, "after");
    await syncAll(fixture, dbId);

    const carolDb = await carol.tenant.openDB(dbId);
    const ids = await visibleIds(carolDb);
    expect(ids).toContain(after);
    expect(ids).toContain(newKey.docId);
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(oldKey.docId);
    expect(await textOf(carolDb, after)).toBe("after");
    // Jane reads both.
    expect(await textOf(db, before)).toBe("before");
    expect(await textOf(db, after)).toBe("after");
    expect((await db.listDepositKeys!(group.getId())).map((k) => k.fingerprint).sort()).toEqual(
      [oldKey.fingerprint, newKey.fingerprint].sort(),
    );
  });

  it("a removed member loses the deliveries; the others keep them, also those sent to the old key", async () => {
    const dbId = "mbox-remove";
    const db = await jane.tenant.openDB(dbId);
    const group = await db.createDocument({ recipients: [bob.username], initialValues: { name: "Mailbox" } });
    const oldKey = await db.createDepositKey!(group.getId());
    await syncAll(fixture, dbId);
    const gatewayDb = await gateway.tenant.openDB(dbId);
    const first = await deliver(gatewayDb, oldKey.publicKeyPem, "first");
    await syncAll(fixture, dbId);

    const bobDb = await bob.tenant.openDB(dbId);
    expect(await visibleIds(bobDb)).toContain(first);
    expect(await textOf(bobDb, first)).toBe("first");

    const removed = await db.removeRecipients!(group, [bob.username]);
    expect(removed.rotated).toBe(true);
    const newKey = await db.createDepositKey!(group.getId());
    // A gateway that has not seen the new key yet still delivers to the old one.
    const stale = await deliver(gatewayDb, oldKey.publicKeyPem, "stale");
    const fresh = await deliver(gatewayDb, newKey.publicKeyPem, "fresh");
    await syncAll(fixture, dbId);

    const bobIds = await visibleIds(bobDb);
    expect(bobIds).not.toContain(group.getId());
    expect(bobIds).not.toContain(first);
    expect(bobIds).not.toContain(fresh);
    await expect(bobDb.getDocument(first)).rejects.toThrow(DocumentNotFoundError);

    expect(await textOf(db, first)).toBe("first");
    expect(await textOf(db, stale)).toBe("stale");
    expect(await textOf(db, fresh)).toBe("fresh");
  });

  it("refuses a deposit key document whose id does not match its key", async () => {
    const dbId = "mbox-forged";
    const db = await jane.tenant.openDB(dbId);
    const group = await db.createDocument({ recipients: [bob.username], initialValues: { name: "Mailbox" } });
    const real = await db.createDepositKey!(group.getId());
    const other = await db.createDepositKey!(group.getId());
    // A member plants a document under the real key's id with another key pair.
    const bobDb = await bob.tenant.openDB(dbId);
    await syncAll(fixture, dbId);
    const otherData = (await db.getDocument(other.docId)).getData() as Record<string, unknown>;
    const forgedId = depositKeyDocId("00:11:22:33:44:55:66:77");
    await bobDb.createDocument({
      id: forgedId,
      assumeUniqueId: true,
      groupKeyDocId: group.getId(),
      initialValues: { ...otherData, fingerprint: "00:11:22:33:44:55:66:77" },
    });
    await syncAll(fixture, dbId);
    const listed = (await db.listDepositKeys!(group.getId())).map((k) => k.docId);
    expect(listed).toEqual(expect.arrayContaining([real.docId, other.docId]));
    expect(listed).not.toContain(forgedId);
  });
});
