# Peer-to-Peer Sync

Two devices syncing their replicas straight to each other over [Iroh](iroh.md), with no `MindooDBServer` in between.

This is the practical guide: what to build, in what order, to get sync running in both directions using nothing but the SDK. [network-sync-protocol.md](network-sync-protocol.md) covers the client-server path, and [iroh.md](iroh.md) is the transport reference — this document assumes neither and links out where the detail lives.

> **Scope.** Everything here is SDK surface, so it works the same in a CLI, a service, a mobile app, or a browser. What the SDK deliberately does *not* prescribe is how two devices learn each other's addresses; that belongs to the application. §7 explains the constraint and how Haven solves it.

---

## 1) Why the same protocol works without a server

Entry payloads are encrypted (AES-256-GCM) before they ever reach a store. The sync layer reads only metadata — entry id, content hash, timestamps, signatures — to work out what the other side is missing. It never needs the plaintext.

Two consequences matter here. First, a peer is not a reduced form of a server: it answers the same comparison-and-transfer protocol, so Bloom summaries, cursor scanning, and deduplication all behave as they do against a server. Second, because `pullChangesFrom()` and `pushChangesTo()` accept any `ContentAddressedStore`, pointing a database at a peer instead of a server is a change of argument, not a change of code path.

There is one real difference from server sync, and it is a simplification: the server path wraps payloads in an extra RSA layer per recipient. Peer sync does not. Entries travel in the encryption they already carry.

---

## 2) The two halves

Peer sync is deliberately asymmetric in implementation even though it is symmetric in effect. Each device needs both halves to sync in both directions.

| Half | You use | What it is |
| --- | --- | --- |
| Outgoing (dialing) | `IrohPeerStore` | A `ContentAddressedStore` that proxies every call to the peer. Hand it to `pullChangesFrom` / `pushChangesTo`. |
| Incoming (listening) | `listenForIrohPeers` + `createStoreIrohHandler` | Accepts streams and answers store RPCs against a local store. |

Both come from `mindoodb/iroh`. The transport underneath is an `IrohStreamIO`, which differs per platform (§6).

---

## 3) Outgoing: dialing a peer

`IrohPeerStore` takes the transport, the peer's address, the database id, and which store kind you mean:

```ts
import { IrohPeerStore, StoreKind } from "mindoodb/iroh";

const peer = new IrohPeerStore(io, `iroh:${peerEndpointId}`, "mydb", StoreKind.docs, {
  tenantId: "tenant-1",
  peerEndpointId,
});

await db.pullChangesFrom(peer, { storeKind: StoreKind.docs });
await db.pushChangesTo(peer, { storeKind: StoreKind.docs });
```

Three details are easy to get wrong:

**Pass `tenantId`.** It travels as `ctx` with every call and is how the listener knows which of its replicas you mean. Without it a listener holding several tenants has to guess.

**Pass `peerEndpointId` when you dial by ticket.** The store's cache identity keys the sync scan cursor. A ticket embeds the peer's current relay and addresses, so keying on it would reset the cursor every time the peer changes network and force a full metadata rescan. The endpoint id never changes. Dialing by bare id (as above) already gives a stable key, so the option only matters for tickets.

**Attachments are a separate store.** `storeKind` defaults to `StoreKind.docs`. A database with attachments needs a second `IrohPeerStore` built with `StoreKind.attachments` and a second pair of calls; syncing only docs leaves attachment bytes behind.

---

## 4) Incoming: answering a peer

Listening is where the security lives. A caller reaching this path is addressing your storage directly, so three separate questions have to be answered before you serve anything.

```ts
import {
  createStoreIrohHandler,
  listenForIrohPeers,
  type IrohRpcHandler,
} from "mindoodb/iroh";

const handler: IrohRpcHandler = async (method, args, ctx, peerEndpointId) => {
  // 1. Which replica? Route on ctx, and never reveal what you do not hold.
  const store = resolveLocalStore(ctx?.tenantId, ctx?.dbId, ctx?.storeKind);
  if (!store) {
    throw new Error("Not available");
  }
  // 2. Which peer? Re-check per request, not just per connection.
  if (!peerEndpointId || !isAllowed(peerEndpointId, ctx?.tenantId)) {
    throw new Error("Not available");
  }
  // 3. Which methods? The default allowlist, never the raw store.
  return createStoreIrohHandler(store)(method, args, ctx, peerEndpointId);
};

await listenForIrohPeers(io, handler, {
  authorize: (peerEndpointId) => Boolean(peerEndpointId) && isKnownDevice(peerEndpointId!),
  maxConcurrentSessions: 32,
  signal: abortController.signal,
});
```

