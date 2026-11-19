/**
 * Document archives: a portable, file-based copy of chosen documents with their
 * complete revision history, their attachment chunks and who wrote what when.
 *
 * The use case is support. A document got into a bad state on a customer's
 * devices; the customer exports it, a developer imports it into a fresh
 * database of their own and replays, inspects or repairs the history there.
 *
 * Format (version 1, `content: "plain"`). The archive is a flat map of paths to
 * bytes, laid out like the on-disk store so it can be read by eye once zipped:
 *
 * ```
 * manifest.json                    format, source, exporter, documents, file hashes
 * manifest.sig                     exporter's Ed25519 signature over manifest.json (base64)
 * authors.json                     signing public key -> user name, as the source directory knew it
 * documents/<docId>/document.json  per-document summary (heads, counts)
 * documents/<docId>/history.json   entry ids in causal order
 * documents/<docId>/entries/<entryId>.json   entry metadata, signatures as base64
 * documents/<docId>/changes/<entryId>.bin    decrypted payload (Automerge change/snapshot bytes)
 * documents/<docId>/attachments/<attachmentId>/entries/<chunkId>.json
 * documents/<docId>/attachments/<attachmentId>/chunks/<chunkId>.bin   decrypted chunk bytes
 * ```
 *
 * "plain" means the payloads are decrypted: the archive is only as safe as the
 * container it travels in. Zipping and encrypting the container is up to the
 * caller (Haven protects it with a password).
 *
 * Signatures only verify in the system they were made in, so an import cannot
 * keep them. It works like a replay copy (`copy/copyDocument.ts`): every entry
 * keeps its id, dependencies and Automerge bytes, is encrypted with the target's
 * key and signed by the importing user, and carries a provenance record with
 * the original entry's signed projection and signature. `verifyEntryProvenance`
 * then still proves who wrote each revision originally.
 *
 * @module
 */

import { orderDagEntriesCausally } from "../DocumentDagAnalysis";
import {
  base64ToBytes,
  bytesToBase64,
  importEd25519PublicKeyFromPem,
  type EntryProvenance,
} from "../crypto/EntrySignature";
import type { CopyEngineHost } from "../copy/host";
import { isDocumentDagEntry } from "../copy/entryRewrite";
import { describeAdmissionFailure, preflightCopyAdmission } from "../copy/preflight";
import { buildProvenanceFromEntry } from "../copy/provenance";
import { isSealedKeyId } from "../userkeys/sealedTypes";
import { computeContentHash } from "../utils/idGeneration";
import { semanticNow } from "../utils/timeSource";
import {
  CURRENT_STORE_ENTRY_VERSION,
  type StoreEntry,
  type StoreEntryAttachmentRef,
  type StoreEntryMetadata,
  type StoreEntryType,
} from "../types";

/** Value of `manifest.format`. */
export const DOCUMENT_ARCHIVE_FORMAT = "mindoodb-document-archive";
/** Highest archive format version this code reads and the one it writes. */
export const DOCUMENT_ARCHIVE_VERSION = 1;
/** Suggested file extension of a zipped archive. */
export const DOCUMENT_ARCHIVE_EXTENSION = ".mdbdocs";

/** An archive as a map of relative paths to file contents. */
export type DocumentArchiveFiles = Record<string, Uint8Array>;

/** One entry's metadata as stored in the archive (binary fields as base64). */
export interface DocumentArchiveEntryRecord {
  entryType: StoreEntryType;
  id: string;
  docId: string;
  dependencyIds: string[];
  createdAt: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  contentHash: string;
  signature: string;
  metadataSignature?: string;
  provenance?: EntryProvenance;
  snapshotHeadHashes?: string[];
  snapshotHeadEntryIds?: string[];
  attachmentId?: string;
  attachmentIds?: string[];
  attachmentRefs?: StoreEntryAttachmentRef[];
  originalSize: number;
  encryptedSize: number;
  entryVersion?: number;
  receiptOrder?: number;
  receivedAt?: number;
  receivedByPublicKey?: string;
  receivedDateSignature?: string;
  receiptScheme?: string;
}

