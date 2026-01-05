# MindooDB Architecture Specification

## Overview

MindooDB is a **zero-trust replicating platform** designed for secure, distributed document storage and synchronization. The platform enables clients to create tenants locally and synchronize document changes across multiple clients and servers through append-only stores containing cryptographically signed and encrypted document histories.

## Core Principles

### Zero-Trust Architecture

MindooDB operates on a zero-trust model where:
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

### Append-Only Store Replication

Document changes are stored in **append-only stores** that enable efficient synchronization:
- Changes are **never modified or deleted** (append-only semantics)
- Synchronization works by comparing change hashes between peers
- Clients can sync with other clients (P2P) or servers (client-server)
- The append-only structure ensures **cryptographic integrity** and **audit trails**

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
- **Encryption Key Pair** (RSA or ECDH): Used **only for encryption/decryption** of the named symmetric keys map stored on disk (encryption only, not signing)

**User Registration:**
- Users are registered by administrators using the administration key (for signing the registration)
- Registration creates an **administration signature** (signed with administration key) proving the user has been granted access
- User public keys are stored in the tenant's directory database

**Key Derivation:**
- Both user private keys are encrypted with a single password
- Key derivation function (KDF) uses different salts for each key:
  - Signing key: salt = "signing"
  - Encryption key: salt = "encryption"
  - Named symmetric keys: salt = key ID (e.g., "default", "project-alpha")

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
- Changes are stored in the append-only store with metadata (document ID, change hash, dependencies, timestamp)
- **Note**: Signing and encryption are separate operations using different keys (signing key for signatures, encryption keys for payload encryption)

### 4. Append-Only Store

The **AppendOnlyStore** is the core synchronization mechanism:

**Structure:**
- Stores binary Automerge changes with signatures and encryption
- Each change has a unique hash (Automerge change hash)
- Changes are never modified or deleted (true append-only)
- Changes are cryptographically chained to ensure tamperproofness (like a blockchain)
- Concrete implementations can be built on trusted systems like ImmuDB for additional tamperproof guarantees

**Synchronization:**
- Peers exchange lists of change hashes they have
- Missing changes are requested and transferred
- Changes can be verified by checking signatures
- Supports client-client, client-server, and server-server synchronization

**Performance Optimization:**
- **Snapshots**: Regular Automerge snapshots are generated for documents
- When loading a document, only changes since the last snapshot need to be applied
- This prevents having to replay the entire document history for each access
- Snapshots are stored alongside changes in the append-only store

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
- Named keys are created using `createNamedSymmetricKey()`
- Keys can be protected with an additional password (distributed via secure channel)
- Keys are stored encrypted on disk using the user's encryption key pair
- Key rotation is supported by storing multiple versions per key ID

**Key Storage:**
- Named symmetric keys are stored in a map: `Map<keyId, EncryptedPrivateKey[]>`
- The map itself is stored on disk encrypted with the user's encryption key pair
- Users unlock their encryption key with their password to access named keys

### 6. Security Model

**Signing:**
- All document changes are signed with the user's signing key (Ed25519)
- Signatures prove:
  - **Authenticity**: The change was created by the user
  - **Integrity**: The change has not been tampered with
- Signatures are verified when changes are received from other peers
- **Key Usage**: Signing keys are used **only for signing**, never for encryption

**Encryption:**
- Document payloads are encrypted before storage
- Encryption keys are identified by `decryptionKeyId` in the change metadata
- Users must have the corresponding key to decrypt changes
- Encryption prevents unauthorized access to document contents
- **Key Usage**: Encryption keys are used **only for encryption/decryption**, never for signing

**Tamperproofness:**
- Changes in the append-only store are cryptographically chained (like a blockchain)
- Each change references previous changes through dependency hashes
- Any modification to a change would break the cryptographic chain
- Concrete implementations can leverage trusted systems like **ImmuDB** for additional tamperproof guarantees at the storage layer
- This ensures the integrity of the entire document history

**Access Control:**
- **Registration**: Only administrators can register new users (proven by administration signature)
- **Document Access**: Controlled by key distribution (users must have the encryption key)
- **Revocation**: Due to append-only nature, revocation prevents future access but not past access
  - Users who lose access cannot decrypt new changes
  - Previously decrypted changes remain accessible (append-only limitation)

## Data Flow

### Creating a Tenant

1. Client calls `TenantFactory.createTenant()` with:
   - Tenant ID
   - Administration key password
   - Tenant encryption key password
2. System generates:
   - Administration key pair (Ed25519)
   - Tenant encryption key (AES-256, stored as "default" in named keys map)
3. Tenant is ready for use

### Creating a User

1. Client calls `TenantFactory.createUserId()` with username and password
2. System generates:
   - Signing key pair (Ed25519)
   - Encryption key pair (RSA or ECDH)
