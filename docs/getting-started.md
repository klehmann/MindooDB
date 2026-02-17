# Getting Started with MindooDB

MindooDB is an end-to-end encrypted, offline-first sync database that runs on Node.js, web browsers, and React Native. You create tenants and users entirely on the client — private keys never leave the device, and the server only ever sees encrypted blobs. This guide walks you through the complete setup: creating a tenant, publishing it to a server, inviting a second user, and collaborating on shared encrypted data.

If you have used traditional databases before, MindooDB will feel familiar in terms of reading and writing documents. The difference is that everything is cryptographically signed, encrypted, and designed for multi-device sync without trusting the server.

> **Who is this for?** Whether you are an application developer looking to ship a working integration quickly, a platform engineer evaluating security and correctness, or a technical decision maker assessing adoption risk — this guide covers the full journey from zero to a working multi-user setup. Code examples are ready to copy-paste; security context is provided inline so you understand what happens under the hood.

---

## Prerequisites

Install MindooDB in your project:

```bash
npm install mindoodb
```

MindooDB runs on three platforms. The API is identical across all of them — only the initial import differs:

| Platform | Import |
|----------|--------|
| **Node.js** | `import { BaseMindooTenantFactory, ... } from "mindoodb"` |
| **Web Browser** | `import { BaseMindooTenantFactory, ... } from "mindoodb/browser"` |
| **React Native** | `import { BaseMindooTenantFactory, ... } from "mindoodb"` (with native Automerge setup, see [React Native Guide](./reactnative.md)) |

For this guide, we use Node.js imports. Replace them with the browser or React Native imports if you are targeting those platforms — every other line of code stays the same.

---

## Step 1: Create a Tenant

A tenant represents your organization or team. Creating one generates all the cryptographic keys, opens the tenant for use, and registers the first user in the directory — in a single call.

```javascript
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
} from "mindoodb";

const storeFactory = new InMemoryContentAddressedStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory);

const { tenant, adminUser, appUser, keyBag } = await factory.createTenant({
  tenantId: "acme",
  adminName: "cn=admin/o=acme",
  adminPassword: "strong-admin-password",
  userName: "cn=alice/o=acme",
  userPassword: "strong-user-password",
});
```

Behind the scenes, `createTenant` performs five operations: it creates the admin identity (Ed25519 signing key + RSA-OAEP encryption key), creates the regular user identity, generates the tenant encryption key and the `$publicinfos` key in a new KeyBag, opens the tenant, and registers the regular user in the admin-signed directory database.

The admin identity is kept separate from the regular user identity by design. Admin credentials are used exclusively for privileged operations like registering users and changing tenant settings; the regular user identity is what you use for day-to-day document operations. This separation limits the blast radius if a user's device is compromised.

> **For platform engineers:** The admin signing key (Ed25519) is the root of trust. Every user registration in the directory is signed with this key. Clients and servers verify these signatures before trusting any user's public key. The `$publicinfos` key (AES-256) encrypts only the directory's access-control entries so that the server can validate users without seeing plaintext usernames.

---

## Step 2: Publish the Tenant to a Server

Now that the tenant exists locally, you register it on a MindooDB sync server. The server stores only encrypted data and the admin's public keys — it never receives private keys or plaintext content.

```javascript
await tenant.publishToServer("https://sync.example.com");
```

This sends the admin's public signing key, public encryption key, and the `$publicinfos` key to the server's registration endpoint. The server uses the `$publicinfos` key to read the directory database and validate incoming sync requests against the admin-signed user registry.

If you want to pre-register users on the server at the same time (so they can sync immediately after joining), you can pass them as an option:

```javascript
await tenant.publishToServer("https://sync.example.com", {
  registerUsers: [factory.toPublicUserId(appUser)],
});
```

> **For decision makers:** This is the extent of server-side setup. There are no server-side user accounts to manage, no passwords to store on the server, no session databases. The server is a relay for encrypted blobs. If the server is breached, the attacker gets ciphertext and public keys — no plaintext data, no private keys, no usernames.

---

## Step 3: Create and Sync Your First Document

