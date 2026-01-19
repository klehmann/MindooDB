# Developer Patterns

## Overview

This document covers development best practices for building applications with MindooDB, including testing strategies, error handling, monitoring, and development workflows. Following these patterns will help you build robust, maintainable applications that take full advantage of MindooDB's unique capabilities.

## Testing Strategies

Testing MindooDB applications requires special attention to offline scenarios, synchronization behavior, and access control. The append-only architecture and CRDT-based conflict resolution create unique testing requirements that differ from traditional database applications.

### Testing Offline Scenarios

MindooDB's offline-first design means that all operations work locally before synchronizing with remote stores. Testing this behavior ensures your application gracefully handles connectivity changes.

**Pattern**: Test offline creation and retrieval

```typescript
class OfflineTesting {
  async testOfflineCreation() {
    // Create DB with a local in-memory store (no network connectivity)
    const tenant = await this.createTestTenant();
    const db = await tenant.openDB("test-db");
    
    // Create document offline - this works entirely locally
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().test = "offline";
    });
    
    // Verify document exists locally using the correct API method
    const retrieved = await db.getDocument(doc.getId());
    expect(retrieved).not.toBeNull();
    expect(retrieved!.getData().test).toBe("offline");
  }
  
  async testSyncAfterOffline() {
    // Create two tenants with separate in-memory stores
    const localTenant = await this.createTestTenant();
    const remoteTenant = await this.createTestTenant();
    
    const localDB = await localTenant.openDB("shared-db");
    const remoteDB = await remoteTenant.openDB("shared-db");
    
    // Create document offline in local database
    const doc = await localDB.createDocument();
    await localDB.changeDoc(doc, (d) => {
      d.getData().test = "sync-test";
    });
    
    // Sync happens at the store level - get new changes and apply them
    const localStore = localDB.getStore();
    const remoteStore = remoteDB.getStore();
    
    // Find changes that remote doesn't have
    const newHashes = await localStore.findNewChanges(
      await remoteStore.getAllChangeHashes()
    );
    
    // Transfer changes to remote store
    const newChanges = await localStore.getChanges(newHashes);
    for (const change of newChanges) {
      await remoteStore.append(change);
    }
    
    // Apply synced changes to remote database
    await remoteDB.syncStoreChanges(newHashes);
    
    // Verify document synced correctly
    const synced = await remoteDB.getDocument(doc.getId());
    expect(synced).not.toBeNull();
    expect(synced!.getData().test).toBe("sync-test");
  }
}
```

### Testing Sync Behavior

Synchronization testing verifies that changes propagate correctly between databases and that concurrent edits merge as expected. This is crucial for applications where multiple users or devices work on the same data.

**Pattern**: Test bidirectional sync operations

```typescript
class SyncTesting {
  async testBidirectionalSync() {
    // Create two independent tenants
    const tenantA = await this.createTestTenant();
    const tenantB = await this.createTestTenant();
    
    const dbA = await tenantA.openDB("sync-test");
    const dbB = await tenantB.openDB("sync-test");
    
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
    
    // Helper function to sync stores
    const syncStores = async (sourceDB: MindooDB, targetDB: MindooDB) => {
      const sourceStore = sourceDB.getStore();
      const targetStore = targetDB.getStore();
      
      const newHashes = await sourceStore.findNewChanges(
        await targetStore.getAllChangeHashes()
      );
      
      if (newHashes.length > 0) {
        const changes = await sourceStore.getChanges(newHashes);
        for (const change of changes) {
          await targetStore.append(change);
        }
        await targetDB.syncStoreChanges(newHashes);
      }
    };
    
    // Sync both ways
    await syncStores(dbA, dbB);  // A -> B
    await syncStores(dbB, dbA);  // B -> A
    
    // Verify both documents exist in both databases
    expect(await dbB.getDocument(docA.getId())).not.toBeNull();
    expect(await dbA.getDocument(docB.getId())).not.toBeNull();
  }
  
  async testConflictResolution() {
    // Create two copies of the same database
    const tenantA = await this.createTestTenant();
    const tenantB = await this.createTestTenant();
    
    const dbA = await tenantA.openDB("conflict-test");
    const dbB = await tenantB.openDB("conflict-test");
    
    // Create the same document in both (simulating offline conflict)
    const docA = await dbA.createDocument();
    await dbA.changeDoc(docA, (d) => {
      d.getData().title = "Version A";
      d.getData().count = 1;
    });
    
    // Sync A to B first, so both have the document
    await this.syncStores(dbA, dbB);
    
    // Now both edit the document concurrently
    await dbA.changeDoc(docA, (d) => {
      d.getData().title = "Title from A";
    });
    
    const docBCopy = await dbB.getDocument(docA.getId());
    await dbB.changeDoc(docBCopy!, (d) => {
      d.getData().count = 2;
    });
    
    // Sync both ways - Automerge will merge changes
    await this.syncStores(dbA, dbB);
    await this.syncStores(dbB, dbA);
    
    // Both changes should be preserved (different fields)
    const finalA = await dbA.getDocument(docA.getId());
    const finalB = await dbB.getDocument(docA.getId());
    
    expect(finalA!.getData().title).toBe("Title from A");
    expect(finalA!.getData().count).toBe(2);
    expect(finalB!.getData()).toEqual(finalA!.getData());
  }
}
```

