# Document Archives

A document archive is a portable copy of chosen documents with their complete
revision history, their attachment chunks and the authors of every revision.
It is meant for support: a document got into a bad state on a user's devices,
the user exports it, and a developer imports it into a fresh database of their
own to inspect or replay the history.

Haven zips the archive and calls the file `MindooDB Document Archive`
(`.mdbdocs`). MindooDB itself only produces and reads the file map, so the
container (zip, password, sealing to a recipient) stays with the application.

## API

```ts
// Export: path -> bytes
const files = await db.exportDocumentArchive([docId], {
  location: "Local",
  tenantLabel: "Acme",
  note: "Broken after editing on two devices",
});

// Read and verify (file hashes + exporter signature over the manifest)
const archive = await targetDb.readDocumentArchive(files);

// Which documents exist in the target already?
const { existingDocIds, newDocIds } = await targetDb.checkDocumentArchiveImport(archive);

// Import (refuses with DocumentArchiveConflictError if any document exists)
await targetDb.importDocumentArchive(archive);
```

## Layout (version 1, `content: "plain"`)

```
manifest.json                    format, version, source tenant/db, exporter, documents, SHA-256 per file
manifest.sig                     exporter's Ed25519 signature over manifest.json (base64)
authors.json                     signing public key -> user name, as the source directory knew it
documents/<docId>/document.json  heads, counts, first/last time, deleted flag
documents/<docId>/history.json   entry ids in causal order, chunk ids per attachment
documents/<docId>/entries/<entryId>.json   entry metadata, signatures as base64
documents/<docId>/changes/<entryId>.bin    decrypted payload (Automerge change or snapshot)
documents/<docId>/attachments/<attachmentId>/entries/<chunkId>.json
documents/<docId>/attachments/<attachmentId>/chunks/<chunkId>.bin
```

"Plain" means the payloads are decrypted. Treat a plain archive like the
document itself and protect the container.

`readDocumentArchive` rejects an archive whose files do not match the hashes in
the manifest or that contains files the manifest does not list. The exporter
signature only proves that the manifest was not edited after the export; it
does not prove who the exporting key belongs to.

## Import semantics

Signatures only verify in the tenant they were made in, so an import works like
a replay copy (see [Document Copy & Sharding](document-copy.md)):

- Entry ids, dependency ids and the Automerge bytes stay unchanged, so the
  revision graph (including branches from concurrent edits) is identical.
- Every entry is encrypted with the target's key and signed by the importing
  user.
- Every entry, attachment chunks included, carries a provenance record with the
  original entry's signed projection and the original author's metadata
  signature. `verifyEntryProvenance` returns `verified` for it, so the original
  author and time of every revision can still be proven.
- Timestamps are rewritten to import time, keeping their order, exactly like a
  copy.
- If any document of the archive already exists in the target, nothing is
  imported. Apps reference documents by id (a TeamEdit document and its
  TeamSketchbook drawings, for example), so the safe place for an import is a
  new database, ideally in a separate test tenant, because attachment chunk ids
  are kept too.

Sealed documents (encrypted for individual users) cannot be exported yet.
