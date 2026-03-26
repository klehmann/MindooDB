# MindooDB Example Server

A Node.js/Express server implementing the MindooDB sync API with:

- **Client-to-server sync** — clients push/pull encrypted entries
- **Server-to-server mirroring** — servers relay ciphertext without decryption
- **Tiered admin access** — full admin keys and delegated tenant creation keys
- **Multi-tenant** — each tenant is isolated with its own config, keybag, and stores

## Prerequisites

- Node.js 20 or later
- The MindooDB library must be built first (run `npm run build` in the root directory)

## Quick Start

```bash
# 1. Build MindooDB (from the root directory)
nvm use 20
npm install
npm run build

# 2. Install server dependencies
cd examples/server
npm install

# 3. Initialize server identity (one-time setup)
MINDOODB_SERVER_PASSWORD=your-secret npm run init -- --name server1

# 4. Start the server
MINDOODB_SERVER_PASSWORD=your-secret npm run dev
```

## CLI Reference

### `npm run dev` — Start the server

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--data-dir` | `-d` | Data directory path | `./data` |
| `--port` | `-p` | Server port | `1661` |
| `--auto-sync` | `-s` | Enable automatic sync with remote servers | disabled |
| `--static-dir` | `-w` | Serve static files at `/statics/` (e.g. bootstrap UI) | — |
| `--tls-cert` | — | Path to TLS certificate file (PEM) | — |
| `--tls-key` | — | Path to TLS private key file (PEM) | — |
| `--help` | `-h` | Show help message | — |

### `npm run init` — Initialize server identity

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--name` | `-n` | Server name (e.g., "server1") | **required** |
| `--data-dir` | `-d` | Data directory path | `./data` |
| `--force` | `-f` | Overwrite existing identity | — |
| `--help` | `-h` | Show help message | — |

### `npm run add-to-network` — Add a server to the network

| Option | Description | Default |
|--------|-------------|---------|
| `--new-server` | URL of the server being added | **required** |
| `--servers` | Comma-separated URLs of existing servers | **required** |
| `--api-key` | Admin API key (shared by all servers) | **required** |
| `--help` | Show help message | — |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINDOODB_SERVER_PASSWORD` | If server-identity.json exists | Password to decrypt server identity and per-tenant keybags |
| `MINDOODB_ADMIN_API_KEY` | Recommended | If set, protects admin endpoints with API key. **Warning logged on startup if not set.** |
| `MINDOODB_ADMIN_ALLOWED_IPS` | No | Comma-separated IPs/CIDRs allowed to access admin endpoints. Default: **localhost only** (`127.0.0.1`, `::1`). Set to `*` to allow all IPs. |
| `MINDOODB_CORS_ORIGIN` | No | Allowed CORS origin (e.g., `https://app.example.com`). If not set, CORS is disabled. |

## Data Directory Layout

```
data/
├── server-identity.json       # Global server identity (PrivateUserId)
├── trusted-servers.json       # Public keys of trusted remote servers
├── tenant-api-keys.json       # Delegated tenant creation API keys
├── acme/
│   ├── config.json            # Tenant configuration
│   └── stores/                # Content-addressed store data
└── other-tenant/
    ├── config.json
    └── stores/
```

## API Reference

### Admin Endpoints

#### Tenant Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/admin/register-tenant` | Admin key or tenant creation key | Register a new tenant |
| `GET` | `/admin/tenants` | Admin key only | List all registered tenants |
| `DELETE` | `/admin/tenants/:tenantId` | Admin key only | Remove a tenant |

#### Trusted Server Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/admin/trusted-servers` | Admin key only | List trusted servers |
| `POST` | `/admin/trusted-servers` | Admin key only | Add a trusted server |
| `DELETE` | `/admin/trusted-servers/:serverName` | Admin key only | Remove a trusted server |

#### Tenant Creation Key Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/admin/tenant-api-keys` | Admin key only | List tenant creation keys (masked) |
| `POST` | `/admin/tenant-api-keys` | Admin key only | Create a tenant creation key |
| `DELETE` | `/admin/tenant-api-keys/:name` | Admin key only | Revoke a tenant creation key |

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
| `GET` | `/admin/tenants/:tenantId/sync-servers` | Admin key only | List sync servers for a tenant |
| `POST` | `/admin/tenants/:tenantId/sync-servers` | Admin key only | Add or update a sync server |
| `DELETE` | `/admin/tenants/:tenantId/sync-servers/:serverName` | Admin key only | Remove a sync server |

