import { webcrypto } from "node:crypto";
import {
  createCopyTestTenant,
  docEntries,
  seedDocument,
  type CopyTestTenant,
} from "./_helpers/copyTestHarness";
import { verifyEntryProvenance } from "../core/copy/provenance";
import {
  buildEntrySigningBytes,
  entrySignatureFieldsFromEntry,
} from "../core/crypto/EntrySignature";
import type { MindooDB, StoreEntryMetadata } from "../core/types";

const subtle = (webcrypto as unknown as Crypto).subtle;

describe("copy provenance", () => {
  let alpha: CopyTestTenant;
  let sourceDb: MindooDB;
  let targetDb: MindooDB;

  beforeEach(async () => {
    alpha = await createCopyTestTenant("prov-tenant-alpha", ["altkey"]);
    sourceDb = await alpha.openDB("source-db");
    targetDb = await alpha.openDB("target-db");
  }, 60000);

  afterEach(async () => {
    await alpha.dispose();
  });

  it("records a cryptographically verifiable origin on every replayed entry", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" }, 2);

    const result = await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
    });

    const copied = await docEntries(targetDb, result.targetDocId);
    expect(copied.length).toBeGreaterThan(0);
    for (const entry of copied) {
      const verification = await verifyEntryProvenance(entry, subtle);
      expect(verification.status).toBe("verified");
      expect(verification.provenance!.sourceTenantId).toBe(alpha.tenantId);
      expect(verification.provenance!.sourceDbId).toBe(sourceDb.getStore().getId());
      expect(verification.provenance!.source.docId).toBe(docId);
      expect(verification.provenance!.source.createdByPublicKey).toBe(
        alpha.signingPublicKey,
      );
    }
  }, 30000);

  it("reports payloadUnchanged when the copy reuses the original ciphertext", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

    const result = await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
    });

    for (const entry of await docEntries(targetDb, result.targetDocId)) {
      const verification = await verifyEntryProvenance(entry, subtle);
      expect(verification.payloadUnchanged).toBe(true);
    }
  }, 30000);

  it("reports payloadUnchanged false once the copy is re-encrypted", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

    const result = await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
      decryptionKeyId: "altkey",
    });

    for (const entry of await docEntries(targetDb, result.targetDocId)) {
      const verification = await verifyEntryProvenance(entry, subtle);
      // The origin claim still verifies — it is a signature over the source's
      // own projection — but it no longer covers this entry's bytes.
      expect(verification.status).toBe("verified");
      expect(verification.payloadUnchanged).toBe(false);
    }
  }, 30000);

  it("binds provenance into the copy's own metadata signature", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" });

    const result = await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
    });

    const [entry] = await docEntries(targetDb, result.targetDocId);
    const withProvenance = buildEntrySigningBytes(
      entrySignatureFieldsFromEntry(entry),
    );
    const withoutProvenance = buildEntrySigningBytes({
      ...entrySignatureFieldsFromEntry(entry),
      provenance: undefined,
    });
    expect(Array.from(withProvenance)).not.toEqual(Array.from(withoutProvenance));
    expect(withProvenance.length).toBeGreaterThan(withoutProvenance.length);
  }, 30000);

  it("rejects a tampered provenance record", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" });

    const result = await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
    });

    const [entry] = await docEntries(targetDb, result.targetDocId);
    const tampered: StoreEntryMetadata = {
      ...entry,
      provenance: {
        ...entry.provenance!,
        source: { ...entry.provenance!.source, docId: "someOtherDoc" },
      },
    };

    const verification = await verifyEntryProvenance(tampered, subtle);
    expect(verification.status).toBe("invalid");
    expect(verification.reason).toMatch(/tampered|fabricated/i);
  }, 30000);

  it("reports absent for entries that were never copied", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" });

    for (const entry of await docEntries(sourceDb, docId)) {
      const verification = await verifyEntryProvenance(entry, subtle);
      expect(verification.status).toBe("absent");
    }
  }, 30000);

  it("reports unverifiable when the source entry predates metadataSignature", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" });
    const [entry] = await docEntries(sourceDb, docId);

    // A v1 entry has no metadataSignature, so the copy can record where the
    // content came from but cannot prove it.
    const legacyCopy: StoreEntryMetadata = {
      ...entry,
      provenance: {
        sourceTenantId: alpha.tenantId,
        sourceDbId: sourceDb.getStore().getId(),
        source: entrySignatureFieldsFromEntry(entry),
        sourceMetadataSignature: undefined,
      },
    };

    const verification = await verifyEntryProvenance(legacyCopy, subtle);
    expect(verification.status).toBe("unverifiable");
    expect(verification.provenance).toBeDefined();
  }, 30000);

  it("omits provenance when the caller opts out", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

    const result = await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
      provenance: false,
    });

    for (const entry of await docEntries(targetDb, result.targetDocId)) {
      expect(entry.provenance).toBeUndefined();
    }
  }, 30000);

  it("does not add provenance to grafted entries, whose originals are intact", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

    await sourceDb.copyDocumentTo(docId, targetDb, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });

    for (const entry of await docEntries(targetDb, docId)) {
      expect(entry.provenance).toBeUndefined();
      expect(entry.createdByPublicKey).toBe(alpha.signingPublicKey);
    }
  }, 30000);

  describe("across tenants", () => {
    let beta: CopyTestTenant;
    let betaDb: MindooDB;

    beforeEach(async () => {
      beta = await createCopyTestTenant("prov-tenant-beta");
      betaDb = await beta.openDB("beta-db");
    }, 60000);

    afterEach(async () => {
      await beta.dispose();
    });

    it("stays verifiable even though the source author is unknown to the target tenant", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" }, 1);

      const result = await sourceDb.copyDocumentTo(docId, betaDb, {
        mode: "history",
      });

      for (const entry of await docEntries(betaDb, result.targetDocId)) {
        const verification = await verifyEntryProvenance(entry, subtle);
        expect(verification.status).toBe("verified");
        expect(verification.provenance!.sourceTenantId).toBe(alpha.tenantId);
        expect(verification.provenance!.source.createdByPublicKey).toBe(
          alpha.signingPublicKey,
        );
        // Cross-tenant always re-encrypts, so the origin signature no longer
        // covers the bytes stored here.
        expect(verification.payloadUnchanged).toBe(false);
        expect(entry.createdByPublicKey).toBe(beta.signingPublicKey);
      }
    }, 30000);

    it("chains provenance through a copy of a copy", async () => {
      const docId = await seedDocument(sourceDb, { title: "Report" });

      const first = await sourceDb.copyDocumentTo(docId, targetDb, {
        mode: "history",
      });
      const second = await targetDb.copyDocumentTo(first.targetDocId, betaDb, {
        mode: "history",
      });

      const [entry] = await docEntries(betaDb, second.targetDocId);
      const verification = await verifyEntryProvenance(entry, subtle);
      expect(verification.status).toBe("verified");
      // The immediate hop names the intermediate database...
      expect(verification.provenance!.sourceDbId).toBe(targetDb.getStore().getId());
      // ...and the nested record still names the original one.
      const inner = verification.provenance!.source.provenance;
      expect(inner).toBeDefined();
      expect(inner!.sourceDbId).toBe(sourceDb.getStore().getId());
      expect(inner!.source.docId).toBe(docId);
    }, 30000);
  });
});