With the tenant published, you can create a database, add a document, and push the encrypted changes to the server.

```javascript
const db = await tenant.openDB("todos");

const doc = await db.createDocument();
await db.changeDoc(doc, (d) => {
  d.getData().title = "Buy groceries";
  d.getData().done = false;
});

// Connect to the server and push
const remote = await tenant.connectToServer("https://sync.example.com", "todos");
await db.pushChangesTo(remote);
```

Every document change is automatically signed with the user's Ed25519 key and encrypted with the tenant's default encryption key (AES-256-GCM) before it is stored. When you push to the server, only the encrypted entries travel over the wire.

`connectToServer` creates a remote store backed by an HTTP transport. It handles authentication (challenge-response using your signing key), encryption of the sync payload, and capability negotiation with the server. You can use the returned store with `pushChangesTo` and `pullChangesFrom` just like any local store.

---

## Step 4: Invite a Second User

This is where MindooDB's security model shines. Inviting a new user is a three-step handshake where both sides keep control of their private keys, and the shared encryption keys are protected by a one-time password communicated out-of-band (for example, by phone or in person).

### 4a. The new user creates a join request

Bob wants to join the "acme" tenant. He creates his identity locally — his private keys are generated on his device and never leave it. He then creates a join request that contains only his public keys.

```javascript
// On Bob's machine
const bob = await factory.createUserId("cn=bob/o=acme", "bobs-password");

const joinRequest = factory.createJoinRequest(bob, { format: "uri" });
// → "mdb://join-request/eyJ2IjoxLCJ1c2VybmFtZSI6..."
```

The join request is a `mdb://join-request/...` URI containing a base64url-encoded JSON payload with Bob's username, public signing key, and public encryption key. It is safe to share through any channel — email, chat, QR code — because it contains no secrets.

### 4b. The admin approves the join request

Alice (the admin) receives Bob's join request and approves it. This registers Bob in the tenant's directory database and prepares an encrypted response containing the tenant's symmetric keys.

```javascript
// On Alice's machine
const joinResponse = await tenant.approveJoinRequest(joinRequest, {
  adminSigningKey: adminUser.userSigningKeyPair.privateKey,
  adminPassword: "strong-admin-password",
  sharePassword: "one-time-secret-42",
  serverUrl: "https://sync.example.com",
  format: "uri",
});
// → "mdb://join-response/eyJ2IjoxLCJ0ZW5hbnRJZCI6..."
```

The join response contains the tenant ID, admin public keys, the server URL, and the tenant's symmetric keys encrypted with the `sharePassword`. Alice sends the `mdb://join-response/...` URI to Bob (same channels as before), and communicates the `sharePassword` separately through a secure channel like a phone call or in-person meeting.

> **Security note:** The `sharePassword` never travels alongside the join response. Even if the join response URI is intercepted, the attacker cannot decrypt the symmetric keys without the share password. This is the same principle used by secure key-exchange protocols: split the secret across two channels.

### 4c. Bob joins the tenant

Bob receives the join response URI and the share password, and joins the tenant.

```javascript
// On Bob's machine
const { tenant: bobTenant, keyBag: bobKeyBag } = await factory.joinTenant(
  joinResponse,
  {
    user: bob,
    password: "bobs-password",
    sharePassword: "one-time-secret-42",
  }
);
```

`joinTenant` parses the response, decrypts the symmetric keys using the share password, creates a new KeyBag with the imported keys, and opens the tenant. Bob now has a fully operational tenant that can read and write encrypted data.

---

## Step 5: Collaborate

With both users set up, collaboration is straightforward. Bob pulls the latest data from the server, modifies a document, and pushes his changes back.

```javascript
// On Bob's machine
const remote = await bobTenant.connectToServer("https://sync.example.com", "todos");
const db = await bobTenant.openDB("todos");

// Pull Alice's documents
await db.pullChangesFrom(remote);
await db.syncStoreChanges();

// Read and modify
const ids = await db.getAllDocumentIds();
const todo = await db.getDocument(ids[0]);
console.log(todo.getData()); // { title: "Buy groceries", done: false }

await db.changeDoc(todo, (d) => {
  d.getData().done = true;
});

// Push back to server
await db.pushChangesTo(remote);
```

