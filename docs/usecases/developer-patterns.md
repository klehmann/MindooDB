# Developer Patterns

## Overview

This document covers development best practices for building applications with MindooDB, including testing strategies, error handling, monitoring, and development workflows.

## Testing Strategies

### Testing Offline Scenarios

**Pattern**: Test offline operation

```typescript
class OfflineTesting {
  async testOfflineCreation() {
    // Create DB without network store
    const localStore = new InMemoryAppendOnlyStore("test-db");
    const db = await this.createDBWithStore(localStore);
    
    // Create document offline
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().test = "offline";
    });
    
    // Verify document exists
    const retrieved = await db.getDocument(doc.getId());
    expect(retrieved.getData().test).toBe("offline");
  }
  
  async testSyncAfterOffline() {
    const localStore = new InMemoryAppendOnlyStore("test-db");
    const remoteStore = new InMemoryAppendOnlyStore("remote-db");
    
    const localDB = await this.createDBWithStore(localStore);
    const remoteDB = await this.createDBWithStore(remoteStore);
    
    // Create document offline
    const doc = await localDB.createDocument();
    await localDB.changeDoc(doc, (d) => {
      d.getData().test = "sync-test";
    });
    
    // Sync when online
    await localDB.pushChangesTo(remoteStore);
    await remoteDB.pullChangesFrom(localStore);
    
    // Verify sync
    const synced = await remoteDB.getDocument(doc.getId());
    expect(synced.getData().test).toBe("sync-test");
  }
}
```

### Testing Sync Behavior

**Pattern**: Test sync operations

```typescript
class SyncTesting {
  async testBidirectionalSync() {
    const storeA = new InMemoryAppendOnlyStore("db-a");
    const storeB = new InMemoryAppendOnlyStore("db-b");
    
    const dbA = await this.createDBWithStore(storeA);
    const dbB = await this.createDBWithStore(storeB);
    
    // Create document in A
    const docA = await dbA.createDocument();
    await dbA.changeDoc(docA, (d) => {
      d.getData().value = "from-a";
    });
    
    // Create document in B
    const docB = await dbB.createDocument();
    await dbB.changeDoc(docB, (d) => {
      d.getData().value = "from-b";
    });
    
    // Sync both ways
    await dbB.pullChangesFrom(storeA);
    await dbA.pullChangesFrom(storeB);
    
    // Verify both documents in both databases
    expect(await dbB.getDocument(docA.getId())).toBeDefined();
    expect(await dbA.getDocument(docB.getId())).toBeDefined();
  }
}
```

### Testing Access Control

**Pattern**: Test named key access

```typescript
class AccessControlTesting {
  async testNamedKeyAccess() {
    const tenant = await this.createTenant();
    const keyId = "test-key";
    
    // Create key
    const encryptedKey = await tenant.getFactory()
      .createSymmetricEncryptedPrivateKey("test-password");
    
    // Add to keybag
    const keyBag = new KeyBag();
    await keyBag.decryptAndImportKey(keyId, encryptedKey, "test-password");
    
    // Create encrypted document
    const db = await tenant.openDB("test");
    const doc = await db.createEncryptedDocument(keyId);
    await db.changeDoc(doc, (d) => {
      d.getData().secret = "test-data";
    });
    
    // Verify can decrypt
    const data = doc.getData();
    expect(data.secret).toBe("test-data");
  }
}
```

### Mocking MindooDB

**Pattern**: Mock for unit tests

```typescript
class MindooDBMock {
  private documents: Map<string, any> = new Map();
  
  async createDocument(): Promise<MockDoc> {
    const docId = this.generateId();
    const doc = new MockDoc(docId, {});
    this.documents.set(docId, doc);
    return doc;
  }
  
  async getDocument(docId: string): Promise<MockDoc> {
    return this.documents.get(docId)!;
  }
  
  async changeDoc(doc: MockDoc, changer: (data: any) => void): Promise<void> {
    changer(doc.getData());
  }
}

class MockDoc {
  constructor(
    private id: string,
    private data: any
  ) {}
  
  getId(): string {
    return this.id;
  }
  
  getData(): any {
    return this.data;
  }
}
```

## Error Handling

### Handling Sync Failures

**Pattern**: Graceful sync error handling

```typescript
class SyncErrorHandling {
  async syncWithRetry(
    db: MindooDB,
    remoteStore: AppendOnlyStore,
    maxRetries: number = 3
  ) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await db.pullChangesFrom(remoteStore);
        await db.pushChangesTo(remoteStore);
        return; // Success
      } catch (error) {
        if (attempt === maxRetries) {
          throw error; // Final attempt failed
        }
        
        // Exponential backoff
        await this.sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Handling Key Issues

**Pattern**: Handle missing or invalid keys

```typescript
class KeyErrorHandling {
  async decryptWithFallback(
    tenant: MindooTenant,
    encryptedData: Uint8Array,
    keyId: string
  ): Promise<Uint8Array> {
    try {
      return await tenant.decryptPayload(encryptedData, keyId);
    } catch (error) {
      if (error.message.includes("key not found")) {
        // Try to recover key
        await this.recoverKey(keyId);
        return await tenant.decryptPayload(encryptedData, keyId);
      }
      throw error;
    }
  }
  
  async recoverKey(keyId: string) {
    // Attempt to recover key from backup or re-distribution
    // Implementation depends on key recovery strategy
  }
}
```

## Monitoring

### Tracking Sync Status

**Pattern**: Monitor sync operations

```typescript
class SyncMonitoring {
  private syncMetrics: Map<string, SyncMetrics> = new Map();
  
