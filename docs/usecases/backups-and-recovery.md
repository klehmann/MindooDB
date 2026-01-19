# Backups and Recovery

## Overview

MindooDB's append-only architecture provides unique advantages for backup and disaster recovery. This document explores how to leverage the append-only nature for simple backups, mirror encrypted data without decryption keys, and implement disaster recovery strategies.

## Key Advantages

### Append-Only Benefits

1. **Simple Backups**: Copy entire append-only store for complete backup
2. **Incremental Backups**: Use `processChangesSince()` for efficient incremental backups
3. **Point-in-Time Recovery**: Reconstruct state at any point in history
4. **Mirroring Without Keys**: Mirror encrypted data without needing decryption keys
5. **Cryptographic Integrity**: Verify backup integrity using change hashes

### Mirroring Without Decryption

A powerful feature of MindooDB is the ability to mirror encrypted data without decryption keys:

- **Servers can mirror data** they cannot read
- **Perfect for disaster recovery** - backup sites don't need keys
- **P2P sync of encrypted data** - peers can sync without access
- **Client-server mirroring** - clients can backup to servers without key exposure
- **Server-server replication** - replicate across data centers securely

## Backup Strategies

### Full Backup

**Pattern**: Copy entire append-only store

```typescript
async function fullBackup(store: AppendOnlyStore, backupLocation: string) {
  // Get all change hashes
  const allHashes = await store.getAllChangeHashes();
  
  // Get all changes
  const allChanges = await store.getChanges(allHashes);
  
  // Write to backup location
  await writeToBackup(backupLocation, allChanges);
  
  // Store backup metadata
  await storeBackupMetadata({
    type: "full",
    timestamp: Date.now(),
    changeCount: allChanges.length,
    location: backupLocation
  });
}
```

**Benefits:**
- Complete backup of all data
- Simple to implement
- Can restore entire database
- Good for initial backups

**Considerations:**
- Can be large for big databases
- Takes time for large stores
- May need to pause writes during backup

### Incremental Backup

**Pattern**: Backup only changes since last backup

```typescript
interface BackupState {
  lastBackupCursor: ProcessChangesCursor | null;
  lastBackupTimestamp: number;
}

async function incrementalBackup(
  db: MindooDB,
  lastBackupState: BackupState
): Promise<BackupState> {
  const changes: MindooDocChange[] = [];
  let currentCursor = lastBackupState.lastBackupCursor;
  
  // Process changes since last backup
  currentCursor = await db.processChangesSince(
    currentCursor,
    1000, // Process in batches
    (doc, cursor) => {
      // Collect changes for backup
      // In practice, you'd get the actual changes from the store
      return true; // Continue processing
    }
  );
  
  // Get actual changes from store
  const store = db.getStore();
  const newHashes = await store.findNewChanges(
    lastBackupState.lastBackupCursor 
      ? [await store.getChangeHashAtCursor(lastBackupState.lastBackupCursor)]
      : []
  );
  const newChanges = await store.getChanges(newHashes);
  
  // Write incremental backup
  await writeIncrementalBackup({
    timestamp: Date.now(),
    changes: newChanges,
    previousBackup: lastBackupState.lastBackupTimestamp
  });
  
  return {
    lastBackupCursor: currentCursor,
    lastBackupTimestamp: Date.now()
  };
}
```

**Benefits:**
- Much smaller than full backups
- Faster to create
- Can run frequently
- Efficient for ongoing backups

**Considerations:**
- Need to track backup state
- Requires previous backup for restore
- More complex than full backup

### Snapshot-Based Backup

**Pattern**: Backup using Automerge snapshots

```typescript
async function snapshotBackup(db: MindooDB) {
  const snapshots: Array<{docId: string, snapshot: Uint8Array}> = [];
  
  // Iterate through all documents
  await db.processChangesSince(null, 1000, (doc, cursor) => {
    // Get all changes for document (note: fromLastSnapshot parameter not available)
    const changeHashes = await db.getStore().findNewChangesForDoc(
      [],
      doc.getId()
    );
    
    // Get changes and find latest snapshot
    const changes = await db.getStore().getChanges(changeHashes);
    const latestSnapshot = changes
      .filter(c => c.type === "snapshot")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    
    if (latestSnapshot) {
      snapshots.push({
        docId: doc.getId(),
        snapshot: latestSnapshot.payload // Decrypted snapshot
      });
    }
  }
  
  // Backup snapshots
  await writeSnapshotBackup(snapshots);
}
```

