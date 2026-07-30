/**
 * The document copy engine.
 *
 * Orchestrates the three strategies described in `docs/document-copy.md`:
 * `flatten` (delegated to `flatten.ts`, which goes through the public document
 * API), and the two history-preserving strategies implemented here.
 *
 * `graft` and `replay` share one pipeline — order the source revision graph
 * causally, skip what the target already has, transform in batches, write — and
 * differ only in the per-entry transform:
 *
 * - **graft** strips the witness receipt and changes nothing else, so the
 *   original authors' signatures remain valid.
 * - **replay** re-homes each entry under the target document id and re-signs it
 *   as the copying user, recording the original author in a verifiable
 *   provenance record.
 *
 * @module
 */

import { orderDagEntriesCausally } from "../DocumentDagAnalysis";
import { computeContentHash, generateDocId } from "../utils/idGeneration";
import { semanticNow } from "../utils/timeSource";
import { CURRENT_STORE_ENTRY_VERSION } from "../types";
import type { SigningKeyPair, StoreEntry, StoreEntryMetadata } from "../types";
import type { CopyEngineHost } from "./host";
import {
  copyFeasibilityError,
  resolveCopyFeasibility,
  resolveTargetDecryptionKeyId,
  type CopyContext,
} from "./feasibility";
import {
  isDocumentDagEntry,
  remapEntryId,
  stripWitnessReceipt,
} from "./entryRewrite";
import { buildProvenanceFromEntry } from "./provenance";
import { describeAdmissionFailure, preflightCopyAdmission } from "./preflight";
import { copyDocumentAttachments } from "./attachments";
import { flattenDocument } from "./flatten";
import type {
  CopyDocumentOptions,
  CopyDocumentResult,
  CopyFeasibility,
  CopyProgress,
  CopyProgressPhase,
} from "./types";

/** Default entries written per `putEntries` call. */
const DEFAULT_BATCH_SIZE = 200;

/**
 * A resolved custom signing identity for a copy, or `undefined` to sign as the
 * current user. Both fields are always present together.
 *
 * @internal
 */
export interface CopySigningKey {
  signingKeyPair: SigningKeyPair;
  signingKeyPassword: string;
}

/**
 * Normalize the caller's signing options: a key pair is only usable together
 * with its password, so a half-supplied pair is treated as absent.
 *
 * @internal
 */
export function resolveCopySigningKey(
  options: CopyDocumentOptions,
): CopySigningKey | undefined {
  if (!options.signingKeyPair || !options.signingKeyPassword) return undefined;
  return {
    signingKeyPair: options.signingKeyPair,
    signingKeyPassword: options.signingKeyPassword,
  };
}

/**
 * The key the copy's entries will be signed with: the caller's service identity
 * when supplied, the current user's otherwise.
 *
 * @internal
 */
export async function resolveCopierPublicKey(
  target: CopyEngineHost,
  options: CopyDocumentOptions,
): Promise<string> {
  return (
    resolveCopySigningKey(options)?.signingKeyPair.publicKey ??
    (await target.tenant.getCurrentUserId()).userSigningPublicKey
  );
}

/**
 * Accumulates copy totals and emits {@link CopyProgress} events.
 *
 * Shared by the single-document and bulk paths so a bulk run reports one
 * continuously rising total rather than restarting the counters per document.
 */
export class CopyProgressReporter {
  copiedEntries = 0;
  copiedBytes = 0;
  scannedEntries = 0;
  copiedAttachments = 0;
  totalSourceEntries?: number;
  currentDocId?: string;
  documentsCompleted?: number;
  totalDocuments?: number;

  constructor(private readonly onProgress?: (progress: CopyProgress) => void) {}

  emit(phase: CopyProgressPhase, message: string): void {
    if (!this.onProgress) return;
    this.onProgress({
      phase,
      message,
      copiedEntries: this.copiedEntries,
      copiedBytes: this.copiedBytes,
      scannedEntries: this.scannedEntries,
      totalSourceEntries: this.totalSourceEntries,
      currentDocId: this.currentDocId,
      documentsCompleted: this.documentsCompleted,
      totalDocuments: this.totalDocuments,
    });
  }
}

/**
 * Read the source document's revision-graph metadata and derive the key it is
 * encrypted under.
 *
 * Uses the raw store rather than the database's filtered scan so a copy sees
 * the document exactly as stored, independent of any time-travel view the
 * source database happens to be opened at.
 */
async function readSourceDagEntries(
  source: CopyEngineHost,
  docId: string,
): Promise<StoreEntryMetadata[]> {
  const all = await source.store.findNewEntriesForDoc([], docId);
  return all.filter(isDocumentDagEntry);
}

/**
 * Resolve the document id the copy will be written under.
 *
 * An explicit string is taken as-is; `"same"` keeps the source id (the sharding
 * case); `"new"` mints a fresh one.
 */
