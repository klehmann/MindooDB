# Cross-Tenant Collaboration

## Overview

MindooDB enables secure collaboration across organizational boundaries through controlled data sharing between tenants. This document explores patterns for sharing subsets of data with external partners, using `iterateChangesSince()` for efficient incremental sync, and managing multi-tenant relationships.

## Key Concepts

### Tenant Isolation

Each organization has its own `MindooTenant`:
- Independent key management
- Separate user directories
- Isolated data by default
- Complete control over access

### Controlled Data Sharing

Tenants can share specific databases or documents:
- Share entire databases
- Share filtered subsets of data
- Use named keys for fine-grained access
- Maintain independent tenant management

### Incremental Sync

Use `iterateChangesSince()` for efficient data transfer:
- Only transfer new changes
- Bidirectional sync support
- Efficient for large datasets
- Minimal network usage

## Partner Collaboration Patterns

### Basic Pattern: Shared Database

**Pattern**: Organizations share a specific database for collaboration

```typescript
// Organization A creates shared database
const orgATenant = await tenantFactory.openTenant("org-a-tenant");
const sharedDB = await orgATenant.openDB("collaboration");

// Organization B syncs from Organization A
const orgBTenant = await tenantFactory.openTenant("org-b-tenant");
const orgBSharedDB = await orgBTenant.openDB("collaboration");

// Helper function to sync stores
async function syncStores(source: MindooDB, target: MindooDB): Promise<void> {
  const sourceStore = source.getStore();
  const targetStore = target.getStore();
  
  const newHashes = await sourceStore.findNewChanges(
    await targetStore.getAllChangeHashes()
  );
  
  if (newHashes.length > 0) {
    const changes = await sourceStore.getChanges(newHashes);
    for (const change of changes) {
      await targetStore.append(change);
    }
    await target.syncStoreChanges(newHashes);
  }
}

// Org B pulls changes from Org A
await syncStores(sharedDB, orgBSharedDB);

// Org A can also pull changes from Org B (bidirectional sync)
await syncStores(orgBSharedDB, sharedDB);
```

**Benefits:**
- Clear collaboration boundary
- Independent tenant management
- Can revoke access by stopping sync
- Each organization controls its own keys

### Filtered Data Sharing

**Pattern**: Share only specific document types or categories

```typescript
// Organization A filters what to share
async function syncFilteredData(
  sourceDB: MindooDB,
  targetStore: AppendOnlyStore,
  filter: (doc: MindooDoc) => boolean
) {
  let cursor: ProcessChangesCursor | null = null;
  
  // Process changes and filter
  for await (const { doc, cursor: currentCursor } of sourceDB.iterateChangesSince(cursor)) {
    cursor = currentCursor;
    
    if (filter(doc)) {
      // Get change from store
      const changeHashes = await sourceDB.getStore()
        .getAllChangeHashesForDoc(doc.getId());
      const changes = await sourceDB.getStore()
        .getChanges(changeHashes);
      
      // Append filtered changes to target
      for (const change of changes) {
        await targetStore.append(change);
      }
    }
  }
}

// Share only "public" documents
await syncFilteredData(
  orgADB,
  orgBStore,
  (doc) => doc.getData().visibility === "public"
);
```

**Benefits:**
- Control what data is shared
- Maintain privacy for sensitive data
- Flexible filtering criteria
- Can change filter over time

### Named Key Collaboration

**Pattern**: Use named keys to control access to shared documents

```typescript
// Create collaboration key
const collaborationKey = await tenantFactory.createSymmetricEncryptedPrivateKey(
  "collab-password-xyz"
);

// Distribute key to partner organizations
await distributeKeyToPartner(orgB, "collaboration-key", collaborationKey, password);

// Create documents with collaboration key
const sharedDoc = await orgADB.createDocument();
await orgADB.changeDoc(sharedDoc, (d) => {
  d.getData().content = "Shared collaboration data";
});

// Partner can decrypt because they have the key
// But cannot decrypt other documents
```

**Benefits:**
- Fine-grained access control
- Only specific documents are accessible
- Can revoke access by not sharing new key versions
- Clear access boundaries

