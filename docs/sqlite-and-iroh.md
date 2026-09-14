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

`IrohNetworkTransport` implements `NetworkTransport` over framed RPC on ALPN `mindoodb/sync-v5`. `IrohPeerStore` proxies `ContentAddressedStore` so `pullChangesFrom` / `pushChangesTo` work between devices without an extra RSA wrap — payloads are already E2E encrypted.

Pairing: exchange `IrohStreamIO.getLocalTicket()` (QR). Inbound: `listenForIrohPeers(io, createStoreIrohHandler(localStore))`. In-process tests: `createLoopbackIrohPair()`. Native: implement `IrohStreamIO` with `react-native-iroh` `endpoint.streams`.

Live Iroh (real relays, `@number0/iroh` on the server):

```bash
# mindoodb — native client ↔ MindooDBServer
MINDOODB_IROH_LIVE=1 pnpm test:iroh

# Haven — browser WASM ↔ the same kind of server
cd ../mindoodb-haven && pnpm test:e2e:iroh
```

Both need outbound access to the n0 relay network. Point Haven at an already-running server with `MINDOODB_IROH_TICKET` (and optionally `MINDOODB_IROH_SERVER_NAME` / `MINDOODB_IROH_TENANT_ID`) instead of spawning a local one.