**Which replica.** Route on `ctx` (`tenantId`, `dbId`, `storeKind`). Serve only replicas that exist locally, and answer everything else with the *same* opaque error — a distinguishable "unknown tenant" lets a caller enumerate which tenants your device holds.

**Which peer.** The QUIC handshake proves the caller holds the secret behind its endpoint id, and you receive it as `peerEndpointId`. That is authentication, not authorization: it tells you *who* is calling, not whether they may. The `authorize` callback gates the connection once; the handler should still check per request, because one connection can carry calls for several tenants. Treat an undefined `peerEndpointId` as an unknown peer and refuse — it means the adapter could not report the caller. Without this check, any endpoint on the internet that learns your id is served.

**Which methods.** `createStoreIrohHandler` resolves methods by name off the store object, so it is gated by `IROH_SYNC_STORE_METHODS` by default. Keep that default. The store also exposes `purgeDocHistory`, which would let a peer destroy history on your device. Pass a narrower `allowedMethods` for a read-only mirror (drop `putEntries` and `applyWitnessReceipts`).

`maxConcurrentSessions` (default 32) caps how much one caller can tie up by opening streams in a loop.

### Materializing what arrives

Entries land as bytes. They become documents only when something drives that:

```ts
await db.syncStoreChanges();
```

Call it after an inbound `putEntries`. Skipping it is the single most common reason a peer sync "did nothing" — the data is there, it just has not been processed.

---

## 5) A complete pair

A CLI that both listens and dials, with persistent identity, on Node:

```ts
import { createNodeIrohStreamIO } from "mindoodb/iroh/node";
import {
  IrohPeerStore,
  StoreKind,
  createStoreIrohHandler,
  listenForIrohPeers,
} from "mindoodb/iroh";

// One secret per install; the endpoint id derived from it is what peers dial.
// A fresh secret on every start would make every published id worthless.
const io = await createNodeIrohStreamIO({ dataDir: "./data" });
console.log("this device:", io.endpointId);

// --- incoming -------------------------------------------------------------
const dbId = db.getStore().getId();
const allowed = new Set([partnerEndpointId]);
void listenForIrohPeers(
  io,
  async (method, args, ctx, peer) => {
    if (ctx?.dbId !== dbId || !peer || !allowed.has(peer)) {
      throw new Error("Not available");
    }
    const store = ctx.storeKind === StoreKind.attachments ? db.getAttachmentStore() : db.getStore();
    const result = await createStoreIrohHandler(store)(method, args, ctx, peer);
    if (method.endsWith("putEntries")) {
      await db.syncStoreChanges();
    }
    return result;
  },
  { authorize: (peer) => Boolean(peer) && allowed.has(peer!) },
);

// --- outgoing -------------------------------------------------------------
for (const storeKind of [StoreKind.docs, StoreKind.attachments]) {
  const peer = new IrohPeerStore(io, `iroh:${partnerEndpointId}`, dbId, storeKind, {
    tenantId,
  });
  await db.pullChangesFrom(peer, { storeKind });
  await db.pushChangesTo(peer, { storeKind });
}
```

Run this on both devices with each other's endpoint id and they converge. Order does not matter: document state is CRDT-based, so entries arriving from either side in any order settle on the same result.

---

## 6) Platforms, relays, and what "direct" means

`IrohStreamIO` is the seam. Everything above is identical across platforms; only the adapter and the connectivity it can achieve change.

