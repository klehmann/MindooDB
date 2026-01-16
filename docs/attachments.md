# Attachment Storage Design

## Overview

This document describes the design for storing file attachments associated with MindooDB documents. The approach uses a unified `ContentAddressedStore` interface that serves both Automerge document changes and attachment chunks, providing secure, efficient, and flexible storage with deduplication, optional local caching, random access, and transparent synchronization.

## Architecture: Unified ContentAddressedStore

After exploring various options, we chose to unify document changes and attachment storage under a single `ContentAddressedStore` interface. This provides:

- **Consistent interface**: Same store interface for documents and attachments
- **Flexible deployment**: MindooDB can use separate stores for docs and attachments
- **Shared infrastructure**: Reuses existing sync, encryption, and authentication patterns
- **Type differentiation**: Uses `entryType` field to distinguish between entry types

### Core Concepts

#### 1. Entry Types

The `ContentAddressedStore` stores entries with a unique `id` and a `contentHash` for deduplication. The `entryType` field distinguishes between:

- `doc_create` - Document creation (first Automerge change)
- `doc_change` - Document modification (subsequent Automerge changes)
- `doc_snapshot` - Automerge snapshot for performance optimization
- `doc_delete` - Document deletion (tombstone entry)
- `attachment_chunk` - File attachment chunk

Store implementations can use this field to optimize storage (e.g., inline small doc changes, external storage for large attachment chunks).

#### 2. Entry ID and ContentHash Separation

Each store entry has two distinct identifiers:

- **`id`**: Unique identifier (primary key) for the entry
  - For doc_* entries: `<docId>_d_<depsFingerprint>_<automergeHash>`
  - For attachment_chunk: `<docId>_a_<fileUuid7>_<base62ChunkUuid7>`
  
- **`contentHash`**: SHA-256 hash of the encrypted data
  - Used for storage-level deduplication
  - Multiple entries can share the same contentHash

This separation enables:
- Unique metadata per entry (even when content is identical)
- Storage-level deduplication (same bytes stored once)
- No metadata collisions when files share content

**Document Entry ID Format:**
```
<docId>_d_<depsFingerprint>_<automergeHash>
```
- `docId`: Document UUID7
- `d`: Type marker for "document"
- `depsFingerprint`: First 8 chars of SHA256(sorted Automerge deps), or "0" if no deps
- `automergeHash`: The Automerge change hash

**Attachment Chunk ID Format:**
```
<docId>_a_<fileUuid7>_<base62ChunkUuid7>
```
- `docId`: Document UUID7 this attachment belongs to
- `a`: Type marker for "attachment"
- `fileUuid7`: UUID7 for the whole file (same for all chunks)
- `base62ChunkUuid7`: Base62-encoded UUID7 for this specific chunk

#### 3. MindooDB Two-Store Architecture

MindooDB accepts two store instances in its constructor:

```typescript
class MindooDB {
  constructor(
    tenant: MindooTenant,
    docStore: ContentAddressedStore,
    attachmentStore?: ContentAddressedStore
  )
  
  getStore(): ContentAddressedStore;  // Returns docStore
  getAttachmentStore(): ContentAddressedStore | undefined;  // Returns attachmentStore
}
```

This enables flexible deployment options:
- **Single store**: Use one store for both documents and attachments (simple deployments)
- **Separate stores**: Use different stores/backends (e.g., local docs, cloud attachments)
- **No attachments**: Don't configure an attachment store for document-only use cases

#### 4. Content Deduplication

The store deduplicates content at the storage level:
- **Metadata**: Stored by `id` (always unique)
- **Content**: Stored by `contentHash` (deduplicated)

When two entries have the same `contentHash`:
1. Both entries have their own metadata (different `id`, `docId`, `dependencyIds`)
2. The encrypted bytes are stored only once
3. When an entry is deleted, orphaned content is cleaned up

**Chunk Size**: 256KB per chunk (configurable)

#### 5. StoreEntry for Attachment Chunks

Attachment chunks use the same `StoreEntry` type as document changes:

```typescript
interface StoreEntry extends StoreEntryMetadata {
  entryType: "attachment_chunk";      // Identifies this as an attachment chunk
  id: string;                         // Unique chunk ID (format: docId_a_fileId_chunkId)
  contentHash: string;                // SHA-256 of encryptedData (for deduplication)
  docId: string;                      // Document this chunk belongs to
  dependencyIds: string[];            // Entry ID of previous chunk (for append-only files)
  createdAt: number;
  createdByPublicKey: string;         // Author's public signing key
  decryptionKeyId: string;            // "default" or named key ID
  signature: Uint8Array;              // Signature over encrypted data
  encryptedData: Uint8Array;          // Encrypted chunk data
  originalSize?: number;              // Plaintext chunk size before encryption
}
```