### Testing Access Control

Access control testing verifies that named encryption keys properly restrict document access. The key aspect to test is that documents encrypted with a specific key can only be decrypted by users who possess that key.

**Pattern**: Test named key access and encryption

```typescript
class AccessControlTesting {
  async testNamedKeyEncryption() {
    const tenant = await this.createTestTenant();
    const keyId = "confidential-key";
    
    // Generate and add a named encryption key to the tenant's keybag
    // In a real application, this key would be securely distributed
    const keyBag = tenant.getKeyBag();
    const symmetricKey = await this.generateSymmetricKey();
    keyBag.setKey(keyId, symmetricKey);
    
    // Open a database
    const db = await tenant.openDB("test");
    
    // Create a document - encryption happens at the change level
    // The tenant's encryptPayload method will use the named key
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().secret = "confidential-data";
      d.getData().classification = "confidential";
    });
    
    // Verify the document is accessible with the correct key
    const retrieved = await db.getDocument(doc.getId());
    expect(retrieved!.getData().secret).toBe("confidential-data");
  }
  
  async testAccessWithoutKey() {
    // Create tenant with the encryption key
    const tenantWithKey = await this.createTestTenant();
    const keyId = "secret-key";
    const symmetricKey = await this.generateSymmetricKey();
    tenantWithKey.getKeyBag().setKey(keyId, symmetricKey);
    
    const dbWithKey = await tenantWithKey.openDB("secure-db");
    const doc = await dbWithKey.createDocument();
    await dbWithKey.changeDoc(doc, (d) => {
      d.getData().secret = "sensitive-info";
    });
    
    // Create a second tenant WITHOUT the encryption key
    const tenantWithoutKey = await this.createTestTenant();
    
    // Sync the encrypted data to the second tenant
    await this.syncStores(dbWithKey, await tenantWithoutKey.openDB("secure-db"));
    
    // The second tenant should not be able to decrypt the document
    const dbWithoutKey = await tenantWithoutKey.openDB("secure-db");
    
    // Attempting to read the document without the key should fail
    // or return encrypted/unreadable data depending on implementation
    await expect(async () => {
      const doc = await dbWithoutKey.getDocument(doc.getId());
      doc!.getData(); // This should fail without the decryption key
    }).rejects.toThrow();
  }
}
```

### Mocking MindooDB

For unit tests that focus on business logic rather than database behavior, you can mock the MindooDB interfaces. This allows faster tests that don't require actual database operations.

**Pattern**: Create mock implementations matching the MindooDB interface

```typescript
import { v4 as uuidv4 } from 'uuid';

class MindooDBMock implements Partial<MindooDB> {
  private documents: Map<string, MockDoc> = new Map();
  
  async createDocument(): Promise<MockDoc> {
    const docId = uuidv4();
    const doc = new MockDoc(docId, {});
    this.documents.set(docId, doc);
    return doc;
  }
  
  async getDocument(docId: string): Promise<MockDoc | null> {
    return this.documents.get(docId) || null;
  }
  
  async changeDoc(doc: MockDoc, changer: (autoDoc: any) => void): Promise<MockDoc> {
    // Simulate Automerge behavior with a simple object
    const autoDoc = { getData: () => doc.getData() };
    changer(autoDoc);
    return doc;
  }
  
  async deleteDoc(doc: MockDoc): Promise<void> {
    this.documents.delete(doc.getId());
  }
  
  // Add processChangesSince for iteration testing
  async processChangesSince(
    cursor: any,
    maxChanges: number,
    callback: (doc: MockDoc, cursor: any) => boolean
  ): Promise<{ cursor: any; hasMore: boolean }> {
    const docs = Array.from(this.documents.values());
    let processed = 0;
    
    for (const doc of docs) {
      if (processed >= maxChanges) break;
      const shouldContinue = callback(doc, { position: processed });
      if (!shouldContinue) break;
      processed++;
    }
    
    return { cursor: { position: processed }, hasMore: processed < docs.size };
  }
}

class MockDoc implements Partial<MindooDoc> {
  private data: Record<string, any> = {};
  
  constructor(
    private readonly id: string,
    initialData: Record<string, any>
  ) {
    this.data = { ...initialData };
  }
  
  getId(): string {
    return this.id;
  }
  
  getData(): Record<string, any> {
    return this.data;
  }
}

// Usage in tests
describe('MyBusinessLogic', () => {
  it('should process documents correctly', async () => {
    const mockDB = new MindooDBMock();
    const businessLogic = new MyBusinessLogic(mockDB as MindooDB);
    
    const result = await businessLogic.createAndProcess({ name: 'Test' });
    expect(result.getData().processed).toBe(true);
  });
});
```

