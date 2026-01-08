# Data Indexing and Querying Strategies for MindooDB

## Overview

MindooDB provides an incremental change processing mechanism via `processChangesSince()` that enables efficient scanning of documents that have changed since a given cursor. This document explores various strategies for building dynamic indexes and query systems on top of MindooDB, inspired by proven approaches from other database systems.

## The Foundation: `processChangesSince()`

MindooDB maintains an internal index that tracks documents sorted by `(lastModified, docId)`, enabling efficient incremental processing. The `processChangesSince()` method:

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
- **Incremental Updates**: Use `processChangesSince()` to process only changed documents since last index update
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

**Challenges:**
- Need to handle document deletions (remove from index)
- Map functions must be deterministic
- Reduce functions need to handle incremental updates correctly
- Index storage and querying infrastructure required

**Open Source Options:**
- **PouchDB**: Client-side CouchDB implementation with map/reduce views
- **Hoodie**: Uses PouchDB, could provide inspiration for view management
- **Custom Implementation**: Build a lightweight map/reduce engine tailored to MindooDB

### 2. Categorized Views (Notes/Domino-inspired)

**Concept:**
Lotus Notes/Domino uses categorized views that group documents into hierarchical categories based on field values. Categories can be nested, and documents appear under their category paths.

**Application to MindooDB:**
- **View Definition**: Define categories based on document fields (e.g., `data.category`, `data.status`, `data.priority`)
- **Category Hierarchy**: Support nested categories (e.g., `["Projects", "Active", "High Priority"]`)
- **Incremental Updates**: When a document changes, remove it from old categories and add to new ones
- **Query Interface**: Query by category path, support wildcards, range queries

**Example Use Case:**
```typescript
// View definition
const view = {
  name: "tasks-by-status",
  categories: [
    { field: "project", type: "string" },
    { field: "status", type: "string" },
    { field: "priority", type: "enum", values: ["low", "medium", "high"] }
  ]
};

// Documents are indexed as:
// "Projects/ProjectA/Active/High" -> [docId1, docId2, ...]
// "Projects/ProjectB/Completed/Medium" -> [docId3, ...]
```

**Benefits:**
- Intuitive: Natural way to organize documents
- Efficient: Direct category lookups
- Hierarchical: Supports nested organization
- Familiar: Similar to file system organization

**Challenges:**
- Category changes require moving documents between categories
- Need efficient data structures for category hierarchies
- Handling null/undefined category values
- Multi-category support (documents in multiple categories)

**Open Source Options:**
- **Custom Implementation**: Build category tree structures
- **Trie Data Structures**: For efficient category path lookups
- **B-Tree Indexes**: For sorted category traversal

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
    await db.processChangesSince(cursor, 100, async (doc, currentCursor) => {
      // Update all indexes
      for (const [name, index] of this.indexes) {
        await index.update(doc);
      }
      return currentCursor;
    });
  }
}
```

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

