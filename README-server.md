# MindooDB reference server

Node.js/Express sources: `src/node/server/`. Docker: `src/node/server/Dockerfile`.

A Node.js/Express server implementing the MindooDB sync API with:

- **Client-to-server sync** — clients push/pull encrypted entries
- **Server-to-server mirroring** — servers relay ciphertext without decryption
- **Capabilities-based system admin security** — challenge/response auth with JWT and fine-grained route authorization
- **Multi-tenant** — each tenant is isolated with its own config, keybag, and stores

## Prerequisites

- Node.js 20 or later
- The MindooDB library must be built first (run `npm run build` in the root directory)

## System admin API (`/system/*`)

Server administration uses **`/system/...`** routes (the old **`/admin/...`** paths are gone). Authenticate with a JWT from **`POST /system/auth/challenge`** and **`POST /system/auth/authenticate`**, then send **`Authorization: Bearer <token>`** on later requests. Full flow and capabilities are in [Server Security](docs/server-security.md). In Node you can use **`MindooDBServerAdmin`** (with your `CryptoAdapter`) instead of raw `curl`.

The **`curl`** examples below use **`$SYSTEM_ADMIN_JWT`** as a placeholder for that token.

## Quick Start

Prefer **`MINDOODB_SERVER_PASSWORD_FILE`** (path to a file containing the password) over **`MINDOODB_SERVER_PASSWORD`** so the plaintext secret is not stored in the process environment block (visible via `docker inspect`, `/proc/<pid>/environ`, etc.). For **`server:add-to-network`**, use **`--password-file`** instead of **`MINDOODB_SYSTEM_ADMIN_PASSWORD`** when you can.

```bash
# 1. Build MindooDB (from the root directory)
nvm use 20
npm install
npm run build

# 2. Store the server password in a file (one-time)
echo -n 'your-secret' > ./.server-password && chmod 600 ./.server-password

# 3. Initialize server identity (one-time setup, from repo root)
MINDOODB_SERVER_PASSWORD_FILE=./.server-password npm run server:init -- --name server1

# 4. Start the server
MINDOODB_SERVER_PASSWORD_FILE=./.server-password npm run server:start
```

`npm run server:dev` runs the TypeScript entry with `ts-node-dev` (same flags as in the table below).

## CLI Reference

### `npm run server:dev` / `npm run server:start` — Start the server

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--data-dir` | `-d` | Data directory path | `./data` |
| `--port` | `-p` | Server port | `1661` |
| `--auto-sync` | `-s` | Enable automatic sync with remote servers | disabled |
| `--static-dir` | `-w` | Serve static files at `/statics/` (e.g. bootstrap UI) | — |
| `--tls-cert` | — | Path to TLS certificate file (PEM) | — |
| `--tls-key` | — | Path to TLS private key file (PEM) | — |
| `--help` | `-h` | Show help message | — |

### `npm run server:init` — Initialize server identity

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--name` | `-n` | Server name (e.g., "server1") | **required** |
| `--data-dir` | `-d` | Data directory path | `./data` |
| `--force` | `-f` | Overwrite existing identity | — |
| `--help` | `-h` | Show help message | — |

### `npm run server:add-to-network` — Add a server to the network

| Option | Description | Default |
|--------|-------------|---------|
| `--new-server` | URL of the server being added | **required** |
| `--servers` | Comma-separated URLs of existing servers | **required** |
| `--identity` | Path to system admin `*.identity.json` (`PrivateUserId`) | **required** |
| `--password-file` | File containing the system admin password (optional if env or TTY) | — |
| `--help` | Show help message | — |