function resolveTargetDocId(
  sourceDocId: string,
  options: CopyDocumentOptions,
): string {
  const requested = options.targetDocId ?? "new";
  if (requested === "same") return sourceDocId;
  if (requested === "new") return generateDocId(options.idPrefix);
  return requested;
}

/**
 * Gather the source/target facts the strategy resolver needs, then resolve it.
 *
 * Shared by `copyDocument` and `canCopyDocument` so the answer a caller gets
 * from the dry run is the one the real run will act on.
 */
export async function prepareCopy(
  source: CopyEngineHost,
  target: CopyEngineHost,
  sourceDocId: string,
  options: CopyDocumentOptions,
  precomputedTargetDocId?: string,
): Promise<{
  context: CopyContext;
  feasibility: CopyFeasibility;
  sourceEntries: StoreEntryMetadata[];
}> {
  const sourceEntries = await readSourceDagEntries(source, sourceDocId);
  if (sourceEntries.length === 0) {
    throw new Error(
      `Document ${sourceDocId} was not found in database ${source.store.getId()}.`,
    );
  }

  const targetDocId = precomputedTargetDocId ?? resolveTargetDocId(sourceDocId, options);
  const sourceTenantId = source.tenant.getId();
  const targetTenantId = target.tenant.getId();
  const sameTenant = sourceTenantId === targetTenantId;

  // Every lifecycle entry of a document shares one decryptionKeyId, so the
  // oldest one speaks for the document.
  const sourceDecryptionKeyId = sourceEntries
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt)[0].decryptionKeyId;

  const context: CopyContext = {
    sourceTenantId,
    targetTenantId,
    sourceDbId: source.store.getId(),
    targetDbId: target.store.getId(),
    sourceDocId,
    targetDocId,
    sourceDecryptionKeyId,
    targetDecryptionKeyId: resolveTargetDecryptionKeyId(
      options.decryptionKeyId,
      sourceDecryptionKeyId,
      sameTenant,
    ),
    // Store ids are only unique within a tenant: each tenant has its own store
    // factory, so the same db id in two tenants is two different stores.
    sameStore:
      source.store === target.store ||
      (sameTenant && source.store.getId() === target.store.getId()),
    targetHasDocId:
      (await target.store.findNewEntriesForDoc([], targetDocId)).length > 0,
  };

  return {
    context,
    feasibility: resolveCopyFeasibility(context, options),
    sourceEntries,
  };
}

/** Dry run: report what a copy would do without writing anything. */
export async function canCopyDocument(
  source: CopyEngineHost,
  target: CopyEngineHost,
  docId: string,
  options: CopyDocumentOptions = {},
): Promise<CopyFeasibility> {
  const { feasibility } = await prepareCopy(source, target, docId, options);
  return feasibility;
}

/**
 * Copy one document into another database.
 *
 * @see `docs/document-copy.md` for the strategy matrix and caveats.
 */
export async function copyDocument(
  source: CopyEngineHost,
  target: CopyEngineHost,
  docId: string,
  options: CopyDocumentOptions = {},
  sharedReporter?: CopyProgressReporter,
): Promise<CopyDocumentResult> {
  const reporter = sharedReporter ?? new CopyProgressReporter(options.onProgress);
  reporter.currentDocId = docId;
  reporter.emit("preparing", `Preparing to copy document ${docId}`);

  const { context, feasibility, sourceEntries } = await prepareCopy(
    source,
    target,
    docId,
    options,
  );
  if (!feasibility.allowed) {
    throw copyFeasibilityError(feasibility);
  }

  if (feasibility.strategy === "flatten") {
    return flattenDocument(source, target, context, options, reporter);
  }
  return copyDocumentHistory(
    source,
    target,
    context,
    feasibility,
    options,
    sourceEntries,
    reporter,
  );
}

/**
 * The shared graft/replay pipeline.
 *
 * Entries are ordered causally so a dependency is always written before the
 * entry that needs it, pre-screened against the target so a re-run after a
 * cancellation transfers only the remainder, and written in batches with an
 * abort check between each.
 */