## Incremental Data Transfer

### Using iterateChangesSince()

**Pattern**: Efficiently transfer only new changes

```typescript
interface SyncState {
  lastSyncCursor: ProcessChangesCursor | null;
  lastSyncTimestamp: number;
}

async function incrementalSync(
  sourceDB: MindooDB,
  targetStore: AppendOnlyStore,
  lastSyncState: SyncState
): Promise<SyncState> {
  let cursor = lastSyncState.lastSyncCursor;
  const sourceStore = sourceDB.getStore();
  
  // Get change hashes we need to transfer
  const targetHashes = await targetStore.getAllChangeHashes();
  const newHashes = await sourceStore.findNewChanges(targetHashes);
  
  if (newHashes.length === 0) {
    return lastSyncState; // No new changes
  }
  
  // Get the actual changes
  const newChanges = await sourceStore.getChanges(newHashes);
  
  // Append to target store
  for (const change of newChanges) {
    await targetStore.append(change);
  }
  
  // Update sync state - get latest cursor by iterating to the end
  for await (const { cursor: currentCursor } of sourceDB.iterateChangesSince(cursor)) {
    cursor = currentCursor;
  }
  
  return {
    lastSyncCursor: cursor,
    lastSyncTimestamp: Date.now()
  };
}
```

**Benefits:**
- Only transfers new changes
- Efficient for large datasets
- Minimal network usage
- Fast sync operations

### Bidirectional Sync

**Pattern**: Keep two tenants synchronized bidirectionally

```typescript
async function bidirectionalSync(
  tenantA: MindooTenant,
  tenantB: MindooTenant,
  dbId: string
) {
  const dbA = await tenantA.openDB(dbId);
  const dbB = await tenantB.openDB(dbId);
  
  // Sync A -> B (using the syncStores helper defined earlier)
  await syncStores(dbA, dbB);
  
  // Sync B -> A
  await syncStores(dbB, dbA);
  
  // Both databases now have all changes
  // Conflicts resolved by Automerge CRDTs
}
```

**Benefits:**
- Both sides stay in sync
- Automatic conflict resolution
- Works offline (syncs when connected)
- Efficient incremental sync

### Scheduled Sync

**Pattern**: Sync on a schedule

```typescript
class ScheduledSync {
  private syncInterval: number = 60 * 60 * 1000; // 1 hour
  
  async startScheduledSync(
    tenantA: MindooTenant,
    tenantB: MindooTenant,
    dbId: string
  ) {
    // Initial sync
    await this.sync(tenantA, tenantB, dbId);
    
    // Schedule periodic sync
    setInterval(async () => {
      await this.sync(tenantA, tenantB, dbId);
    }, this.syncInterval);
  }
  
  private async sync(
    tenantA: MindooTenant,
    tenantB: MindooTenant,
    dbId: string
  ) {
    const dbA = await tenantA.openDB(dbId);
    const dbB = await tenantB.openDB(dbId);
    
    // Bidirectional sync using store-level operations
    await this.syncStores(dbA, dbB);
    await this.syncStores(dbB, dbA);
  }
  
  private async syncStores(source: MindooDB, target: MindooDB): Promise<void> {
    const sourceStore = source.getStore();
    const targetStore = target.getStore();
    
    const newHashes = await sourceStore.findNewChanges(
      await targetStore.getAllChangeHashes()
    );
    
    if (newHashes.length > 0) {
      const changes = await sourceStore.getChanges(newHashes);
      for (const change of changes) {
        await targetStore.append(change);
      }
      await target.syncStoreChanges(newHashes);
    }
  }
}
```

## Controlled Access Patterns

### Different Tenant Keys for Limited Access

**Pattern**: Use different tenant encryption keys to limit access

```typescript
// Organization A creates limited-access tenant
const limitedTenant = await tenantFactory.createTenant({
  tenantId: "limited-collab-tenant",
  // Different encryption key than main tenant
  tenantEncryptionKeyPassword: "different-password"
});

// Share only specific database with limited tenant
const sharedDB = await limitedTenant.openDB("shared-data");

// Partner syncs from limited tenant
// Can only access shared database, not main tenant data
```

