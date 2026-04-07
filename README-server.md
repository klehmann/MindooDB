# MindooDB reference server

Node.js/Express sources: `src/node/server/`. Docker: `src/node/server/Dockerfile`.

A Node.js/Express server implementing the MindooDB sync API with:

- **Client-to-server sync** — clients push/pull encrypted entries
- **Server-to-server mirroring** — servers relay ciphertext without decryption
- **Capabilities-based system admin security** — challenge/response auth with JWT and fine-grained route authorization
- **Multi-tenant** — each tenant is isolated with its own config, keybag, and stores

## Prerequisites

- **Docker** — the recommended way to build and run the server
- Node.js 20 or later (only needed for local development without Docker)

## Quick Start

The fastest way to get a server running is the interactive setup script. It prompts for the data directory first, detects whether this is a fresh setup or an existing deployment, and then asks only for the values needed for the chosen path (for example server name and password for fresh setup, or just bind settings for safe update). It then builds the Docker image and initialises the server identity when needed (including optional system admin creation):

```bash
# 1. Clone and enter the repo
git clone https://github.com/klehmann/MindooDB.git && cd MindooDB

# 2. Run the interactive setup
bash serversetup.sh

# 3. Start the server
docker compose up -d

# 4. Verify
curl http://localhost:1661/health
```

The setup script:
- builds the `mindoodb-server` Docker image
- creates the data directory (`../mindoodb-data/server`) and password file (`../mindoodb-data/.server_unlock`, mode 600)
- initialises the server identity and optionally creates a system admin keypair interactively
- writes a `docker-compose.override.yml` with your current host uid/gid, bind mounts, and one or more published port bindings based on your chosen bind address

For an existing deployment, use one of these update paths instead of reinitialising blindly:

```bash
# Safe interactive update for an existing server
bash serversetup.sh --update

# Or rebuild the image and restart without touching setup files
docker compose up -d --build
```

`bash serversetup.sh --update` preserves the existing `server.identity.json`, `server.keybag`, `config.json`, tenant data, `trusted-servers.json`, and `.server_unlock`, while still rebuilding the Docker image and regenerating `docker-compose.override.yml`.

After setup, manage the server with:

```bash
docker compose up -d        # start
docker compose down          # stop
docker compose logs -f       # follow logs
docker compose up -d --build # rebuild image and restart
```

When rerunning `bash serversetup.sh` without `--update`, the script now detects an existing `server.identity.json` and offers three choices:

- safe update (preserve identity, keybag, config, tenant data, and password file)
- overwrite identity (destructive re-init)
- abort

Only choose overwrite if you intentionally want to replace the server identity and reinitialise the deployment.

For identity utilities on a Docker-deployed server, use the wrapper script from the repository root:

```bash
./mindoodb-cli.sh identity:info server.identity.json
./mindoodb-cli.sh identity:change-password server.identity.json
./mindoodb-cli.sh identity:export-public system-admin-cn-sysadmin-o-myorg.identity.json --output ./system-admin.public-identity.json
```

Files inside the mounted server data directory can be referenced by filename alone. Running `./mindoodb-cli.sh` without arguments prints a command overview, and each `identity:*` command prints its own help when called without the required parameters.

### What was created on disk?

After running `serversetup.sh` (with system admin creation), the data directory contains:

```
../mindoodb-data/server/
├── server.identity.json                            # Server keypair (Ed25519 + RSA, password-encrypted)
├── config.json                                     # Admin access rules — who can call which /system/* endpoints
├── trusted-servers.json                            # Public keys of remote servers trusted for sync (initially empty)
└── system-admin-cn-sysadmin-o-myorg.identity.json  # System admin keypair (password-encrypted)
```

The most important file for day-to-day operations is **`config.json`**. After a fresh setup with one system admin, it looks like this:

```json
{
  "capabilities": {
    "ALL:/system/*": [
      {
        "username": "cn=sysadmin/o=myorg",
        "publicsignkey": "-----BEGIN PUBLIC KEY-----\nMCow...base64...\n-----END PUBLIC KEY-----"
      }
    ]
  }
}
```

