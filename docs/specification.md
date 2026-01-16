# MindooDB Architecture Specification

## Overview

MindooDB is an **End-to-End Encrypted, Offline-first Sync Database** designed for secure, distributed document storage and synchronization. The platform enables clients to create tenants locally and synchronize document changes across multiple clients and servers through content-addressed stores containing cryptographically signed and encrypted document histories.

## Core Principles

### End-to-End Encrypted, Offline-first Architecture

MindooDB operates on an end-to-end encrypted, offline-first model where:
- **No central authority** is required for tenant creation or user management
- **All operations are cryptographically verified** through digital signatures
- **Access control is enforced** through encryption keys distributed offline
- **Trust is established** through cryptographic proofs rather than server-side authentication

### Client-Side Tenant Creation

Tenants are created entirely on the client side:
- Each tenant has its own **tenant encryption key** (used as the default document encryption key)
- Each tenant has an **administration key** (used for signing user registrations and administrative operations)
- Tenants can be synchronized across clients and servers without requiring a central registry
- The tenant creator becomes the initial administrator

### Content-Addressed Store Replication

Document changes and attachment chunks are stored in **content-addressed stores** that enable efficient synchronization:
- Entries are **never modified or deleted** (append-only semantics)
- Synchronization works by comparing content hashes between peers
- Clients can sync with other clients (P2P) or servers (client-server)
- The append-only structure ensures **cryptographic integrity** and **audit trails**
- Store implementations can use the `entryType` field to optimize storage strategies

## Architecture Components

### 1. Tenants

A **tenant** represents an organization or group that shares access to documents:
- Contains one or more **MindooDB** instances
- Has a mandatory **directory database** that stores all registered users and their public keys
- Manages **tenant encryption keys** (default encryption for all documents)
- Manages **administration keys** (for user registration and administrative operations)

**Key Management:**
- **Tenant Encryption Key**: Symmetric key (AES-256) used as the default encryption key for all documents (encryption only, not signing)
- **Administration Key**: Asymmetric key pair (Ed25519) used **only for signing** user registrations and administrative operations (signing only, not encryption)

### 2. Users

Users are identified by cryptographic key pairs and registered in the tenant directory:

**User Key Pairs:**
- **Signing Key Pair** (Ed25519): Used **only for signing** document changes, proving authorship and integrity (signing only, not encryption)
- **Encryption Key Pair** (RSA-OAEP): Used **only for encryption/decryption** of the KeyBag stored on disk (encryption only, not signing)

**User Registration:**
- Users are registered by administrators using the administration key (for signing the registration)
- Registration creates an **administration signature** (signed with administration key) proving the user has been granted access
- User public keys are stored in the tenant's directory database

**Key Derivation:**
- Both user private keys are encrypted with a single password
- Key derivation function (KDF) uses different salts for each key:
  - Signing key: salt = "signing"
  - Encryption key: salt = "encryption"
  - Named symmetric keys: salt = "symmetric" (for keys created via `createSymmetricEncryptedPrivateKey()`)

### 3. Documents and Automerge

Each **MindooDB** contains multiple **documents**, where each document is an Automerge document:

**Automerge Integration:**
- Documents are implemented as Automerge CRDTs (Conflict-free Replicated Data Types)
- Each document change is a binary Automerge change
- Changes include dependency hashes for ordering and conflict resolution
- Documents support real-time collaborative editing with automatic conflict resolution

**Document Changes:**
- Every change is **signed** by the user's signing key (proving authorship and preventing tampering)
- Changes are **encrypted** with either:
  - **Default encryption**: Tenant encryption key (all tenant members can decrypt)
  - **Named key encryption**: A named symmetric key shared offline (only users with that key can decrypt)
- Changes are stored in the content-addressed store with metadata (document ID, change hash, dependencies, timestamp)
- **Note**: Signing and encryption are separate operations using different keys (signing key for signatures, encryption keys for payload encryption)

### 4. Content-Addressed Store

The **ContentAddressedStore** is the unified storage and synchronization mechanism for both Automerge document changes and attachment chunks.

**Structure:**
- Stores signed and encrypted binary entries identified by content hash
- Supports multiple entry types: document changes, snapshots, deletions, and attachment chunks
- Entries are never modified or deleted (append-only semantics)
- Entries are cryptographically chained to ensure tamperproofness (like a blockchain)
- Concrete implementations can be built on trusted systems like ImmuDB for additional tamperproof guarantees