Password resolution: `MINDOODB_SYSTEM_ADMIN_PASSWORD`, then `--password-file`, then a hidden prompt on an interactive TTY. The **same** identity must be authorized in each server’s `config.json` for every URL you pass.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINDOODB_SERVER_PASSWORD` | If server-identity.json exists and `MINDOODB_SERVER_PASSWORD_FILE` is unset | Password to decrypt server identity and per-tenant keybags |
| `MINDOODB_SERVER_PASSWORD_FILE` | No | Path to a file whose contents are the server password (trimmed). If set, **used instead of** `MINDOODB_SERVER_PASSWORD`. Prefer for Docker: env only holds the path, not the secret. |
| `MINDOODB_SYSTEM_ADMIN_PASSWORD` | No | For `server:add-to-network`: password for `--identity` (if not using `--password-file` or interactive prompt). May be visible in `ps` on shared hosts. |
| `MINDOODB_CORS_ORIGIN` | No | Allowed CORS origin (e.g., `https://app.example.com`). If not set, CORS is disabled. |
| `MINDOODB_ADMIN_ALLOWED_IPS` | No | Optional comma-separated client IPs/CIDRs allowed to call **`/system/*`** (all system admin routes, including `/system/auth/*`). If unset or `*`, any source IP may reach `/system/*` (JWT + `config.json` capabilities still apply). Example: `127.0.0.1,::1,172.23.248.0/24`. Behind a reverse proxy, configure Express `trust proxy` so `req.ip` is the real client. |

> **Note:** The old `MINDOODB_ADMIN_API_KEY` variable has been removed. System admin **authorization** is enforced by `config.json` capabilities and JWTs. **`MINDOODB_ADMIN_ALLOWED_IPS`** is an optional **network** layer for `/system/*` only. See [Server Security](docs/server-security.md).

## Data Directory Layout

```
data/
├── server-identity.json                       # Global server identity (PrivateUserId)
├── config.json                                # Capabilities-based system admin config
├── trusted-servers.json                       # Public keys of trusted remote servers
├── tenant-api-keys.json                       # Delegated tenant creation API keys
├── system-admin-cn-sysadmin-o-myorg.identity.json  # System admin identity (password-encrypted)
├── acme/
│   ├── config.json                            # Tenant configuration
│   └── stores/                                # Content-addressed store data
└── other-tenant/
    ├── config.json
    └── stores/
```

## API Reference

### System Admin Endpoints (`/system/*`)

All system admin endpoints require a JWT obtained via challenge/response authentication.
See [Server Security](docs/server-security.md) for full details.

#### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/system/auth/challenge` | None | Request a challenge (body: `{ username, publicsignkey }`) |
| `POST` | `/system/auth/authenticate` | None | Submit signed challenge |

#### Tenant Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/system/tenants/:tenantId` | JWT | Create a tenant |
| `GET` | `/system/tenants` | JWT | List all registered tenants |
| `PUT` | `/system/tenants/:tenantId` | JWT | Update tenant config |
| `DELETE` | `/system/tenants/:tenantId` | JWT | Remove a tenant |

#### Trusted Server Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/system/trusted-servers` | JWT | List trusted servers |
| `POST` | `/system/trusted-servers` | JWT | Add a trusted server |
| `DELETE` | `/system/trusted-servers/:serverName` | JWT | Remove a trusted server |

#### Tenant Creation Key Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/system/tenant-api-keys` | JWT | List tenant creation keys (masked) |
| `POST` | `/system/tenant-api-keys` | JWT | Create a tenant creation key |
| `DELETE` | `/system/tenant-api-keys/:name` | JWT | Revoke a tenant creation key |

### Authentication Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/:tenantId/auth/challenge` | Request authentication challenge |
| `POST` | `/:tenantId/auth/authenticate` | Authenticate with signed challenge |

### Sync Endpoints (requires JWT token)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/:tenantId/sync/findNewEntries` | Find entries we don't have |
| `POST` | `/:tenantId/sync/findNewEntriesForDoc` | Find entries for specific document |
| `POST` | `/:tenantId/sync/getEntries` | Get specific entries |
| `POST` | `/:tenantId/sync/putEntries` | Push entries to server |
| `POST` | `/:tenantId/sync/hasEntries` | Check which entry IDs exist |
| `GET` | `/:tenantId/sync/getAllIds` | Get all entry IDs |
| `POST` | `/:tenantId/sync/resolveDependencies` | Resolve dependency chain |
| `POST` | `/:tenantId/sync/findEntries` | Find entries by type/date |
| `POST` | `/:tenantId/sync/scanEntriesSince` | Cursor-based entry scanning |
| `POST` | `/:tenantId/sync/getIdBloomSummary` | Get Bloom filter summary |
| `GET` | `/:tenantId/sync/capabilities` | Get server capabilities |

