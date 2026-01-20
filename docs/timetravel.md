# Time Travel and Document History

## Overview

MindooDB provides time travel functionality that allows you to retrieve documents at specific points in time and traverse the complete history of a document from its creation to the latest version. This enables historical analysis, audit trails, and the ability to understand how documents evolved over time.

## Features

MindooDB offers three main time travel capabilities:

1. **`getDocumentAtTimestamp()`** - Retrieve a document snapshot at a specific point in time
2. **`getAllDocumentIdsAtTimestamp()`** - Get all document IDs that existed at a specific point in time
3. **`iterateDocumentHistory()`** - Traverse all changes to a document chronologically

Both methods work with MindooDB's append-only storage architecture, which maintains a complete history of all document changes.

## getDocumentAtTimestamp()

Retrieve a document at a specific point in time by applying all changes up to the given timestamp.

### Method Signature

```typescript
getDocumentAtTimestamp(docId: string, timestamp: number): Promise<MindooDoc | null>
```

### Parameters

- `docId`: The ID of the document to retrieve
- `timestamp`: The timestamp to reconstruct the document at (milliseconds since Unix epoch)

### Returns

- `Promise<MindooDoc | null>`: The document at the specified timestamp, or `null` if the document didn't exist at that time.
  If the document was deleted at or before the timestamp, returns a document with `isDeleted() === true` (not `null`).

### Example Usage

```typescript
// Create a document and make several changes
const doc = await db.createDocument();
const docId = doc.getId();

// Record timestamps for each change
const timestamps: number[] = [];
timestamps.push(Date.now()); // Creation time

await db.changeDoc(doc, (d) => {
  d.getData().version = 1;
});
timestamps.push(Date.now()); // First modification

await db.changeDoc(doc, (d) => {
  d.getData().version = 2;
});
timestamps.push(Date.now()); // Second modification

// Retrieve document at different points in time
const docAtCreation = await db.getDocumentAtTimestamp(docId, timestamps[0]);
console.log("At creation:", docAtCreation?.getData()); // { version: undefined }

const docAtFirstChange = await db.getDocumentAtTimestamp(docId, timestamps[1]);
console.log("After first change:", docAtFirstChange?.getData()); // { version: 1 }

const docAtSecondChange = await db.getDocumentAtTimestamp(docId, timestamps[2]);
console.log("After second change:", docAtSecondChange?.getData()); // { version: 2 }

// Before document existed
const beforeCreation = await db.getDocumentAtTimestamp(docId, timestamps[0] - 1000);
console.log("Before creation:", beforeCreation); // null
```

### Handling Deleted Documents

When a document is deleted, `getDocumentAtTimestamp()` returns a document with `isDeleted() === true` for timestamps at or after the deletion time. This allows you to distinguish between:
- **Document didn't exist yet**: Returns `null`
- **Document was deleted**: Returns a document with `isDeleted() === true`

```typescript
const doc = await db.createDocument();
const docId = doc.getId();

await db.changeDoc(doc, (d) => {
  d.getData().status = "active";
});
const modifyTime = Date.now();

await db.deleteDocument(docId);
const deleteTime = Date.now();

// Document exists before deletion
const beforeDelete = await db.getDocumentAtTimestamp(docId, modifyTime);
console.log(beforeDelete?.getData().status); // "active"
console.log(beforeDelete?.isDeleted()); // false

// Document is deleted at deletion time (not null!)
const atDelete = await db.getDocumentAtTimestamp(docId, deleteTime);
console.log(atDelete); // MindooDoc (not null)
console.log(atDelete?.isDeleted()); // true

// Document didn't exist before creation
const beforeCreation = await db.getDocumentAtTimestamp(docId, createTime - 1000);
console.log(beforeCreation); // null
```

## iterateDocumentHistory()

Traverse the complete history of a document from its origin to the latest version, yielding each document state along with change metadata.

**Order**: Documents are yielded in chronological order from oldest to newest (origin to latest version).

### Method Signature

```typescript
iterateDocumentHistory(docId: string): AsyncGenerator<DocumentHistoryResult, void, unknown>
```

**Order**: Documents are yielded in chronological order from oldest to newest (origin to latest version).

### Return Type

```typescript
interface DocumentHistoryResult {
  /**
   * The document state after applying this change.
   * Each document is an independent clone, safe to store in arrays.
   */
  doc: MindooDoc;
  
  /**
   * The timestamp when this change was created (milliseconds since Unix epoch).
   */
  changeCreatedAt: number;
  
  /**
   * The public signing key of the user who created this change (Ed25519, PEM format).
   */
  changeCreatedByPublicKey: string;
}
```