This single rule grants the admin `cn=sysadmin/o=myorg` full access to **all** `/system/*` endpoints -- tenant management, trusted server management, config updates, and everything else. The next section explains how to customize these rules.

### What's next?

Once the server is healthy, a nice real-world workflow is:

1. Create the tenant locally. This generates the tenant's own admin identity (`result.adminUser`).
2. Share the tenant admin's **public** identity with the server owner.
3. The server owner grants that admin access to `POST /system/tenants/...` via `MindooDBServerAdmin`, after which the tenant admin can publish the tenant directly.

### 1. Create the tenant locally and export a public identity

```typescript
import { writeFileSync } from "fs";
import { BaseMindooTenantFactory, InMemoryContentAddressedStoreFactory } from "mindoodb";

const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory());

const result = await factory.createTenant({
  tenantId: "acme",
  adminName: "cn=admin/o=acme",
  adminPassword: "admin-pass",
  userName: "cn=alice/o=acme",
  userPassword: "alice-pass",
});

const tenantAdminPublic = factory.toPublicUserId(result.adminUser);

writeFileSync(
  "./acme-admin.public-identity.json",
  JSON.stringify(tenantAdminPublic, null, 2),
  "utf-8",
);
```

The file `acme-admin.public-identity.json` contains only the tenant admin's public keys, so it can be shared with the server owner.

### 2. Server owner grants tenant-creation access

The server owner loads the tenant admin's public identity and grants access for one tenant, a prefix, or all tenants:

```typescript
import { readFileSync } from "fs";
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  MindooDBServerAdmin,
} from "mindoodb";
import { NodeCryptoAdapter } from "mindoodb/node";

const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory());
const tenantAdminPublic = JSON.parse(
  readFileSync("./acme-admin.public-identity.json", "utf-8"),
);
const systemAdminIdentity = JSON.parse(
  readFileSync(
    "../mindoodb-data/server/system-admin-cn-sysadmin-o-myorg.identity.json",
    "utf-8",
  ),
);

const serverAdmin = new MindooDBServerAdmin({
  serverUrl: "http://localhost:1661",
  systemAdminUser: systemAdminIdentity,
  systemAdminPassword: "sysadmin-pass",
  cryptoAdapter: new NodeCryptoAdapter(),
});

await serverAdmin.grantSystemAdminAccess(
  {
    username: tenantAdminPublic.username,
    publicsignkey: tenantAdminPublic.userSigningPublicKey,
  },
  [
    "POST:/system/tenants/acme",       // exactly one tenant
    // "POST:/system/tenants/customer-*", // or a naming prefix
    // "POST:/system/tenants/*",          // or all tenants
  ],
);
```

At that point the tenant admin is recognized by `/system/auth/challenge` and is allowed to create only the tenants covered by the granted rules.

### 3. Tenant admin publishes the tenant

Now the tenant admin can authenticate with their own private identity and publish the tenant:

```typescript
await result.tenant.publishToServer("http://localhost:1661", {
  systemAdminUser: result.adminUser,
  systemAdminPassword: "admin-pass",
  adminUsername: result.adminUser.username,
  registerUsers: [factory.toPublicUserId(result.appUser)],
});
```

Here, `systemAdminUser` is the delegated tenant admin identity, while `adminUsername: result.adminUser.username` tells the server which tenant admin identity should be stored in the new tenant's `config.json`.

```typescript
const remoteStore = await result.tenant.connectToServer(
  "http://localhost:1661",
  "main",
);

const db = await result.tenant.openDB("main");

await db.pushChangesTo(remoteStore);

await db.pullChangesFrom(remoteStore);
await db.syncStoreChanges();
```

## How `config.json` controls admin access

MindooDB uses a **capabilities-based model** for server administration. Instead of a single shared API key, each admin has their own Ed25519 keypair, and `config.json` declares exactly which endpoints each admin is allowed to call.

The server has two authentication tiers:

