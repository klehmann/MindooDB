import {
  createCopyTestTenant,
  seedDocument,
  type CopyTestTenant,
} from "./_helpers/copyTestHarness";
import type { MindooDB, MindooDoc } from "../core/types";

/** Deterministic bytes, long enough to span several 128-byte chunks. */
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
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Every attachment chunk a store holds for one document. */
async function chunkEntries(db: MindooDB, docId: string) {
  const entries = await db.getAttachmentStore().findNewEntriesForDoc([], docId);
  return entries.filter((entry) => entry.entryType === "attachment_chunk");
}

describe("copying attachments", () => {
  let alpha: CopyTestTenant;
  let sourceDb: MindooDB;
  let targetDb: MindooDB;
  const attachmentConfig = { attachmentConfig: { chunkSizeBytes: 128 } };

  beforeEach(async () => {
    alpha = await createCopyTestTenant("attach-tenant-alpha", ["altkey"]);
    sourceDb = await alpha.openDB("source-db", attachmentConfig);
    targetDb = await alpha.openDB("target-db", attachmentConfig);
  }, 60000);

  afterEach(async () => {
    await alpha.dispose();
  });

  /** Seed a document carrying one attachment; returns its ids and bytes. */
  async function seedWithAttachment(
    db: MindooDB,
    fileName = "payload.bin",
    length = 1000,
  ) {
    const doc = await db.createDocument();
    const bytes = payloadBytes(length);
    let attachmentId = "";
    await db.changeDoc(doc, async (draft) => {
      draft.getData().title = "With attachment";
      const ref = await draft.addAttachment(bytes, fileName, "application/octet-stream");
      attachmentId = ref.attachmentId;
    });
    return { docId: doc.getId(), attachmentId, bytes };
  }

  describe("across databases", () => {
    it("carries chunks verbatim under a graft, so the ids stay stable", async () => {
      const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);
      expect(sourceChunks.length).toBeGreaterThan(1);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(result.copiedAttachments).toBe(1);
      const targetChunks = await chunkEntries(targetDb, docId);
      expect(targetChunks.map((entry) => entry.id).sort()).toEqual(
        sourceChunks.map((entry) => entry.id).sort(),
      );
      for (const chunk of targetChunks) {
        const original = sourceChunks.find((candidate) => candidate.id === chunk.id)!;
        expect(chunk.contentHash).toBe(original.contentHash);
        expect(chunk.createdByPublicKey).toBe(original.createdByPublicKey);
      }

      const copy = await targetDb.getDocument(docId);
      expect(await readAttachment(copy, attachmentId)).toEqual(bytes);
    }, 30000);

    it("keeps chunk ids on a replay too, so the replayed payloads still resolve", async () => {
      const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
      });

      const targetChunks = await chunkEntries(targetDb, result.targetDocId);
      expect(targetChunks.map((entry) => entry.id).sort()).toEqual(
        sourceChunks.map((entry) => entry.id).sort(),
      );

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(await readAttachment(copy, attachmentId)).toEqual(bytes);
    }, 30000);

    it("re-uploads attachments under fresh ids when flattening", async () => {
      const { docId, bytes } = await seedWithAttachment(sourceDb);

      const result = await sourceDb.copyDocumentTo(docId, targetDb);

      const copy = await targetDb.getDocument(result.targetDocId);
      const attachments = copy.getAttachments();
      expect(attachments.length).toBe(1);
      expect(attachments[0].fileName).toBe("payload.bin");
      expect(await readAttachment(copy, attachments[0].attachmentId)).toEqual(bytes);
    }, 30000);

    it("skips attachments when the caller opts out", async () => {
      const { docId } = await seedWithAttachment(sourceDb);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        includeAttachments: false,
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(result.copiedAttachments).toBe(0);
      expect(await chunkEntries(targetDb, result.targetDocId)).toHaveLength(0);
    }, 30000);

    it("duplicates the bytes: content dedup does not cross a store boundary", async () => {
      const { docId } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);
      const sourceBytes = sourceChunks.reduce(
        (total, chunk) => total + chunk.encryptedSize,
        0,
      );

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      const targetBytes = (await chunkEntries(targetDb, docId)).reduce(
        (total, chunk) => total + chunk.encryptedSize,
        0,
      );
      expect(targetBytes).toBe(sourceBytes);
      expect(result.copiedBytes).toBeGreaterThanOrEqual(sourceBytes);
    }, 30000);

    it("copies several attachments on one document", async () => {
      const doc = await sourceDb.createDocument();
      const first = payloadBytes(400, 3);
      const second = payloadBytes(700, 11);
      const ids: string[] = [];
      await sourceDb.changeDoc(doc, async (draft) => {
        ids.push(
          (await draft.addAttachment(first, "a.bin", "application/octet-stream"))
            .attachmentId,
        );
        ids.push(
          (await draft.addAttachment(second, "b.bin", "application/octet-stream"))
            .attachmentId,
        );
      });

      const result = await sourceDb.copyDocumentTo(doc.getId(), targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(result.copiedAttachments).toBe(2);
      const copy = await targetDb.getDocument(result.targetDocId);
      expect(await readAttachment(copy, ids[0])).toEqual(first);
      expect(await readAttachment(copy, ids[1])).toEqual(second);
    }, 30000);

    it("resumes after cancellation without duplicating chunks", async () => {
      const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
      const controller = new AbortController();
      controller.abort();

      const cancelled = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
        signal: controller.signal,
      });
      expect(cancelled.cancelled).toBe(true);

      const resumed = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(resumed.cancelled).toBe(false);

      const sourceChunks = await chunkEntries(sourceDb, docId);
      const targetChunks = await chunkEntries(targetDb, docId);
      expect(targetChunks.length).toBe(sourceChunks.length);

      const copy = await targetDb.getDocument(docId);
      expect(await readAttachment(copy, attachmentId)).toEqual(bytes);
    }, 30000);
  });

  describe("under a different key in the same tenant", () => {
    it("re-encrypts the chunks and still streams the original bytes back", async () => {
      const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        decryptionKeyId: "altkey",
      });

      const targetChunks = await chunkEntries(targetDb, result.targetDocId);
      expect(targetChunks.length).toBe(sourceChunks.length);
      const sourceHashes = new Set(sourceChunks.map((entry) => entry.contentHash));
      for (const chunk of targetChunks) {
        expect(chunk.decryptionKeyId).toBe("altkey");
        // A different key means different ciphertext, so the deterministic-IV
        // dedup that applies to a same-key copy cannot apply here.
        expect(sourceHashes.has(chunk.contentHash)).toBe(false);
      }

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(await readAttachment(copy, attachmentId)).toEqual(bytes);
    }, 30000);
  });

  describe("within one database", () => {
    it("re-prefixes chunk ids and re-points the copy at the chunks it owns", async () => {
      const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, sourceDb, {
        mode: "history",
      });

      expect(result.targetDocId).not.toBe(docId);
      const copyChunks = await chunkEntries(sourceDb, result.targetDocId);
      expect(copyChunks.length).toBe(sourceChunks.length);
      for (const chunk of copyChunks) {
        expect(chunk.id.startsWith(`${result.targetDocId}_a_`)).toBe(true);
        expect(chunk.docId).toBe(result.targetDocId);
      }

      // The source must be untouched: same chunk ids, same count.
      const sourceAfter = await chunkEntries(sourceDb, docId);
      expect(sourceAfter.map((entry) => entry.id).sort()).toEqual(
        sourceChunks.map((entry) => entry.id).sort(),
      );

      const original = await sourceDb.getDocument(docId);
      expect(await readAttachment(original, attachmentId)).toEqual(bytes);
      const copy = await sourceDb.getDocument(result.targetDocId);
      const copiedRef = copy.getAttachments()[0];
      expect(await readAttachment(copy, copiedRef.attachmentId)).toEqual(bytes);
    }, 30000);

    it("deduplicates the ciphertext, because the chunk IV is deterministic", async () => {
      const { docId } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, sourceDb, {
        mode: "history",
      });

      // Different entry ids, identical content hashes: one copy of the bytes.
      const copyChunks = await chunkEntries(sourceDb, result.targetDocId);
      expect(copyChunks.map((entry) => entry.contentHash).sort()).toEqual(
        sourceChunks.map((entry) => entry.contentHash).sort(),
      );
    }, 30000);
  });

  describe("across tenants", () => {
    let beta: CopyTestTenant;
    let betaDb: MindooDB;

    beforeEach(async () => {
      beta = await createCopyTestTenant("attach-tenant-beta");
      betaDb = await beta.openDB("beta-db", attachmentConfig);
    }, 60000);

    afterEach(async () => {
      await beta.dispose();
    });

    it("re-encrypts every chunk under the target tenant key", async () => {
      const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
      const sourceChunks = await chunkEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, betaDb, {
        mode: "history",
        targetDocId: "same",
      });

      const targetChunks = await chunkEntries(betaDb, result.targetDocId);
      expect(targetChunks.length).toBe(sourceChunks.length);
      const sourceHashes = new Set(sourceChunks.map((entry) => entry.contentHash));
      for (const chunk of targetChunks) {
        expect(chunk.createdByPublicKey).toBe(beta.signingPublicKey);
        // A different tenant key means different ciphertext for the same bytes.
        expect(sourceHashes.has(chunk.contentHash)).toBe(false);
      }

      const copy = await betaDb.getDocument(result.targetDocId);
      expect(await readAttachment(copy, attachmentId)).toEqual(bytes);
    }, 30000);
  });
});
