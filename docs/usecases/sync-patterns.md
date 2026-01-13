# Sync Patterns

## Overview

MindooDB supports multiple synchronization patterns: peer-to-peer (P2P), client-server, and server-server. This document explores these patterns, how to implement them, and when to use each approach. It also covers sync without decryption, incremental sync, and offline-first workflows.

## Key Concepts

### Sync Mechanisms

MindooDB uses the `AppendOnlyStore` interface for synchronization:
- **findNewChanges()**: Compare change hashes to find missing changes
- **getChanges()**: Fetch actual change payloads
- **append()**: Store changes locally (handles deduplication)
- **pullChangesFrom()**: High-level method to pull from remote store
- **pushChangesTo()**: High-level method to push to remote store

### Sync Without Decryption

A powerful feature: sync encrypted data without decryption keys:
- Servers can mirror data they cannot read
- Peers can backup each other's encrypted data
- Perfect for disaster recovery
- Maintains end-to-end encryption

## P2P Synchronization

### Direct Client-to-Client Sync

**Pattern**: Two clients sync directly without a server

```typescript
// Client A and Client B want to sync
const clientADB = await tenant.openDB("shared");
const clientBDB = await tenant.openDB("shared");

// Client A pulls from Client B
await clientADB.pullChangesFrom(clientBDB.getStore());

// Client B pulls from Client A
await clientBDB.pullChangesFrom(clientADB.getStore());

// Both clients now have all changes
// Conflicts resolved by Automerge CRDTs
```

**Benefits:**
- No server required
- Direct communication
- Lower latency
- Works offline (when peers are nearby)

**Use Cases:**
- Local network collaboration
- Offline peer sync
- Mobile device sync
- Field operations

### P2P with Discovery

**Pattern**: Discover peers and sync automatically

```typescript
class P2PSyncManager {
  private peers: Map<string, AppendOnlyStore> = new Map();
  
  async discoverPeers() {
    // Use mDNS, Bluetooth, or manual discovery
    const discoveredPeers = await this.discoverLocalPeers();
    
    for (const peer of discoveredPeers) {
      this.peers.set(peer.id, peer.store);
    }
  }
  
  async syncWithAllPeers(db: MindooDB) {
    for (const [peerId, peerStore] of this.peers) {
      try {
        // Bidirectional sync
        await db.pullChangesFrom(peerStore);
        await db.pushChangesTo(peerStore);
      } catch (error) {
        console.error(`Sync failed with ${peerId}:`, error);
      }
    }
  }
}
```

**See**: [P2P Sync Documentation](../p2psync.md) for detailed implementation

## Client-Server Sync

### Centralized Server Pattern

**Pattern**: Multiple clients sync with a central server

```typescript
// Server setup
const serverStore = new ServerNetworkAppendOnlyStore(
  localStore,
  authenticationService
);

// Client setup
const clientStore = new ClientNetworkAppendOnlyStore(
  networkTransport,
  tenantId,
  dbId
);

// Client syncs with server
const clientDB = await tenant.openDB("main");
await clientDB.pullChangesFrom(clientStore);
await clientDB.pushChangesTo(clientStore);
```

**Benefits:**
- Centralized data storage
- Always-available server
- Easier to manage
- Good for cloud deployments

**Use Cases:**
- Cloud-based applications
- Mobile apps with backend
- Web applications
- Enterprise deployments

### Offline-First Client-Server

**Pattern**: Clients work offline, sync when connected

```typescript
class OfflineFirstSync {
  private db: MindooDB;
  private serverStore: AppendOnlyStore;
  private isOnline: boolean = false;
  
  async start() {
    // Check connectivity
    this.isOnline = await this.checkConnectivity();
    
    if (this.isOnline) {
      await this.sync();
    }
    
    // Monitor connectivity
    this.monitorConnectivity();
  }
  
  async sync() {
    if (!this.isOnline) {
      console.log("Offline - queuing sync");
      return;
    }
    
    try {
      // Pull from server
      await this.db.pullChangesFrom(this.serverStore);
      
      // Push to server
      await this.db.pushChangesTo(this.serverStore);
      
      console.log("Sync completed");
    } catch (error) {
      console.error("Sync failed:", error);
      // Will retry when connectivity restored
    }
  }
  
  private monitorConnectivity() {
    setInterval(async () => {
      const wasOnline = this.isOnline;
      this.isOnline = await this.checkConnectivity();
      
      if (!wasOnline && this.isOnline) {
        // Connectivity restored - sync
        await this.sync();
      }
    }, 5000); // Check every 5 seconds
  }
}
```

**Benefits:**
- Works offline
- Automatic sync when online
- No data loss
- Better user experience

## Server-Server Sync

### Multi-Server Replication

**Pattern**: Multiple servers replicate data