**Entry Types:**
- `doc_create` - Document creation (first Automerge change)
- `doc_change` - Document modification (subsequent Automerge changes)
- `doc_snapshot` - Automerge snapshot for performance optimization
- `doc_delete` - Document deletion (tombstone entry)
- `attachment_chunk` - File attachment chunk

**Store Entry Structure:**
```typescript
interface StoreEntryMetadata {
  entryType: StoreEntryType;      // Type of entry (doc_*, attachment_*)
  hash: string;                   // Content hash (SHA-256 of encrypted data)
  docId: string;                  // Associated document ID
  dependencyHashes: string[];     // Predecessor entry hashes (for ordering)
  createdAt: number;              // Timestamp (milliseconds since Unix epoch)
  createdByPublicKey: string;     // Author's public signing key (Ed25519, PEM)
  decryptionKeyId: string;        // Key ID for decryption ("default" or named)
  signature: Uint8Array;          // Ed25519 signature over encrypted data
  originalSize?: number;          // Original size before encryption (for attachments)
}

interface StoreEntry extends StoreEntryMetadata {
  encryptedData: Uint8Array;      // Encrypted payload (IV/tag embedded)
}
```

**Core Methods:**
- `putEntries(entries)` - Store one or more entries (automatic deduplication)
- `getEntries(hashes)` - Retrieve entries by their content hashes
- `hasEntries(hashes)` - Check which hashes exist in the store
- `findNewEntries(knownHashes)` - Find entries not in the provided list
- `findNewEntriesForDoc(knownHashes, docId)` - Find new entries for a specific document
- `getAllHashes()` - Get all entry hashes in the store
- `resolveDependencies(startHash, options)` - Traverse dependency chain
- `purgeDocHistory(docId)` - Remove all entries for a document (GDPR compliance)

**Dependency Resolution:**
The `resolveDependencies()` method enables traversing the DAG structure:
- For documents: Load changes from a hash back to a snapshot
- For attachments: Traverse from last chunk to first chunk
- Supports options: `stopAtEntryType`, `maxDepth`, `includeStart`

**Synchronization:**
- Peers exchange lists of entry hashes they have
- Missing entries are requested and transferred
- Entries can be verified by checking signatures
- Supports client-client, client-server, and server-server synchronization

**Two-Store Architecture:**
MindooDB supports separate stores for documents and attachments:
```typescript
class MindooDB {
  constructor(
    tenant: MindooTenant,
    docStore: ContentAddressedStore,
    attachmentStore?: ContentAddressedStore
  )
}
```
This enables:
- **Flexible deployment**: Different storage backends for docs vs attachments
- **Cost optimization**: Keep docs local, store attachments in cloud
- **Simple deployments**: Use single store for both when appropriate

**Performance Optimization:**
- **Snapshots**: Regular Automerge snapshots are generated for documents
- When loading a document, only changes since the last snapshot need to be applied
- This prevents having to replay the entire document history for each access
- Snapshots are stored as `doc_snapshot` entries in the store
- The `resolveDependencies()` method can stop at snapshots using `stopAtEntryType`

### 5. Encryption Model

MindooDB uses a **hybrid encryption model**:

**Default Encryption (Tenant Key):**
- All documents are encrypted by default with the tenant encryption key
- All users registered in the tenant automatically have access
- Key ID: "default"
- Suitable for general tenant-wide document security

**Named Key Encryption (Fine-Grained Access):**
- Documents can be encrypted with named symmetric keys
- Keys are distributed offline (e.g., via email with password protection, or in-person)
- Only users who have received the key can decrypt the document
- Supports key rotation: multiple key versions can exist for the same ID
- Key IDs are stored in document changes (`decryptionKeyId` field)

**Key Distribution:**
- Named keys are created using `createSymmetricEncryptedPrivateKey()` (returns an `EncryptedPrivateKey`)
- Keys can be protected with a password (distributed via secure channel)
- Keys are stored in a **KeyBag** which is encrypted on disk using the user's encryption key password (via PBKDF2)
- Key rotation is supported by storing multiple versions per key ID (newest tried first)