| Platform | Adapter | Connectivity |
| --- | --- | --- |
| Node / CLI / service | `createNodeIrohStreamIO` (`mindoodb/iroh/node`) | Hole punching, falls back to relay |
| React Native | `createReactNativeIrohStreamIO` | Hole punching, falls back to relay |
| Browser / PWA | Haven's WASM build (`ensureHavenIrohStreamIO`) | Relay only |

The browser limitation is structural, not a missing feature: a page cannot open raw UDP sockets, so there is no hole punching to do. Every byte between two browser tabs goes through a relay. That costs latency and relay bandwidth, and the n0 public relays are shared, rate-limited, and carry no SLA — fine for syncing a handful of devices, not a transport to build a product on without reading [iroh.computer/pricing](https://www.iroh.computer/pricing) first.

Native adapters attempt a direct path first and fall back to a relay when NAT traversal fails. A future CLI or native mobile client therefore gets materially better peer sync than the PWA does, with no change to the code in §3–§5.

Relays never see plaintext. They forward QUIC packets; the entries inside are already encrypted, and the relay has no key.

### Addressing: id or ticket

A bare 64-hex endpoint id is dialable on its own, because Iroh publishes the changing address information to `dns.iroh.link` via pkarr and resolves it back on dial. That is what makes the `iroh:<endpointId>` form in the examples work, and it is why an endpoint id is the only thing worth persisting. A ticket additionally embeds current relay and socket addresses — useful for an offline LAN exchange (QR, see [sqlite-and-iroh.md](sqlite-and-iroh.md)), but it goes stale.

---

## 7) Discovery is the application's job

The SDK starts at "I have the peer's endpoint id." Getting that id from one device to the other is deliberately out of scope, because the right channel depends entirely on the product: a QR code, a pairing server, a shared directory, or a user pasting a string.

The constraint to design around: **the id must be stable, and the channel must be one the peer can read before the connection exists.** An id that rotates is worthless, since a peer that has not synced recently would hold a dead address.

Haven is the reference implementation. Each device persists one Iroh secret and publishes the derived endpoint id as a `dev_<fingerprint>` document in the tenant's `userdirectory`, encrypted with the tenant `default` key. That gets the properties you want: every member of the tenant can resolve a device label to an endpoint, while the hoster — who has `$publicinfos` but not `default` — cannot read it at all. The allowlist for `authorize` is built from exactly those documents. See [userkeys.md](userkeys.md) §7.6.1 for the document format and the anti-spoofing rules.

Note what this buys and what it costs. It is server-assisted discovery for a serverless sync: the directory has to have travelled at least once before two devices can find each other, which is why Haven only offers peer sync for tenants that already live on a server. A product with a different pairing story (QR at setup, for instance) has no such dependency.

---

## 8) Testing without a network

`createLoopbackIrohPair()` returns two `IrohStreamIO` instances wired to each other in-process. Everything in §3 and §4 runs against it unchanged, so the routing, allowlist, and method-gating logic can be tested without relays, NAT, or timing:

```ts
import { createLoopbackIrohPair } from "mindoodb/iroh";

const { a, b } = createLoopbackIrohPair();
```

See `src/__tests__/IrohPeerSyncGuards.test.ts` for the three guards tested this way.

---

## 9) What peer sync does not give you

Worth knowing before designing around it:

- **No JWT, no tenant publication, no cluster membership.** A peer is not a server. It does not issue tokens, host tenants for others, or join a mesh.
- **No live change feed.** `subscribeToChanges` over a peer link is not part of this path; sync is something you trigger.
- **No witness receipts** from the peer.
- **No availability.** A peer answers only while its process is running and listening. For a browser tab that means only while the tab is open.

If you need any of these, you need a server — see [iroh.md](iroh.md) §Server for running one reachable over Iroh rather than HTTPS.

---

## 10) Related documents

- Iroh transport, adapters, relays: [iroh.md](iroh.md)
- Client-server sync protocol: [network-sync-protocol.md](network-sync-protocol.md)
- Peer-device records and key visibility: [userkeys.md](userkeys.md)
- Ticket exchange over QR on a LAN: [sqlite-and-iroh.md](sqlite-and-iroh.md)
- React Native adapter: [reactnative.md](reactnative.md)
- Main system spec: [specification.md](specification.md)
