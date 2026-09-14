# SQLite store and Iroh transport

Additive backends for React Native and other non-browser hosts. `mindoodb/browser` does not import these modules.

## SQLite ContentAddressedStore

```ts
import { SqliteContentAddressedStoreFactory, createMemorySqliteBackend } from "mindoodb/sqlite";

const factory = new SqliteContentAddressedStoreFactory((dbId, kind) => {
  // Tests: createMemorySqliteBackend()
  // Expo: createExpoSqliteBackend(SQLite.openDatabaseSync(`mindoodb-${dbId}-${kind}.db`))
  return createMemorySqliteBackend();
});
```

Schema: `entries` (metadata + receipt order), `content` (ref-counted blobs), `store_meta` (epoch / counters). Production sync methods: `scanEntriesSince`, `getStoreHead`, `getIdBloomSummary`, `applyWitnessReceipts`.

## Iroh

See **[iroh.md](iroh.md)** for what Iroh is, which problems it solves, and how MindooDB uses it on the server, in a Node CLI (`mindoodb/iroh/node`), in Haven (WASM), and on React Native.

`IrohNetworkTransport` implements `NetworkTransport` over framed RPC on ALPN `mindoodb/sync-v5`. `IrohPeerStore` proxies `ContentAddressedStore` so `pullChangesFrom` / `pushChangesTo` work between devices without an extra RSA wrap.

Pairing: exchange `IrohStreamIO.getLocalTicket()` (QR). Inbound: `listenForIrohPeers(io, createStoreIrohHandler(localStore))`. In-process tests: `createLoopbackIrohPair()`. React Native: `createReactNativeIrohStreamIO()`. Node CLI: `createNodeIrohStreamIO` from `mindoodb/iroh/node`.
