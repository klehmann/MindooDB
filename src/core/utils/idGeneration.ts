/**
 * ID Generation Utilities for ContentAddressedStore entries.
 * 
 * Provides structured ID formats that enable:
 * - Guaranteed uniqueness across documents
 * - Efficient prefix-based queries
 * - Debugging visibility into entry relationships
 * - Blockchain-like integrity for document entries
 */

import { encode as base62Encode, decode as base62Decode } from '@digitalmaas/uuid-base62';
import { v7 as uuidv7 } from 'uuid';

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
  // base62Encode expects UUID with dashes
  const base62Chunk = base62Encode(chunkId);
  return `${docId}_a_${fileUuid7}_${base62Chunk}`;
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
