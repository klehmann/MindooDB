# Attachment Storage Design

## Overview

This document explores design options for storing file attachments associated with MindooDB documents. The goal is to provide secure, efficient, and flexible attachment storage that integrates seamlessly with the existing MindooDB architecture while supporting deduplication, optional local caching, random access, and transparent synchronization.

## Core Requirements

1. **Document Association**: Attachments must be linked to specific MindooDB documents
2. **Deduplication**: Same file content should be stored only once within a MindooDB (content-addressable)
3. **Optional Local Storage**: Clients can choose to store attachments locally (LRU, size threshold, or not at all)
4. **Transparent Remote Fetching**: Missing attachments should be automatically fetched from remote stores
5. **Random File Access**: Files must be chunked to enable seeking without loading entire files
6. **Resumable Transfers**: Individual chunks can be transferred independently for network resilience
7. **Encryption**: Each chunk must be encrypted using the same key model as documents (default tenant key or named keys)
8. **Reuse Existing Patterns**: Leverage append-only store concepts where applicable
9. **Future Migration**: Design should allow moving old attachments to external storage later

## Architecture Options

### Option 1: Separate Attachment Store (Recommended)

Create a parallel `AttachmentStore` interface similar to `AppendOnlyStore` but optimized for large binary data.

**Structure:**
- **Attachment Metadata**: Stored in document changes (Automerge) - lightweight references
- **Attachment Chunks**: Stored in separate `AttachmentStore` - encrypted binary chunks
- **Content Addressing**: Chunks identified by content hash (SHA-256) for deduplication
- **Chunk Index**: Tracks which chunks belong to which attachments

**Advantages:**
- Clean separation of concerns (documents vs. attachments)
- Can optimize storage strategies independently
- Easier to implement different retention policies
- Can use different storage backends (e.g., object storage for attachments)
- Doesn't bloat document change history with large payloads

**Disadvantages:**
- Requires new store interface and implementations
- More complex synchronization (two stores to sync)
- Need to handle orphaned attachments (when document deleted)

**Implementation Sketch:**
```typescript
interface AttachmentStore {
  // Store a chunk (content-addressable by hash)
  storeChunk(chunk: EncryptedAttachmentChunk): Promise<void>;
  
  // Get chunks by their content hashes
  getChunks(chunkHashes: string[]): Promise<EncryptedAttachmentChunk[]>;
  
  // Find chunks we don't have (similar to findNewChanges)
  findNewChunks(haveChunkHashes: string[]): Promise<string[]>;
  
  // Check if chunk exists locally (for optional storage)
  hasChunk(chunkHash: string): Promise<boolean>;
  
  // Optional: Get chunk metadata without fetching data
  getChunkMetadata(chunkHash: string): Promise<AttachmentChunkMetadata | null>;
}

interface EncryptedAttachmentChunk {
  chunkHash: string;        // SHA-256 of encrypted chunk
  encryptedData: Uint8Array; // AES-256-GCM encrypted chunk
  decryptionKeyId: string;   // "default" or named key ID
  iv: Uint8Array;           // AES-GCM IV
  tag: Uint8Array;          // AES-GCM authentication tag
  size: number;              // Original chunk size (before encryption)
  createdAt: number;         // Timestamp
}
```

### Option 2: Extend AppendOnlyStore

Extend the existing `AppendOnlyStore` to handle both document changes and attachment chunks.

**Structure:**
- Use same `append()` method but with different change types
- Add `type: "attachment-chunk"` to `MindooDocChangeHashes`
- Store chunks as large payloads in `MindooDocChange`

**Advantages:**
- Reuses existing sync infrastructure
- Single store to manage
- Consistent with document change model

**Disadvantages:**
- Mixes small document changes with large attachment chunks
- Less efficient for large files (all chunks in one store)
- Harder to implement different storage strategies
- Blurs the line between document metadata and binary data

### Option 3: Hybrid Approach

Store attachment metadata in document changes, but chunks in a separate optimized store.

**Structure:**
- Attachment references stored in Automerge document (lightweight)
- Chunks stored in `AttachmentStore` (optimized for large binary data)
- Document changes reference attachment by content hash

**Advantages:**
- Best of both worlds: lightweight metadata in documents, optimized storage for chunks
- Can implement sophisticated caching strategies
- Easy to migrate chunks to external storage later

**Disadvantages:**
- Most complex to implement
- Requires coordination between two stores

## Recommended Design: Option 1 (Separate Attachment Store)

### Core Concepts

#### 1. Content-Addressable Chunks

