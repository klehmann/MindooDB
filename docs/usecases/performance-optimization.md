# Performance Optimization

## Overview

Optimizing MindooDB performance requires understanding when to split databases, how to optimize sync operations, and strategies for managing storage growth. This document explores performance optimization patterns and best practices.

## When to Split Databases

### Performance Thresholds

**Indicators for splitting:**
- Database size exceeds threshold (e.g., 10GB, 100GB)
- Document count exceeds limit (e.g., 1M, 10M documents)
- Query performance degrades
- Sync operations become slow
- Memory usage is high

### Decision Framework

```typescript
class DatabaseSplitter {
  async shouldSplit(db: MindooDB): Promise<boolean> {
    const stats = await this.getDatabaseStats(db);
    
    // Check size threshold
    if (stats.size > 10 * 1024 * 1024 * 1024) { // 10GB
      return true;
    }
    
    // Check document count
    if (stats.documentCount > 1000000) { // 1M documents
      return true;
    }
    
    // Check performance metrics
    if (stats.avgQueryTime > 1000) { // 1 second
      return true;
    }
    
    return false;
  }
  
  async getDatabaseStats(db: MindooDB): Promise<any> {
    const docs = await db.getAllDocuments();
    return {
      documentCount: docs.length,
      size: await this.estimateSize(db),
      avgQueryTime: await this.measureQueryTime(db)
    };
  }
}
```

## Sharding Strategies

### Time-Based Sharding

**Pattern**: Split by time periods

```typescript
class TimeBasedSharding {
  async getDatabaseForDate(date: Date, baseName: string): Promise<MindooDB> {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const dbId = `${baseName}-${year}${month}`;
    return await this.tenant.openDB(dbId);
  }
  
  async createDocument(data: any, baseName: string): Promise<MindooDoc> {
    const db = await this.getDatabaseForDate(new Date(), baseName);
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc;
  }
}
```

**Benefits:**
- Natural archival boundaries
- Efficient time-range queries
- Manageable database sizes
- Clear retention policies

### Category-Based Sharding

**Pattern**: Split by document category

```typescript
class CategoryBasedSharding {
  async getDatabaseForCategory(category: string): Promise<MindooDB> {
    const dbId = `category-${category}`;
    return await this.tenant.openDB(dbId);
  }
  
  async createDocument(data: any, category: string): Promise<MindooDoc> {
    const db = await this.getDatabaseForCategory(category);
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().category = category;
    });
    return doc;
  }
}
```

## Sync Optimization

### Incremental Sync

**Pattern**: Only sync new changes

```typescript
class OptimizedSync {
  async syncIncremental(
    sourceDB: MindooDB,
    targetStore: AppendOnlyStore,
    lastSyncState: SyncState
  ): Promise<SyncState> {
    // Get only new changes
    const targetHashes = await targetStore.getAllChangeHashes();
    const sourceStore = sourceDB.getStore();
    const newHashes = await sourceStore.findNewChanges(targetHashes);
    
    if (newHashes.length === 0) {
      return lastSyncState; // No new changes
    }
    
    // Get changes in batches
    const batchSize = 100;
    for (let i = 0; i < newHashes.length; i += batchSize) {
      const batch = newHashes.slice(i, i + batchSize);
      const changes = await sourceStore.getChanges(batch);
      
      for (const change of changes) {
        await targetStore.append(change);
      }
    }
    
    return this.updateSyncState(lastSyncState);
  }
}
```

### Batch Operations

**Pattern**: Batch multiple operations

```typescript
class BatchOperations {
  async batchCreateDocuments(
    db: MindooDB,
    items: any[],
    batchSize: number = 100
  ): Promise<MindooDoc[]> {
    const results: MindooDoc[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(item => this.createDocument(db, item))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
  
  private async createDocument(db: MindooDB, item: any): Promise<MindooDoc> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), item);
    });
    return doc;
  }
}
```

## Storage Management

### Handling Append-Only Growth

**Pattern**: Archive old data

```typescript
class StorageManagement {
  async archiveOldData(
    db: MindooDB,
    archiveDate: Date,
    archiveDB: MindooDB
  ) {
    const allDocs = await db.getAllDocuments();
    const oldDocs = allDocs.filter(doc => 
      doc.getData().createdAt < archiveDate.getTime()
    );
    
    // Copy to archive
    for (const doc of oldDocs) {
      const changeHashes = await db.getStore()
        .getAllChangeHashesForDoc(doc.getId());
      const changes = await db.getStore()
        .getChanges(changeHashes);
      
      for (const change of changes) {
        await archiveDB.getStore().append(change);
      }
    }
  }
}
```

