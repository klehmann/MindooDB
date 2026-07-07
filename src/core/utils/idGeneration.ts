/**
 * ID Generation Utilities for ContentAddressedStore entries.
 * 
 * Provides structured ID formats that enable:
 * - Guaranteed uniqueness across documents
 * - Efficient prefix-based queries
 * - Debugging visibility into entry relationships
 * - Blockchain-like integrity for document entries
 */

import { v7 as uuidv7 } from 'uuid';

/**
 * Base62 alphabet in ASCII order (digits < uppercase < lowercase). The order
 * matters: fixed-length, left-zero-padded encodings of numerically increasing
 * values (e.g. UUID7 timestamps) then sort chronologically under plain
 * lexicographic string comparison. Do NOT reorder.
 */
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const UUID_NO_DASH_LENGTH = 32;
const BASE62_UUID_LENGTH = 22;

function trimLeft(target: string, length: number): string {
  let trim = 0;
  while (target[trim] === "0" && target.length - trim > length) {
    trim++;
  }
  return target.slice(trim);
}

function ensureLength(target: string, length: number): string {
  if (target.length < length) {
    return target.padStart(length, "0");
  }
  if (target.length > length) {
    return trimLeft(target, length);
  }
  return target;
}

function hexToBase62(uuid: string): string {
  const normalized = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new TypeError(`Invalid UUID for base62 encoding: ${uuid}`);
  }

  let value = BigInt(`0x${normalized}`);
  if (value === 0n) {
    return "0".repeat(BASE62_UUID_LENGTH);
  }

  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 62n);
    encoded = BASE62_ALPHABET[digit] + encoded;
    value /= 62n;
  }

  return ensureLength(encoded, BASE62_UUID_LENGTH);
}

/**
 * Generate a fresh, globally unique document id: a UUID7 encoded as a
 * fixed-length (22 char), left-zero-padded base62 string, optionally prefixed
 * with `<prefix>_`.
 *
 * Because the UUID7 timestamp occupies the most significant bits and the
 * base62 alphabet is in ASCII order, ids generated later sort lexicographically
 * after ids generated earlier (within the same prefix) — same property as raw
 * UUID7 strings, but 14 characters shorter.
 *
 * The prefix (if any) is NOT validated here; callers validate it against
 * `DOC_ID_PREFIX_REGEX` before invoking this.
 *
 * @param prefix Optional short application prefix (e.g. "cls"); joined with "_".
 * @returns e.g. "0BqXa9yTFn2M4kVzR1sWpq" or "cls_0BqXa9yTFn2M4kVzR1sWpq"
 */
export function generateDocId(prefix?: string): string {
  const encoded = hexToBase62(uuidv7());
  return prefix ? `${prefix}_${encoded}` : encoded;
}

/**
 * Boundary-aware document-id prefix match used by prefix-filtered listing and
 * changefeed iteration.
 *
 * A `docId` matches `idPrefix` when it either equals the prefix exactly or
 * begins with `<idPrefix>_`. Matching on the `_` boundary (rather than a raw
 * `startsWith`) mirrors the `<prefix>_<base62>` id scheme, so filtering by
 * `"cls"` returns `cls_…` documents without also catching an unrelated prefix
 * like `classroom_…`.
 *
 * An empty `idPrefix` matches every id (i.e. "no filter").
 *
 * @param docId The document id to test.
 * @param idPrefix The prefix to match (without the trailing `_`).
 */
export function matchesDocIdPrefix(docId: string, idPrefix: string): boolean {
  if (idPrefix.length === 0) return true;
  return docId === idPrefix || docId.startsWith(`${idPrefix}_`);
}

/**
 * Generate a document entry ID with blockchain-like chaining.
 * Format: <docId>_d_<depsFingerprint>_<automergeHash>
 * 
 * The depsFingerprint is the first 8 hex characters of SHA256(sorted deps),
 * or "0" if there are no dependencies.
 * 
 * @param docId The document ID (UUID7 format)
 * @param automergeHash The Automerge change hash
 * @param dependencyAutomergeHashes The Automerge hashes of dependencies
 * @param subtle The SubtleCrypto instance for hashing
 * @returns The generated entry ID
 */
export async function generateDocEntryId(
  docId: string,
  automergeHash: string,
  dependencyAutomergeHashes: string[],
  subtle: SubtleCrypto
): Promise<string> {
  const depsFingerprint = await generateDepsFingerprint(dependencyAutomergeHashes, subtle);
  return `${docId}_d_${depsFingerprint}_${automergeHash}`;
}

/**
 * Generate a dependency fingerprint from a list of Automerge hashes.
 * This is the first 8 hex characters of SHA256(sorted deps), or "0" if empty.
 * 
 * @param dependencyAutomergeHashes The Automerge hashes of dependencies
 * @param subtle The SubtleCrypto instance for hashing
 * @returns The 8-character fingerprint
 */
