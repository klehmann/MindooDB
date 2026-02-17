# Peer-to-Peer Sync and Advanced Network Topologies

## Why This Document Exists

The network synchronization protocol (see [network-sync-protocol.md](network-sync-protocol.md)) describes how a client synchronizes encrypted entries with a server. But MindooDB's architecture was not designed for client-server alone. The same protocol, the same entry format, and the same `ContentAddressedStore` interface that power server sync also enable peer-to-peer communication, multi-hop relay chains, and network topologies where data flows through nodes that cannot read it.

This document explains the design decisions that make these advanced topologies possible, walks through the most useful patterns, and discusses when each one is the right choice.

---

## 1) The Design Insight That Makes This Work

MindooDB's sync protocol operates on encrypted entries. Every entry payload is encrypted with a symmetric key (AES-256-GCM) before it enters the store. The sync layer never needs to decrypt that payload — it only reads metadata (entry ID, content hash, timestamps, signatures) to figure out what is missing and where to send it.

This means that any node in the network can participate in sync without being able to read the data it is transferring. A server, a relay, or another client can store and forward entries faithfully even if it has no access to the decryption keys. The entry's cryptographic signature ensures integrity regardless of how many hops it takes.

This is not an accidental side effect. It is a deliberate architectural choice: by separating the sync concern (moving encrypted bytes) from the application concern (decrypting and interpreting those bytes), MindooDB enables topologies that would be impossible in systems where the transport layer needs access to plaintext.

---

## 2) The Interface That Enables Composition

At the center of MindooDB's flexibility is the `ContentAddressedStore` interface. Every store — whether backed by local disk, in-memory data, or a remote network connection — implements this same interface. The sync methods `pullChangesFrom()` and `pushChangesTo()` accept any `ContentAddressedStore`, which means they work identically regardless of whether the other side is a local store, a remote server, or another client connected over WebRTC.

Two components make network composition possible:

**`ClientNetworkContentAddressedStore`** implements `ContentAddressedStore` and acts as a remote proxy. From the caller's perspective, it looks and behaves like a local store, but internally it forwards every operation over a network transport to a remote endpoint. It handles authentication, capability negotiation, and RSA payload decryption transparently.

**`ServerNetworkContentAddressedStore`** accepts incoming sync requests and delegates them to a local `ContentAddressedStore`. The critical detail is in that constructor parameter: the "local store" it delegates to can be any `ContentAddressedStore` implementation — including another `ClientNetworkContentAddressedStore` that points somewhere else.

This composability is what unlocks every topology described in this document.

---

## 3) Standard Client-Server Sync

Before exploring advanced topologies, it helps to understand the baseline that everything builds on.

In the simplest deployment, a client has a local store (on disk or in memory) and syncs with a server that also has a local store. The client creates a `ClientNetworkContentAddressedStore` pointing at the server, and calls `pullChangesFrom()` to fetch missing entries or `pushChangesTo()` to upload local entries.

```
┌──────────┐         HTTPS/TLS         ┌──────────┐
│  Client   │ ◄──────────────────────► │  Server   │
│           │                           │           │
│ LocalStore│                           │ LocalStore│
└──────────┘                           └──────────┘
```

The server's `ServerNetworkContentAddressedStore` validates the client's JWT token, looks up entries in its local store, RSA-encrypts the payloads for the requesting client, and returns them. The client decrypts the RSA layer and stores the entries locally.

This is covered in detail in [network-sync-protocol.md](network-sync-protocol.md). The rest of this document builds on this foundation.

---

## 4) Direct Peer-to-Peer Sync

In a peer-to-peer scenario, two clients sync directly without a central server. This works because both sides of the sync use the same `ContentAddressedStore` interface.

### How it works

Each peer runs a lightweight server component that wraps its local store with a `ServerNetworkContentAddressedStore`. The other peer connects to it via a `ClientNetworkContentAddressedStore`. The transport can be HTTP over a local network, WebRTC for NAT traversal, or any other mechanism that implements the `NetworkTransport` interface.

```
┌──────────┐       WebRTC / LAN        ┌──────────┐
│  Peer A   │ ◄──────────────────────► │  Peer B   │
│           │                           │           │
│ LocalStore│                           │ LocalStore│
│ + Server  │                           │ + Server  │
└──────────┘                           └──────────┘
```

Both peers can act as client and server simultaneously. Peer A pulls from Peer B, then Peer B pulls from Peer A. After both operations complete, both peers have the same set of entries.

### Why this design was chosen

Many P2P sync systems require a custom protocol that is fundamentally different from their client-server protocol. MindooDB avoids this by making the same `ContentAddressedStore` interface serve both roles. A peer does not need a different sync implementation for P2P — it reuses the same `pullChangesFrom()` and `pushChangesTo()` methods, the same capability negotiation, and the same reconciliation logic. The only thing that changes is the transport layer underneath.

### When to use this

Direct P2P sync is ideal when two devices are on the same network (or can establish a direct WebRTC connection) and you want to sync without depending on a central server. Common scenarios include field teams syncing tablets at a job site, or two users exchanging updates in a meeting room.

---

