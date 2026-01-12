# MindooDB

**Sleep well, even if your hosting service gets hacked.** 🔒

MindooDB is an **End-to-End Encrypted, Offline-first Sync Database** for secure, distributed document storage and synchronization. Everything on the server side is encrypted—even if attackers gain access to your infrastructure, they can't read your data without the encryption keys that never leave your clients.

## Why MindooDB?

### 🛡️ End-to-End Encrypted Security
- **No central authority required** - Tenants are created entirely on the client side
- **Cryptographically verified** - All operations are signed and encrypted
- **Server-side encryption** - Your hosting provider can't read your data, even if compromised
- **Fine-grained access control** - Named encryption keys for sensitive documents

### 🔄 Offline-First & Distributed
- **Works offline** - Create and modify documents without network connectivity
- **Peer-to-peer sync** - Synchronize between clients, servers, or any combination
- **Append-only stores** - Complete audit trail with cryptographic integrity
- **Automerge CRDTs** - Real-time collaborative editing with automatic conflict resolution

### 🔐 Cryptographic Guarantees
- **Digital signatures** - Every change is signed, proving authorship and preventing tampering
- **End-to-end encryption** - Documents encrypted with tenant keys or named symmetric keys
- **Key management** - Secure key distribution and storage with password protection
- **Tamperproof history** - Changes are cryptographically chained (like a blockchain)

## Core Concepts

### Tenants
A **tenant** represents an organization or group that shares access to documents:
- Created entirely on the client side (no server registration needed)
- Has a **tenant encryption key** (default encryption for all documents)
- Has an **administration key** (for user registration and administrative operations by authorized persons)
- Contains one or more **MindooDB** instances (databases)

### Users
Users are identified by cryptographic key pairs:
- **Signing Key** (Ed25519): Signs document changes to prove authorship
- **Encryption Key** (RSA-OAEP): Encrypts the KeyBag stored on disk
- Registered by administrators in the tenant's directory database
- Access can be revoked (prevents future changes, but preserves audit trail)

### Documents
Each **MindooDB** contains multiple **documents**:
- Implemented as Automerge CRDTs for collaborative editing
- Every change is **signed** (proves authenticity) and **encrypted** (protects content)
- Changes stored in append-only stores with complete history
- Support for time travel (reconstruct document state at any point in time)

### Encryption Model
- **Default encryption**: All documents encrypted with tenant key (all tenant members can decrypt)
- **Named key encryption**: Documents encrypted with named symmetric keys (only users with the key can decrypt)
- Keys distributed offline (e.g., via email with password protection)
- KeyBag stores named keys encrypted on disk using user's encryption key password

## Quick Start

### Installation

```bash
npm install mindoodb2
```

### Basic Usage

```typescript
import { 
  BaseMindooTenantFactory, 
  InMemoryAppendOnlyStoreFactory,
  KeyBag 
} from "mindoodb2";

// Create a store factory (can be in-memory, file-based, or server-backed)
const storeFactory = new InMemoryAppendOnlyStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory);

// Create a user
const userPassword = "mypassword123";
const user = await factory.createUserId("CN=alice/O=mycompany", userPassword);
const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, userPassword);

// Create an admin signing key
const adminPassword = "adminpass123";
const adminKeyPair = await factory.createSigningKeyPair(adminPassword);

// Create a tenant
const tenantId = "my-tenant";
const tenantEncryptionKeyPassword = "tenantkeypass123";
const tenant = await factory.createTenant(
  tenantId,
  adminKeyPair.publicKey,
  tenantEncryptionKeyPassword,
  user,
  userPassword,
  keyBag
);

// Open a database and create a document
const contactsDB = await tenant.openDB("contacts");
const contactDoc = await contactsDB.createDocument();

// Modify the document
await contactsDB.changeDoc(contactDoc, async (doc) => {
  const data = doc.getData();
  data.name = "John Doe";
  data.email = "john.doe@example.com";
  data.phone = "+1234567890";
});

// Retrieve the document
const allContacts = await contactsDB.getAllDocumentIds();
const doc = await contactsDB.getDocument(allContacts[0]);
console.log(doc.getData()); // { name: "John Doe", email: "john.doe@example.com", ... }
```

