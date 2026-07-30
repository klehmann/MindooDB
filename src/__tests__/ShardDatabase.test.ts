/**
 * Sharding a growing database by copying whole document sets into new ones.
 *
 * This is the bulk-copy API used the way `docs/document-copy.md` prescribes:
 * `mode: "history"`, `targetDocId: "same"`, `authorship: "preserve"`, selecting
 * by document-id prefix. The point of the suite is that the split is lossless
 * (original signers and full history survive), repeatable (a second pass only
 * carries the delta), and that reclaiming the source afterwards leaves the
 * shards intact.
 */

import {
  createCopyTestTenant,
  docEntries,
  seedDocument,
  type CopyTestTenant,
} from "./_helpers/copyTestHarness";
import { buildDocHistoryPurgeRequest } from "../core/copy/copyDocuments";
import { validateDocHistoryPurge } from "../core/accesscontrol/types";
import type { MindooDB } from "../core/types";

describe("sharding a database", () => {
  let alpha: CopyTestTenant;
  let monolith: MindooDB;
  let shard2025: MindooDB;
  let shard2026: MindooDB;

  /** Document ids per year prefix, as the monolith holds them. */
  let ids2025: string[];
  let ids2026: string[];

  beforeEach(async () => {
    alpha = await createCopyTestTenant("shard-tenant");
    monolith = await alpha.openDB("monolith");
    shard2025 = await alpha.openDB("shard-2025");
    shard2026 = await alpha.openDB("shard-2026");

    // The shard key lives in the document id prefix, which is what keeps
    // selection keyless: no payload is ever decrypted to place a document.
    ids2025 = [
      await seedDocument(monolith, { year: 2025, n: 1 }, 2, { idPrefix: "inv2025" }),
      await seedDocument(monolith, { year: 2025, n: 2 }, 1, { idPrefix: "inv2025" }),
    ];
    ids2026 = [
      await seedDocument(monolith, { year: 2026, n: 1 }, 1, { idPrefix: "inv2026" }),
    ];
  }, 120000);

  afterEach(async () => {
    await alpha.dispose();
  });

  it("splits one database into two by id prefix, losslessly", async () => {
    const first = await monolith.copyDocumentsTo(
      { idPrefix: "inv2025" },
      shard2025,
      { mode: "history", targetDocId: "same", authorship: "preserve" },
    );
    const second = await monolith.copyDocumentsTo(
      { idPrefix: "inv2026" },
      shard2026,
      { mode: "history", targetDocId: "same", authorship: "preserve" },
    );

    expect(first.copiedDocIds.sort()).toEqual([...ids2025].sort());
    expect(second.copiedDocIds).toEqual(ids2026);
    expect(first.failed).toEqual([]);
    expect(second.failed).toEqual([]);
    for (const result of [...first.documents, ...second.documents]) {
      expect(result.strategy).toBe("graft");
      expect(result.authorshipPreserved).toBe(true);
    }

    // Each shard holds exactly its own documents, under the original ids.
    for (const docId of ids2025) {
      expect((await shard2025.getDocument(docId)).getData().year).toBe(2025);
      await expect(shard2026.getDocument(docId)).rejects.toThrow();
    }
    for (const docId of ids2026) {
      expect((await shard2026.getDocument(docId)).getData().year).toBe(2026);
    }
  }, 120000);

  it("keeps the original signers and the full entry set on both shards", async () => {
    await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });

    for (const docId of ids2025) {
      const before = await docEntries(monolith, docId);
      const after = await docEntries(shard2025, docId);
      expect(after.map((entry) => entry.id).sort()).toEqual(
        before.map((entry) => entry.id).sort(),
      );
      for (const entry of after) {
        const original = before.find((candidate) => candidate.id === entry.id)!;
        expect(entry.createdByPublicKey).toBe(original.createdByPublicKey);
        expect(entry.metadataSignature).toEqual(original.metadataSignature);
        expect(entry.contentHash).toBe(original.contentHash);
      }
    }
  }, 120000);

  it("selects by explicit ids as well as by prefix", async () => {
    const result = await monolith.copyDocumentsTo(
      { docIds: [ids2025[0]] },
      shard2025,
      { mode: "history", targetDocId: "same", authorship: "preserve" },
    );

    expect(result.copiedDocIds).toEqual([ids2025[0]]);
    await expect(shard2025.getDocument(ids2025[1])).rejects.toThrow();
  }, 120000);

  it("rejects a selector that matches nothing to select on", async () => {
    await expect(monolith.copyDocumentsTo({}, shard2025)).rejects.toThrow(
      /docIds or idPrefix/,
    );
  }, 120000);

  it("refuses the directory database as a shard target", async () => {
    await alpha.tenant.openDirectory();
    const directoryDb = await alpha.openDB("directory");

    await expect(
      monolith.copyDocumentsTo({ idPrefix: "inv2025" }, directoryDb),
    ).rejects.toThrow(/directory database/i);
  }, 120000);

  it("reports per-document failures instead of aborting the run", async () => {
    const result = await monolith.copyDocumentsTo(
      { docIds: [ids2025[0], "doesNotExist"] },
      shard2025,
      { mode: "history", targetDocId: "same", authorship: "preserve" },
    );

    expect(result.copiedDocIds).toEqual([ids2025[0]]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].docId).toBe("doesNotExist");
  }, 120000);

  it("never touches an encryption key on the shard fast path", async () => {
    // A graft moves ciphertext, not content: it re-signs nothing and decrypts
    // nothing. That is what lets an operator shard a database they cannot read,
    // and it is the reason sharding scales — no per-entry crypto.
    const doc = await monolith.createDocument({ idPrefix: "inv2025" });
    await monolith.changeDoc(doc, async (draft) => {
      draft.getData().year = 2025;
      await draft.addAttachment(
        new Uint8Array([1, 2, 3, 4, 5]),
        "note.bin",
        "application/octet-stream",
      );
    });

    const tenantInternals = alpha.tenant as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const cryptoCalls: string[] = [];
    const guarded = [
      "encryptPayload",
      "decryptPayload",
      "encryptAttachmentPayload",
      "decryptAttachmentPayload",
    ];
    const originals = new Map(guarded.map((name) => [name, tenantInternals[name]]));
    for (const name of guarded) {
      tenantInternals[name] = (...args: unknown[]) => {
        cryptoCalls.push(name);
        return originals.get(name)!.apply(alpha.tenant, args);
      };
    }

    try {
      const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(result.copiedEntries).toBeGreaterThan(0);
      expect(result.copiedAttachments).toBe(1);
    } finally {
      for (const name of guarded) {
        tenantInternals[name] = originals.get(name)!;
      }
    }

    expect(cryptoCalls).toEqual([]);
  }, 120000);

  describe("online migration", () => {
    it("carries only the delta on a second pass and converges", async () => {
      const first = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(first.copiedEntries).toBeGreaterThan(0);

      // Users keep working against the source between the two passes.
      const live = await monolith.getDocument(ids2025[0]);
      await monolith.changeDoc(live, (draft) => {
        draft.getData().addedAfterFirstPass = true;
      });

      const second = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(second.copiedEntries).toBe(1);
      expect((await shard2025.getDocument(ids2025[0])).getData().addedAfterFirstPass)
        .toBe(true);

      // A third pass with no intervening writes is a pure no-op: the cutover
      // can be taken the moment a pass reports zero.
      const third = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(third.copiedEntries).toBe(0);
    }, 120000);

    it("resumes cleanly after a cancelled pass", async () => {
      const controller = new AbortController();
      controller.abort();

      const cancelled = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
        signal: controller.signal,
      });
      expect(cancelled.cancelled).toBe(true);

      const resumed = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(resumed.cancelled).toBe(false);
      expect(resumed.copiedDocIds.sort()).toEqual([...ids2025].sort());

      for (const docId of ids2025) {
        const before = await docEntries(monolith, docId);
        const after = await docEntries(shard2025, docId);
        expect(after.length).toBe(before.length);
      }
    }, 120000);
  });

  describe("migrating a database that stays in use", () => {
    /**
     * The whole point of repeating a pass: everything the shard holds for a
     * document is byte-identical to what the source holds, whatever the users
     * did in between. Compares the entry set (ids, signers, signatures, content
     * hashes) and the materialized state, including the deleted case.
     */
    async function expectShardMatchesSource(docId: string) {
      const before = await docEntries(monolith, docId);
      const after = await docEntries(shard2025, docId);
      expect(after.map((entry) => entry.id).sort()).toEqual(
        before.map((entry) => entry.id).sort(),
      );
      for (const entry of after) {
        const original = before.find((candidate) => candidate.id === entry.id)!;
        expect(entry.entryType).toBe(original.entryType);
        expect(entry.createdByPublicKey).toBe(original.createdByPublicKey);
        expect(entry.metadataSignature).toEqual(original.metadataSignature);
        expect(entry.contentHash).toBe(original.contentHash);
      }

      const sourceDeleted = (await monolith.getDeletedDocumentIds()).includes(docId);
      if (sourceDeleted) {
        // A doc_delete grafts like any other entry, so the shard must agree the
        // document is gone rather than silently resurrecting it.
        expect((await shard2025.getDeletedDocumentIds()).includes(docId)).toBe(true);
        await expect(shard2025.getDocument(docId)).rejects.toThrow(/deleted/);
        return;
      }

      const sourceDoc = await monolith.getDocument(docId);
      const shardDoc = await shard2025.getDocument(docId);
      expect(JSON.parse(JSON.stringify(shardDoc.getData()))).toEqual(
        JSON.parse(JSON.stringify(sourceDoc.getData())),
      );
    }

    it("converges after repeated passes over a live workload, and the shard reads back whole", async () => {
      // Pass 1 — taken while the database is open for business.
      const first = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(first.copiedDocIds.sort()).toEqual([...ids2025].sort());
      expect(first.failed).toEqual([]);

      // Users keep working: an edit to a document already copied, a brand-new
      // document under the shard prefix, an attachment, a delete, and a
      // document under a different prefix that must not be pulled in.
      const edited = await monolith.getDocument(ids2025[0]);
      await monolith.changeDoc(edited, (draft) => {
        draft.getData().note = "edited mid-migration";
      });

      const createdMidFlight = await seedDocument(
        monolith,
        { year: 2025, n: 3, createdDuringMigration: true },
        1,
        { idPrefix: "inv2025" },
      );

      const withAttachment = await monolith.createDocument({ idPrefix: "inv2025" });
      const attachmentBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
      let attachmentId = "";
      await monolith.changeDoc(withAttachment, async (draft) => {
        draft.getData().year = 2025;
        attachmentId = (
          await draft.addAttachment(
            attachmentBytes,
            "mid-flight.bin",
            "application/octet-stream",
          )
        ).attachmentId;
      });

      const doomed = await seedDocument(monolith, { year: 2025, n: 4 }, 0, {
        idPrefix: "inv2025",
      });
      await monolith.deleteDocument(doomed);

      const otherPrefix = await seedDocument(monolith, { year: 2026, n: 2 }, 0, {
        idPrefix: "inv2026",
      });

      // Pass 2 — carries only what changed, including documents that did not
      // exist when pass 1 ran.
      const second = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(second.failed).toEqual([]);
      expect(second.copiedDocIds).toEqual(
        expect.arrayContaining([
          ids2025[0],
          createdMidFlight,
          withAttachment.getId(),
          doomed,
        ]),
      );
      // An untouched document is still reported as copied — it is fully present
      // in the target, which is what makes `copiedDocIds` usable as the purge
      // set. The delta shows up in the per-document entry count instead.
      const untouched = second.documents.find(
        (result) => result.sourceDocId === ids2025[1],
      )!;
      expect(untouched.copiedEntries).toBe(0);
      expect(second.copiedDocIds).toContain(ids2025[1]);
      expect(
        second.documents.find((result) => result.sourceDocId === ids2025[0])!
          .copiedEntries,
      ).toBeGreaterThan(0);

      // Pass 3 — nothing left. This zero is the cutover signal.
      const third = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect(third.copiedEntries).toBe(0);
      expect(third.copiedAttachments).toBe(0);

      // Now verify the shard is a faithful, readable replica of every 2025
      // document — not just the ones the last pass happened to touch.
      const allShardedIds = [
        ...ids2025,
        createdMidFlight,
        withAttachment.getId(),
        doomed,
      ];
      for (const docId of allShardedIds) {
        await expectShardMatchesSource(docId);
      }

      // Spot-check the payloads that the live workload produced.
      expect((await shard2025.getDocument(ids2025[0])).getData().note).toBe(
        "edited mid-migration",
      );
      expect(
        (await shard2025.getDocument(createdMidFlight)).getData().createdDuringMigration,
      ).toBe(true);

      // Attachment bytes survive the graft and stream back from the shard.
      const shardedAttachmentDoc = await shard2025.getDocument(withAttachment.getId());
      expect(await shardedAttachmentDoc.getAttachment(attachmentId)).toEqual(
        attachmentBytes,
      );

      // Selection stayed on the prefix boundary throughout: nothing from the
      // 2026 set leaked into the 2025 shard.
      for (const docId of [...ids2026, otherPrefix]) {
        expect(await docEntries(shard2025, docId)).toHaveLength(0);
      }
    }, 180000);

    it("picks up a document created between passes even though the first pass never saw it", async () => {
      await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      const late = await seedDocument(monolith, { year: 2025, late: true }, 1, {
        idPrefix: "inv2025",
      });

      const second = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      // Selection re-runs per pass, so a late arrival is not stranded in the
      // source: it is discovered and copied whole, not as a partial delta.
      expect(second.copiedDocIds).toContain(late);
      await expectShardMatchesSource(late);
      expect((await shard2025.getDocument(late)).getData().late).toBe(true);
    }, 180000);

    it("replays a delete that happened after the document was already copied", async () => {
      await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      expect((await shard2025.getDocument(ids2025[0])).getData().year).toBe(2025);

      await monolith.deleteDocument(ids2025[0]);

      const second = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(second.copiedDocIds).toContain(ids2025[0]);
      await expectShardMatchesSource(ids2025[0]);
    }, 180000);
  });

  describe("reclaiming the source", () => {
    it("builds a purge request the existing pipeline accepts", async () => {
      const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      const request = buildDocHistoryPurgeRequest(result, {
        dbId: monolith.getStore().getId(),
        requestId: "shard-2025-reclaim",
        preparedByPublicKey: alpha.signingPublicKey,
        reason: "Reclaim space after sharding 2025 invoices",
      });

      expect(() => validateDocHistoryPurge(request)).not.toThrow();
      expect(request.dbId).toBe("monolith");
      expect(request.docIds.sort()).toEqual([...ids2025].sort());
    }, 120000);

    it("refuses to build a request when some document failed to copy", async () => {
      const result = await monolith.copyDocumentsTo(
        { docIds: [ids2025[0], "doesNotExist"] },
        shard2025,
        { mode: "history", targetDocId: "same", authorship: "preserve" },
      );

      expect(() =>
        buildDocHistoryPurgeRequest(result, {
          dbId: monolith.getStore().getId(),
          requestId: "partial",
          preparedByPublicKey: alpha.signingPublicKey,
        }),
      ).toThrow(/failed to copy/);
    }, 120000);

    it("purging the source leaves the shard intact, because the denylist is per database", async () => {
      const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard2025, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      const request = buildDocHistoryPurgeRequest(result, {
        dbId: monolith.getStore().getId(),
        requestId: "shard-2025-reclaim",
        preparedByPublicKey: alpha.signingPublicKey,
      });

      // What the server's executePendingPurges does to the named database.
      for (const docId of request.docIds) {
        await monolith.getStore().purgeDocHistory(docId);
      }

      for (const docId of ids2025) {
        expect(await docEntries(monolith, docId)).toHaveLength(0);
        // The shard carries the same document ids under a different database
        // id, so it survives the reclaim untouched.
        expect((await docEntries(shard2025, docId)).length).toBeGreaterThan(0);
        expect((await shard2025.getDocument(docId)).getData().year).toBe(2025);
      }
      // Documents outside the shard are unaffected in the source.
      for (const docId of ids2026) {
        expect((await docEntries(monolith, docId)).length).toBeGreaterThan(0);
      }
    }, 120000);
  });
});
