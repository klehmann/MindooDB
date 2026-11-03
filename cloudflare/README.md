# MindooDB server on Cloudflare

Runs the MindooDB sync server serverless on Cloudflare Workers and Durable
Objects. Clients (Haven, the SDK, the Node and Kotlin clients) talk to it
exactly as they talk to the Node/Docker server: same paths, same protocol.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/klehmann/MindooDB/tree/main/cloudflare)

## How it is built

| Piece | What it holds |
|---|---|
| Worker | Routes each request; CORS, security headers, global rate limit |
| `MindooServerObject` (one) | `config.json`, the tenant list and configs, the server key bag; serves `/system/*` and discovery; runs peer replication |
| `MindooDatabaseObject` (one per tenant and database) | The database's entry stores in the object's SQLite. Each object checks access with the same code as the Node server, using a replica of the tenant's `directory` database. The `directory` object also handles login, the change-event stream (SSE) and the RFC 3161 proxy |

Because every database has its own object, tenants and databases scale
independently. A database object pulls new directory entries before serving a
request (at most every 2 seconds), right away when the directory announces a
change, and once more when it is about to deny a request.

All logic lives in the `mindoodb` package (`mindoodb/cloudflare`); this
folder only holds the Worker's configuration. To update, bump `mindoodb` in
`package.json` and deploy again.

## Requirements

- A Cloudflare account on the **Workers Paid** plan. The server signs,
  verifies and wraps keys on every sync request, and that does not fit the
  free plan's CPU time per request.
- Node.js 22+ on your machine for the one-time setup.
- `mindoodb` 0.0.86 or later (the first release with `mindoodb/cloudflare`).

## Deploy

1. Click **Deploy to Cloudflare** above. Cloudflare copies this folder into a
   new repository of yours and deploys the Worker (`<name>.<account>.workers.dev`).
   The server has no identity yet; `/.well-known/mindoodb-server-info`
   answers 503 until step 3.
2. Clone the new repository and install:
   ```bash
   npm install
   npx wrangler login
   ```
3. Create the server identity and a system administrator, and store them as
   secrets of the deployed Worker:
   ```bash
   npm run setup
   ```
   This writes `system-admin-cn=sysadmin.identity.json` into the current directory. Keep it:
   it is the only copy of the admin's private key, and you need it (with
   its password) to create tenants. Use `--admin <name>` for another admin
   name, or `--admin-public <identity.json>` to make an existing identity the
   admin.
4. Check it:
   ```bash
   curl https://<name>.<account>.workers.dev/.well-known/mindoodb-server-info
   ```

Without the button: clone MindooDB, `cd cloudflare`, `npm install`,
`npx wrangler login`, `npx wrangler r2 bucket create mindoodb-large-entries`
(or remove the `r2_buckets` entry), `npm run setup`, `npm run deploy`.

### Own domain

Add a custom domain to the Worker in the Cloudflare dashboard (Workers &
Pages → your Worker → Settings → Domains & Routes), or add a route to
`wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "sync.example.com", "custom_domain": true }]
```

A hosted multi-customer setup can run one Worker on a wildcard route such as
`*.mindoodb-cloud.com/*`. Tenants are already isolated by tenant id in the
path, so the host name only needs to reach the Worker.

### Browser clients

Set `MINDOODB_CORS_ORIGIN` in `wrangler.jsonc` (or in the dashboard) to the
origins of your web apps, comma-separated, e.g. `https://haven.example.com`.

## Create tenants

