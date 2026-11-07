import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID, type MindooDB, type StoreEntry } from "../core/types";
import { StoreKind } from "../core/appendonlystores/types";
import { SymmetricKeyNotFoundError } from "../core/errors";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

/**
 * `syncAll` only moves the document store. Attachment bytes live in a second
 * store, so every sealed-attachment assertion needs both kinds pushed.
 */
async function syncDocsAndAttachments(
  fixture: MultiDeviceFixture,
  dbId: string,
): Promise<void> {
  const devices = [fixture.host, ...fixture.devices];
  for (const source of devices) {
    for (const target of devices) {
      if (source === target) continue;
      const sourceDb = await source.tenant.openDB(dbId);
      const targetDb = await target.tenant.openDB(dbId);
      await sourceDb.pushChangesTo(targetDb.getStore());
      await sourceDb.pushChangesTo(targetDb.getAttachmentStore(), {
        storeKind: StoreKind.attachments,
      });
      await targetDb.syncStoreChanges();
    }
  }
}

async function chunkEntriesForDoc(db: MindooDB, docId: string): Promise<StoreEntry[]> {
  const store = db.getAttachmentStore();
  const metas = await store.findNewEntriesForDoc([], docId);
  const entries = await store.getEntries(metas.map((meta) => meta.id));
  return entries.filter((entry) => entry.entryType === "attachment_chunk");
}

