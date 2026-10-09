/**
 * Local document-history purge (docs/accesscontrol.md §13): what
 * `MindooDB.purgeDocumentHistory()` removes, what it must keep, and that a
 * purged document cannot come back through a pull.
 *
 * - Attachments: chunks and content blobs another document still uses survive.
 * - Derived state: caches, full-text tokens, listings and time-travel
 *   snapshots forget the document.
 * - Pulls: a replica that never executed the purge cannot hand the entries back.
 */
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { StoreKind } from "../core/types";
import type { MindooDB, MindooDoc, MindooTenant } from "../core/types";
import type { PrivateUserId } from "../core/userid";
import { installManualSemanticClock } from "./_helpers/manualSemanticClock";

const ADMIN_PASSWORD = "admin-pass";
const attachmentConfig = { attachmentConfig: { chunkSizeBytes: 128 } };

/** Deterministic bytes, long enough to span several 128-byte chunks. */
function payloadBytes(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * seed + 13) % 256;
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
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

async function chunkEntries(db: MindooDB, docId: string) {
  const entries = await db.getAttachmentStore().findNewEntriesForDoc([], docId);
  return entries.filter((entry) => entry.entryType === "attachment_chunk");
}

async function docEntries(db: MindooDB, docId: string) {
  return db.getStore().findNewEntriesForDoc([], docId);
}

async function addDocWithAttachment(db: MindooDB, bytes: Uint8Array, title: string) {
  const doc = await db.createDocument();
  let attachmentId = "";
  await db.changeDoc(doc, async (draft) => {
    draft.getData().title = title;
    attachmentId = (await draft.addAttachment(bytes, "payload.bin", "application/octet-stream"))
      .attachmentId;
  });
  return { docId: doc.getId(), attachmentId };
}