#### Per-Tenant Sync Server Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/system/tenants/:tenantId/sync-servers` | JWT | List sync servers for a tenant |
| `POST` | `/system/tenants/:tenantId/sync-servers` | JWT | Add or update a sync server |
| `DELETE` | `/system/tenants/:tenantId/sync-servers/:serverName` | JWT | Remove a sync server |
| `POST` | `/system/tenants/:tenantId/trigger-sync` | JWT | Trigger sync for a tenant |

#### Server Config Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/system/config` | JWT | Read the current server config |
| `PUT` | `/system/config` | JWT | Replace the server config (no restart needed) |

### Server Info & Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health status |
| `GET` | `/.well-known/mindoodb-server-info` | Server name and public keys (unauthenticated) |

## Tiered Authentication

1. **System admin** — `config.json` capabilities + Ed25519 challenge/response + short-lived JWT for `/system/*`. Optional **`MINDOODB_ADMIN_ALLOWED_IPS`** restricts which client IPs may use the `/system/*` HTTP surface.

2. **Tenant creation key** — delegated keys stored in `tenant-api-keys.json` (managed via `/system/tenant-api-keys`). Intended for limited tenant registration; see server implementation for current enforcement.

3. **User JWT** — per-tenant sync via Ed25519 challenge-response. Users are authenticated against the tenant directory (admin-signed).

## Walkthrough: Single Server Setup

### 1. Initialize the server

```bash
mkdir -p ./data && echo -n 'secret' > ./data/.server-password && chmod 600 ./data/.server-password
MINDOODB_SERVER_PASSWORD_FILE=./data/.server-password npm run server:init -- --name server1 --data-dir ./data
```

This creates `server-identity.json`, `trusted-servers.json`, and `tenant-api-keys.json` in the data directory, and prints the server's public keys.

### 2. Start the server

```bash
MINDOODB_SERVER_PASSWORD_FILE=./data/.server-password npm run server:dev -- -d ./data -p 1661
```

### 3. Client creates a tenant and publishes to server

```typescript
import { BaseMindooTenantFactory, InMemoryContentAddressedStoreFactory } from "mindoodb";

const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory());
const result = await factory.createTenant({
  tenantId: "acme",
  adminName: "cn=admin/o=acme",
  adminPassword: "admin-pass",
  userName: "cn=alice/o=acme",
  userPassword: "alice-pass",
});

// Register tenant on server (sends admin keys + $publicinfos key)
await result.tenant.publishToServer("http://localhost:1661", {
  adminUsername: result.adminUser.username,
  registerUsers: [factory.toPublicUserId(result.appUser)],
});
```

### 4. Client syncs data

```typescript
// Create a remote store for the "main" database
const remoteStore = await result.tenant.connectToServer(
  "http://localhost:1661",
  "main",
);

const db = await result.tenant.openDB("main");

// Push local changes to server
await db.pushChangesTo(remoteStore);

// Pull server changes to local
await db.pullChangesFrom(remoteStore);
await db.syncStoreChanges();
```

## Walkthrough: Multi-Server Mirroring

### 1. Initialize both servers

```bash
# Server 1
mkdir -p ./data1 && echo -n 'secret1' > ./data1/.server-password && chmod 600 ./data1/.server-password
MINDOODB_SERVER_PASSWORD_FILE=./data1/.server-password npm run server:init -- --name server1 --data-dir ./data1

# Server 2
mkdir -p ./data2 && echo -n 'secret2' > ./data2/.server-password && chmod 600 ./data2/.server-password
MINDOODB_SERVER_PASSWORD_FILE=./data2/.server-password npm run server:init -- --name server2 --data-dir ./data2
```

