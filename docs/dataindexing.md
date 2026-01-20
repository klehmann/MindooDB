# Data Indexing and Querying Strategies for MindooDB

## Overview

MindooDB provides an incremental change processing mechanism via `iterateChangesSince()` that enables efficient scanning of documents that have changed since a given cursor. This document explores various strategies for building dynamic indexes and query systems on top of MindooDB, inspired by proven approaches from other database systems.

## The Foundation: `iterateChangesSince()`

MindooDB maintains an internal index that tracks documents sorted by `(lastModified, docId)`, enabling efficient incremental processing. The `iterateChangesSince()` method (preferred) or `processChangesSince()` method:

- Accepts a cursor `{ lastModified: number, docId: string }` to resume from a specific position
- Processes documents in modification order (oldest first)
- Supports pagination via a `limit` parameter
- Returns the cursor of the last processed document for continuation
- Handles deleted documents (they remain in the index but are skipped during processing)

This mechanism provides the foundation for building persistent indexes that can be incrementally updated as documents change, without requiring full database scans.

## Indexing Approaches

### 1. Map/Reduce (CouchDB-inspired)

**Concept:**
CouchDB uses JavaScript map/reduce functions to build views (indexes) that extract and compute values from documents. The map function emits key-value pairs, and reduce functions aggregate results.

**Application to MindooDB:**
- **Map Function**: User-defined function that takes a `MindooDoc` and emits `(key, value)` pairs
- **Reduce Function** (optional): Aggregates values for the same key (e.g., count, sum, average)
- **Incremental Updates**: Use `iterateChangesSince()` to process only changed documents since last index update
- **Persistent Index**: Store the emitted key-value pairs in a separate index structure

**Example Use Case:**
```typescript
// Map function: Extract category and date from documents
function mapFunction(doc: MindooDoc) {
  const data = doc.getData();
  if (data.category && data.createdAt) {
    emit([data.category, data.createdAt], {
      docId: doc.getId(),
      title: data.title,
      lastModified: doc.getLastModified()
    });
  }
}

// Reduce function: Count documents per category
function reduceFunction(keys, values) {
  return values.length;
}
```

**Benefits:**
- Flexible: Users define what to index via map functions
- Incremental: Only changed documents need reprocessing
- Proven pattern: Widely understood from CouchDB
- Supports complex queries: Multiple keys, ranges, aggregations

**Incremental Update Mechanism:**

The key to efficient incremental map/reduce is **caching map outputs** in the index. Here's how it works:

1. **Store Map Outputs**: For each document, store the key-value pairs emitted by the map function
   - Index structure: `Map<docId, Array<{key, value}>>` - tracks what each document emitted
   - View index: `Map<key, Array<{docId, value}>>` - organizes by emitted keys

2. **Document Updates**: When a document changes via `iterateChangesSince()`:
   - **Remove old entries**: Look up cached map outputs for the document, remove those key-value pairs from the view index
   - **Add new entries**: Run map function on the updated document, add new key-value pairs to the view index
   - **Update cache**: Replace cached map outputs with new ones
   - **Incremental reduce**: Update reduce results by subtracting old values and adding new values

3. **Document Deletions**: When a document is deleted:
   - **Remove entries**: Look up cached map outputs, remove all key-value pairs from the view index
   - **Clear cache**: Remove document from the map output cache
   - **Incremental reduce**: Subtract deleted document's contributions from reduce results

**Example Implementation:**