### Server Info & Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health status |
| `GET` | `/.well-known/mindoodb-server-info` | Server name and public keys (unauthenticated) |

## Tiered Authentication

The server uses three levels of authentication:

1. **Admin API key** (`MINDOODB_ADMIN_API_KEY`) — full access to all admin endpoints. Set via environment variable, passed in the `X-API-Key` header.

2. **Tenant creation key** — can only create tenants via `POST /admin/register-tenant`. Optionally restricted to a tenant ID prefix. Created by an admin via `POST /admin/tenant-api-keys`. Passed in the `X-API-Key` header.

3. **User JWT token** — per-tenant sync access via Ed25519 challenge-response. Users are authenticated against the tenant's directory (admin-signed) or the config.json fallback.

## Walkthrough: Single Server Setup

### 1. Initialize the server

```bash
MINDOODB_SERVER_PASSWORD=secret npm run init -- --name server1 --data-dir ./data
```

This creates `server-identity.json`, `trusted-servers.json`, and `tenant-api-keys.json` in the data directory, and prints the server's public keys.

### 2. Start the server

```bash
MINDOODB_SERVER_PASSWORD=secret npm run dev -- -d ./data -p 1661
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
MINDOODB_SERVER_PASSWORD=secret1 npm run init -- --name server1 --data-dir ./data1

# Server 2
MINDOODB_SERVER_PASSWORD=secret2 npm run init -- --name server2 --data-dir ./data2
```

Both commands print the server's public keys.

### 2. Exchange public keys via admin API

```bash
# Tell server1 to trust server2
curl -X POST http://server1:3000/admin/trusted-servers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
  -d '{
    "name": "CN=server2",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }'

# Tell server2 to trust server1
curl -X POST http://server2:3000/admin/trusted-servers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
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
MINDOODB_SERVER_PASSWORD=secret1 npm run dev -- -d ./data1 -s
```

The servers will periodically sync all configured tenant databases, relaying encrypted entries without decrypting them.

## Walkthrough: Delegated Tenant Creation

### 1. Admin creates a tenant creation key

```bash
curl -X POST http://localhost:1661/admin/tenant-api-keys \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
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

The `add-to-network` CLI automates mutual trust exchange when adding a new server. It fetches each server's public keys via the well-known endpoint and registers them on every other server.

```bash
# 1. Initialize the new server
MINDOODB_SERVER_PASSWORD=secret4 npm run init -- --name server4 --data-dir ./data4

# 2. Start it
MINDOODB_SERVER_PASSWORD=secret4 npm run dev -- -d ./data4 -p 3003 &

# 3. Add it to the existing network
npm run add-to-network -- \
  --new-server http://localhost:3003 \
  --servers http://localhost:1661,http://localhost:3001,http://localhost:3002 \
  --api-key $ADMIN_KEY
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
curl -X POST http://server1:3000/admin/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
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
curl http://server1:3000/admin/tenants/acme/sync-servers \
  -H "X-API-Key: $ADMIN_KEY"
```

**Remove a sync server from a tenant:**

```bash
curl -X DELETE http://server1:3000/admin/tenants/acme/sync-servers/CN%3Dserver2 \
  -H "X-API-Key: $ADMIN_KEY"
```

Note: the server name in the URL must be percent-encoded (e.g., `CN%3Dserver2` for `CN=server2`).

### Complete workflow: new server joins and starts syncing

```bash
# Step 1: Init and start the new server
MINDOODB_SERVER_PASSWORD=secret npm run init -- --name server3 --data-dir ./data3
MINDOODB_SERVER_PASSWORD=secret npm run dev -- -d ./data3 -p 3002 &

# Step 2: Add to network (establishes trust with all existing servers)
npm run add-to-network -- \
  --new-server http://localhost:3002 \
  --servers http://localhost:1661,http://localhost:3001 \
  --api-key $ADMIN_KEY

# Step 3: Register the tenant on the new server (if not already published)
# (Usually done by the tenant admin via publishToServer)