/** Per-document summary in the manifest and in `document.json`. */
export interface DocumentArchiveDocumentSummary {
  docId: string;
  /** Revision entries (create, change, delete, undelete, snapshot). */
  entryCount: number;
  /** Attachment chunk entries. */
  chunkCount: number;
  /** Distinct attachments the chunks belong to. */
  attachmentCount: number;
  /** Entry ids no other entry depends on: the document's current heads. */
  headEntryIds: string[];
  /** Oldest and newest `createdAt` of the revision entries. */
  firstCreatedAt: number;
  lastCreatedAt: number;
  /** Whether the latest revision is a deletion. */
  deleted: boolean;
}

/** Contents of `manifest.json`. */
export interface DocumentArchiveManifest {
  format: typeof DOCUMENT_ARCHIVE_FORMAT;
  version: number;
  content: "plain";
  /** ISO time of the export. */
  createdAt: string;
  source: {
    tenantId: string;
    dbId: string;
    /** Free text the caller supplies, e.g. "Local" or a server URL. */
    location?: string;
    /** Free text the caller supplies, e.g. the tenant's display name. */
    tenantLabel?: string;
  };
  exportedBy: {
    signingPublicKey: string;
    username?: string;
  };
  /** Free text, e.g. what went wrong. */
  note?: string;
  documents: DocumentArchiveDocumentSummary[];
  /** SHA-256 (hex) of every other file in the archive. */
  files: Record<string, string>;
}

/** One line of `authors.json`. */
export interface DocumentArchiveAuthor {
  signingPublicKey: string;
  /** Null when the source directory did not know the key. */
  username: string | null;
  entryCount: number;
}

/** A parsed and integrity-checked archive. */
export interface DocumentArchive {
  manifest: DocumentArchiveManifest;
  authors: DocumentArchiveAuthor[];
  documents: DocumentArchiveDocument[];
  /** What could be established about the exporter's manifest signature. */
  exporterSignature: "verified" | "invalid" | "missing";
}

/** One document of a parsed archive. */
export interface DocumentArchiveDocument {
  summary: DocumentArchiveDocumentSummary;
  /** Revision entries in causal order. */
  entries: Array<{ record: DocumentArchiveEntryRecord; payload: Uint8Array }>;
  /** Attachment chunks, in dependency order per attachment. */
  chunks: Array<{ record: DocumentArchiveEntryRecord; payload: Uint8Array }>;
}

/** Options for {@link exportDocumentArchive}. */
export interface ExportDocumentArchiveOptions {
  /** Shown in the manifest as `source.location`. */
  location?: string;
  /** Shown in the manifest as `source.tenantLabel`. */
  tenantLabel?: string;
  /** Free text stored in the manifest. */
  note?: string;
  signal?: AbortSignal;
}

/** Options for {@link importDocumentArchive}. */
export interface ImportDocumentArchiveOptions {
  /**
   * Key to encrypt the imported entries with. Defaults to the entry's original
   * key id when importing into the source tenant and to `"default"` otherwise.
   */
  decryptionKeyId?: string;
  /** Only import these documents of the archive. Defaults to all of them. */
  docIds?: string[];
  /** Skip the write-access precheck (admin tooling only). */
  bypassAccessControlPrecheck?: boolean;
  signal?: AbortSignal;
}

/** Result of {@link importDocumentArchive}. */
export interface ImportDocumentArchiveResult {
  importedDocIds: string[];
  importedEntries: number;
  importedChunks: number;
}

/** What {@link checkDocumentArchiveImport} found in the target database. */
export interface DocumentArchiveImportCheck {
  /** Archived documents whose id already exists in the target. */
  existingDocIds: string[];
  /** Archived documents that do not exist in the target yet. */
  newDocIds: string[];
}

/** Thrown when an archive is malformed, from an unknown version or tampered with. */
export class DocumentArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentArchiveFormatError";
  }
}