#### 6. Attachment Metadata in Documents

Attachments are referenced in Automerge documents via lightweight metadata:

```typescript
interface AttachmentReference {
  attachmentId: string;           // UUID7 for this attachment instance
  fileName: string;               // Original filename
  mimeType: string;               // MIME type
  size: number;                   // Total file size in bytes
  lastChunkId: string;            // Entry ID of the last chunk (enables append-only growth)
  decryptionKeyId: string;        // Same key as document ("default" or named)
  createdAt: number;              // When attachment was added
  createdBy: string;              // User public key
}
```

**Document Structure Example:**
```typescript
{
  title: "My Document",
  content: "...",
  _attachments: [
    {
      attachmentId: "123e4567-...",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      size: 5242880,
      lastChunkId: "123e4567-..._a_file-uuid_chunk-id",
      decryptionKeyId: "default",
      createdAt: 1234567890,
      createdBy: "-----BEGIN PUBLIC KEY-----..."
    }
  ]
}
```

### Append-Only File Growth

The design supports appending content to files without copying existing data:

1. Each chunk has `dependencyIds` pointing to the previous chunk's entry ID
2. Document metadata stores `lastChunkId` and total `size`
3. To append: Create new chunks pointing back to the previous last chunk
4. Update document metadata with new `lastChunkId` and `size`
5. Use `resolveDependencies()` to traverse from last to first chunk for reading

This is ideal for log files and other append-only data.

### Dependency Resolution

The `ContentAddressedStore.resolveDependencies()` method enables:
- **Attachment streaming**: Traverse from last chunk to first
- **Document loading**: Stop at snapshots when loading document history

```typescript
interface ContentAddressedStore {
  resolveDependencies(
    startId: string,
    options?: {
      stopAtEntryType?: string;  // Stop at "doc_snapshot" for docs
      maxDepth?: number;         // Limit traversal depth
      includeStart?: boolean;    // Include startId in result
    }
  ): Promise<string[]>;
}
```

### Encryption

Each chunk is encrypted independently using AES-256-GCM with two modes:

#### Random IV Mode (0x00)
- IV is randomly generated for each encryption
- Same plaintext produces different ciphertext each time
- No deduplication possible
- More secure for sensitive content

#### Deterministic IV Mode (0x01) - Default for Attachments
- IV is derived from SHA-256(plaintext)[:12]
- Same plaintext + same key = same ciphertext
- Enables tenant-wide deduplication
- Reveals when identical content is stored (acceptable trade-off)

**Encrypted Data Format:**
```
[mode byte (1)] [IV (12 bytes)] [ciphertext + GCM tag]
```

- **Key**: Same as document (tenant key or named key from `decryptionKeyId`)
- **Mode byte**: 0x00 = random IV, 0x01 = deterministic IV
- **IV**: 12 bytes (random or derived from content)
- **contentHash**: SHA-256 of complete encrypted payload (mode + IV + ciphertext)

**Why encrypt before hashing?**
- Security: Content hash doesn't reveal plaintext information
- Per-key deduplication: Same file with different keys = different hashes
- Consistent with document change encryption