Both commands print the server's public keys.

### 2. Exchange public keys via the system admin API

```bash
# Tell server1 to trust server2
curl -X POST http://server1:3000/system/trusted-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{
    "name": "CN=server2",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }'

# Tell server2 to trust server1
curl -X POST http://server2:3000/system/trusted-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{
    "name": "CN=server1",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }'
```

Trust changes take effect immediately — no restart required.

### 3. Publish tenant to both servers

```typescript
await tenant.publishToServer("http://server1:3000");
await tenant.publishToServer("http://server2:3000");
```

### 4. Configure remote servers in tenant config

Add `remoteServers` to `data1/acme/config.json` on server 1:

```json
{
  "remoteServers": [
    {
      "url": "http://server2:3000",
      "syncIntervalMs": 60000,
      "databases": ["directory", "main"]
    }
  ]
}
```

And vice versa on server 2.

### 5. Start servers with auto-sync

```bash
MINDOODB_SERVER_PASSWORD_FILE=./data1/.server-password npm run server:dev -- -d ./data1 -s
```

The servers will periodically sync all configured tenant databases, relaying encrypted entries without decrypting them.

## Walkthrough: Delegated Tenant Creation

### 1. Admin creates a tenant creation key

```bash
curl -X POST http://localhost:1661/system/tenant-api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{"name": "acme-corp", "tenantIdPrefix": "acme-"}'
```

Response:
```json
{
  "success": true,
  "name": "acme-corp",
  "apiKey": "mdb_tk_a1b2c3d4...",
  "tenantIdPrefix": "acme-"
}
```

### 2. Share the key with the customer

The customer uses this key when publishing their tenant:

```typescript
await tenant.publishToServer("http://localhost:1661", {
  adminApiKey: "mdb_tk_a1b2c3d4...",
  adminUsername: adminUser.username,
  registerUsers: [factory.toPublicUserId(appUser)],
});
```

### 3. Prefix enforcement

- `tenantId: "acme-prod"` — allowed (matches prefix `acme-`)
- `tenantId: "other-org"` — rejected with 403

## Network Management

This section covers adding servers to a MindooDB network and configuring per-tenant sync.

### Server discovery endpoint

Every initialized server exposes its public identity at a well-known URL:

```bash
curl https://server1.example.com/.well-known/mindoodb-server-info
```

Response:

```json
{
  "name": "CN=server1",
  "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

This eliminates the need to manually copy public keys between servers.

### Adding a server to the network

The `add-to-network` CLI automates mutual trust exchange when adding a new server. It calls **`POST /system/trusted-servers`** on each side (JWT from challenge/response using your system admin identity). It fetches each server's public keys from `/.well-known/mindoodb-server-info`.

**Secrets:** Prefer **`--password-file`** for the system admin password (and **`MINDOODB_SERVER_PASSWORD_FILE`** for the server identity) so secrets are not placed in the process environment. Use **`MINDOODB_SYSTEM_ADMIN_PASSWORD`** only when you must script without files. A leading space before the command or `HISTCONTROL=ignorespace` reduces shell-history leakage for typed passwords.

```bash
# 1. Initialize the new server
mkdir -p ./data4 && echo -n 'secret4' > ./data4/.server-password && chmod 600 ./data4/.server-password
MINDOODB_SERVER_PASSWORD_FILE=./data4/.server-password npm run server:init -- --name server4 --data-dir ./data4

# 2. Start it
MINDOODB_SERVER_PASSWORD_FILE=./data4/.server-password npm run server:dev -- -d ./data4 -p 3003 &

# 3. Add it to the existing network (same system admin identity on every server)
echo -n 'admin-pass' > ./.admin-password && chmod 600 ./.admin-password
npm run server:add-to-network -- \
  --new-server http://localhost:3003 \
  --servers http://localhost:1661,http://localhost:3001,http://localhost:3002 \
  --identity ./data1/system-admin-cn-sysadmin-o-myorg.identity.json \
  --password-file ./.admin-password