export async function generateDepsFingerprint(
  dependencyAutomergeHashes: string[],
  subtle: SubtleCrypto
): Promise<string> {
  if (dependencyAutomergeHashes.length === 0) {
    return "0";
  }
  
  // Sort deps for deterministic fingerprint
  const sortedDeps = [...dependencyAutomergeHashes].sort();
  const depsString = sortedDeps.join(",");
  const hashBuffer = await subtle.digest("SHA-256", new TextEncoder().encode(depsString));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 4)  // First 4 bytes = 8 hex chars
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate an attachment chunk ID.
 * Format: <docId>_a_<fileUuid7>_<base62ChunkUuid7>
 * 
 * @param docId The document ID this attachment belongs to
 * @param fileUuid7 The UUID7 for the whole file (same for all chunks)
 * @param chunkUuid7 Optional UUID7 for this chunk. If not provided, generates new one.
 * @returns The generated chunk ID
 */
export function generateAttachmentChunkId(
  docId: string,
  fileUuid7: string,
  chunkUuid7?: string
): string {
  const chunkId = chunkUuid7 || uuidv7();
  const base62Chunk = hexToBase62(chunkId);
  return `${docId}_a_${fileUuid7}_${base62Chunk}`;
}

/**
 * Generate an attachment chunk id that is unique within one write operation
 * even under case-insensitive comparison.
 *
 * Chunk entry ids become on-disk filenames (`entries/<id>.json`) and — unlike
 * document entry ids — contain no lowercase-hex hash component, so two chunk
 * ids differing only in the case of their base62 part would collide on
 * case-insensitive filesystems (APFS/NTFS). The caller passes a set of
 * case-folded ids already used in the current write; on the (astronomically
 * unlikely) fold-collision the id is simply regenerated. The set is expected
 * to be scoped to a single attachment write, so there is no persistent cost.
 *
 * @param docId The document ID this attachment belongs to
 * @param fileUuid7 The UUID7 for the whole file (same for all chunks)
 * @param usedCaseFoldedIds Case-folded ids already used in this write; the
 *   returned id's folded form is added to the set.
 * @returns The generated chunk ID
 */
export function generateUniqueAttachmentChunkId(
  docId: string,
  fileUuid7: string,
  usedCaseFoldedIds: Set<string>,
): string {
  for (;;) {
    const id = generateAttachmentChunkId(docId, fileUuid7);
    const folded = id.toLowerCase();
    if (!usedCaseFoldedIds.has(folded)) {
      usedCaseFoldedIds.add(folded);
      return id;
    }
  }
}

/**
 * Generate a new file UUID7.
 * This should be called once per file and reused for all chunks of that file.
 * 
 * @returns A new UUID7 string
 */
export function generateFileUuid7(): string {
  return uuidv7();
}

/**
 * Generate a new chunk UUID7.
 * This should be called for each chunk within a file.
 * 
 * @returns A new UUID7 string
 */
export function generateChunkUuid7(): string {
  return uuidv7();
}

/**
 * Parse a document entry ID to extract its components.
 * 
 * @param id The entry ID to parse
 * @returns The parsed components, or null if the ID doesn't match the expected format
 */
export function parseDocEntryId(id: string): {
  docId: string;
  depsFingerprint: string;
  automergeHash: string;
} | null {
  // Match: <docId>_d_<depsFingerprint>_<automergeHash>
  // Note: docId itself may contain underscores (UUID7 doesn't, but be safe)
  const match = id.match(/^(.+)_d_([0-9a-f]+|0)_(.+)$/);
  if (!match) return null;
  return {
    docId: match[1],
    depsFingerprint: match[2],
    automergeHash: match[3],
  };
}

/**
 * Parse an attachment chunk ID to extract its components.
 * 
 * @param id The chunk ID to parse
 * @returns The parsed components, or null if the ID doesn't match the expected format
 */
export function parseAttachmentChunkId(id: string): {
  docId: string;
  fileUuid7: string;
  base62ChunkId: string;
} | null {
  // Match: <docId>_a_<fileUuid7>_<base62ChunkId>
  const match = id.match(/^(.+)_a_([^_]+)_(.+)$/);
  if (!match) return null;
  return {
    docId: match[1],
    fileUuid7: match[2],
    base62ChunkId: match[3],
  };
}

/**
 * Check if an ID is a document entry ID (contains "_d_").
 * 
 * @param id The ID to check
 * @returns True if this is a document entry ID
 */
export function isDocEntryId(id: string): boolean {
  return id.includes('_d_');
}

/**
 * Check if an ID is an attachment chunk ID (contains "_a_").
 * 
 * @param id The ID to check
 * @returns True if this is an attachment chunk ID
 */
export function isAttachmentChunkId(id: string): boolean {
  return id.includes('_a_');
}

/**
 * Extract the docId from any entry ID (document or attachment).
 * 
 * @param id The entry ID
 * @returns The docId portion, or null if the ID format is unrecognized
 */
export function extractDocIdFromEntryId(id: string): string | null {
  if (isDocEntryId(id)) {
    const parsed = parseDocEntryId(id);
    return parsed?.docId || null;
  } else if (isAttachmentChunkId(id)) {
    const parsed = parseAttachmentChunkId(id);
    return parsed?.docId || null;
  }
  return null;
}

/**
 * Compute the SHA-256 hash of data and return it as a hex string.
 * Used for computing contentHash of encrypted data.
 * 
 * @param data The data to hash
 * @param subtle The SubtleCrypto instance
 * @returns The hex-encoded SHA-256 hash
 */
export async function computeContentHash(
  data: Uint8Array,
  subtle: SubtleCrypto
): Promise<string> {
  // Use data.buffer with proper offset/length to handle views correctly
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hashBuffer = await subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