**Deterministic Encryption Trade-offs:**
- Pro: Tenant-wide deduplication (all users encrypting same file = same contentHash)
- Pro: Bandwidth savings on sync (don't transfer duplicate content)
- Pro: Storage savings (one copy of encrypted bytes per contentHash)
- Con: Reveals when identical content exists (metadata pattern)
- Con: Same content always produces same ciphertext (less secure than random IV)

### Synchronization Strategy

#### Two-Phase Sync

1. **Document Changes Sync**:
   - Sync document entries via `docStore`
   - Extract attachment references from documents
   - Identify required chunk entry IDs

2. **Attachment Chunks Sync**:
   - Compare chunk IDs with remote `attachmentStore`
   - Fetch missing chunks using `resolveDependencies()`
   - Store chunks locally (if optional storage enabled)

#### Lazy Loading

- **On-Demand Fetching**: Only fetch chunks when attachment is accessed
- **Streaming**: Use `resolveDependencies()` to traverse chunk chain
- **Background Sync**: Optionally sync all chunks in background

### MindooDB Attachment API

```typescript
interface MindooDB {
  // Get the attachment store (may be same as doc store or separate)
  getAttachmentStore(): ContentAddressedStore | undefined;

  // Add an attachment to a document
  addAttachment(
    doc: MindooDoc,
    fileData: Uint8Array | File | Blob,
    fileName: string,
    mimeType: string,
    decryptionKeyId?: string
  ): Promise<AttachmentReference>;

  // Get attachment data (fetches chunks, decrypts, assembles)
  getAttachment(doc: MindooDoc, attachmentId: string): Promise<Uint8Array>;

  // Get a range of attachment data (random access)
  getAttachmentRange(
    doc: MindooDoc,
    attachmentId: string,
    startByte: number,
    endByte: number
  ): Promise<Uint8Array>;

  // Append data to an existing attachment
  appendToAttachment(
    doc: MindooDoc,
    attachmentId: string,
    data: Uint8Array
  ): Promise<void>;

  // Remove an attachment from a document
  removeAttachment(doc: MindooDoc, attachmentId: string): Promise<void>;
}
```

### Optional Local Storage

#### Storage Policies

```typescript
interface AttachmentStoragePolicy {
  maxLocalSize?: number;        // Maximum total size of attachments
  maxLocalCount?: number;       // Maximum number of chunks (LRU)
  keepForDocuments?: string[];  // Always keep for these doc IDs
  neverStore?: boolean;         // Always fetch from remote
}
```

#### Cache Management

- **LRU Cache**: Track access times, evict least recently used chunks
- **Size Threshold**: Keep chunks below total size limit
- **Document-Based**: Keep all chunks for certain documents

### GDPR Compliance

The `ContentAddressedStore.purgeDocHistory(docId)` method enables:
- Removing all entries (document changes AND attachment chunks) for a document
- Supporting "right to be forgotten" requirements
- Coordinated cleanup across document and attachment stores
- Automatic cleanup of orphaned content (bytes no longer referenced by any entry)

### Implementation Phases

#### Phase 1: Core Infrastructure (COMPLETED)
- [x] Create `ContentAddressedStore` interface with `id`/`contentHash` separation
- [x] Implement `InMemoryContentAddressedStore` with byte-level deduplication
- [x] Add `StoreEntry` types with `entryType` field
- [x] Update `MindooDB` to accept two stores
- [x] Implement structured ID generation utilities
- [x] Add deterministic encryption for attachments

#### Phase 2: Attachment Storage (Future)
- [ ] Implement chunking and `attachment_chunk` entries
- [ ] Add `addAttachment()` and `getAttachment()` to MindooDB
- [ ] Store attachment references in documents

#### Phase 3: Synchronization (Future)
- [ ] Implement attachment chunk sync
- [ ] Add `resolveDependencies()` usage for streaming
- [ ] Integrate with document sync (two-phase sync)

#### Phase 4: Optional Local Storage (Future)
- [ ] Implement `AttachmentCacheManager` with LRU/size policies
- [ ] Add storage policies configuration
- [ ] Implement eviction logic
- [ ] Add transparent remote fetching

#### Phase 5: Advanced Features (Future)
- [ ] Append-only file growth
- [ ] Random access (`getAttachmentRange()`)
- [ ] Streaming support for large files
- [ ] Content-defined chunking (variable-size)
- [ ] Tiered storage (external storage migration)

### Example Usage

```typescript
// Create MindooDB with separate stores for docs and attachments
const docStore = docStoreFactory.createStore("mydb");
const attachmentStore = attachmentStoreFactory.createStore("mydb-attachments");

const db = new BaseMindooDB(tenant, docStore, attachmentStore);

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
console.log(`Last chunk ID: ${attachment.lastChunkId}`);

// Get attachment (automatically fetches missing chunks)
const retrievedData = await db.getAttachment(doc, attachment.attachmentId);

// Append to file (for log files, etc.)
await db.appendToAttachment(doc, attachment.attachmentId, newData);

// Get attachment range (random access)
const range = await db.getAttachmentRange(
  doc,
  attachment.attachmentId,
  0,
  1024 * 1024 // First 1MB
);
```

## Conclusion

The unified `ContentAddressedStore` approach provides:

- **Consistent interface**: Same store interface for documents and attachments
- **Flexible deployment**: Separate or combined stores based on needs
- **Content-addressable storage**: Deduplication via contentHash
- **Separate id and contentHash**: No metadata collisions with deduplication
- **Deterministic encryption**: Tenant-wide deduplication for attachments
- **Append-only files**: Support for log files and growing data
- **Security**: Per-chunk encryption using existing key model
- **Synchronization**: Reuse proven sync patterns from document changes
- **GDPR compliance**: Coordinated cleanup via `purgeDocHistory()`
- **Future-proof**: Design allows migration to external storage

The implementation is phased, with core infrastructure completed and attachment-specific features to be added incrementally.