async function copyDocumentHistory(
  source: CopyEngineHost,
  target: CopyEngineHost,
  context: CopyContext,
  feasibility: CopyFeasibility,
  options: CopyDocumentOptions,
  sourceEntries: StoreEntryMetadata[],
  reporter: CopyProgressReporter,
): Promise<CopyDocumentResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const ordered = orderDagEntriesCausally(sourceEntries);
  const startedAtCopiedEntries = reporter.copiedEntries;
  const startedAtCopiedBytes = reporter.copiedBytes;
  const startedAtAttachments = reporter.copiedAttachments;

  reporter.emit(
    "planning",
    `Planning copy of ${ordered.length} revisions of ${context.sourceDocId}`,
  );

  // Ask the target's write policy before doing any work. The copy writes store
  // entries directly, so it does not inherit the precheck that changeDoc runs,
  // and a graft carries signers the target may never have granted anything to.
  if (!options.bypassAccessControlPrecheck) {
    const copierKey = await resolveCopierPublicKey(target, options);
    const preflight = await preflightCopyAdmission(
      target,
      ordered,
      feasibility.strategy === "graft"
        ? (entry) => entry.createdByPublicKey
        : () => copierKey,
      ordered.find((entry) => entry.entryType === "doc_create")?.createdByPublicKey ??
        null,
    );
    if (!preflight.admitted) {
      throw new Error(
        describeAdmissionFailure(preflight, target.store.getId()),
      );
    }
  }

  // Attachments first: a document entry's signed attachmentRefs snapshot has to
  // describe chunks that already exist in the target, and the same-store
  // strategy needs the chunk id remapping before document entries are rewritten.
  const attachmentPlan = await copyDocumentAttachments(
    source,
    target,
    context,
    feasibility,
    options,
    reporter,
    sourceEntries,
  );
  if (attachmentPlan.cancelled) {
    return buildResult(context, feasibility, reporter, {
      startedAtCopiedEntries,
      startedAtCopiedBytes,
      startedAtAttachments,
      cancelled: true,
    });
  }

  const targetIds = ordered.map((entry) =>
    remapEntryId(entry.id, context.sourceDocId, context.targetDocId),
  );
  const alreadyPresent = new Set(await target.store.hasEntries(targetIds));
  const causalIndexById = new Map(ordered.map((entry, index) => [entry.id, index]));

  // Anchor the rewritten timestamps so the last entry lands at copy time and
  // earlier ones stay strictly before it. Copies are never backdated to the
  // original write time — that would collide with provisional-entry handling
  // and access-control time travel — but relative order still has to survive,
  // because delete/undelete resolution compares createdAt.
  const copyTime = semanticNow();
  const timeAnchor = copyTime - (ordered.length - 1);

  const signing = resolveCopySigningKey(options);
  const copierPublicKey =
    signing?.signingKeyPair.publicKey ??
    (await target.tenant.getCurrentUserId()).userSigningPublicKey;

  for (let offset = 0; offset < ordered.length; offset += batchSize) {
    if (options.signal?.aborted) {
      return buildResult(context, feasibility, reporter, {
        startedAtCopiedEntries,
        startedAtCopiedBytes,
        startedAtAttachments,
        cancelled: true,
      });
    }

    const slice = ordered.slice(offset, offset + batchSize);
    reporter.scannedEntries += slice.length;

    const needed = slice.filter(
      (_entry, index) => !alreadyPresent.has(targetIds[offset + index]),
    );
    if (needed.length === 0) {
      reporter.emit(
        "transferring",
        `Skipped ${slice.length} revisions already present in the target`,
      );
      continue;
    }

    const fetched = await source.store.getEntries(needed.map((entry) => entry.id));
    const byId = new Map(fetched.map((entry) => [entry.id, entry]));

    const transformed: StoreEntry[] = [];
    for (const metadata of needed) {
      const sourceEntry = byId.get(metadata.id);
      if (!sourceEntry) {
        // The entry vanished between the metadata scan and the read (a
        // concurrent purge). Skip it: the copy stays consistent because the
        // document's remaining revisions still form a valid graph.
        continue;
      }
      const index = causalIndexById.get(metadata.id) ?? 0;
      transformed.push(
        feasibility.strategy === "graft"
          ? graftEntry(sourceEntry)
          : await replayEntry(
              source,
              target,
              context,
              feasibility,
              options,
              sourceEntry,
              {
                createdAt: timeAnchor + index,
                createdByPublicKey: copierPublicKey,
                signing,
              },
            ),
      );
    }

    if (transformed.length > 0) {
      await target.store.putEntries(transformed);
      reporter.copiedEntries += transformed.length;
      for (const entry of transformed) {
        reporter.copiedBytes += entry.encryptedSize;
      }
    }
    reporter.emit(
      "transferring",
      `Copied ${reporter.copiedEntries} revisions of ${context.sourceDocId}`,
    );
  }

  // The same-store variant re-homes attachment chunks under the new document
  // id, which the copied history still points at by their old ids. One trailing
  // change repoints the current revision at the chunks the copy owns.
  await target.syncStoreChanges();
  await attachmentPlan.finalize(signing);

  reporter.emit("processing", `Materializing ${context.targetDocId}`);
  await target.syncStoreChanges();
  reporter.emit("complete", `Copied document ${context.sourceDocId}`);

  return buildResult(context, feasibility, reporter, {
    startedAtCopiedEntries,
    startedAtCopiedBytes,
    startedAtAttachments,
    cancelled: false,
  });
}

