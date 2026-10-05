/**
 * ID Generation Utilities for ContentAddressedStore entries.
 *
 * Provides structured ID formats that enable:
 * - Guaranteed uniqueness across documents
 * - Efficient prefix-based queries
 * - Debugging visibility into entry relationships
 * - Blockchain-like integrity for document entries
 */

/** MongoDB-style ObjectId length: 12 bytes → 24 lowercase hex chars. */
export const OBJECT_ID_LENGTH = 24;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Cryptographically secure random bytes. Unlike {@link randomBytes} there is
 * no `Math.random` fallback: callers use these for nonces and ids that must
 * not be guessable.
 */
function secureRandomBytes(length: number): Uint8Array {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is not available");
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Process-unique 5-byte machine/process id (MongoDB ObjectId layout).
 * Regenerated once per JS realm so concurrent realms don't share the same
 * random prefix.
 */
const OBJECT_ID_PROCESS_UNIQUE = randomBytes(5);

/** 3-byte counter; seeded randomly then incremented per id (wraps at 2^24). */
let objectIdCounter = Math.floor(Math.random() * 0xffffff);

/**
 * Generate a MongoDB-style ObjectId: 24 lowercase hex characters.
 *
 * Layout (12 bytes):
 * - 4-byte big-endian Unix timestamp (seconds)
 * - 5-byte process-unique random value
 * - 3-byte big-endian incrementing counter
 *
 * Leading timestamp bytes make ids lexicographically sortable by creation
 * time. The alphabet is `0-9a-f` only — safe on case-insensitive filesystems.
 *
 * @param timeSeconds Optional Unix timestamp in seconds (for tests). Defaults
 *   to `Math.floor(Date.now() / 1000)`.
 */
export function generateObjectId(timeSeconds?: number): string {
  const seconds = timeSeconds ?? Math.floor(Date.now() / 1000);
  const bytes = new Uint8Array(12);
  bytes[0] = (seconds >>> 24) & 0xff;
  bytes[1] = (seconds >>> 16) & 0xff;
  bytes[2] = (seconds >>> 8) & 0xff;
  bytes[3] = seconds & 0xff;
  bytes.set(OBJECT_ID_PROCESS_UNIQUE, 4);
  objectIdCounter = (objectIdCounter + 1) & 0xffffff;
  bytes[9] = (objectIdCounter >>> 16) & 0xff;
  bytes[10] = (objectIdCounter >>> 8) & 0xff;
  bytes[11] = objectIdCounter & 0xff;
  return bytesToHex(bytes);
}

/**
 * Generate a fresh, globally unique document id: a MongoDB-style ObjectId
 * (24-char lowercase hex), optionally prefixed with `<prefix>_`.
 *
 * Because the ObjectId timestamp occupies the leading bytes, ids generated
 * later sort lexicographically after earlier ones (within the same prefix).
 *
 * The prefix (if any) is NOT validated here; callers validate it against
 * `DOC_ID_PREFIX_REGEX` before invoking this.
 *
 * @param prefix Optional short application prefix (e.g. "cls"); joined with "_".
 * @returns e.g. "507f1f77bcf86cd799439011" or "cls_507f1f77bcf86cd799439011"
 */
export function generateDocId(prefix?: string): string {
  const encoded = generateObjectId();
  return prefix ? `${prefix}_${encoded}` : encoded;
}

/**
 * Generate a fresh tenant id: MongoDB-style ObjectId (24-char lowercase hex).
 * Same format as {@link generateDocId} without a prefix — unique, time-sortable,
 * and case-insensitive-filesystem safe.
 */
export function generateTenantId(): string {
  return generateObjectId();
}

/**
 * Boundary-aware document-id prefix match used by prefix-filtered listing and
 * changefeed iteration.
 *
 * A `docId` matches `idPrefix` when it either equals the prefix exactly or
 * begins with `<idPrefix>_`. Matching on the `_` boundary (rather than a raw
 * `startsWith`) mirrors the `<prefix>_<objectId>` id scheme, so filtering by
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
 * Format: <docId>_a_<attachmentId>_<objectId>
 *
 * @param docId The document ID this attachment belongs to
 * @param attachmentId The id of the whole file (same for all chunks): an
 *   ObjectId for new attachments, a UUID7 for older ones
 * @param chunkObjectId Optional 24-char ObjectId for this chunk. If omitted, a
 *   fresh ObjectId is generated.
 * @returns The generated chunk ID
 */
export function generateAttachmentChunkId(
  docId: string,
  attachmentId: string,
  chunkObjectId?: string
): string {
  const chunkId = chunkObjectId ?? generateObjectId();
  return `${docId}_a_${attachmentId}_${chunkId}`;
}

/**
 * Generate an attachment chunk id that is unique within one write operation
 * even under case-insensitive comparison.
 *
 * Chunk entry ids become on-disk filenames (`entries/<id>.json`). New chunk
 * suffixes are lowercase ObjectIds, but legacy mixed-case suffixes may still
 * appear; the caller passes a set of case-folded ids already used in the
 * current write and on a fold-collision the id is regenerated. The set is
 * expected to be scoped to a single attachment write.
 *
 * @param docId The document ID this attachment belongs to
 * @param attachmentId The id of the whole file (same for all chunks): an
 *   ObjectId for new attachments, a UUID7 for older ones
 * @param usedCaseFoldedIds Case-folded ids already used in this write; the
 *   returned id's folded form is added to the set.
 * @returns The generated chunk ID
 */
export function generateUniqueAttachmentChunkId(
  docId: string,
  attachmentId: string,
  usedCaseFoldedIds: Set<string>,
): string {
  for (;;) {
    const id = generateAttachmentChunkId(docId, attachmentId);
    const folded = id.toLowerCase();
    if (!usedCaseFoldedIds.has(folded)) {
      usedCaseFoldedIds.add(folded);
      return id;
    }
  }
}

/**
 * Generate a new attachment id: a MongoDB-style ObjectId (24-char lowercase
 * hex), like document ids. Call once per file and reuse it for all chunks.
 *
 * Attachments written before this change carry a UUID7 here instead; both
 * formats parse via {@link parseAttachmentChunkId}.
 */
export function generateAttachmentId(): string {
  return generateObjectId();
}

/**
 * Generate a random RFC 4122 version 4 UUID from `crypto.getRandomValues`.
 * Used for single-use auth challenges and store epochs, where the value only
 * has to be unique and unguessable, not sortable.
 *
 * Deliberately not `crypto.randomUUID()`: that is missing in insecure browser
 * contexts and in some React Native crypto polyfills.
 */
export function generateRandomUuid(): string {
  const b = secureRandomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate an RFC 9562 version 7 UUID (48-bit Unix-ms timestamp + random).
 */
function uuidv7(): string {
  const b = secureRandomBytes(16);
  const ms = Date.now();
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate a new file UUID7.
 *
 * @deprecated MindooDB now uses {@link generateAttachmentId} (ObjectId) for new
 *   attachments. Kept for API compatibility.
 * @returns A new UUID7 string
 */
export function generateFileUuid7(): string {
  return uuidv7();
}

/**
 * Generate a new chunk UUID7.
 *
 * @deprecated Chunk ids use ObjectIds (see {@link generateAttachmentChunkId}).
 *   Kept for API compatibility.
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
  /** Attachment id: ObjectId for new attachments, UUID7 for older ones. */
  fileUuid7: string;
  chunkObjectId: string;
} | null {
  // Match: <docId>_a_<attachmentId>_<chunkObjectId> (legacy suffixes also parse)
  const match = id.match(/^(.+)_a_([^_]+)_(.+)$/);
  if (!match) return null;
  return {
    docId: match[1],
    fileUuid7: match[2],
    chunkObjectId: match[3],
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