```typescript
class MultiServerReplication {
  private servers: Map<string, AppendOnlyStore> = new Map();
  
  async addServer(serverId: string, store: AppendOnlyStore) {
    this.servers.set(serverId, store);
  }
  
  async replicateAll() {
    const serverIds = Array.from(this.servers.keys());
    
    // Replicate each pair
    for (let i = 0; i < serverIds.length; i++) {
      for (let j = i + 1; j < serverIds.length; j++) {
        await this.replicatePair(serverIds[i], serverIds[j]);
      }
    }
  }
  
  private async replicatePair(serverIdA: string, serverIdB: string) {
    const storeA = this.servers.get(serverIdA)!;
    const storeB = this.servers.get(serverIdB)!;
    
    // Bidirectional sync
    const dbA = await this.getDBForStore(storeA);
    const dbB = await this.getDBForStore(storeB);
    
    await dbB.pullChangesFrom(storeA);
    await dbA.pullChangesFrom(storeB);
  }
}
```

**Benefits:**
- Geographic redundancy
- Load distribution
- Disaster recovery
- High availability

**Use Cases:**
- Multi-region deployments
- Data center replication
- High availability systems
- Disaster recovery

## Sync Without Decryption

### Encrypted Data Mirroring

**Pattern**: Mirror encrypted data without decryption keys

```typescript
// Server A has encrypted data (no keys)
// Server B wants to mirror it

const serverAStore = await createServerStore("server-a");
const serverBStore = await createServerStore("server-b");

// Server B pulls encrypted changes from Server A
await serverBStore.pullChangesFrom(serverAStore);

// Server B now has encrypted backup
// Cannot decrypt (no keys)
// Perfect for disaster recovery!
```

**Benefits:**
- Secure backups
- Servers don't need keys
- Disaster recovery
- Compliance with data protection

**Use Cases:**
- Backup servers
- Disaster recovery sites
- Multi-site replication
- Compliance requirements

### P2P Encrypted Backup

**Pattern**: Peers backup each other's encrypted data

```typescript
// Peer A and Peer B sync encrypted data
// Neither needs the other's keys

const peerADB = await tenantA.openDB("main");
const peerBDB = await tenantB.openDB("backup");

// Peer B pulls encrypted changes from Peer A
await peerBDB.pullChangesFrom(peerADB.getStore());

// Peer B has encrypted backup
// Cannot read the data
// Can restore if Peer A loses data
```

**Benefits:**
- Community backup networks
- Personal backup systems
- Distributed backup
- No key exposure

## Incremental Sync

### Using processChangesSince()

**Pattern**: Efficiently sync only new changes

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
  const sourceStore = sourceDB.getStore();
  
  // Get change hashes we need
  const targetHashes = await targetStore.getAllChangeHashes();
  const newHashes = await sourceStore.findNewChanges(targetHashes);
  
  if (newHashes.length === 0) {
    return lastSyncState; // No new changes
  }
  
  // Get actual changes
  const newChanges = await sourceStore.getChanges(newHashes);
  
  // Append to target
  for (const change of newChanges) {
    await targetStore.append(change);
  }
  
  // Update sync state
  const cursor = await sourceDB.processChangesSince(
    lastSyncState.lastSyncCursor,
    1,
    (doc, currentCursor) => {
      return false; // Just get cursor
    }
  );
  
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

### Scheduled Incremental Sync

**Pattern**: Sync on a schedule

```typescript
class ScheduledSync {
  private syncInterval: number = 60 * 60 * 1000; // 1 hour
  private syncStates: Map<string, SyncState> = new Map();
  
  async startScheduledSync(
    syncId: string,
    sourceDB: MindooDB,
    targetStore: AppendOnlyStore
  ) {
    // Initial sync
    const state = await incrementalSync(sourceDB, targetStore, {
      lastSyncCursor: null,
      lastSyncTimestamp: 0
    });
    this.syncStates.set(syncId, state);
    
    // Schedule periodic sync
    setInterval(async () => {
      const lastState = this.syncStates.get(syncId)!;
      const newState = await incrementalSync(sourceDB, targetStore, lastState);
      this.syncStates.set(syncId, newState);
    }, this.syncInterval);
  }
}
```

## Conflict Resolution

### Automerge CRDTs

MindooDB uses Automerge CRDTs for automatic conflict resolution:

```typescript
// Client A and Client B modify same document offline
// Client A changes field X
await clientADB.changeDoc(sharedDoc, (d) => {
  d.getData().fieldX = "value from A";
});

// Client B changes field Y (different field)
await clientBDB.changeDoc(sharedDoc, (d) => {
  d.getData().fieldY = "value from B";
});

// Sync both ways
await clientBDB.pullChangesFrom(clientADB.getStore());
await clientADB.pullChangesFrom(clientBDB.getStore());

// Both changes preserved (different fields)
// Automerge automatically merges
```