1. **System admin** — `config.json` capabilities + Ed25519 challenge/response + short-lived JWT for `/system/*`. Optional **`MINDOODB_ADMIN_ALLOWED_IPS`** restricts which client IPs may use the `/system/*` HTTP surface.
2. **User (per-tenant)** — Ed25519 challenge-response for sync endpoints (`/:tenantId/sync/*`). Users are authenticated against the tenant directory (admin-signed).

This section covers tier 1 -- system admin access. For the design rationale behind this model, see [Server Security](docs/server-security.md).

### Rule format

Each rule in `config.json` is a key-value pair where:

- The **key** is `METHOD:PATHPATTERN` — an HTTP method (or `ALL`) paired with a URL path pattern
- The **value** is an array of **principals** (admin identities), each identified by `username` + `publicsignkey`

```json
{
  "capabilities": {
    "METHOD:PATHPATTERN": [
      { "username": "<admin-username>", "publicsignkey": "<ed25519-public-key-pem>" }
    ]
  }
}
```

**METHOD** can be `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, or `ALL` (matches any HTTP method).

**PATHPATTERN** is a URL path that may end with `*` to match any remaining characters.

### Wildcard patterns

| Rule | What it grants |
|------|---------------|
| `ALL:/system/*` | Full access to all system endpoints |
| `POST:/system/tenants/*` | Can create any tenant (but not delete, update, or list) |
| `POST:/system/tenants/acme` | Can only create the specific tenant `acme` |
| `PUT:/system/tenants/company-*` | Can update any tenant whose ID starts with `company-` |
| `GET:/system/tenants` | Read-only: can list tenants but not modify anything |
| `DELETE:/system/tenants/*` | Can delete any tenant |

### Multiple admins with different roles

A realistic production config might look like this:

```json
{
  "capabilities": {
    "ALL:/system/*": [
      { "username": "cn=admin/o=myorg", "publicsignkey": "<key-admin>" }
    ],
    "POST:/system/tenants/*": [
      { "username": "cn=provisioner/o=myorg", "publicsignkey": "<key-provisioner>" }
    ],
    "GET:/system/tenants": [
      { "username": "cn=auditor/o=myorg", "publicsignkey": "<key-auditor>" }
    ]
  }
}
```

- **`cn=admin`** is the super-admin with full access
- **`cn=provisioner`** can create tenants but cannot delete them, manage trusted servers, or change the config
- **`cn=auditor`** can list tenants (read-only) but has no write access

To delegate tenant management for a specific prefix to a team, add a scoped rule:

```json
"PUT:/system/tenants/team-alpha-*": [
  { "username": "cn=lead/o=alpha", "publicsignkey": "<key-lead>" }
]
```

### How matching works at request time

On each `/system/*` request the server:

1. Extracts the HTTP method and path from the request
2. Validates the JWT and extracts `username` + `publicsignkey` from its payload
3. Finds all capability rules whose method and path pattern match
4. Unions all principal entries from matching rules
5. **Allows** the request if any entry has **both** a matching `username` AND `publicsignkey`

A principal is identified by the combination of username + public key. Two admins may share a username but have different keys -- they are treated as distinct identities.

### Updating config at runtime

You do not need to restart the server to change access rules. Use the system admin API:

- **`GET /system/config`** — read the current config
- **`PUT /system/config`** — replace the config (takes effect immediately)
- **`GET /system/config/backups`** — list previous config snapshots created by runtime updates
- **`GET /system/config/backups/:backupFile`** — read one previous validated config snapshot

Before overwriting, the server creates a timestamped backup (e.g., `config.2026-03-27T16-30-45.123Z.json`). Self-lockout protection rejects any change that would remove the calling admin's own `PUT /system/config` access.

In Node you can use `MindooDBServerAdmin` instead of raw HTTP:

```typescript
const admin = new MindooDBServerAdmin({
  serverUrl: "http://localhost:1661",
  systemAdminUser: adminIdentity,
  systemAdminPassword: "your-admin-password",
  cryptoAdapter: new NodeCryptoAdapter(),
});

await admin.grantSystemAdminAccess(
  {
    username: "cn=newauditor/o=myorg",
    publicsignkey: "<new-auditor-key>",
  },
  ["GET:/system/tenants"],
);

const access = await admin.findSystemAdminAccess({
  username: "cn=newauditor/o=myorg",
  publicsignkey: "<new-auditor-key>",
});

const backups = await admin.listConfigBackups();
const previousConfig = await admin.getConfigBackup(backups[0].file);
```

#### Demo server `config.json` examples

For isolated demo environments, MindooDB Server also supports a special wildcard principal:

```json
{ "username": "*", "publicsignkey": "*" }
```

This wildcard is intentionally narrow:

- It is only valid on `POST:/system/tenants/...` capability rules
- It allows any username + any signing key to authenticate for tenant creation
- It does **not** unlock `GET /system/tenants`, `PUT /system/config`, or any other `/system/*` route

Open demo server (allow creation of any tenant name):

```json
{
  "capabilities": {
    "POST:/system/tenants/*": [
      { "username": "*", "publicsignkey": "*" }
    ]
  }
}
```

Prefix-restricted demo server (allow only tenant names starting with `demo_`):

```json
{
  "capabilities": {
    "POST:/system/tenants/demo_*": [
      { "username": "*", "publicsignkey": "*" }
    ]
  }
}
```

These examples are useful for public demos or temporary onboarding servers, but they are intentionally less strict than normal production setups. For regular servers, prefer explicit principals with real public keys.

For key rotation, adding/removing admins, and the full authentication flow (challenge/response, JWT lifecycle), see [Server Security](docs/server-security.md).

## Walkthrough: Multi-Server Setup

MindooDB servers can mirror encrypted data between each other. This section covers the full workflow: initializing servers, establishing trust, and configuring per-tenant sync.

### 1. Initialize servers

Run `bash serversetup.sh` on each machine (or in separate data directories for local testing):

```bash
# Server 1
bash serversetup.sh
# Choose: name=server1, data dir=../mindoodb-data-s1, bind 127.0.0.1

# Server 2
bash serversetup.sh
# Choose: name=server2, data dir=../mindoodb-data-s2, bind 127.0.0.1
```

Both runs print the server's public keys. Start both servers:

```bash
docker compose up -d
```

### 2. Server discovery

Every initialized server exposes its public identity at a well-known URL:

```bash
curl https://server1.example.com/.well-known/mindoodb-server-info
```

```json
{
  "name": "CN=server1",
  "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

This eliminates the need to manually copy public keys between servers.

### 3. Establish trust

The `add-to-network` CLI automates mutual trust exchange. It fetches each server's public keys from `/.well-known/mindoodb-server-info` and calls `POST /system/trusted-servers` on each side using your system admin identity.

```bash
printf '%s' 'admin-pass' > ./.admin-password && chmod 600 ./.admin-password
npm run server:add-to-network -- \
  --new-server http://localhost:3001 \
  --servers http://localhost:1661 \
  --identity ../mindoodb-data-s1/system-admin-cn-sysadmin-o-myorg.identity.json \
  --password-file ./.admin-password
```

The CLI authenticates with the `--identity` file against every server it contacts (`--new-server` **and** each URL in `--servers`), so that identity's principal must be listed in each server's `config.json`. If a server pair is already trusted, the CLI skips it instead of failing.

**Secrets:** Prefer **`--password-file`** so secrets are not placed in the process environment. Use **`MINDOODB_SYSTEM_ADMIN_PASSWORD`** only when you must script without files. A leading space before the command or `HISTCONTROL=ignorespace` reduces shell-history leakage.

Alternatively, you can exchange trust manually via curl:

```bash
curl -X POST http://server1:1661/system/trusted-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{
    "name": "CN=server2",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }'
```

Trust changes take effect immediately -- no restart required.

### 4. Publish tenant to servers

Reuse the same system admin identity that is authorized in each server's `config.json`:

```typescript
await result.tenant.publishToServer("http://server1:1661", {
  systemAdminUser: systemAdminIdentity,
  systemAdminPassword: "sysadmin-pass",
  adminUsername: result.adminUser.username,
});

await result.tenant.publishToServer("http://server2:3001", {
  systemAdminUser: systemAdminIdentity,
  systemAdminPassword: "sysadmin-pass",
  adminUsername: result.adminUser.username,
});
```

### 5. Configure per-tenant sync

After trust is established, configure which tenants each server syncs. This gives full control over sync topology -- not every server needs to sync every tenant.

**Add a sync server for a tenant:**

```bash
curl -X POST http://server1:1661/system/tenants/acme/sync-servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT" \
  -d '{
    "name": "CN=server2",
    "url": "http://server2:3001",
    "syncIntervalMs": 60000,
    "databases": ["directory", "main"]
  }'
```

The `databases` field is required and controls which databases are synced with the remote server. The `name` field identifies the remote server (must match the trusted server name). If a server with the same name already exists for the tenant, it is updated.

**List sync servers for a tenant:**

```bash
curl http://server1:1661/system/tenants/acme/sync-servers \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT"
```

**Remove a sync server from a tenant:**

```bash
curl -X DELETE http://server1:1661/system/tenants/acme/sync-servers/CN%3Dserver2 \
  -H "Authorization: Bearer $SYSTEM_ADMIN_JWT"
```

Note: the server name in the URL must be percent-encoded (e.g., `CN%3Dserver2` for `CN=server2`).

### 6. Enable auto-sync

Add `--auto-sync` via the `command` key in each server's `docker-compose.override.yml`:

```yaml
services:
  mindoodb:
    command: ["--auto-sync"]
```

Then restart:

```bash
docker compose up -d
```

The servers will periodically sync all configured tenant databases, relaying encrypted entries without decrypting them. Sync config changes take effect on the next server restart or when auto-sync timers are restarted.

## Data Directory Layout

```
data/
├── server.identity.json          # Server keypair (Ed25519 + RSA, password-encrypted)
├── config.json                   # Admin access rules (capabilities) — see "How config.json controls admin access"
├── trusted-servers.json          # Public keys of remote servers trusted for sync
├── system-admin-*.identity.json  # System admin keypair (password-encrypted)
├── acme/                         # Tenant "acme"
│   ├── config.json               # Tenant config (admin keys, users, sync servers)
│   └── stores/                   # Content-addressed entry stores
└── other-tenant/
    ├── config.json
    └── stores/
```

## Configuration File Formats

### `config.json` (global — capabilities)

Controls which system admins can call which `/system/*` endpoints. See [How `config.json` controls admin access](#how-configjson-controls-admin-access) for a full explanation of the rule format and wildcard patterns.

```json
{
  "capabilities": {
    "ALL:/system/*": [
      {
        "username": "cn=sysadmin/o=myorg",
        "publicsignkey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
      }
    ],
    "POST:/system/tenants/*": [
      {
        "username": "cn=provisioner/o=myorg",
        "publicsignkey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
      }
    ]
  }
}
```

### `server.identity.json` (global)

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINDOODB_SERVER_PASSWORD` | If `server.identity.json` exists and `MINDOODB_SERVER_PASSWORD_FILE` is unset | Password to decrypt server identity and per-tenant keybags |
| `MINDOODB_SERVER_PASSWORD_FILE` | No | Path to a file whose contents are the server password (trimmed). If set, **used instead of** `MINDOODB_SERVER_PASSWORD`. Prefer for Docker: env only holds the path, not the secret. |
| `MINDOODB_SYSTEM_ADMIN_PASSWORD` | No | For `server:add-to-network`: password for `--identity` (if not using `--password-file` or interactive prompt). May be visible in `ps` on shared hosts. |
| `MINDOODB_CORS_ORIGIN` | No | Allowed CORS origin (e.g., `https://app.example.com`). If not set, CORS is disabled. |
| `MINDOODB_ADMIN_ALLOWED_IPS` | No | Optional comma-separated client IPs/CIDRs allowed to call **`/system/*`** (all system admin routes, including `/system/auth/*`). If unset or `*`, any source IP may reach `/system/*` (JWT + `config.json` capabilities still apply). Example: `127.0.0.1,::1,172.23.248.0/24,2001:db8::/32`. Behind a reverse proxy, configure Express `trust proxy` so `req.ip` is the real client. |

> **Note:** The old `MINDOODB_ADMIN_API_KEY` variable has been removed. System admin **authorization** is enforced by `config.json` capabilities and JWTs. **`MINDOODB_ADMIN_ALLOWED_IPS`** is an optional **network** layer for `/system/*` only. See [Server Security](docs/server-security.md).

## CLI Reference

### `npm run server:dev` / `npm run server:start` — Start the server

Launches the MindooDB server process. `server:dev` runs via `ts-node` for development; `server:start` runs the compiled JavaScript. The server loads its identity from `server.identity.json` and the capabilities-based authorization config from `config.json` in the data directory.

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

One-time setup that generates the server's Ed25519/RSA keypair (`server.identity.json`) and an empty `trusted-servers.json`. It also interactively offers to create a first system admin keypair and writes the initial `config.json` with that admin's public key in the `capabilities` section.

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--name` | `-n` | Server name (e.g., "server1") | **required** |
| `--data-dir` | `-d` | Data directory path | `./data` |
| `--force` | `-f` | Overwrite existing identity | — |
| `--help` | `-h` | Show help message | — |

### `npm run server:add-to-network` — Add a server to the network

Automates mutual trust exchange when adding a new server to an existing network. For each existing server it fetches public keys from `/.well-known/mindoodb-server-info` and calls `POST /system/trusted-servers` in both directions so that the new server and every existing server trust each other.

| Option | Description | Default |
|--------|-------------|---------|
| `--new-server` | URL of the server being added | **required** |
| `--servers` | Comma-separated URLs of existing servers | **required** |
| `--identity` | Path to system admin `*.identity.json` (`PrivateUserId`) | **required** |
| `--password-file` | File containing the system admin password (optional if env or TTY) | — |
| `--help` | Show help message | — |

Password resolution order: read `MINDOODB_SYSTEM_ADMIN_PASSWORD`, then `--password-file`, then a hidden prompt on an interactive TTY. The CLI authenticates with the `--identity` file against every server it contacts (`--new-server` **and** each URL in `--servers`), so that identity's principal (username + public signing key) must be listed in the `capabilities` section of each server's `config.json`.

### `npm run identity:info` — Show public information from an identity file

| Option | Description | Default |
|--------|-------------|---------|
| `--identity` | Path to an `*.identity.json` file | **required** |
| `--help` | Show help message | — |

Prints the username, a stable SHA-256 username hash (`Public user ID (hex)`), both public keys, the fixed salt string names (`signing`, `encryption`), and whether encrypted private keys are present.

### `npm run identity:change-password` — Re-encrypt an identity with a new password

| Option | Description | Default |
|--------|-------------|---------|
| `--identity` | Path to an `*.identity.json` file | **required** |
| `--help` | Show help message | — |

Prompts for the current password, the new password, and confirmation using hidden input. The file is updated atomically in place.

### `npm run identity:export-public` — Export only the public portion of an identity

| Option | Description | Default |
|--------|-------------|---------|
| `--identity` | Path to an `*.identity.json` file | **required** |
| `--output` | Write JSON to a file instead of stdout | stdout |
| `--help` | Show help message | — |

This emits the corresponding `PublicUserId` JSON object:

```json
{
  "username": "cn=sysadmin/o=myorg",
  "userSigningPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "userEncryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

## API Reference

### System Admin Endpoints (`/system/*`)

All system admin endpoints require a JWT obtained via challenge/response authentication.
See [Server Security](docs/server-security.md) for full details.

The **`curl`** examples in this document use **`$SYSTEM_ADMIN_JWT`** as a placeholder for that token. In Node you can use **`MindooDBServerAdmin`** (with your `CryptoAdapter`) instead of raw `curl`.

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

### Server Info & Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health status |
| `GET` | `/.well-known/mindoodb-server-info` | Server name and public keys (unauthenticated) |

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
- **Optional `/system/*` IP allowlist** — set `MINDOODB_ADMIN_ALLOWED_IPS` to a comma-separated list of IPs or IPv4/IPv6 CIDRs (e.g., `127.0.0.1,::1,10.0.0.0/8,2001:db8::/32`) to restrict which client addresses may call **any** `/system/*` route (including auth). If unset or `*`, there is no IP restriction at this layer. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. Behind a reverse proxy, configure Express `trust proxy` so `req.ip` is accurate.

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

**Recommended:** use `bash serversetup.sh` for first-time setup, and `bash serversetup.sh --update` for safe interactive updates to an existing deployment. The rest of this section covers manual Docker commands for advanced use cases.

### docker-compose.yml

The repository includes a `docker-compose.yml` that uses the default data paths (`../mindoodb-data`). `serversetup.sh` writes a `docker-compose.override.yml` that docker compose merges automatically. It pins the container to your current host uid/gid so the non-root container can read the password file and write to the mounted data directory. On SELinux hosts it also adds the required mount suffixes.

The generated override also contains the published port bindings. This supports all three common setups:
- bind all interfaces (`0.0.0.0`)
- bind a single specific IP (for example a VPN address)
- bind both `127.0.0.1` and one specific extra IP

If you only changed application code and do not need to adjust ports or bind addresses, `docker compose up -d --build` is usually enough.

### Manual Docker commands (without serversetup.sh)

If you prefer not to use the setup script, here are the individual steps:

```bash
# Build the image
docker build -f src/node/server/Dockerfile -t mindoodb-server .

# Create data directory and password file
mkdir -p ../mindoodb-data/server
printf '%s' 'your-secret' > ../mindoodb-data/.server_unlock
chmod 600 ../mindoodb-data/.server_unlock

# Initialize server identity (interactive — prompts for system admin creation)
# Run as your current host uid/gid so the container can read/write the bind mounts.
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$(pwd)/../mindoodb-data/server:/data" \
  -v "$(pwd)/../mindoodb-data/.server_unlock:/run/secrets/server_unlock:ro" \
  -e MINDOODB_SERVER_PASSWORD_FILE=/run/secrets/server_unlock \
  --entrypoint node \
  mindoodb-server dist/node/server/serverinit.js --data-dir /data --name server1

# Start the server
docker compose up -d

# Verify
curl http://localhost:1661/health
```

On SELinux hosts, append `:Z` to the `/data` bind mount and `,Z` to the read-only password-file mount.

### Bind to a specific IP

To restrict the server to a specific network interface (e.g. a VPN), rerun `bash serversetup.sh --update` and provide the bind address when prompted. Update mode preserves the existing server identity, keybag, config, tenant data, and password file while regenerating `docker-compose.override.yml`.

If you also want local checks from the same host, answer `y` when asked whether to also bind `127.0.0.1`. The generated `docker-compose.override.yml` will then contain both mappings.

Avoid the overwrite path unless you intentionally want to replace `server.identity.json`. Replacing the server identity breaks the relationship to server-owned encrypted state such as `server.keybag`, so it should be treated as a destructive reinitialization step, not a normal upgrade.

### Additional flags

Environment variables and CLI flags can be added to `docker-compose.override.yml`:

```yaml
services:
  mindoodb:
    environment:
      MINDOODB_ADMIN_ALLOWED_IPS: "127.0.0.1,10.0.0.0/8"
    command: ["--port", "8443", "--auto-sync"]
    ports:
      - "0.0.0.0:8443:8443"
```

### Password handling

Prefer **`MINDOODB_SERVER_PASSWORD_FILE`** over **`MINDOODB_SERVER_PASSWORD`** so the plaintext secret is not stored in the process environment block (visible via `docker inspect`, `/proc/<pid>/environ`). The setup script and `docker-compose.yml` use file-based passwords by default. See [Server Security](docs/server-security.md) for details on Docker secrets.

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
