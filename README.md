# MindooDB - Your Data. Your Control.

**Sleep well, even if your hosting service gets hacked.** 🔒

MindooDB is an **end-to-end encrypted, offline-first sync database**.
It lets apps collaborate and sync data without giving servers access to the contents.

Even if someone has full access to your infrastructure — database dumps, backups, logs — all they get is ciphertext.

Your data is encrypted on the client before it ever touches a server. No plaintext. No server-side keys. No trust required.

> ⚠️ **Alpha software**: This project is in early development and not yet recommended for production use. APIs may change without notice.


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

**Sync happens through content-addressed stores**: clients exchange only the encrypted entries they're missing. Works peer-to-peer, client-server, or any combination.

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

### Create a Tenant and Start Working

```typescript
import { 
  BaseMindooTenantFactory, 
  InMemoryAppendOnlyStoreFactory,
  KeyBag 
} from "mindoodb";

// 1. Set up storage (in-memory for demo; use file/server-backed for production)
const storeFactory = new InMemoryAppendOnlyStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory);

// 2. Create a user (generates signing + encryption key pairs)
const user = await factory.createUserId("CN=alice/O=acme", "user-password");
const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "user-password");

// 3. Create admin keys (for managing users)
const adminKeyPair = await factory.createSigningKeyPair("admin-password");

// 4. Create a tenant (an organization that shares documents)
const tenant = await factory.createTenant(
  "acme-corp",
  adminKeyPair.publicKey,
  "tenant-key-password",
  user,
  "user-password",
  keyBag
);

// 5. Open a database and create documents
const db = await tenant.openDB("contacts");
const doc = await db.createDocument();

await db.changeDoc(doc, async (d) => {
  d.getData().name = "John Doe";
  d.getData().email = "john@example.com";
});

// 6. Read it back
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
- Time travel: reconstruct any historical state of documents (e.g. run queries on historic data)

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
  const { documents, cursor: newCursor } = await db.processChangesSince(cursor);
  for (const doc of documents) {
    if (doc.isDeleted()) {
      mySearchIndex.remove(doc.id);
    } else {
      mySearchIndex.update(doc);  // Flexsearch, Lunr, or custom
    }
  }
  cursor = newCursor;
  await sleep(1000);
}
```

### Encryption Model

All encryption keys are stored in the **KeyBag**—a local, password-protected key store.

| Key Type | Purpose | Who Has It |
|----------|---------|------------|
| **`default` key** | Used when no other key is specified | All tenant members |
| **Named keys** | Fine-grained access for sensitive docs | Only users you share it with |

Keys are distributed offline (email, phone, in-person). The `default` key is typically shared during onboarding; named keys are shared as needed for specific documents.

## Security

### Cryptographic Guarantees
- **Signatures**: Ed25519 on every change—proves who wrote it
- **Encryption**: AES-256-GCM—servers see only ciphertext
- **Integrity**: Changes are hash-chained—tampering breaks the chain

### User Revocation
Revoked users:
- ❌ Cannot sync with peers or servers
- ❌ Cannot make new changes (signatures rejected)
- ⚠️ Can still read previously-synced data (fundamental trade-off of E2E encryption)

MindooDB includes **revocation timestamp protection** to prevent backdated changes from revoked users. See: [Revocation Protection](./docs/revocation-timestamp-protection.md)

### Audit Trail
Append-only storage means nothing is ever deleted:
- Complete history of who changed what and when
- Cryptographic proof of all operations
- GDPR compliance via `purgeDocHistory()` when legally required

## Use Cases

- **Multi-Tenant SaaS**: Each customer isolated with encrypted data
- **Collaborative Editing**: Real-time co-editing with signed changes
- **Secure File Sharing**: Named keys for need-to-know access
- **Audit-Critical Systems**: Tamperproof history meets compliance requirements
- **Offline-First Apps**: Full functionality without network; sync when connected

See: [Use Cases Documentation](./docs/usecases/README.md)

## Documentation

- [Architecture Specification](./docs/specification.md) — Full technical details
- [Virtual Views](./docs/virtualview.md) — Aggregations and cross-database views
- [Data Indexing](./docs/dataindexing.md) — Incremental indexing and search integration
- [P2P Sync](./docs/p2psync.md) — Peer-to-peer synchronization
- [Attachments](./docs/attachments.md) — File storage and streaming

## Support

Need help, have questions, or want to request a feature? We're here to help! :-)

- 🐛 **Bug Reports**: [Open an issue on GitHub](https://github.com/klehmann/mindoodb/issues)
- 💬 **Questions & Discussions**: [GitHub Discussions](https://github.com/klehmann/mindoodb/discussions)
- ✨ **Feature Requests**: [Create a feature request](https://github.com/klehmann/mindoodb/issues/new?template=feature_request.md)

## License

Apache 2.0

## Author

Mindoo GmbH

---

**Your data. Your keys. Your control.** With MindooDB, even a complete server breach doesn't expose your documents. Sleep well! 😴🔒
