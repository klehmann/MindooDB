# MindooDB - Your Data. Your Control.

**Sleep well, even if your hosting service gets hacked.** 🔒

MindooDB is an **end-to-end encrypted, offline-first sync database**.
It lets apps collaborate and sync data without giving servers access to the contents.

Even if someone has full access to your infrastructure — database dumps, backups, logs — all they get is ciphertext.

Your data is encrypted on the client before it ever touches a server. No plaintext. No server-side keys. No trust required.

> ⚠️ **Beta software**: This project is in early development and not yet recommended for production use. APIs may change without notice.

Use AI to explore this repository:

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/klehmann/MindooDB)

## The Problem

Traditional databases trust the server. If your hosting provider is compromised, your data is exposed. Even "encrypted at rest" solutions decrypt data server-side for queries. **MindooDB takes a different approach**: encryption keys never leave your clients.

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│                         Your Clients                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │   Alice's   │  │    Bob's    │  │  Charlie's  │               │
│  │   Device    │  │   Device    │  │   Device    │               │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │               │
│  │ │  Keys   │ │  │ │  Keys   │ │  │ │  Keys   │ │ ← Keys stay   │
│  │ │(private)│ │  │ │(private)│ │  │ │(private)│ │   on devices  │
│  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │               │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │ encrypted      │ encrypted      │ encrypted
          ▼                ▼                ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Server (or P2P Peers)                        │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐    │
│   │           Encrypted Blobs (unreadable)                  │    │
│   │     🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒 🔒             │    │
│   └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│   Server can sync & store data, but CANNOT read it               │
└──────────────────────────────────────────────────────────────────┘
```

**Sync happens through content-addressed stores**: clients exchange only the encrypted entries they're missing. Works peer-to-peer, client-server, or any combination - for documents and attached files.

## Key Features

| Feature | What It Means |
|---------|---------------|
| 🛡️ **End-to-End Encrypted** | Data encrypted on client before sync. Servers can't decrypt. |
| 📴 **Offline-First** | Create and edit documents without network. Sync when online. |
| ✍️ **Signed Changes** | Every change is digitally signed. Proves authorship, prevents tampering. |
| 🔗 **Tamperproof History** | Append-only, cryptographically chained. Like a blockchain for your docs. |
| 🤝 **Real-time Collaboration** | Built on [Automerge](https://automerge.org/) CRDTs. Conflicts resolve automatically. |
| 🔑 **Fine-grained Access** | Named encryption keys for sensitive documents. Share with specific users. |

## Quick Start

### Installation

```bash
npm install mindoodb
```

> 📱 **React Native / Expo?** See the [React Native setup guide](./docs/reactnative.md) for mobile-specific instructions with native performance.

### Pick Your Runtime

| Runtime | Fastest start | Recommended path |
|---------|---------------|------------------|
| Node.js | Use `mindoodb` directly in a Node script | [Getting Started](./docs/getting-started.md#nodejs) |
| Web | Import from `mindoodb/browser` | [Getting Started](./docs/getting-started.md#web-browser) |
| React Native / Expo | Run `npx mindoodb setup-react-native` in your app root | [React Native Guide](./docs/reactnative.md) |

### React Native Recommendation

- Use **native Automerge** (`react-native-automerge-generated`) and native crypto for production.
- Treat Expo Go / JS fallback as a convenience path for prototyping, not the default production runtime.

### Create a Tenant and Start Working

```typescript
import { 
  BaseMindooTenantFactory, 
  InMemoryContentAddressedStoreFactory,
} from "mindoodb";

// 1. Set up storage (in-memory for demo; use file/server-backed for production)
const storeFactory = new InMemoryContentAddressedStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory);

// 2. Create tenant (generates all keys, opens tenant, registers user — single call)
const { tenant, adminUser, appUser, keyBag } = await factory.createTenant({
  tenantId: "acme-corp",
  adminName: "cn=admin/o=acme",
  adminPassword: "admin-password",
  userName: "cn=alice/o=acme",
  userPassword: "user-password",
});

// 3. Open a database and create documents
const db = await tenant.openDB("contacts");
const doc = await db.createDocument();

await db.changeDoc(doc, async (d) => {
  const data = d.getData();
  data.name = "John Doe";
  data.email = "john@example.com";
});

