import { webcrypto } from "node:crypto";
import {
  createCopyTestTenant,
  docEntries,
  seedDocument,
  type CopyTestTenant,
} from "./_helpers/copyTestHarness";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { verifyEntryProvenance } from "../core/copy/provenance";
import {
  DocumentArchiveConflictError,
  DocumentArchiveFormatError,
  type DocumentArchiveManifest,
} from "../core/archive/documentArchive";
import type { MindooDB, MindooDoc } from "../core/types";

const subtle = (webcrypto as unknown as Crypto).subtle;
const attachmentConfig = { attachmentConfig: { chunkSizeBytes: 128 } };

function payloadBytes(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * seed + 13) % 256;
  }
  return bytes;
}

async function readAttachment(doc: MindooDoc, attachmentId: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of doc.streamAttachment(attachmentId)) {
    parts.push(part);
  }
  const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

async function chunkEntries(db: MindooDB, docId: string) {
  return (await db.getAttachmentStore().findNewEntriesForDoc([], docId)).filter(
    (entry) => entry.entryType === "attachment_chunk",
  );
}

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

describe("document archives", () => {
  let alpha: CopyTestTenant;
  let beta: CopyTestTenant;
  let sourceDb: MindooDB;
  let targetDb: MindooDB;

  beforeEach(async () => {
    alpha = await createCopyTestTenant("archive-tenant-alpha");
    beta = await createCopyTestTenant("archive-tenant-beta");
    sourceDb = await alpha.openDB("source-db", attachmentConfig);
    targetDb = await beta.openDB("target-db", attachmentConfig);
  }, 60000);

  afterEach(async () => {
    await alpha.dispose();
    await beta.dispose();
  });

  async function seedWithAttachment(db: MindooDB) {
    const doc = await db.createDocument();
    const bytes = payloadBytes(1000);
    let attachmentId = "";
    await db.changeDoc(doc, async (draft) => {
      draft.getData().title = "With attachment";
      const ref = await draft.addAttachment(bytes, "payload.bin", "application/octet-stream");
      attachmentId = ref.attachmentId;
    });
    await db.changeDoc(doc, (draft) => {
      draft.getData().title = "Renamed";
    });
    return { docId: doc.getId(), attachmentId, bytes };
  }

  it("writes the documented layout with a manifest, hashes and authors", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" }, 2);

    const files = await sourceDb.exportDocumentArchive([docId], {
      location: "Local",
      tenantLabel: "Alpha",
      note: "broken on two devices",
    });

    const manifest = decodeJson<DocumentArchiveManifest>(files["manifest.json"]);
    expect(manifest.format).toBe("mindoodb-document-archive");
    expect(manifest.version).toBe(1);
    expect(manifest.content).toBe("plain");
    expect(manifest.source).toEqual({
      tenantId: alpha.tenantId,
      dbId: sourceDb.getStore().getId(),
      location: "Local",
      tenantLabel: "Alpha",
    });
    expect(manifest.note).toBe("broken on two devices");
    expect(manifest.exportedBy.signingPublicKey).toBe(alpha.signingPublicKey);
    expect(manifest.documents).toHaveLength(1);
    expect(manifest.documents[0].docId).toBe(docId);
    // create + first change + two revisions
    expect(manifest.documents[0].entryCount).toBe(4);
    expect(manifest.documents[0].headEntryIds).toHaveLength(1);
    expect(files["manifest.sig"]).toBeDefined();

    const entries = await docEntries(sourceDb, docId);
    for (const entry of entries) {
      expect(files[`documents/${docId}/entries/${entry.id}.json`]).toBeDefined();
      expect(files[`documents/${docId}/changes/${entry.id}.bin`]).toBeDefined();
    }
    for (const path of Object.keys(files)) {
      if (path === "manifest.json" || path === "manifest.sig") continue;
      expect(manifest.files[path]).toMatch(/^[0-9a-f]{64}$/);
    }

    const authors = decodeJson<Array<{ signingPublicKey: string; username: string | null }>>(
      files["authors.json"],
    );
    expect(authors).toEqual([
      expect.objectContaining({
        signingPublicKey: alpha.signingPublicKey,
        username: `CN=user/O=${alpha.tenantId}`,
        entryCount: 4,
      }),
    ]);
  }, 30000);

  it("imports into another tenant with the same entry ids, dependencies and verified provenance", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report", amount: 7 }, 3);
    const sourceEntries = await docEntries(sourceDb, docId);

    const archive = await targetDb.readDocumentArchive(
      await sourceDb.exportDocumentArchive([docId]),
    );
    expect(archive.exporterSignature).toBe("verified");
    expect(await targetDb.checkDocumentArchiveImport(archive)).toEqual({
      existingDocIds: [],
      newDocIds: [docId],
    });

    const result = await targetDb.importDocumentArchive(archive);
    expect(result).toEqual({ importedDocIds: [docId], importedEntries: 5, importedChunks: 0 });

    const imported = await docEntries(targetDb, docId);
    expect(imported.map((entry) => entry.id).sort()).toEqual(
      sourceEntries.map((entry) => entry.id).sort(),
    );
    for (const entry of imported) {
      const original = sourceEntries.find((candidate) => candidate.id === entry.id)!;
      expect(entry.dependencyIds).toEqual(original.dependencyIds);
      expect(entry.createdByPublicKey).toBe(beta.signingPublicKey);
      const verification = await verifyEntryProvenance(entry, subtle);
      expect(verification.status).toBe("verified");
      expect(verification.provenance!.sourceTenantId).toBe(alpha.tenantId);
      expect(verification.provenance!.sourceDbId).toBe(sourceDb.getStore().getId());
      expect(verification.provenance!.source.createdByPublicKey).toBe(alpha.signingPublicKey);
      expect(verification.provenance!.source.createdAt).toBe(original.createdAt);
    }

    const doc = await targetDb.getDocument(docId);
    expect(doc.getData()).toMatchObject({ title: "Report", amount: 7, revision: 3 });
  }, 30000);

  it("keeps a branched history with both heads", async () => {
    const docId = await seedDocument(sourceDb, { title: "Base" });
    // A second device: the same tenant and user on stores of its own.
    const deviceFactory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const deviceTenant = await deviceFactory.openTenant(
      alpha.tenantId,
      alpha.tenant.getAdministrationPublicKey(),
      alpha.tenant.getAdministrationEncryptionPublicKey(),
      alpha.user,
      alpha.userPassword,
      alpha.keyBag,
    );
    await (await deviceTenant.openDB("directory")).pullChangesFrom(
      (await alpha.openDB("directory")).getStore(),
    );
    const peerDb = await deviceTenant.openDB("source-db", attachmentConfig);
    await peerDb.pullChangesFrom(sourceDb.getStore());
    await peerDb.syncStoreChanges();
    await sourceDb.changeDoc(await sourceDb.getDocument(docId), (draft) => {
      draft.getData().left = "device A";
    });
    await peerDb.changeDoc(await peerDb.getDocument(docId), (draft) => {
      draft.getData().right = "device B";
    });
    await sourceDb.pullChangesFrom(peerDb.getStore());
    await sourceDb.syncStoreChanges();

    const files = await sourceDb.exportDocumentArchive([docId]);
    const manifest = decodeJson<DocumentArchiveManifest>(files["manifest.json"]);
    expect(manifest.documents[0].headEntryIds).toHaveLength(2);

    await targetDb.importDocumentArchive(await targetDb.readDocumentArchive(files));
    const doc = await targetDb.getDocument(docId);
    expect(doc.getData()).toMatchObject({ title: "Base", left: "device A", right: "device B" });
  }, 30000);

  it("carries attachments, readable after the import", async () => {
    const { docId, attachmentId, bytes } = await seedWithAttachment(sourceDb);
    const sourceChunks = await chunkEntries(sourceDb, docId);
    expect(sourceChunks.length).toBeGreaterThan(1);

    const files = await sourceDb.exportDocumentArchive([docId]);
    expect(
      Object.keys(files).filter((path) =>
        path.startsWith(`documents/${docId}/attachments/${attachmentId}/chunks/`),
      ),
    ).toHaveLength(sourceChunks.length);

    const result = await targetDb.importDocumentArchive(await targetDb.readDocumentArchive(files));
    expect(result.importedChunks).toBe(sourceChunks.length);

    const targetChunks = await chunkEntries(targetDb, docId);
    expect(targetChunks.map((chunk) => chunk.id).sort()).toEqual(
      sourceChunks.map((chunk) => chunk.id).sort(),
    );
    for (const chunk of targetChunks) {
      expect((await verifyEntryProvenance(chunk, subtle)).status).toBe("verified");
    }
    const doc = await targetDb.getDocument(docId);
    expect(doc.getData().title).toBe("Renamed");
    expect(await readAttachment(doc, attachmentId)).toEqual(bytes);
  }, 30000);

  it("imports into another database of the same tenant", async () => {
    const docId = await seedDocument(sourceDb, { title: "Same tenant" }, 1);
    const otherDb = await alpha.openDB("other-db", attachmentConfig);

    await otherDb.importDocumentArchive(
      await otherDb.readDocumentArchive(await sourceDb.exportDocumentArchive([docId])),
    );

    expect((await otherDb.getDocument(docId)).getData()).toMatchObject({
      title: "Same tenant",
      revision: 1,
    });
    for (const entry of await docEntries(otherDb, docId)) {
      expect((await verifyEntryProvenance(entry, subtle)).status).toBe("verified");
    }
  }, 30000);

  it("refuses to import a document that exists in the target and writes nothing", async () => {
    const existing = await seedDocument(sourceDb, { title: "Exists" });
    const fresh = await seedDocument(sourceDb, { title: "Fresh" });
    const archive = await sourceDb.readDocumentArchive(
      await sourceDb.exportDocumentArchive([existing, fresh]),
    );

    // Importing into the source itself: one of the two ids exists.
    const otherDb = await alpha.openDB("other-db");
    await otherDb.importDocumentArchive(archive, { docIds: [existing] });
    expect(await otherDb.checkDocumentArchiveImport(archive)).toEqual({
      existingDocIds: [existing],
      newDocIds: [fresh],
    });

    await expect(otherDb.importDocumentArchive(archive)).rejects.toBeInstanceOf(
      DocumentArchiveConflictError,
    );
    expect(await docEntries(otherDb, fresh)).toHaveLength(0);
  }, 30000);

  it("rejects a tampered archive", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" });
    const files = await sourceDb.exportDocumentArchive([docId]);
    const changePath = Object.keys(files).find((path) => path.includes("/changes/"))!;
    const tampered = { ...files, [changePath]: new Uint8Array([1, 2, 3]) };

    await expect(targetDb.readDocumentArchive(tampered)).rejects.toBeInstanceOf(
      DocumentArchiveFormatError,
    );
    await expect(
      targetDb.readDocumentArchive({ ...files, "extra.txt": new Uint8Array([1]) }),
    ).rejects.toThrow(/not listed/);
  }, 30000);

  it("reports a forged manifest signature", async () => {
    const docId = await seedDocument(sourceDb, { title: "Report" });
    const files = await sourceDb.exportDocumentArchive([docId]);
    const manifest = decodeJson<DocumentArchiveManifest>(files["manifest.json"]);
    manifest.note = "edited later";
    const forged = {
      ...files,
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    };

    expect((await targetDb.readDocumentArchive(forged)).exporterSignature).toBe("invalid");
  }, 30000);

  it("refuses an unknown document id on export", async () => {
    await expect(sourceDb.exportDocumentArchive(["missing-doc"])).rejects.toThrow(
      /does not exist/,
    );
  }, 30000);
});