  async trackSync(
    syncId: string,
    operation: () => Promise<void>
  ) {
    const startTime = Date.now();
    try {
      await operation();
      this.recordSuccess(syncId, Date.now() - startTime);
    } catch (error) {
      this.recordFailure(syncId, error, Date.now() - startTime);
    }
  }
  
  private recordSuccess(syncId: string, duration: number) {
    const metrics = this.syncMetrics.get(syncId) || {
      successCount: 0,
      failureCount: 0,
      totalDuration: 0
    };
    metrics.successCount++;
    metrics.totalDuration += duration;
    this.syncMetrics.set(syncId, metrics);
  }
  
  private recordFailure(syncId: string, error: Error, duration: number) {
    const metrics = this.syncMetrics.get(syncId) || {
      successCount: 0,
      failureCount: 0,
      totalDuration: 0
    };
    metrics.failureCount++;
    this.syncMetrics.set(syncId, metrics);
    console.error(`Sync ${syncId} failed:`, error);
  }
}
```

### Monitoring Database Growth

**Pattern**: Track database sizes

```typescript
class DatabaseMonitoring {
  async monitorDatabaseSize(db: MindooDB): Promise<number> {
    const allHashes = await db.getStore().getAllChangeHashes();
    const allChanges = await db.getStore().getChanges(allHashes);
    
    let totalSize = 0;
    for (const change of allChanges) {
      totalSize += change.payload.length;
    }
    
    return totalSize;
  }
  
  async checkGrowthThreshold(db: MindooDB, threshold: number): Promise<boolean> {
    const size = await this.monitorDatabaseSize(db);
    return size > threshold;
  }
}
```

## Development Workflows

### Local Development

**Pattern**: Use in-memory stores for development

```typescript
class LocalDevelopment {
  async setupLocalEnvironment() {
    // Use in-memory stores for fast development
    const storeFactory = new InMemoryAppendOnlyStoreFactory();
    const tenant = await this.createTenantWithFactory(storeFactory);
    
    return tenant;
  }
  
  async setupTestData(tenant: MindooTenant) {
    const db = await tenant.openDB("test-data");
    
    // Create test documents
    for (let i = 0; i < 10; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        d.getData().testId = i;
        d.getData().name = `Test ${i}`;
      });
    }
  }
}
```

### Debugging

**Pattern**: Debug MindooDB operations

```typescript
class MindooDBDebugging {
  async debugDocument(docId: string, db: MindooDB) {
    const doc = await db.getDocument(docId);
    
    console.log("Document ID:", doc.getId());
    console.log("Data:", doc.getData());
    console.log("Last Modified:", doc.getLastModified());
    
    // Get change history
    const changeHashes = await db.getStore()
      .getAllChangeHashesForDoc(docId);
    console.log("Change Count:", changeHashes.length);
    
    // Get changes
    const changes = await db.getStore().getChanges(changeHashes);
    console.log("Changes:", changes.map(c => ({
      type: c.type,
      createdAt: c.createdAt,
      createdBy: c.createdByPublicKey
    })));
  }
  
  async debugSync(localDB: MindooDB, remoteStore: AppendOnlyStore) {
    const localHashes = await localDB.getStore().getAllChangeHashes();
    const remoteHashes = await remoteStore.getAllChangeHashes();
    
    console.log("Local Changes:", localHashes.length);
    console.log("Remote Changes:", remoteHashes.length);
    
    const newHashes = await localDB.getStore()
      .findNewChanges(remoteHashes);
    console.log("New Changes to Pull:", newHashes.length);
  }
}
```

## Code Organization

### Structuring MindooDB Applications

**Pattern**: Organize code by feature

```
src/
  features/
    documents/
      DocumentService.ts
      DocumentRepository.ts
    sync/
      SyncService.ts
      SyncManager.ts
    access/
      AccessControlService.ts
      KeyDistributionService.ts
  core/
    MindooDBFactory.ts
    TenantManager.ts
  utils/
    EncryptionUtils.ts
    ValidationUtils.ts
```

### Service Layer Pattern

**Pattern**: Abstract MindooDB operations

```typescript
class DocumentService {
  constructor(private db: MindooDB) {}
  
  async createDocument(data: any): Promise<MindooDoc> {
    const doc = await this.db.createDocument();
    await this.db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc;
  }
  
  async updateDocument(docId: string, updates: any): Promise<void> {
    const doc = await this.db.getDocument(docId);
    await this.db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), updates);
    });
  }
  
  async getDocument(docId: string): Promise<MindooDoc> {
    return await this.db.getDocument(docId);
  }
}
```

## Best Practices

### 1. Error Handling

- Handle sync failures gracefully
- Retry with exponential backoff
- Log errors for debugging
- Notify users of issues

### 2. Testing

- Test offline scenarios
- Test sync behavior
- Test access control
- Use mocks for unit tests

### 3. Monitoring

- Track sync status
- Monitor database growth
- Log important operations
- Alert on failures

### 4. Development

- Use in-memory stores for development
- Set up test data
- Debug with logging
- Organize code clearly

## Related Patterns

- **[Sync Patterns](sync-patterns.md)** - Sync strategies
- **[Access Control Patterns](access-control-patterns.md)** - Security patterns
- **[Performance Optimization](performance-optimization.md)** - Performance patterns

## Conclusion

Effective MindooDB development requires:

1. **Comprehensive Testing** of offline, sync, and access scenarios
2. **Robust Error Handling** for sync and key operations
3. **Monitoring** of sync status and database growth
4. **Clear Code Organization** with service layers
5. **Development Tools** for debugging and local development

By following these patterns, you can build reliable, maintainable MindooDB applications with confidence.