### Example Usage

```typescript
const doc = await db.createDocument();
const docId = doc.getId();

// Make multiple modifications
for (let i = 1; i <= 5; i++) {
  await db.changeDoc(doc, (d) => {
    d.getData().version = i;
    d.getData().data = `change-${i}`;
  });
}

// Traverse complete history
const history: MindooDoc[] = [];
for await (const { doc, changeCreatedAt, changeCreatedByPublicKey } of db.iterateDocumentHistory(docId)) {
  console.log(`Document at ${new Date(changeCreatedAt)}:`, doc.getData());
  console.log(`Changed by: ${changeCreatedByPublicKey}`);
  
  // Store in array - each document is independent
  history.push(doc);
}

// Access any historical version
console.log("First version:", history[0].getData());
console.log("Latest version:", history[history.length - 1].getData());
```

### Independent Document Clones

Each yielded document is an independent clone, safe to store in arrays or modify without affecting other versions:

```typescript
const doc = await db.createDocument();
const docId = doc.getId();

await db.changeDoc(doc, (d) => {
  d.getData().value = 1;
});

await db.changeDoc(doc, (d) => {
  d.getData().value = 2;
});

// Collect all history versions
const versions: MindooDoc[] = [];
for await (const { doc: histDoc } of db.iterateDocumentHistory(docId)) {
  versions.push(histDoc);
}

// Modify one version without affecting others
versions[0].getData().test = "modified";
console.log(versions[1].getData().test); // undefined

// Verify values are correct
console.log(versions[versions.length - 2].getData().value); // 1
console.log(versions[versions.length - 1].getData().value); // 2
```

### Change Metadata

Each yielded result includes metadata about the change:

```typescript
for await (const result of db.iterateDocumentHistory(docId)) {
  const { doc, changeCreatedAt, changeCreatedByPublicKey } = result;
  
  console.log(`Change timestamp: ${new Date(changeCreatedAt).toISOString()}`);
  console.log(`Changed by public key: ${changeCreatedByPublicKey}`);
  console.log(`Document state:`, doc.getData());
}
```

### Handling Deleted Documents

When a document is deleted, `iterateDocumentHistory()` includes the deletion entry in the history:

```typescript
const doc = await db.createDocument();
const docId = doc.getId();

await db.changeDoc(doc, (d) => {
  d.getData().status = "active";
});

await db.deleteDocument(docId);

// History includes deletion
const history: MindooDoc[] = [];
for await (const { doc: histDoc } of db.iterateDocumentHistory(docId)) {
  history.push(histDoc);
}

// Last entry is the deleted state
const lastEntry = history[history.length - 1];
console.log(lastEntry.isDeleted()); // true

// Second to last is the active state before deletion
const beforeDelete = history[history.length - 2];
console.log(beforeDelete.getData().status); // "active"
console.log(beforeDelete.isDeleted()); // false
```

## getAllDocumentIdsAtTimestamp()

Get all document IDs that existed at a specific point in time. This method efficiently queries the content-addressed store to find documents that existed at the given timestamp without loading document content.

### Method Signature

```typescript
getAllDocumentIdsAtTimestamp(timestamp: number): Promise<string[]>
```

### Parameters

- `timestamp`: The timestamp to query (milliseconds since Unix epoch)

### Returns

- `Promise<string[]>`: A list of document IDs that existed at the specified timestamp. A document is considered to exist at a timestamp if:
  - It has a `doc_create` entry with `createdAt < timestamp`
  - Either it has no `doc_delete` entry, or its `doc_delete` entry has `createdAt > timestamp`

### Example Usage

```typescript
// Create multiple documents at different times
const doc1 = await db.createDocument();
const doc1Id = doc1.getId();
const time1 = Date.now();

await new Promise(resolve => setTimeout(resolve, 10));

const doc2 = await db.createDocument();
const doc2Id = doc2.getId();
const time2 = Date.now();

await new Promise(resolve => setTimeout(resolve, 10));

const doc3 = await db.createDocument();
const doc3Id = doc3.getId();
const time3 = Date.now();

// At time1, only doc1 should exist
const idsAtTime1 = await db.getAllDocumentIdsAtTimestamp(time1);
console.log(idsAtTime1); // [doc1Id]

// At time2, doc1 and doc2 should exist
const idsAtTime2 = await db.getAllDocumentIdsAtTimestamp(time2);
console.log(idsAtTime2); // [doc1Id, doc2Id]

// At time3, all three should exist
const idsAtTime3 = await db.getAllDocumentIdsAtTimestamp(time3);
console.log(idsAtTime3); // [doc1Id, doc2Id, doc3Id]
```