Each chunk is identified by its content hash (SHA-256 of encrypted chunk):
- **Deduplication**: Same file content = same chunk hashes = stored once
- **Integrity**: Hash verifies chunk hasn't been corrupted
- **Efficiency**: Multiple attachments can reference same chunks (e.g., same image in multiple documents)

**Chunk Size Considerations:**
- **Small chunks (64KB-256KB)**: Better for random access, more network overhead
- **Large chunks (1MB-4MB)**: Better for network efficiency, less random access granularity
- **Recommendation**: Start with 256KB chunks, make configurable

#### 2. Attachment Metadata in Documents

Attachments are referenced in Automerge documents via lightweight metadata:

```typescript
interface AttachmentReference {
  attachmentId: string;           // UUID7 for this attachment instance
  fileName: string;               // Original filename
  mimeType: string;               // MIME type
  size: number;                   // Total file size in bytes
  chunkHashes: string[];          // Ordered list of chunk content hashes
  decryptionKeyId: string;        // Same key as document ("default" or named)
  createdAt: number;              // When attachment was added
  createdBy: string;              // User public key
  // Optional: thumbnail, preview, etc.
}
```

**Document Structure Example:**
```typescript
{
  title: "My Document",
  content: "...",
  attachments: [
    {
      attachmentId: "123e4567-...",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      size: 5242880,
      chunkHashes: ["abc123...", "def456...", "ghi789..."],
      decryptionKeyId: "default",
      createdAt: 1234567890,
      createdBy: "-----BEGIN PUBLIC KEY-----..."
    }
  ]
}
```

#### 3. Chunk Encryption

Each chunk is encrypted independently using AES-256-GCM:
- **Key**: Same as document (tenant key or named key from `decryptionKeyId`)
- **IV**: Unique per chunk (12 bytes, random)
- **Tag**: Authentication tag from AES-GCM (16 bytes)
- **Hash**: SHA-256 of encrypted chunk (for content addressing)

**Why encrypt before hashing?**
- Content hash = hash of encrypted data
- Same plaintext with different keys = different hashes
- Enables per-tenant/per-key deduplication
- Security: Even if hash is known, can't determine if you have the key

**Alternative: Hash plaintext, encrypt separately**
- Simpler deduplication (same file = same hash regardless of key)
- But: Need to store both plaintext hash and encrypted data
- Risk: Plaintext hash could leak information about file content

**Recommendation**: Encrypt then hash (current approach) for stronger security, accept that deduplication is per-key.

#### 4. Attachment Store Interface

```typescript
interface AttachmentStore {
  /**
   * Get the ID of the store (same as MindooDB ID)
   */
  getId(): string;

  /**
   * Store a chunk. Deduplication is automatic (no-op if chunk already exists).
   * @param chunk The encrypted chunk to store
   */
  storeChunk(chunk: EncryptedAttachmentChunk): Promise<void>;

  /**
   * Get multiple chunks by their content hashes.
   * Returns only chunks that exist locally (for optional storage).
   * @param chunkHashes Array of chunk hashes to fetch
   * @returns Array of chunks (may be shorter than input if some don't exist locally)
   */
  getChunks(chunkHashes: string[]): Promise<EncryptedAttachmentChunk[]>;

  /**
   * Check if a chunk exists locally.
   * @param chunkHash The chunk hash to check
   * @returns True if chunk exists locally, false otherwise
   */
  hasChunk(chunkHash: string): Promise<boolean>;

  /**
   * Find chunks in this store that are not in the provided list.
   * Similar to AppendOnlyStore.findNewChanges().
   * @param haveChunkHashes List of chunk hashes we already have
   * @returns List of chunk hashes we don't have yet
   */
  findNewChunks(haveChunkHashes: string[]): Promise<string[]>;

  /**
   * Get all chunk hashes stored in this store.
   * Similar to AppendOnlyStore.getAllChangeHashes().
   */
  getAllChunkHashes(): Promise<string[]>;

  /**
   * Optional: Get chunk metadata without fetching the actual data.
   * Useful for checking if chunk exists and getting size info.
   */
  getChunkMetadata(chunkHash: string): Promise<AttachmentChunkMetadata | null>;

  /**
   * Optional: Delete a chunk (for storage management).
   * Should only be used when moving to external storage or cleanup.
   */
  deleteChunk(chunkHash: string): Promise<void>;
}

interface EncryptedAttachmentChunk {
  chunkHash: string;        // SHA-256 of encryptedData
  encryptedData: Uint8Array; // AES-256-GCM encrypted chunk
  decryptionKeyId: string;   // "default" or named key ID
  iv: Uint8Array;           // 12 bytes for AES-GCM
  tag: Uint8Array;          // 16 bytes authentication tag
  originalSize: number;     // Size of plaintext chunk (before encryption)
  createdAt: number;         // Timestamp
}

interface AttachmentChunkMetadata {
  chunkHash: string;
  size: number;             // Size of encrypted chunk
  originalSize: number;     // Size of plaintext chunk
  decryptionKeyId: string;
  createdAt: number;
}
```