// 4. Read it back
const contacts = await db.getAllDocumentIds();
const loaded = await db.getDocument(contacts[0]);
console.log(loaded.getData()); // { name: "John Doe", email: "john@example.com" }
```

### Sync Between Users

```typescript
// Alice creates a document
const aliceDB = await aliceTenant.openDB("projects");
const project = await aliceDB.createDocument();
await aliceDB.changeDoc(project, (d) => { d.getData().title = "Secret Project"; });

// Bob pulls Alice's changes
const bobDB = await bobTenant.openDB("projects");
await bobDB.pullChangesFrom(aliceDB.getStore());

// Bob edits the document
const projectDoc = await bobDB.getDocument(project.id);
await bobDB.changeDoc(projectDoc, (d) => { d.getData().status = "In Progress"; });

// Alice pulls Bob's changes
await aliceDB.pullChangesFrom(bobDB.getStore());
// Alice now sees: { title: "Secret Project", status: "In Progress" }
```

## Core Concepts

### Tenants
An organization or team that shares access. Created client-side—no server registration needed.
- Has a **default encryption key** (a regular KeyBag key shared with all members)
- Has an **admin key** (for registering/revoking users)
- Contains multiple databases

### Users
Identified by cryptographic key pairs, registered by an admin:
- **Signing key** (Ed25519): Proves authorship of changes
- **Encryption key** (RSA-OAEP): Protects local key storage
- Keys generated locally; only public keys shared with admin

### Databases
Each tenant can have multiple databases, created on-demand:
```typescript
const contacts = await tenant.openDB("contacts");
const invoices = await tenant.openDB("invoices");
```
A special **directory** database stores user registrations (admin-only).

### Documents
[Automerge](https://automerge.org/) CRDTs with full history:
- Every change is signed and encrypted
- Automatic conflict resolution for concurrent edits
- Time travel: reconstruct any historical state of documents (e.g. run queries on historic data) — see [Time Travel Documentation](./docs/timetravel.md)

### Attachments
Files attached to documents:
- Chunked (256KB) and encrypted
- Streaming upload/download for large files
- Deduplication across the tenant

See: [Attachments Documentation](./docs/attachments.md)

### Document Indexing
MindooDB provides a flexible, **incremental indexing** facility:
- **Cursor-based processing**: Only index documents that changed since the last run—no full rescans
- **Pluggable indexers**: Add any indexer you need (fulltext search, aggregations, custom queries)
- **Built-in [Virtual Views](./docs/virtualview.md)**: Spreadsheet-like views that categorize, sort, and aggregate documents
- **Cross-boundary queries**: Virtual Views can span multiple databases, mix local and remote data, or even query across tenants

```typescript
// Incremental indexing: process only what's new
let cursor = null;
while (true) {
  for await (const { doc, cursor: newCursor } of db.iterateChangesSince(cursor)) {
    if (doc.isDeleted()) {
      mySearchIndex.remove(doc.getId());
    } else {
      mySearchIndex.update(doc);  // Flexsearch, Lunr, or custom
    }
    cursor = newCursor;
  }
  await sleep(1000);
}
```

### Encryption Model

All encryption keys are stored in the **KeyBag**—a local, password-protected key store.

| Key Type | Purpose | Who Has It |
|----------|---------|------------|
| **`default` key** | Used when no other key is specified | All tenant members |
| **Named keys** | Fine-grained access for sensitive docs | Only users you share it with |

Keys are distributed offline (e.g. password protected via email or a shared drive). The `default` key is typically shared during onboarding; named keys are shared as needed for specific documents.

## Security

### Cryptographic Guarantees
- **Signatures**: Ed25519 on every change - proves who wrote it
- **Encryption**: AES-256-GCM - servers see only ciphertext
- **Integrity**: Changes are hash-chained - tampering breaks the chain

### User Revocation
Revoked users:
- ❌ Cannot sync with peers or servers
- ❌ Cannot make new changes (signatures rejected)
- ⚠️ Can currently read previously-synced local data (planned: data wipe on first connect after revocation)

MindooDB includes **revocation timestamp protection** to prevent backdated changes from revoked users. See: [Revocation Protection](./docs/revocation-timestamp-protection.md)

### Audit Trail
Append-only storage means nothing is ever deleted:
- Complete history of who changed what and when
- Cryptographic proof of all operations
- GDPR compliance via `purgeDocHistory()` when legally required

## Supported Platforms

- ✅ **Node.js** - Server-side and desktop apps
- ✅ **Web Browsers** - Progressive web apps with Web Crypto API
- ✅ **React Native / Expo** - iOS and Android with native Automerge (Rust via JSI)
- ✅ **Electron** - Cross-platform desktop apps

## Use Cases

- **Multi-Tenant SaaS**: Each customer isolated with encrypted data
- **Collaborative Editing**: Real-time co-editing with signed changes
- **Secure File Sharing**: Named keys for need-to-know access
- **Audit-Critical Systems**: Tamperproof history meets compliance requirements
- **Offline-First Apps**: Full functionality without network; sync when connected
- **Mobile Apps**: End-to-end encrypted sync with native performance

See: [Use Cases Documentation](./docs/usecases/README.md)

## Documentation

- [Getting Started](./docs/getting-started.md) — Fast setup for Node.js, Web, and React Native
- [Example Snippets](./docs/examples/README.md) — Copy-paste Todo starters for all runtimes
- [Architecture Specification](./docs/specification.md) — Full technical details
- [React Native Guide](./docs/reactnative.md) — Native Automerge setup and troubleshooting
- [Virtual Views](./docs/virtualview.md) — Aggregations and cross-database views
- [Data Indexing](./docs/dataindexing.md) — Incremental indexing and search integration
- [Time Travel](./docs/timetravel.md) — Historical document retrieval and history traversal
- [P2P Sync](./docs/p2psync.md) — Peer-to-peer synchronization
- [Attachments](./docs/attachments.md) — File storage and streaming

## Testing

Run tests from the command line:

```bash
# Node.js unit/integration tests (Jest)
npm test

