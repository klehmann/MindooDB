/**
 * Attachment chunk copying.
 *
 * Chunk entry ids embed the document id (`<docId>_a_<fileUuid7>_<chunkUuid>`)
 * and a document's payload points at them by id through
 * `_attachments[].lastChunkId`. That forces two different strategies depending
 * on whether the copy crosses a store boundary:
 *
 * - **Different store** (the normal case, including every shard): keep the
 *   chunk ids exactly as they are and only re-home the `docId` metadata field.
 *   Nothing can collide, because the target store has never seen those ids, and
 *   leaving them alone is what lets the document's change bytes replay
 *   unmodified — the payload's `lastChunkId` values still resolve.
 *
 * - **Same store, new document id** (duplicating a document in place): the ids
 *   must be re-prefixed. Reusing them is not an option: the stores implement an
 *   id write as remove-then-insert, so a verbatim copy would overwrite the
 *   source's own chunk metadata and re-point it at the copy. The copied history
 *   keeps referring to the source's chunks (still present in the same store,
 *   holding identical bytes, so attachment time travel still works), and one
 *   trailing change re-points the copy's current revision at the chunks it owns.
 *
 * @module
 */

import { orderDagEntriesCausally } from "../DocumentDagAnalysis";
import { computeContentHash } from "../utils/idGeneration";
import { semanticNow } from "../utils/timeSource";
import { CURRENT_STORE_ENTRY_VERSION } from "../types";
import type { StoreEntry, StoreEntryMetadata } from "../types";
import type { CopyEngineHost } from "./host";
import type { CopyContext } from "./feasibility";
import { remapEntryId, stripWitnessReceipt } from "./entryRewrite";
import type { CopySigningKey, CopyProgressReporter } from "./copyDocument";
import type { CopyDocumentOptions, CopyFeasibility } from "./types";

/** Default entries written per `putEntries` call. */
const DEFAULT_BATCH_SIZE = 200;

/**
 * The result of copying a document's attachment chunks, plus the deferred step
 * that can only run once the document's own entries are in place.
 *
 * @internal
 */
export interface AttachmentCopyPlan {
  /** True when the abort signal fired before the chunks were fully copied. */
  cancelled: boolean;
  /**
   * Same-store copies only: append the one trailing change that re-points
   * `_attachments[].lastChunkId` at the re-prefixed chunks. A no-op otherwise.
   */
  finalize(signing?: CopySigningKey): Promise<void>;
}

/** A plan that does nothing, for documents without attachments. */
const NO_ATTACHMENTS: AttachmentCopyPlan = {
  cancelled: false,
  finalize: async () => {},
};

/**
 * Copy every attachment chunk belonging to a document.
 *
 * Runs before the document's own entries so that the signed `attachmentRefs`
 * snapshot each copied revision carries always describes chunks that already
 * exist in the target.
 */