**Benefits:**
- Complete isolation from main tenant
- Limited access scope
- Easy to revoke (stop sharing tenant)
- Clear security boundaries

### Document Type Filtering

**Pattern**: Share only specific document types

```typescript
async function syncDocumentType(
  sourceDB: MindooDB,
  targetStore: AppendOnlyStore,
  documentType: string
) {
  let cursor: ProcessChangesCursor | null = null;
  
  for await (const { doc, cursor: currentCursor } of sourceDB.iterateChangesSince(cursor)) {
    cursor = currentCursor;
    
    if (doc.getData().type === documentType) {
      // Sync this document type
      const changeHashes = await sourceDB.getStore()
        .getAllChangeHashesForDoc(doc.getId());
      const changes = await sourceDB.getStore()
        .getChanges(changeHashes);
      
      for (const change of changes) {
        await targetStore.append(change);
      }
    }
  }
}

// Share only "orders" documents
await syncDocumentType(orgADB, orgBStore, "order");
```

## Sync Orchestration

### Managing Multiple Tenant Relationships

**Pattern**: Coordinate sync across multiple partner relationships

```typescript
class MultiTenantSyncOrchestrator {
  private relationships: Map<string, TenantRelationship> = new Map();
  
  async addRelationship(
    relationshipId: string,
    localTenant: MindooTenant,
    partnerTenant: MindooTenant,
    dbIds: string[]
  ) {
    this.relationships.set(relationshipId, {
      localTenant,
      partnerTenant,
      dbIds,
      lastSync: null,
      enabled: true
    });
  }
  
  async syncAll() {
    for (const [id, relationship] of this.relationships) {
      if (!relationship.enabled) continue;
      
      try {
        await this.syncRelationship(relationship);
        relationship.lastSync = Date.now();
      } catch (error) {
        console.error(`Sync failed for ${id}:`, error);
        // Log error, continue with other relationships
      }
    }
  }
  
  private async syncRelationship(relationship: TenantRelationship) {
    for (const dbId of relationship.dbIds) {
      const localDB = await relationship.localTenant.openDB(dbId);
      const partnerDB = await relationship.partnerTenant.openDB(dbId);
      
      // Bidirectional sync using store-level operations
      await this.syncStores(localDB, partnerDB);
      await this.syncStores(partnerDB, localDB);
    }
  }
  
  async disableRelationship(relationshipId: string) {
    const relationship = this.relationships.get(relationshipId);
    if (relationship) {
      relationship.enabled = false;
    }
  }
}

interface TenantRelationship {
  localTenant: MindooTenant;
  partnerTenant: MindooTenant;
  dbIds: string[];
  lastSync: number | null;
  enabled: boolean;
}
```

### Conflict Resolution

Automerge CRDTs automatically resolve conflicts:

```typescript
// Both organizations modify same document
// Org A changes field X
await orgADB.changeDoc(sharedDoc, (d) => {
  d.getData().fieldX = "value from A";
});

// Org B changes field Y (different field)
await orgBDB.changeDoc(sharedDoc, (d) => {
  d.getData().fieldY = "value from B";
});

// Sync both ways using store-level operations
await syncStores(orgADB, orgBDB);
await syncStores(orgBDB, orgADB);

// Both changes are preserved (different fields)
// Automerge automatically merges
```

**Benefits:**
- Automatic conflict resolution
- No manual merge required
- Works offline
- Preserves all changes

## Implementation Examples

### Example 1: Supplier-Customer Collaboration