# Install Chromium once for browser tests
npm run test:browser:install

# Real browser runtime tests (Playwright + headless Chromium)
npm run test:browser

# Run Node + browser lanes
npm run test:all
```

### Test coverage by environment

| Environment | Command | What is covered today |
|-------------|---------|------------------------|
| Node.js | `npm test` | Full Jest suite for core APIs (documents, sync logic, indexing, virtual views, settings, trust model, attachments, etc.) |
| Browser | `npm run test:browser` | Real Chromium runtime via Playwright, including browser entrypoint usage, document lifecycle, real HTTP sync endpoint flows, and browser Virtual View update behavior |
| React Native / Expo | `npm test -- ReactNativeCrypto.test.ts` | Crypto adapter behavior in Jest (uses `src/__mocks__/expo-standard-web-crypto.ts`), not a device/simulator E2E run |

### Browser sync test behavior

- Browser tests run in headless Chromium and execute MindooDB browser code in a real page runtime.
- During test setup, an ephemeral HTTP server is started automatically and exposes the real sync endpoints.
- Sync assertions use real HTTP requests against that temporary endpoint (no mocked transport for sync tests).
- The server binds to an OS-assigned free port and is shut down after the suite completes.

### Current parity status

- The package exports and core API shape are aligned across Node.js, browser, and React Native entrypoints.
- Node and browser now have executable CLI lanes with runtime validation.
- React Native coverage is currently adapter-focused in Jest and does not yet validate full app-level behavior inside a real React Native runtime.
- For high confidence in three-environment parity, add a React Native integration lane (Expo/Detox or RN test app) that exercises document lifecycle, sync, and virtual view updates on device/simulator.
- For Expo Go / JS fallback scenarios, PBKDF2 iterations can be tuned at runtime; native RN builds should keep strong defaults.

## Support

Need commercial support, have questions, or want to request a feature? We're here to help! :-)

- 🐛 **Bug Reports**: [Open an issue on GitHub](https://github.com/klehmann/mindoodb/issues)
- 💬 **Questions & Discussions**: [GitHub Discussions](https://github.com/klehmann/mindoodb/discussions)
- ✨ **Feature Requests**: [Create a feature request](https://github.com/klehmann/mindoodb/issues/new?template=feature_request.md)

## License

Apache 2.0

## Author

Mindoo GmbH

---

**Your data. Your keys. Your control.** With MindooDB, even a complete server breach doesn't expose your documents. Sleep well! 😴🔒