```typescript
class MapReduceView {
  // Cache of map outputs per document
  private mapOutputs: Map<string, Array<{key: any, value: any}>> = new Map();
  
  // View index: organized by emitted keys
  private viewIndex: Map<string, Array<{docId: string, value: any}>> = new Map();
  
  // Reduce cache: pre-computed reduce results per key
  private reduceCache: Map<string, any> = new Map();
  
  async updateDocument(doc: MindooDoc) {
    const docId = doc.getId();
    
    // Get old map outputs (if document existed before)
    const oldOutputs = this.mapOutputs.get(docId) || [];
    
    // Compute new map outputs
    const newOutputs = this.mapFunction(doc);
    
    // Remove old entries from view index
    for (const {key, value} of oldOutputs) {
      this.removeFromViewIndex(key, docId);
      this.updateReduce(key, value, 'subtract');
    }
    
    // Add new entries to view index
    for (const {key, value} of newOutputs) {
      this.addToViewIndex(key, docId, value);
      this.updateReduce(key, value, 'add');
    }
    
    // Update cache
    this.mapOutputs.set(docId, newOutputs);
  }
  
  async deleteDocument(docId: string) {
    const oldOutputs = this.mapOutputs.get(docId);
    if (!oldOutputs) return;
    
    // Remove all entries
    for (const {key, value} of oldOutputs) {
      this.removeFromViewIndex(key, docId);
      this.updateReduce(key, value, 'subtract');
    }
    
    // Clear cache
    this.mapOutputs.delete(docId);
  }
  
  private updateReduce(key: any, value: any, operation: 'add' | 'subtract') {
    const currentValues = this.viewIndex.get(key) || [];
    const newReduceResult = this.reduceFunction(key, currentValues);
    this.reduceCache.set(key, newReduceResult);
  }
}
```

**Reduce Function Requirements:**

**Critical Limitation: NOT all reduce functions work incrementally!**

For incremental updates to work correctly, reduce functions must be:
- **Associative**: `reduce(a, reduce(b, c)) === reduce(reduce(a, b), c)` - order of grouping doesn't matter
- **Commutative**: `reduce(a, b) === reduce(b, a)` - order of operands doesn't matter

This allows partial reductions to be combined in any order, which is essential for incremental updates where we subtract old values and add new values.

**Reduce Functions That Work Incrementally:**

✅ **Count**: `(keys, values) => values.length`
```typescript
// Incremental: count = oldCount - removedCount + newCount
```

✅ **Sum**: `(keys, values) => values.reduce((a, b) => a + b, 0)`
```typescript
// Incremental: sum = oldSum - removedSum + newSum
```

✅ **Min/Max**: `(keys, values) => Math.min(...values)` or `Math.max(...values)`
```typescript
// Incremental: Need to track all values or recompute, but can be done
// More efficient: Store sorted list and update incrementally
```

✅ **Average** (with count): Store both sum and count, compute average on query
```typescript
// Incremental: sum and count updated separately, average computed on-demand
reduce: (keys, values) => ({ sum: values.reduce((a, b) => a + b, 0), count: values.length })
query: (result) => result.sum / result.count
```

✅ **Set Union**: `(keys, values) => [...new Set(values.flat())]`
```typescript
// Incremental: Can add/remove individual values
```

✅ **Boolean OR/AND**: `(keys, values) => values.some(v => v)` or `values.every(v => v)`
```typescript
// Incremental: Can update based on individual value changes
```

**Reduce Functions That DON'T Work Incrementally:**

❌ **Last Value**: `(keys, values) => values[values.length - 1]`
```typescript
// Problem: Order-dependent, not commutative
// If we remove a value, we don't know which was "last" without full recomputation
```

❌ **Median**: `(keys, values) => { const sorted = values.sort(); return sorted[Math.floor(sorted.length/2)]; }`
```typescript
// Problem: Requires all values to compute, can't incrementally update
// Workaround: Store all values, recompute median on query (defeats purpose)
```

❌ **Standard Deviation**: Requires mean and all values
```typescript
// Problem: Can't compute incrementally without storing all values
// Workaround: Store all values, recompute on query
```

❌ **Percentiles**: Requires sorted list of all values
```typescript
// Problem: Order-dependent, requires full value set
```

❌ **Distinct Count with Details**: `(keys, values) => ({ count: new Set(values).size, items: [...new Set(values)] })`
```typescript
// Problem: While count is incremental, maintaining the full list of distinct items
// requires tracking all values, which defeats incremental benefits
```

**Why Some Functions Don't Work:**

The fundamental issue is that incremental updates require:
1. **Subtracting old contributions**: When a document changes, we need to remove its old map outputs
2. **Adding new contributions**: Then add the new map outputs

For functions like "last value" or "median", removing a value changes the result in ways that can't be computed without knowing all remaining values. The result isn't just `oldResult - removedValue + newValue`; it depends on the entire set.