export async function copyDocumentAttachments(
  source: CopyEngineHost,
  target: CopyEngineHost,
  context: CopyContext,
  feasibility: CopyFeasibility,
  options: CopyDocumentOptions,
  reporter: CopyProgressReporter,
  sourceDagEntries: StoreEntryMetadata[],
): Promise<AttachmentCopyPlan> {
  if (options.includeAttachments === false) {
    return NO_ATTACHMENTS;
  }

  const sourceChunks = (
    await source.attachmentStore.findNewEntriesForDoc([], context.sourceDocId)
  ).filter((entry) => entry.entryType === "attachment_chunk");
  if (sourceChunks.length === 0) {
    return NO_ATTACHMENTS;
  }

  // Only a same-store copy is forced to rename chunks; see the module comment.
  const reprefixChunkIds = context.sameStore;
  const chunkTargetDocId = context.targetDocId;
  const remapChunkId = (chunkId: string): string =>
    reprefixChunkIds
      ? remapEntryId(chunkId, context.sourceDocId, chunkTargetDocId)
      : chunkId;

  const ordered = orderDagEntriesCausally(sourceChunks);
  const targetIds = ordered.map((entry) => remapChunkId(entry.id));
  const alreadyPresent = new Set(
    await target.attachmentStore.hasEntries(targetIds),
  );

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const signing =
    options.signingKeyPair && options.signingKeyPassword
      ? {
          signingKeyPair: options.signingKeyPair,
          signingKeyPassword: options.signingKeyPassword,
        }
      : undefined;
  const copierPublicKey =
    signing?.signingKeyPair.publicKey ??
    (await target.tenant.getCurrentUserId()).userSigningPublicKey;
  const copyTime = semanticNow();
  const copiedAttachmentIds = new Set<string>();

  for (let offset = 0; offset < ordered.length; offset += batchSize) {
    if (options.signal?.aborted) {
      return { cancelled: true, finalize: async () => {} };
    }

    const slice = ordered.slice(offset, offset + batchSize);
    const needed = slice.filter(
      (_entry, index) => !alreadyPresent.has(targetIds[offset + index]),
    );
    if (needed.length === 0) continue;

    const fetched = await source.attachmentStore.getEntries(
      needed.map((entry) => entry.id),
    );
    const transformed: StoreEntry[] = [];
    for (const sourceEntry of fetched) {
      transformed.push(
        feasibility.strategy === "graft"
          ? stripWitnessReceipt({ ...sourceEntry })
          : await replayChunk(source, target, context, feasibility, sourceEntry, {
              id: remapChunkId(sourceEntry.id),
              dependencyIds: sourceEntry.dependencyIds.map(remapChunkId),
              createdAt: copyTime,
              createdByPublicKey: copierPublicKey,
              signing,
            }),
      );
      if (sourceEntry.attachmentId) {
        copiedAttachmentIds.add(sourceEntry.attachmentId);
      }
    }

    if (transformed.length > 0) {
      await target.attachmentStore.putEntries(transformed);
      reporter.copiedEntries += transformed.length;
      for (const entry of transformed) {
        reporter.copiedBytes += entry.encryptedSize;
      }
    }
    reporter.emit(
      "transferring",
      `Copied ${transformed.length} attachment chunks of ${context.sourceDocId}`,
    );
  }
  reporter.copiedAttachments += copiedAttachmentIds.size;

  if (!reprefixChunkIds) {
    return { cancelled: false, finalize: async () => {} };
  }

  // The re-prefixed chunks are in place but nothing points at them yet: the
  // copied revisions still carry the source's chunk ids in their payloads. Look
  // up the document's live attachment set from the newest signed refs snapshot
  // (no decryption needed) and hand the re-pointing to the target database.
  const liveRefs = latestAttachmentRefs(sourceDagEntries);
  return {
    cancelled: false,
    finalize: async (finalizeSigning) => {
      if (liveRefs.length === 0) return;
      const pointerRemap = new Map<string, string>();
      for (const ref of liveRefs) {
        pointerRemap.set(ref.attachmentId, remapChunkId(ref.lastChunkId));
      }
      await target.remapAttachmentPointers(
        chunkTargetDocId,
        pointerRemap,
        finalizeSigning ?? signing,
      );
    },
  };
}

/**
 * The document's current attachment set, read from the signed `attachmentRefs`
 * snapshot on its newest revision.
 *
 * Every document revision carries the complete set as of that revision, so the
 * newest one is authoritative — and reading it needs no decryption key.
 */
function latestAttachmentRefs(sourceDagEntries: StoreEntryMetadata[]) {
  let newest: StoreEntryMetadata | undefined;
  for (const entry of sourceDagEntries) {
    if (!entry.attachmentRefs || entry.attachmentRefs.length === 0) continue;
    if (!newest || entry.createdAt > newest.createdAt) {
      newest = entry;
    }
  }
  return newest?.attachmentRefs ?? [];
}

/**
 * Re-home and re-sign one attachment chunk.
 *
 * Attachment payloads use a deterministic IV, so re-encrypting the same chunk
 * under the same key reproduces the same ciphertext and `contentHash` — which
 * is why a same-tenant copy into the same store deduplicates the bytes instead
 * of storing them twice.
 */
async function replayChunk(
  source: CopyEngineHost,
  target: CopyEngineHost,
  context: CopyContext,
  feasibility: CopyFeasibility,
  sourceEntry: StoreEntry,
  rewrite: {
    id: string;
    dependencyIds: string[];
    createdAt: number;
    createdByPublicKey: string;
    signing?: CopySigningKey;
  },
): Promise<StoreEntry> {
  let encryptedData = sourceEntry.encryptedData;
  let contentHash = sourceEntry.contentHash;
  if (feasibility.requiresReEncryption) {
    const plaintext = await source.decryptAttachmentPayload(
      sourceEntry.encryptedData,
      sourceEntry.decryptionKeyId,
    );
    encryptedData = await target.encryptAttachmentPayload(
      plaintext,
      context.targetDecryptionKeyId,
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
    entryType: "attachment_chunk",
    id: rewrite.id,
    contentHash,
    docId: context.targetDocId,
    dependencyIds: rewrite.dependencyIds,
    createdAt: rewrite.createdAt,
    attachmentId: sourceEntry.attachmentId,
    createdByPublicKey: rewrite.createdByPublicKey,
    decryptionKeyId: context.targetDecryptionKeyId,
    signature,
    originalSize: sourceEntry.originalSize,
    encryptedSize: encryptedData.length,
    entryVersion: CURRENT_STORE_ENTRY_VERSION,
    encryptedData,
  };
  entry.metadataSignature = await target.computeEntryMetadataSignature(
    entry,
    rewrite.signing,
  );
  return entry;
}