# Step 4: Configure sync for specific tenants
curl -X POST http://localhost:3002/admin/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
  -d '{"name":"CN=server1","url":"http://localhost:1661","syncIntervalMs":60000,"databases":["directory","main"]}'

curl -X POST http://localhost:1661/admin/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
  -d '{"name":"CN=server3","url":"http://localhost:3002","syncIntervalMs":60000,"databases":["directory","main"]}'

# Step 5: Restart servers with --auto-sync to activate periodic sync
```

Sync config changes take effect on the next server restart or when auto-sync timers are restarted.

## Configuration File Formats

### `server-identity.json` (global)

Generated by `npm run init`. Contains a `PrivateUserId` with encrypted private keys:

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
- **Constant-time key comparison** -- API keys are compared using `crypto.timingSafeEqual()` to prevent timing attacks.
- **Error sanitization** -- internal errors never leak file paths or stack traces to clients. Only known auth/validation errors return specific messages.
- **Request size limits** -- JSON body limited to 5MB. Array sizes capped (100k IDs, 10k entries for putEntries).
- **Connection timeouts** -- idle connections are closed after 30 seconds.
- **Admin IP allowlist** -- admin endpoints are restricted to localhost by default. Set `MINDOODB_ADMIN_ALLOWED_IPS` to a comma-separated list of IPs or CIDRs (e.g., `10.0.0.0/8,192.168.1.0/24`) to allow specific networks, or `*` to allow all. IPv4-mapped IPv6 addresses (e.g., `::ffff:127.0.0.1`) are normalized automatically. When behind a reverse proxy, configure Express's `trust proxy` setting so that `req.ip` reflects the real client IP.

For production deployments, also consider:

- Enabling TLS (see below) or running behind a reverse proxy (nginx, Caddy) with TLS termination
- Setting `MINDOODB_ADMIN_API_KEY` (the server warns on startup if not set)
- Reviewing the `MINDOODB_ADMIN_ALLOWED_IPS` setting (defaults to localhost only)
- Using a process manager (PM2, systemd) for automatic restarts

## Static File Serving

The server can serve static files from a local directory, which is useful for hosting a bootstrap UI for [distributed web applications](../../docs/distributed-webapps.md). When `--static-dir` is provided, two additional routes are available:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Redirects to `/statics/index.html` if the file exists (302), otherwise returns 404 |
| `GET` | `/statics/*` | Serves files from the configured static directory |

### Usage

```bash
MINDOODB_SERVER_PASSWORD=secret npm run dev -- --static-dir ./webapp-bootstrap
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
MINDOODB_SERVER_PASSWORD=secret npm run dev -- \
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

The server ships with a multi-stage `Dockerfile` that produces a minimal Alpine-based image (~180 MB). The build context must be the **repository root** so that the mindoodb library can be compiled inside the image.

### Build the image

```bash
# From the repository root
docker build -f examples/server/Dockerfile -t mindoodb-server .
```

### Initialize server identity

The identity is stored inside the data directory, so point the container at a local `./data` folder. The init script requires overriding the default entrypoint:

```bash
docker run --rm \
  -v "$(pwd)/data:/data" \
  -e MINDOODB_SERVER_PASSWORD=your-secret \
  --entrypoint node \
  mindoodb-server dist/init.js --data-dir /data --name server1
```

### Run the server

```bash
docker run -d --name mindoodb \
  -v "$(pwd)/data:/data" \
  -p 1661:1661 \
  -e MINDOODB_SERVER_PASSWORD=your-secret \
  -e MINDOODB_ADMIN_API_KEY=your-admin-key \
  mindoodb-server
```

Additional CLI flags can be appended after the image name:

```bash
docker run -d --name mindoodb \
  -v "$(pwd)/data:/data" \
  -p 8443:8443 \
  -e MINDOODB_SERVER_PASSWORD=your-secret \
  mindoodb-server --port 8443 --auto-sync
```

### Verify

```bash
curl http://localhost:1661/health
```

## Development

### Build

```bash
npm run build
```

### Run in development mode

```bash
npm run dev
```

### Run built version

```bash
npm start -- -d ./data -p 1661
```

## Testing

The integration tests are located in the main MindooDB package at `src/__tests__/ExampleServer.test.ts`. Run them with:

```bash
# From the root mindoodb directory
npm test -- ExampleServer
```