## Error Handling

Robust error handling is essential for MindooDB applications, particularly around synchronization operations that may fail due to network issues, and key operations where missing keys prevent decryption.

### Handling Sync Failures

Network operations can fail for many reasons: connectivity loss, server unavailability, timeouts, or data conflicts. Your application should handle these gracefully without losing local changes.

**Pattern**: Graceful sync error handling with exponential backoff

```typescript
class SyncErrorHandling {
  /**
   * Performs bidirectional sync with automatic retry on failure.
   * Local changes are preserved even if sync fails.
   */
  async syncWithRetry(
    localDB: MindooDB,
    remoteStore: ContentAddressedStore,
    maxRetries: number = 3
  ): Promise<{ success: boolean; error?: Error }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Pull changes from remote to local
        const localStore = localDB.getStore();
        const remoteHashes = await remoteStore.getAllChangeHashes();
        const newFromRemote = await remoteStore.findNewChanges(
          await localStore.getAllChangeHashes()
        );
        
        if (newFromRemote.length > 0) {
          const remoteChanges = await remoteStore.getChanges(newFromRemote);
          for (const change of remoteChanges) {
            await localStore.append(change);
          }
          await localDB.syncStoreChanges(newFromRemote);
        }
        
        // Push local changes to remote
        const newFromLocal = await localStore.findNewChanges(remoteHashes);
        if (newFromLocal.length > 0) {
          const localChanges = await localStore.getChanges(newFromLocal);
          for (const change of localChanges) {
            await remoteStore.append(change);
          }
        }
        
        console.log(`Sync completed successfully on attempt ${attempt}`);
        return { success: true };
        
      } catch (error) {
        console.warn(`Sync attempt ${attempt} failed:`, error);
        
        if (attempt === maxRetries) {
          console.error('Sync failed after all retries');
          return { success: false, error: error as Error };
        }
        
        // Exponential backoff: 2s, 4s, 8s...
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.log(`Retrying in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
      }
    }
    
    return { success: false };
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

Effective debugging in MindooDB involves examining document state, change history, and sync status. These utilities help diagnose issues during development.

**Pattern**: Debug MindooDB operations