**Workarounds for Non-Incremental Reduce Functions:**

1. **Store All Values**: Keep all values in the reduce result, recompute on query
   ```typescript
   reduce: (keys, values) => values  // Store all values
   query: (result) => computeMedian(result)  // Recompute on query
   ```
   - ✅ Works for any function
   - ❌ Defeats storage benefits of reduction
   - ❌ Slower queries (full recomputation)

2. **Approximate Algorithms**: Use algorithms that can be updated incrementally
   - **Approximate Median**: Use streaming algorithms (e.g., T-Digest)
   - **Approximate Percentiles**: Use quantile sketches
   - ✅ Incremental updates possible
   - ❌ Approximate results (may be acceptable)

3. **Hybrid Approach**: Cache map outputs, but recompute reduce on query
   - Still get efficient updates/deletions (via cached map outputs)
   - Accept slower queries (recompute reduce)
   - ✅ Works for any reduce function
   - ❌ Slower queries

4. **Periodic Full Rebuild**: For complex reduce functions, periodically rebuild
   - Incremental updates for simple cases
   - Full rebuild during maintenance window
   - ✅ Works for any function
   - ❌ Not real-time

**Recommendation for MindooDB:**

- **Support incremental reduce** for associative/commutative functions (count, sum, min, max, average)
- **Support "store all values" mode** for complex functions (median, percentiles) with clear documentation that queries will be slower
- **Provide approximate algorithms** where possible (e.g., approximate percentiles)
- **Allow users to choose** between incremental (fast queries) and recompute-on-query (works for any function)

**Alternative: Recompute Reduce On-The-Fly**

Instead of caching reduce results, you could:
- Cache only map outputs
- Recompute reduce results when queried by aggregating all values for a key

This trades query performance (slower queries) for update performance (faster updates) and storage (less storage). For most use cases, caching reduce results is preferred.

**Challenges:**
- Need to handle document deletions (remove from index) - **solved by caching map outputs**
- Map functions must be deterministic - required for consistency
- Reduce functions need to be associative and commutative - required for incremental updates
- Index storage and querying infrastructure required
- Storage overhead for caching map outputs and reduce results

**CouchDB's Implementation (Reference):**

CouchDB's incremental map/reduce is well-documented and provides a proven reference implementation:

**Key Documentation:**
- **[CouchDB Guide: Views](https://guide.couchdb.org/editions/1/en/views.html)**: Comprehensive guide to how views work
- **[CouchDB Documentation: Design Documents](https://docs.couchdb.org/en/stable/ddocs/ddocs.html)**: Official documentation on views and reduce functions
- **[CouchDB Performance Guide](https://docs.couchdb.org/en/stable/maintenance/performance.html)**: Performance considerations for views

**How CouchDB Does It:**

1. **B-Tree Index Structure**: CouchDB stores view indexes as B-trees where:
   - **Leaf nodes**: Contain the actual map outputs (key-value pairs)
   - **Internal nodes**: Contain pre-computed reduce values
   - Each node stores reduce results, enabling efficient incremental updates

2. **Document Revision Tracking**: CouchDB tracks document revisions (sequence numbers) to identify:
   - Which documents have changed since last view update
   - Which map outputs need to be removed (old document state)
   - Which map outputs need to be added (new document state)

3. **Incremental Update Process**:
   - When a document changes, CouchDB:
     1. Identifies the affected keys in the B-tree (from old map outputs)
     2. Removes old map outputs from leaf nodes
     3. Adds new map outputs to leaf nodes
     4. Recalculates reduce values only for affected internal nodes (bottom-up)
     5. Updates the B-tree structure as needed

4. **Reduce Function Requirements**: CouchDB requires reduce functions to be:
   - **Associative**: `reduce(a, reduce(b, c)) === reduce(reduce(a, b), c)`
   - **Commutative**: `reduce(a, b) === reduce(b, a)`
   - This allows partial reductions to be combined in any order

5. **Built-in Reduce Functions**: CouchDB provides optimized built-in reduce functions:
   - `_count`: Count documents
   - `_sum`: Sum numeric values
   - `_stats`: Statistical aggregations (min, max, sum, count)
   - These are implemented in Erlang (not JavaScript) for better performance

**Key Insight from CouchDB:**

CouchDB doesn't explicitly "cache" map outputs in a separate structure. Instead, the **B-tree index itself serves as the cache**:
- Map outputs are stored in leaf nodes of the B-tree
- The B-tree is organized by emitted keys
- Document IDs are stored alongside map outputs, allowing efficient lookup
- When a document changes, CouchDB can find and remove old entries by traversing the B-tree

**For MindooDB Implementation:**

We can learn from CouchDB's approach:
- **Use B-tree or similar structure** for the view index (organized by keys)
- **Store document ID with map outputs** to enable efficient removal
- **Track document sequence numbers** (or use `processChangesSince()` cursors) to identify changes
- **Pre-compute reduce values** in internal nodes for fast queries
- **Require associative/commutative reduce functions** for incremental updates

**Open Source Options:**
- **PouchDB**: Client-side CouchDB implementation with map/reduce views - uses this incremental approach
  - PouchDB's source code is a good reference: [GitHub - pouchdb/pouchdb](https://github.com/pouchdb/pouchdb)
  - Look at the `mapreduce` module for view implementation details
- **CouchDB Source Code**: [GitHub - apache/couchdb](https://github.com/apache/couchdb)
  - The view index implementation is in Erlang
  - Can study the B-tree structure and update algorithms
- **Hoodie**: Uses PouchDB, could provide inspiration for view management
- **Custom Implementation**: Build a lightweight map/reduce engine tailored to MindooDB, inspired by CouchDB's approach

### 2. Categorized Views (Notes/Domino-inspired) - VirtualView ✅ IMPLEMENTED

> **📚 See [VirtualView Documentation](./virtualview.md) for comprehensive documentation, API reference, and examples.**

**Concept:**
Lotus Notes/Domino uses categorized views that group documents into hierarchical categories based on field values. Categories can be nested, and documents appear under their category paths.

**Implementation:**
MindooDB includes a full **VirtualView** implementation, inspired by and adapted from **Karsten Lehmann's Domino JNA project** ([klehmann/domino-jna](https://github.com/klehmann/domino-jna)). This provides:

- **VirtualViewColumn**: Define columns for categorization, sorting, display, and totals
- **VirtualViewEntryData**: Tree nodes representing categories or documents
- **VirtualViewNavigator**: Hierarchical navigation with expand/collapse and selection
- **MindooDBVirtualViewDataProvider**: Incremental updates via `processChangesSince()`
- **Multi-Database Views**: Combine documents from multiple MindooDB instances
- **Multi-Tenant Views**: Span views across different MindooTenants
- **Category Totals**: Built-in SUM and AVERAGE aggregations

**Quick Example:**
```typescript
import { VirtualViewFactory, ColumnSorting, TotalMode } from "./indexing/virtualviews";

// Create a categorized view with totals
const view = await VirtualViewFactory.createView()
  .addCategoryColumn("department", { sorting: ColumnSorting.ASCENDING })
  .addCategoryColumn("year", { sorting: ColumnSorting.DESCENDING })
  .addSortedColumn("lastName")
  .addTotalColumn("salary", TotalMode.SUM)
  .withDB("employees", employeeDB)
  .buildAndUpdate();

// Navigate the view
const nav = VirtualViewFactory.createNavigator(view).expandAll().build();
for await (const entry of nav.entriesForward()) {
  if (entry.isCategory()) {
    console.log(`${entry.getCategoryValue()}: Total $${entry.getColumnValue("salary")}`);
  }
}
```

**Benefits:**
- ✅ **Intuitive**: Natural way to organize documents
- ✅ **Efficient**: Direct category lookups with sorted navigation
- ✅ **Hierarchical**: Supports nested categories (use backslash: `"2024\\Q1\\January"`)
- ✅ **Multi-Database**: Combine documents from multiple sources
- ✅ **Incremental**: Efficient updates via `processChangesSince()`
- ✅ **Totals**: Built-in SUM and AVERAGE for category rows

**Source:**
- `src/indexing/virtualviews/` - Full TypeScript implementation
- Inspired by [Domino JNA VirtualView](https://github.com/klehmann/domino-jna)

### 3. Full-Text Search with FlexSearch

**Concept:**
FlexSearch is a high-performance, memory-efficient full-text search library that supports incremental indexing and real-time search.

**Application to MindooDB:**
- **Index Creation**: Create FlexSearch indexes for text fields in documents
- **Incremental Updates**: Use `processChangesSince()` to add/update/remove documents from indexes
- **Multiple Indexes**: Support separate indexes for different fields or document types
- **Query Interface**: Provide search API that queries FlexSearch indexes

**Example Use Case:**
```typescript
import { Index } from "flexsearch";

// Create index for document titles and content
const searchIndex = new Index({
  tokenize: "forward",
  cache: 100
});

// Index a document
function indexDocument(doc: MindooDoc) {
  const data = doc.getData();
  searchIndex.add(doc.getId(), `${data.title} ${data.content}`);
}

// Search
const results = searchIndex.search("query text");
```

**Benefits:**
- High Performance: Fast search with low memory footprint
- Incremental: Supports add/update/delete operations
- Flexible: Configurable tokenization, stemming, etc.
- Real-time: Updates immediately queryable
- Open Source: Well-maintained library

**Challenges:**
- Need to extract text from documents (which fields to index?)
- Handling document deletions
- Multiple language support
- Index persistence (save/load indexes)

**Open Source Options:**
- **[FlexSearch](https://github.com/nextapps-de/flexsearch)**: Primary option, actively maintained
- **[MiniSearch](https://github.com/lucaong/minisearch)**: Alternative lightweight option
- **[Lunr.js](https://lunrjs.com/)**: Client-side full-text search

### 4. Field-Based Indexes (Traditional Database Approach)

**Concept:**
Create indexes on specific document fields, similar to traditional database indexes (B-tree, hash indexes, etc.).

**Application to MindooDB:**
- **Index Definition**: Define indexes on specific fields (e.g., `data.email`, `data.createdAt`)
- **Index Types**: Support different index types:
  - **B-Tree**: For sorted queries, ranges, comparisons
  - **Hash**: For exact lookups
  - **Composite**: Multiple fields (e.g., `[data.category, data.priority]`)
- **Incremental Updates**: Update indexes as documents change via `processChangesSince()`

**Example Use Case:**
```typescript
// Define indexes
const indexes = {
  email: { type: "hash", field: "email" },
  createdAt: { type: "btree", field: "createdAt" },
  categoryPriority: { type: "btree", fields: ["category", "priority"] }
};

// Query
const results = indexes.email.get("user@example.com");
const rangeResults = indexes.createdAt.range(startDate, endDate);
```

**Benefits:**
- Familiar: Well-understood indexing model
- Efficient: Optimized for specific query patterns
- Flexible: Support multiple index types
- Standard: Similar to SQL indexes

**Challenges:**
- Need to define indexes upfront
- Storage overhead for multiple indexes
- Index maintenance complexity
- Handling schema changes

**Open Source Options:**
- **[LevelDB/RocksDB](https://github.com/facebook/rocksdb)**: Key-value stores with range queries
- **[LMDB](https://symas.com/lmdb/)**: Lightning Memory-Mapped Database
- **[BTree-JS](https://github.com/qiao/btree.js)**: JavaScript B-tree implementation
- **[Sorted Set Libraries](https://www.npmjs.com/package/sorted-set)**: For sorted indexes

### 5. Materialized Views (SQL-inspired)

**Concept:**
Materialized views are pre-computed query results stored as tables/indexes that are updated when underlying data changes.

**Application to MindooDB:**
- **View Definition**: Define views as queries over documents (e.g., "all active tasks grouped by project")
- **Incremental Updates**: Use `processChangesSince()` to update views incrementally
- **Query Interface**: Query the materialized view instead of scanning all documents
- **Multiple Views**: Support multiple views for different query patterns

**Example Use Case:**
```typescript
// Define materialized view
const view = {
  name: "active-tasks-by-project",
  query: (doc: MindooDoc) => {
    const data = doc.getData();
    return data.status === "active" && data.project;
  },
  groupBy: "project",
  aggregate: {
    count: true,
    sum: "effort",
    avg: "priority"
  }
};

// Query view
const results = view.get("ProjectA"); // Returns aggregated data for ProjectA
```

**Benefits:**
- Fast Queries: Pre-computed results
- Complex Aggregations: Support sum, count, average, etc.
- Incremental: Only changed documents need reprocessing
- Flexible: Can define multiple views

**Challenges:**
- View maintenance overhead
- Storage for materialized results
- Handling deletions and updates
- View refresh strategies

**Open Source Options:**
- **Custom Implementation**: Build view engine tailored to MindooDB
- **In-Memory Aggregation Libraries**: For computing aggregations

### 6. Graph-Based Indexes

**Concept:**
If documents contain relationships (references to other documents), build graph indexes to enable efficient relationship traversal.

**Application to MindooDB:**
- **Relationship Extraction**: Extract document references from fields (e.g., `data.parentId`, `data.relatedIds`)
- **Graph Structure**: Build adjacency lists or graph databases
- **Incremental Updates**: Update graph as documents change
- **Query Interface**: Support graph queries (e.g., "find all descendants", "find shortest path")

**Example Use Case:**
```typescript
// Extract relationships
function extractRelationships(doc: MindooDoc) {
  const data = doc.getData();
  return {
    docId: doc.getId(),
    parentId: data.parentId,
    childrenIds: data.childrenIds || [],
    relatedIds: data.relatedIds || []
  };
}

// Graph queries
const descendants = graphIndex.getDescendants("doc123");
const path = graphIndex.findPath("doc1", "doc2");
```

**Benefits:**
- Relationship Queries: Efficient traversal of document relationships
- Hierarchical Data: Natural for tree structures
- Complex Queries: Support graph algorithms

**Challenges:**
- Need to identify relationships in documents
- Graph maintenance complexity
- Storage overhead
- Query language design

**Open Source Options:**
- **[Gun.js](https://gun.eco/)**: Graph database (may be overkill)
- **[Neo4j](https://neo4j.com/)**: Full graph database (server-side)
- **Custom Implementation**: Lightweight graph structures

### 7. Time-Series Indexes

**Concept:**
If documents have temporal aspects, build time-series indexes optimized for time-range queries.

**Application to MindooDB:**
- **Time Extraction**: Extract timestamps from documents (`createdAt`, `lastModified`, or custom time fields)
- **Time-Series Structure**: Use specialized data structures (e.g., time-ordered indexes, time buckets)
- **Incremental Updates**: Append new time points as documents change
- **Query Interface**: Support time-range queries, aggregations over time

**Example Use Case:**
```typescript
// Time-series index
const timeSeries = {
  field: "timestamp",
  granularity: "hour", // or "day", "month"
  aggregations: ["count", "sum", "avg"]
};

// Query
const hourlyData = timeSeries.query({
  start: startTime,
  end: endTime,
  granularity: "hour"
});
```

**Benefits:**
- Time Queries: Optimized for temporal queries
- Aggregations: Efficient time-based aggregations
- Visualization: Good for charts and analytics

**Challenges:**
- Need temporal data in documents
- Storage for time-series data
- Aggregation computation

**Open Source Options:**
- **[TimescaleDB](https://www.timescaledb.com/)**: PostgreSQL extension (server-side)
- **[InfluxDB](https://www.influxdata.com/)**: Time-series database (server-side)
- **Custom Implementation**: Lightweight time-series structures

## Hybrid Approaches

### Combining Multiple Index Types

Different indexing strategies can be combined:

1. **Full-Text + Field Indexes**: Use FlexSearch for text search, B-tree indexes for structured queries
2. **Map/Reduce + Categorized Views**: Use map/reduce to build categorized views
3. **Materialized Views + Time-Series**: Pre-compute time-based aggregations
4. **Graph + Full-Text**: Index document relationships and content

### Index Orchestration

An index manager could coordinate multiple indexes:

```typescript
class IndexManager {
  private indexes: Map<string, Index>;
  
  async processChanges(cursor: ProcessChangesCursor | null) {
    // Process changes once
    for await (const { doc, cursor: currentCursor } of db.iterateChangesSince(cursor)) {
      // Update all indexes
      for (const [name, index] of this.indexes) {
        await index.update(doc);
      }
      cursor = currentCursor;
    }
  }
}
```

## Incremental Map/Reduce: Deep Dive

### The Core Question: Cache Map Values or Recompute?

When implementing incremental map/reduce views, there are two main approaches:

**Approach 1: Cache Map Values (Recommended)**

This is how CouchDB and similar systems work:

- **Store map outputs**: For each document, cache the `(key, value)` pairs emitted by the map function
- **Index structure**: Maintain both:
  - `docId → [map outputs]` - tracks what each document emitted
  - `key → [docId, value]` - organizes by emitted keys for efficient querying
- **Incremental updates**: When a document changes:
  1. Look up cached map outputs for the document
  2. Remove old `(key, value)` pairs from the view index
  3. Run map function on updated document
  4. Add new `(key, value)` pairs to the view index
  5. Update cached map outputs
  6. Incrementally update reduce results (subtract old, add new)

**Benefits:**
- ✅ Efficient deletions: Can remove document from view without re-running map function
- ✅ Efficient updates: Only need to diff old vs new map outputs
- ✅ Fast reduce updates: Can incrementally update reduce results
- ✅ Handles document state changes: If document no longer matches map criteria, old entries are cleanly removed

**Storage Cost:**
- Stores map outputs for every document (even if document is deleted from view)
- Typically acceptable: map outputs are usually small (just keys and values)

**Approach 2: Recompute Reduce On-The-Fly**

Alternative approach that doesn't cache map outputs:

- **No map cache**: Don't store what each document emitted
- **On update**: Re-run map function on document, but don't know what it emitted before
- **Problem**: Can't efficiently remove old entries without knowing what they were
- **Solution**: Mark document as "dirty" and rebuild reduce for affected keys

**Benefits:**
- ✅ Lower storage: No map output cache
- ✅ Simpler: Less state to manage

**Drawbacks:**
- ❌ Inefficient deletions: Need to rebuild reduce for potentially many keys
- ❌ Can't efficiently remove old entries: Don't know what document emitted before
- ❌ Slower updates: May need to recompute reduce for multiple keys

**Hybrid Approach: Cache Map, Recompute Reduce**

Middle ground:

- **Cache map outputs**: Store what each document emitted
- **Don't cache reduce results**: Recompute reduce when queried

**Benefits:**
- ✅ Efficient updates/deletions: Can remove old entries using cached map outputs
- ✅ Lower storage: No reduce result cache
- ✅ Always fresh: Reduce results computed from current view state

**Drawbacks:**
- ❌ Slower queries: Reduce computed on-demand
- ❌ Still need map output cache: So storage savings are limited

### Recommended Implementation Strategy

**For MindooDB, use Approach 1 (Cache Map Values):**

1. **Cache map outputs per document**: `Map<docId, Array<{key, value}>>`
2. **Maintain view index**: `Map<key, Array<{docId, value}>>` for efficient key lookups
3. **Cache reduce results**: `Map<key, reducedValue>` for fast queries
4. **Incremental updates**: Use cached map outputs to efficiently add/remove entries

**Why this works well with `iterateChangesSince()`:**

```typescript
async function updateView(db: MindooDB, view: MapReduceView, cursor: ProcessChangesCursor | null) {
  for await (const { doc, cursor: currentCursor } of db.iterateChangesSince(cursor)) {
    cursor = currentCursor;
    
    if (doc.isDeleted()) {
      // Efficiently remove using cached map outputs
      await view.deleteDocument(doc.getId());
    } else {
      // Efficiently update using cached map outputs
      await view.updateDocument(doc);
    }
  }
}
```

The cached map outputs enable efficient incremental updates because:
- We know exactly what to remove (old map outputs)
- We know exactly what to add (new map outputs)
- We can incrementally update reduce results (subtract old, add new)
- No need to scan or recompute anything

## Implementation Considerations

### Index Persistence

Indexes need to be persisted to survive restarts:

- **File-Based**: Save indexes to disk (JSON, binary formats)
- **Database-Backed**: Store indexes in a separate database (LevelDB, SQLite)
- **Incremental Save**: Save only changes, not full index
- **Checkpointing**: Periodic full saves for recovery

### Index Versioning

When document schemas or index definitions change:

- **Version Indexes**: Track index versions
- **Migration**: Support index migration/rebuild
- **Backward Compatibility**: Handle old index formats

### Performance Optimization

- **Batch Updates**: Process multiple documents before updating indexes
- **Lazy Indexing**: Defer index updates for non-critical indexes
- **Index Partitioning**: Split large indexes into smaller ones
- **Caching**: Cache frequently accessed index data

### Error Handling

- **Partial Failures**: Handle errors for individual documents without stopping entire index update
- **Recovery**: Ability to rebuild indexes from scratch if corrupted
- **Validation**: Verify index consistency

### Security Considerations

- **Encryption**: Indexes may contain sensitive data (consider encryption at rest)
- **Access Control**: Who can create/modify indexes?
- **Audit Trail**: Track index changes for compliance

## Open Source Projects to Explore

### Full-Text Search
- **[FlexSearch](https://github.com/nextapps-de/flexsearch)**: High-performance, incremental full-text search
- **[MiniSearch](https://github.com/lucaong/minisearch)**: Lightweight alternative
- **[Lunr.js](https://lunrjs.com/)**: Client-side full-text search

### Index Storage
- **[LevelDB](https://github.com/google/leveldb)**: Key-value store with range queries
- **[RocksDB](https://github.com/facebook/rocksdb)**: LevelDB fork with additional features
- **[LMDB](https://symas.com/lmdb/)**: Lightning Memory-Mapped Database
- **[SQLite](https://www.sqlite.org/)**: Embedded SQL database for index storage

### Map/Reduce
- **[PouchDB](https://pouchdb.com/)**: Client-side CouchDB with map/reduce views
- **Custom Implementation**: Lightweight map/reduce engine

### Data Structures
- **[BTree-JS](https://github.com/qiao/btree.js)**: B-tree implementation
- **[Trie Libraries](https://www.npmjs.com/package/trie-prefix-tree)**: For category hierarchies
- **[Sorted Set Libraries](https://www.npmjs.com/package/sorted-set)**: For sorted indexes

### Graph Databases
- **[Gun.js](https://gun.eco/)**: Graph database (may be overkill for simple relationships)
- **Custom Implementation**: Lightweight graph structures

## Recommended Approach

Based on the analysis, a **hybrid approach** combining multiple strategies is recommended:

1. **FlexSearch for Full-Text Search**: Primary choice for text search capabilities
2. **Map/Reduce for Flexible Indexing**: Allow users to define custom indexes via map functions
3. **Field-Based Indexes for Common Queries**: B-tree indexes for structured queries (dates, numbers, etc.)
4. **Index Manager**: Orchestrate multiple indexes, handle persistence, incremental updates

### Implementation Phases

**Phase 1: Foundation**
- Build index manager infrastructure
- Implement FlexSearch integration
- Support incremental updates via `processChangesSince()`
- Basic index persistence

**Phase 2: Map/Reduce**
- Implement map/reduce engine
- Support user-defined map functions
- Basic reduce functions (count, sum)

**Phase 3: Field Indexes**
- B-tree indexes for common field types
- Composite indexes
- Range queries

**Phase 4: Advanced Features**
- Categorized views
- Materialized views
- Graph indexes (if needed)

## Conclusion

MindooDB's `processChangesSince()` mechanism provides an excellent foundation for building dynamic, incremental indexes. The recommended approach is to:

1. Start with **FlexSearch** for full-text search (proven, incremental, performant)
2. Add **map/reduce** capabilities for flexible, user-defined indexes
3. Complement with **field-based indexes** for structured queries
4. Use an **index manager** to orchestrate multiple indexes

This hybrid approach provides the flexibility of map/reduce, the performance of specialized indexes, and the search capabilities of full-text indexing, all while leveraging MindooDB's incremental change processing.