### Handling Deleted Documents

Deleted documents are excluded from the result:

```typescript
const doc1 = await db.createDocument();
const doc1Id = doc1.getId();
const createTime = Date.now();

await new Promise(resolve => setTimeout(resolve, 10));

await db.deleteDocument(doc1Id);
const deleteTime = Date.now();

// Before deletion, document exists
const idsBeforeDelete = await db.getAllDocumentIdsAtTimestamp(createTime + 5);
console.log(idsBeforeDelete); // [doc1Id]

// At or after deletion time, document does not exist
const idsAtDelete = await db.getAllDocumentIdsAtTimestamp(deleteTime);
console.log(idsAtDelete); // []

const idsAfterDelete = await db.getAllDocumentIdsAtTimestamp(deleteTime + 1000);
console.log(idsAfterDelete); // []
```

### Performance

This method is optimized for efficiency:

- **Server-side filtering**: For network stores, filtering happens on the server, reducing data transfer
- **No document loading**: Only queries metadata, avoiding the cost of loading document content
- **Parallel queries**: Uses parallel queries for `doc_create` and `doc_delete` entries
- **Efficient for large stores**: Scales well even with many documents

### Use Cases

**Find all documents that existed at a specific time**:

```typescript
// Get all document IDs that existed at a specific timestamp
const timestamp = new Date("2024-01-01").getTime();
const docIds = await db.getAllDocumentIdsAtTimestamp(timestamp);

// Load the documents if needed
const docs = await Promise.all(
  docIds.map(id => db.getDocumentAtTimestamp(id, timestamp))
);
```

**Compare document sets at different times**:

```typescript
const time1 = new Date("2024-01-01").getTime();
const time2 = new Date("2024-06-01").getTime();

const idsAtTime1 = await db.getAllDocumentIdsAtTimestamp(time1);
const idsAtTime2 = await db.getAllDocumentIdsAtTimestamp(time2);

// Find documents created between time1 and time2
const createdBetween = idsAtTime2.filter(id => !idsAtTime1.includes(id));

// Find documents deleted between time1 and time2
const deletedBetween = idsAtTime1.filter(id => !idsAtTime2.includes(id));
```

## Use Cases

### Audit Trails

Track who made what changes and when:

```typescript
const auditLog: Array<{
  timestamp: Date;
  author: string;
  changes: any;
}> = [];

for await (const { doc, changeCreatedAt, changeCreatedByPublicKey } of db.iterateDocumentHistory(docId)) {
  auditLog.push({
    timestamp: new Date(changeCreatedAt),
    author: changeCreatedByPublicKey,
    changes: doc.getData(),
  });
}
```

### Document Version Comparison

Compare different versions of a document:

```typescript
const versions: MindooDoc[] = [];
for await (const { doc } of db.iterateDocumentHistory(docId)) {
  versions.push(doc);
}

// Compare first and last versions
const firstVersion = versions[0].getData();
const lastVersion = versions[versions.length - 1].getData();

console.log("Changes:", diff(firstVersion, lastVersion));
```

### Time-Based Queries

Find documents that existed at a specific time:

**Option 1: Using getAllDocumentIdsAtTimestamp() (Recommended)**:

```typescript
async function findDocumentsAtTime(db: MindooDB, timestamp: number): Promise<MindooDoc[]> {
  // Efficiently get all document IDs that existed at the timestamp
  const docIds = await db.getAllDocumentIdsAtTimestamp(timestamp);
  
  // Load the documents
  const docs = await Promise.all(
    docIds.map(id => db.getDocumentAtTimestamp(id, timestamp))
  );
  
  return docs.filter(doc => doc !== null) as MindooDoc[];
}
```

**Option 2: Manual iteration (for comparison)**:

```typescript
async function findDocumentsAtTime(db: MindooDB, timestamp: number): Promise<MindooDoc[]> {
  const allDocIds = await db.getAllDocumentIds();
  const docsAtTime: MindooDoc[] = [];
  
  for (const docId of allDocIds) {
    const doc = await db.getDocumentAtTimestamp(docId, timestamp);
    if (doc !== null) {
      docsAtTime.push(doc);
    }
  }
  
  return docsAtTime;
}
```

