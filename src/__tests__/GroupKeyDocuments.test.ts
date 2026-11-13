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
});
