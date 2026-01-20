# MindooDB Architecture Specification

## Overview

MindooDB is an **End-to-End Encrypted, Offline-first Sync Database** for secure, distributed document storage. Clients create tenants locally and synchronize through content-addressed stores containing cryptographically signed and encrypted document histories.

**Design Principles:**
- No central authority required—tenants created entirely client-side
- All operations cryptographically verified through digital signatures
- Access control enforced through encryption keys distributed offline
- Trust established through cryptographic proofs, not server authentication

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              TENANT                                     │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Directory Database (admin-only)                                  │   │
│  │  • User registrations (signed by admin)                          │   │
│  │  • Group memberships                                             │   │
│  │  • Tenant/DB settings                                            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │   Database A    │  │   Database B    │  │   Database C    │   ...    │
│  │  (documents +   │  │  (documents +   │  │  (documents +   │          │
│  │   attachments)  │  │   attachments)  │  │   attachments)  │          │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘          │
│                                                                         │
│  Keys: default encryption key, admin signing key, admin encryption key  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Tenants

A **tenant** represents an organization or group sharing document access.

**Properties:**
- Contains one or more MindooDB instances (databases)
- Has a mandatory **directory database** for user registry and settings
- Created entirely client-side (no server registration)
- Tenant creator becomes the initial administrator

**Keys:**

| Key | Type | Purpose |
|-----|------|---------|
| **Default Encryption Key** (`default`) | AES-256 (symmetric) | Default encryption when no other key specified |
| **Administration Signing Key** | Ed25519 (asymmetric) | Signs user registrations & admin operations |
| **Administration Encryption Key** | RSA-OAEP (asymmetric) | Encrypts sensitive admin data (usernames in directory) |

---

## 2. Users

Users are identified by cryptographic key pairs and registered in the tenant directory.

**Key Pairs:**

| Key | Type | Purpose |
|-----|------|---------|
| **Signing Key** | Ed25519 | Signs document changes (proves authorship) |
| **Encryption Key** | RSA-OAEP (3072-bit) | Encrypts local KeyBag storage |

**Key Derivation:**
Both private keys are encrypted with a single password using KDF with different salts:
- Signing key: salt = `"signing"`
- Encryption key: salt = `"encryption"`
- Named symmetric keys: salt = `"symmetric"`

**Registration Flow:**
1. User generates keys locally
2. User sends public keys to administrator
3. Administrator registers user in directory (signed with admin key)
4. Registration syncs to all clients/servers
5. User can now make changes that will be trusted

**Revocation:**
Administrators call `revokeUser()` to add a revocation record. Revoked users:
- Cannot sync with peers/servers
- Future changes are rejected (untrusted signature)
- Previously-accessed data remains readable (E2E encryption trade-off)

**Groups:**
- Defined by administrators in the directory database
- Support nesting (groups containing groups)
- Case-insensitive names (normalized to lowercase)
- Merged automatically when offline clients sync conflicting group docs

---

## 3. Documents