#### 5. MindooDB Attachment API

```typescript
interface MindooDB {
  // ... existing methods ...

  /**
   * Add an attachment to a document.
   * Chunks the file, encrypts each chunk, stores in AttachmentStore,
   * and adds reference to document.
   * 
   * @param doc The document to attach the file to
   * @param fileData The file data (Uint8Array or File/Blob)
   * @param fileName Original filename
   * @param mimeType MIME type
   * @param decryptionKeyId Optional key ID (defaults to document's key)
   * @returns Attachment reference with attachmentId and chunkHashes
   */
  addAttachment(
    doc: MindooDoc,
    fileData: Uint8Array | File | Blob,
    fileName: string,
    mimeType: string,
    decryptionKeyId?: string
  ): Promise<AttachmentReference>;

  /**
   * Get attachment data by reading chunks and decrypting.
   * Automatically fetches missing chunks from remote stores if configured.
   * 
   * @param doc The document containing the attachment
   * @param attachmentId The attachment ID
   * @returns The decrypted file data
   */
  getAttachment(doc: MindooDoc, attachmentId: string): Promise<Uint8Array>;

  /**
   * Get a range of attachment data (for streaming/random access).
   * Only fetches and decrypts the necessary chunks.
   * 
   * @param doc The document containing the attachment
   * @param attachmentId The attachment ID
   * @param startByte Start byte offset (inclusive)
   * @param endByte End byte offset (exclusive)
   * @returns The decrypted data range
   */
  getAttachmentRange(
    doc: MindooDoc,
    attachmentId: string,
    startByte: number,
    endByte: number
  ): Promise<Uint8Array>;

  /**
   * Remove an attachment from a document.
   * Note: Chunks are not deleted (may be referenced by other attachments).
   * 
   * @param doc The document
   * @param attachmentId The attachment ID to remove
   */
  removeAttachment(doc: MindooDoc, attachmentId: string): Promise<void>;

  /**
   * Pull attachment chunks from a remote AttachmentStore.
   * Similar to pullChangesFrom() for document changes.
   * 
   * @param remoteStore The remote AttachmentStore to pull from
   */
  pullAttachmentChunksFrom(remoteStore: AttachmentStore): Promise<void>;

  /**
   * Push attachment chunks to a remote AttachmentStore.
   * Similar to pushChangesTo() for document changes.
   * 
   * @param remoteStore The remote AttachmentStore to push to
   */
  pushAttachmentChunksTo(remoteStore: AttachmentStore): Promise<void>;
}
```

### Synchronization Strategy

#### Two-Phase Sync

1. **Document Changes Sync** (existing):
   - Sync document changes via `AppendOnlyStore`
   - Extract attachment references from documents
   - Identify required chunk hashes

2. **Attachment Chunks Sync** (new):
   - Compare chunk hashes with remote `AttachmentStore`
   - Fetch missing chunks
   - Store chunks locally (if optional storage enabled)

#### Lazy Loading

- **On-Demand Fetching**: Only fetch chunks when attachment is accessed
- **Prefetching**: Optionally prefetch chunks for recently accessed documents
- **Background Sync**: Optionally sync all chunks in background

### Optional Local Storage

#### Storage Policies

```typescript
interface AttachmentStoragePolicy {
  // Maximum total size of attachments to store locally (in bytes)
  maxLocalSize?: number;
  
  // Maximum number of attachments to keep locally (LRU)
  maxLocalCount?: number;
  
  // Always keep attachments for these document IDs
  keepForDocuments?: string[];
  
  // Never store locally (always fetch from remote)
  neverStore?: boolean;
}

class AttachmentCacheManager {
  // Track chunk access times for LRU eviction
  private chunkAccessTimes: Map<string, number>;
  
  // Track total local storage size
  private localStorageSize: number;
  
  // Evict least recently used chunks when limit reached
  async evictIfNeeded(): Promise<void>;
  
  // Check if chunk should be kept locally
  shouldKeepLocally(chunkHash: string): boolean;
}
```

#### Implementation Strategies

