# Server core and hosts

The MindooDB server is split into a platform-neutral core and the hosts that
run it.

| Folder | What it contains | Runtime |
|---|---|---|
| `src/server/` | Route handlers (`http/MindooDBServerCore.ts`), `TenantManager`, auth services, config validation, rate-limit policy, persistence interfaces | Any JavaScript runtime with WebCrypto |
| `src/node/server/` | The Node host: Express, HTTP/2 + TLS, static files, Iroh, peer replication and cluster jobs, file-backed persistence | Node.js (Docker image, `pnpm server:start`) |
| `src/cloudflare/` | The Cloudflare host: Worker router and Durable Objects (see below) | Cloudflare Workers |

The core and the Cloudflare host must not import Node built-ins.
`ServerCoreNeutralBundle.test.ts` bundles `src/server/index.ts` and
`src/cloudflare/index.ts` for esbuild's neutral platform and fails on any
`fs`, `path` or `node:*` import. The package exports them as
`mindoodb/server` and `mindoodb/cloudflare`.

## What a host provides

**HTTP.** Every endpoint is a method of `MindooDBServerCore` that takes a
`ServerRequest` (method, params, query, headers, parsed JSON body or raw
bytes) and returns a `ServerResponse` (JSON, bytes, or an event stream to
open). Guards for the tenant id, system admin JWTs and the timestamp proxy
return a rejection or `null`. The host owns transport concerns: body parsing
and size limits, compression, CORS, security headers, the rate-limit store,
and keeping Server-Sent-Events streams open. Rate-limit tiers, defaults and
bucket keys come from `server/rateLimits.ts` so every host throttles alike.

On Node, `MindooDBServer` mounts the handlers on Express through
`expressAdapter.ts`; the middleware stack, routes, status codes and response
bodies are unchanged.

**Server state.** `ServerDataStore` is a small synchronous key/document store
for the server identity, trusted servers, the server key bag, tenant configs
and the purge registry. Keys are relative paths; `FsServerDataStore` maps
them 1:1 onto the files below the data directory, so existing servers keep
their layout:

```
server.identity.json
trusted-servers.json
server.keybag
<tenantId>/config.json
<tenantId>/purged-docs.json
```

**Entry stores.** `ServerStoreProvider` creates the content-addressed stores
of a tenant's databases and lists them. On Node these are the on-disk stores
in `<tenantId>/stores`.

**Config.** `ServerConfigRepository` reads config backups and replaces
`config.json` for `PUT /system/config`.

**Clustering (optional).** `ServerClusterHooks` connects the tenant routes to
peer replication: mirrors for `/.well-known/mindoodb-cluster`, replicator
updates when trusted servers change, and the peer label on change events.
A host without it serves the same API without mirrors. Peer replication
itself is neutral too (`server/peer`: `ClusterManager`, `PeerReplicator`,
`PeerAuthService`, the `/system/peer` and `/system/cluster` handlers in
`clusterHttp.ts`); a host provides its local stores, a `ClusterAuditStorage`,
and optionally Iroh (`openIrohLink`; Node passes `IrohPeerLink`).

Iroh is not part of the core; the Node host wires it in when `config.json`
enables it.

## The Cloudflare host

`src/cloudflare` runs the same handlers on Workers and Durable Objects;
`cloudflare/` is the deployable Worker project (setup, Deploy button,
differences to Node: see `cloudflare/README.md`).

- **`MindooServerObject`** (one instance) is the server's data directory
  without entry stores: `config.json` and backups, trusted servers, the server
  key bag and tenant configs in a `ServerDataStore` on the object's SQLite. It
  serves `/system/*` and discovery, and hands a tenant's config and
  `$publicinfos` keys to the objects serving its databases.
- **`MindooDatabaseObject`** (one per tenant and database) holds the docs and
  attachments stores of its database (`SqliteContentAddressedStore` with a
  table prefix and without BEGIN/COMMIT, which Durable Object SQL rejects).
  It runs its own `TenantManager`. Access control therefore runs locally,
  with the code the Node server uses, against a replica of the tenant's
  directory store. The replica is pulled from the directory object: at most
  every 2 s, on a change notice from the directory, and again before a
  request would be denied.
- The tenant's **`directory` object** also answers the auth handshake,
  proxies RFC 3161 requests, keeps the SSE streams (the other databases
  forward their change events to it) and knows the tenant's databases, which
  it wipes when the tenant is deleted.
- Sync tokens are HMAC-signed with a per-tenant key derived from
  `MINDOODB_JWT_SECRET`, so a token issued by the directory object is valid in
  every database object of the tenant (`TenantManagerOptions.jwtSecretForTenant`).
- Purge requests are executed by each database object for its own database
  (`executePendingPurges(tenantId, { dbIds })`).
- **Peer replication** runs in the server object: the `ClusterManager` of the
  Node server, whose local stores are the database objects' stores reached
  over store RPC (`RpcContentAddressedStore`). The cron trigger runs a pass
  with every peer (`ClusterManager.syncAll`); a database object reports each
  accepted write so it is pushed at once (`replicateLocalChange`). The
  replicators do not hold an event stream to their peers
  (`liveEventStream: false`), but the server object serves
  `/system/peer/events` to peers that do. Peer tokens are signed with a key
  derived from `MINDOODB_JWT_SECRET`, so the database objects accept them on
  the sync routes; pulled entries of purged documents are refused there.

The end-to-end tests `CloudflareWorker.test.ts` (clients) and
`CloudflarePeerReplication.test.ts` (Node server ↔ Cloudflare in both
directions) run the host under `wrangler dev` (opt-in:
`MINDOODB_CLOUDFLARE_TESTS=1`, and `WRANGLER_BIN` or `cloudflare/node_modules`).
