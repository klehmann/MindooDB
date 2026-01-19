# MindooDB Example Server

A minimal Node.js/Express server that implements the MindooDB sync API, enabling:
- **Client-to-server sync**: Clients can push/pull entries to/from the server
- **Server-to-server sync**: Servers can synchronize with each other
- **Tenant registration via HTTP**: Create tenants without manual file editing

## Prerequisites

- Node.js 20 or later
- The MindooDB library must be built first (run `npm run build` in the root directory)

## Installation

```bash
cd examples/server
npm install
```

## Quick Start

### 1. Build the MindooDB library

```bash
# From the root mindoodb directory
nvm use 20
npm install
npm run build
```

### 2. Start the server

```bash
# From examples/server directory
cd examples/server
npm run dev
```

Or with specific options:

```bash
npm run dev -- -d ./data -p 3000
```

### 3. Register a tenant via HTTP

```bash
curl -X POST http://localhost:3000/admin/register-tenant \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "my-tenant",
    "adminSigningPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "adminEncryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "users": [
      {
        "username": "alice",
        "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
        "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
      }
    ]
  }'
```

## CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--data-dir` | `-d` | Data directory path | `./data` |
| `--port` | `-p` | Server port | `3000` |
| `--auto-sync` | `-s` | Enable automatic sync with remote servers | disabled |
| `--help` | `-h` | Show help message | - |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MINDOODB_SERVER_KEY_PASSWORD` | If server-keys.json exists | Password to decrypt server private keys |
| `MINDOODB_ADMIN_API_KEY` | No | If set, protects admin endpoints with API key |

### Example: Protected Admin Endpoints

```bash
export MINDOODB_ADMIN_API_KEY="my-secret-key"
npm run dev

# Now admin endpoints require X-API-Key header
curl -X GET http://localhost:3000/admin/tenants \
  -H "X-API-Key: my-secret-key"
```

## API Reference

### Admin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/admin/register-tenant` | Register a new tenant |
| `GET` | `/admin/tenants` | List all registered tenants |
| `DELETE` | `/admin/tenants/:tenantId` | Remove a tenant |

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

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health status |

## Configuration Files

### Tenant Configuration (`<dataDir>/<tenantId>/config.json`)

```json
{
  "adminSigningPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "adminEncryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "defaultStoreType": "inmemory",
  "databaseStores": {
    "special-db": {
      "storeType": "file"
    }
  },
  "users": [
    {
      "username": "alice",
      "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
    }
  ],
  "remoteServers": [
    {
      "url": "https://other-server.example.com",
      "username": "this-server-username",
      "syncIntervalMs": 60000,
      "databases": ["directory", "main"]
    }
  ]
}
```

### Server Keys (`<dataDir>/<tenantId>/server-keys.json`)

Required for server-to-server sync. Contains the server's identity:

```json
{
  "username": "server-primary",
  "signingPrivateKey": {
    "ciphertext": "...",
    "iv": "...",
    "tag": "...",
    "salt": "...",
    "iterations": 100000
  },
  "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "encryptionPrivateKey": {
    "ciphertext": "...",
    "iv": "...",
    "tag": "...",
    "salt": "...",
    "iterations": 100000
  },
  "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

**Important**: The password to decrypt the private keys must be provided via the `MINDOODB_SERVER_KEY_PASSWORD` environment variable.

## Typical Workflow

### 1. Client Creates Tenant Locally

```typescript
// On the client (admin)
const factory = new BaseMindooTenantFactory(cryptoAdapter, storeFactory);

// Create admin keys
const adminSigningKey = await factory.createSigningKeyPair("admin-password");
const adminEncryptionKey = await factory.createEncryptionKeyPair("admin-password");

// Create user
const user = await factory.createUserId("alice", "alice-password");
const publicUser = factory.toPublicUserId(user);

// Create tenant locally
const keyBag = new KeyBag(cryptoAdapter);
const tenant = await factory.createTenant(
  "my-tenant",
  adminSigningKey.publicKey,
  adminEncryptionKey.publicKey,
  "tenant-key-password",
  user,
  "alice-password",
  keyBag
);
```

### 2. Register Tenant on Server

```typescript
// Register tenant on the server
await fetch("http://localhost:3000/admin/register-tenant", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tenantId: "my-tenant",
    adminSigningPublicKey: adminSigningKey.publicKey,
    adminEncryptionPublicKey: adminEncryptionKey.publicKey,
    users: [{
      username: publicUser.username,
      signingPublicKey: publicUser.signingPublicKey,
      encryptionPublicKey: publicUser.encryptionPublicKey,
    }],
  }),
});
```

### 3. Client Syncs with Server

```typescript
// Create HttpTransport
const transport = new HttpTransport({
  baseUrl: "http://localhost:3000",
  tenantId: "my-tenant",
  dbId: "directory",
});

// Create client store
const clientStore = new ClientNetworkContentAddressedStore(
  "directory",
  transport,
  cryptoAdapter,
  publicUser.username,
  signingKey,      // decrypted signing key
  encryptionKey,   // decrypted encryption key
);

// open database with local data
const db = await tenant.openDB("main");
// Sync: push local changes to server
await db.pushChangesTo(clientStore);

// Sync: pull server changes to local
await db.pullChangesFrom(clientStore);
```

## Server-to-Server Sync

### Setup

1. Generate server keys using MindooDB factory methods:

```typescript
const factory = new BaseMindooTenantFactory(cryptoAdapter, storeFactory);
const signingKey = await factory.createSigningKeyPair("server-password");
const encryptionKey = await factory.createEncryptionKeyPair("server-password");

// Save to server-keys.json
const serverKeys = {
  username: "server-primary",
  signingPrivateKey: signingKey.privateKey,
  signingPublicKey: signingKey.publicKey,
  encryptionPrivateKey: encryptionKey.privateKey,
  encryptionPublicKey: encryptionKey.publicKey,
};
```

2. Register this server as a user on the remote server's config.json:

```json
{
  "users": [
    {
      "username": "server-primary",
      "signingPublicKey": "...",
      "encryptionPublicKey": "..."
    }
  ]
}
```

3. Configure remote servers in this server's config.json:

```json
{
  "remoteServers": [
    {
      "url": "https://remote-server.example.com",
      "username": "server-primary",
      "syncIntervalMs": 60000
    }
  ]
}
```

4. Start the server with auto-sync:

```bash
# Option 1: Inline environment variable (single line)
MINDOODB_SERVER_KEY_PASSWORD=server-password npm run dev -- -s

# Option 2: Export first, then run
export MINDOODB_SERVER_KEY_PASSWORD=server-password
npm run dev -- -s
```

## Directory Structure

```
data/
└── my-tenant/
    ├── config.json         # Tenant configuration
    └── server-keys.json    # Server identity (optional)
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
npm start -- -d ./data -p 3000
```

## Testing

The integration tests are located in the main MindooDB package at `src/__tests__/ExampleServer.test.ts`. Run them with:

```bash
# From the root mindoodb directory
npm test -- ExampleServer
```