The first option is more efficient, especially for network stores, as it filters at the store level before loading documents.

### Undo/Redo Functionality

Build undo/redo by storing history:

```typescript
class DocumentEditor {
  private history: MindooDoc[] = [];
  private currentIndex = -1;
  
  async loadHistory(docId: string) {
    this.history = [];
    for await (const { doc } of db.iterateDocumentHistory(docId)) {
      this.history.push(doc);
    }
    this.currentIndex = this.history.length - 1;
  }
  
  undo(): MindooDoc | null {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.history[this.currentIndex];
    }
    return null;
  }
  
  redo(): MindooDoc | null {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      return this.history[this.currentIndex];
    }
    return null;
  }
}
```

## Performance Considerations

### getDocumentAtTimestamp()

- **Efficiency**: Loads and applies all changes up to the timestamp
- **Caching**: Uses the same document cache as regular `getDocument()` calls
- **Optimization**: Consider using snapshots for frequently accessed historical points

### iterateDocumentHistory()

- **Memory**: Each yielded document is cloned, so storing many versions in memory can be memory-intensive
- **Efficiency**: Only yields when document actually changes (checks Automerge heads)
- **Early Termination**: You can break out of the loop early if you only need recent history. Since documents are yielded from oldest to newest, you can:

**Option 1: Keep only the most recent versions** (requires processing all history):
```typescript
const recentHistory: MindooDoc[] = [];
for await (const { doc, changeCreatedAt } of db.iterateDocumentHistory(docId)) {
  recentHistory.push(doc);
  
  // Only keep last 10 versions
  if (recentHistory.length > 10) {
    recentHistory.shift();
  }
}
```

**Option 2: Stop after finding what you need** (more efficient):
```typescript
// Find the first version that matches a condition
let targetVersion: MindooDoc | null = null;
for await (const { doc, changeCreatedAt } of db.iterateDocumentHistory(docId)) {
  if (doc.getData().status === "published") {
    targetVersion = doc;
    break; // Stop after finding the first match
  }
}
```

**Note**: Since documents are yielded from oldest to newest, if you need the latest version, you'll need to process all history or collect them and take the last one.

## Implementation Details

### Change Detection

`iterateDocumentHistory()` only yields when the document actually changes. It compares Automerge document heads before and after applying each change:

- **First entry (doc_create)**: Always yielded (initial creation)
- **Delete entries**: Always yielded (deletion state)
- **Other entries**: Only yielded if Automerge heads changed

This prevents yielding duplicate document states when a change doesn't modify the document (e.g., setting a value to the same value it already has).

### Document Cloning

Each yielded document is cloned using `Automerge.clone()` to ensure independence. This allows you to:

- Store multiple versions in arrays
- Modify one version without affecting others
- Keep historical snapshots in memory

### Entry Types

History traversal includes:
- `doc_create`: Document creation (first entry)
- `doc_change`: Document modifications
- `doc_delete`: Document deletion

History traversal excludes:
- `doc_snapshot`: Performance snapshots (not part of change history)

## Relationship to Other Features

### Sync

Time travel works seamlessly with MindooDB's sync functionality. Historical versions are preserved across sync operations, allowing you to query document history even after syncing with remote stores.

### Caching

The document cache used by `getDocument()` is also used by `getDocumentAtTimestamp()`, improving performance for recently accessed documents.

### Virtual Views

You can build virtual views that track document history by using `iterateDocumentHistory()` to process historical changes and maintain indexes of past states.

## Best Practices

1. **Use timestamps consistently**: Store timestamps in your documents if you need to query by application-level time
2. **Limit history storage**: Don't store all history versions in memory if you have many documents
3. **Early termination**: Use `break` to exit `iterateDocumentHistory()` early when you've found what you need
4. **Cache frequently accessed timestamps**: If you frequently access the same historical timestamp, consider caching the result
5. **Handle null results**: Always check for `null` when using `getDocumentAtTimestamp()` as documents may not exist at that time

## Summary

Time travel functionality in MindooDB provides powerful capabilities for:

- **Historical analysis**: Understand how documents evolved
- **Audit trails**: Track who made changes and when
- **Version comparison**: Compare different document states
- **Time-based queries**: Find documents that existed at specific times
- **Undo/redo**: Build undo/redo functionality

Both `getDocumentAtTimestamp()` and `iterateDocumentHistory()` work with MindooDB's append-only storage architecture, ensuring complete historical accuracy while maintaining excellent performance characteristics.