Alice can then fetch Bob's changes:

```javascript
// On Alice's machine
await db.pullChangesFrom(remote);
await db.syncStoreChanges();

const updated = await db.getDocument(ids[0]);
console.log(updated.getData().done); // true
```

Documents use Automerge CRDTs under the hood, so concurrent edits from multiple users merge automatically without conflicts. If Alice and Bob both modify the same document offline, their changes are reconciled when they next sync — no manual conflict resolution needed.

---

## Step 6: Persisting and Restoring a Session

The examples above create everything in memory. In a real application, you need to persist the user identity and KeyBag so the tenant can be reopened after a restart without repeating the setup or join flow.

Three pieces of data need to be saved:

1. **The user identity** (`PrivateUserId`) — a plain JSON object containing the user's encrypted private keys and public keys. It is safe to write to disk because the private keys inside are already encrypted with the user's password.
2. **The KeyBag** — call `keyBag.save()` to get an encrypted `Uint8Array` containing all symmetric keys (tenant key, `$publicinfos` key, any named document keys). The blob is encrypted with the user's encryption key, so it is safe to store alongside the identity.
3. **Tenant metadata** — the tenant ID and the admin's public keys. These are not secret, but you need them to call `openTenant` on restart.

### Saving after setup or join

```javascript
import { writeFileSync } from "fs";

// After createTenant or joinTenant:
const keyBagBlob = await keyBag.save();

writeFileSync("user-identity.json", JSON.stringify(appUser));   // or bob
writeFileSync("keybag.bin", Buffer.from(keyBagBlob));
writeFileSync("tenant-meta.json", JSON.stringify({
  tenantId: "acme",
  adminSigningPublicKey: adminUser.userSigningKeyPair.publicKey,
  adminEncryptionPublicKey: adminUser.userEncryptionKeyPair.publicKey,
}));
```

> **Tip:** You can combine all three into a single file if you prefer. The user identity and tenant metadata are JSON; the KeyBag blob can be stored as a base64 string inside the same JSON. The important thing is that none of this data is plaintext-sensitive — private keys and symmetric keys are already encrypted.

### Restoring on restart

```javascript
import { readFileSync } from "fs";
import { BaseMindooTenantFactory, InMemoryContentAddressedStoreFactory, KeyBag } from "mindoodb";

const storeFactory = new InMemoryContentAddressedStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory);

// Load persisted data
const savedUser = JSON.parse(readFileSync("user-identity.json", "utf-8"));
const keyBagBlob = new Uint8Array(readFileSync("keybag.bin"));
const meta = JSON.parse(readFileSync("tenant-meta.json", "utf-8"));

// Recreate KeyBag and load saved keys
const keyBag = new KeyBag(savedUser.userEncryptionKeyPair.privateKey, "strong-user-password");
await keyBag.load(keyBagBlob);

// Reopen the tenant
const tenant = await factory.openTenant(
  meta.tenantId,
  meta.adminSigningPublicKey,
  meta.adminEncryptionPublicKey,
  savedUser,
  "strong-user-password",
  keyBag,
);

// Ready — connect, open databases, sync as before
const remote = await tenant.connectToServer("https://sync.example.com", "todos");
const db = await tenant.openDB("todos");
await db.pullChangesFrom(remote);
```

The user's password is the only thing not stored on disk. Your application should prompt for it on startup (or use a platform-specific credential store like Keychain or Android Keystore).

> **Planned enhancement:** A future `exportSession` / `restoreSession` convenience API will collapse these three persistence steps into a single encrypted blob and a one-liner restore call.

---

## What Happens Under the Hood

For those who want to understand the cryptographic flow in more detail, here is what each step does at the protocol level.

### Tenant creation

`createTenant` generates four key pairs and two symmetric keys:

| Key | Type | Purpose |
|-----|------|---------|
| Admin signing key | Ed25519 | Signs directory entries (user registrations, revocations) |
| Admin encryption key | RSA-OAEP (3072-bit) | Encrypts usernames in the directory for privacy |
| User signing key | Ed25519 | Signs document changes (proves authorship) |
| User encryption key | RSA-OAEP (3072-bit) | Encrypts the local KeyBag |
| Tenant key | AES-256 | Encrypts document content (default encryption key) |
| $publicinfos key | AES-256 | Encrypts directory access-control entries |

All private keys are encrypted with their respective passwords using PBKDF2 key derivation with unique salts. The KeyBag stores symmetric keys encrypted with the user's encryption key.

### Join request / response

The join request is a JSON object containing only public information:

```json
{
  "v": 1,
  "username": "cn=bob/o=acme",
  "signingPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n..."
}
```

The join response contains the same metadata plus encrypted keys:

```json
{
  "v": 1,
  "tenantId": "acme",
  "adminSigningPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "adminEncryptionPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "serverUrl": "https://sync.example.com",
  "encryptedTenantKey": { "encrypted": "...", "salt": "...", "iv": "...", "iterations": 600000 },
  "encryptedPublicInfosKey": { "encrypted": "...", "salt": "...", "iv": "...", "iterations": 600000 }
}
```

Both are encoded as base64url and prefixed with `mdb://join-request/` or `mdb://join-response/` to form shareable URIs.

### Sync authentication

When a client connects to the server, the `connectToServer` method establishes a challenge-response authentication flow:

1. The client sends its public signing key to the server.
2. The server looks up the key in the directory and sends a random challenge.
3. The client signs the challenge with its private signing key and returns the signature.
4. The server verifies the signature against the registered public key.

If the key is not found in the directory or has been revoked, the server rejects the connection. No passwords or tokens are stored on the server.

---

## Platform-Specific Setup

### Node.js

No additional setup needed. Install `mindoodb` and use the examples above as-is.

### Web Browser

Use the browser-specific import path and provide a crypto adapter:

```javascript
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  createCryptoAdapter,
} from "mindoodb/browser";

const cryptoAdapter = createCryptoAdapter();
const storeFactory = new InMemoryContentAddressedStoreFactory();
const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

// Everything else is identical to the Node.js examples above
```

For persistent browser storage, use `IndexedDBContentAddressedStoreFactory` instead of `InMemoryContentAddressedStoreFactory`. See [Browser IndexedDB Store](./browser-indexeddb-store.md) for details.

### React Native / Expo

React Native requires the native Automerge backend and a set of polyfills for crypto, `TextDecoder`, and URL handling:

```bash
npm install mindoodb react-native-automerge-generated
npx mindoodb setup-react-native
```

The `react-native-automerge-generated` package provides a native Rust backend for Automerge (via UniFFI bindings) that replaces the default WASM implementation. It exports a drop-in `Automerge` class that you can use directly — no `@automerge/automerge` dependency needed:

```javascript
import { Automerge } from "react-native-automerge-generated";

// Use exactly like @automerge/automerge
let doc = Automerge.init();
doc = Automerge.change(doc, (d) => {
  d.title = "Buy groceries";
  d.done = false;
});
```

MindooDB detects and uses this native backend automatically on React Native. After the polyfill setup (crypto, `TextDecoder`, `atob`/`btoa`, URL — handled by the setup helper), all the code examples above work identically. For the full setup guide and polyfill details, see [React Native Guide](./reactnative.md).

---

## Next Steps

With the basic setup complete, there are several directions to explore depending on your needs:

- **[Architecture Specification](./specification.md)** — Deep dive into the cryptographic model, store architecture, and security guarantees.
- **[Network Sync Protocol](./network-sync-protocol.md)** — Full endpoint contracts, capability negotiation, and performance optimization (bloom filters, cursor-based sync).
- **[Attachments](./attachments.md)** — Chunked, encrypted file attachments with streaming support.
- **[Named Key Encryption](./specification.md#5-encryption-model)** — Fine-grained access control where only users with a specific key can decrypt certain documents.
- **[Logging](./logging.md)** — Configurable logging for debugging and production monitoring.
- **[Data Indexing](./dataindexing.md)** — Incremental queries and cursor-based document iteration.
- **[Time Travel](./timetravel.md)** — Reconstruct any historical state of a document.
