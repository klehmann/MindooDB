# Sync Patterns

## Overview

MindooDB supports multiple synchronization patterns: peer-to-peer (P2P), client-server, and server-server. This document explores these patterns, how to implement them, and when to use each approach. It also covers sync without decryption, incremental sync, and offline-first workflows.

## Key Concepts

### Sync Mechanisms

MindooDB synchronization operates at the store level through the `ContentAddressedStore` interface. Understanding this interface is essential for implementing sync patterns.

**findNewChanges(existingHashes)** compares your local change hashes against another set of hashes (typically from a remote store) to identify which changes are missing locally. This is the foundation of incremental sync—you only transfer what's actually needed.

**getChanges(hashes)** retrieves the actual change payloads for a set of hashes. Once you know which changes are missing, this method fetches the encrypted change data.

**append(entry)** stores a change locally. The store handles deduplication automatically—if a change with the same hash already exists, it's ignored rather than duplicated.

**syncStoreChanges(newHashes)** on the `MindooDB` interface processes newly synced changes, updating the in-memory document cache and triggering any change callbacks.

The typical sync flow is: (1) find new changes the local store is missing, (2) fetch those changes from the remote store, (3) append them to the local store, (4) notify the database to process the new changes.

### Sync Without Decryption

One of MindooDB's most powerful features is the ability to synchronize encrypted data without possessing the decryption keys.

Because all changes are stored as encrypted entries with cryptographic hashes, a server or peer can store and forward these entries without ever reading the actual content. The server sees only encrypted bytes and hash identifiers. This enables several important patterns: servers can mirror data they cannot read, peers can back up each other's encrypted data, and disaster recovery systems can replicate entire databases while maintaining complete data privacy.

This capability is fundamental to MindooDB's security model—it means you can use untrusted infrastructure for storage and synchronization while maintaining true end-to-end encryption.

## P2P Synchronization

### Direct Client-to-Client Sync

Peer-to-peer synchronization allows two clients to exchange changes directly without routing through a server. This is ideal for local network scenarios, mobile device sync, or environments where server connectivity is unavailable.

**Pattern**: Two clients sync directly without a server

```typescript
/**
 * Utility function to sync changes from one store to another.
 * Returns the number of new changes transferred.
 */
async function syncStores(
  sourceStore: ContentAddressedStore,
  targetStore: ContentAddressedStore,
  targetDB: MindooDB
): Promise<number> {
  // Find changes that target is missing
  const targetHashes = await targetStore.getAllChangeHashes();
  const newHashes = await sourceStore.findNewChanges(targetHashes);
  
  if (newHashes.length === 0) {
    return 0;
  }
  
  // Transfer missing changes
  const changes = await sourceStore.getChanges(newHashes);
  for (const change of changes) {
    await targetStore.append(change);
  }
  
  // Notify database to process new changes
  await targetDB.syncStoreChanges(newHashes);
  
  return newHashes.length;
}

// Client A and Client B want to sync their "shared" database
const clientADB = await tenantA.openDB("shared");
const clientBDB = await tenantB.openDB("shared");

const storeA = clientADB.getStore();
const storeB = clientBDB.getStore();

// Client A pulls from Client B
const pulledByA = await syncStores(storeB, storeA, clientADB);
console.log(`Client A received ${pulledByA} changes from Client B`);

// Client B pulls from Client A
const pulledByB = await syncStores(storeA, storeB, clientBDB);
console.log(`Client B received ${pulledByB} changes from Client A`);

// Both clients now have all changes
// Any conflicts are automatically resolved by Automerge CRDTs
```

**Benefits:**
- No server required—clients communicate directly
- Lower latency for local network scenarios
- Works when peers are nearby but internet is unavailable
- Complete privacy—no central server sees the data

**Use Cases:**
- Local network collaboration in offices or conferences
- Offline peer sync in the field
- Mobile device sync over Bluetooth or local WiFi
- Field operations in areas without internet

### P2P with Discovery

In real-world P2P scenarios, you need a mechanism to discover available peers. This can use mDNS for local network discovery, Bluetooth for nearby devices, or a lightweight discovery server that only facilitates connections.

**Pattern**: Discover peers and sync automatically