## 5) Relay and Passthrough Nodes

This is where MindooDB's architecture enables something unusual: a node that participates in sync without being able to read the data it handles.

### The relay pattern

Consider three users: Alice, Bob, and Carol. Alice and Carol share encrypted documents that Bob cannot decrypt. But Bob's server is the only one with reliable uptime and connectivity. Can Alice sync her data through Bob's server to reach Carol?

Yes. Because sync operates on encrypted entries, Bob's server can store and forward Alice's entries without ever accessing their plaintext content. When Carol connects to Bob's server and syncs, she receives Alice's entries — still encrypted with keys that only Alice and Carol share. Bob's server fulfilled its role as a relay without needing (or having) access to the decryption keys.

```
┌──────────┐                ┌──────────┐                ┌──────────┐
│  Alice    │ ──── sync ──► │   Bob    │ ◄── sync ──── │  Carol    │
│           │                │  (relay)  │                │           │
│ can read  │                │ cannot    │                │ can read  │
│ the data  │                │ read data │                │ the data  │
└──────────┘                └──────────┘                └──────────┘
```

This works because:

1. Entry payloads are encrypted at the application layer before they enter any store.
2. The sync protocol only needs metadata (IDs, hashes, timestamps) to reconcile — it never inspects payload contents.
3. Entry signatures guarantee integrity regardless of how many intermediaries handle the entry.
4. Bob's server stores the encrypted bytes faithfully and serves them to Carol when she syncs.

### Why this matters

In many real-world deployments, not every node should be able to read every piece of data. A shared infrastructure server might host data for multiple teams with different access levels. A regional office server might relay data between field workers who share encrypted project data that the office administrator does not need to see. The relay pattern makes these topologies safe by default — there is no configuration step to "disable decryption" on the relay, because the relay never had the keys in the first place.

---

## 6) Store Chaining: The Passthrough Architecture

The relay pattern described above works naturally when a server stores entries locally and other clients sync from that local store. But MindooDB's composability enables an even more powerful pattern: a node that does not store data locally at all, but instead forwards sync requests to another remote store in real time.

### How store chaining works

`ServerNetworkContentAddressedStore` accepts any `ContentAddressedStore` as its backing store. A `ClientNetworkContentAddressedStore` implements `ContentAddressedStore`. This means you can construct a server whose backing store is actually a client connection to another server:

```
┌──────────┐         ┌──────────────────────┐         ┌──────────┐
│  Client   │ ──────►│  Passthrough Node     │────────►│  Origin   │
│           │        │                       │         │  Server   │
│           │        │ ServerNetwork...Store  │         │           │
│           │        │   └─► ClientNetwork..  │         │ LocalStore│
│           │        │         Store (proxy)  │         │           │
└──────────┘        └──────────────────────┘         └──────────┘
```

When the client sends a `findNewEntries` request to the passthrough node, the passthrough's `ServerNetworkContentAddressedStore` receives it, validates the token, and delegates to its backing store — which is a `ClientNetworkContentAddressedStore` pointing at the origin server. The request flows through to the origin, the response flows back, and the client receives its answer as if it were talking to the origin directly.

### When to use store chaining

**Edge caching.** Place a passthrough node close to a group of clients (e.g., in the same data center or office). The passthrough can optionally cache entries in a local store alongside the forwarding connection, serving as both a relay and a local cache that reduces latency for repeated requests.

**Access control boundaries.** A passthrough node can enforce its own authentication and authorization layer before forwarding requests. This is useful when the origin server is internal and should not be exposed directly to external clients.

**Multi-hop data distribution.** In geographically distributed deployments, data can flow through a chain of nodes — origin server to regional relay to local office server to field devices — with each hop using the same protocol and the same entry format. No node in the chain needs to decrypt the payload to forward it correctly.

### What makes this different from a traditional proxy

A traditional HTTP reverse proxy forwards opaque bytes without understanding the protocol. MindooDB's store chaining is protocol-aware: the passthrough node participates in capability negotiation, can serve Bloom filter summaries from its own cache, and can merge metadata from multiple upstream sources. It is a first-class participant in the sync protocol, not a transparent byte forwarder.

---

## 7) Multi-Party Sync Without Shared Keys

The patterns above lead to a topology that is rare in encrypted database systems: multi-party sync where not all participants share decryption keys.

### The scenario

Consider a healthcare application. A doctor creates encrypted patient records. A hospital server stores and distributes those records. A specialist at another clinic needs to review specific records. The hospital IT administrator manages the server but should not have access to patient data.

With MindooDB:

1. The doctor encrypts entries with keys shared only with authorized medical staff.
2. The hospital server stores the encrypted entries and syncs them to all connected clients.
3. The specialist syncs from the hospital server and decrypts the entries using their shared key.
4. The IT administrator can manage, monitor, and maintain the server (including compaction telemetry) without ever being able to decrypt patient records.

No special configuration is required to achieve this. It is simply how the system works when encryption keys are distributed to authorized users and the sync layer operates on encrypted entries.

### Trust model