**Benefits:**
- Automatic conflict resolution
- No manual merge required
- Works offline
- Preserves all changes

### Handling Concurrent Edits

**Pattern**: Automerge handles concurrent edits automatically

```typescript
// Multiple users edit same document
// User A: changes title
await dbA.changeDoc(doc, (d) => {
  d.getData().title = "New Title A";
});

// User B: changes content (same time)
await dbB.changeDoc(doc, (d) => {
  d.getData().content = "New Content B";
});

// Sync
await dbB.pullChangesFrom(dbA.getStore());
await dbA.pullChangesFrom(dbB.getStore());

// Both changes preserved
// Automerge merges automatically
// No conflicts!
```

## Offline-First Workflows

### Local-First Data Creation

**Pattern**: Create data locally, sync when available

```typescript
class OfflineFirstApp {
  private db: MindooDB;
  private serverStore: AppendOnlyStore | null = null;
  
  async createDocument(data: any): Promise<MindooDoc> {
    // Always create locally first
    const doc = await this.db.createDocument();
    await this.db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    
    // Try to sync if online
    if (this.serverStore) {
      try {
        await this.db.pushChangesTo(this.serverStore);
      } catch (error) {
        console.log("Offline - will sync later");
      }
    }
    
    return doc;
  }
  
  async syncWhenOnline() {
    if (!this.serverStore) return;
    
    try {
      await this.db.pullChangesFrom(this.serverStore);
      await this.db.pushChangesTo(this.serverStore);
    } catch (error) {
      console.error("Sync failed:", error);
    }
  }
}
```

### Periodic Sync

**Pattern**: Sync periodically in background

```typescript
class PeriodicSync {
  private db: MindooDB;
  private serverStore: AppendOnlyStore;
  private interval: number = 5 * 60 * 1000; // 5 minutes
  
  start() {
    // Initial sync
    this.sync();
    
    // Periodic sync
    setInterval(() => {
      this.sync();
    }, this.interval);
  }
  
  private async sync() {
    try {
      await this.db.pullChangesFrom(this.serverStore);
      await this.db.pushChangesTo(this.serverStore);
    } catch (error) {
      console.error("Background sync failed:", error);
      // Will retry on next interval
    }
  }
}
```

## Hybrid Patterns

### Combining P2P and Client-Server

**Pattern**: Use both P2P and server sync

```typescript
class HybridSync {
  private db: MindooDB;
  private serverStore: AppendOnlyStore | null = null;
  private peerStores: AppendOnlyStore[] = [];
  
  async sync() {
    // Sync with server if available
    if (this.serverStore) {
      await this.db.pullChangesFrom(this.serverStore);
      await this.db.pushChangesTo(this.serverStore);
    }
    
    // Sync with peers
    for (const peerStore of this.peerStores) {
      try {
        await this.db.pullChangesFrom(peerStore);
        await this.db.pushChangesTo(peerStore);
      } catch (error) {
        console.error("Peer sync failed:", error);
      }
    }
  }
}
```

**Benefits:**
- Best of both worlds
- Server for reliability
- P2P for speed
- Redundant sync paths

## Best Practices

### 1. Handle Errors Gracefully

- Retry failed syncs
- Log errors for debugging
- Continue with other syncs
- Notify users of issues

### 2. Monitor Sync Status

- Track sync success/failure
- Monitor sync performance
- Log sync operations
- Alert on persistent failures

### 3. Optimize Sync Frequency

- Balance freshness and performance
- Use incremental sync
- Schedule appropriately
- Consider user activity

### 4. Security Considerations

- Verify peer/server identity
- Use secure channels
- Monitor for unusual activity
- Regularly review access

### 5. Test Offline Scenarios

- Test offline operation
- Test sync after offline
- Test conflict resolution
- Verify data integrity

## Related Patterns

- **[Cross-Tenant Collaboration](cross-tenant-collaboration.md)** - Multi-tenant sync
- **[Backups and Recovery](backups-and-recovery.md)** - Using sync for backup
- **[P2P Sync Documentation](../p2psync.md)** - Detailed P2P implementation
- **[Network Sync Protocol](../network-sync-protocol.md)** - Client-server protocol

## Conclusion

MindooDB supports flexible synchronization patterns:

1. **P2P Sync** for direct client-to-client communication
2. **Client-Server Sync** for centralized deployments
3. **Server-Server Sync** for multi-site replication
4. **Sync Without Decryption** for secure backups
5. **Incremental Sync** for efficient data transfer
6. **Offline-First** for resilient applications

By choosing the right sync pattern for your use case, you can build robust, scalable applications that work reliably across different network conditions and deployment scenarios.