```typescript
class P2PSyncManager {
  private peers: Map<string, ContentAddressedStore> = new Map();
  
  async discoverPeers(): Promise<void> {
    // Discovery mechanism depends on environment:
    // - mDNS for local network (e.g., using Bonjour)
    // - Bluetooth scanning for nearby mobile devices
    // - WebRTC signaling server for web applications
    const discoveredPeers = await this.discoverLocalPeers();
    
    for (const peer of discoveredPeers) {
      this.peers.set(peer.id, peer.store);
      console.log(`Discovered peer: ${peer.id}`);
    }
  }
  
  async syncWithAllPeers(db: MindooDB): Promise<void> {
    const localStore = db.getStore();
    
    for (const [peerId, peerStore] of this.peers) {
      try {
        console.log(`Syncing with peer: ${peerId}`);
        
        // Pull changes from peer
        await syncStores(peerStore, localStore, db);
        
        // Push our changes to peer (requires peer to have a way to receive)
        const ourNewHashes = await localStore.findNewChanges(
          await peerStore.getAllChangeHashes()
        );
        
        if (ourNewHashes.length > 0) {
          const ourChanges = await localStore.getChanges(ourNewHashes);
          for (const change of ourChanges) {
            await peerStore.append(change);
          }
        }
        
        console.log(`Sync complete with ${peerId}`);
      } catch (error) {
        console.error(`Sync failed with ${peerId}:`, error);
        // Continue with other peers even if one fails
      }
    }
  }
  
  private async discoverLocalPeers(): Promise<Array<{ id: string; store: ContentAddressedStore }>> {
    // Implementation depends on the discovery mechanism
    // This is a placeholder for actual discovery logic
    return [];
  }
}
```

**See**: [P2P Sync Documentation](../p2psync.md) for detailed implementation guidance

## Client-Server Sync

### Centralized Server Pattern

Client-server synchronization is the most common pattern for cloud-based applications. Multiple clients connect to a central server that stores the authoritative copy of the database. The server can mirror encrypted data without possessing decryption keys.

**Pattern**: Multiple clients sync with a central server

```typescript
// Server-side: The server wraps a local store with network capabilities
// See examples/server for a complete implementation
const serverStore = new ServerNetworkAppendOnlyStore(
  localStore,           // The server's local storage
  authenticationService // Validates client credentials
);

// Client-side: The client uses a network transport to communicate with the server
const clientNetworkStore = new ClientNetworkAppendOnlyStore(
  networkTransport,  // HTTP, WebSocket, or custom transport
  tenantId,
  dbId
);

// Client syncs with server using the standard sync pattern
const clientDB = await tenant.openDB("main");
const localStore = clientDB.getStore();

// Pull changes from server
const serverHashes = await clientNetworkStore.getAllChangeHashes();
const newFromServer = await clientNetworkStore.findNewChanges(
  await localStore.getAllChangeHashes()
);

if (newFromServer.length > 0) {
  const serverChanges = await clientNetworkStore.getChanges(newFromServer);
  for (const change of serverChanges) {
    await localStore.append(change);
  }
  await clientDB.syncStoreChanges(newFromServer);
}

// Push local changes to server
const newForServer = await localStore.findNewChanges(serverHashes);
if (newForServer.length > 0) {
  const localChanges = await localStore.getChanges(newForServer);
  for (const change of localChanges) {
    await clientNetworkStore.append(change);
  }
}
```

**Benefits:**
- Centralized data storage simplifies operations
- Server is always available for sync (when online)
- Easier to manage backups and monitoring
- Good for cloud deployments and SaaS applications

**Use Cases:**
- Cloud-based applications with mobile and web clients
- Mobile apps with a backend API
- Web applications requiring persistence
- Enterprise deployments with centralized IT management

### Offline-First Client-Server

The offline-first pattern ensures applications remain fully functional without network connectivity, syncing changes when connectivity returns.

**Pattern**: Clients work offline, sync when connected

```typescript
class OfflineFirstSync {
  private db: MindooDB;
  private serverStore: ContentAddressedStore;
  private isOnline: boolean = false;
  private syncInProgress: boolean = false;
  
  constructor(db: MindooDB, serverStore: ContentAddressedStore) {
    this.db = db;
    this.serverStore = serverStore;
  }
  
  async start(): Promise<void> {
    // Check initial connectivity
    this.isOnline = await this.checkConnectivity();
    
    if (this.isOnline) {
      await this.sync();
    }
    
    // Monitor connectivity changes
    this.monitorConnectivity();
  }
  
  private async checkConnectivity(): Promise<boolean> {
    try {
      // Attempt to reach server
      await this.serverStore.getAllChangeHashes();
      return true;
    } catch (error) {
      return false;
    }
  }
  
  private monitorConnectivity(): void {
    // In a browser environment, use online/offline events
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleOnline());
      window.addEventListener('offline', () => this.handleOffline());
    }
    
    // Periodically check connectivity as backup
    setInterval(async () => {
      const wasOnline = this.isOnline;
      this.isOnline = await this.checkConnectivity();
      
      if (!wasOnline && this.isOnline) {
        await this.handleOnline();
      }
    }, 30000); // Check every 30 seconds
  }
  
  private async handleOnline(): Promise<void> {
    console.log('Connection restored, syncing...');
    this.isOnline = true;
    await this.sync();
  }
  
  private handleOffline(): void {
    console.log('Connection lost, working offline');
    this.isOnline = false;
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

### Using iterateChangesSince()

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
  
  // Update sync state - iterate to the end to get latest cursor
  let cursor = lastSyncState.lastSyncCursor;
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
