# Iroh transport

Iroh is a QUIC-based peer protocol from [n0](https://www.iroh.computer/). Peers identify each other with a ticket (an endpoint address plus a public key), not a DNS name. When a direct UDP path is blocked by NAT or a firewall, traffic falls back through [relays](https://www.iroh.computer/pricing). Payloads stay end-to-end encrypted; relays only see connection metadata.

MindooDB uses Iroh as an **alternative `NetworkTransport`**. The sync protocol is unchanged: the same RPCs, the same JWT challenge-response, the same encrypted store entries. HTTP remains the default. Iroh is for hosts that should not (or cannot) expose a public HTTPS URL.

This page is the product and integration guide. Wire details of the sync RPCs live in [network-sync-protocol.md](network-sync-protocol.md). Additive store/transport notes for React Native are in [sqlite-and-iroh.md](sqlite-and-iroh.md).

## What it solves

| Problem | HTTP | Iroh |
| --- | --- | --- |
| Server needs a public URL / TLS cert / reverse proxy | Yes | No — ticket + relay is enough |
| Browser or laptop behind NAT must reach a home server | Port forward or tunnel | Relays punch or forward QUIC |
| Device-to-device sync without a deployed server | Not this transport | `IrohPeerStore` + ticket exchange |
| Same SDK on Node, browser, and React Native | `HttpTransport` | Same `IrohNetworkTransport`, different byte adapter |

What Iroh does **not** replace: authentication, access control, or encryption. A client still signs a challenge and the server still stores ciphertext.

## How MindooDB uses it

```
Client (IrohNetworkTransport)
        │  framed RPC, ALPN mindoodb/sync-v5
        │  one QUIC connection, many bi-streams
        ▼
MindooDBServer Iroh listen ──► same store handlers + SyncEventBus
subscribeToChanges is a second stream on the same connection
```

Three layers:

1. **`IrohStreamIO`** — open a bidirectional byte stream (`connect` / `listen` / `send` / `recv`). Native adapters also expose `openConnection()` so several RPCs and the change feed share one QUIC handshake. Each in-flight request still owns its own stream (`rpcCall` is one request / one response). WASM and React Native keep `connect()` per stream.
2. **`IrohNetworkTransport`** — the same `NetworkTransport` methods as HTTP (`getStoreHead`, `putEntries`, `subscribeToChanges`, …) as length-prefixed JSON frames. When `openConnection` is present, parallel `putEntries` batches no longer share a single stream.
3. **`ClientNetworkContentAddressedStore`** — auth, capability negotiation, pull/push. Unchanged.

| Role | Package / adapter |
| --- | --- |
| Server listen | `MindooDBServer` + `config.json` `iroh.enabled` (`@number0/iroh` in the Docker image) |
| Node CLI / service | `createNodeIrohStreamIO` from `mindoodb/iroh/node` |
| Browser (Haven) | vendored WASM (`mindoodb-haven-iroh`), loaded at runtime — not this package |
| React Native | `createReactNativeIrohStreamIO()` from `mindoodb/iroh` (`react-native-iroh`) |
| Tests | `createLoopbackIrohPair()` — in-process, no relays |

Pairing uses an `iroh:<ticket>` locator (Haven pastes that into the server URL field). The ticket is not a secret by itself; the usual tenant JWT still gates store RPCs.

Live change events reuse `SyncEventBus` (the same bus as HTTP SSE). Over Iroh they travel as framed JSON on a dedicated feed stream (same QUIC connection as RPC when the adapter supports `openConnection`), with heartbeats so the ~30 s QUIC idle timeout does not drop a silent subscribe.

## Server

Enable listen in the server data directory `config.json`:

```json
{
  "capabilities": {},
  "iroh": {
    "enabled": true,
    "secretKeyPath": "iroh-secret.key"
  }
}
```

On start the process joins the Iroh network, waits until it has a home relay, and logs a ticket. Details and Docker notes: [README-server.md](../README-server.md). Public n0 relays are free for development; production should use dedicated or self-hosted relays.

## Server-to-server mesh

Two MindooDB servers can mirror each other over Iroh instead of HTTPS. Put the peer's ticket in `trusted-servers.json` as `url`:

```json
{
  "name": "CN=east",
  "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "url": "iroh:<ticket>"
}
```

That is the same peer control plane as HTTP (`challenge` → `authenticate` → tenant Bloom → store sync → live events), on the same Iroh endpoint the server already uses for clients. Cluster admin (`/system/cluster/*`, `add-to-network`) stays on HTTP.

**Ticket vs Node-ID.** A full `endpoint…` ticket includes the current addresses and relay. The stable label is the 64-hex Node-ID (`iroh:<64-hex>`).

A bare Node-ID **is** dialable whenever both sides run an endpoint with n0 address discovery — which `presets::N0` wires up by default, and which both the Haven WASM build and the native `@number0/iroh` adapter use. The binding endpoint publishes its current relay and addresses to pkarr under its Node-ID, and the dialing endpoint resolves them back. That makes the Node-ID the value worth persisting: it survives IP and relay changes, whereas a stored ticket goes stale. Store a ticket only for a first pairing between endpoints that have discovery switched off, and paste a fresh one from the peer's log when it goes stale.

Both sides need `iroh.enabled` and a shared tenant (create once, `publishToServer` to each). `--auto-sync` / `startCluster()` starts the replicators; Iroh listen is async, so a first dial may retry until the endpoint is online.

`publishToServer` and Haven's "Push tenant" dialog use the same Iroh RPC as discovery — not browser `fetch`. An `iroh:` locator is not an HTTP origin (Firefox reports "CORS request was not http"). The client must pass the full endpoint ticket plus an `IrohStreamIO`; the server answers `system.requestChallenge`, `system.authenticate`, and `system.registerTenant` with the same JWT + capability checks as `/system/auth/*` and `POST /system/tenants/:tenantId`. Cluster admin (`/system/cluster/*`, `add-to-network`) stays on HTTP.

## Node CLI

A CLI does **not** need the Haven WASM build. Node talks to the same server through the native N-API package `@number0/iroh`.

```bash
pnpm add mindoodb @number0/iroh
```

```ts
import { ClientNetworkContentAddressedStore, StoreKind } from "mindoodb";
import { NodeCryptoAdapter } from "mindoodb/node";
import { IrohNetworkTransport } from "mindoodb/iroh";
import { createNodeIrohStreamIO } from "mindoodb/iroh/node";
import { mkdirSync } from "node:fs";

const dataDir = "./iroh-cli";
mkdirSync(dataDir, { recursive: true });

const io = await createNodeIrohStreamIO({ dataDir });
const transport = new IrohNetworkTransport(io, process.env.MINDOODB_IROH_TICKET!, {
  tenantId: process.env.MINDOODB_TENANT_ID!,
  dbId: "directory",
  storeKind: StoreKind.docs,
});

const crypto = new NodeCryptoAdapter();
const store = new ClientNetworkContentAddressedStore(
  "directory",
  StoreKind.docs,
  transport,
  crypto,
  username,
  signingKey,          // Ed25519 private key used for the auth challenge
  encryptionKey,       // RSA private key used to unwrap entries
  undefined,
  signingPublicKeyPem,
);
store.setSyncAuthOverride({
  username,
  signingKey,
  signingPublicKey: signingPublicKeyPem,
});

const head = await store.getStoreHead();
await localDb.pushChangesTo(store);
await localDb.pullChangesFrom(store);

const stop = store.subscribeToChanges((event) => {
  console.log("change", event.dbId, event.maxReceiptOrder);
});
```

The ALPN is `mindoodb/sync-v5` (`MINDOODB_IROH_ALPN` from `mindoodb/iroh`). Discovery RPCs (`getServerInfo`, `getTenantPublicInfosFingerprints`) only need `tenantId` on the transport; store RPCs also need `dbId` and `storeKind`.

Close the endpoint when the process exits: `await io.close?.()`.

## Browser and React Native

Haven loads WASM from `/iroh/` at runtime (`ensureHavenIrohStreamIO`). That crate is a separate build; do not ship it in a Node CLI.

On React Native, `createReactNativeIrohStreamIO()` wraps `react-native-iroh`. See [reactnative.md](reactnative.md).

## Device-to-device (no MindooDBServer)

`IrohPeerStore` plus `listenForIrohPeers` syncs already-encrypted entries between two devices — Bloom compare, `scanEntriesSince`, `getEntries`, `putEntries`, the same protocol a server answers. There is no extra RSA wrap on that path. Devices can exchange tickets (QR) as in [sqlite-and-iroh.md](sqlite-and-iroh.md), or address each other by bare Node-ID once each has published it somewhere both can read.

Three things must be got right before a device answers this protocol, because the caller is addressing storage directly:

- **Which replica.** `IrohPeerStore` sends `ctx` (`tenantId`, `dbId`, `storeKind`) with every call, and the listener routes on it. Serve only replicas that exist locally; answer anything else with the same opaque error, so a caller cannot probe for which tenants a device holds.
- **Which peer.** The QUIC handshake proves the caller holds the secret behind its Node-ID, and the listener sees it as `peerEndpointId` on the handler (and as `IrohByteStream.remoteEndpointId`). Pass `authorize` to `listenForIrohPeers` to check it against a list of known devices; without that check any endpoint on the internet that learns the Node-ID is served. Use `maxConcurrentSessions` to cap what one caller can tie up.
- **Which methods.** `createStoreIrohHandler` resolves methods by name off the store, so pass it through its `IROH_SYNC_STORE_METHODS` allowlist (the default) rather than exposing everything — `purgeDocHistory` is on the store too.

After an incoming `putEntries`, call `db.syncStoreChanges()`: entries land as bytes and only materialize into documents once something drives that.

Haven builds on exactly this. Each device persists one Iroh secret, publishes the derived Node-ID as a `dev_<fingerprint>` document in `userdirectory` encrypted with the tenant `default` key (readable by every member, opaque to the hoster), and accepts incoming sync only from the devices it finds there. See [userkeys.md](userkeys.md) §7.6.

[p2psync.md](p2psync.md) is the step-by-step version of this section: both halves with runnable code, the platform/relay matrix, and what peer sync does not give you.

## Relays and cost

Default endpoints use n0 public relays (US / EU / Singapore): free, shared, rate-limited, no SLA. Paid Iroh Services and self-hosted relays are documented on [iroh.computer/pricing](https://www.iroh.computer/pricing). A long-lived change-feed connection plus heartbeat is extra relay traffic compared with HTTP SSE.

## Tests

```bash
# Loopback protocol tests (default CI)
pnpm test IrohChangeFeed IrohMultiStream IrohNetworkTransport IrohServerRpc IrohPeerMesh

# Native client ↔ MindooDBServer over real relays
MINDOODB_IROH_LIVE=1 pnpm test:iroh

# Haven WASM ↔ the same kind of server
cd ../mindoodb-haven && pnpm test:e2e:iroh
```