The trust boundary in MindooDB is at the encryption key level, not at the network topology level. Any node can participate in sync — the question is which nodes hold keys that can decrypt which entries. This separation means you can add relay nodes, regional caches, or partner-organization servers to the sync topology without expanding the set of entities that can read sensitive data.

Entry signatures (Ed25519) provide an additional layer: even if a relay or intermediary were malicious, it cannot forge or tamper with entries without detection, because every entry carries a cryptographic signature from its creator.

---

## 8) Transport Options for P2P

MindooDB's sync protocol is transport-agnostic. The `NetworkTransport` interface abstracts the wire communication, and any transport that can carry request/response messages can be used. Here are the most common choices for P2P scenarios:

### WebRTC

WebRTC is the recommended transport for P2P sync across the internet. It handles NAT traversal automatically, provides encrypted channels by default, and works across platforms (browsers, React Native, Node.js). A signaling mechanism (a lightweight server, mDNS, or manual exchange) is needed for the initial connection setup, but once established, communication is direct between peers.

### Local network (HTTP/mDNS)

For devices on the same WiFi or LAN, running a lightweight HTTP server and discovering peers via mDNS/Bonjour is the simplest approach. Each peer advertises its sync endpoint, and other peers connect using standard HTTP. This avoids the complexity of WebRTC signaling when NAT traversal is not needed.

### Bluetooth Low Energy

For close-proximity sync without any network connectivity (e.g., two tablets in a field with no WiFi), BLE can serve as the transport layer. Bandwidth is limited, so this works best for small-to-medium datasets or incremental sync of recent changes.

### Choosing a transport

The choice depends on your connectivity environment. WebRTC is the most versatile option and works in the widest range of scenarios. Local network HTTP is simpler to implement when all devices are on the same network. BLE is a last resort for truly offline environments. In practice, many applications implement multiple transports and select the best available one at runtime.

---

## 9) Peer Discovery

Before two peers can sync, they need to find each other. MindooDB does not prescribe a discovery mechanism — the sync protocol starts after a transport connection is established — but here are proven approaches:

**mDNS / Bonjour** works well for automatic discovery on local networks. Each peer broadcasts a service advertisement, and other peers discover it without manual configuration. This is the most seamless user experience for same-network scenarios.

**QR code / manual pairing** is useful for initial connection setup across different networks. One device displays a QR code containing its connection endpoint (IP address, signaling server URL, or WebRTC offer), and the other device scans it. This is secure because it requires physical proximity for the initial exchange.

**Signaling server** is the standard approach for WebRTC. A lightweight server brokers the initial connection handshake between two peers, after which communication is direct. The signaling server does not handle sync data — it only facilitates the WebRTC connection setup.

**Hybrid discovery** combines multiple methods: mDNS for same-network peers, a signaling server for remote WebRTC connections, and QR codes as a fallback. This provides automatic discovery when possible and manual options when needed.

---

## 10) Practical Considerations

### Offline-first behavior

Every peer should maintain a local store that works independently of network connectivity. When a connection is available, sync transfers missing entries. When the connection drops, the peer continues working with its local data. This is the same offline-first model used in client-server sync — P2P simply adds more sync targets.

### Conflict resolution

MindooDB uses CRDTs (Conflict-free Replicated Data Types) for document state. This means that entries synced from multiple peers in any order will converge to the same document state. There is no need for conflict resolution logic in the sync layer — the data model handles it.

### Entry deduplication

Entries are identified by `id` and deduplicated by `contentHash`. If the same entry arrives from multiple peers (which is common in mesh topologies), it is stored once. The sync protocol's `hasEntries` check prevents redundant transfers.

### Security in P2P

In a P2P scenario, peers authenticate each other using the same challenge-response mechanism used in client-server sync. Each peer's `ServerNetworkContentAddressedStore` validates tokens using the tenant directory, which contains the authorized users and their public keys. A peer that is not in the tenant directory cannot authenticate and cannot participate in sync.

### Performance at scale

The optimized sync features (cursor scanning and Bloom filters) work identically in P2P scenarios. For peers with large local stores, cursor-based scanning avoids transmitting large ID lists, and Bloom filter summaries reduce the number of existence checks. These optimizations are negotiated per-connection through capability discovery, so a peer that supports them will use them automatically when connecting to another peer that also supports them.

---

## 11) Summary of Topologies

| Topology | Description | Key benefit |
|---|---|---|
| Client-Server | Standard sync with a central server | Simplest deployment |
| Peer-to-Peer | Two clients sync directly | No server dependency |
| Relay | Data flows through a node that cannot decrypt it | Secure data distribution |
| Store chain | A node forwards sync requests to another remote store | Edge caching, access boundaries |
| Multi-hop | Data traverses multiple nodes to reach its destination | Geographic distribution |
| Mesh | Multiple peers sync with each other | Resilience, convergence |

All of these topologies use the same sync protocol, the same entry format, and the same `ContentAddressedStore` interface. The choice of topology is a deployment decision, not a code change.

---

## 12) Related Documents

- Network sync protocol: [network-sync-protocol.md](network-sync-protocol.md)
- On-disk store: [on-disk-content-addressed-store.md](on-disk-content-addressed-store.md)
- Main system spec: [specification.md](specification.md)