```typescript
class SupplierCustomerCollaboration {
  private supplierTenant: MindooTenant;
  private customerTenant: MindooTenant;
  
  async setupCollaboration() {
    // Create shared database in supplier tenant
    const sharedDB = await this.supplierTenant.openDB("customer-orders");
    
    // Customer syncs from supplier
    const customerDB = await this.customerTenant.openDB("supplier-orders");
    await this.syncStores(sharedDB, customerDB);
  }
  
  private async syncStores(source: MindooDB, target: MindooDB): Promise<void> {
    const sourceStore = source.getStore();
    const targetStore = target.getStore();
    
    const newHashes = await sourceStore.findNewChanges(
      await targetStore.getAllChangeHashes()
    );
    
    if (newHashes.length > 0) {
      const changes = await sourceStore.getChanges(newHashes);
      for (const change of changes) {
        await targetStore.append(change);
      }
      await target.syncStoreChanges(newHashes);
    }
  }
  
  async createOrder(orderData: any) {
    // Customer creates order
    const customerDB = await this.customerTenant.openDB("supplier-orders");
    const orderDoc = await customerDB.createDocument();
    await customerDB.changeDoc(orderDoc, (d) => {
      Object.assign(d.getData(), orderData);
      d.getData().type = "order";
      d.getData().status = "pending";
    });
    
    // Sync to supplier using store-level operations
    const supplierDB = await this.supplierTenant.openDB("customer-orders");
    await this.syncStores(customerDB, supplierDB);
  }
  
  async updateOrderStatus(orderId: string, status: string) {
    // Supplier updates status
    const supplierDB = await this.supplierTenant.openDB("customer-orders");
    const orderDoc = await supplierDB.getDocument(orderId);
    await supplierDB.changeDoc(orderDoc, (d) => {
      d.getData().status = status;
    });
    
    // Sync back to customer
    const customerDB = await this.customerTenant.openDB("supplier-orders");
    await this.syncStores(supplierDB, customerDB);
  }
}
```

### Example 2: Multi-Party Research Collaboration

```typescript
class ResearchCollaboration {
  private researchTenants: Map<string, MindooTenant> = new Map();
  private sharedDBId = "research-data";
  
  async addResearchInstitution(institutionId: string, tenant: MindooTenant) {
    this.researchTenants.set(institutionId, tenant);
  }
  
  async syncAllInstitutions() {
    const tenants = Array.from(this.researchTenants.values());
    
    // Sync each pair
    for (let i = 0; i < tenants.length; i++) {
      for (let j = i + 1; j < tenants.length; j++) {
        await this.syncPair(tenants[i], tenants[j]);
      }
    }
  }
  
  private async syncPair(tenantA: MindooTenant, tenantB: MindooTenant) {
    const dbA = await tenantA.openDB(this.sharedDBId);
    const dbB = await tenantB.openDB(this.sharedDBId);
    
    // Bidirectional sync
    await this.syncStores(dbA, dbB);
    await this.syncStores(dbB, dbA);
  }
  
  async shareResearchData(data: any, keyId: string) {
    // Create document with shared key
    const localTenant = this.researchTenants.values().next().value;
    const db = await localTenant.openDB(this.sharedDBId);
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().type = "research-data";
    });
    
    // Sync to all institutions
    await this.syncAllInstitutions();
  }
}
```

## Best Practices

### 1. Plan Sync Strategy

- Determine what data to share
- Decide on sync frequency
- Plan for conflict resolution
- Document sync procedures

### 2. Use Filtered Sync

- Only share necessary data
- Filter sensitive information
- Use document type filtering
- Consider named keys for access control

### 3. Monitor Sync Status

- Track sync success/failure
- Monitor sync performance
- Log sync operations
- Alert on sync failures

### 4. Handle Errors Gracefully

- Retry failed syncs
- Log errors for debugging
- Continue with other relationships
- Notify administrators of issues

### 5. Security Considerations

- Verify partner identity
- Use secure channels for sync
- Monitor for unusual activity
- Regularly review access

## Related Patterns

- **[Access Control Patterns](access-control-patterns.md)** - Using named keys for collaboration
- **[Sync Patterns](sync-patterns.md)** - Detailed sync strategies
- **[Virtual Views Patterns](virtual-views-patterns.md)** - Aggregating across tenants
- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing shared data

## Conclusion

Cross-tenant collaboration in MindooDB enables:

1. **Secure Data Sharing** across organizational boundaries
2. **Incremental Sync** for efficient data transfer
3. **Controlled Access** through filtering and named keys
4. **Bidirectional Sync** with automatic conflict resolution
5. **Flexible Orchestration** for complex multi-party scenarios

By following these patterns, you can build secure, efficient collaboration systems that maintain data privacy while enabling productive partnerships.