1. **LRU Cache**: Track access times, evict least recently used chunks
2. **Size Threshold**: Keep chunks below total size limit, evict largest first
3. **Hybrid**: Combine LRU with size limits
4. **Document-Based**: Keep all chunks for certain documents, evict others

### Chunking Strategy

#### Fixed-Size Chunks

- **Size**: 256KB per chunk (configurable)
- **Advantages**: Simple, predictable, good for random access
- **Disadvantages**: Last chunk may be small, slight overhead

#### Variable-Size Chunks (Content-Defined)

- Use content-defined chunking (e.g., Rabin fingerprinting)
- **Advantages**: Better deduplication (handles insertions in files)
- **Disadvantages**: More complex, less predictable random access

**Recommendation**: Start with fixed-size chunks (256KB), consider variable-size later if deduplication becomes important.

### Encryption Details

#### Per-Chunk Encryption

Each chunk is encrypted independently:
1. Generate random IV (12 bytes) for AES-GCM
2. Encrypt chunk with key from `decryptionKeyId` (tenant key or named key)
3. Get authentication tag (16 bytes) from AES-GCM
4. Compute SHA-256 hash of encrypted data
5. Store: `{ chunkHash, encryptedData, iv, tag, decryptionKeyId, originalSize, createdAt }`

#### Key Derivation

- Use same key management as documents:
  - `decryptionKeyId === "default"` → tenant encryption key
  - `decryptionKeyId === "<name>"` → named symmetric key from KeyBag
- Reuse `Tenant.encryptPayload()` and `Tenant.decryptPayload()` methods

### Deduplication Strategy

#### Content-Addressable Storage

- Chunk hash = SHA-256(encrypted chunk)
- Same encrypted content = same hash = stored once
- Multiple attachments can reference same chunk hash

#### Deduplication Scope

**Option A: Per-Tenant Deduplication**
- Deduplicate within a MindooDB (tenant scope)
- Same file in different documents = same chunks
- **Advantage**: Maximum deduplication
- **Disadvantage**: Need to track chunk references (garbage collection)

**Option B: Per-Document Deduplication**
- Each document's attachments are independent
- **Advantage**: Simpler (no reference tracking)
- **Disadvantage**: Less deduplication

**Recommendation**: Start with per-tenant deduplication, add reference counting for garbage collection later.

### Garbage Collection

When attachments are removed from documents, chunks may become orphaned:

```typescript
interface ChunkReferenceTracker {
  // Track which documents reference which chunks
  private chunkReferences: Map<string, Set<string>>; // chunkHash -> Set<docId>
  
  // Add reference when attachment added
  addReference(chunkHash: string, docId: string): void;
  
  // Remove reference when attachment removed
  removeReference(chunkHash: string, docId: string): void;
  
  // Get orphaned chunks (not referenced by any document)
  getOrphanedChunks(): string[];
  
  // Optional: Clean up orphaned chunks (for storage management)
  async cleanupOrphanedChunks(): Promise<void>;
}
```

**Garbage Collection Strategy:**
- **Immediate**: Delete chunks when last reference removed
- **Deferred**: Mark as orphaned, delete in background job
- **Never**: Keep all chunks (for audit/history)

**Recommendation**: Start with deferred cleanup, make configurable.

### Migration to External Storage

#### Future Enhancement: Tiered Storage

Design should allow moving old chunks to external storage (e.g., S3, Azure Blob):

```typescript
interface TieredAttachmentStore extends AttachmentStore {
  // Move chunks older than threshold to external storage
  migrateToExternalStorage(ageThreshold: number): Promise<void>;
  
  // Restore chunk from external storage if needed
  restoreFromExternalStorage(chunkHash: string): Promise<void>;
}
```

**Migration Strategy:**
1. Identify chunks older than threshold (e.g., 90 days)
2. Upload to external storage (S3, etc.)
3. Mark as migrated in local store (keep metadata)
4. Delete local copy (or keep as cache)
5. On access: Check local → check external → fetch if needed

**Metadata Preservation:**
- Keep chunk metadata in local store even after migration
- Enables efficient "has chunk" checks without external calls
- Can prefetch from external storage if needed

### Implementation Phases

#### Phase 1: Core Attachment Store (MVP)

1. Create `AttachmentStore` interface
2. Implement `InMemoryAttachmentStore` (for testing)
3. Implement chunking and encryption
4. Add `addAttachment()` and `getAttachment()` to MindooDB
5. Store attachment references in documents

#### Phase 2: Synchronization

1. Implement `findNewChunks()` and sync methods
2. Add `pullAttachmentChunksFrom()` and `pushAttachmentChunksTo()`
3. Integrate with document sync (two-phase sync)

