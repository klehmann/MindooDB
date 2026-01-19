# P2P Synchronization Concept

## Overview

MindooDB's architecture is already designed to support peer-to-peer (P2P) synchronization. The `ContentAddressedStore` interface provides a clean abstraction that allows different implementations—including network-backed stores that communicate with remote peers.

This document outlines how to implement P2P sync for MindooDB, focusing on mobile applications (iOS/Android) using JavaScript/TypeScript.

## How P2P Sync Works with MindooDB

### Existing Architecture

MindooDB's sync mechanism is already P2P-ready through the `ContentAddressedStore` interface:

1. **Entry Exchange**: Peers exchange lists of entry IDs they have
2. **Missing Entries**: Each peer identifies which entries they're missing
3. **Entry Transfer**: Missing entries are requested and transferred
4. **Local Processing**: Entries are stored locally and processed

The key methods that enable this are:

- `findNewEntries(knownIds)`: Find entries the remote has that we don't
- `getEntries(ids)`: Fetch the actual entry payloads
- `putEntries(entries)`: Store entries locally (handles deduplication)

### High-Level Sync Flow

```typescript
// Client A wants to sync with Client B
const dbA = await tenant.openDB("contacts");
const dbB = await tenant.openDB("contacts");

// Client A pulls entries from Client B
await dbA.pullChangesFrom(dbB.getStore());

// Client B pulls entries from Client A
await dbB.pullChangesFrom(dbA.getStore());
```

The `pullChangesFrom()` and `pushChangesTo()` methods in `BaseMindooDB` handle the complete sync flow:

1. Compare entry IDs between local and remote stores
2. Identify missing entries
3. Transfer missing entries
4. Store in local store (with deduplication)
5. Process entries to update document state

### Network-Backed Store Pattern

To enable P2P sync, you need a `NetworkContentAddressedStore` that:

- Implements the `ContentAddressedStore` interface
- Wraps a local store (for caching and offline operation)
- Communicates with remote peers over the network
- Handles connection management and error recovery

The network store acts as a proxy: it checks the local store first, then queries remote peers for missing data.

## Tech Stack Recommendations

### Option 1: React Native (Recommended for Beginners)

**Best for**: Cross-platform mobile apps (iOS + Android) with a single codebase.

**Tech Stack:**
- **React Native**: Mobile app framework
- **TypeScript**: Already using it
- **react-native-webrtc**: P2P networking via WebRTC
- **react-native-zeroconf**: Local peer discovery via mDNS/Bonjour

**Pros:**
- Single codebase for iOS and Android
- Large community and ecosystem
- Can reuse web code patterns
- WebRTC works excellently for P2P

**Cons:**
- Larger app size
- Some native modules may be needed

**When to use**: Starting from scratch, need both iOS and Android, want fastest development.

### Option 2: Capacitor (Web-First Approach)

**Best for**: If you already have or plan to have a web app.

**Tech Stack:**
- **Capacitor**: Wraps web apps as native apps
- **TypeScript**: Already using it
- **WebRTC**: Built-in browser support
- **mDNS**: Via Web APIs or plugins

**Pros:**
- Share code with web version
- WebRTC works in browsers
- Easier if you have web experience

**Cons:**
- Performance may be lower than native
- Some native features require plugins

**When to use**: Have existing web app, want to share codebase, web-first approach.

### Option 3: Native with TypeScript (Advanced)

**Best for**: Maximum performance and platform integration.

**Tech Stack:**
- **Swift (iOS) / Kotlin (Android)**: Native apps
- **TypeScript via JSI bridge**: Share business logic
- **Native WebRTC**: Platform WebRTC libraries
- **Native mDNS**: Platform discovery APIs

**Pros:**
- Best performance
- Full platform access

**Cons:**
- More complex
- Separate codebases or complex bridging

**When to use**: Need maximum performance, have native development expertise.

## P2P Networking Libraries

### WebRTC (Recommended)

**Why**: Works in browsers and mobile, handles NAT traversal, encrypted by default.

**Libraries:**
- `simple-peer` (Node.js/browser): Simple WebRTC wrapper
- `react-native-webrtc` (React Native): WebRTC for mobile
- Native WebRTC: iOS/Android SDKs