/**
 * Graft transform: keep every byte, drop only the witness receipt.
 *
 * There is deliberately nothing else here. Not re-deriving the id, not
 * re-encrypting and not re-signing is precisely what leaves the original
 * author's `metadataSignature` valid — and it is why sharding never needs a
 * decryption key.
 */
function graftEntry(sourceEntry: StoreEntry): StoreEntry {
  return stripWitnessReceipt({ ...sourceEntry });
}

/** Replay transform: re-home the entry and re-sign it as the copying user. */
async function replayEntry(
  source: CopyEngineHost,
  target: CopyEngineHost,
  context: CopyContext,
  feasibility: CopyFeasibility,
  options: CopyDocumentOptions,
  sourceEntry: StoreEntry,
  rewrite: {
    createdAt: number;
    createdByPublicKey: string;
    signing?: CopySigningKey;
  },
): Promise<StoreEntry> {
  const { sourceDocId, targetDocId, targetDecryptionKeyId } = context;

  // The Automerge change bytes are reused verbatim, so the whole CRDT history —
  // actor ids, per-change timestamps, text structure — survives intact. Only
  // the encryption envelope is redone, and only when it has to be.
  let encryptedData = sourceEntry.encryptedData;
  let contentHash = sourceEntry.contentHash;
  if (feasibility.requiresReEncryption) {
    const plaintext = await source.tenant.decryptPayload(
      sourceEntry.encryptedData,
      sourceEntry.decryptionKeyId,
    );
    encryptedData = await target.tenant.encryptPayload(
      plaintext,
      targetDecryptionKeyId,
    );
    contentHash = await computeContentHash(
      encryptedData,
      target.tenant.getCryptoAdapter().getSubtle(),
    );
  }

  const signature = rewrite.signing
    ? await target.tenant.signPayloadWithKey(
        encryptedData,
        rewrite.signing.signingKeyPair,
        rewrite.signing.signingKeyPassword,
      )
    : await target.tenant.signPayload(encryptedData);

  const entry: StoreEntry = {
    entryType: sourceEntry.entryType,
    id: remapEntryId(sourceEntry.id, sourceDocId, targetDocId),
    contentHash,
    docId: targetDocId,
    dependencyIds: sourceEntry.dependencyIds.map((dependencyId) =>
      remapEntryId(dependencyId, sourceDocId, targetDocId),
    ),
    createdAt: rewrite.createdAt,
    createdByPublicKey: rewrite.createdByPublicKey,
    decryptionKeyId: targetDecryptionKeyId,
    snapshotHeadHashes: sourceEntry.snapshotHeadHashes,
    snapshotHeadEntryIds: sourceEntry.snapshotHeadEntryIds?.map((entryId) =>
      remapEntryId(entryId, sourceDocId, targetDocId),
    ),
    attachmentId: sourceEntry.attachmentId,
    attachmentIds: sourceEntry.attachmentIds,
    // Carried verbatim. The refs name chunk ids, and a chunk id is only renamed
    // for a same-store copy — where the copied history deliberately keeps
    // pointing at the source's chunks, matching its own unmodified payload,
    // until the trailing remap change repoints the current revision.
    attachmentRefs: sourceEntry.attachmentRefs,
    signature,
    originalSize: sourceEntry.originalSize,
    encryptedSize: encryptedData.length,
    entryVersion: CURRENT_STORE_ENTRY_VERSION,
    encryptedData,
  };

  if (options.provenance !== false) {
    entry.provenance = buildProvenanceFromEntry(
      sourceEntry,
      context.sourceTenantId,
      context.sourceDbId,
    );
  }

  entry.metadataSignature = await target.computeEntryMetadataSignature(
    entry,
    rewrite.signing,
  );
  return entry;
}

/** Assemble the per-document result from the reporter's running totals. */
function buildResult(
  context: CopyContext,
  feasibility: CopyFeasibility,
  reporter: CopyProgressReporter,
  baseline: {
    startedAtCopiedEntries: number;
    startedAtCopiedBytes: number;
    startedAtAttachments: number;
    cancelled: boolean;
  },
): CopyDocumentResult {
  return {
    sourceDocId: context.sourceDocId,
    targetDocId: context.targetDocId,
    strategy: feasibility.strategy,
    authorshipPreserved: feasibility.authorshipPreserved,
    mergedIntoExisting: feasibility.willMergeIntoExisting,
    copiedEntries: reporter.copiedEntries - baseline.startedAtCopiedEntries,
    copiedBytes: reporter.copiedBytes - baseline.startedAtCopiedBytes,
    copiedAttachments: reporter.copiedAttachments - baseline.startedAtAttachments,
    cancelled: baseline.cancelled,
  };
}