#### Phase 3: Optional Local Storage

1. Implement `AttachmentCacheManager` with LRU/size policies
2. Add storage policies configuration
3. Implement eviction logic
4. Add transparent remote fetching

#### Phase 4: Random Access & Streaming

1. Implement `getAttachmentRange()` for byte-range requests
2. Optimize chunk fetching (only fetch needed chunks)
3. Add streaming support for large files

#### Phase 5: Advanced Features

1. Garbage collection for orphaned chunks
2. Content-defined chunking (variable-size)
3. Tiered storage (external storage migration)
4. Thumbnail/preview generation
5. Attachment versioning

### Reusing Existing Functionality

#### Encryption/Decryption

- **Reuse**: `Tenant.encryptPayload()` and `Tenant.decryptPayload()`
- **Benefit**: Consistent encryption, existing key management

#### Synchronization Pattern

- **Reuse**: `findNewChanges()` / `getChanges()` pattern from `AppendOnlyStore`
- **Adapt**: `findNewChunks()` / `getChunks()` for attachments
- **Benefit**: Familiar API, proven sync mechanism

#### Store Factory Pattern

- **Reuse**: `AppendOnlyStoreFactory` pattern
- **Create**: `AttachmentStoreFactory` interface
- **Benefit**: Consistent architecture, easy to swap implementations

### Security Considerations

#### Encryption

- Each chunk encrypted independently (different IV per chunk)
- Same key model as documents (tenant key or named keys)
- AES-256-GCM provides authenticated encryption

#### Access Control

- Attachment access controlled by document access
- If user can't decrypt document, they can't decrypt attachments
- Chunk hashes don't reveal plaintext (encrypted then hashed)

#### Integrity

- Content hash verifies chunk integrity
- AES-GCM tag verifies authenticity
- Signature on document change verifies attachment reference

### Performance Considerations

#### Chunk Size Trade-offs

- **Small chunks (64KB)**: Better random access, more overhead
- **Large chunks (1MB+)**: Better network efficiency, less granular access
- **Recommendation**: 256KB default, make configurable

#### Caching Strategy

- Cache decrypted chunks in memory (with size limits)
- Prefetch chunks for recently accessed documents
- Background sync for frequently accessed attachments

#### Network Optimization

- Batch chunk requests (similar to `getChanges()`)
- Compress chunk metadata (not encrypted data)
- Use HTTP range requests for external storage

### Open Questions

1. **Chunk Size**: What's the optimal default? (Recommendation: 256KB)
2. **Deduplication Scope**: Per-tenant or per-document? (Recommendation: per-tenant)
3. **Garbage Collection**: Immediate, deferred, or never? (Recommendation: deferred, configurable)
4. **Storage Policy**: How to configure LRU/size limits? (Recommendation: configurable per MindooDB)
5. **External Storage**: When to migrate? What backends? (Future enhancement)
6. **Variable Chunking**: When to implement? (Future enhancement if deduplication needed)

### Example Usage

```typescript
// Create a document
const doc = await db.createDocument();
await db.changeDoc(doc, (d) => {
  d.getData().title = "My Document";
});

// Add an attachment
const fileData = new Uint8Array(/* ... */);
const attachment = await db.addAttachment(
  doc,
  fileData,
  "report.pdf",
  "application/pdf"
);
console.log(`Attachment ID: ${attachment.attachmentId}`);
console.log(`Chunks: ${attachment.chunkHashes.length}`);

// Get attachment (automatically fetches missing chunks)
const retrievedData = await db.getAttachment(doc, attachment.attachmentId);

// Get attachment range (random access)
const range = await db.getAttachmentRange(
  doc,
  attachment.attachmentId,
  0,
  1024 * 1024 // First 1MB
);

// Sync attachments between stores
const remoteAttachmentStore = /* ... */;
await db.pullAttachmentChunksFrom(remoteAttachmentStore);
await db.pushAttachmentChunksTo(remoteAttachmentStore);
```

## Conclusion

The recommended design uses a separate `AttachmentStore` interface that parallels `AppendOnlyStore` but is optimized for large binary chunks. This provides:

- **Clean separation**: Documents vs. attachments
- **Content-addressable storage**: Deduplication via chunk hashes
- **Flexible storage**: Optional local caching with configurable policies
- **Random access**: Chunked files enable byte-range requests
- **Security**: Per-chunk encryption using existing key model
- **Synchronization**: Reuse proven sync patterns from document changes
- **Future-proof**: Design allows migration to external storage

The implementation can be phased, starting with core functionality and adding advanced features (caching, garbage collection, external storage) incrementally.

