/**
 * `MindooDB.restoreDocumentToEntry()`: putting a document back to an earlier
 * DAG state, e.g. after vandalism, as one new change on top of the history.
 */
import { createCopyTestTenant, docEntries, type CopyTestTenant } from "./_helpers/copyTestHarness";
import { MindooValue } from "../core/values";
import type { MindooDB, MindooDoc } from "../core/types";

function payloadBytes(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * seed + 13) % 256;
  }
  return bytes;
}

async function readAttachment(doc: MindooDoc, attachmentId: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of doc.streamAttachment(attachmentId)) {
    chunks.push(chunk);
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** The newest docs-store entry of a document: the state to come back to. */
async function headEntryId(db: MindooDB, docId: string): Promise<string> {
  const entries = await docEntries(db, docId);
  return entries[entries.length - 1].id;
}

describe("MindooDB.restoreDocumentToEntry", () => {
  let alpha: CopyTestTenant;
  let db: MindooDB;

  beforeEach(async () => {
    alpha = await createCopyTestTenant(`restore-${Date.now()}`);
    db = await alpha.openDB("main", { attachmentConfig: { chunkSizeBytes: 128 } });
  }, 60000);

  afterEach(async () => {
    await alpha.dispose();
  });

  it("puts changed, added and removed fields back and keeps the history", async () => {
    const doc = await db.createDocument({
      initialValues: {
        title: "Quarterly plan",
        owner: "alice",
        nested: { goals: ["ship", "hire"], done: false },
        stats: { views: MindooValue.counter(5) },
      },
    });
    const good = await headEntryId(db, doc.getId());

    await db.changeDoc(await db.getDocument(doc.getId()), (draft) => {
      const data = draft.getData();
      data.title = "lol";
      data.spam = "buy now";
      delete data.owner;
      data.nested = { goals: [] };
    });
    const entriesBefore = (await docEntries(db, doc.getId())).length;

    const result = await db.restoreDocumentToEntry(doc.getId(), good);

    expect(result.restoredFromEntryId).toBe(good);
    expect(result.undeleted).toBe(false);
    expect(result.changedFields.sort()).toEqual(["nested", "owner", "title"]);
    expect(result.removedFields).toEqual(["spam"]);
    const restored = (await db.getDocument(doc.getId())).getData() as Record<string, unknown>;
    expect(restored.title).toBe("Quarterly plan");
    expect(restored.owner).toBe("alice");
    expect(restored.nested).toEqual({ goals: ["ship", "hire"], done: false });
    expect(restored.spam).toBeUndefined();
    expect(restored.stats).toEqual({ views: 5 });
    // One new entry; the vandalized state stays in the history.
    expect((await docEntries(db, doc.getId())).length).toBe(entriesBefore + 1);
  }, 60000);

  it("keeps a counter a counter", async () => {
    const doc = await db.createDocument({
      initialValues: { title: "Stats", stats: { views: MindooValue.counter(5) } },
    });
    const good = await headEntryId(db, doc.getId());
    await db.changeDoc(await db.getDocument(doc.getId()), (draft) => {
      draft.getData().stats = { views: 0 };
    });

    await db.restoreDocumentToEntry(doc.getId(), good);
    await db.changeDoc(await db.getDocument(doc.getId()), (draft) => {
      draft.incrementCounter(["stats", "views"], 2);
    });

    expect((await db.getDocument(doc.getId())).getData().stats).toEqual({ views: 7 });
  }, 60000);

  it("puts the attachment set back without re-uploading", async () => {
    const bytes = payloadBytes(700);
    const doc = await db.createDocument();
    let kept = "";
    await db.changeDoc(doc, async (draft) => {
      draft.getData().title = "with file";
      kept = (await draft.addAttachment(bytes, "keep.bin", "application/octet-stream")).attachmentId;
    });
    const good = await headEntryId(db, doc.getId());
    const chunksBefore = (await db.getAttachmentStore().findNewEntriesForDoc([], doc.getId())).length;

    let added = "";
    await db.changeDoc(await db.getDocument(doc.getId()), async (draft) => {
      await draft.removeAttachment(kept);
      added = (await draft.addAttachment(payloadBytes(200, 3), "junk.bin", "application/octet-stream"))
        .attachmentId;
    });

    const result = await db.restoreDocumentToEntry(doc.getId(), good);

    expect(result.restoredAttachmentIds).toEqual([kept]);
    expect(result.removedAttachmentIds).toEqual([added]);
    const restored = await db.getDocument(doc.getId());
    expect(restored.getAttachments().map((ref) => ref.attachmentId)).toEqual([kept]);
    expect(await readAttachment(restored, kept)).toEqual(bytes);
    // The restored attachment points at its stored chunks; only the junk
    // attachment's chunks were written in between.
    const junkChunks = (await db.getAttachmentStore().findNewEntriesForDoc([], doc.getId())).filter(
      (entry) => entry.attachmentId === added,
    ).length;
    expect((await db.getAttachmentStore().findNewEntriesForDoc([], doc.getId())).length).toBe(
      chunksBefore + junkChunks,
    );
  }, 60000);

  it("undeletes a document that was deleted after that state", async () => {
    const doc = await db.createDocument({ initialValues: { title: "keep me" } });
    const good = await headEntryId(db, doc.getId());
    await db.deleteDocument(doc.getId());

    const result = await db.restoreDocumentToEntry(doc.getId(), good);

    expect(result.undeleted).toBe(true);
    const restored = await db.getDocument(doc.getId());
    expect(restored.isDeleted()).toBe(false);
    expect(restored.getData().title).toBe("keep me");
  }, 60000);

  it("writes nothing when the document already has that state", async () => {
    const doc = await db.createDocument({ initialValues: { title: "same" } });
    const good = await headEntryId(db, doc.getId());
    const before = (await docEntries(db, doc.getId())).length;

    const result = await db.restoreDocumentToEntry(doc.getId(), good);

    expect(result.changedFields).toEqual([]);
    expect((await docEntries(db, doc.getId())).length).toBe(before);
  }, 60000);

  it("refuses a deleted state and an unknown entry", async () => {
    const doc = await db.createDocument({ initialValues: { title: "x" } });
    await db.deleteDocument(doc.getId());
    const deletedState = await headEntryId(db, doc.getId());

    await expect(db.restoreDocumentToEntry(doc.getId(), deletedState)).rejects.toThrow(/deleted/);
    await expect(db.restoreDocumentToEntry(doc.getId(), "no-such-entry")).rejects.toThrow(
      /no state/,
    );
  }, 60000);

  it("is not allowed on a time-travel snapshot", async () => {
    const doc = await db.createDocument({ initialValues: { title: "x" } });
    const good = await headEntryId(db, doc.getId());
    const snapshot = await alpha.openDB("main", { timeTravelDate: Date.now() });
    await expect(snapshot.restoreDocumentToEntry(doc.getId(), good)).rejects.toThrow(/time travel/i);
  }, 60000);
});