```

The CLI will:

1. Fetch server4's public keys from `/.well-known/mindoodb-server-info`
2. For each existing server, fetch its public keys and exchange trust in both directions
3. Print a summary showing how many servers were successfully configured

If a server pair is already trusted, the CLI skips that pair instead of failing.

### Configuring per-tenant sync

After trust is established, configure which tenants each server syncs by using the admin API. This gives full control over sync topology — not every server needs to sync every tenant.

**Add a sync server for a tenant:**

```bash
curl -X POST http://server1:3000/system/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{
    "name": "CN=server2",
    "url": "http://server2:3000",
    "syncIntervalMs": 60000,
    "databases": ["directory", "main"]
  }'
```

The `databases` field is required and controls which databases are synced with the remote server. The `name` field identifies the remote server (must match the trusted server name). If a server with the same name already exists for the tenant, it is updated.

**List sync servers for a tenant:**

```bash
curl http://server1:3000/system/tenants/acme/sync-servers \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT"
```

**Remove a sync server from a tenant:**

```bash
curl -X DELETE http://server1:3000/system/tenants/acme/sync-servers/CN%3Dserver2 \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT"
```

Note: the server name in the URL must be percent-encoded (e.g., `CN%3Dserver2` for `CN=server2`).

### Complete workflow: new server joins and starts syncing

```bash
# Step 1: Init and start the new server (password from file, not env)
echo -n 'secret' > ./data3/.server-password && chmod 600 ./data3/.server-password
MINDOODB_SERVER_PASSWORD_FILE=./data3/.server-password npm run server:init -- --name server3 --data-dir ./data3
MINDOODB_SERVER_PASSWORD_FILE=./data3/.server-password npm run server:dev -- -d ./data3 -p 3002 &

# Step 2: Add to network (establishes trust with all existing servers)
echo -n 'admin-pass' > ./.admin-password && chmod 600 ./.admin-password
npm run server:add-to-network -- \
  --new-server http://localhost:3002 \
  --servers http://localhost:1661,http://localhost:3001 \
  --identity ./data1/system-admin-cn-sysadmin-o-myorg.identity.json \
  --password-file ./.admin-password

# Step 3: Register the tenant on the new server (if not already published)
# (Usually done by the tenant admin via publishToServer)

# Step 4: Configure sync for specific tenants
curl -X POST http://localhost:3002/system/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{"name":"CN=server1","url":"http://localhost:1661","syncIntervalMs":60000,"databases":["directory","main"]}'

curl -X POST http://localhost:1661/system/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{"name":"CN=server3","url":"http://localhost:3002","syncIntervalMs":60000,"databases":["directory","main"]}'

