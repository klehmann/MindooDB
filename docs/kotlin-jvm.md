# MindooDB for Kotlin and Java

This guide shows how a JVM application (Kotlin or Java, for example a Spring or Ktor backend, a batch job or an integration service) reads and writes MindooDB data: create a tenant locally, publish it to a server, sync, let other users join, work with documents and attachments, and read virtual views.

The JVM side is the Kotlin library [`mindoodb-kmp-client`](https://github.com/klehmann/mindoodb-kmp-client). It talks to a small Node.js process, the [`mindoodb-jvm-bridge`](https://github.com/klehmann/mindoodb-jvm-bridge) sidecar, which runs the real `mindoodb` engine. Everything MindooDB guarantees (end-to-end encryption, signed changes, CRDT merging, access control) is done by the same TypeScript code that Node.js, browsers, React Native and Haven use. There is no second implementation to drift apart.

> **Status:** the Kotlin/JVM client is beta: its APIs may still change. MindooDB and Haven themselves are not beta. Both projects build from source today; they are not on Maven Central or npm yet.

---

## How it works

```
JVM application
  └─ mindoodb-kmp-client (Kotlin, coroutines)
       │  loopback WebSocket: JSON-RPC + binary attachment frames
       ▼
mindoodb-jvm-bridge supervisor (Node.js)
  └─ one child process per user session
       └─ mindoodb engine + decrypted KeyBag + on-disk replica
```

- **One session = one user = one child process.** Each session unlocks one user's KeyBag in its own OS process. Several users in one JVM means several sessions, and their keys and replicas never mix.
- **Local-first.** Each session has its own on-disk replica (`<dataRoot>/<tenantId>/<hash(user)>/`). Reads, queries and views run locally; a background loop syncs with the server every 5 seconds once a server URL is set.
- **Loopback only.** The supervisor binds to `127.0.0.1`, writes a mode-600 handshake file with a random bootstrap token, and requires a per-session token on every frame. The user's password unlocks the KeyBag in the child process; the JVM only sees JSON results and attachment bytes.
- **Coroutines.** Every client call is a `suspend` function or a `Flow`. From Java, wrap them (see [Using it from Java](#using-it-from-java)).

The wire protocol is documented in [PROTOCOL.md](https://github.com/klehmann/mindoodb-jvm-bridge/blob/main/PROTOCOL.md) if you want to write a client in another language.

---

## Prerequisites

- JDK 21 or newer
- Node.js 22.13 or newer on the machine that runs the JVM (the sidecar is started as a child process)
- A MindooDB server if you want to sync (see [Running a server](../README-server.md)); local-only use needs none

## Setup

Clone both projects next to each other and build the sidecar:

```bash
git clone https://github.com/klehmann/mindoodb-jvm-bridge.git
git clone https://github.com/klehmann/mindoodb-kmp-client.git

cd mindoodb-jvm-bridge
npm install
npm run build          # → dist/index.js
```

Build the Kotlin client and run its tests (they start the sidecar from `../mindoodb-jvm-bridge`):

```bash
cd ../mindoodb-kmp-client
./gradlew jvmTest
```

To use the client in your own Gradle build, either include it as a composite build:

```kotlin
// settings.gradle.kts of your application
includeBuild("../mindoodb-kmp-client")
```

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.mindoo.db:mindoodb-kmp-client:0.0.1")
}
```

or publish it to your local Maven repository with `./gradlew publishToMavenLocal` (add the `maven-publish` plugin first) and depend on the same coordinates. Ship `mindoodb-jvm-bridge/dist`, its `node_modules` and a Node.js runtime with your application.

---

## Step 1: Start the sidecar

```kotlin
import com.mindoo.db.bridge.*
import java.nio.file.Paths

val sidecar = Sidecar.start(
    entryScript = Paths.get("../mindoodb-jvm-bridge/dist/index.js"),
    dataRoot = Paths.get("./mindoodb-data"),   // replicas + identity files live here
)
val endpoint = sidecar.endpoint                 // host, port, bootstrap token
// ... later: sidecar.stop()
```

`Sidecar.start` launches `node`, waits for the ready line and reads the handshake file. If the supervisor runs as a separate service, read its handshake file yourself and pass `host`, `port` and `bootstrapToken` to the `MindooDBBridge` functions instead of an endpoint.

Keep `dataRoot` on persistent storage. It holds each user's replica and a password-locked identity bundle (`identity.json`); without it the user's keys are gone.

## Step 2: Create a tenant

A tenant is an organization or team. Creating one is purely local: it generates the admin and user key pairs, the tenant keys and the directory database, and writes an identity bundle for the app user.

```kotlin
import kotlinx.coroutines.runBlocking

runBlocking {
    val created = MindooDBBridge.createTenant(
        endpoint,
        tenantId = "acme",                       // lowercase letters, digits, - and _
        adminName = "cn=admin/o=acme",
        adminPassword = "a long admin passphrase",
        userId = "cn=service/o=acme",
        password = "a long user passphrase",
        databases = listOf("orders"),
    )
    // Keep created.adminIdentity (password-locked) if this process will approve join requests.
}
```

The **admin** is the root of trust: it signs the directory (who belongs to the tenant, grants, policies). The **app user** is the identity your code works as. Use strong passphrases; they protect private keys that never leave this machine.

## Step 3: Open a session

```kotlin
val session = MindooDBBridge.openSession(
    endpoint, tenantId = "acme", userId = "cn=service/o=acme",
    password = "a long user passphrase", databases = listOf("orders"),
)
val orders = session.database("orders")
// ...
session.close()   // stops the child process
```

`openDatabase(id)` opens further databases later. `openDatabase(id, DatabaseMode.Remote)` opens one whose primary store is the server itself (every read and write is a network call, nothing is replicated locally) for occasional access to large databases.

---

## Step 4: Work with documents

```kotlin
val doc = orders.documents.create(mapOf(
    "type" to "order",
    "customer" to "Contoso",
    "total" to 1290.0,
))

orders.documents.update(doc.id, baseHeads = doc.heads) {
    setAtomic("status", "open")                     // a value, not editable text
    set("lines", listOf(mapOf("sku" to "A-1", "qty" to 3)))
    setText("notes", "Deliver after 10 am")         // collaborative text
    set("reminders", MindooValue.counter(0))
}
orders.documents.update(doc.id) { increment("reminders") }

val current = orders.documents.get(doc.id)        // data, heads, attachments, isDeleted
val ids = orders.documents.list()
orders.documents.delete(doc.id)
orders.documents.undelete(doc.id)
```

- `create(initialValues, id = …)` uses your own ID (`^[a-z][a-z0-9_]*$`). Creating the same ID on two replicas converges into one document, which is what you want for settings singletons. `idPrefix` instead prefixes a generated, time-sortable ID.
- `createMany`, `deleteMany` and `listDeleted` work in batches.
- `history(docId)` lists every revision with author and time; `getAtRevision(docId, timestamp)` returns the document as it was then.

### Concurrent edits and `baseHeads`

MindooDB never rejects a write because someone else changed the document: every document is an Automerge CRDT and concurrent changes merge. Pass the `heads` you read as `baseHeads`. The update is then made against that version and merged into the current one, so edits of other fields survive and the result is the same on every replica. `UpdateResult.conflictExpected` tells you that the document had moved on in between, if you want to re-read it.

### Field types

How a value merges depends on how you write it:

| Write it with | Stored as | Concurrent changes |
|---|---|---|
| `setText`, or `set` with a plain `String` | collaborative text | merge character by character |
| `setAtomic` / `MindooValue.atomic(...)` | atomic string | last writer wins, never mixed |
| `MindooValue.counter(n)` + `increment` | counter | increments add up |
| `MindooValue.timestamp(ms)` | date | last writer wins |
| numbers, booleans, maps, lists | JSON values | per field / per list element |

Use atomic strings for IDs, status and enum values, URLs and hashes. A plain string is collaborative text: if one user changes `"open"` to `"closed"` while another changes it to `"blocked"`, text merging can produce a mix of both words.

Further update operations: `unset`, `merge(map)`, `textSplice(path, index, deleteCount, insert)` for small edits in long text, `listInsert` and `listDelete`. All operations of one `update { }` block are applied as a single change.

### Rich text, marks and cursors

```kotlin
val bold = buildJsonObject { put("bold", true) }
orders.documents.update(doc.id) {
    richText(listOf("description"), listOf(
        RichTextSpan.Block(buildJsonObject { put("type", "paragraph") }),
        RichTextSpan.Text("Rush "),
        RichTextSpan.Text("order", bold),
    ))
}

val snapshot = orders.documents.getRichText(doc.id, listOf("description"))
orders.documents.update(doc.id, baseHeads = snapshot.heads) {
    textMark(listOf("description"), index = 1, length = 4, marks = mapOf("italic" to true))
    richTextSteps(listOf("description"), listOf(RichTextStep.Splice(index = 11, insert = "!")))
}
```

- `richText(path, spans)` writes a whole field; MindooDB diffs it against the current spans, so concurrent edits elsewhere in the text survive.
- `richTextSteps` makes positional edits; `textMark` / `textUnmark` format a range of any collaborative text.
- `getRichText` reads spans with their marks. `get` only returns the plain string, where each block counts as one `￼` character.
- `getTextCursors(docId, path, positions)` returns cursors that keep pointing at the same character while others edit (store them with `setAtomic`, for example to anchor comments); `resolveTextCursors` turns them back into indexes, now or at older `heads`.

---

## Step 5: Attachments

Attachments are encrypted with the document's key, split into chunks and streamed in both directions with flow control, so large files never sit in memory as a whole.

```kotlin
import java.io.File

val info = orders.attachments.upload(
    doc.id, "invoice.pdf", "application/pdf",
    File("invoice.pdf").inputStream().asByteFlow(),
)
orders.attachments.uploadBytes(doc.id, "note.txt", "text/plain", "hello".encodeToByteArray())

File("copy.pdf").outputStream().use { out ->
    orders.attachments.read(doc.id, "invoice.pdf").collect { chunk -> out.write(chunk) }
}
orders.attachments.list(doc.id)
orders.attachments.removeById(doc.id, info.attachmentId)
```

`Flow<ByteArray>.asInputStream(scope)` turns a download into an `InputStream`, for example for a servlet response. Attachments sync like documents (both directions).

---

## Step 6: Query, search and views

### Queries

Queries answer from an index of document summaries, so they do not decrypt every document. Call `session.awaitIndexReady()` once after opening a session with existing data.

```kotlin
val result = orders.query(mindooQuery {
    filter = (field("type") eq "order") and (field("status") eq "open")
    sort("customer")
    limit = 50
})
result.rows.forEach { println("${it.docId} ${it.fields}") }

orders.liveQuery(mindooQuery { filter = field("status") eq "open" })
    .collect { println("${it.total} open orders") }   // re-emits on every change, also after sync
```

### Full-text search

Enable it per database once (the setting syncs to every member), then add a text clause:

```kotlin
orders.setFulltextSetup(buildJsonObject { put("enabled", true) })
val hits = orders.query(mindooQuery {
    text = TextClause("contoso delivery")
    sortByTextScore()
})
```

### Virtual views

A virtual view categorizes, sorts and totals documents, like a table of contents:

```kotlin
val nav = orders.openViewNavigator(
    viewDefinition {
        filter = field("type") eq "order"
        category("customer")
        column("total", totalMode = "sum")
        column("status")
    },
    navigatorOptions = navigatorOptions(expandAll = true),
)
nav.readForward(limit = 100).forEach { e ->
    if (e.isCategory) println("${"  ".repeat(e.level)}${e.categoryValue}")
    else println("${"  ".repeat(e.level)}${e.columnValues}")
}
nav.changes().collect { /* the view followed the database; read again */ }
nav.close()
```

The navigator walks the tree (`gotoFirst`, `gotoNext`, `gotoParent`, `gotoPos("1.2")`, siblings), expands and collapses categories, and selects entries (`select`, `readSelected`). While `changes()` is collected the view updates itself; otherwise call `nav.refresh()`.

### Incremental reads and the changefeed

Every database has a changefeed: each document appears once, at its latest state, ordered by when it last changed. A cursor marks how far you have read. That makes incremental processing cheap: a job reads what changed since its last run, saves the cursor, and stops. Cost grows with the number of changes, not with the size of the database.

```kotlin
var stored: String? = loadCursor()                 // e.g. from your own database; null = from the start
println("${orders.countChanges(ChangeCursors.parse(stored), idPrefix = "inv")} invoices to process")
do {
    val page = orders.readChanges(ChangeCursors.parse(stored), limit = 500, idPrefix = "inv")
    page.changes.forEach { exportToWarehouse(it.doc) }
    stored = ChangeCursors.serialize(page.cursor)
    saveCursor(stored)                             // only after the page is processed
} while (!page.done)
```

- `readChanges(cursor, limit, idPrefix)` returns one page up to the current end (`ChangePage(changes, cursor, done)`) and does not wait for new changes. `changesUntilNow(...)` is the same as a `Flow` that pages internally.
- `readChangeMetadata(...)` returns only document id, deleted flag and time, without decrypting anything. Use it to find out *which* documents changed (or were deleted), and load only those you need with `documents.get`.
- `countChanges(cursor, idPrefix)` counts what is left, for progress bars or to skip a run.
- `idPrefix` filters by ID prefix before documents are loaded, so give document types their own prefix (`create(values, idPrefix = "inv")`).
- A cursor is an opaque JSON object. Store it with `ChangeCursors.serialize` and pass `ChangeCursors.parse(...)` back unchanged. Save it after you processed a page: if the job dies mid-page, the page is read again (at-least-once), so make processing idempotent.
- Deleted documents appear in the feed too (`doc.isDeleted` / `meta.isDeleted`), so a mirror can remove them.

To follow changes live instead of polling, collect `changes(cursor, idPrefix)` (or `changeMetadata(...)`): it replays everything after the cursor and then emits each new change, including changes that arrive through sync.

```kotlin
orders.changes(sinceCursor = ChangeCursors.parse(stored)).collect { change ->
    exportToWarehouse(change.doc)
    saveCursor(ChangeCursors.serialize(change.cursor))
}
```

---

## Step 7: Publish to a server and sync

Publishing registers the tenant on a MindooDB server and uploads the directory. The server stores and relays ciphertext only.

```kotlin
val published = session.publishToServer(
    serverUrl = "https://sync.example.com",
    adminPassword = "a long admin passphrase",      // pushes the admin-signed directory
    // systemAdminUser = …, systemAdminPassword = … if only server admins may register tenants
)
```

From then on the session syncs in the background. To sync right away, for example before a batch job ends:

```kotlin
val r = session.refresh()                              // directory, userdirectory and all open databases
println(r.databases.map { "${it.dbId}: +${it.pulledEntries} / ${it.pushedEntries} pushed" })
session.refresh("orders", SyncDirection.Pull)
```

To show progress, for example during the first sync of a large tenant, collect `session.syncProgress()`. It reports every push and pull of the session (refresh, publish, approval and the background loop) per database and store: phase (`preparing`, `planning`, `transferring`, `processing`, `complete`), scanned and transferred entries and bytes, and `totalSourceEntries` when known, so `scannedEntries / totalSourceEntries` is a completion ratio. Each push or pull ends with `complete`. The background loop starts 5 seconds after a session opens, so subscribe first or call `refresh` yourself.

```kotlin
val progress = launch {
    session.syncProgress().collect { p ->
        val ratio = p.totalSourceEntries?.let { total -> p.scannedEntries * 100 / maxOf(total, 1) }
        println("${p.dbId} ${p.direction} ${p.store}: ${p.phase} ${ratio ?: "?"}% (${p.transferredEntries} entries)")
    }
}
session.refresh()
progress.cancel()
```

`rejectedEntries > 0` means the server refused some of your changes (typically because an access policy forbids them). A tenant created elsewhere (for example in Haven) can be used from the JVM through the join flow below.

---

## Step 8: Add users and devices

Joining never moves a private key: the new user creates their identity locally, the admin approves a request, and the response carries the keys wrapped for that user.

```kotlin
// On the joining side (another machine, or the same sidecar):
val user = MindooDBBridge.createUser(endpoint, "cn=billing/o=acme", "billing passphrase")
val request = MindooDBBridge.createJoinRequest(endpoint, user.identity, label = "Billing service")
// send request.joinRequest (an mdb:// URI) to the admin

// On the admin side, in a session of the tenant: look at the request first
val info = session.inspectJoinRequest(request.joinRequest)
println("${info.username} wants access for '${info.label}', key ${info.signingPublicKeyFingerprint}")
if (info.directoryUser?.exists == true) println("adds a device to an existing person")
val approved = session.approveJoinRequest(
    request.joinRequest,
    adminPassword = "a long admin passphrase",
    adminIdentity = created.adminIdentity,
)
// the grant is pushed to the server right away; send approved.joinResponse back

// Joining side again:
MindooDBBridge.joinTenant(
    endpoint, approved.joinResponse, user.identity, "billing passphrase",
    databases = listOf("orders"),
)
val billing = MindooDBBridge.openSession(endpoint, "acme", "cn=billing/o=acme", "billing passphrase", listOf("orders"))
```

`inspectJoinRequest` decodes the request without approving it. Compare `signingPublicKeyFingerprint` with the fingerprint the joining device shows (Haven uses the same format), so nobody can slip in their own keys. `directoryUser` tells you whether the name already exists (approving then adds a device to that person; pass `username` to choose the person yourself) and whether this exact device is already granted. `hasUserKey = false` means the requesting identity has no User-Key; create users with `createUser`, which adds one.

Haven users can approve the same request in Haven, and a JVM admin can approve requests created in Haven: it is the same protocol.

Restrict what a user may read with named keys: `session.createDocKey("finance")` creates a key, and `documents.create(values, decryptionKeyId = "finance")` encrypts a document with it. Only users who hold that key can decrypt the document. See [Access control](./accesscontrol.md) and [User keys](./userkeys.md).

---

## Using it from Java

The client is written for coroutines. Wrap the calls you need in a small Kotlin facade that returns `CompletableFuture`s:

```kotlin
// OrdersFacade.kt
class OrdersFacade(private val session: MindooDBSession) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val orders = session.database("orders")

    fun create(values: Map<String, Any?>): CompletableFuture<MindooDocument> =
        scope.future { orders.documents.create(values) }

    fun get(id: String): CompletableFuture<MindooDocument> =
        scope.future { orders.documents.get(id) }

    fun close(): CompletableFuture<Unit> = scope.future { session.close() }
}
```

```java
MindooDocument doc = facade.create(Map.of("type", "order", "customer", "Contoso")).join();
System.out.println(doc.getData().get("customer"));
```

`scope.future { }` comes from `kotlinx.coroutines.future` (part of `kotlinx-coroutines-core` on the JVM). Document data is a `kotlinx.serialization` `JsonObject`; convert it with your JSON library of choice if you prefer Jackson types.

---

## Errors

Calls throw `BridgeException` with a `code`:

| Code | Meaning |
|---|---|
| `NotFound` | document or attachment does not exist or is deleted |
| `NotAuthorized` | wrong password, missing key, or an access policy forbids the write |
| `BadRequest` | invalid parameters, query error, no server URL for `refresh` |
| `FulltextNotEnabled` | text search without full-text index |
| `SessionClosed` | the session or its child process ended; open a new one |
| `Internal` | anything else, with MindooDB's message |

## Operations checklist

- Back up `dataRoot`: identity bundles and replicas. A replica can be re-synced from the server; an identity cannot be recovered without its backup.
- Do not keep passwords in source code; they unlock the KeyBag once per session.
- One session per user identity. Sessions are cheap to keep open; closing one stops its child process.
- Run one supervisor per host and data root; it is reachable from loopback only.

## Testing

`mindoodb-kmp-client` has integration tests that start the sidecar, plus `ServerSyncIntegrationTest`, which syncs two users through a real server when `MINDOODB_TEST_SERVER_URL` is set. The sidecar's `scripts/e2e/server-sync.mjs` covers the same at protocol level. A local test server:

```bash
MINDOODB_SERVER_PASSWORD=test node node_modules/mindoodb/dist/node/server/serverinit.js \
  --name cn=testserver/o=test --skip-admin -d /tmp/mdb-server
# let any signed user register tenants (test only)
cat > /tmp/mdb-server/config.json <<'JSON'
{ "capabilities": { "POST:/system/tenants/*": [{ "username": "*", "publicsignkey": "*" }] } }
JSON
MINDOODB_SERVER_PASSWORD=test node node_modules/mindoodb/dist/node/server/server.js -d /tmp/mdb-server -p 1761
```

## Further reading

- [Getting started (Node.js)](./getting-started.md): the same concepts with the TypeScript API
- [Best practices](./best-practices.md): data modeling, queries and views that stay fast
- [Virtual views](./virtualview.md), [Attachments](./attachments.md), [Time travel](./timetravel.md), [Full-text search](./fulltext-search.md)
- [Access control](./accesscontrol.md) and [User keys](./userkeys.md)
- [Bridge wire protocol](https://github.com/klehmann/mindoodb-jvm-bridge/blob/main/PROTOCOL.md)