/** Thrown when an import would write into documents that already exist. */
export class DocumentArchiveConflictError extends Error {
  constructor(readonly existingDocIds: string[]) {
    super(
      `These documents already exist in the target database: ${existingDocIds.join(", ")}. ` +
        "Import the archive into a new database instead.",
    );
    this.name = "DocumentArchiveConflictError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Make an id safe as one path segment. Entry and document ids are already
 * restricted to safe characters; this is a guard, not an encoding.
 */
function pathSegment(id: string): string {
  if (!id || id === "." || id === ".." || /[\\/\u0000]/.test(id)) {
    throw new DocumentArchiveFormatError(`Unsafe id for an archive path: ${JSON.stringify(id)}`);
  }
  return id;
}

async function sha256Hex(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toRecord(entry: StoreEntryMetadata): DocumentArchiveEntryRecord {
  const record: DocumentArchiveEntryRecord = {
    entryType: entry.entryType,
    id: entry.id,
    docId: entry.docId,
    dependencyIds: [...entry.dependencyIds],
    createdAt: entry.createdAt,
    createdByPublicKey: entry.createdByPublicKey,
    decryptionKeyId: entry.decryptionKeyId,
    contentHash: entry.contentHash,
    signature: bytesToBase64(entry.signature),
    originalSize: entry.originalSize,
    encryptedSize: entry.encryptedSize,
  };
  if (entry.metadataSignature) record.metadataSignature = bytesToBase64(entry.metadataSignature);
  if (entry.provenance) record.provenance = entry.provenance;
  if (entry.snapshotHeadHashes) record.snapshotHeadHashes = entry.snapshotHeadHashes;
  if (entry.snapshotHeadEntryIds) record.snapshotHeadEntryIds = entry.snapshotHeadEntryIds;
  if (entry.attachmentId) record.attachmentId = entry.attachmentId;
  if (entry.attachmentIds) record.attachmentIds = entry.attachmentIds;
  if (entry.attachmentRefs) record.attachmentRefs = entry.attachmentRefs;
  if (entry.entryVersion !== undefined) record.entryVersion = entry.entryVersion;
  if (entry.receiptOrder !== undefined) record.receiptOrder = entry.receiptOrder;
  if (entry.receivedAt !== undefined) record.receivedAt = entry.receivedAt;
  if (entry.receivedByPublicKey) record.receivedByPublicKey = entry.receivedByPublicKey;
  if (entry.receivedDateSignature) {
    record.receivedDateSignature = bytesToBase64(entry.receivedDateSignature);
  }
  if (entry.receiptScheme) record.receiptScheme = entry.receiptScheme;
  return record;
}

/** The archived entry as store metadata, as the source system held it. */
function fromRecord(record: DocumentArchiveEntryRecord): StoreEntryMetadata {
  const meta: StoreEntryMetadata = {
    entryType: record.entryType,
    id: record.id,
    docId: record.docId,
    dependencyIds: record.dependencyIds,
    createdAt: record.createdAt,
    createdByPublicKey: record.createdByPublicKey,
    decryptionKeyId: record.decryptionKeyId,
    contentHash: record.contentHash,
    signature: base64ToBytes(record.signature),
    originalSize: record.originalSize,
    encryptedSize: record.encryptedSize,
  };
  if (record.metadataSignature) meta.metadataSignature = base64ToBytes(record.metadataSignature);
  if (record.provenance) meta.provenance = record.provenance;
  if (record.snapshotHeadHashes) meta.snapshotHeadHashes = record.snapshotHeadHashes;
  if (record.snapshotHeadEntryIds) meta.snapshotHeadEntryIds = record.snapshotHeadEntryIds;
  if (record.attachmentId) meta.attachmentId = record.attachmentId;
  if (record.attachmentIds) meta.attachmentIds = record.attachmentIds;
  if (record.attachmentRefs) meta.attachmentRefs = record.attachmentRefs;
  if (record.entryVersion !== undefined) meta.entryVersion = record.entryVersion;
  return meta;
}

/** Order chunks so each comes after the chunk it depends on, per attachment. */
function orderChunks(chunks: StoreEntryMetadata[]): StoreEntryMetadata[] {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const ordered: StoreEntryMetadata[] = [];
  const placed = new Set<string>();
  const visit = (chunk: StoreEntryMetadata, depth: number) => {
    if (placed.has(chunk.id) || depth > chunks.length) return;
    for (const dependencyId of chunk.dependencyIds) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency, depth + 1);
    }
    if (!placed.has(chunk.id)) {
      placed.add(chunk.id);
      ordered.push(chunk);
    }
  };
  const sorted = [...chunks].sort(
    (left, right) =>
      (left.attachmentId ?? "").localeCompare(right.attachmentId ?? "") ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  );
  for (const chunk of sorted) visit(chunk, 0);
  return ordered;
}

function summarize(
  docId: string,
  entries: StoreEntryMetadata[],
  chunks: StoreEntryMetadata[],
): DocumentArchiveDocumentSummary {
  const referenced = new Set(entries.flatMap((entry) => entry.dependencyIds));
  const heads = entries.filter((entry) => !referenced.has(entry.id));
  const times = entries.map((entry) => entry.createdAt);
  const latest = [...heads].sort((left, right) => right.createdAt - left.createdAt)[0];
  return {
    docId,
    entryCount: entries.length,
    chunkCount: chunks.length,
    attachmentCount: new Set(chunks.map((chunk) => chunk.attachmentId ?? "")).size,
    headEntryIds: heads.map((entry) => entry.id).sort(),
    firstCreatedAt: times.length ? Math.min(...times) : 0,
    lastCreatedAt: times.length ? Math.max(...times) : 0,
    deleted: latest?.entryType === "doc_delete",
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("The archive operation was cancelled.", "AbortError");
  }
}

/**
 * Write the chosen documents of a database into a plain archive.
 *
 * @param source The database to export from.
 * @param docIds The documents to export. Unknown ids are an error.
 */
export async function exportDocumentArchive(
  source: CopyEngineHost,
  docIds: string[],
  options: ExportDocumentArchiveOptions = {},
): Promise<DocumentArchiveFiles> {
  const uniqueDocIds = [...new Set(docIds)];
  if (uniqueDocIds.length === 0) {
    throw new Error("Choose at least one document to export.");
  }
  const files: DocumentArchiveFiles = {};
  const summaries: DocumentArchiveDocumentSummary[] = [];
  const entriesByAuthor = new Map<string, number>();

  for (const docId of uniqueDocIds) {
    throwIfAborted(options.signal);
    const root = `documents/${pathSegment(docId)}`;
    const dagMetadata = (await source.store.findNewEntriesForDoc([], docId)).filter(
      isDocumentDagEntry,
    );
    if (dagMetadata.length === 0) {
      throw new Error(`Document ${docId} does not exist in this database.`);
    }
    const ordered = orderDagEntriesCausally(dagMetadata);
    const fetched = new Map(
      (await source.store.getEntries(ordered.map((entry) => entry.id))).map((entry) => [
        entry.id,
        entry,
      ]),
    );
    const exportedEntries: StoreEntryMetadata[] = [];
    for (const metadata of ordered) {
      const entry = fetched.get(metadata.id);
      if (!entry) continue;
      if (entry.recipients || isSealedKeyId(entry.decryptionKeyId)) {
        throw new Error(
          `Document ${docId} is sealed to individual users; sealed documents cannot be exported yet.`,
        );
      }
      const payload = await source.tenant.decryptPayload(
        entry.encryptedData,
        entry.decryptionKeyId,
      );
      files[`${root}/entries/${pathSegment(entry.id)}.json`] = jsonBytes(toRecord(entry));
      files[`${root}/changes/${pathSegment(entry.id)}.bin`] = payload;
      exportedEntries.push(entry);
      entriesByAuthor.set(
        entry.createdByPublicKey,
        (entriesByAuthor.get(entry.createdByPublicKey) ?? 0) + 1,
      );
      if (entry.provenance?.source.createdByPublicKey) {
        const original = entry.provenance.source.createdByPublicKey;
        entriesByAuthor.set(original, entriesByAuthor.get(original) ?? 0);
      }
    }

    const chunkMetadata = orderChunks(
      (await source.attachmentStore.findNewEntriesForDoc([], docId)).filter(
        (entry) => entry.entryType === "attachment_chunk",
      ),
    );
    const exportedChunks: StoreEntryMetadata[] = [];
    if (chunkMetadata.length > 0) {
      const chunks = new Map(
        (await source.attachmentStore.getEntries(chunkMetadata.map((chunk) => chunk.id))).map(
          (chunk) => [chunk.id, chunk],
        ),
      );
      for (const metadata of chunkMetadata) {
        throwIfAborted(options.signal);
        const chunk = chunks.get(metadata.id);
        if (!chunk) continue;
        const payload = await source.decryptAttachmentPayload(
          chunk.encryptedData,
          chunk.decryptionKeyId,
        );
        const folder = `${root}/attachments/${pathSegment(chunk.attachmentId ?? "unknown")}`;
        files[`${folder}/entries/${pathSegment(chunk.id)}.json`] = jsonBytes(toRecord(chunk));
        files[`${folder}/chunks/${pathSegment(chunk.id)}.bin`] = payload;
        exportedChunks.push(chunk);
      }
    }

    const summary = summarize(docId, exportedEntries, exportedChunks);
    summaries.push(summary);
    files[`${root}/document.json`] = jsonBytes(summary);
    files[`${root}/history.json`] = jsonBytes({
      docId,
      entries: exportedEntries.map((entry) => ({
        id: entry.id,
        entryType: entry.entryType,
        createdAt: entry.createdAt,
        createdByPublicKey: entry.createdByPublicKey,
        dependencyIds: entry.dependencyIds,
      })),
      chunks: exportedChunks.map((chunk) => ({
        id: chunk.id,
        attachmentId: chunk.attachmentId,
        dependencyIds: chunk.dependencyIds,
      })),
    });
  }

  const authors: DocumentArchiveAuthor[] = [];
  let directory: Awaited<ReturnType<typeof source.tenant.openDirectory>> | null = null;
  try {
    directory = await source.tenant.openDirectory();
  } catch {
    directory = null;
  }
  for (const [signingPublicKey, entryCount] of entriesByAuthor) {
    let username: string | null = null;
    try {
      username = (await directory?.getUserBySigningPublicKey(signingPublicKey))?.username ?? null;
    } catch {
      username = null;
    }
    authors.push({ signingPublicKey, username, entryCount });
  }
  authors.sort((left, right) => right.entryCount - left.entryCount);
  files["authors.json"] = jsonBytes(authors);

  const subtle = source.tenant.getCryptoAdapter().getSubtle();
  const hashes: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) {
    hashes[path] = await sha256Hex(files[path], subtle);
  }
  const exporter = await source.tenant.getCurrentUserId();
  const manifest: DocumentArchiveManifest = {
    format: DOCUMENT_ARCHIVE_FORMAT,
    version: DOCUMENT_ARCHIVE_VERSION,
    content: "plain",
    createdAt: new Date().toISOString(),
    source: {
      tenantId: source.tenant.getId(),
      dbId: source.store.getId(),
      ...(options.location ? { location: options.location } : {}),
      ...(options.tenantLabel ? { tenantLabel: options.tenantLabel } : {}),
    },
    exportedBy: {
      signingPublicKey: exporter.userSigningPublicKey,
      ...(exporter.username ? { username: exporter.username } : {}),
    },
    ...(options.note ? { note: options.note } : {}),
    documents: summaries,
    files: hashes,
  };
  const manifestBytes = jsonBytes(manifest);
  files["manifest.json"] = manifestBytes;
  files["manifest.sig"] = textEncoder.encode(
    bytesToBase64(await source.tenant.signPayload(manifestBytes)),
  );
  return files;
}