**Benefits:**
- Faster restore (no need to replay all changes)
- Smaller than full change history
- Good for point-in-time recovery
- Efficient for large document histories

## Mirroring Without Decryption

### Concept

One of MindooDB's most powerful features is the ability to mirror encrypted data without decryption keys. This enables:

- **Secure Backup Sites**: Backup servers don't need keys
- **Disaster Recovery**: Restore from encrypted backups
- **Multi-Site Replication**: Replicate across data centers
- **P2P Backup**: Peers can backup each other's encrypted data

### How It Works

The append-only store contains encrypted changes. These can be synced without decryption:

```typescript
// Server A has encrypted data (no keys)
// Server B wants to mirror it

// Server B pulls changes from Server A
// Sync at store level
const newHashes = await serverAStore.findNewChanges(
  await serverBStore.getAllChangeHashes()
);
if (newHashes.length > 0) {
  const changes = await serverAStore.getChanges(newHashes);
  for (const change of changes) {
    await serverBStore.append(change);
  }
}

// Server B now has encrypted changes
// But cannot decrypt them (no keys)
// This is perfect for disaster recovery!
```

### P2P Mirroring

**Pattern**: Peers mirror each other's encrypted data

```typescript
// Peer A and Peer B sync encrypted data
// Neither needs the other's keys

// Peer A pushes to Peer B
// Push changes from peerA to peerB at store level
const peerAStore = peerADB.getStore();
const pushHashes = await peerAStore.findNewChanges(
  await peerBStore.getAllChangeHashes()
);
if (pushHashes.length > 0) {
  const changes = await peerAStore.getChanges(pushHashes);
  for (const change of changes) {
    await peerBStore.append(change);
  }
}

// Peer B now has encrypted backup of Peer A's data
// Can restore if Peer A loses data
// But cannot read the data (no keys)
```

**Use Cases:**
- Personal backup networks
- Community backup pools
- Distributed backup systems
- Disaster recovery networks

### Client-Server Mirroring

**Pattern**: Clients backup to servers without key exposure

```typescript
// Client has data and keys
// Server provides backup storage (no keys)

// Client pushes encrypted changes to server
// Push client changes to server at store level
const clientStore = clientDB.getStore();
const clientNewHashes = await clientStore.findNewChanges(
  await serverStore.getAllChangeHashes()
);
if (clientNewHashes.length > 0) {
  const changes = await clientStore.getChanges(clientNewHashes);
  for (const change of changes) {
    await serverStore.append(change);
  }
}

// Server stores encrypted backup
// Server cannot read the data
// Client can restore from server if needed
```

**Benefits:**
- Server doesn't need keys (better security)
- Client controls access
- Can use untrusted backup providers
- Meets compliance requirements

### Server-Server Replication

**Pattern**: Replicate across data centers

```typescript
// Primary data center
const primaryStore = await createServerStore("primary-dc");

// Backup data center (no keys)
const backupStore = await createServerStore("backup-dc");

// Replicate encrypted data
// Backup syncs from primary at store level
const backupHashes = await primaryStore.findNewChanges(
  await backupStore.getAllChangeHashes()
);
if (backupHashes.length > 0) {
  const changes = await primaryStore.getChanges(backupHashes);
  for (const change of changes) {
    await backupStore.append(change);
  }
}

// Backup DC has encrypted copy
// Cannot decrypt (keys stored separately)
// Can restore if primary DC fails
```

**Benefits:**
- Geographic redundancy
- Keys stored separately (better security)
- Fast disaster recovery
- Compliance with data residency requirements

## Disaster Recovery

### Recovery Procedures

#### 1. Key Recovery

```typescript
// Keys are stored separately from data
// Recover keys from secure key storage

async function recoverKeys(userId: string, keyBackupLocation: string) {
  // Recover user's KeyBag from backup
  const keyBagBackup = await readFromBackup(keyBackupLocation);
  
  // Restore KeyBag
  const keyBag = new KeyBag();
  await keyBag.load(keyBagBackup, userPassword);
  
  return keyBag;
}
```