### Synchronization Example

```typescript
// User 1 creates a document
const tenant1 = await factory1.createTenant(/* ... */);
const db1 = await tenant1.openDB("contacts");
const doc1 = await db1.createDocument();
await db1.changeDoc(doc1, async (doc) => {
  doc.getData().name = "John Doe";
});

// User 2 opens the same tenant and pulls changes
const tenant2 = await factory2.openTenantWithKeys(/* ... */);
const db2 = await tenant2.openDB("contacts");

// Pull changes from user 1's store
const store1 = db1.getStore();
await db2.pullChangesFrom(store1);

// User 2 can now see the document
const allDocs = await db2.getAllDocumentIds();
expect(allDocs.length).toBe(1);

// User 2 modifies the document
const doc2 = await db2.getDocument(allDocs[0]);
await db2.changeDoc(doc2, async (doc) => {
  doc.getData().name = "John Smith";
});

// Push changes back to user 1
await db2.pushChangesTo(store1);
await db1.syncStoreChanges();

// User 1 sees the updated document
const updatedDoc = await db1.getDocument(allDocs[0]);
console.log(updatedDoc.getData().name); // "John Smith"
```

## Security Features

### Revocation Protection
MindooDB protects against revoked users creating backdated changes by manipulating their system clock. The system uses:
- **Directory sequence numbers**: Cryptographically linked sequence numbers in directory operations
- **Local monotonic counters**: Per-device counters that prevent relative backdating
- **Cryptographic validation**: Both mechanisms are signed and verified

This ensures that revocation actually prevents future changes, even if a user tries to manipulate timestamps.

### Append-Only Audit Trail
- Changes are **never modified or deleted** (true append-only semantics)
- Complete history preserved for compliance and audit requirements
- Cryptographic chaining ensures tamperproofness
- Time travel: reconstruct document state at any historical point

### Key Management
- Single password unlocks all user keys (via key derivation with different salts)
- Named symmetric keys stored in encrypted KeyBag
- Keys distributed offline via secure channels
- Key rotation supported (multiple versions per key ID)

## Architecture Highlights

### End-to-End Encrypted Model
- No central authority for tenant creation or user management
- All operations cryptographically verified
- Trust established through cryptographic proofs, not server-side authentication

### Hybrid Deployment
- Works with local stores (in-memory, file-based)
- Works with remote stores (server-backed implementations)
- Works with mixed local / remote stores
- Seamless synchronization between local and remote stores
- Can be deployed as P2P, client-server, or hybrid

### Performance Optimizations
- **Snapshots**: Regular Automerge snapshots prevent replaying entire history
- **Efficient sync**: Only missing changes are transferred
- **Incremental processing**: Internal index tracks document changes for efficient queries

## Use Cases

- **Multi-Tenant SaaS**: Each customer is a tenant with encrypted documents
- **Collaborative Editing**: Real-time collaboration with cryptographic proof of authorship
- **Secure File Sharing**: Documents encrypted with named keys, distributed offline
- **Audit-Compliant Systems**: Complete append-only audit trail with cryptographic proofs
- **Offline-First Applications**: Create and modify documents without network connectivity

## Project Goals

MindooDB is designed to provide **strong security guarantees** while maintaining practical usability:

1. **End-to-End Encrypted Architecture**: No reliance on central authorities or trusted servers
2. **Offline-First Operation**: System works when offline, syncs when connectivity is available
3. **Cryptographic Integrity**: All operations provable through cryptography
4. **Hybrid Deployment**: Seamless operation across local and remote stores
5. **Revocation Protection**: Prevent revoked users from creating backdated changes
6. **Complete Audit Trail**: Append-only structure preserves full history

## Documentation

- [Full Specification](./docs/specification.md) - Complete architecture and design details
- [Revocation Timestamp Protection](./docs/revocation-timestamp-protection.md) - Security analysis and solutions

## License

ISC

## Author

Mindoo GmbH

---

**Remember**: With MindooDB, your data is encrypted end-to-end. Even if your hosting service gets compromised, attackers can't read your documents without the encryption keys that stay on your clients. Sleep well! 😴🔒