As on the Node server: a client publishes a tenant with the system admin's
identity (`tenant.publishToServer(url, { systemAdminUser, systemAdminPassword, ... })`
in the SDK, or Haven's "publish to server"). `config.json` follows the format
of the Node server (see `README-server.md` in the MindooDB repository) and can
be changed at runtime with `PUT /system/config`.

## Replicating with other servers

A Cloudflare server joins a MindooDB cluster like a Node server: both trust
each other's server identity and replicate every tenant they both host, over
the same `/system/peer/*` protocol.

1. Enable replication in `config.json`:
   `PUT /system/config` with `"cluster": { "autoSync": true }` (or put it into
   the initial config before `npm run setup`).
2. On the Cloudflare server, add the other server, with its url
   (`/system/trusted-servers` or `POST /system/cluster/peers/<name>`; keys
   from its `/.well-known/mindoodb-server-info`).
3. On the other server, add the Cloudflare server the same way (or with
   `pnpm server:add-to-network` on Node).
4. Publish the tenant to both servers.

Cloudflare pulls from its peers on a cron trigger every minute and pushes a
write to them as soon as it is accepted. A Node peer additionally pulls
promptly over `/system/peer/events`. The cluster admin API
(`/system/cluster/status`, `jobs`, `audit`, `actions/sync`, …) works as on
Node.

## Local development

```bash
npm run setup -- --local   # writes .dev.vars instead of secrets
npm run dev                # wrangler dev, storage stays local
```

## Differences from the Node server

- **Not available:** device discovery (`/device/*`) answers `501`; Iroh
  (neither for clients nor between peers).
- **Peer replication** pulls on the cron trigger (every minute) instead of
  keeping an event stream open to each peer, which would keep the server
  object running permanently. Pushes still go out immediately.
- **Rate limits** come from the `ratelimits` bindings in `wrangler.jsonc`
  (periods of 10 or 60 seconds), not from `rateLimits` in `config.json`. The
  timestamp proxy's daily cap is not enforced. The admin IP allowlist
  (`MINDOODB_ADMIN_ALLOWED_IPS`) does not exist; use Cloudflare WAF rules.
- **Large entries:** Durable Object SQLite caps a row at 2 MB, so entries of
  1 MB and more are kept in the R2 bucket bound as `MINDOODB_LARGE_ENTRIES`
  (`mindoodb-large-entries` in `wrangler.jsonc`). Without the binding, entries
  above about 1.9 MB are refused. Attachments are split into 256 KB chunks
  and stay in SQLite.
- **Platform limits** (Workers Paid, as of 2026) and how the server stays
  inside them:
  - *128 MB memory per isolate:* requests that carry entry payloads run one at
    a time per database object, and peer replication moves one small batch at
    a time (16 attachment chunks). Directory caches grow by roughly 50–60 KB
    per directory user (≈ 30 MB at 500 users).
  - *CPU time per request:* raised to 5 minutes in `wrangler.jsonc`
    (`limits.cpu_ms`); a cron tick replicates for at most 4 minutes and
    continues on the next tick.
  - *10 GB per Durable Object:* one database of a tenant (R2 content not
    counted). When full, writes fail and reads keep working.
  - *2 MB per stored value:* also applies to the server's key bag in the server
    object, which holds one key per tenant; this becomes tight only at about
    10,000+ tenants.
  - *SQL:* at most 100 bound parameters per statement (lists are split
    accordingly), no `BEGIN`/`COMMIT` (writes without real I/O in between
    commit atomically; content is written before its entry row and receipt
    numbers are reserved per batch, so an interruption never leaves an entry
    without content).
  - *About 1,000 requests per second per object*, i.e. per tenant database.
- **Key derivation:** Workers allow at most 100 000 PBKDF2 iterations, so the
  server identity and server key bag use that count (the Node server uses
  310 000). Client identities are never decrypted on the server.
- **Responses** are compressed by Cloudflare's edge, not by the server.

## Secrets and variables

| Name | Kind | Set by |
|---|---|---|
| `MINDOODB_SERVER_IDENTITY` | secret | `npm run setup` |
| `MINDOODB_SERVER_PASSWORD` | secret | `npm run setup` (random) |
| `MINDOODB_JWT_SECRET` | secret | `npm run setup` (random); sync tokens are derived from it per tenant |
| `MINDOODB_SERVER_CONFIG` | secret | `npm run setup`; the initial `config.json` |
| `MINDOODB_CORS_ORIGIN` | var | you |
| `MINDOODB_JSON_BODY_LIMIT` | var | default `5mb` |
| `MINDOODB_TSA_PROVIDERS` | var | optional, as on Node |
| `MINDOODB_LARGE_ENTRIES` | R2 binding | optional; entries of 1 MB and more |