function parseJson<T>(files: DocumentArchiveFiles, path: string): T {
  const bytes = files[path];
  if (!bytes) {
    throw new DocumentArchiveFormatError(`The archive is missing ${path}.`);
  }
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    throw new DocumentArchiveFormatError(`${path} is not valid JSON.`);
  }
}

/**
 * Parse an archive and check its integrity: format and version, the SHA-256 of
 * every file named in the manifest, and that no unlisted file is present.
 *
 * The exporter's manifest signature is checked against the key the manifest
 * itself names. That proves the manifest was not edited after the export; it
 * does not prove who the key belongs to (the importing tenant usually does not
 * know the exporter).
 */
export async function readDocumentArchive(
  files: DocumentArchiveFiles,
  subtle: SubtleCrypto,
): Promise<DocumentArchive> {
  const manifest = parseJson<DocumentArchiveManifest>(files, "manifest.json");
  if (manifest.format !== DOCUMENT_ARCHIVE_FORMAT) {
    throw new DocumentArchiveFormatError("This file is not a MindooDB document archive.");
  }
  if (typeof manifest.version !== "number" || manifest.version > DOCUMENT_ARCHIVE_VERSION) {
    throw new DocumentArchiveFormatError(
      `Archive version ${String(manifest.version)} is newer than this software understands.`,
    );
  }
  if (manifest.content !== "plain") {
    throw new DocumentArchiveFormatError(`Archive content "${String(manifest.content)}" is not supported.`);
  }
  for (const [path, expected] of Object.entries(manifest.files ?? {})) {
    const bytes = files[path];
    if (!bytes) {
      throw new DocumentArchiveFormatError(`The archive is missing ${path}.`);
    }
    if ((await sha256Hex(bytes, subtle)) !== expected) {
      throw new DocumentArchiveFormatError(`${path} was changed after the export.`);
    }
  }
  for (const path of Object.keys(files)) {
    if (path === "manifest.json" || path === "manifest.sig") continue;
    if (!(path in (manifest.files ?? {}))) {
      throw new DocumentArchiveFormatError(`${path} is not listed in the manifest.`);
    }
  }

  let exporterSignature: DocumentArchive["exporterSignature"] = "missing";
  const signatureBytes = files["manifest.sig"];
  if (signatureBytes) {
    try {
      const key = await importEd25519PublicKeyFromPem(manifest.exportedBy.signingPublicKey, subtle);
      exporterSignature = (await subtle.verify(
        { name: "Ed25519" },
        key,
        base64ToBytes(textDecoder.decode(signatureBytes).trim()) as BufferSource,
        files["manifest.json"] as BufferSource,
      ))
        ? "verified"
        : "invalid";
    } catch {
      exporterSignature = "invalid";
    }
  }

  const documents: DocumentArchiveDocument[] = [];
  for (const summary of manifest.documents) {
    const root = `documents/${pathSegment(summary.docId)}`;
    const history = parseJson<{
      entries: Array<{ id: string }>;
      chunks: Array<{ id: string; attachmentId?: string }>;
    }>(files, `${root}/history.json`);
    const entries = history.entries.map(({ id }) => {
      const record = parseJson<DocumentArchiveEntryRecord>(
        files,
        `${root}/entries/${pathSegment(id)}.json`,
      );
      const payload = files[`${root}/changes/${pathSegment(id)}.bin`];
      if (!payload || record.id !== id || record.docId !== summary.docId) {
        throw new DocumentArchiveFormatError(`Entry ${id} of ${summary.docId} is incomplete.`);
      }
      return { record, payload };
    });
    const chunks = history.chunks.map(({ id, attachmentId }) => {
      const folder = `${root}/attachments/${pathSegment(attachmentId ?? "unknown")}`;
      const record = parseJson<DocumentArchiveEntryRecord>(
        files,
        `${folder}/entries/${pathSegment(id)}.json`,
      );
      const payload = files[`${folder}/chunks/${pathSegment(id)}.bin`];
      if (!payload || record.id !== id || record.docId !== summary.docId) {
        throw new DocumentArchiveFormatError(`Attachment chunk ${id} of ${summary.docId} is incomplete.`);
      }
      return { record, payload };
    });
    documents.push({ summary, entries, chunks });
  }

  return {
    manifest,
    authors: files["authors.json"] ? parseJson<DocumentArchiveAuthor[]>(files, "authors.json") : [],
    documents,
    exporterSignature,
  };
}

