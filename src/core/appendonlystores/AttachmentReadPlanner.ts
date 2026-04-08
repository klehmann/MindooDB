import type { StoreEntryMetadata } from "../types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanChunk,
  AttachmentReadPlanOptions,
  ContentAddressedStore,
} from "./types";

/**
 * Internal normalized byte window for attachment reads.
 *
 * All ranges in this file use the `[start, end)` convention:
 * - `startByte` is inclusive
 * - `endByteExclusive` is exclusive
 */
interface NormalizedAttachmentReadRange {
  startByte: number;
  endByteExclusive: number;
}

/**
 * Validates and normalizes a requested attachment byte range.
 *
 * The planner operates on the declared attachment size from the attachment
 * reference, not on the database's current runtime `chunkSizeBytes`. This is
 * what makes the resulting read plan stable even when attachments were written
 * with a different chunk size than the one used by the current runtime.
 */
function normalizeAttachmentReadRange(
  attachmentSize: number,
  options: AttachmentReadPlanOptions,
): NormalizedAttachmentReadRange {
  const endByteExclusive = options.endByteExclusive ?? attachmentSize;
  if (options.startByte < 0 || endByteExclusive < options.startByte) {
    throw new Error(`Invalid byte range: [${options.startByte}, ${endByteExclusive})`);
  }
  if (endByteExclusive > attachmentSize) {
    throw new Error(`End byte ${endByteExclusive} exceeds attachment size ${attachmentSize}`);
  }
  return {
    startByte: options.startByte,
    endByteExclusive,
  };
}

/**
 * Verifies that the fetched metadata belongs to a valid attachment chunk.
 *
 * The planner depends only on metadata, so it must fail early if the chain is
 * malformed. In particular, attachment chunks are expected to form a simple
 * singly-linked list through `dependencyIds[0]`.
 */
function validateAttachmentChunkMetadata(
  metadata: StoreEntryMetadata | null,
  id: string,
): StoreEntryMetadata {
  if (!metadata) {
    throw new Error(`Attachment chunk ${id} not found in store`);
  }
  if (metadata.entryType !== "attachment_chunk") {
    throw new Error(`Entry ${id} is not an attachment chunk`);
  }
  if (metadata.dependencyIds.length > 1) {
    throw new Error(`Attachment chunk ${id} has unexpected dependency fanout`);
  }
  if (metadata.originalSize <= 0) {
    throw new Error(`Attachment chunk ${id} has invalid originalSize ${metadata.originalSize}`);
  }
  return metadata;
}

/**
 * Builds the final read plan object once the relevant chunks are known.
 *
 * `offsetInFirstChunk` tells callers how many plaintext bytes to skip from the
 * first fetched chunk before yielding or copying data to the final consumer.
 */
function finalizeAttachmentReadPlan(
  attachmentSize: number,
  range: NormalizedAttachmentReadRange,
  chunkPlans: AttachmentReadPlanChunk[],
): AttachmentReadPlan {
  if (range.startByte === range.endByteExclusive) {
    return {
      attachmentSize,
      startByte: range.startByte,
      endByteExclusive: range.endByteExclusive,
      chunkPlans: [],
      offsetInFirstChunk: 0,
    };
  }
  if (chunkPlans.length === 0) {
    throw new Error(
      `Attachment chunk plan for range [${range.startByte}, ${range.endByteExclusive}) produced no chunks`,
    );
  }
  return {
    attachmentSize,
    startByte: range.startByte,
    endByteExclusive: range.endByteExclusive,
    chunkPlans,
    offsetInFirstChunk: range.startByte - chunkPlans[0].startByte,
  };
}

/**
 * Plans a plaintext attachment read by walking chunk metadata backward from the
 * newest chunk (`lastChunkId`) toward the oldest chunk.
 *
 * Why the backward walk works:
 * - attachment chunks form a reverse-linked list via `dependencyIds`
 * - the attachment reference stores the total plaintext attachment size
 * - each chunk metadata record stores its own plaintext size in `originalSize`
 *
 * With those three facts, the planner can reconstruct chunk byte boundaries
 * from the tail of the file without relying on the current runtime
 * `chunkSizeBytes`. This keeps range planning correct even if the attachment was
 * written with a different chunk size than the reader currently uses.
 *
 * The returned plan is backend-agnostic. Store implementations can expose this
 * helper through `planAttachmentReadByWalkingMetadata()` on the store interface,
 * and `BaseMindooDB` can also call this helper directly as a fallback because it
 * only depends on standard store methods like `getEntryMetadata()`.
 */
export async function planAttachmentReadByWalkingMetadata(
  store: ContentAddressedStore,
  lastChunkId: string,
  attachmentSize: number,
  options: AttachmentReadPlanOptions,
): Promise<AttachmentReadPlan> {
  const range = normalizeAttachmentReadRange(attachmentSize, options);
  if (range.startByte === range.endByteExclusive || attachmentSize === 0) {
    return finalizeAttachmentReadPlan(attachmentSize, range, []);
  }

  const reverseChunkPlans: AttachmentReadPlanChunk[] = [];
  let currentId: string | null = lastChunkId;
  let currentChunkEnd = attachmentSize;

  while (currentId && currentChunkEnd > range.startByte) {
    const metadata = validateAttachmentChunkMetadata(await store.getEntryMetadata(currentId), currentId);
    const currentChunkStart = currentChunkEnd - metadata.originalSize;
    if (currentChunkStart < 0) {
      throw new Error(
        `Attachment chunk ${currentId} exceeds declared attachment size ${attachmentSize}`,
      );
    }
    if (currentChunkEnd > range.startByte && currentChunkStart < range.endByteExclusive) {
      reverseChunkPlans.push({
        id: currentId,
        startByte: currentChunkStart,
        endByteExclusive: currentChunkEnd,
        originalSize: metadata.originalSize,
      });
    }
    currentId = metadata.dependencyIds[0] ?? null;
    currentChunkEnd = currentChunkStart;
  }

  if (!currentId && currentChunkEnd > range.startByte) {
    throw new Error(
      `Attachment chunk chain ended before covering declared attachment size ${attachmentSize}`,
    );
  }

  reverseChunkPlans.reverse();
  return finalizeAttachmentReadPlan(attachmentSize, range, reverseChunkPlans);
}