3. Both private keys are encrypted with the password (via key derivation)
4. Administrator registers the user using `registerUser()` with administration key
5. This adds the user to the special MindooDB named "directory", signed with the administration key to verify the user is trusted.
6. For users with revoked tenant access, we might add a record to the directory as well so that their changes are no longer trusted and ignored.

### Creating a Document

1. Client calls `MindooDB.createDocument()` or `createEncryptedDocument(keyId)`
2. If encrypted, the key ID is stored in document metadata
3. First change is created and stored in append-only store
4. Change is signed with user's signing key
5. Change is encrypted with the specified key (or "default" tenant key)

### Modifying a Document

1. Client calls `MindooDB.changeDoc()` with document and change function
2. System:
   - Applies the change function to the Automerge document
   - Generates binary Automerge change
   - Signs the change with user's signing key
   - Determines encryption key ID from document metadata (from first change)
   - Encrypts the change payload with the appropriate key
   - Appends to append-only store

### Synchronizing Changes

1. Client A calls `AppendOnlyStore.findNewChanges()` with list of known change hashes
2. Client B (or server) returns list of missing changes
3. Client A calls `AppendOnlyStore.getChanges()` to fetch the actual changes
4. For each change:
   - Verify signature (prove authenticity and integrity)
   - Decrypt payload if encrypted (using appropriate key from user's key map)
   - Apply change to Automerge document
5. Updated document state is available
6. **Internal Index Update**: The local MindooDB instance updates its internal index when documents actually change (after applying changes)
7. The index tracks which documents have changed and when, enabling incremental operations on the database
8. `processChangesSince()` uses this index to efficiently find documents that changed since a given timestamp
9. This enables external systems to efficiently query for document changes and update their own indexes incrementally

### Key Distribution

1. Administrator creates named key: `createNamedSymmetricKey(keyId, optionalPassword)`
2. Encrypted key is distributed to authorized users (email, shared folder, etc.)
3. If password-protected, password is communicated via secure channel (phone, in-person)
4. Users add the key to their `NamedSymmetricKeysMap`
5. Key is stored encrypted on disk using user's encryption key pair
6. **Access Discovery**: When a new key is added to a user's `NamedSymmetricKeysMap`, the system scans all append-only stores to identify documents encrypted with that key ID
7. For newly accessible documents, the system builds their latest state by applying all changes
8. Users can now decrypt and access documents encrypted with that key ID

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
- Snapshots are stored in the append-only store
- The system tracks which changes have been snapshotted
- `getAllChangeHashesForDoc()` supports `fromLastSnapshot` parameter

### Append-Only Store Efficiency

- Changes are identified by hash, enabling efficient duplicate detection
- Bulk operations (`getChanges()`) reduce network round-trips
- Change hashes are small, enabling efficient synchronization
- Only missing changes are transferred during sync

### Historical Analysis

An important benefit of the append-only structure is the ability to **go back in time** and perform historical analysis:
- All document changes are preserved in the append-only store
- Documents can be reconstructed to any point in time by applying changes up to a specific timestamp
- This enables:
  - **Audit trails**: Complete history of who changed what and when
  - **Time travel**: View document state at any historical point
  - **Change analysis**: Analyze how documents evolved over time
  - **Compliance**: Meet regulatory requirements for data retention and auditability

## Limitations and Trade-offs

### Append-Only Revocation Limitation

Due to the append-only nature of the store:
- **Revoking user access** prevents them from decrypting future changes
- **Previously decrypted changes** remain accessible to revoked users
- This is a fundamental trade-off: audit trail and integrity vs. retroactive access control

**Mitigation:**
- Use named keys for sensitive documents (smaller blast radius)
- Rotate keys when users leave (they can't decrypt new changes)
- Accept that historical access cannot be retroactively revoked

### Key Management Complexity

- Users must manage multiple keys (signing, encryption, named symmetric keys)
- Key distribution requires offline secure channels
- Key rotation requires coordination among all authorized users

**Mitigation:**
- Single password unlocks all keys (via key derivation)
- Named keys stored encrypted on disk (unlocked with user encryption key)
- Clear key ID system for identifying which key to use

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
- Append-only store provides complete audit trail
- All changes are signed and timestamped
- Cryptographic proofs of all operations

## Future Enhancements

- **Forward Secrecy**: Key rotation that prevents decryption of future changes
- **Key Escrow**: Secure key recovery mechanisms
- **Advanced Access Control**: Role-based access with key hierarchies
- **Performance Optimizations**: More sophisticated snapshot strategies
- **Network Protocols**: Optimized sync protocols for large-scale deployments
- **Document Attachments**: 
  - Support for file attachments to documents
  - **Lazy Loading**: Attachments can be loaded on-demand from other parties (not all peers need to store all attachments)
  - **Encrypted Chunks**: Attachment data is encrypted in chunks to enable random file access
  - **Efficient Streaming**: Large attachments can be streamed and accessed without loading the entire file
  - **Access Control**: Attachment encryption follows the same key model as documents (tenant key or named keys)

