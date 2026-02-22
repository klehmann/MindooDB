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
| `--port` | `-p` | Server port | `3000` |
| `--auto-sync` | `-s` | Enable automatic sync with remote servers | disabled |
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINDOODB_SERVER_PASSWORD` | If server-identity.json exists | Password to decrypt server identity and per-tenant keybags |
| `MINDOODB_ADMIN_API_KEY` | Recommended | If set, protects admin endpoints with API key. **Warning logged on startup if not set.** |
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

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health status |

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
MINDOODB_SERVER_PASSWORD=secret npm run dev -- -d ./data -p 3000
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
await result.tenant.publishToServer("http://localhost:3000", {
  registerUsers: [factory.toPublicUserId(result.appUser)],
});
```

### 4. Client syncs data

```typescript
// Create a remote store for the "main" database
const remoteStore = await result.tenant.connectToServer(
  "http://localhost:3000",
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
curl -X POST http://localhost:3000/admin/tenant-api-keys \
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
await tenant.publishToServer("http://localhost:3000", {
  adminApiKey: "mdb_tk_a1b2c3d4...",
  registerUsers: [factory.toPublicUserId(appUser)],
});
```

### 3. Prefix enforcement

- `tenantId: "acme-prod"` — allowed (matches prefix `acme-`)
- `tenantId: "other-org"` — rejected with 403

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
      "url": "https://server2.example.com",
      "syncIntervalMs": 60000,
      "databases": ["directory", "main"]
    }
  ]
}
```

## Security

The server includes the following hardening measures:

- **Input validation** -- all identifiers (tenantId, dbId, serverName) are validated to prevent path traversal. Only lowercase alphanumeric characters and hyphens are allowed, max 64 characters.
- **Rate limiting** -- tiered per-IP rate limits: auth endpoints (20/min), admin endpoints (30/min), sync endpoints (200/min), global fallback (500/min). Returns `429 Too Many Requests` when exceeded.
- **Security headers** -- `helmet` middleware sets X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, Strict-Transport-Security, and others.
- **CORS** -- disabled by default. Set `MINDOODB_CORS_ORIGIN` to allow a specific origin.
- **Constant-time key comparison** -- API keys are compared using `crypto.timingSafeEqual()` to prevent timing attacks.
- **Error sanitization** -- internal errors never leak file paths or stack traces to clients. Only known auth/validation errors return specific messages.
- **Request size limits** -- JSON body limited to 5MB. Array sizes capped (100k IDs, 10k entries for putEntries).
- **Connection timeouts** -- idle connections are closed after 30 seconds.

For production deployments, also consider:

- Enabling TLS (see below) or running behind a reverse proxy (nginx, Caddy) with TLS termination
- Setting `MINDOODB_ADMIN_API_KEY` (the server warns on startup if not set)
- Using a process manager (PM2, systemd) for automatic restarts

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
npm start -- -d ./data -p 3000
```

## Testing

The integration tests are located in the main MindooDB package at `src/__tests__/ExampleServer.test.ts`. Run them with:

```bash
# From the root mindoodb directory
npm test -- ExampleServer
```