# Step 5: Restart servers with --auto-sync to activate periodic sync
```

Sync config changes take effect on the next server restart or when auto-sync timers are restarted.

## Configuration File Formats

### `server-identity.json` (global)

Generated by `npm run server:init`. Contains a `PrivateUserId` with encrypted private keys:

```json
{
  "username": "CN=server1",
  "userSigningKeyPair": {
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
    "privateKey": {
      "ciphertext": "...",
      "iv": "...",
      "tag": "...",
      "salt": "...",
      "iterations": 100000
    }
  },
  "userEncryptionKeyPair": {
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
    "privateKey": {
      "ciphertext": "...",
      "iv": "...",
      "tag": "...",
      "salt": "...",
      "iterations": 100000
    }
  }
}
```

### `trusted-servers.json` (global)

```json
[
  {
    "name": "CN=server2",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n..."
  }
]
```

### `tenant-api-keys.json` (global)

```json
[
  {
    "apiKey": "mdb_tk_a1b2c3...",
    "name": "acme-corp",
    "tenantIdPrefix": "acme-",
    "createdAt": 1708617600000
  }
]
```

### `<tenantId>/config.json`

```json
{
  "adminUsername": "cn=admin/o=acme",
  "adminSigningPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "adminEncryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "publicInfosKey": "base64-encoded-aes-key",
  "defaultStoreType": "file",
  "users": [
    {
      "username": "alice",
      "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
      "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n..."
    }
  ],
  "remoteServers": [
    {
      "name": "CN=server2",
      "url": "https://server2.example.com",
      "syncIntervalMs": 60000,
      "databases": ["directory", "main"]
    }
  ]
}
```

## Security

The server includes the following hardening measures:

- **Input validation** -- all identifiers (tenantId, dbId, serverName) are validated to prevent path traversal. Only lowercase alphanumeric characters and hyphens are allowed, max 64 characters. Tenant IDs that collide with server route prefixes (`admin`, `health`, `statics`) are rejected as reserved names.
- **Rate limiting** -- tiered per-IP rate limits: auth endpoints (20/min), admin endpoints (30/min), sync endpoints (200/min), global fallback (500/min). Returns `429 Too Many Requests` when exceeded.
- **Security headers** -- `helmet` middleware sets X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, Strict-Transport-Security, and others.
- **CORS** -- disabled by default. Set `MINDOODB_CORS_ORIGIN` to allow a specific origin.
- **Constant-time key comparison** -- tenant creation API keys are compared using `crypto.timingSafeEqual()` where applicable.
- **Error sanitization** -- internal errors never leak file paths or stack traces to clients. Only known auth/validation errors return specific messages.
- **Request size limits** -- JSON body limited to 5MB. Array sizes capped (100k IDs, 10k entries for putEntries).
- **Connection timeouts** -- idle connections are closed after 30 seconds.
- **Optional `/system/*` IP allowlist** — set `MINDOODB_ADMIN_ALLOWED_IPS` to a comma-separated list of IPs or IPv4 CIDRs (e.g., `127.0.0.1,::1,10.0.0.0/8`) to restrict which client addresses may call **any** `/system/*` route (including auth). If unset or `*`, there is no IP restriction at this layer. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. Behind a reverse proxy, configure Express `trust proxy` so `req.ip` is accurate.

For production deployments, also consider:

- Enabling TLS (see below) or running behind a reverse proxy (nginx, Caddy) with TLS termination
- Setting `MINDOODB_ADMIN_ALLOWED_IPS` if `/system/*` should only be reachable from operator networks
- Using a process manager (PM2, systemd) for automatic restarts

## Static File Serving

The server can serve static files from a local directory, which is useful for hosting a bootstrap UI for [distributed web applications](docs/distributed-webapps.md). When `--static-dir` is provided, two additional routes are available:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Redirects to `/statics/index.html` if the file exists (302), otherwise returns 404 |
| `GET` | `/statics/*` | Serves files from the configured static directory |

### Usage

```bash
MINDOODB_SERVER_PASSWORD_FILE=./.server-password npm run server:dev -- --static-dir ./webapp-bootstrap
```

The static directory might contain a minimal bootstrap page that registers a service worker and triggers the initial MindooDB sync for a distributed web application:

```
webapp-bootstrap/
├── index.html          # Minimal HTML shell, registers the service worker
├── bootstrap.js        # Sync logic: check pointer DB, sync UI DB
├── sw.js               # Service worker: serves UI assets from IndexedDB
└── style.css           # Loading indicator styles
```

Path traversal is prevented by an explicit guard that rejects requests containing `..`, in addition to the built-in protection provided by Express's static middleware. Dotfiles (`.env`, `.git`, etc.) are not served.

## TLS / HTTPS

The server supports TLS directly via `--tls-cert` and `--tls-key` flags. No additional dependencies are required.

### Starting with TLS

```bash
MINDOODB_SERVER_PASSWORD_FILE=./.server-password npm run server:dev -- \
  --tls-cert /etc/letsencrypt/live/sync.example.com/fullchain.pem \
  --tls-key /etc/letsencrypt/live/sync.example.com/privkey.pem \
  -p 443
```

Both flags must be provided together. The certificate file should be the full chain (PEM format).

### Free certificates with Let's Encrypt

#### Method A: Standalone (HTTP-01)

Certbot briefly binds port 80 to prove domain ownership. Best when port 80 is available.

```bash
# Install certbot (Ubuntu/Debian)
sudo apt install certbot

# Obtain certificate
sudo certbot certonly --standalone -d sync.example.com
```

Auto-renewal is handled by certbot's systemd timer, which runs automatically on most Linux distributions. After renewal, restart the server to pick up the new certificate.

#### Method B: DNS (DNS-01)

Prove ownership via a DNS TXT record. No port 80 required -- works behind firewalls and on non-standard ports.

**Automated (recommended for production)** -- use a DNS provider plugin so renewal is fully unattended:

```bash
# Example with Cloudflare
sudo apt install certbot python3-certbot-dns-cloudflare

# Create credentials file
cat > /etc/letsencrypt/cloudflare.ini << EOF
dns_cloudflare_api_token = your-cloudflare-api-token
EOF
chmod 600 /etc/letsencrypt/cloudflare.ini

# Obtain certificate
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d sync.example.com
```

With a DNS plugin, certbot creates and removes the TXT record via the provider's API automatically. The systemd timer handles renewal with zero manual intervention.

**Manual (testing only)** -- requires updating the DNS TXT record by hand every 90 days:

```bash
sudo certbot certonly --manual --preferred-challenges dns -d sync.example.com
# Certbot will ask you to create: _acme-challenge.sync.example.com TXT "..."
```

Available DNS plugins include Cloudflare, Route53, Google Cloud DNS, DigitalOcean, Linode, and OVH. See the [certbot documentation](https://eff-certbot.readthedocs.io/en/latest/using.html#dns-plugins) for the full list.

## Docker

The server ships with a multi-stage `Dockerfile` under `src/node/server/` that produces a minimal Alpine-based image. The build context must be the **repository root** so the library and server compile together.

### Build the image

```bash
# From the repository root
docker build -f src/node/server/Dockerfile -t mindoodb-server .
```

### Initialize server identity

The identity is stored inside the data directory, so point the container at a local `./data` folder. The init script requires overriding the default entrypoint. Prefer a **mounted password file** so the secret is not passed as `-e MINDOODB_SERVER_PASSWORD=...`:

```bash
echo -n 'your-secret' > ./server-password && chmod 600 ./server-password
docker run --rm \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/server-password:/run/secrets/server_password:ro" \
  -e MINDOODB_SERVER_PASSWORD_FILE=/run/secrets/server_password \
  --entrypoint node \
  mindoodb-server dist/node/server/serverinit.js --data-dir /data --name server1
```

### Run the server

```bash
docker run -d --name mindoodb \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/server-password:/run/secrets/server_password:ro" \
  -e MINDOODB_SERVER_PASSWORD_FILE=/run/secrets/server_password \
  -p 1661:1661 \
  mindoodb-server
```

Optional: restrict `/system/*` to specific networks, e.g. `-e MINDOODB_ADMIN_ALLOWED_IPS=127.0.0.1,10.0.0.0/8`.

Additional CLI flags can be appended after the image name:

```bash
docker run -d --name mindoodb \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/server-password:/run/secrets/server_password:ro" \
  -e MINDOODB_SERVER_PASSWORD_FILE=/run/secrets/server_password \
  -p 8443:8443 \
  mindoodb-server --port 8443 --auto-sync
```

### Verify

```bash
curl http://localhost:1661/health
```

## Development

From the **repository root** (where `README-server.md` lives):

### Build

```bash
npm run build
```

### Run in development mode

```bash
MINDOODB_SERVER_PASSWORD_FILE=./.server-password npm run server:dev -- -d ./data -p 1661
```

### Run built version

```bash
MINDOODB_SERVER_PASSWORD_FILE=./.server-password npm run server:start -- -d ./data -p 1661
```

## Testing

The integration tests are located in the main MindooDB package at `src/__tests__/ExampleServer.test.ts`. Run them with:

```bash
# From the root mindoodb directory
npm test -- ExampleServer
```