### Snapshot Optimization

**Pattern**: Use Automerge snapshots

MindooDB automatically generates snapshots:
- Reduces change replay
- Faster document loading
- Less storage for old changes
- Still maintains complete history

## Indexing Strategies

### Using VirtualView

**Pattern**: Create views for common queries

```typescript
class ViewBasedIndexing {
  async createIndexedView(db: MindooDB): Promise<VirtualView> {
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("status")
      .addSortedColumn("createdAt", ColumnSorting.DESCENDING)
      .addDisplayColumn("name")
      .withDB("main", db)
      .buildAndUpdate();
    
    return view;
  }
  
  async queryByStatus(status: string, view: VirtualView): Promise<MindooDoc[]> {
    const nav = VirtualViewFactory.createNavigator(view)
      .fromCategory(status)
      .build();
    
    const results: MindooDoc[] = [];
    for await (const entry of nav.entriesForward()) {
      if (entry.isDocument()) {
        // Get document from view
        const doc = await this.getDocument(entry.docId);
        results.push(doc);
      }
    }
    
    return results;
  }
}
```

### Custom Indexes

**Pattern**: Build custom indexes using processChangesSince

```typescript
class CustomIndex {
  private index: Map<string, string[]> = new Map();
  
  async buildIndex(db: MindooDB) {
    let cursor: ProcessChangesCursor | null = null;
    
    cursor = await db.processChangesSince(
      cursor,
      100,
      async (doc, currentCursor) => {
        // Index by status
        const status = doc.getData().status;
        if (!this.index.has(status)) {
          this.index.set(status, []);
        }
        this.index.get(status)!.push(doc.getId());
        
        return currentCursor;
      }
    );
  }
  
  async queryByStatus(status: string): Promise<string[]> {
    return this.index.get(status) || [];
  }
}
```

## Caching Patterns

### Local Caching

**Pattern**: Cache frequently accessed data

```typescript
class LocalCache {
  private cache: Map<string, { data: any, timestamp: number }> = new Map();
  private ttl: number = 5 * 60 * 1000; // 5 minutes
  
  async getCached(key: string, fetcher: () => Promise<any>): Promise<any> {
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data;
    }
    
    const data = await fetcher();
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    return data;
  }
  
  invalidate(key: string) {
    this.cache.delete(key);
  }
}
```

## Load Balancing

### Multi-Server Deployment

**Pattern**: Distribute load across servers

```typescript
class LoadBalancedDeployment {
  private servers: AppendOnlyStore[] = [];
  
  async getServerForWrite(): Promise<AppendOnlyStore> {
    // Round-robin or least-loaded
    return this.servers[this.getNextServerIndex()];
  }
  
  async replicateToAll(change: MindooDocChange) {
    // Write to primary
    const primary = await this.getServerForWrite();
    await primary.append(change);
    
    // Replicate to all servers
    const replicationPromises = this.servers.map(server => 
      server.append(change).catch(error => {
        console.error("Replication failed:", error);
      })
    );
    
    await Promise.all(replicationPromises);
  }
}
```

## Best Practices

### 1. Monitor Performance

- Track database sizes
- Monitor query performance
- Measure sync times
- Watch memory usage

### 2. Optimize Queries

- Use VirtualView for common queries
- Build custom indexes
- Filter at data provider level
- Cache frequently accessed data

### 3. Manage Storage

- Archive old data
- Use time-based sharding
- Implement retention policies
- Monitor storage growth

### 4. Optimize Sync

- Use incremental sync
- Batch operations
- Schedule sync appropriately
- Handle errors gracefully

## Related Patterns

- **[Data Modeling Patterns](data-modeling-patterns.md)** - Sharding strategies
- **[Sync Patterns](sync-patterns.md)** - Sync optimization
- **[Virtual Views Patterns](virtual-views-patterns.md)** - View-based indexing

## Conclusion

Performance optimization in MindooDB requires:

1. **Monitoring** performance metrics
2. **Splitting databases** when thresholds are reached
3. **Optimizing sync** with incremental operations
4. **Managing storage** through archiving
5. **Using indexes** for common queries

By following these patterns, you can build high-performance MindooDB applications that scale efficiently.