describe("sealed document attachments", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-attach" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await publishUserKey(carol);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("encrypts attachment chunks under the sealed document key, not a named key", async () => {
    const db = await alice.tenant.openDB("attach-key");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await db.changeDoc(doc, async (d) => {
      await d.addAttachment(payload, "secret.bin", "application/octet-stream");
    });

    const chunks = await chunkEntriesForDoc(db, doc.getId());
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.decryptionKeyId).toBe(`$sealed:${doc.getId()}`);
      // Chunks carry no RSA wrap block of their own: the DEK is acquired by
      // unwrapping the recipient block on the document entries.
      expect(chunk.recipients).toBeUndefined();
    }
  });

  it("carries attachments in the doc_create entry, readable for a recipient the author excluded itself from", async () => {
    const db = await alice.tenant.openDB("attach-create");
    const payload = new Uint8Array([9, 8, 7, 6]);
    const doc = await db.createDocument({
      recipients: [bob.username],
      recipientOptions: { includeSelf: false },
      initialValues: { subject: "with attachment" },
      attachments: [{ data: payload, fileName: "scan.pdf", mimeType: "application/pdf" }],
    });
    // One entry for the document: the attachment rides on doc_create.
    const docEntries = await db.getStore().findNewEntriesForDoc([], doc.getId());
    expect(docEntries.map((entry) => entry.entryType)).toEqual(["doc_create"]);
    expect(docEntries[0]!.attachmentRefs?.length).toBe(1);
    const chunks = await chunkEntriesForDoc(db, doc.getId());
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.decryptionKeyId === `$sealed:${doc.getId()}`)).toBe(true);

    await syncDocsAndAttachments(fixture, "attach-create");
    const bobDoc = await (await bob.tenant.openDB("attach-create")).getDocument(doc.getId());
    const [ref] = bobDoc.getAttachments();
    expect(ref).toMatchObject({ fileName: "scan.pdf", mimeType: "application/pdf", size: 4 });
    expect(await bobDoc.getAttachment(ref!.attachmentId)).toEqual(payload);
  });

  it("refuses attachments on a convergent custom id and in createDocuments()", async () => {
    const db = await alice.tenant.openDB("attach-create-guard");
    const attachments = [{ data: new Uint8Array([1]), fileName: "a.bin", mimeType: "application/octet-stream" }];
    await expect(db.createDocument({ id: "settings_singleton", attachments })).rejects.toThrow(/convergent custom id/);
    await expect(db.createDocuments([{ attachments }])).rejects.toThrow(/only supported by createDocument/);
  });

  it("lets a recipient read attachment bytes and keeps them from a non-recipient", async () => {
    const db = await alice.tenant.openDB("attach-read");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    let attachmentId = "";
    await db.changeDoc(doc, async (d) => {
      const ref = await d.addAttachment(payload, "secret.bin", "application/octet-stream");
      attachmentId = ref.attachmentId;
    });
    await syncDocsAndAttachments(fixture, "attach-read");

    const bobDb = await bob.tenant.openDB("attach-read");
    const bobDoc = await bobDb.getDocument(doc.getId());
    expect(await bobDoc.getAttachment(attachmentId)).toEqual(payload);

    // Carol holds the ciphertext but no wrap, so the bytes stay unreadable
    // even though the chunks replicated into her attachment store.
    const carolDb = await carol.tenant.openDB("attach-read");
    await expect(carolDb.getDocument(doc.getId())).rejects.toThrow();
    const carolChunks = await chunkEntriesForDoc(carolDb, doc.getId());
    expect(carolChunks.length).toBeGreaterThan(0);
    await expect(
      carol.tenant.decryptAttachmentPayload(
        carolChunks[0].encryptedData!,
        carolChunks[0].decryptionKeyId,
      ),
    ).rejects.toThrow(SymmetricKeyNotFoundError);
  });

  it("gives a newly added recipient attachments written before they were added", async () => {
    const db = await alice.tenant.openDB("attach-past");
    const doc = await db.createDocument({
      recipients: [],
      initialValues: { n: 1 },
    });
    const payload = new Uint8Array([7, 7, 7, 42]);
    let attachmentId = "";
    await db.changeDoc(doc, async (d) => {
      const ref = await d.addAttachment(payload, "history.bin", "application/octet-stream");
      attachmentId = ref.attachmentId;
    });
    await syncDocsAndAttachments(fixture, "attach-past");

    const carolDb = await carol.tenant.openDB("attach-past");
    await expect(carolDb.getDocument(doc.getId())).rejects.toThrow();

    await db.addRecipients!(doc, [carol.username]);
    await syncDocsAndAttachments(fixture, "attach-past");
    await carolDb.reconcileKeyVisibility();

    const carolDoc = await carolDb.getDocument(doc.getId());
    expect(await carolDoc.getAttachment(attachmentId)).toEqual(payload);
  });

  it("keeps pre-rotation attachments readable for remaining recipients and closed to the removed one", async () => {
    const db = await alice.tenant.openDB("attach-rotate");
    const doc = await db.createDocument({
      recipients: [bob.username],
      initialValues: { n: 1 },
    });
    const beforeRotation = new Uint8Array([1, 1, 2, 3, 5, 8]);
    let beforeId = "";
    await db.changeDoc(doc, async (d) => {
      const ref = await d.addAttachment(beforeRotation, "before.bin", "application/octet-stream");
      beforeId = ref.attachmentId;
    });
    await syncDocsAndAttachments(fixture, "attach-rotate");

    const bobDb = await bob.tenant.openDB("attach-rotate");
    const bobDocBefore = await bobDb.getDocument(doc.getId());
    expect(await bobDocBefore.getAttachment(beforeId)).toEqual(beforeRotation);

    // Removing Bob mints a new generation. Existing chunks are NOT rewritten.
    const removal = await db.removeRecipients!(doc, [bob.username]);
    expect(removal.rotated).toBe(true);

    const afterRotation = new Uint8Array([9, 9, 9]);
    let afterId = "";
    const aliceDoc = await db.getDocument(doc.getId());
    await db.changeDoc(aliceDoc, async (d) => {
      const ref = await d.addAttachment(afterRotation, "after.bin", "application/octet-stream");
      afterId = ref.attachmentId;
    });

    // Alice spans both generations: the old chunk decrypts via the retired
    // generation, the new one via the current generation.
    const aliceReload = await db.getDocument(doc.getId());
    expect(await aliceReload.getAttachment(beforeId)).toEqual(beforeRotation);
    expect(await aliceReload.getAttachment(afterId)).toEqual(afterRotation);

    await syncDocsAndAttachments(fixture, "attach-rotate");

    // Bob lost the series entirely: neither the attachment he could read
    // before nor the post-rotation one is reachable.
    await expect(bobDb.getDocument(doc.getId())).rejects.toThrow();
    const bobChunks = await chunkEntriesForDoc(bobDb, doc.getId());
    expect(bobChunks.length).toBeGreaterThan(0);
    for (const chunk of bobChunks) {
      await expect(
        bob.tenant.decryptAttachmentPayload(chunk.encryptedData!, chunk.decryptionKeyId),
      ).rejects.toThrow(SymmetricKeyNotFoundError);
    }
  });
});