**Key Storage:**
- Named symmetric keys are stored in a **KeyBag** instance
- The KeyBag internally uses `Map<keyId, KeyEntry[]>` where each `KeyEntry` contains the decrypted key bytes and optional `createdAt` timestamp
- The KeyBag is stored on disk encrypted with the user's encryption key password (using PBKDF2 with salt derived from the user encryption key)
- Users unlock their KeyBag with their password to access named keys
- The KeyBag provides methods: `get(keyId)`, `set(keyId, key, createdAt)`, `listKeys()`, `save()`, `load()`

### 6. Security Model

**Trust Model and Chain of Trust:**

MindooDB establishes trust through a hierarchical cryptographic model:

1. **Root of Trust**: The administration public key and the directory database are the sources of truth for MindooDB. This is where the trust chain starts.

2. **Trust Chain**:
   - The **administrator** is trusted by virtue of possessing the administration private key
   - The **administrator trusts users** by signing their registration in the directory database
   - **Other users trust the administrator** and, by extension, all users the administrator has trusted
   - Document changes from trusted users are accepted; changes from untrusted signers are rejected

3. **Directory Database as Admin-Only**:
   - The "directory" database (dbId="directory") is a special admin-only database
   - **Only entries signed by the administration key are accepted and processed**
   - Entries signed by any other key (even registered users) are silently ignored
   - This prevents malicious users from tampering with the user registry
   - This design eliminates recursion issues during signature verification (since admin key is always trusted without lookup)

4. **Signature Verification Flow**:
   - When loading entries from any database, each entry's signature is verified
   - The signature's public key is validated against the directory to ensure the signer is trusted
   - For the directory database itself, only the admin key is accepted (no directory lookup needed)
   - For other databases, the signer must be a registered, non-revoked user in the directory

