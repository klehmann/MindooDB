# Best Practices for Building MindooDB Applications

## Overview

MindooDB is not a remote SQL server with encryption bolted on. Four structural
properties — **append-only storage**, **local-first replicas**,
**client-side-only querying**, and **read access enforced by encryption rather
than by filtering** — change which application designs are cheap and which are
expensive. A design that is idiomatic against PostgreSQL or MongoDB can be an
order of magnitude slower here, or quietly less safe.

This document collects the practices that follow from those properties. Each one
states *what* to do, *why* the architecture makes it the right call, and *when*
the opposite choice is justified. It deliberately does not re-specify APIs; every
practice links to the reference document that does.

### How to read this document

| You are | Read | Skip |
|---|---|---|
| **Deciding whether to adopt MindooDB** | [1. The five properties](#1-the-five-properties-that-change-how-you-build), [2. Adoption snapshot](#2-adoption-snapshot), [5. Read access](#5-read-access-is-encryption-not-filtering) | Everything from section 6 on |
| **Shipping your first feature** | Sections [1](#1-the-five-properties-that-change-how-you-build), [3](#3-the-cost-model-you-are-optimizing-against), [4](#4-querying-summary-first)–[8](#8-building-apps-for-haven), then the [checklists](#10-review-checklists) | Section 9 |
| **Reviewing correctness, scale, failure behavior** | All of it, especially [3](#3-the-cost-model-you-are-optimizing-against), [4](#4-querying-summary-first), [9. Semantics and invariants](#9-semantics-and-invariants) | — |

---

## 1. The Five Properties That Change How You Build

Everything else in this document is a consequence of this table. If you only read
one section, read this one.

| Property | What it means | The practice it forces |
|---|---|---|
| **Append-only, hash-chained store** | Entries are immutable. Nothing is updated or deleted in place; history is the storage format, not a feature layered on top. | Plan database growth up front ([§6.3](#63-plan-for-growth-before-you-need-to)). Write small patches, not whole-document rewrites ([§6.2](#62-write-patches-not-whole-document-rewrites)). Treat history and audit as free ([§6.4](#64-history-is-free-use-it)). |
| **Local-first replicas** | Every client holds a full local replica and reads it without the network. Sync is a background transport, not a request path. | Never block the UI on sync ([§7.1](#71-never-block-the-ui-on-sync)). Work against a synced local replica, not a remote store ([§7.2](#72-sync-a-local-replica-do-not-work-against-a-remote-store)). |
| **The server cannot query** | Data is ciphertext to the server. There is no server-side index, no `WHERE` clause, no aggregation pushdown. | All querying is client-side and index-backed. The summary buffer, not the document store, is your query substrate ([§4](#4-querying-summary-first)). |
| **Materialization is the expensive operation** | Reading a document means fetching entries, verifying signatures, decrypting, and replaying an Automerge DAG. | Never materialize to answer a list, filter, sort, or count ([§4.1](#41-query-the-summary-buffer-materialize-only-what-you-display)). |
| **Read access is encryption, not filtering** | A document a user may not read is ciphertext to them. No query filter and no engine-side skip decides visibility. | Model read access as key scope, not as a predicate you must remember to apply ([§5](#5-read-access-is-encryption-not-filtering)). |

Offline clients also control their own clocks, which is why anything auditable
must key off trusted time rather than a client-supplied timestamp
([§7.4](#74-design-for-the-offline-clock)).

---

## 2. Adoption Snapshot

**Effort.** A local-only prototype is hours: create a tenant, open a database,
write documents, all client-side with no server involved. Adding sync to that
prototype is also hours if you use the reference server — deploy it with the
provided setup script and publish the tenant to it; you implement no endpoints.
The days-scale task is **writing your own store or relay implementation** — a
custom backend, a peer-to-peer transport, or a bridge into existing
infrastructure. That means implementing the `ContentAddressedStore` interface and
speaking the sync protocol (two auth endpoints, five sync endpoints, plus the
optional cursor, Bloom-filter, and SSE capabilities), which is well specified but
is real work. See [Network Sync Protocol](network-sync-protocol.md) and
[P2P Sync](p2psync.md).

**The one design decision that dominates.** Which fields are queryable from the
summary buffer. Get it right and lists, searches, and dashboards are in-memory
scans over a compact RAM structure. Get it wrong and the same screens fall back
to materializing documents, which is the slowest thing the system does. This is
reversible — the summary configuration is a derived local index, not a document
attribute, so changing it never rewrites documents
([§4.2](#42-keep-filter-and-sort-fields-summary-coverable)).

**Where MindooDB is a poor fit.** Very high write throughput against an
append-only store; workloads needing complex relational joins; anything that
requires the server to filter or aggregate on your behalf; teams that cannot
accept client-side key custody. See
[Target Audiences](usecases/target-audiences.md).

### Quick decision checklist

- [ ] Can the app's primary screens be answered by filtering and sorting **short
      scalar fields**? (If yes, the fast path covers you.)
- [ ] Is long text searched rather than filtered? (Full-text index, not summary.)
- [ ] Does the data model tolerate append-only growth, or is a sharding strategy
      needed from day one?
- [ ] Can read access be expressed as **key scope** — groups of documents sharing
      a key, or per-document recipient lists?
- [ ] Do users need to work offline, and is eventual convergence acceptable?
- [ ] Is client-side key custody acceptable — including that a lost key means
      unrecoverable data?

---

## 3. The Cost Model You Are Optimizing Against

Two operations dominate every performance question in MindooDB, and they differ
by orders of magnitude.

**Materializing a document** is expensive. It requires the document's entry
metadata, a snapshot payload, and replay of every uncovered change entry — each
verified and decrypted, then applied to an Automerge document. Against a local
store this is acceptable. Against a remote store it is network-bound: a *single*
document materialized in isolation costs roughly two to three HTTP requests.

**Reading the summary buffer** is cheap. It is a RAM-resident map of one compact
entry per live document, scanned linearly. No decryption, no DAG replay, no store
round trip.

The whole architecture follows from that gap:

```
iterateChangesSince (cursor, tombstones)   ← materializes each document ONCE
        │
        ├──────────► DocumentSummaryStore   ← short scalar fields  → db.query(), views
        │
        └──────────► DocumentFullTextIndex  ← tokenized long text  → db.searchText()
```

Both derived indexes pay the materialization cost **once**, incrementally, in the
background, and every subsequent query is answered from the index. Your job as an
application author is to stay on the index side of that boundary.

> **Bulk materialization changes the arithmetic — do not extrapolate from the
> per-document figure.** Two to three requests per document is the cost of an
> *isolated* materialization. A bulk pass does not pay it per document: the sync
> walk's entry metadata is retained and reused instead of re-scanned, and entries
> for a whole window of documents are fetched in one call, paged against a byte
> budget. The prefetch window is enabled by default at 32 documents, so a cold
> pass costs roughly one batched fetch per window plus occasional store-wide
> metadata scans — for a few thousand documents that is on the order of low
> hundreds of requests, not thousands. The unbatched shape (which is what
> "2–3 × N" would predict) is the problem [Bulk
> Materialization](bulk-materialization.md) was written to eliminate. Note that
> the repository contains scale tests for batching behavior but no published
> benchmark at five-figure document counts, so treat the magnitude as a design
> target rather than a measured number.

> **The two derived indexes are independent.** The full-text index does not read
> from the summary buffer; it consumes the changefeed itself, with its own
> cursor, its own persistence, and its own configuration in the same `dbsetup`
> document. A combined query (`filter` + `text`) uses both.

---

## 4. Querying: Summary-First

### 4.1 Query the summary buffer; materialize only what you display

Use `db.query()` for filtering, sorting, paging, and counting. Use
`db.queryView()` when you also need categorization and totals, and
`db.queryLive()` when the result must stay current. Reach for
`db.getDocument()` only when the user opens one specific document.

```typescript
// List / search / dashboard — no document is loaded or decrypted
const result = await db.query({
  filter: v.and(
    v.eq(v.field("type"), v.string("invoice")),
    v.gt(v.toNumber(v.field("total")), v.number(100)),
  ),
  sortBy: [{ field: "total", direction: "descending" }],
  limit: 50,
});
// result.rows[i].docId / .fields / .lastModified, result.total, result.coverage

// Only now, when the user actually opens one:
const doc = await db.getDocument(result.rows[0].docId);
```

The anti-pattern is loading documents to decide which ones you wanted:

```typescript
// DO NOT DO THIS — materializes the whole database to filter in JS
for await (const { doc } of db.iterateChangesSince(null)) {
  if (doc.getData().type === "invoice") rows.push(doc);
}
```

**When to break the rule.** `allowFullScan: true` bypasses the summary and
materializes everything. It is the correct choice for one-off administrative or
migration queries, and for queries that must read `decrypt` expressions. It is
documented as expensive by design — never put it behind an interactive control.

**Fetch related documents with `include`, not with a query per row.** The second
shape of the same anti-pattern is running one query per result row to pick up the
related records — an invoice list that queries its line items per invoice turns
one cheap scan into N of them. An `include` clause joins them in the same call,
and the engine answers each slot with ONE additional summary scan regardless of
how many rows it decorates:

```typescript
const result = await invoicesDb.query({
  filter: v.eq(v.field("type"), v.string("invoice")),
  fields: ["total"],             // `customerId` is joined on but not projected
  limit: 50,
  include: {
    customer: {
      db: customersDb,           // another database — needs a handle
      cardinality: "one",        // → a row or null
      localKey: "customerId",    // this invoice's field holds the customer's id
      fields: ["name"],
    },
    lines: {
      // No `db`: the slot is scanned in the database this query runs against,
      // which is where the line items of an invoice live.
      cardinality: "many",       // → an array, possibly empty, never null
      filter: v.eq(v.field("invoiceId"), v.parentDocId()),
      sortBy: [{ field: "position", direction: "ascending" }],
    },
    contracts: {
      // Joined on a shared field rather than on an id: inside an include
      // filter, `v.field(...)` reads the contract, `v.parent(...)` the invoice.
      db: contractsDb,
      cardinality: "many",
      filter: v.eq(v.field("customerId"), v.parent("customerId")),
      fields: ["title", "validUntil"],
    },
  },
});
result.rows[0].includes?.customer?.fields.name;
result.rows[0].includes?.lines.length;
```

What the shape of that API is protecting:

- **The join key is what keeps a slot linear.** Exactly one equality may relate
  the related document to the parent row — `v.parentDocId()` for the parent's id,
  `v.parent("<path>")` for one of its fields, with `localKey` as shorthand for
  "this row's field holds the related document's id". Further conditions are
  allowed but must not mention the parent; anything else is rejected rather than
  silently evaluated once per (parent × child) pair.
- **Both sides still have to be summary-covered** ([§4.2](#42-keep-filter-and-sort-fields-summary-coverable)),
  the related document's fields against the joined database's configuration and
  the parent's against this one's. Covered is all they need to be: a join key is
  read from the parent's summary entry, not from `row.fields`, so `localKey` and
  `v.parent(...)` work on fields the query does not project.
- **Cardinality is explicit.** A `"one"` slot that matches several documents
  raises `MindooQueryError` instead of quietly picking the first — that mismatch
  is a data-model bug, and hiding it would make it permanent.
- **Hydration runs after `sortBy` / `limit` / `offset`**, so only the rows you
  actually return are joined and `total` stays the unpaged match count. Slots
  nest up to three levels, and a `"many"` slot returns at most 200 related rows
  per parent unless you set `limit`.
- **`queryLive` watches every database in the tree**, so a change to a joined
  document delivers a new result too.

In a Haven app the same clause travels over the bridge, with one substitution: a
related database is named by its logical `databaseId` instead of a handle, and
the host resolves it under the app's own mapping and `read` capability at every
level ([§8.1](#81-address-databases-by-logical-id-never-by-physical-name)).

See [Ad-hoc Queries, Ephemeral Views and Reactive Updates](adhoc-queries.md).

### 4.2 Keep filter and sort fields summary-coverable

A query is only fast if every field it references is in the summary buffer.
Coverage is governed by the extraction rules, and the defaults are generous:
every **non-underscore** top-level field holding a scalar (or array of scalars)
is auto-included, as long as its JSON-serialized size stays within
`DEFAULT_SUMMARY_MAX_VALUE_BYTES` (1024 bytes).

Design consequences:

- **Keep queryable fields top-level and scalar.** `status`, `type`, `ownerId`,
  `dueDate`, `total` at the document root are covered with zero configuration.
- **Nested or oversized values need an explicit `include` path.** `"meta.owner"`
  is stored under its full dot-path and bypasses the size cap.
- **Never expect encrypted-field plaintext.** Fields following the
  `*_encrypted` / `*_encrypted_key` convention are skipped — their values are
  ciphertext, and the plaintext exists only inside the encrypted payload.
  Queries needing it require `allowFullScan`.
- **Long text belongs in the full-text index, not the summary.** A Markdown body
  or e-mail content would blow the size cap and bloat a RAM-resident structure.
  Search it with a `text` clause instead ([§4.4](#44-use-the-right-index-for-the-right-shape-of-data)).

#### Managed underscore fields

Auto-include skips every key starting with `_`, so the underscore namespace is
reserved for fields MindooDB manages itself. Exactly two get special treatment:

| Field | Covered when | Stored as |
|---|---|---|
| `_attachments` | `includeAttachments` is on (the default) | A slim projection — `attachmentId`, `fileName`, `size`, `mimeType`, `createdAt`, plus a `hasExtractedText` flag. Internal plumbing (`lastChunkId`, `decryptionKeyId`), the creator's full PEM signing key, and extracted OCR text are deliberately dropped. |
| `_encryptFor` | `includeRecipients` is on (the default) | A slim projection of the per-document recipient map, under the same keys the document payload uses, each entry keeping `kind`, `label`, `addedAt`, `removedAt`. The adding/removing users' PEM signing keys and the internal `keyFingerprint` are dropped. |
| `_lastModified` | Always | Mirrored from the summary entry's metadata, so `v.field("_lastModified")` filters and sort keys work with no configuration. |

The attachment projection is what lets attachment expressions —
`v.attachmentNames()`, `v.attachmentCount()`, "has a PDF larger than 5 MB" — run
on the summary path. With `includeAttachments: false` those expressions are
rejected by the coverage guardrails rather than silently returning empty.

The recipient projection makes "which documents are currently shared with X" a
summary query for documents created with per-document recipients
([§5.2](#52-three-ways-to-scope-read-access)): filter or categorize on
`_encryptFor`, checking `removedAt` to skip withdrawn recipients exactly as you
would against a materialized document. Withdrawal is deliberately visible as a
`removedAt` timestamp rather than a vanished key, so both paths answer the same
question the same way. Documents without per-document recipients carry no such
field, so the projection costs nothing for databases that do not use them. For a
single-document check prefer `doc.isEncryptedFor(user)`.

**Changing the selection is safe.** This is the structural difference from HCL
Notes, where summary items live in the document and changing them means
rewriting documents. In MindooDB the field selection is configuration of a
derived local index. Changing it never touches a document; it triggers a
resumable backfill, and the previous state keeps serving queries while that runs.

Configure it per database through the synced `dbsetup` document so every replica
agrees:

```typescript
await db.setSummarySetup({
  include: ["meta.owner"],   // nested path, bypasses the size cap
  exclude: ["draftBody"],    // wins over everything, covers nested paths
});
```

### 4.3 Treat `coverage` as a UI state, not an error

Every query result carries `coverage`:

| Value | Meaning | What the UI should do |
|---|---|---|
| `"full"` | The summary reflects the current configuration for all documents. | Nothing. |
| `"rebuilding"` | A backfill or catch-up is in progress; results may be incomplete and will improve on their own. | Show a subtle "indexing" hint. Do not block, do not error. |
| `"full-scan"` | The query ran via `allowFullScan` and materialized documents. | Expect it to be slow; never on an interactive path. |

**Sync completing does not guarantee the summary is complete.** Haven activates
the summary store *before* pulling, precisely so its auto-follow extracts entries
batch by batch while the sync run proceeds — so in practice the buffer is usually
well advanced by the time a sync finishes. But nothing awaits it: catch-up is
fire-and-forget, and the warmer the Sync page starts afterwards fills the
document cache, not the summary. (The one place a summary build *is* awaited is
the time-travel launch warming path, which pins a cutoff and prepares its
snapshot before handing the app a session.) So a first launch against a large
database legitimately reports `"rebuilding"`, and applications that treat it as
failure show spurious errors on exactly the launch where the user is least
patient.

When a query carries a `text` clause, coverage is the minimum of the summary and
full-text states.

### 4.4 Use the right index for the right shape of data

| Data shape | Index | API |
|---|---|---|
| Short scalars — status, type, owner, dates, amounts | Summary buffer | `db.query()`, `db.queryView()`, `db.queryLive()` |
| Long text — Markdown bodies, mail, rich text, extracted attachment text | Full-text index | `db.searchText()`, or a `text` clause inside `db.query()` |
| Both at once | Both | `db.query({ text, filter, sortBy })` |

The summary buffer is on by default; the full-text index is **opt-in**
(`enabled: false`) because it costs indexing time and memory, so enable it only
for databases whose apps actually search. A `text` clause against a database
without an enabled index throws `MindooQueryError` with code
`"fulltext-not-enabled"` — catch that code and hide the search UI rather than
surfacing a raw error. See [Full-Text Search](fulltext-search.md).

### 4.5 Let the derived indexes warm up in the background

Index catch-up is automatic and non-blocking. After every coalesced change event
— including the single ingest event a sync batch emits when it completes — an
active summary buffer and full-text index schedule a background catch-up. Errors
are logged and never propagate into your write or sync path.

Practices that follow:

- **Do not build your own document-scanning index** for something the built-ins
  already cover. You would pay the materialization cost a second time.
- **Leave `autoIndexing` at its default (`true`).** Setting it to `false` on
  `openDB` disables both catch-up passes; it exists for hosts that cannot afford
  the walk at all, at the cost of the indexes that make a database feel fast.
- **Activate the summary deliberately for a database you will query.** Auto-
  activation happens when the `dbsetup` document carries a `summarySetup` field;
  otherwise the store is created lazily on the first `db.query()`. Instantiating
  it *before* a large pull — as Haven does — lets extraction ride along with the
  sync instead of starting from scratch afterwards. System databases
  (`directory`, `userdirectory`) are excluded.

### 4.6 Keep virtual views on the summary path

Persistent [Virtual Views](virtualview.md) resolve summary-first and fall back to
materialized documents only when the definition forces it. The fallback is
correct but expensive, so know what triggers it:

- `useFullDocuments: true` or `includeAllDocumentFields: true`
- a JavaScript `filter` function instead of an expression
- a column with a JavaScript `valueFunction` instead of an expression
- an expression requiring `decrypt` or view-tree context
- a referenced field outside the summary coverage

The first four are choices. Prefer the declarative expression language — built
with `createViewLanguage()` or parsed from formula text — over JavaScript
callbacks. Expressions keep the view on the fast path, and because they are plain
JSON data they can also be stored, transmitted, and evaluated safely, which is
what lets Haven hand a view definition to a sandboxed app.

---

## 5. Read Access Is Encryption, Not Filtering

### 5.1 Why this is different, and why it matters

Most systems enforce read access *above* the data. In a MongoDB application it is
typically the application's job: every query gets extra filter clauses, and the
data is safe exactly as long as no code path forgets one. In HCL Notes/Domino it
is the engine's job: reader fields are evaluated per document and the engine skips
documents that do not list the current user — safe, but the cost is borne at read
time, and a user entitled to a small slice of a large database pays for scanning
past everything else.

MindooDB does neither. **A document a user may not read is ciphertext to that
user.** There is no read-rule subsystem and no per-entry server-side read
evaluator; readability is decided by whether the reader's KeyBag holds a key that
decrypts the document. Three consequences follow, and they are the reason to
prefer this model:

- **There is no filter to forget.** A missing predicate cannot leak a document,
  because the bytes are unreadable without the key. The failure mode of the
  application-enforced model does not exist here.
- **Cost does not scale with what you cannot see.** Access is not re-evaluated
  per document per read. A client simply never obtains a usable plaintext for
  documents outside its key scope.
- **The guarantee survives a compromised server.** Server-side enforcement
  protects data only while the server is honest and unbreached. Encryption-based
  read access holds even against a full server compromise, which yields
  ciphertext and public keys.

**Where the responsibility moves.** The cost of this model is key management:
distributing keys to the right people, rotating them when someone leaves, and
accepting that a lost key means unrecoverable data. Admin-signed key-distribution
documents automate most of it — clients reconcile their KeyBag against the
directory on bring-up and after every sync, importing keys they are entitled to
and dropping keys revoked from them — but it is real operational surface, and it
is where design attention belongs.

### 5.2 Three ways to scope read access

| Mechanism | Key | Use it for |
|---|---|---|
| **Tenant default key** | One AES key shared with all tenant members | Data everyone in the tenant may read. The default when no key is specified. |
| **Named keys** | A key you create and distribute to specific users or groups | Stable, organizational access scopes — a department, a project, a sensitivity tier. The workhorse for "not everyone may read this". |
| **Per-document sealed keys (dynamic recipients)** | A freshly generated per-document key, wrapped to each recipient's user key | Case-by-case recipient lists that are not known in advance — one contract visible to three named people. Created with `createDocument({ recipients: [...] })`; the recipient set lives in `_encryptFor` and `doc.isEncryptedFor(user)` answers per document. Recipients are individual people, not directory groups, so the set stays explicit. |

Removing a recipient triggers key rotation for the remaining ones, so the
withdrawal is cryptographic rather than advisory. See
[User Keys](userkeys.md) and
[Access Control Patterns](usecases/access-control-patterns.md).

### 5.3 Design read access as key scope, not as a query predicate

The practical shape of a MindooDB data model is that **documents sharing a read
audience share a key**, and often a database. Practices:

- **Decide the key when you create the document**, not when you read it. Choose
  the tenant default, a named key, or a recipient list at `createDocument` time.
- **Prefer a separate database over a filter** when a whole class of data has a
  different audience. It scopes keys, sync, and app mappings in one move — and it
  is the only way to genuinely narrow what an app can reach
  ([§8.3](#83-view-sharing-can-confine-an-app-to-columns)).
- **Do not treat listing behavior as an access control.** A client does not list
  documents it cannot decrypt, and the server withholds entries for keys revoked
  from a user — but those are consequences of key possession and delivery, not a
  separate authorization layer. The boundary is the key.
- **Remember that write access is a separate mechanism.** Encryption governs
  reading; anyone who can read a database can also change it unless admin-signed
  write policies say otherwise. There is also a database-level read/sync gate
  that decides who may open and sync a database at all, woven into sync so a
  revoked user stops receiving updates and can no longer open their local copy.
  See [Access Control & Governance](accesscontrol.md).

---

## 6. Living With Append-Only Storage

### 6.1 Model documents as state, not as your own log

The store is already an immutable log. Adding an application-level event log
inside a document duplicates it, and every append rewrites a growing array. Let
documents hold current state and let the entry chain be the history.

### 6.2 Write patches, not whole-document rewrites

Every change becomes a new immutable entry. A change that rewrites the whole
document payload costs proportionally more storage than one that touches a field,
and — more importantly — it merges worse: two clients rewriting the same object
concurrently produce a coarse conflict where two field-level changes would have
merged cleanly.

Mutate exactly what changed inside `changeDoc`:

```typescript
await db.changeDoc(doc, (d) => {
  d.getData().status = "approved";   // one field
});
```

For text, use the granular text APIs so concurrent typing merges character by
character. For lists, use list insert/delete operations so concurrent inserts
interleave instead of one overwriting the other. Apps built on the App SDK get
the same guarantees through its patch flavors (field set/unset, granular JSON
patches, text patches, rich-text patches), each carrying the `baseHeads` the app
composed against.

### 6.3 Plan for growth before you need to

Data accumulates and cannot be removed from the primary store by ordinary
operation. Decide on a strategy while the schema is still cheap to change:

- **Time-based sharding** — `crm2025`, `crm2026`; archive or sync old shards less
  often.
- **Category-based splitting** — `invoices`, `customers`, `products` as separate
  databases, which also simplifies access control and key scoping.
- **CRDT snapshots** to stop long histories from slowing materialization.
- **Coordinated purge** for erasure obligations ([§6.5](#65-deletion-is-a-tombstone-and-that-is-recoverable)).

Planning shards up front is cheaper, but a database that outgrew its store does
not have to stay that way. **Within the same tenant you can split it after the
fact.** `copyDocumentsTo()` copies selected documents — including their full
change history and the original authors' signatures — into another database of
that tenant. Because source and target share the tenant, encryption does not
have to be opened: the transfer is a `ContentAddressedStore` copy of ciphertext
entries (a *graft*). An operator who cannot read a single document can still
reshard. That keeps "administer the data" and "read the data" as separate
privileges. Crossing a tenant boundary, or changing the document key, is a
different path: it must decrypt and re-author. See [Data Modeling
Patterns](usecases/data-modeling-patterns.md) and [Document Copy &
Sharding](document-copy.md).

**Sharding pairs well with Haven Enterprise sync policies.** A sync setup policy
is an admin-signed directory document that tells clients which databases to seed
on their Sync page, in one of two modes: `initial` seeds the configuration once
and leaves the user free to change it, while `permanent` forces bidirectional sync
and prevents the user from turning it off (until they are added to the policy's
`pullfrom` list, which releases the lock without unseeding). Combined with
time-based shards this is how you approximate a **sliding window of local data**:
pin the current shard as permanent, and rotate which shard is pinned as time
moves on. Be aware of the limit — a policy selects *whole databases*. There is no
policy field for "recent records only", no date range, and no partial changefeed
scope, so the window has to come from how you shard, not from the policy itself.

### 6.4 History is free — use it

Because nothing is overwritten, capabilities that are projects elsewhere are
already present: point-in-time reads, full authorship-attributed history, and
opening an entire database read-only as of a cutoff
(`tenant.openDB(id, { timeTravelDate })`). A time-travel instance keeps its own
summary buffer filtered to the cutoff, so queries and views work against it
unchanged. Build audit and "what did this look like last Tuesday" features on
these APIs instead of maintaining your own version tables. See [Time
Travel](timetravel.md).

### 6.5 Deletion is a tombstone — and that is recoverable

Deleting marks a document deleted; the history remains. Two things follow.

**Deletion is reversible.** `undeleteDocument(docId)` brings a tombstoned
document back with its body intact, and `canUndelete()` lets a UI offer the
action only where it will succeed. (For documents with a custom id,
`createDocument({ id })` on a tombstoned id undeletes it rather than failing.)
The only requirement is that the history is still in the store — which is exactly
what purging removes, so a purged document cannot be undeleted. Offering undelete
is usually a better product decision than a confirmation dialog.

**Derived state must observe deletions.** Any index you maintain has to see
tombstones explicitly, or deleted documents linger in it. The changefeed yields
them for exactly this reason — lightweight entries whose body is never
materialized:

```typescript
for await (const { doc, cursor: next } of db.iterateChangesSince(cursor)) {
  if (doc.isDeleted()) myIndex.remove(doc.getId());
  else myIndex.update(doc);
  cursor = next;          // persist this checkpoint
}
```

Documents that became inaccessible through key revocation surface the same way,
so a client that lost a key drops the data from its derived state instead of
serving stale plaintext.

**When erasure is genuinely required, purge is the deliberate escape hatch.** An
administrator signs a purge request naming specific document ids; it lands in the
directory as an ordinary admin-signed document and propagates with the directory
to every client, which then purges the named documents' complete history from its
local store. The server purges its own copies and records the ids in a purged-doc
registry so a re-push of the same data is rejected — that part is enforced, not
advisory. Client-side execution is cooperative, so a replica that never syncs
again keeps what it has, and the purge request itself stays in the directory as
the audit record of what was erased and by whom. Treat purge as a compliance
operation with a paper trail, never as routine cleanup: it is the one place where
append-only integrity is intentionally broken for a document, and it is
irreversible. See [Compliance Patterns](usecases/compliance-patterns.md).

---

## 7. Local-First, Offline, and Collaboration

### 7.1 Never block the UI on sync

Reads hit the local replica. Writes land locally and are visible immediately.
Sync moves entries in the background. An interface that shows a spinner while
saving, or refuses to open a screen until sync completes, throws away the main
benefit of the architecture and behaves worse than a server-backed app on a bad
connection.

Design for it: render from local state, treat sync status as ambient information
rather than a modal gate, and expect convergence to arrive as an update. Sync is
also transactional per database — a failed run leaves the database as it was, so
a failure is a retry, not a repair.

### 7.2 Sync a local replica; do not work against a remote store

Opening a database directly against a remote server through
`ClientNetworkContentAddressedStore` is supported and occasionally useful — for
an admin tool, a one-off inspection, or a script that touches a handful of
documents. **It is the wrong foundation for an application.**

The reason is that nothing about remote access removes the client-side work. The
server cannot query, so the summary buffer and full-text index still have to be
built *on the client*, from remote data — which means the changefeed walk that
feeds them pulls what it needs over HTTP. Even with bulk materialization keeping
the request count bounded, you are paying network latency and rate limits for
work that against a local replica is local I/O.

So: sync a local replica first, then run everything against it. Remote-mode
databases exist for reach, not for throughput. The `autoIndexing: false` option
exists precisely for hosts that must open a remote database without triggering
those passes — which tells you what the passes cost there, and that turning them
off costs you the indexes that make a database feel fast.

The same preference applies inside virtual views: a view source can read from a
local replica or pull live from the server. Default to local replica sources and
switch individual ones to live only where freshness genuinely outranks speed.

### 7.3 Make writes optimistic, but handle authoritative rejection

Write access control evaluates locally at the call site and throws
`AccessDeniedError` before persisting, which is what lets you show a meaningful
message instead of an optimistic write that silently vanishes later. Use the
non-throwing `canCreate()` / `canChange()` / `canDelete()` helpers to disable
actions in the UI.

Treat this as UX, not security. The local precheck fails open and is bypassable;
the server witness and the quarantine-on-materialization path stay authoritative.
An entry that violates an identity rule cannot be witnessed and therefore cannot
propagate, and a content-rule violation is quarantined by every honest receiver.

### 7.4 Design for the offline clock

An offline client controls its own clock, so `createdAt` is a claim, not a fact.
Anything auditable must key off **trusted time** — the `receivedAt` from the
witness receipt an entry gets on first push. When you need to answer "was this
allowed when it actually entered the tenant?", use the time-travel-aware
authorization query rather than comparing timestamps yourself. See [Access
Control & Governance](accesscontrol.md).

### 7.5 Know what "live" means here, and design to it

MindooDB is a near-live collaboration system, not a sub-second one, and the
distinction is worth designing around rather than papering over.

**The transport is Server-Sent Events.** A client keeps one long-lived SSE
subscription to the server's change feed per database; when entries land on the
server, subscribers are notified and pull. Haven debounces that pull by roughly
two seconds. Outbound, Haven has an **auto-push toggle** ("Auto-push changes to
servers") on the Sync page which pushes locally saved documents on a similar
short debounce instead of waiting for the next manual sync. Enabling it on both
sides is what turns two clients into a collaborative pair. There are no
WebSockets in this path.

**What an app can subscribe to.** Through the App SDK bridge, two mechanisms push
updates:

| Mechanism | API | Scope |
|---|---|---|
| View updates | `navigator.onDidUpdate(listener)` | A live-bound virtual view, across all its source databases |
| Live queries | `db.documents.liveQuery(query, onResult)` | One database, shaped by the query; the host fingerprints results so only real changes are delivered |

There is deliberately no session-wide "some database changed" event: both
mechanisms are scoped to something the app has already declared an interest in.
For derived state that needs deletions and a durable checkpoint, page the
changefeed yourself instead. Dispose subscriptions when their UI unmounts.

**Set expectations accordingly.** A few seconds of propagation is fine for
task boards, records, dashboards, and documents; it is not a shared cursor in a
real-time editor. What you get in exchange is the property no
always-connected design offers: every client works fully offline against its own
replica, and Automerge merges the divergent histories into one consistent state
when they reconnect — without a conflict dialog, and without the last writer
silently winning. Design the collaborative story around *convergence*, not around
latency, and the architecture is working with you.

---

## 8. Building Apps for Haven

Applications built on the App SDK run in a sandboxed iframe on a separate origin
and reach data only through Haven's bridge. Two configuration mechanisms decide
what they see.

### 8.1 Address databases by logical id, never by physical name

An app registration maps each database the app may see to a **logical database
id** that the app addresses. Haven resolves that id to a concrete target —
tenant, database name, local replica or a specific server connection — at launch.
The app receives only the logical id in its launch context.

**This is structural, not a convention to follow.** The logical id is the only
handle the bridge accepts. `session.listDatabases()` returns logical ids,
`session.openDatabase(databaseId)` takes one, and every `documents.*` and
`database.*` RPC carries one; the host resolves it against the session's bindings
and answers `database-not-found` for anything else. No RPC accepts a tenant plus a
physical database name, so an app cannot address a database it was not mapped —
by accident or on purpose. The indirection is enforced by the protocol surface.

That is what makes an app portable. Repointing it from a development database to
production, or onto a different tenant, is an edit to the mapping; the app's code
does not change. Two mappings in one registration may target different tenants or
different servers, so a single app can legitimately work across organizational
boundaries. A mapping can also resolve its database name from a **pattern** plus
a launch parameter, which is how one registration serves a family of databases.

The discipline that remains is one level up — not hardcoding the *logical* id
either:

- **Read the logical ids from the launch context rather than embedding string
  literals.** An app that hardcodes `"invoices"` still breaks when an
  administrator names the mapping something else, and cannot serve a
  pattern-mapped family of databases at all.
- **Use `preferredDatabaseId` as a hint for initial selection.** It comes from
  the registration's default launch database. Haven does not open anything on
  your behalf.
- **Do not assume a fixed set of databases.** Enumerate what you were granted.

### 8.2 Check capabilities and degrade the UI

Each mapping carries capabilities. The complete set is `read`, `create`,
`update`, `delete`, `history`, `attachments`, `views`, `sign`, `timestamps`,
`directory`, and `sealedchannel`. Note that there is **no `read` permission to
grant or withhold** — mapping a database always grants `read`, and the admin
toggles control everything above it.

Enforcement is in the Haven bridge host, which checks every request against the
registration. The SDK does not enforce — checking capabilities client-side is
about presenting an honest UI, not about security:

```typescript
if (!db.capabilities.includes("delete")) hideDeleteButton();
if (db.capabilities.includes("history")) showHistoryTab();
```

Start a new registration with read-only access to a single database, get the app
working, then widen. Adding write access later is easy; withdrawing it after
users depend on it is not.

### 8.3 View sharing can confine an app to columns

A registration can attach virtual views, and the navigator API exposes computed
column values, category values, and a `docId` per entry — never document bodies.
Sharing a view rather than a database is a genuine narrowing: the app sees the
columns an administrator chose. Reporting and dashboard apps should prefer this
— it keeps them on the summary-backed fast path and spares them the document
schema.

A view source still needs a mapping so Haven knows which physical database to
open and keep live. When that mapping exists only to feed the view, it is marked
`viewOnly`. Then:

- Haven still opens the database to build and update the view.
- `launchContext.databases`, `session.listDatabases`, and `session.openDatabase`
  omit it.
- Every document, query, and attachment RPC that names its logical id fails with
  `database-not-found` — the same error as an unmapped id, including RPCs added
  later. The app also cannot create its own views against that id
  (`session.createViewNavigator`); only views defined in the registration can
  read it.
- Importing a saved view creates these mappings automatically for sources that
  are not already shared with the app. An administrator can later uncheck
  **View only** on the mapping to share the full database. Removing the last
  view that uses the mapping does not clear the flag.

If the same logical id also has a normal (not `viewOnly`) mapping, the app can
read documents, as before. Existing registrations that already mapped a database
to make a view work keep document access until someone marks that mapping
view-only or recreates it by importing the view.

View entries still carry the real `docId`. That is load-bearing for selection and
for opening a document when the app *does* have a mapping. With only a view-only
source the id cannot be resolved to a body.

Use **encryption keys** when a boundary must hold even against a user who also
has a database mapping
([§5](#5-read-access-is-encryption-not-filtering)).

### 8.4 Expect read-only launches

A registration pinned to a time-travel date serves every mapped database, view,
document, and attachment as of that instant, and the bridge rejects every write
with a `forbidden` error. Apps that assume writes always succeed break in this
mode. Check `timeTravelDate` in the launch context and present a read-only UI
when it is set — the same app then works for audit, retrospective, and
regression-debugging launches without any time-travel code of its own.

App-defined views (`createViewNavigator`) require the `views` capability on every
database they reference, and can only span databases already mapped to the app.

---

## 9. Semantics and Invariants

Precise behavior for reviewers and platform engineers. These are the guarantees
the practices above rely on.

### Index catch-up trigger chain

```
local write  ──┐
               ├─► change notification ─► coalesced event ─► background catch-up
sync ingest  ──┘   (sync holds the batch and emits one event on completion)
                                              │
                                              ├─► DocumentSummaryStore.update()
                                              └─► DocumentFullTextIndex.update()
```

Both passes consume `iterateChangesSince(cursor)` independently, with their own
cursors and their own persisted state. Catch-up is fire-and-forget: concurrent
requests coalesce, and failures are logged without propagating to the caller.

Two consequences worth stating explicitly, because they are easy to assume
otherwise:

- Extraction is **not** inline in the sync path, and no sync API awaits it. A
  host can arrange for extraction to overlap a sync run by activating the summary
  store before pulling (Haven does), but completion is still not guaranteed when
  sync returns.
- Building the summary **does** materialize documents — that is the cost the
  buffer exists to amortize. The saving is that it happens once per change, in
  the background, rather than once per query.

### What survives a restart

The summary buffer and full-text index persist through the tenant's local cache
store, encrypted at rest, separately from the content-addressed document store.
A restart restores pre-extracted entries without re-materializing documents.
Cursor-based resume means a derived index never misses or double-processes a
document update across restarts — the property custom indexers depend on.

### Coverage and configuration changes

A summary configuration change is detected through a persisted fingerprint and
triggers a resumable backfill: the changefeed is re-consumed from the beginning
under the new extraction rules, interruptible and progress-reported. The previous
state keeps serving queries throughout, and results report `"rebuilding"`.
Documents are never rewritten by a configuration change.

### Cost constants

Useful when reasoning about a cold open or tuning a large deployment.

| Constant | Default | Why it matters |
|---|---|---|
| Auto-included summary value size cap | 1024 bytes | Above this a scalar field is not auto-covered; needs an explicit `include`. |
| Summary cache buckets | 64 | Persistence granularity. |
| Summary update batch | 100 documents | Interruption granularity of a catch-up pass. |
| L1 document cache | 128 documents | Materialized documents held in memory. |
| Changefeed prefetch window | 32 documents | Batched materialization look-ahead; `0` disables batching. Capped at half the L1 cache so a window cannot evict itself. |
| Materialization page budget | 8 MiB ciphertext | Bounds peak memory and response size per batched fetch. |
| Live sync / auto-push debounce | ~2 seconds | The floor on perceived collaboration latency. |
| Server sync rate limit (reference server) | 1000 requests/min | The ceiling an unbatched materialization pass would hit. |

### Protocol guarantees you can rely on

Completeness (after a full sync cycle the client has metadata awareness of every
remote entry), idempotency (every endpoint tolerates repetition), order
independence (entries may arrive in any sequence; CRDTs converge), and
deduplication (identical entries from multiple sources are stored once). These
hold across every deployment topology. See [Network Sync
Protocol](network-sync-protocol.md).

---

## 10. Review Checklists

### Application developer

- [ ] Lists, filters, sorts, and counts go through `db.query()` / `db.queryView()`,
      not through a document scan.
- [ ] `db.getDocument()` is called only for documents the user actually opens.
- [ ] Related records come from an `include` clause, not from a query per result
      row.
- [ ] Every field used in a filter or sort is summary-covered (top-level scalar,
      or an explicit `include` path).
- [ ] `coverage: "rebuilding"` renders as a hint, not an error.
- [ ] `"fulltext-not-enabled"` is caught and hides the search UI.
- [ ] Writes mutate individual fields inside `changeDoc`, not whole payloads.
- [ ] Derived indexes observe tombstones and persist their cursor.
- [ ] Deleted documents can be restored where that makes product sense.
- [ ] No UI path blocks on sync completion.
- [ ] Live subscriptions are disposed when their UI unmounts.

### Platform / architecture review

- [ ] Application work runs against a synced local replica, not a remote store.
- [ ] A growth strategy exists — sharding, snapshots, or a documented retention
      decision; sync policies pin the shards clients must hold.
- [ ] Read audiences are expressed as key scope (default / named / per-document
      recipients), and ideally as separate databases.
- [ ] Virtual views avoid JavaScript filters and value functions on hot paths.
- [ ] `allowFullScan` and `useFullDocuments` appear only on administrative paths.
- [ ] `autoIndexing` is left enabled, or its cost is documented where disabled.
- [ ] Databases that will be queried carry a `summarySetup` in `dbsetup`, and the
      summary store is activated before large pulls.
- [ ] Auditable logic keys off trusted time, never client `createdAt`.
- [ ] Erasure obligations have a purge procedure; everything else uses tombstones.
- [ ] Collaboration expectations are set around convergence, not latency.

### Haven app review

- [ ] Logical database ids come from the launch context, not from string literals
      in the app. (Addressing a *physical* database is already impossible — the
      bridge accepts nothing but logical ids.)
- [ ] Capabilities are checked and the UI degrades accordingly.
- [ ] The app tolerates a time-travel (read-only) launch.
- [ ] The registration grants the narrowest capability set that works.
- [ ] Views that must not expose documents use view-only mappings (created
      automatically on view import). `documents.get` on those logical ids must
      fail — see
      [§8.3](#83-view-sharing-can-confine-an-app-to-columns).

---

## Related Documentation

- [Ad-hoc Queries, Ephemeral Views and Reactive Updates](adhoc-queries.md) — the
  summary buffer, `db.query()`, ephemeral views, live queries
- [Full-Text Search](fulltext-search.md) — the second derived index and the
  `text` clause
- [Virtual Views](virtualview.md) — persistent views, summary-first resolution
- [Data Indexing](dataindexing.md) — `iterateChangesSince()` and custom indexers
- [DB Open and Sync Optimization](db-open-and-sync-optimization.md) — causal
  planning, metadata-first open, dense sync
- [Bulk Materialization](bulk-materialization.md) — how cold passes are batched
- [Time Travel](timetravel.md) — historical reads and time-travel instances
- [Access Control & Governance](accesscontrol.md) — the read/sync gate,
  admin-signed write policies, witness receipts, trusted time
- [User Keys](userkeys.md) — per-person keys, sealed per-document recipients
- [Access Control Patterns](usecases/access-control-patterns.md) — named keys,
  distribution, rotation
- [Compliance Patterns](usecases/compliance-patterns.md) — GDPR erasure and
  coordinated purge
- [Document Copy & Sharding](document-copy.md) — keyless resharding
- [Data Modeling Patterns](usecases/data-modeling-patterns.md) — database layout
  and append-only growth
- [Performance Optimization](usecases/performance-optimization.md) — scaling and
  tuning
- [Network Sync Protocol](network-sync-protocol.md) — endpoint contracts, SSE
  change feed, capability negotiation
- [P2P Sync](p2psync.md) — peer-to-peer and relay topologies
- [Haven Handbook](haven-handbook.md) — app registrations, mappings, capabilities
- [Architecture Specification](specification.md) — the underlying model
