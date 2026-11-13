/**
 * Documents encrypted with a group document's key series (`groupKeyDocId`):
 * one sealed group document holds the members, any number of other documents in
 * the same database use its key generations. Used for chats: the group document
 * is the chat, every message is its own document.
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

async function visibleIds(db: MindooDB): Promise<string[]> {
  await db.syncStoreChanges();
  return (await db.getAllDocumentIds()).sort();
}

describe("group key documents (groupKeyDocId)", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-group-key" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await publishUserKey(carol);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("encrypts documents with the group's key series; members read them, others do not", async () => {
    const db = await alice.tenant.openDB("chat-basic");
    const group = await db.createDocument({ recipients: [bob.username], initialValues: { name: "Team" } });
    const message = await db.createDocument({
      groupKeyDocId: group.getId(),
      initialValues: { text: "hello" },
    });
    expect(message.getDecryptionKeyId()).toBe(`$sealed:${group.getId()}`);
    expect(message.isSealed()).toBe(false);
    expect(message.getGroupKeyDocId()).toBe(group.getId());
    expect(group.isSealed()).toBe(true);
    expect(group.getGroupKeyDocId()).toBeUndefined();
    await syncAll(fixture, "chat-basic");

    const bobDb = await bob.tenant.openDB("chat-basic");
    expect(await visibleIds(bobDb)).toEqual([group.getId(), message.getId()].sort());
    expect((await bobDb.getDocument(message.getId())).getData().text).toBe("hello");

    // Bob writes into the same chat with the same group key.
    const reply = await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "hi" } });
    await syncAll(fixture, "chat-basic");
    expect((await db.getDocument(reply.getId())).getData().text).toBe("hi");

    const carolDb = await carol.tenant.openDB("chat-basic");
    expect(await visibleIds(carolDb)).toEqual([]);
    await expect(carolDb.getDocument(message.getId())).rejects.toThrow(DocumentNotFoundError);
    await expect(
      carolDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "let me in" } }),
    ).rejects.toThrow(/not a member/);
  });

  it("adding a member to the group document reveals all existing documents", async () => {
    const db = await alice.tenant.openDB("chat-add");
    const group = await db.createDocument({ recipients: [bob.username], initialValues: { name: "Team" } });
    const first = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "one" } });
    const second = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "two" } });
    await syncAll(fixture, "chat-add");

    const carolDb = await carol.tenant.openDB("chat-add");
    expect(await visibleIds(carolDb)).toEqual([]);

    await db.addRecipients!(group, [carol.username]);
    await syncAll(fixture, "chat-add");
    expect(await visibleIds(carolDb)).toEqual([group.getId(), first.getId(), second.getId()].sort());
    expect((await carolDb.getDocument(first.getId())).getData().text).toBe("one");
  });

  it("removing a member rotates the group key: nothing written afterwards is readable for them", async () => {
    const db = await alice.tenant.openDB("chat-remove");
    const group = await db.createDocument({
      recipients: [bob.username, carol.username],
      initialValues: { name: "Team" },
    });
    const before = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "before" } });
    await syncAll(fixture, "chat-remove");

    const bobDb = await bob.tenant.openDB("chat-remove");
    expect(await visibleIds(bobDb)).toContain(before.getId());

    const removed = await db.removeRecipients!(group, [bob.username]);
    expect(removed.rotated).toBe(true);
    const after = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "after" } });
    await syncAll(fixture, "chat-remove");

    // Honest client: the group and everything encrypted with it disappears.
    const bobIds = await visibleIds(bobDb);
    expect(bobIds).not.toContain(after.getId());
    expect(bobIds).not.toContain(before.getId());
    expect(bobIds).not.toContain(group.getId());
    await expect(bobDb.getDocument(after.getId())).rejects.toThrow(DocumentNotFoundError);
    await expect(
      bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "still here?" } }),
    ).rejects.toThrow(/not a member/);

    // Carol stays and reads both.
    const carolDb = await carol.tenant.openDB("chat-remove");
    expect(await visibleIds(carolDb)).toEqual([group.getId(), before.getId(), after.getId()].sort());
    expect((await carolDb.getDocument(after.getId())).getData().text).toBe("after");
  });

  it("documents keep working when they arrive before their group document's newest wraps", async () => {
    const db = await alice.tenant.openDB("chat-order");
    const group = await db.createDocument({ recipients: [], initialValues: { name: "Solo" } });
    await db.addRecipients!(group, [bob.username]);
    const message = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "x" } });
    await syncAll(fixture, "chat-order");
    const bobDb = await bob.tenant.openDB("chat-order");
    expect(await visibleIds(bobDb)).toEqual([group.getId(), message.getId()].sort());
  });

  it("validates the group document and refuses recipient changes on group-encrypted documents", async () => {
    const db = await alice.tenant.openDB("chat-validate");
    const plain = await db.createDocument({ initialValues: { n: 1 } });
    await expect(
      db.createDocument({ groupKeyDocId: plain.getId(), initialValues: { text: "x" } }),
    ).rejects.toThrow(/created with recipients/);
    await expect(
      db.createDocument({ groupKeyDocId: "doesnotexist", initialValues: { text: "x" } }),
    ).rejects.toThrow(/does not exist/);

    const group = await db.createDocument({ recipients: [], initialValues: { name: "Solo" } });
    await expect(
      db.createDocument({ groupKeyDocId: group.getId(), decryptionKeyId: "default" }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      db.createDocument({ id: "m_fixed", groupKeyDocId: group.getId() }),
    ).rejects.toThrow(/convergent custom id/);

    const message = await db.createDocument({
      id: "m_random",
      assumeUniqueId: true,
      groupKeyDocId: group.getId(),
      initialValues: { text: "x" },
    });
    await expect(db.addRecipients!(message, [bob.username])).rejects.toThrow(/change the recipients there/);
  });

  it("after a rotation remaining members encrypt with the newest generation", async () => {
    const db = await alice.tenant.openDB("chat-order-gens");
    const group = await db.createDocument({ recipients: [bob.username, carol.username], initialValues: {} });
    await db.removeRecipients!(group, [bob.username]);
    await syncAll(fixture, "chat-order-gens");
    const carolDb = await carol.tenant.openDB("chat-order-gens");
    const written = await carolDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "new" } });
    expect(written.getData().text).toBe("new");
    const keyId = group.getDecryptionKeyId();
    const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
    const aliceGens = alice.tenant.getSealedGenerations!(keyId).map(hex);
    const carolGens = carol.tenant.getSealedGenerations!(keyId).map(hex);
    expect(aliceGens).toHaveLength(2);
    // Index 0 is the key new content is encrypted with: the one Bob never got.
    expect(carolGens).toEqual(aliceGens);
  });

  it("history none: new members read only what is written after they joined, until revealHistory", async () => {
    const db = await alice.tenant.openDB("chat-no-history");
    const group = await db.createDocument({ recipients: [bob.username], initialValues: { name: "Klasse" } });
    const old = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "old" } });
    await syncAll(fixture, "chat-no-history");

    const added = await db.addRecipients!(group, [carol.username], { history: "none" });
    expect(added.rotated).toBe(true);
    expect(added.added[0]?.historyFrom).toBe(2);
    const fresh = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "fresh" } });
    await syncAll(fixture, "chat-no-history");

    const carolDb = await carol.tenant.openDB("chat-no-history");
    expect(await visibleIds(carolDb)).toEqual([group.getId(), fresh.getId()].sort());
    await expect(carolDb.getDocument(old.getId())).rejects.toThrow();
    // The group document itself is readable: a snapshot under the new key.
    expect((await carolDb.getDocument(group.getId())).getData().name).toBe("Klasse");
    expect((await carolDb.getDocument(fresh.getId())).getData().text).toBe("fresh");
    const bobDb = await bob.tenant.openDB("chat-no-history");
    expect(await visibleIds(bobDb)).toEqual([group.getId(), old.getId(), fresh.getId()].sort());

    // Carol cannot re-seal with half the series.
    const carolGroup = await carolDb.getDocument(group.getId());
    await expect(carolDb.addRecipients!(carolGroup, [bob.username])).rejects.toThrow(/whole history/);

    // A later rotation by Alice keeps Carol's limit.
    await db.removeRecipients!(group, [bob.username]);
    const later = await db.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "later" } });
    await syncAll(fixture, "chat-no-history");
    expect(await visibleIds(carolDb)).toEqual([group.getId(), fresh.getId(), later.getId()].sort());
    expect(
      (await db.getDocument(group.getId())).getRecipients().find((r) => r.id.includes("carol"))?.historyFrom,
    ).toBe(2);

    // Revealed: Carol reads the whole history, no rotation.
    const revealed = await db.revealHistory!(await db.getDocument(group.getId()), [carol.username]);
    expect(revealed.rotated).toBe(false);
    await syncAll(fixture, "chat-no-history");
    expect(await visibleIds(carolDb)).toEqual([group.getId(), old.getId(), fresh.getId(), later.getId()].sort());
    expect((await carolDb.getDocument(old.getId())).getData().text).toBe("old");
    expect(
      (await db.getDocument(group.getId())).getRecipients().find((r) => r.id.includes("carol"))?.historyFrom,
    ).toBeUndefined();
  });

  it("history none twice, by different members: the second late member loads the group; late members cannot re-seal", async () => {
    const db = await alice.tenant.openDB("chat-no-history-twice");
    const group = await db.createDocument({ recipients: [bob.username], initialValues: { name: "Team" } });
    await syncAll(fixture, "chat-no-history-twice");

    const dave = await addPerson(fixture, "dave", "tablet");
    await syncAll(fixture, "directory");
    await publishUserKey(dave);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    await db.addRecipients!(group, [dave.username], { history: "none" });
    await syncAll(fixture, "chat-no-history-twice");
    // Bob loaded the group from Alice's snapshot; his change depends on that snapshot entry.
    const bobDb = await bob.tenant.openDB("chat-no-history-twice");
    await bobDb.syncStoreChanges();
    await bobDb.addRecipients!(await bobDb.getDocument(group.getId()), [carol.username], { history: "none" });
    await syncAll(fixture, "chat-no-history-twice");

    const carolDb = await carol.tenant.openDB("chat-no-history-twice");
    expect(await visibleIds(carolDb)).toEqual([group.getId()]);
    expect((await carolDb.getDocument(group.getId())).getData().name).toBe("Team");

    // A re-seal that changes nothing (Bob is a member already) must not open a door for Carol.
    await db.addRecipients!(await db.getDocument(group.getId()), [bob.username]);
    await syncAll(fixture, "chat-no-history-twice");
    await carolDb.syncStoreChanges();
    const carolGroup = await carolDb.getDocument(group.getId());
    await expect(carolDb.removeRecipients!(carolGroup, [bob.username])).rejects.toThrow(/whole history/);
    await expect(carolDb.revealHistory!(carolGroup, [carol.username])).rejects.toThrow(/whole history/);
  });
});