```
┌─────────────────────────────────────────────────────────────────┐
│                        Trust Hierarchy                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────┐                                       │
│   │  Administration Key │  ← Root of Trust                      │
│   │  (Ed25519 Keypair)  │                                       │
│   └──────────┬──────────┘                                       │
│              │                                                  │
│              │ signs                                            │
│              ▼                                                  │
│   ┌─────────────────────┐                                       │
│   │  Directory Database │  ← Admin-only, source of truth        │
│   │  (dbId="directory") │    for user registrations             │
│   └──────────┬──────────┘                                       │
│              │                                                  │
│              │ contains                                         │
│              ▼                                                  │
│   ┌─────────────────────┐                                       │
│   │  User Registrations │  ← Signed by admin key                │
│   │  (grant/revoke)     │                                       │
│   └──────────┬──────────┘                                       │
│              │                                                  │
│              │ trusts                                           │
│              ▼                                                  │
│   ┌─────────────────────┐                                       │
│   │   Registered Users  │  ← Can sign documents in other DBs    │
│   │   (signing keys)    │                                       │
│   └─────────────────────┘                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Signing:**
- All document changes are signed with the user's signing key (Ed25519)
- Signatures prove:
  - **Authenticity**: The change was created by the user
  - **Integrity**: The change has not been tampered with
- Signatures are verified when changes are received from other peers
- **Key Usage**: Signing keys are used **only for signing**, never for encryption
- **Signature Validation**: When loading entries, the signer's public key is validated against the directory to ensure they are a trusted (registered and non-revoked) user

**Encryption:**
- Document payloads are encrypted before storage
- Encryption keys are identified by `decryptionKeyId` in the change metadata
- Users must have the corresponding key to decrypt changes
- Encryption prevents unauthorized access to document contents
- **Key Usage**: Encryption keys are used **only for encryption/decryption**, never for signing

**Tamperproofness:**
- Entries in the content-addressed store are cryptographically chained (like a blockchain)
- Each change references previous changes through dependency hashes
- Any modification to a change would break the cryptographic chain
- Concrete implementations can leverage trusted systems like **ImmuDB** for additional tamperproof guarantees at the storage layer
- This ensures the integrity of the entire document history

**Access Control:**
- **Registration**: Only administrators can register new users (proven by administration signature)
- **Directory Protection**: The directory database only accepts admin-signed entries
- **Document Access**: Controlled by key distribution (users must have the encryption key)
- **Signer Validation**: Document changes in non-directory databases are only accepted if signed by a trusted user
- **Revocation**: Due to append-only nature, revocation prevents future access but not past access
  - Users who lose access cannot decrypt new changes
  - Previously decrypted changes remain accessible (append-only limitation)
  - Revoked users' future changes are rejected (their signing key is no longer trusted)

## Data Flow

### Creating a Tenant

1. Client calls `TenantFactory.createTenant()` with:
   - Tenant ID
   - Administration key password
   - Tenant encryption key password
   - Current user (PrivateUserId)
   - Current user password
   - KeyBag instance
2. System generates:
   - Administration key pair (Ed25519)
   - Tenant encryption key (AES-256, encrypted with password)
3. Tenant is ready for use (tenant encryption key is used for "default" key ID)

### Creating a User

1. Client calls `TenantFactory.createUserId()` with username and password
2. System generates:
   - Signing key pair (Ed25519)
   - Encryption key pair (RSA-OAEP, 3072 bits)
3. Both private keys are encrypted with the password (via key derivation with different salts)
4. Administrator opens the directory using `Tenant.openDirectory()` and registers the user using `MindooTenantDirectory.registerUser()` with:
   - Public user ID (from `TenantFactory.toPublicUserId()`)
   - Administration private key (encrypted)
   - Administration key password
5. This adds the user to the special MindooDB named "directory", signed with the administration key to verify the user is trusted
6. For users with revoked tenant access, administrators can call `MindooTenantDirectory.revokeUser()` to add a revocation record so that their changes are no longer trusted and ignored

### Creating a Database

1. Client calls `Tenant.openDB(id, options?)` with a database ID (string)
2. System checks if the database is already cached in the tenant's database cache
3. If not cached:
   - Creates content-addressed stores for documents and optionally attachments using the store factory
   - Creates a new `MindooDB` instance with the stores
   - Initializes the database (sets up internal indexes)
   - Caches the database instance for future use
4. Special case: If `id === "directory"`, the database is automatically opened with `adminOnlyDb: true` to enforce admin-only write access
5. Returns the `MindooDB` instance (cached or newly created)
6. The database is now ready to store documents and can be used by any registered user in the tenant

### Creating a Document

1. Client calls `MindooDB.createDocument()` or `createEncryptedDocument(keyId)`
2. `keyId` refers to a symmetric encryption key that the client has created locally and imported into his KeyBag.
3. the special key ID `default` is the default value, encrypting the document with the tenant encryption key shared between all tenant users.
3. The key ID is stored in document metadata
4. First change is created and stored in content-addressed store
5. Change is signed with user's signing key
6. Change is encrypted with the specified key (or "default" tenant key)
7. The key can be exported from the KeyBag, signed with a custom password and key / password can be shared with coworkers (see chapter "Key Distribution").

### Modifying a Document

1. Client calls `MindooDB.changeDoc()` with document and change function
2. System:
   - Applies the change function to the Automerge document
   - Generates binary Automerge change
   - Signs the change with user's signing key
   - Determines encryption key ID from document metadata (from first change)
   - Encrypts the change payload with the appropriate key
   - Stores entry in content-addressed store

### Synchronizing Changes

**Low-Level Synchronization (ContentAddressedStore):**
1. Client A calls `store.findNewEntries()` with list of known entry hashes
2. Client B (or server) returns list of missing entry metadata
3. Client A calls `store.getEntries()` to fetch the actual entries

**High-Level Synchronization (MindooDB):**
1. Client calls `MindooDB.syncStoreChanges()` to sync changes from the local content-addressed store
   - This finds new entries using `findNewEntries()`
   - Processes each entry: verifies signature, decrypts payload, applies to Automerge document
   - Updates internal index
2. For remote synchronization:
   - `MindooDB.pullChangesFrom(remoteStore)` - pulls entries from a remote store
   - `MindooDB.pushChangesTo(remoteStore)` - pushes local entries to a remote store

**Entry Processing:**
- For each entry:
  - Verify signature (prove authenticity and integrity)
  - Decrypt payload if encrypted (using appropriate key from KeyBag via `Tenant.decryptPayload()`)
  - Apply change to Automerge document (for doc_* entry types)
- Updated document state is available
- **Internal Index Update**: The local MindooDB instance updates its internal index when documents actually change (after applying entries)
- The index tracks which documents have changed and when, enabling incremental operations on the database
- `processChangesSince()` uses this index to efficiently find documents that changed since a given cursor
- This enables external systems to efficiently query for document changes and update their own indexes incrementally

### Tenant and Database Settings

Tenant-wide and database-specific settings are stored in the directory database as special documents with `form="tenantsettings"` and `form="dbsettings"` respectively. These settings are managed exclusively by administrators and are automatically synchronized to all clients.

**Retrieving Settings:**
1. Client calls `MindooTenantDirectory.getTenantSettings()` or `getDBSettings(dbId)`
2. System synchronizes the directory database to ensure latest changes are available
3. System updates internal settings cache by iterating through directory changes since last update
4. For tenant settings: returns the latest document with `form="tenantsettings"` (or `null` if none exists)
5. For DB settings: returns the latest document with `form="dbsettings"` and matching `dbid` field (or `null` if none exists)
6. Settings are cached in memory for efficient access

**Updating Settings:**
1. Administrator calls `MindooTenantDirectory.changeTenantSettings(changeFunc, adminKey, adminPassword)` or `changeDBSettings(dbId, changeFunc, adminKey, adminPassword)`
2. System retrieves the existing settings document from cache (or creates a new one if it doesn't exist)
3. System applies the administrator's change function to the document
4. System ensures the `form` field is set correctly (`"tenantsettings"` or `"dbsettings"`)
5. For DB settings, system also ensures the `dbid` field matches the provided `dbId`
6. System creates a new change entry signed with the administration key
7. Change is stored in the directory database (admin-only, so only admin-signed entries are accepted)
8. Settings cache is invalidated to force refresh on next access
9. Settings are automatically synchronized to all clients through the normal directory sync process

**Settings Document Structure:**
- Tenant settings documents have `form="tenantsettings"` and can contain any tenant-wide configuration (e.g., `maxAttachmentSize`, `adminKeyRotationAnnouncement`)
- Database settings documents have `form="dbsettings"` and `dbid=<databaseId>` and can contain database-specific configuration
- Settings documents use Automerge for automatic conflict resolution when multiple administrators make concurrent changes

### Key Distribution

1. Administrator creates named key: `TenantFactory.createSymmetricEncryptedPrivateKey(password)` which returns an `EncryptedPrivateKey`
2. Encrypted key is distributed to authorized users (email, shared folder, etc.)
3. Password is communicated via secure channel (phone, in-person)
4. Users add the key to their KeyBag using `KeyBag.decryptAndImportKey(keyId, encryptedKey, encryptedKeyPassword)`
5. The KeyBag decrypts the key and stores it (the KeyBag itself is encrypted on disk using the user's encryption key password)
6. The KeyBag can be saved/loaded using `KeyBag.save()` and `KeyBag.load()` methods (encrypts the KeyBag content and returns it as byte sequence)
7. **Note**: Access discovery (scanning content-addressed stores when a new key is added) is a potential future enhancement but not currently implemented
8. Users can now decrypt and access documents encrypted with that key ID using `Tenant.encryptPayload()` and `Tenant.decryptPayload()`

## Performance Considerations

### Snapshot Generation

To maintain acceptable database performance:
- **Regular snapshots** are generated for Automerge documents
- When loading a document, the system:
  1. Loads the most recent snapshot
  2. Applies only changes since the snapshot
  3. This avoids replaying the entire document history

**Snapshot Strategy:**
- Snapshots are generated periodically (e.g., every N changes or time interval)
- Snapshots are stored as `doc_snapshot` entries in the content-addressed store
- The system tracks which changes have been snapshotted
- `getAllChangeHashesForDoc()` supports `fromLastSnapshot` parameter

### Content-Addressed Store Efficiency

- Entries are identified by content hash, enabling automatic deduplication
- Bulk operations (`getEntries()`, `putEntries()`) reduce network round-trips
- Entry hashes are small, enabling efficient synchronization
- Only missing entries are transferred during sync
- Store implementations can optimize storage based on entry type

### Historical Analysis

An important benefit of the append-only structure is the ability to **go back in time** and perform historical analysis:
- All document changes are preserved in the content-addressed store
- Documents can be reconstructed to any point in time by applying changes up to a specific timestamp
- This enables:
  - **Audit trails**: Complete history of who changed what and when
  - **Time travel**: View document state at any historical point
  - **Change analysis**: Analyze how documents evolved over time
  - **Compliance**: Meet regulatory requirements for data retention and auditability

## Limitations and Trade-offs

### Content-Addressed Store Revocation Limitation

Due to the append-only nature of the content-addressed store:
- **Revoking user access** prevents them from decrypting future changes
- **Previously decrypted changes** remain accessible to revoked users
- This is a fundamental trade-off: audit trail and integrity vs. retroactive access control

**Mitigation:**
- Use named keys for sensitive documents (smaller blast radius)
- Rotate keys when users leave (they can't decrypt new changes)
- Accept that historical access cannot be retroactively revoked

**Note**: There is a critical security concern regarding **revocation timestamp protection** - preventing revoked users from creating backdated changes by manipulating their system clock. See [Revocation Timestamp Protection Concept Document](./revocation-timestamp-protection.md) for a detailed analysis of the problem and proposed solutions.

### Key Management Complexity

- Users must manage multiple keys (signing, encryption, named symmetric keys)
- Key distribution requires offline secure channels
- Key rotation requires coordination among all authorized users

**Mitigation:**
- Single password unlocks all keys (via key derivation)
- Named keys stored in KeyBag encrypted on disk (unlocked with user encryption key password via PBKDF2)
- Clear key ID system for identifying which key to use
- KeyBag provides unified interface for key management (`get()`, `set()`, `listKeys()`, `save()`, `load()`)

## Use Cases

### Multi-Tenant SaaS Application
- Each customer is a tenant
- Documents encrypted with tenant key by default
- Sensitive documents use named keys for fine-grained access

### Collaborative Document Editing
- Real-time collaboration through Automerge CRDTs
- Changes signed to prove authorship
- Offline-first: changes sync when connection is available

### Secure File Sharing
- Documents encrypted with named keys
- Keys distributed via secure channels
- No central server required for access control

### Audit-Compliant Systems
- Content-addressed store provides complete audit trail
- All changes are signed and timestamped
- Cryptographic proofs of all operations

## Document Attachments

MindooDB supports file attachments associated with documents. See [attachments.md](./attachments.md) for detailed design documentation.

### Key Features (Implemented)

- **Attachment API on MindooDoc**: Methods for adding, removing, and retrieving attachments
- **Chunked Storage**: Large files are split into 256KB chunks for efficient storage and streaming
- **Deterministic Encryption**: Attachment chunks use deterministic IV derivation for tenant-wide deduplication
- **Streaming Upload**: `addAttachmentStream()` accepts `AsyncIterable<Uint8Array>` for memory-efficient large file uploads
- **Streaming Download**: `streamAttachment()` returns an `AsyncGenerator` for memory-efficient reading
- **Random Access**: `getAttachmentRange()` fetches only the chunks needed for a byte range
- **Append-Only Growth**: `appendToAttachment()` supports log files and growing data
- **Two-Store Architecture**: Separate stores for documents and attachments enable flexible deployment

### Attachment API

Write methods (only within `changeDoc()` callback):
- `addAttachment(fileData, fileName, mimeType)` - Add from in-memory data
- `addAttachmentStream(dataStream, fileName, mimeType)` - Add from streaming source
- `removeAttachment(attachmentId)` - Remove attachment reference
- `appendToAttachment(attachmentId, data)` - Append to existing attachment

Read methods (work anywhere):
- `getAttachments()` - List all attachment references
- `getAttachment(attachmentId)` - Get full content
- `getAttachmentRange(attachmentId, start, end)` - Get byte range
- `streamAttachment(attachmentId, offset?)` - Stream chunks

## Future Enhancements

- **Forward Secrecy**: Key rotation that prevents decryption of future changes
- **Key Escrow**: Secure key recovery mechanisms
- **Advanced Access Control**: Role-based access with key hierarchies
- **Performance Optimizations**: More sophisticated snapshot strategies
- **Network Protocols**: Optimized sync protocols for large-scale deployments
- **Attachment Synchronization**: 
  - Lazy loading of attachments from remote peers
  - Two-phase sync (documents first, then referenced attachment chunks)
  - Background sync for offline access
- **Attachment Caching**:
  - LRU/size-based local cache policies
  - Transparent remote fetching for uncached chunks