#### 2. Data Recovery

```typescript
// Recover data from encrypted backup

async function recoverData(
  backupStore: AppendOnlyStore,
  tenant: MindooTenant,
  keyBag: KeyBag
) {
  // Create new database from backup
  const recoveredDB = await tenant.openDB("recovered");
  
  // Pull all changes from backup
  // Recover from backup at store level
  const recoveredStore = recoveredDB.getStore();
  const recoverHashes = await backupStore.findNewChanges(
    await recoveredStore.getAllChangeHashes()
  );
  if (recoverHashes.length > 0) {
    const changes = await backupStore.getChanges(recoverHashes);
    for (const change of changes) {
      await recoveredStore.append(change);
    }
    await recoveredDB.syncStoreChanges(recoverHashes);
  }
  
  // Data is now recovered
  // Can decrypt because we have keys
  return recoveredDB;
}
```

#### 3. Complete Recovery

```typescript
async function completeDisasterRecovery(
  backupLocation: string,
  keyBackupLocation: string,
  tenantId: string,
  userId: string,
  userPassword: string
) {
  // Step 1: Recover keys
  const keyBag = await recoverKeys(userId, keyBackupLocation);
  
  // Step 2: Recover tenant
  const tenant = await recoverTenant(tenantId, keyBag);
  
  // Step 3: Recover data
  const backupStore = await createStoreFromBackup(backupLocation);
  const db = await tenant.openDB("main");
  // Restore from backup at store level
  const dbStore = db.getStore();
  const restoreHashes = await backupStore.findNewChanges(
    await dbStore.getAllChangeHashes()
  );
  if (restoreHashes.length > 0) {
    const changes = await backupStore.getChanges(restoreHashes);
    for (const change of changes) {
      await dbStore.append(change);
    }
    await db.syncStoreChanges(restoreHashes);
  }
  
  // Step 4: Verify recovery
  await verifyRecovery(db);
  
  return { tenant, db };
}
```

### Multi-Site Recovery

**Pattern**: Recover from multiple backup sites

```typescript
async function multiSiteRecovery(backupSites: string[]) {
  // Try to recover from each site
  for (const site of backupSites) {
    try {
      const backupStore = await connectToBackupSite(site);
      const recovered = await recoverFromBackup(backupStore);
      
      // Verify integrity
      if (await verifyDataIntegrity(recovered)) {
        return recovered;
      }
    } catch (error) {
      console.error(`Failed to recover from ${site}:`, error);
      continue;
    }
  }
  
  throw new Error("All backup sites failed");
}
```

## Point-in-Time Recovery

### Reconstructing Historical State

**Pattern**: Recover database to specific point in time

```typescript
async function pointInTimeRecovery(
  backupStore: AppendOnlyStore,
  targetTimestamp: number
): Promise<MindooDB> {
  const recoveredDB = await tenant.openDB("recovered");
  
  // Get all changes up to target timestamp
  const allHashes = await backupStore.getAllChangeHashes();
  const allChanges = await backupStore.getChanges(allHashes);
  
  // Filter changes before target timestamp
  const historicalChanges = allChanges.filter(
    change => change.createdAt <= targetTimestamp
  );
  
  // Apply historical changes
  for (const change of historicalChanges) {
    await recoveredDB.getStore().append(change);
  }
  
  // Process changes to update document state
  await recoveredDB.syncStoreChanges();
  
  return recoveredDB;
}
```

**Use Cases:**
- Recover from data corruption
- Restore before accidental deletion
- Investigate historical state
- Compliance audits

## Backup Verification

### Integrity Verification

**Pattern**: Verify backup integrity using change hashes

```typescript
async function verifyBackupIntegrity(
  originalStore: AppendOnlyStore,
  backupStore: AppendOnlyStore
): Promise<boolean> {
  // Get all change hashes from both stores
  const originalHashes = await originalStore.getAllChangeHashes();
  const backupHashes = await backupStore.getAllChangeHashes();
  
  // Compare hashes
  const originalHashSet = new Set(originalHashes.map(h => h.changeHash));
  const backupHashSet = new Set(backupHashes.map(h => h.changeHash));
  
  // Check if all original hashes are in backup
  for (const hash of originalHashSet) {
    if (!backupHashSet.has(hash)) {
      console.error(`Missing change in backup: ${hash}`);
      return false;
    }
  }
  
  // Verify change contents match
  const sampleChanges = await originalStore.getChanges(
    Array.from(originalHashSet).slice(0, 100)
  );
  const backupSampleChanges = await backupStore.getChanges(
    sampleChanges.map(c => c.changeHash)
  );
  
  // Compare change contents
  for (let i = 0; i < sampleChanges.length; i++) {
    if (!changesEqual(sampleChanges[i], backupSampleChanges[i])) {
      console.error(`Change mismatch: ${sampleChanges[i].changeHash}`);
      return false;
    }
  }
  
  return true;
}
```