/** Which of the archive's documents already exist in the target database. */
export async function checkDocumentArchiveImport(
  target: CopyEngineHost,
  archive: DocumentArchive,
): Promise<DocumentArchiveImportCheck> {
  const existingDocIds: string[] = [];
  const newDocIds: string[] = [];
  for (const { summary } of archive.documents) {
    const docId = summary.docId;
    const inStore = await target.store.findNewEntriesForDoc([], docId);
    const inAttachments =
      target.attachmentStore === target.store
        ? []
        : await target.attachmentStore.findNewEntriesForDoc([], docId);
    if (inStore.length > 0 || inAttachments.length > 0) {
      existingDocIds.push(docId);
    } else {
      newDocIds.push(docId);
    }
  }
  return { existingDocIds, newDocIds };
}

/**
 * Import an archive into a database that does not contain any of its
 * documents yet.
 *
 * Entry ids, dependencies and the Automerge bytes stay as they were, so the
 * document's revision graph is the same as in the source. Every entry is
 * encrypted with the target's key, signed by the importing user and gets a
 * provenance record naming the original author. Timestamps are rewritten to
 * import time (keeping their order), exactly like a replay copy.
 */
export async function importDocumentArchive(
  target: CopyEngineHost,
  archive: DocumentArchive,
  options: ImportDocumentArchiveOptions = {},
): Promise<ImportDocumentArchiveResult> {
  const wanted = options.docIds ? new Set(options.docIds) : null;
  const documents = archive.documents.filter(
    (document) => !wanted || wanted.has(document.summary.docId),
  );
  if (documents.length === 0) {
    return { importedDocIds: [], importedEntries: 0, importedChunks: 0 };
  }

  const check = await checkDocumentArchiveImport(target, { ...archive, documents });
  if (check.existingDocIds.length > 0) {
    throw new DocumentArchiveConflictError(check.existingDocIds);
  }

  const importer = await target.tenant.getCurrentUserId();
  const importerKey = importer.userSigningPublicKey;
  const sameTenant = archive.manifest.source.tenantId === target.tenant.getId();
  const keyIdFor = (record: DocumentArchiveEntryRecord) =>
    options.decryptionKeyId ??
    (sameTenant && !isSealedKeyId(record.decryptionKeyId) ? record.decryptionKeyId : "default");
  const subtle = target.tenant.getCryptoAdapter().getSubtle();

  if (!options.bypassAccessControlPrecheck) {
    for (const document of documents) {
      const metadata = document.entries.map(({ record }) => fromRecord(record));
      const preflight = await preflightCopyAdmission(
        target,
        metadata,
        () => importerKey,
        importerKey,
      );
      if (!preflight.admitted) {
        throw new Error(describeAdmissionFailure(preflight, target.store.getId()));
      }
    }
  }

  let importedEntries = 0;
  let importedChunks = 0;
  for (const document of documents) {
    throwIfAborted(options.signal);
    const total = document.chunks.length + document.entries.length;
    const timeAnchor = semanticNow() - (total - 1);
    let index = 0;

    const build = async (
      record: DocumentArchiveEntryRecord,
      payload: Uint8Array,
      kind: "chunk" | "entry",
    ): Promise<StoreEntry> => {
      const decryptionKeyId = keyIdFor(record);
      const encryptedData =
        kind === "chunk"
          ? await target.encryptAttachmentPayload(payload, decryptionKeyId)
          : await target.tenant.encryptPayload(payload, decryptionKeyId);
      const contentHash = await computeContentHash(encryptedData, subtle);
      const signature = await target.tenant.signPayload(encryptedData);
      const entry: StoreEntry = {
        entryType: record.entryType,
        id: record.id,
        contentHash,
        docId: record.docId,
        dependencyIds: record.dependencyIds,
        createdAt: timeAnchor + index++,
        createdByPublicKey: importerKey,
        decryptionKeyId,
        signature,
        originalSize: record.originalSize,
        encryptedSize: encryptedData.length,
        entryVersion: CURRENT_STORE_ENTRY_VERSION,
        encryptedData,
      };
      if (record.snapshotHeadHashes) entry.snapshotHeadHashes = record.snapshotHeadHashes;
      if (record.snapshotHeadEntryIds) entry.snapshotHeadEntryIds = record.snapshotHeadEntryIds;
      if (record.attachmentId) entry.attachmentId = record.attachmentId;
      if (record.attachmentIds) entry.attachmentIds = record.attachmentIds;
      if (record.attachmentRefs) entry.attachmentRefs = record.attachmentRefs;
      entry.provenance = buildProvenanceFromEntry(
        fromRecord(record),
        archive.manifest.source.tenantId,
        archive.manifest.source.dbId,
      );
      entry.metadataSignature = await target.computeEntryMetadataSignature(entry);
      return entry;
    };

    // Chunks first: a revision's signed attachmentRefs name chunks that must
    // already exist, just as in a copy.
    const chunks: StoreEntry[] = [];
    for (const { record, payload } of document.chunks) {
      chunks.push(await build(record, payload, "chunk"));
    }
    if (chunks.length > 0) {
      await target.attachmentStore.putEntries(chunks);
      importedChunks += chunks.length;
    }

    const entries: StoreEntry[] = [];
    for (const { record, payload } of document.entries) {
      entries.push(await build(record, payload, "entry"));
    }
    await target.store.putEntries(entries);
    importedEntries += entries.length;
  }

  await target.syncStoreChanges();
  return {
    importedDocIds: documents.map((document) => document.summary.docId),
    importedEntries,
    importedChunks,
  };
}
