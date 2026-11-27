/**
 * Two members of a group document remove the same person while offline
 * (team mailbox: every member's Haven reconciles the group document with the
 * directory group, so two may rotate at once). Both rotations survive the
 * merge; members read everything from both branches; the removed person reads
 * nothing written after the removal, in either branch or afterwards.
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

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

async function textOf(db: MindooDB, id: string): Promise<string | null> {
  await db.syncStoreChanges();
  try {
    return String((await db.getDocument(id)).getData().text);
  } catch (error) {
    if (error instanceof DocumentNotFoundError) return null;
    return `ERR ${(error as Error).name}`;
  }
}

describe("group key documents: concurrent rotation", () => {
  jest.setTimeout(300000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;
  let dave: DeviceHandle;
  let eve: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-group-rotation" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    dave = await addPerson(fixture, "dave", "tablet");
    eve = await addPerson(fixture, "eve", "watch");
    await syncAll(fixture, "directory");
    for (const device of [alice, bob, carol, dave, eve]) await publishUserKey(device);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("two members remove the same person offline: both branches stay readable for members, none for the removed", async () => {
    const dbId = "team-rotation";
    const aliceDb = await alice.tenant.openDB(dbId);
    const group = await aliceDb.createDocument({
      recipients: [bob.username, carol.username, dave.username],
      initialValues: { name: "Support" },
    });
    const before = await aliceDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "before" } });
    await syncAll(fixture, dbId);

    const bobDb = await bob.tenant.openDB(dbId);
    const carolDb = await carol.tenant.openDB(dbId);
    const daveDb = await dave.tenant.openDB(dbId);
    expect(await textOf(daveDb, before.getId())).toBe("before");

    // Offline: Alice and Bob both remove Dave and each writes a mail afterwards.
    await aliceDb.removeRecipients!(await aliceDb.getDocument(group.getId()), [dave.username]);
    const fromAlice = await aliceDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "alice after" } });
    await bobDb.syncStoreChanges();
    await bobDb.removeRecipients!(await bobDb.getDocument(group.getId()), [dave.username]);
    const fromBob = await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "bob after" } });

    await syncAll(fixture, dbId);
    await syncAll(fixture, dbId);

    // Members read both branches.
    for (const db of [aliceDb, bobDb, carolDb]) {
      expect(await textOf(db, fromAlice.getId())).toBe("alice after");
      expect(await textOf(db, fromBob.getId())).toBe("bob after");
      expect(await textOf(db, before.getId())).toBe("before");
    }
    // Dave keeps what he had, but reads nothing written after the removal.
    expect(await textOf(daveDb, fromAlice.getId())).toBeNull();
    expect(await textOf(daveDb, fromBob.getId())).toBeNull();

    // The fork is visible; any member repairs it, then nothing is left to repair.
    const need = await carolDb.recipientsNeedRepair!(await carolDb.getDocument(group.getId()));
    expect(need?.forked).toBe(true);
    await carolDb.repairRecipients!(await carolDb.getDocument(group.getId()));
    await syncAll(fixture, dbId);
    for (const db of [aliceDb, bobDb, carolDb]) {
      expect(await db.recipientsNeedRepair!(await db.getDocument(group.getId()))).toBeNull();
    }

    // Every member writes with a key Dave does not hold, and the others read it.
    const fromCarol = await carolDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "carol later" } });
    const fromAliceLater = await aliceDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "alice later" } });
    await syncAll(fixture, dbId);
    for (const db of [aliceDb, bobDb, carolDb]) {
      expect(await textOf(db, fromCarol.getId())).toBe("carol later");
      expect(await textOf(db, fromAliceLater.getId())).toBe("alice later");
    }
    expect(await textOf(daveDb, fromCarol.getId())).toBeNull();
    expect(await textOf(daveDb, fromAliceLater.getId())).toBeNull();
  });

  it("one member removes, another adds a new person offline: the newcomer reads everything, the removed nothing new", async () => {
    const dbId = "team-rotation-add";
    const aliceDb = await alice.tenant.openDB(dbId);
    const group = await aliceDb.createDocument({
      recipients: [bob.username, dave.username],
      initialValues: { name: "Sales" },
    });
    const before = await aliceDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "before" } });
    await syncAll(fixture, dbId);
    const bobDb = await bob.tenant.openDB(dbId);
    await bobDb.syncStoreChanges();

    await aliceDb.removeRecipients!(await aliceDb.getDocument(group.getId()), [dave.username]);
    const afterRemove = await aliceDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "after remove" } });
    await bobDb.addRecipients!(await bobDb.getDocument(group.getId()), [carol.username]);
    const afterAdd = await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "after add" } });

    await syncAll(fixture, dbId);
    await syncAll(fixture, dbId);

    const carolDb = await carol.tenant.openDB(dbId);
    const daveDb = await dave.tenant.openDB(dbId);
    // Alice's rotation did not know Carol: she misses a wrap until a member repairs.
    const need = await aliceDb.recipientsNeedRepair!(await aliceDb.getDocument(group.getId()));
    expect(need?.missing.some((label) => /carol/i.test(label))).toBe(true);
    await aliceDb.repairRecipients!(await aliceDb.getDocument(group.getId()));
    await syncAll(fixture, dbId);
    expect(await textOf(carolDb, before.getId())).toBe("before");
    expect(await textOf(carolDb, afterAdd.getId())).toBe("after add");
    expect(await textOf(carolDb, afterRemove.getId())).toBe("after remove");
    expect(await textOf(daveDb, afterRemove.getId())).toBeNull();

    // Bob's branch used the key from before the removal: Dave may still read
    // that one (forward cut-off only once the removal reached the writer).
    // What counts: after the merge nobody writes with a key Dave holds.
    const later = await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "later" } });
    await syncAll(fixture, dbId);
    expect(await textOf(carolDb, later.getId())).toBe("later");
    expect(await textOf(daveDb, later.getId())).toBeNull();
  });

  it("two members remove different people offline: after the repair neither removed person reads new mail", async () => {
    const dbId = "team-rotation-two-removals";
    const aliceDb = await alice.tenant.openDB(dbId);
    const group = await aliceDb.createDocument({
      recipients: [bob.username, carol.username, dave.username, eve.username],
      initialValues: { name: "Office" },
    });
    await syncAll(fixture, dbId);
    const bobDb = await bob.tenant.openDB(dbId);
    await bobDb.syncStoreChanges();

    await aliceDb.removeRecipients!(await aliceDb.getDocument(group.getId()), [dave.username]);
    await bobDb.removeRecipients!(await bobDb.getDocument(group.getId()), [eve.username]);
    await syncAll(fixture, dbId);
    await syncAll(fixture, dbId);

    const carolDb = await carol.tenant.openDB(dbId);
    const need = await carolDb.recipientsNeedRepair!(await carolDb.getDocument(group.getId()));
    expect(need).not.toBeNull();
    expect(need!.stale.length).toBe(1); // the newest block still wraps one of the two
    await carolDb.repairRecipients!(await carolDb.getDocument(group.getId()));
    await syncAll(fixture, dbId);

    const later = await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "after repair" } });
    await syncAll(fixture, dbId);
    expect(await textOf(aliceDb, later.getId())).toBe("after repair");
    expect(await textOf(carolDb, later.getId())).toBe("after repair");
    expect(await textOf(await dave.tenant.openDB(dbId), later.getId())).toBeNull();
    expect(await textOf(await eve.tenant.openDB(dbId), later.getId())).toBeNull();
  });

  it("a member added after a repair reads mail from both concurrent branches", async () => {
    const dbId = "team-rotation-late";
    const aliceDb = await alice.tenant.openDB(dbId);
    const group = await aliceDb.createDocument({ recipients: [bob.username, dave.username], initialValues: { name: "Late" } });
    await syncAll(fixture, dbId);
    const bobDb = await bob.tenant.openDB(dbId);
    await bobDb.syncStoreChanges();
    await aliceDb.removeRecipients!(await aliceDb.getDocument(group.getId()), [dave.username]);
    const a = await aliceDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "branch a" } });
    await bobDb.removeRecipients!(await bobDb.getDocument(group.getId()), [dave.username]);
    const b = await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "branch b" } });
    await syncAll(fixture, dbId);
    await syncAll(fixture, dbId);
    await aliceDb.repairRecipients!(await aliceDb.getDocument(group.getId()));
    await syncAll(fixture, dbId);
    // Eve joins later, from a block sealed after the repair.
    await bobDb.addRecipients!(await bobDb.getDocument(group.getId()), [eve.username]);
    await syncAll(fixture, dbId);
    const eveDb = await eve.tenant.openDB(dbId);
    expect(await textOf(eveDb, a.getId())).toBe("branch a");
    expect(await textOf(eveDb, b.getId())).toBe("branch b");
  });
});