```typescript
class MindooDBDebugging {
  /**
   * Prints detailed information about a document and its change history.
   */
  async debugDocument(docId: string, db: MindooDB): Promise<void> {
    const doc = await db.getDocument(docId);
    
    if (!doc) {
      console.log(`Document ${docId} not found`);
      return;
    }
    
    console.log("=== Document Debug Info ===");
    console.log("Document ID:", doc.getId());
    console.log("Current Data:", JSON.stringify(doc.getData(), null, 2));
    
    // Get change history from the store
    const store = db.getStore();
    const allHashes = await store.getAllChangeHashes();
    
    // Filter to changes for this document
    // Note: The actual API may vary - this shows the concept
    console.log("Total changes in store:", allHashes.length);
    
    // Get the actual changes to examine metadata
    const changes = await store.getChanges(allHashes);
    const docChanges = changes.filter(c => 
      c.type === 'change' && c.documentId === docId
    );
    
    console.log("Changes for this document:", docChanges.length);
    console.log("Change history:");
    docChanges.forEach((change, i) => {
      console.log(`  ${i + 1}. Type: ${change.type}`);
      console.log(`     Created: ${new Date(change.createdAt).toISOString()}`);
      console.log(`     Author: ${change.createdByPublicKey?.substring(0, 20)}...`);
    });
  }
  
  /**
   * Compares local and remote stores to diagnose sync issues.
   */
  async debugSync(localDB: MindooDB, remoteStore: ContentAddressedStore): Promise<void> {
    const localStore = localDB.getStore();
    
    const localHashes = await localStore.getAllChangeHashes();
    const remoteHashes = await remoteStore.getAllChangeHashes();
    
    console.log("=== Sync Debug Info ===");
    console.log("Local store entries:", localHashes.length);
    console.log("Remote store entries:", remoteHashes.length);
    
    // Find what each side is missing
    const localNeedsFromRemote = await remoteStore.findNewChanges(localHashes);
    const remoteNeedsFromLocal = await localStore.findNewChanges(remoteHashes);
    
    console.log("Local needs from remote:", localNeedsFromRemote.length);
    console.log("Remote needs from local:", remoteNeedsFromLocal.length);
    
    if (localNeedsFromRemote.length > 0) {
      console.log("Sample hashes local needs:", 
        localNeedsFromRemote.slice(0, 5).join(', ')
      );
    }
    
    if (remoteNeedsFromLocal.length > 0) {
      console.log("Sample hashes remote needs:", 
        remoteNeedsFromLocal.slice(0, 5).join(', ')
      );
    }
  }
  
  /**
   * Lists all documents in a database for debugging.
   */
  async listAllDocuments(db: MindooDB): Promise<void> {
    console.log("=== Database Contents ===");
    
    let count = 0;
    await db.processChangesSince(null, 1000, (doc, cursor) => {
      console.log(`${++count}. ID: ${doc.getId()}`);
      console.log(`   Data: ${JSON.stringify(doc.getData()).substring(0, 100)}...`);
      return true; // Continue iterating
    });
    
    console.log(`Total documents: ${count}`);
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

A service layer abstracts MindooDB operations behind a domain-specific interface. This provides a clean separation between business logic and data access, makes testing easier, and provides a place for validation and business rules.

**Pattern**: Abstract MindooDB operations behind service classes

```typescript
interface Contact {
  id?: string;
  name: string;
  email: string;
  company?: string;
  createdAt?: number;
  updatedAt?: number;
}

class ContactService {
  constructor(private db: MindooDB) {}
  
  /**
   * Creates a new contact with automatic timestamps.
   */
  async createContact(contactData: Omit<Contact, 'id' | 'createdAt'>): Promise<Contact> {
    const doc = await this.db.createDocument();
    await this.db.changeDoc(doc, (d) => {
      const data = d.getData();
      data.type = 'contact';
      data.name = contactData.name;
      data.email = contactData.email;
      data.company = contactData.company;
      data.createdAt = Date.now();
      data.updatedAt = Date.now();
    });
    
    return this.docToContact(doc);
  }
  
  /**
   * Updates an existing contact.
   * @throws Error if contact not found
   */
  async updateContact(id: string, updates: Partial<Contact>): Promise<Contact> {
    const doc = await this.db.getDocument(id);
    if (!doc) {
      throw new Error(`Contact not found: ${id}`);
    }
    
    await this.db.changeDoc(doc, (d) => {
      const data = d.getData();
      if (updates.name) data.name = updates.name;
      if (updates.email) data.email = updates.email;
      if (updates.company !== undefined) data.company = updates.company;
      data.updatedAt = Date.now();
    });
    
    // Re-fetch to get updated data
    const updated = await this.db.getDocument(id);
    return this.docToContact(updated!);
  }
  
  /**
   * Retrieves a contact by ID.
   */
  async getContact(id: string): Promise<Contact | null> {
    const doc = await this.db.getDocument(id);
    return doc ? this.docToContact(doc) : null;
  }
  
  /**
   * Lists all contacts, optionally filtered.
   */
  async listContacts(filter?: { company?: string }): Promise<Contact[]> {
    const contacts: Contact[] = [];
    
    await this.db.processChangesSince(null, 1000, (doc, cursor) => {
      const data = doc.getData();
      if (data.type !== 'contact') return true;
      if (filter?.company && data.company !== filter.company) return true;
      
      contacts.push(this.docToContact(doc));
      return true; // Continue
    });
    
    return contacts;
  }
  
  /**
   * Soft deletes a contact by marking it as deleted.
   */
  async deleteContact(id: string): Promise<void> {
    const doc = await this.db.getDocument(id);
    if (!doc) {
      throw new Error(`Contact not found: ${id}`);
    }
    
    await this.db.deleteDoc(doc);
  }
  
  private docToContact(doc: MindooDoc): Contact {
    const data = doc.getData();
    return {
      id: doc.getId(),
      name: data.name,
      email: data.email,
      company: data.company,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}

// Usage
const contactService = new ContactService(db);
const newContact = await contactService.createContact({
  name: 'Jane Doe',
  email: 'jane@example.com',
  company: 'Acme Inc'
});
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