### Restore Testing

**Pattern**: Periodically test restore procedures

```typescript
async function testRestore(backupLocation: string) {
  // Create test environment
  const testTenant = await createTestTenant();
  const testDB = await testTenant.openDB("test");
  
  // Restore from backup
  const backupStore = await createStoreFromBackup(backupLocation);
  // Restore to test DB at store level
  const testStore = testDB.getStore();
  const testHashes = await backupStore.findNewChanges(
    await testStore.getAllChangeHashes()
  );
  if (testHashes.length > 0) {
    const changes = await backupStore.getChanges(testHashes);
    for (const change of changes) {
      await testStore.append(change);
    }
    await testDB.syncStoreChanges(testHashes);
  }
  
  // Verify restored data
  let docCount = 0;
  let sampleDoc: MindooDoc | null = null;
  await testDB.processChangesSince(null, 1000, (doc, cursor) => {
    if (docCount === 0) {
      sampleDoc = doc;
    }
    docCount++;
  }
  console.log(`Restored ${docCount} documents`);
  
  // Test document access
  if (sampleDoc) {
    const data = sampleDoc.getData();
    console.log("Sample document accessible:", !!data);
  }
  
  // Cleanup
  await cleanupTestEnvironment(testTenant);
}
```

## Compliance Considerations

### Backup Requirements

Many regulations require:
- **Regular Backups**: Scheduled backup procedures
- **Off-Site Storage**: Geographic redundancy
- **Retention Periods**: Keep backups for specified time
- **Verification**: Regular backup testing
- **Documentation**: Backup procedures documented

### Audit Trails

Backup operations should be logged:

```typescript
async function logBackupOperation(operation: BackupOperation) {
  await auditLogDB.createDocument();
  await auditLogDB.changeDoc(doc, (d) => {
    d.getData().type = "backup-operation";
    d.getData().operation = operation.type; // "full" | "incremental"
    d.getData().timestamp = Date.now();
    d.getData().location = operation.location;
    d.getData().changeCount = operation.changeCount;
    d.getData().performedBy = currentUserId;
  });
}
```

## Best Practices

### 1. Regular Backups

- Schedule regular full backups (e.g., weekly)
- Run incremental backups frequently (e.g., daily)
- Automate backup procedures
- Monitor backup success

### 2. Multiple Backup Locations

- Store backups in multiple locations
- Use different storage types (local, cloud, off-site)
- Test restore from each location
- Consider geographic distribution

### 3. Key Management

- Store keys separately from data
- Backup keys securely (encrypted, offline)
- Limit key backup access
- Test key recovery procedures

### 4. Verification

- Verify backup integrity regularly
- Test restore procedures periodically
- Document verification results
- Fix issues immediately

### 5. Documentation

- Document backup procedures
- Document recovery procedures
- Keep runbooks updated
- Train staff on procedures

## Related Patterns

- **[Sync Patterns](sync-patterns.md)** - Using sync for backup
- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing data for backup
- **[Access Control Patterns](access-control-patterns.md)** - Key backup strategies
- **[Compliance Patterns](compliance-patterns.md)** - Meeting backup requirements

## Conclusion

MindooDB's append-only architecture provides powerful backup and recovery capabilities:

1. **Simple Backups**: Copy entire store or use incremental backups
2. **Mirroring Without Keys**: Backup encrypted data without decryption
3. **Point-in-Time Recovery**: Reconstruct state at any point
4. **Multi-Site Replication**: Geographic redundancy
5. **Cryptographic Integrity**: Verify backup integrity

By leveraging these capabilities, you can implement robust backup and disaster recovery strategies that meet compliance requirements while maintaining security.
