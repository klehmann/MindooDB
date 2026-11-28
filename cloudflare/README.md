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
folder only holds the Worker's configuration. Updating the server means
installing a newer `mindoodb` and deploying again (see [Updating](#updating)).

## Requirements

- A Cloudflare account on the **Workers Paid** plan (5 USD/month as of 2026).
  The server signs, verifies and wraps keys on every sync request, and that
  does not fit the free plan's CPU time per request.
- Node.js 22+ on your machine for the setup and for updates.

## Deploy

There are two ways. Both end with the same Worker; they differ in where its
configuration lives and how it is updated later.

| | Deploy button | From a copy of this folder |
|---|---|---|
| Configuration lives in | a new GitHub/GitLab repository of yours | a folder on your machine (keep it, e.g. in your own repository) |
| Updates | merge a pull request that bumps `mindoodb`; Cloudflare deploys on push | `npm run update` |
| Good for | one server that should stay current with little effort | several servers, scripted setups, servers without a Git host |

Whichever you choose, keep the system admin identity that setup writes
(`system-admin-*.identity.json`) and its password somewhere safe and **out of
Git**. It is the only copy of the admin's private key.

### A. Deploy button

1. Click **Deploy to Cloudflare** above. Cloudflare copies this folder into a
   new repository of yours, creates the R2 bucket and deploys the Worker
   (`mindoodb-server.<account>.workers.dev`). The server has no identity yet:
   `/.well-known/mindoodb-server-info` answers 503 until step 3.
2. Clone the new repository and install:
   ```bash
   npm install
   npx wrangler login
   ```
3. Create the server identity and a system administrator and store them as
   secrets of the deployed Worker (continue with [Check it](#check-it)):
   ```bash
   npm run setup
   ```

### B. From a copy of this folder

1. Copy the folder (not a clone of the whole MindooDB repository) and install:
   ```bash
   git clone --depth 1 https://github.com/klehmann/MindooDB.git
   cp -R MindooDB/cloudflare mindoodb-server && cd mindoodb-server
   npm install
   npx wrangler login
   ```
2. Pick the Worker name (`"name"` in `wrangler.jsonc`, default
   `mindoodb-server`; it becomes the host name), the browser origins
   (`MINDOODB_CORS_ORIGIN`, see [Browser clients](#browser-clients)), and
   create the bucket for large entries:
   ```bash
   npx wrangler r2 bucket create mindoodb-large-entries
   ```
3. Deploy. The server answers 503 until setup has run:
   ```bash
   npm run deploy
   ```
4. Create the server identity and the system admin:
   ```bash
   npm run setup                         # or: npm run setup -- --config demo.json
   ```

### What setup does

`npm run setup` creates the server identity and a system administrator, then
stores four secrets on the Worker (`wrangler secret put`, which also rolls out
a new version): the server identity, its random password, the key from which
sync tokens are derived, and the initial `config.json`. It asks for the admin
password (or reads `MINDOODB_ADMIN_PASSWORD`) and writes
`system-admin-cn=sysadmin.identity.json` into the current directory.

Options: `--admin <name>` for another admin name, `--admin-public
<identity.json>` to make an existing identity the admin, `--config <file>` to
start with own rules, e.g. a demo server (see
[Server settings](#server-settings-configjson)). Run setup only once per
server: running it again replaces the server identity and its password, so
the server can no longer open the tenant keys it stored, and clients that
trust the old key refuse it.

### Check it

```bash
curl https://mindoodb-server.<account>.workers.dev/.well-known/mindoodb-server-info
npm run config -- --url https://mindoodb-server.<account>.workers.dev get
```

The first shows the server name and keys; the second proves that the admin
identity and password work. Then publish a tenant from Haven ("Push to
server") or the SDK.

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

Set `MINDOODB_CORS_ORIGIN` in `wrangler.jsonc` to the origins of your web
apps, comma-separated, e.g.
`"https://haven.example.com,http://localhost:4174"`, and deploy. Set it in
`wrangler.jsonc` rather than in the dashboard: every `wrangler deploy`
replaces the dashboard's variables with the ones in the file. Native apps and
Node clients do not need it.

## Updating

An update has up to two parts:

- **Code:** a newer `mindoodb` package. This is the usual case.
- **Worker configuration:** occasionally a release needs a change in
  `wrangler.jsonc`, e.g. a new Durable Object class with its `migrations`
  entry, a new binding or a new limit. The release notes say so; compare your
  `wrangler.jsonc` with this folder's.

Data stays where it is. Durable Object storage and R2 are not touched by a
deploy, and every object brings its own tables up to date when it starts. The
secrets (server identity, admin, config) stay as they are.

### With a copy of this folder

```bash
npm run update            # newest mindoodb release
npm run update -- 0.2.1   # a specific release
```

The script installs the release (pinned exactly in `package.json`), shows the
version change and deploys with the tag `mindoodb-<version>`, so
`npx wrangler versions list` shows which release each Worker version runs.
Check the server afterwards as under [Check it](#check-it). Commit
`package.json` and `package-lock.json` if you keep the folder in Git.

### With the Deploy button's repository

Cloudflare (Workers Builds) deploys every push to the repository's main
branch. To update, change the `mindoodb` version in `package.json`, run
`npm install` so the lock file follows, and push. The repository contains a
Dependabot configuration that opens such a pull request every week when a new
`mindoodb` release is out (enable Dependabot in the repository's settings on
GitHub); merging it deploys the update.

### Rolling back

Every deploy creates a new Worker version; the previous ones stay available:

```bash
npx wrangler versions list                 # versions with their mindoodb tag
npx wrangler rollback <version-id>         # serve an earlier version again
```

A rollback only switches the code; stored data stays as the newer version left
it. That is safe as long as releases keep their storage readable by the
previous release, which MindooDB does: storage changes only add tables,
columns or entries. Durable Object class migrations cannot be undone; a
release that adds one says so.

## Create tenants

As on the Node server: a client publishes a tenant with the system admin's
identity (`tenant.publishToServer(url, { systemAdminUser, systemAdminPassword, ... })`
in the SDK, or Haven's "publish to server"). Who else may create tenants is
set in `config.json` (next section).

## Server settings (config.json)

`config.json` has the format of the Node server (see `README-server.md` in the
MindooDB repository): `capabilities` decide who may call which `/system/*`
route, `cluster` enables peer replication. There is no file on Cloudflare; the
server object keeps the config in its storage:

1. `npm run setup` stores the first config as the `MINDOODB_SERVER_CONFIG`
   secret (the system admin gets `ALL:/system/*`; add your own rules with
   `--config <file>`). The server uses it as long as it has no stored config.
2. From then on, change it at runtime as system admin. It applies
   immediately, without a redeploy, and the previous version is kept as a
   backup:
   ```bash
   npm run config -- --url https://<name>.<account>.workers.dev get > config.json
   # edit config.json
   npm run config -- --url https://<name>.<account>.workers.dev put config.json
   ```
   After the first `put`, the stored config wins; changing the
   `MINDOODB_SERVER_CONFIG` secret no longer has an effect.

**Demo server** (anyone may create a tenant; nobody but the admin may list
tenants or change the config, and each tenant's own admin may delete it):

```json
{
  "capabilities": {
    "ALL:/system/*": [{ "username": "cn=sysadmin", "publicsignkey": "<admin key from get>" }],
    "POST:/system/tenants/*": [{ "username": "*", "publicsignkey": "*" }]
  }
}
```

Use `POST:/system/tenants/demo_*` to allow only tenant ids with that prefix.
For a fresh server the rule can go into the initial config instead:
`npm run setup -- --config demo.json` with only the `POST:/system/tenants/*`
entry (setup adds the admin).

Settings that are not in `config.json` are Worker variables in
`wrangler.jsonc` or the dashboard (table at the end), and rate limits are
the `ratelimits` bindings.

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
npm run dev                # wrangler dev on http://localhost:8787, storage stays local in .wrangler/
npm run config -- --url http://localhost:8787 get
```

## Differences from the Node server

- **Not available:** Iroh (neither for clients nor between peers).
- **Device discovery** (`/device/*`, how a device finds the tenants that
  granted it access, e.g. after its join request was admitted) asks each
  tenant's directory object; like on Node it looks at every tenant, so it has
  its own tight rate limit (`MINDOODB_RATE_LIMIT_DEVICE`).
- **Invitations and join requests** (`/<tenant>/invitations/*`,
  `/<tenant>/join-requests/*`) are served by the tenant's `joinrequests`
  object. The limits in `config.json` (`joinRequests`) apply, but per tenant:
  the hourly budget per client address and the server-wide cap of pending
  requests are counted per tenant and in memory, so they start over when the
  object is evicted. The `MINDOODB_RATE_LIMIT_INVITE*` bindings cap bursts per
  address across all tenants.
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