**How it works:**
1. Signaling server (or mDNS) for initial connection
2. WebRTC establishes direct P2P connection
3. Exchange data over the connection

**Pros:**
- Industry standard
- Handles NAT traversal automatically
- Encrypted by default
- Works across platforms

**Cons:**
- Requires signaling for initial connection
- Can be complex for beginners

### libp2p (Advanced)

**Why**: More features, but more complex.

**Libraries:**
- `js-libp2p`: JavaScript implementation
- `@libp2p/webrtc`: WebRTC transport for libp2p

**Pros:**
- Multiple transports (WebRTC, WebSocket, etc.)
- Built-in peer discovery
- DHT for peer routing

**Cons:**
- Steeper learning curve
- Larger bundle size

**When to use**: Need advanced features like DHT routing, multiple transport protocols.

### WebSocket (Simple Alternative)

**Why**: Simpler than WebRTC, but requires a relay server.

**Libraries:**
- `ws` (Node.js)
- Native WebSocket APIs

**Pros:**
- Simple to implement
- Works everywhere

**Cons:**
- Requires a relay server (not true P2P)
- Less efficient than direct P2P

**When to use**: Simple use cases, have a relay server available.

## Peer Discovery Options

### 1. mDNS/Bonjour (Local Network)

**Best for**: Nearby devices on the same WiFi/LAN.

**Libraries:**
- `react-native-zeroconf` (React Native)
- `bonjour` (Node.js)
- Native mDNS APIs (iOS/Android)

**How it works:**
- Devices broadcast their presence on the local network
- Peers discover each other automatically
- No central server needed

**Pros:**
- Automatic discovery
- No server required
- Works on local network

**Cons:**
- Only works on same network
- May require network permissions

### 2. Bluetooth Low Energy (BLE)

**Best for**: Very close proximity (same room).

**Libraries:**
- `react-native-ble-manager` (React Native)
- Native BLE APIs

**Pros:**
- Works without WiFi
- Low power

**Cons:**
- Limited range (~10 meters)
- Lower bandwidth

**When to use**: Need to work without network, very close proximity.

### 3. QR Codes / Manual Entry

**Best for**: Initial connection setup.

**How it works:**
- One device shows a QR code with connection info
- Other device scans it
- Establishes direct connection

**Pros:**
- Simple to implement
- Works across networks
- Secure (manual verification)

**Cons:**
- Manual process
- Not automatic

**When to use**: Initial pairing, cross-network connections.

### 4. Hybrid Approach (Recommended)

Combine multiple methods:

1. **mDNS** for automatic discovery on same network
2. **QR codes** for initial pairing
3. **Manual IP entry** as fallback

This provides the best user experience with automatic discovery when possible, and manual options when needed.

## Implementation Architecture

### NetworkContentAddressedStore Pattern

The network-backed store wraps a local store and adds network communication:

```typescript
// NetworkContentAddressedStore.ts
import { ContentAddressedStore } from './types';
import { StoreEntry, StoreEntryMetadata } from '../types';

/**
 * Network-backed ContentAddressedStore that communicates with remote peers
 * over WebRTC or other P2P protocols.
 */
export class NetworkContentAddressedStore implements ContentAddressedStore {
  private dbId: string;
  private localStore: ContentAddressedStore; // Local cache
  private peerConnection: PeerConnection; // WebRTC or other P2P connection
  
  constructor(dbId: string, localStore: ContentAddressedStore, peerConnection: PeerConnection) {
    this.dbId = dbId;
    this.localStore = localStore;
    this.peerConnection = peerConnection;
  }
  
  getId(): string {
    return this.dbId;
  }
  
  async putEntries(entries: StoreEntry[]): Promise<void> {
    // Always store locally first
    await this.localStore.putEntries(entries);
    
    // Then send to remote peer (if connected)
    if (this.peerConnection.isConnected()) {
      await this.peerConnection.send('putEntries', entries);
    }
  }
  
  async findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    // Check local store first
    const localNew = await this.localStore.findNewEntries(knownIds);
    
    // Also check remote peer
    if (this.peerConnection.isConnected()) {
      const remoteNew = await this.peerConnection.request('findNewEntries', knownIds);
      // Merge and deduplicate by entry ID
      return this.mergeEntryMetadata(localNew, remoteNew);
    }
    
    return localNew;
  }
  
  async findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    // Check local store first
    const localNew = await this.localStore.findNewEntriesForDoc(knownIds, docId);
    
    // Also check remote peer
    if (this.peerConnection.isConnected()) {
      const remoteNew = await this.peerConnection.request('findNewEntriesForDoc', { knownIds, docId });
      return this.mergeEntryMetadata(localNew, remoteNew);
    }
    
    return localNew;
  }
  
  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    // Try local store first
    const localEntries = await this.localStore.getEntries(ids);
    const localIds = new Set(localEntries.map(e => e.id));
    
    // Find missing entries
    const missingIds = ids.filter(id => !localIds.has(id));
    
    if (missingIds.length > 0 && this.peerConnection.isConnected()) {
      // Fetch from remote
      const remoteEntries = await this.peerConnection.request('getEntries', missingIds);
      // Cache locally
      await this.localStore.putEntries(remoteEntries);
      return [...localEntries, ...remoteEntries];
    }
    
    return localEntries;
  }
  
  async hasEntries(ids: string[]): Promise<string[]> {
    // Check local store first
    const localHas = await this.localStore.hasEntries(ids);
    const localSet = new Set(localHas);
    
    // Check remote for any IDs we don't have locally
    const notLocal = ids.filter(id => !localSet.has(id));
    
    if (notLocal.length > 0 && this.peerConnection.isConnected()) {
      const remoteHas = await this.peerConnection.request('hasEntries', notLocal);
      return [...localHas, ...remoteHas];
    }
    
    return localHas;
  }
  
  async getAllIds(): Promise<string[]> {
    // Merge local and remote
    const local = await this.localStore.getAllIds();
    
    if (this.peerConnection.isConnected()) {
      const remote = await this.peerConnection.request('getAllIds', []);
      // Deduplicate
      return [...new Set([...local, ...remote])];
    }
    
    return local;
  }
  
  async resolveDependencies(
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    // Prefer remote resolution (more efficient - single round trip)
    if (this.peerConnection.isConnected()) {
      return await this.peerConnection.request('resolveDependencies', { startId, options });
    }
    
    // Fall back to local resolution
    return this.localStore.resolveDependencies(startId, options);
  }
  
  async purgeDocHistory(docId: string): Promise<void> {
    // Purge locally
    await this.localStore.purgeDocHistory(docId);
    
    // Request purge on remote (if connected)
    if (this.peerConnection.isConnected()) {
      await this.peerConnection.send('purgeDocHistory', docId);
    }
  }
  
  private mergeEntryMetadata(a: StoreEntryMetadata[], b: StoreEntryMetadata[]): StoreEntryMetadata[] {
    const seen = new Set<string>();
    const result: StoreEntryMetadata[] = [];
    
    for (const entry of [...a, ...b]) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        result.push(entry);
      }
    }
    
    return result;
  }
}
```

### PeerConnection Interface

The `PeerConnection` abstraction handles the network layer:

```typescript
interface PeerConnection {
  isConnected(): boolean;
  send(method: string, data: any): Promise<void>;
  request(method: string, data: any): Promise<any>;
  on(event: 'connect' | 'disconnect' | 'error', handler: Function): void;
  connect(peerInfo: PeerInfo): Promise<void>;
  disconnect(): void;
}
```

Different implementations can use WebRTC, WebSocket, or other protocols.

### Hybrid Local + Network Store

The recommended pattern is to use a hybrid store that:

1. **Always checks local first**: Fast, works offline
2. **Falls back to network**: Fetches missing data from peers
3. **Caches network data**: Stores fetched entries locally
4. **Handles disconnections**: Gracefully degrades to local-only

This provides:
- **Offline-first**: Works without network
- **Efficient sync**: Only transfers missing entries
- **Automatic caching**: Network data becomes local
- **Resilient**: Handles network failures

## Recommended Starting Point

For beginners, we recommend:

1. **React Native** with TypeScript
2. **react-native-webrtc** for P2P networking
3. **react-native-zeroconf** for mDNS discovery
4. **Hybrid local + network store** pattern

