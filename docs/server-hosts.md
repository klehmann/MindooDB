# Server core and hosts

The MindooDB server is split into a platform-neutral core and the hosts that
run it.

| Folder | What it contains | Runtime |
|---|---|---|
| `src/server/` | Route handlers (`http/MindooDBServerCore.ts`), `TenantManager`, auth services, config validation, rate-limit policy, persistence interfaces | Any JavaScript runtime with WebCrypto |
| `src/node/server/` | The Node host: Express, HTTP/2 + TLS, static files, Iroh, peer replication and cluster jobs, file-backed persistence | Node.js (Docker image, `pnpm server:start`) |

The core must not import Node built-ins. `ServerCoreNeutralBundle.test.ts`
bundles `src/server/index.ts` for esbuild's neutral platform and fails on any
`fs`, `path` or `node:*` import. The package exports the core as
`mindoodb/server`.

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
itself (`node/server/peer`) is Node-only for now.

Iroh is not part of the core; the Node host wires it in when `config.json`
enables it.