Each document is an [Automerge](https://automerge.org/) CRDT stored in a content-addressed store.

**Properties:**
- Real-time collaborative editing with automatic conflict resolution
- Every change is **signed** (proves authorship) and **encrypted** (protects content)
- Complete history preserved (append-only)
- Time travel: reconstruct any historical state

**Change Storage:**

```typescript
interface StoreEntry {
  entryType: StoreEntryType;      // doc_create | doc_change | doc_snapshot | doc_delete | attachment_chunk
  hash: string;                   // SHA-256 of encrypted data
  docId: string;                  // Document ID
  dependencyHashes: string[];     // Predecessor entries (DAG ordering)
  createdAt: number;              // Unix timestamp (ms)
  createdByPublicKey: string;     // Author's Ed25519 public key (PEM)
  decryptionKeyId: string;        // "default" or named key ID
  signature: Uint8Array;          // Ed25519 signature over encrypted data
  encryptedData: Uint8Array;      // Encrypted payload (IV/tag embedded)
}
```

**Performance Optimization:**
- **Snapshots** generated periodically to avoid replaying full history
- Loading a document: load latest snapshot → apply changes since snapshot
- Snapshots stored as `doc_snapshot` entries

---

## 4. Content-Addressed Store

The unified storage and sync mechanism for document changes and attachment chunks.

**Characteristics:**
- Entries identified by content hash (SHA-256)
- **Append-only**: entries never modified or deleted
- **Cryptographically chained**: like a blockchain for integrity
- Automatic deduplication

**Entry Types:**
| Type | Description |
|------|-------------|
| `doc_create` | Document creation (first Automerge change) |
| `doc_change` | Document modification |
| `doc_snapshot` | Performance snapshot |
| `doc_delete` | Deletion tombstone |
| `attachment_chunk` | File attachment chunk |

**Core API:**

```typescript
interface ContentAddressedStore {
  // Write
  putEntries(entries: StoreEntry[]): Promise<void>;
  
  // Read
  getEntries(hashes: string[]): Promise<StoreEntry[]>;
  hasEntries(hashes: string[]): Promise<Map<string, boolean>>;
  getAllHashes(): Promise<string[]>;
  
  // Sync
  findNewEntries(knownHashes: string[]): Promise<StoreEntryMetadata[]>;
  findNewEntriesForDoc(knownHashes: string[], docId: string): Promise<StoreEntryMetadata[]>;
  
  // DAG traversal
  resolveDependencies(startHash: string, options?: ResolveOptions): Promise<StoreEntry[]>;
  
  // GDPR
  purgeDocHistory(docId: string): Promise<void>;
}
```

**Two-Store Architecture:**
Separate stores for documents and attachments enable flexible deployment:

```typescript
const db = new MindooDB(tenant, docStore, attachmentStore);
```

Use cases:
- Keep docs local, attachments in cloud
- Different sync strategies per store type
- Single store for simple deployments

---

## 5. Encryption Model

### Default Encryption

Documents are encrypted with the `default` key when no other key is specified:
- All registered users can decrypt
- Key ID: `"default"`
- Suitable for general tenant-wide access

### Named Key Encryption (Fine-Grained Access)

Documents encrypted with named symmetric keys for restricted access:
- Only users with the key can decrypt
- Keys distributed offline (email, phone, in-person)
- Supports key rotation (multiple versions per ID, newest tried first)

### Key Distribution Flow

1. Admin creates named key: `createSymmetricEncryptedPrivateKey(password)`
2. Encrypted key sent to authorized users (email, shared folder)
3. Password communicated via secure channel (phone, in-person)
4. User imports: `keyBag.decryptAndImportKey(keyId, encryptedKey, password)`
5. User can now decrypt documents using that key

### KeyBag

Local storage for named keys:
- Encrypted on disk using user's encryption key password (PBKDF2)
- API: `get(keyId)`, `set(keyId, key, createdAt)`, `listKeys()`, `save()`, `load()`

### Server Access Control ($publicinfos Key)

Servers need to verify users without accessing business data. The `$publicinfos` key enables this:

**Problem:** Servers must check if a signing key belongs to a trusted user before accepting operations.

**Solution:** Directory access-control documents use `$publicinfos` encryption:
- User registration (`grantaccess`)
- User revocation (`revokeaccess`)  
- Group membership (`group`)

**Privacy-Preserving Identity:**
```typescript
// Directory stores usernames as:
username_hash: string;      // SHA-256(lowercase username) - for lookups
username_encrypted: string; // RSA-encrypted with admin key - only admin can read
```

This allows servers to validate signing keys **without knowing actual usernames**.

---

## 6. Security Model

### Trust Hierarchy

```
┌─────────────────────┐
│  Administration Key │  ← Root of Trust
│  (Ed25519 Keypair)  │
└──────────┬──────────┘
           │ signs
           ▼
┌─────────────────────┐
│  Directory Database │  ← Admin-only, source of truth
│  (user registry)    │
└──────────┬──────────┘
           │ contains
           ▼
┌─────────────────────┐
│  User Registrations │  ← Signed by admin key
│  (public keys)      │
└──────────┬──────────┘
           │ trusts
           ▼
┌─────────────────────┐
│   Registered Users  │  ← Can sign documents in other DBs
└─────────────────────┘
```

**Key Points:**
1. **Directory is admin-only**: Only admin-signed entries accepted
2. **No recursion**: Admin key trusted without directory lookup
3. **Signer validation**: Changes in other DBs validated against directory

### Cryptographic Guarantees

| Mechanism | Guarantee |
|-----------|-----------|
| **Signatures** (Ed25519) | Authenticity (who created it) + Integrity (not tampered) |
| **Encryption** (AES-256-GCM) | Confidentiality (only key holders can read) |
| **Hash chaining** | Tamperproofness (modifications break the chain) |

### Access Control Summary

| Operation | Enforced By |
|-----------|-------------|
| User registration | Admin signature required |
| Document creation | Must have encryption key |
| Document modification | Must have signing key (registered user) + encryption key |
| Document reading | Must have decryption key |

---

## 7. Data Flows

### Creating a Tenant

```typescript
// 1. Create required keys
const adminSigningKey = await factory.createSigningKeyPair(adminPassword);
const adminEncryptionKey = await factory.createEncryptionKeyPair(adminPassword);
const publicinfosKey = await factory.createSymmetricEncryptedPrivateKey(keyPassword);

// 2. Add $publicinfos to KeyBag
keyBag.decryptAndImportKey("$publicinfos", publicinfosKey, keyPassword);

// 3. Create tenant
const tenant = await factory.createTenant(
  tenantId,
  adminSigningKey.publicKey,      // Ed25519
  adminEncryptionKey.publicKey,   // RSA-OAEP  
  tenantKeyPassword,
  user,
  userPassword,
  keyBag
);
```

### Creating a User

```typescript
// 1. User generates keys locally
const user = await factory.createUserId("CN=bob/O=acme", password);

// 2. User sends public ID to admin
const publicUserId = factory.toPublicUserId(user);

// 3. Admin registers user in directory
const directory = await tenant.openDirectory(adminKey, adminPassword);
await directory.registerUser(publicUserId, adminKey, adminPassword);
```

### Document Lifecycle

```typescript
// Create
const doc = await db.createDocument();  // Uses "default" key
// or
const doc = await db.createEncryptedDocument("confidential-key");

// Modify
await db.changeDoc(doc, async (d) => {
  d.getData().title = "Project X";
});
// System: sign with user's key → encrypt with doc's key → store entry

// Read
const loaded = await db.getDocument(docId);
console.log(loaded.getData());
```

### Synchronization

**Low-level (store-to-store):**
```typescript
const missing = await remoteStore.findNewEntries(localHashes);
const entries = await remoteStore.getEntries(missing.map(m => m.hash));
await localStore.putEntries(entries);
```

**High-level (MindooDB):**
```typescript
// Pull changes from remote
await db.pullChangesFrom(remoteStore);

// Push changes to remote
await db.pushChangesTo(remoteStore);

// Sync local store changes into memory
await db.syncStoreChanges();
```

### Settings Management

Tenant and database settings stored in directory as special documents:

```typescript
// Read settings
const tenantSettings = await directory.getTenantSettings();
const dbSettings = await directory.getDBSettings("invoices");

// Update settings (admin only)
await directory.changeTenantSettings(
  (doc) => { doc.getData().maxAttachmentSize = 100_000_000; },
  adminKey,
  adminPassword
);
```

---

## 8. Attachments

Files attached to documents, stored in chunks.

**Features:**
- Chunked (256KB default) for efficient streaming
- Encrypted with same key as parent document
- Deterministic IV for tenant-wide deduplication
- Separate store enables flexible deployment

**API:**

```typescript
// Write (within changeDoc callback)
await doc.addAttachment(fileData, "report.pdf", "application/pdf");
await doc.addAttachmentStream(asyncIterable, "video.mp4", "video/mp4");
// For logs, adds chunks to existing attachment:
await doc.appendToAttachment(attachmentId, moreData);
// Delete attachment reference from document 
await doc.removeAttachment(attachmentId);

// Read (anywhere)
const attachments = doc.getAttachments();
const data = await doc.getAttachment(attachmentId);
const range = await doc.getAttachmentRange(attachmentId, 0, 1024);
for await (const chunk of doc.streamAttachment(attachmentId)) { ... }
```

See: [Attachments Documentation](./attachments.md)

---

## 9. Performance

### Snapshots

Automerge documents accumulate changes over time. Snapshots prevent performance degradation:

1. System generates periodic snapshots (`doc_snapshot` entries)
2. Loading: fetch latest snapshot → apply only subsequent changes
3. `resolveDependencies()` stops at snapshots via `stopAtEntryType`

### Incremental Sync

- `findNewEntries()` returns only entries the requester doesn't have
- Small hash comparison enables efficient sync over slow connections
- Bulk operations (`getEntries`, `putEntries`) reduce round-trips

### Incremental Queries

```typescript
// First query: get all documents
let cursor: ProcessChangesCursor | null = null;
for await (const { doc, cursor: currentCursor } of db.iterateChangesSince(cursor)) {
  // Process document
  cursor = currentCursor; // Save cursor for resuming
}

// Subsequent queries: only changed documents
for await (const { doc, cursor: currentCursor } of db.iterateChangesSince(cursor)) {
  // Process changed documents
  cursor = currentCursor;
}
```

---

## 10. Limitations & Trade-offs

### Revocation Limitations

Due to append-only architecture:
- ✅ Revoked users cannot decrypt **future** changes
- ⚠️ Revoked users retain access to **previously decrypted** data that is locally synced
- ✅ Revoked users' **future changes** are rejected and sync with clients and servers is blocked

**Mitigations:**
- Use named keys for sensitive documents (smaller blast radius)
- Rotate keys when users leave
- Accept that historical access cannot be retroactively revoked

See: [Revocation Timestamp Protection](./revocation-timestamp-protection.md)

### Key Management Complexity

Multiple keys per user (signing, encryption, named symmetric keys) require:
- Secure distribution of named keys
- Coordination for key rotation

**Mitigations:**
- Single password unlocks all keys (KDF with different salts)
- KeyBag provides unified key storage
- Clear key ID system

---

## 11. Use Cases

| Use Case | How MindooDB Helps |
|----------|-------------------|
| **Multi-Tenant SaaS** | Each customer is a tenant with encrypted data |
| **Collaborative Editing** | Automerge CRDTs + signed changes |
| **Secure File Sharing** | Named keys for need-to-know access |
| **Audit-Compliant Systems** | Append-only, signed, timestamped history |
| **Offline-First Apps** | Full functionality without network |

---

## 12. Future Enhancements

- **Forward Secrecy**: Key rotation preventing future decryption
- **Key Escrow**: Secure key recovery mechanisms
- **Advanced Access Control**: Role-based access with key hierarchies
- **Attachment Lazy Loading**: Fetch chunks on-demand from remote peers
- **LRU Caching**: Size-based local cache for attachments