This provides:
- Cross-platform support (iOS + Android)
- Excellent P2P networking
- Automatic peer discovery
- TypeScript throughout
- Good developer experience

### Implementation Steps

1. **Set up React Native project** with TypeScript
2. **Implement PeerConnection wrapper** around WebRTC
3. **Implement NetworkContentAddressedStore** that wraps local store
4. **Add mDNS discovery** for automatic peer finding
5. **Use existing sync methods**: `pullChangesFrom()` / `pushChangesTo()`

The key advantage: your existing `BaseMindooDB` code doesn't need to change—just swap in a `NetworkContentAddressedStore` instead of `InMemoryContentAddressedStore`.

## Protocol Design

### Message Types

The network protocol needs to support the `ContentAddressedStore` operations:

1. **findNewEntries**: Request missing entries
2. **getEntries**: Fetch entry payloads
3. **getAllIds**: Get all entry IDs
4. **findNewEntriesForDoc**: Get entries for a specific document
5. **putEntries**: Push new entries (optional, for real-time sync)
6. **hasEntries**: Check which entry IDs exist
7. **resolveDependencies**: Traverse entry dependency chains

### Message Format

```typescript
interface NetworkMessage {
  id: string; // Request ID for correlation
  method: string; // Method name
  params: any; // Method parameters
  response?: any; // Response data (for replies)
  error?: string; // Error message (for errors)
}
```

### Connection Flow

1. **Discovery**: Find peers via mDNS or manual entry
2. **Connection**: Establish WebRTC connection
3. **Authentication**: Verify peer identity (optional, using tenant keys)
4. **Sync**: Exchange entries using `ContentAddressedStore` methods
5. **Maintenance**: Keep connection alive, handle reconnection

## Security Considerations

### Peer Authentication

While MindooDB uses cryptographic signatures for entry verification, you may want to verify peer identity:

- **Tenant-based**: Only sync with peers in the same tenant
- **Key exchange**: Exchange public keys during connection
- **Certificate pinning**: Pin peer certificates for trusted devices

### Encryption

- **WebRTC**: Encrypted by default (DTLS)
- **Application layer**: Additional encryption if needed
- **Entry payloads**: Already encrypted by MindooDB

### Network Security

- **Local network**: mDNS only works on local network (safer)
- **Public networks**: Use QR codes or manual pairing
- **VPN**: Consider VPN for additional security

## Performance Considerations

### Entry Batching

For efficiency, batch multiple entries:

- Send multiple entry IDs in one request
- Fetch multiple entries in one response
- Use compression for large payloads

### Incremental Sync

- Only sync missing entries (already handled by `findNewEntries`)
- Use snapshots to reduce entry count
- Track sync state to avoid redundant transfers

### Connection Management

- **Connection pooling**: Reuse connections when possible
- **Connection timeout**: Close idle connections
- **Reconnection**: Automatic reconnection on failure

## Future Enhancements

### Multi-Peer Sync

Extend to sync with multiple peers simultaneously:

- **Mesh topology**: Each peer connects to multiple peers
- **Entry propagation**: Entries propagate through the mesh
- **Conflict resolution**: Already handled by Automerge CRDTs

### Relay Servers

For peers that can't establish direct connections:

- **TURN servers**: For NAT traversal
- **Relay nodes**: Forward messages between peers
- **Hybrid**: Direct P2P when possible, relay when needed

### Background Sync

Sync in the background without user interaction:

- **Periodic sync**: Sync on a schedule
- **Event-driven**: Sync on network changes
- **Battery-aware**: Reduce sync frequency on low battery

## Conclusion

MindooDB's architecture is well-suited for P2P synchronization. The `ContentAddressedStore` interface provides a clean abstraction that allows network-backed implementations without changing the core database code.

The recommended approach is:
1. Use React Native for cross-platform mobile apps
2. Implement WebRTC-based P2P networking
3. Use mDNS for automatic peer discovery
4. Create a `NetworkContentAddressedStore` that wraps a local store
5. Leverage existing sync methods (`pullChangesFrom`, `pushChangesTo`)

This provides a solid foundation for P2P sync while maintaining the security and integrity guarantees of MindooDB.