describe("MindooDB.purgeDocumentHistory", () => {
  let tenant: MindooTenant;
  let adminUser: PrivateUserId;
  let tenantId: string;
  let db: MindooDB;

  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    tenantId = `purge-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await factory.createTenant({
      tenantId,
      adminName: `cn=admin/o=${tenantId}`,
      adminPassword: ADMIN_PASSWORD,
      userName: `cn=user1/o=${tenantId}`,
      userPassword: "user-pass",
    });
    tenant = result.tenant;
    adminUser = result.adminUser;
    db = await tenant.openDB("main", attachmentConfig);
  }, 60000);

  describe("attachments", () => {
    it("purges a document's own chunks and keeps content another document shares", async () => {
      // Same bytes, same key: deterministic attachment encryption gives both
      // documents identical ciphertext, stored once.
      const bytes = payloadBytes(1000);
      const purged = await addDocWithAttachment(db, bytes, "purge me");
      const kept = await addDocWithAttachment(db, bytes, "keep me");
      const purgedChunks = await chunkEntries(db, purged.docId);
      const keptChunks = await chunkEntries(db, kept.docId);
      expect(purgedChunks.length).toBeGreaterThan(1);
      expect(purgedChunks.map((e) => e.contentHash).sort()).toEqual(
        keptChunks.map((e) => e.contentHash).sort(),
      );

      const outcome = await db.purgeDocumentHistory(purged.docId);

      expect(outcome.docEntriesPurged).toBeGreaterThan(0);
      expect(outcome.attachmentChunksPurged).toBe(purgedChunks.length);
      expect(outcome.attachmentChunksRetained).toBe(0);
      expect(await chunkEntries(db, purged.docId)).toHaveLength(0);
      expect(await docEntries(db, purged.docId)).toHaveLength(0);

      // The other document's attachment is intact, payload included.
      const keptDoc = await db.getDocument(kept.docId);
      expect(await readAttachment(keptDoc, kept.attachmentId)).toEqual(bytes);
    }, 60000);

    it("releases the content blob when no other document uses it", async () => {
      // Random bytes: no chunk repeats, within or across the documents.
      const purged = await addDocWithAttachment(db, randomBytes(600), "unique");
      const kept = await addDocWithAttachment(db, randomBytes(600), "different bytes");
      const store = db.getAttachmentStore() as InMemoryContentAddressedStore;
      const keptChunks = await chunkEntries(db, kept.docId);
      expect(store.getStats().contentCount).toBeGreaterThan(keptChunks.length);

      await db.purgeDocumentHistory(purged.docId);

      expect(store.getStats().contentCount).toBe(keptChunks.length);
    }, 60000);

    it("keeps chunks an in-place copy's history still points at", async () => {
      const bytes = payloadBytes(1000);
      const source = await addDocWithAttachment(db, bytes, "source");
      const sourceChunks = await chunkEntries(db, source.docId);
      // Duplicating inside the same database re-prefixes the copy's chunks,
      // but the copied revisions keep referring to the source's chunk ids.
      const copy = await db.copyDocumentTo(source.docId, db, { mode: "history" });
      const beforeRepoint = (await docEntries(db, copy.targetDocId)).some((entry) =>
        (entry.attachmentRefs ?? []).some((ref) =>
          sourceChunks.some((chunk) => chunk.id === ref.lastChunkId),
        ),
      );
      expect(beforeRepoint).toBe(true);

      const outcome = await db.purgeDocumentHistory(source.docId);

      expect(outcome.attachmentChunksRetained).toBe(sourceChunks.length);
      expect(outcome.attachmentChunksPurged).toBe(0);
      expect(await docEntries(db, source.docId)).toHaveLength(0);
      // Every chunk the copy's history needs is still there.
      const remaining = new Set((await chunkEntries(db, source.docId)).map((e) => e.id));
      for (const chunk of sourceChunks) {
        expect(remaining.has(chunk.id)).toBe(true);
      }
      const copyDoc = await db.getDocument(copy.targetDocId);
      expect(await readAttachment(copyDoc, copyDoc.getAttachments()[0].attachmentId)).toEqual(
        bytes,
      );

      // Once the copy is purged too, a repeated purge of the source sweeps the
      // chunks nobody references any more.
      await db.purgeDocumentHistory(copy.targetDocId);
      const sweep = await db.purgeDocumentHistory(source.docId);
      expect(sweep.attachmentChunksPurged).toBe(sourceChunks.length);
      expect(await chunkEntries(db, source.docId)).toHaveLength(0);
    }, 60000);
  });

  describe("derived state", () => {
    it("removes the document from listings, views of the index and full-text search", async () => {
      await db.setFulltextSetup!({ enabled: true });
      const doc = await db.createDocument();
      await db.changeDoc(doc, (draft) => {
        draft.getData().body = "zebracorn secret";
      });
      const other = await db.createDocument();
      await db.changeDoc(other, (draft) => {
        draft.getData().body = "harmless";
      });
      expect((await db.searchText!("zebracorn")).hits.map((h) => h.docId)).toEqual([
        doc.getId(),
      ]);

      await db.purgeDocumentHistory(doc.getId());

      const remainingIds = await db.getAllDocumentIds();
      expect(remainingIds).not.toContain(doc.getId());
      expect(remainingIds).toContain(other.getId());
      expect((await db.searchText!("zebracorn")).hits).toHaveLength(0);
      await expect(db.getDocument(doc.getId())).rejects.toThrow();

      // A changefeed consumer sees the document go away.
      const changes: Array<{ docId: string; isDeleted: boolean }> = [];
      for await (const change of db.iterateChangesSince(null)) {
        changes.push({ docId: change.doc.getId(), isDeleted: change.doc.isDeleted() });
      }
      expect(changes.some((c) => c.docId === doc.getId() && !c.isDeleted)).toBe(false);
    }, 60000);

    it("scrubs an open time-travel snapshot", async () => {
      const clock = installManualSemanticClock();
      try {
        const doc = await db.createDocument();
        await db.changeDoc(doc, (draft) => {
          draft.getData().title = "visible in the past";
        });
        const cutoff = clock.advance();
        clock.advance();

        const snapshot = await tenant.openDB("main", { timeTravelDate: cutoff });
        expect((await snapshot.getDocument(doc.getId())).getData().title).toBe(
          "visible in the past",
        );

        await db.purgeDocumentHistory(doc.getId());

        expect(await snapshot.getAllDocumentIds()).not.toContain(doc.getId());
        await expect(snapshot.getDocument(doc.getId())).rejects.toThrow();
      } finally {
        clock.restore();
      }
    }, 60000);

    it("is not allowed on a time-travel snapshot", async () => {
      const doc = await db.createDocument();
      const snapshot = await tenant.openDB("main", { timeTravelDate: Date.now() });
      await expect(snapshot.purgeDocumentHistory(doc.getId())).rejects.toThrow(/time travel/i);
    }, 60000);
  });

  describe("pulling from a replica that has not executed the purge", () => {
    it("refuses the purged document's entries, docs and attachments alike", async () => {
      const bytes = payloadBytes(700);
      const purged = await addDocWithAttachment(db, bytes, "erase me");
      const kept = await addDocWithAttachment(db, payloadBytes(300, 9), "keep me");

      // A stale replica: a full copy of both stores taken before the purge.
      const staleDocs = new InMemoryContentAddressedStore("main", StoreKind.docs);
      const staleAttachments = new InMemoryContentAddressedStore("main", StoreKind.attachments);
      await staleDocs.putEntries(await db.getStore().getEntries(await db.getStore().getAllIds()));
      await staleAttachments.putEntries(
        await db.getAttachmentStore().getEntries(await db.getAttachmentStore().getAllIds()),
      );

      const directory = await tenant.openDirectory();
      await directory.publishDocHistoryPurge!(
        {
          v: 1,
          tenantId,
          requestId: `req-${Date.now()}`,
          dbId: "main",
          docIds: [purged.docId],
          preparedByPublicKey: "",
        },
        adminUser.userSigningKeyPair.privateKey,
        ADMIN_PASSWORD,
      );
      expect(await tenant.getPurgedDocumentIds("main")).toEqual(new Set([purged.docId]));
      expect(await tenant.getPurgedDocumentIds("directory")).toEqual(new Set());

      await db.purgeDocumentHistory(purged.docId);
      await db.pullChangesFrom(staleDocs);
      await db.pullChangesFrom(staleAttachments, { storeKind: StoreKind.attachments });

      expect(await docEntries(db, purged.docId)).toHaveLength(0);
      expect(await chunkEntries(db, purged.docId)).toHaveLength(0);
      expect(await db.getAllDocumentIds()).toEqual([kept.docId]);

      // The refusal is final: a second pull offers nothing new.
      const second = await db.pullChangesFrom(staleDocs);
      expect(second.cancelled).toBe(false);
      expect(second.transferredEntries).toBe(0);
      expect(await docEntries(db, purged.docId)).toHaveLength(0);
    }, 60000);
  });
});
