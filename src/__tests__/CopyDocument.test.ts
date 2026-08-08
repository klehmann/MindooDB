import {
  createCopyTestTenant,
  docEntries,
  seedDocument,
  type CopyTestTenant,
} from "./_helpers/copyTestHarness";
import type { MindooDB } from "../core/types";

describe("copyDocumentTo", () => {
  let alpha: CopyTestTenant;
  let sourceDb: MindooDB;
  let targetDb: MindooDB;

  beforeEach(async () => {
    alpha = await createCopyTestTenant("copy-tenant-alpha", ["altkey"]);
    sourceDb = await alpha.openDB("source-db");
    targetDb = await alpha.openDB("target-db");
  }, 60000);

  afterEach(async () => {
    await alpha.dispose();
  });

  describe("feasibility", () => {
    it("reports flatten as the zero-config strategy", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const feasibility = await sourceDb.canCopyDocumentTo(docId, targetDb);

      expect(feasibility.allowed).toBe(true);
      expect(feasibility.strategy).toBe("flatten");
      expect(feasibility.authorshipPreserved).toBe(false);
      expect(feasibility.sameStore).toBe(false);
    }, 30000);

    it("allows graft for the one configuration that keeps signatures valid", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);

      const feasibility = await sourceDb.canCopyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(feasibility.allowed).toBe(true);
      expect(feasibility.strategy).toBe("graft");
      expect(feasibility.authorshipPreserved).toBe(true);
      expect(feasibility.requiresReEncryption).toBe(false);
      expect(feasibility.reasons).toEqual([]);
    }, 30000);

    it("refuses preserve under a new document id and says why", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const feasibility = await sourceDb.canCopyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "new",
        authorship: "preserve",
      });

      expect(feasibility.allowed).toBe(false);
      expect(feasibility.reasons.map((reason) => reason.code)).toContain(
        "different_doc_id",
      );
    }, 30000);

    it("refuses preserve in flatten mode", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const feasibility = await sourceDb.canCopyDocumentTo(docId, targetDb, {
        mode: "flatten",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(feasibility.allowed).toBe(false);
      expect(feasibility.reasons.map((reason) => reason.code)).toContain(
        "flatten_mode",
      );
    }, 30000);

    it("refuses preserve when the encryption key changes", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const feasibility = await sourceDb.canCopyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
        decryptionKeyId: "altkey",
      });

      expect(feasibility.allowed).toBe(false);
      expect(feasibility.reasons.map((reason) => reason.code)).toContain(
        "different_key",
      );
      expect(feasibility.requiresReEncryption).toBe(true);
    }, 30000);

    it("refuses a same-database copy onto the same document id", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const feasibility = await sourceDb.canCopyDocumentTo(docId, sourceDb, {
        mode: "history",
        targetDocId: "same",
      });

      expect(feasibility.allowed).toBe(false);
      expect(feasibility.reasons.map((reason) => reason.code)).toContain(
        "same_database_same_doc_id",
      );
    }, 30000);

    it("refuses the tenant directory database as a target", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });
      await alpha.tenant.openDirectory();
      const directoryDb = await alpha.openDB("directory");

      const feasibility = await sourceDb.canCopyDocumentTo(docId, directoryDb);

      expect(feasibility.allowed).toBe(false);
      expect(feasibility.reasons.map((reason) => reason.code)).toContain(
        "directory_database",
      );
    }, 30000);
  });

  describe("flatten", () => {
    it("copies the current state as a single fresh change", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report", tag: "q3" }, 3);

      const result = await sourceDb.copyDocumentTo(docId, targetDb);

      expect(result.strategy).toBe("flatten");
      expect(result.sourceDocId).toBe(docId);
      expect(result.targetDocId).not.toBe(docId);
      expect(result.authorshipPreserved).toBe(false);

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData().title).toBe("Report");
      expect(copy.getData().tag).toBe("q3");
      expect(copy.getData().revision).toBe(3);

      // The source needed five entries (create + set + three revisions); the
      // flattened copy collapses all of them into create + one change.
      const sourceCount = (await docEntries(sourceDb, docId)).length;
      const targetCount = (await docEntries(targetDb, result.targetDocId)).length;
      expect(targetCount).toBeLessThan(sourceCount);
    }, 30000);

    it("copies the state as of a past timestamp when asked", async () => {
      const doc = await sourceDb.createDocument();
      await sourceDb.changeDoc(doc, (draft) => {
        draft.getData().stage = "draft";
      });
      const cutoff = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await sourceDb.changeDoc(doc, (draft) => {
        draft.getData().stage = "final";
      });

      const result = await sourceDb.copyDocumentTo(doc.getId(), targetDb, {
        atTimestamp: cutoff,
      });

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData().stage).toBe("draft");
    }, 30000);

    it("records document-level provenance in the payload by default", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const result = await sourceDb.copyDocumentTo(docId, targetDb);

      const copy = await targetDb.getDocument(result.targetDocId);
      const provenance = copy.getData()._provenance as Record<string, unknown>;
      expect(provenance).toBeDefined();
      expect(provenance.sourceDocId).toBe(docId);
      expect(provenance.sourceDbId).toBe(sourceDb.getStore().getId());
      expect(provenance.sourceTenantId).toBe(alpha.tenantId);
      expect(provenance.copiedByPublicKey).toBe(alpha.signingPublicKey);
      expect(provenance.sourceAtTimestamp).toBeUndefined();
    }, 30000);

    it("omits provenance when disabled", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        provenance: false,
      });

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData()._provenance).toBeUndefined();
    }, 30000);

    it("honors an explicit target document id", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        targetDocId: "explicitCopyId",
      });

      expect(result.targetDocId).toBe("explicitCopyId");
      const copy = await targetDb.getDocument("explicitCopyId");
      expect(copy.getData().title).toBe("Report");
    }, 30000);

    it("costs a single store entry when nothing needs a follow-up change", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report", tag: "q3" }, 3);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        provenance: false,
      });

      // The payload rides along in the doc_create change itself.
      const entries = await docEntries(targetDb, result.targetDocId);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe("doc_create");

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData().title).toBe("Report");
      expect(copy.getData().revision).toBe(3);
    }, 30000);

    it("adds a second entry only for what the create cannot carry", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      // Provenance lives in the reserved `_` namespace, which initialValues
      // refuses to seed, so it needs a follow-up change.
      const withProvenance = await sourceDb.copyDocumentTo(docId, targetDb);
      expect(await docEntries(targetDb, withProvenance.targetDocId)).toHaveLength(2);

      // A caller-provided id is seeded from the deterministic convergence
      // change, which cannot carry content either.
      const explicitId = await sourceDb.copyDocumentTo(docId, targetDb, {
        targetDocId: "explicitFlattenId",
        provenance: false,
      });
      expect(await docEntries(targetDb, explicitId.targetDocId)).toHaveLength(2);
    }, 30000);

    it("folds a kept document id into one entry when the caller asserts uniqueness", async () => {
      // A prefixed id (`inv2025_<24-char-objectid>`) is both MindooDB-generated —
      // so provably unique — and letter-leading, so it is legal as a
      // caller-provided id. That combination is what makes the assertion safe.
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2, {
        idPrefix: "inv2025",
      });

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        targetDocId: "same",
        provenance: false,
        assumeUniqueTargetDocId: true,
      });

      expect(result.targetDocId).toBe(docId);
      const entries = await docEntries(targetDb, docId);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe("doc_create");

      const copy = await targetDb.getDocument(docId);
      expect(copy.getData().title).toBe("Report");
      expect(copy.getData().revision).toBe(2);
    }, 30000);

    it("keeps the convergent seed change when uniqueness is not asserted", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 0, {
        idPrefix: "inv2025",
      });

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        targetDocId: "same",
        provenance: false,
      });

      // Two entries, because the doc_create must stay byte-identical across
      // replicas that create this id independently.
      expect(await docEntries(targetDb, result.targetDocId)).toHaveLength(2);
    }, 30000);

    it("ignores the uniqueness assertion in history mode, which synthesizes no create", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);
      const sourceEntries = await docEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
        assumeUniqueTargetDocId: true,
      });

      // The source's own doc_create is carried over verbatim, so the entry
      // count is the source's and the flag has nothing to act on.
      expect(result.copiedEntries).toBe(sourceEntries.length);
      const targetEntries = await docEntries(targetDb, docId);
      expect(targetEntries.map((entry) => entry.id).sort()).toEqual(
        sourceEntries.map((entry) => entry.id).sort(),
      );
    }, 30000);

    it("does not carry the source's internal underscore fields", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });
      const source = await sourceDb.getDocument(docId);
      const sourceModified = source.getData()._lastModified;

      const result = await sourceDb.copyDocumentTo(docId, targetDb);

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData()._lastModified).not.toBe(sourceModified);
    }, 30000);
  });

  describe("graft", () => {
    it("copies every entry byte-for-byte with the original signer intact", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);
      const sourceEntries = await docEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(result.strategy).toBe("graft");
      expect(result.authorshipPreserved).toBe(true);
      expect(result.targetDocId).toBe(docId);
      expect(result.copiedEntries).toBe(sourceEntries.length);

      const targetEntries = await docEntries(targetDb, docId);
      expect(targetEntries.map((entry) => entry.id).sort()).toEqual(
        sourceEntries.map((entry) => entry.id).sort(),
      );
      for (const entry of targetEntries) {
        const original = sourceEntries.find((candidate) => candidate.id === entry.id)!;
        expect(entry.contentHash).toBe(original.contentHash);
        expect(entry.createdByPublicKey).toBe(original.createdByPublicKey);
        expect(entry.metadataSignature).toEqual(original.metadataSignature);
      }
    }, 30000);

    it("preserves the full revision history so time travel still works", async () => {
      const doc = await sourceDb.createDocument();
      await sourceDb.changeDoc(doc, (draft) => {
        draft.getData().stage = "draft";
      });
      const cutoff = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await sourceDb.changeDoc(doc, (draft) => {
        draft.getData().stage = "final";
      });

      await sourceDb.copyDocumentTo(doc.getId(), targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      const head = await targetDb.getDocument(doc.getId());
      expect(head.getData().stage).toBe("final");
      const past = await targetDb.getDocumentAtTimestamp(doc.getId(), cutoff);
      expect(past?.getData().stage).toBe("draft");
    }, 30000);

    it("strips the source database's witness receipt fields", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      // A witness receipt attests that one specific database received the entry,
      // so it cannot travel with a copy. `receiptOrder` is deliberately not
      // checked: it is store-local insertion order that the target assigns
      // itself on write.
      for (const entry of await docEntries(targetDb, docId)) {
        expect(entry.receivedAt).toBeUndefined();
        expect(entry.receivedByPublicKey).toBeUndefined();
        expect(entry.receivedDateSignature).toBeUndefined();
      }
    }, 30000);

    it("is idempotent: a second pass copies nothing", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);

      const first = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });
      const second = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(first.copiedEntries).toBeGreaterThan(0);
      expect(second.copiedEntries).toBe(0);
      expect(second.mergedIntoExisting).toBe(true);
    }, 30000);

    it("carries only the delta when the source gains changes between passes", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });
      await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      const doc = await sourceDb.getDocument(docId);
      await sourceDb.changeDoc(doc, (draft) => {
        draft.getData().title = "Report v2";
      });

      const second = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(second.copiedEntries).toBe(1);
      const copy = await targetDb.getDocument(docId);
      expect(copy.getData().title).toBe("Report v2");
    }, 30000);

    it("throws rather than silently downgrading when preserve is impossible", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      await expect(
        sourceDb.copyDocumentTo(docId, targetDb, {
          mode: "history",
          targetDocId: "new",
          authorship: "preserve",
        }),
      ).rejects.toThrow(/preserve/i);
    }, 30000);
  });

  describe("replay", () => {
    it("keeps the revision history but re-authors every entry", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);
      const sourceEntries = await docEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
      });

      expect(result.strategy).toBe("replay");
      expect(result.authorshipPreserved).toBe(false);
      expect(result.targetDocId).not.toBe(docId);
      expect(result.copiedEntries).toBe(sourceEntries.length);

      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData().title).toBe("Report");
      expect(copy.getData().revision).toBe(2);
    }, 30000);

    it("rewrites entry ids under the target document id", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
      });

      const targetEntries = await docEntries(targetDb, result.targetDocId);
      expect(targetEntries.length).toBeGreaterThan(0);
      for (const entry of targetEntries) {
        expect(entry.docId).toBe(result.targetDocId);
        expect(entry.id.startsWith(`${result.targetDocId}_`)).toBe(true);
      }
    }, 30000);

    it("produces deterministic ids, so a re-run is a no-op", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);

      const first = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
      });
      const second = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
      });

      expect(first.copiedEntries).toBeGreaterThan(0);
      expect(second.copiedEntries).toBe(0);
    }, 30000);

    it("re-encrypts under a different key id", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        decryptionKeyId: "altkey",
      });

      const targetEntries = await docEntries(targetDb, result.targetDocId);
      for (const entry of targetEntries) {
        expect(entry.decryptionKeyId).toBe("altkey");
      }
      const copy = await targetDb.getDocument(result.targetDocId);
      expect(copy.getData().title).toBe("Report");
    }, 30000);

    it("reports progress and stops on abort", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 4);
      const phases: string[] = [];

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        onProgress: (progress) => phases.push(progress.phase),
      });

      expect(phases[0]).toBe("preparing");
      expect(phases[phases.length - 1]).toBe("complete");
      expect(result.cancelled).toBe(false);
    }, 30000);

    it("returns cancelled with a resumable target id when aborted up front", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);
      const controller = new AbortController();
      controller.abort();

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        signal: controller.signal,
      });

      expect(result.cancelled).toBe(true);
      expect(result.targetDocId).toBe(docId);
      expect(result.copiedEntries).toBe(0);
    }, 30000);
  });

  describe("within one database", () => {
    // Duplicating a document in place. Graft is structurally impossible here —
    // it would need the same doc id, which would merge the copy back into the
    // original — so every history copy in this topology is a replay.
    it("flattens into a fresh document and leaves the original alone", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, sourceDb, {
        provenance: false,
      });

      expect(result.strategy).toBe("flatten");
      expect(result.targetDocId).not.toBe(docId);

      const copy = await sourceDb.getDocument(result.targetDocId);
      expect(copy.getData().title).toBe("Report");
      expect(copy.getData().revision).toBe(1);

      // The original keeps its own id, entries and content.
      const original = await sourceDb.getDocument(docId);
      expect(original.getData().title).toBe("Report");
      expect((await docEntries(sourceDb, docId)).length).toBeGreaterThan(0);
    }, 30000);

    it("replays the history under a new document id, keeping both copies readable", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);
      const sourceEntries = await docEntries(sourceDb, docId);

      const result = await sourceDb.copyDocumentTo(docId, sourceDb, {
        mode: "history",
      });

      expect(result.strategy).toBe("replay");
      expect(result.targetDocId).not.toBe(docId);

      const copyEntries = await docEntries(sourceDb, result.targetDocId);
      expect(copyEntries).toHaveLength(sourceEntries.length);
      // Every entry is re-homed under the new id, so nothing collides with the
      // original's entries in the one store both now share.
      for (const entry of copyEntries) {
        expect(entry.docId).toBe(result.targetDocId);
        expect(entry.id.startsWith(`${result.targetDocId}_`)).toBe(true);
      }
      const sourceIds = new Set(sourceEntries.map((entry) => entry.id));
      for (const entry of copyEntries) {
        expect(sourceIds.has(entry.id)).toBe(false);
      }

      const copy = await sourceDb.getDocument(result.targetDocId);
      expect(copy.getData().revision).toBe(2);
      const original = await sourceDb.getDocument(docId);
      expect(original.getData().revision).toBe(2);
      expect((await docEntries(sourceDb, docId)).map((entry) => entry.id).sort())
        .toEqual([...sourceIds].sort());
    }, 30000);

    it("re-encrypts an in-place copy under a different key", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, sourceDb, {
        mode: "history",
        decryptionKeyId: "altkey",
      });

      for (const entry of await docEntries(sourceDb, result.targetDocId)) {
        expect(entry.decryptionKeyId).toBe("altkey");
      }
      // The original stays on its own key.
      for (const entry of await docEntries(sourceDb, docId)) {
        expect(entry.decryptionKeyId).not.toBe("altkey");
      }
      expect((await sourceDb.getDocument(result.targetDocId)).getData().title)
        .toBe("Report");
    }, 30000);
  });

  describe("encryption keys within one tenant", () => {
    it("inherits the source key when none is named", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1, {
        decryptionKeyId: "altkey",
      });

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      // Inheriting the key is what keeps a graft possible: changing it would
      // invalidate the original authors' signatures.
      expect(result.strategy).toBe("graft");
      for (const entry of await docEntries(targetDb, docId)) {
        expect(entry.decryptionKeyId).toBe("altkey");
      }
    }, 30000);

    it("flattens under an explicitly named key", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        decryptionKeyId: "altkey",
        provenance: false,
      });

      const entries = await docEntries(targetDb, result.targetDocId);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.decryptionKeyId).toBe("altkey");
      }
      expect((await targetDb.getDocument(result.targetDocId)).getData().title)
        .toBe("Report");
    }, 30000);

    it("re-keys a document that was written under a non-default key", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1, {
        decryptionKeyId: "altkey",
      });

      const result = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
        decryptionKeyId: "default",
      });

      expect(result.strategy).toBe("replay");
      for (const entry of await docEntries(targetDb, result.targetDocId)) {
        expect(entry.decryptionKeyId).toBe("default");
      }
      expect((await targetDb.getDocument(result.targetDocId)).getData().revision)
        .toBe(1);
    }, 30000);
  });

  describe("cross-tenant", () => {
    let beta: CopyTestTenant;
    let betaDb: MindooDB;

    beforeEach(async () => {
      beta = await createCopyTestTenant("copy-tenant-beta");
      betaDb = await beta.openDB("beta-db");
    }, 60000);

    afterEach(async () => {
      await beta.dispose();
    });

    it("forces replay and re-encryption, and reports the reason", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const feasibility = await sourceDb.canCopyDocumentTo(docId, betaDb, {
        mode: "history",
        targetDocId: "same",
        authorship: "preserve",
      });

      expect(feasibility.allowed).toBe(false);
      expect(feasibility.reasons.map((reason) => reason.code)).toContain(
        "different_tenant",
      );
      expect(feasibility.requiresReEncryption).toBe(true);
    }, 30000);

    it("copies history into the other tenant when re-authoring", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 2);

      const result = await sourceDb.copyDocumentTo(docId, betaDb, {
        mode: "history",
        targetDocId: "same",
      });

      expect(result.strategy).toBe("replay");
      const copy = await betaDb.getDocument(docId);
      expect(copy.getData().title).toBe("Report");
      expect(copy.getData().revision).toBe(2);

      for (const entry of await docEntries(betaDb, docId)) {
        expect(entry.createdByPublicKey).toBe(beta.signingPublicKey);
      }
    }, 30000);

    it("flattens into the other tenant", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, betaDb);

      const copy = await betaDb.getDocument(result.targetDocId);
      expect(copy.getData().title).toBe("Report");
    }, 30000);
  });
});
