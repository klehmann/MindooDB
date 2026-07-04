# Ad-hoc Queries, Ephemeral Views and Reactive Updates

## Overview

MindooDB's persistent [VirtualViews](virtualview.md) are ideal for stable, long-lived
view designs, but they require documents to be materialized (loaded and decrypted)
to compute column values. For **ad-hoc queries** — "give me all tasks owned by Alice,
sorted by due date" typed into a search UI — materializing every document would be
far too expensive.

This is solved by three layers built on top of the changefeed:

```
iterateChangesSince (cursor, tombstones)
        │
        ▼
DocumentSummaryStore          ← per-document map of queryable field values,
        │                       encrypted persistence, resumable backfill
        ├────────────► db.query()        ad-hoc filter/sort/paging
        ├────────────► db.queryView()    ephemeral VirtualViews, dynamic re-sort
        └────────────► db.queryLive()    live queries (reactive)
db.addChangeListener()        ← coalesced change events feeding live views/queries
```

The key idea: ad-hoc queries **never touch documents** — they only read the summary
buffer. The summary is built once (interruptible, with progress reporting) and then
maintained incrementally from the changefeed.

## The Document Summary Store

The `DocumentSummaryStore` keeps one lightweight entry per live document:

```typescript
{
  docId: string;
  fields: Record<string, unknown>;   // extracted field values
  lastModified: number;
  changeSeq: number;                 // changefeed sequence of the extraction
  decryptionKeyId: string | null;
}
```

### Configuration

```typescript
const summary = db.getSummaryStore({
  autoInclude: true,          // default: all scalar top-level fields
  maxValueBytes: 1024,        // size cap for auto-included values
  include: ["meta.owner"],    // nested/large paths, stored under the dot-path key
  exclude: ["draftBody"],     // wins over everything, covers nested paths
});
```

Passing a config in code is optional — without one, the store follows the synced
`dbsetup` design document (see below).

Extraction rules:

1. **Auto-include** (default on): every non-underscore top-level field whose value is
   a scalar (string/number/boolean/null) or an array of scalars, as long as its
   JSON-serialized size stays within `maxValueBytes`.
2. **`include` paths**: may be nested (`"meta.owner"`), may resolve to non-scalar
   values, and bypass the size cap. Stored under the full dot-path as key.
3. **`exclude` paths**: win over both and also cover all nested paths below them.

Encrypted field values are **never** stored in the summary (they only exist inside
the encrypted document payload); see `allowFullScan` below for queries that need them.

### The "Notes problem" — changing the field selection

In HCL Notes, summary items are part of the document, so changing what is
"summary-searchable" means rewriting documents. In MindooDB the field selection is
**configuration of a derived local index**, not a document attribute:

- Changing the configuration never rewrites documents.
- A configuration change (detected via a persisted fingerprint) triggers a
  **resumable backfill**: the changefeed is re-consumed from the beginning with the
  new extraction rules, interruptible and progress-reported like any view update.
- While the backfill runs, the summary keeps serving the previous state; query
  results carry `coverage: "rebuilding"` so UIs can show a hint.
- With the auto-include default, "forgot to declare a field" is rare in the first
  place — every scalar top-level field is queryable out of the box.

### The `dbsetup` design document

So users and app developers have **one shared place** to configure the summary
fields (e.g. in the Haven UI), the configuration can live in a regular MindooDB
document with the fixed ID **`dbsetup`**, in its **`summarySetup`** field:

```typescript
import { DB_SETUP_DOC_ID, SUMMARY_SETUP_FIELD } from "mindoodb";

await db.setSummarySetup({ include: ["meta.owner"], exclude: ["draftBody"] });
const config = await db.getSummarySetup();   // null when not configured
await db.setSummarySetup(null);              // back to auto-include defaults
```

Behavior:

- **Sync-native**: `dbsetup` is an ordinary document, so the configuration syncs
  between client and server like any other data. Custom-ID documents share seeded
  Automerge ancestry, so replicas that create `dbsetup` independently merge
  cleanly (`setSummarySetup` creates it idempotently).
- **Fallback, not override**: a summary store constructed **without** an explicit
  config (e.g. plain `db.query(...)` / `db.getSummaryStore()`) reads the setup
  document before its first update and follows it from then on. A config passed
  in code always wins and detaches the store from the document.
- **Live via the changefeed**: changes to `dbsetup` — local edits or sync ingest —
  arrive through the same changefeed the summary consumes. A changed
  `summarySetup` triggers the usual resumable backfill, so after sync **every
  replica** re-extracts with the new field selection automatically.
- **Robust**: the `summarySetup` value is sanitized on read (unknown/mistyped
  properties are dropped); a malformed or deleted setup document falls back to
  the default auto-include configuration.
- The `dbsetup` document itself is not indexed into the summary (it configures
  the index instead of appearing in query results); read it via
  `db.getDocument(DB_SETUP_DOC_ID)` when needed.

### Persistence

The summary persists through the tenant's `LocalCacheStore` (and therefore through
the `EncryptedLocalCacheStore` wrapper — entries are encrypted at rest). Entries are
grouped into hash buckets; only dirty buckets are rewritten on flush. The changefeed
cursor, configuration fingerprint and backfill cursor are persisted alongside, so an
app restart restores the summary and continues incrementally instead of rebuilding.

The store registers with the tenant's `CacheManager` like other caches and is
restored lazily on first use. Purge paths (`purgeDocument`, key revocation) also
remove summary entries immediately, so plaintext values never outlive access.

## Ad-hoc queries: `db.query()`

```typescript
import { createViewLanguage } from "mindoodb";

interface Task { type: string; status: string; due: string; owner: string }
const v = createViewLanguage<Task>();

const result = await db.query({
  filter: v.and(
    v.eq(v.field("type"), "task"),
    v.neq(v.field("status"), "done"),
  ),
  sortBy: [{ field: "due", direction: "ascending" }],
  limit: 50,
  offset: 0,
  fields: ["due", "owner"],       // optional projection
});

// result: { rows: [{ docId, fields, lastModified }], total, coverage }
```

The filter IS an expression of the **MindooDB expression language** (the same
language used for declarative view columns) — built with `createViewLanguage()`
or parsed from formula text with `parseMindooDBFormulaBooleanExpression()`. Query
definitions are plain JSON and can be stored or transmitted safely.

Sort keys are either summary field paths or expressions
(`{ expression: v.mul(v.field("amount"), -1) }`).

### Cost model

- `db.query()` first brings the summary up to date (incremental changefeed
  consumption; batching/progress/cancellation options are passed through), then runs
  a **linear in-memory scan** over the summary entries.
- There is deliberately no per-field B-tree/inverted index: for the target scale
  (10k–100k documents) a linear scan over in-memory entries is fast, and it keeps
  every write path cheap (no index amplification).
- The expensive part — document materialization — never happens on this path.

### Guardrails and coverage

`db.query()` fails fast with a `MindooQueryError` instead of silently returning
wrong results:

- A referenced field that is **not covered** by the summary configuration
  (excluded, or nested without an `include`) → error naming the field.
- `decrypt` expressions (see below) → error (encrypted values are not in the
  summary).
- View-tree operations (`childCount`, `descendantCount`, …) → error (they only
  evaluate inside a materialized view; use `db.queryView()` with categories).

### `decrypt` expressions

`decrypt` is not a query option but a **node of the expression language** itself,
written into the filter/sort expression like any other helper:

```typescript
v.decryptField("notes_encrypted")            // plaintext of an encrypted field
v.decryptJson("profile_encrypted", "email")  // path into encrypted JSON
```

(Formula text: `v.decryptField("notes_encrypted")` parses the same way.)

They target MindooDB's **encrypted-field convention**: a field named
`<name>_encrypted` holds a base64 ciphertext, and the optional companion field
`<name>_encrypted_key` names the symmetric key id (default: the tenant key). Both
helpers take an optional key-id expression to override that resolution. Evaluation
yields the decrypted plaintext — or `null` when the field is missing or the key is
not in the current user's KeyBag, so unreadable values behave as absent instead of
failing the query.

Because the summary buffer never stores plaintext of encrypted fields, expressions
containing `decrypt` nodes cannot run on the summary path — `db.query()` rejects
them with a `MindooQueryError` unless `allowFullScan` is set.

### Escape hatch: `allowFullScan`

```typescript
const result = await db.query(
  { filter: v.eq(v.decryptField("ssn_encrypted"), "123-45-6789") },
  { allowFullScan: true, onProgress: ... }
);
// result.coverage === "full-scan"
```

`allowFullScan: true` materializes every document via the changefeed and evaluates
expressions against the full payload. This removes the coverage requirement and
allows `decrypt` expressions — each document's `decrypt` nodes are resolved against
the tenant KeyBag during the scan — but costs a full document scan plus per-document
decryption — **expensive by design**, intended for one-off/administrative queries,
not for UI code paths.

## Ephemeral views: `db.queryView()`

For UI grids that need categories, totals and **dynamic re-sorting**, an ephemeral
VirtualView can be built directly from the summary:

```typescript
const view = await db.queryView({
  filter: v.eq(v.field("type"), "task"),
  columns: [
    VirtualViewColumn.category("status"),
    VirtualViewColumn.sorted("due", ColumnSorting.ASCENDING),
    new VirtualViewColumn({
      name: "priorityScore",
      expression: v.mul(v.field("priority"), 10),   // declarative, JSON-serializable
    }),
  ],
});

view.getView();          // regular VirtualView: navigators, totals, entries
await view.resort({ columns: [...] });   // re-sort over the SAME summary
view.dispose();
```

- Backed by `SummaryVirtualViewDataProvider` — column values come from summary
  fields, no document materialization. Building a view over 10k summary entries is
  a pure in-memory sort.
- Columns use declarative `expression`s instead of JS `valueFunction`s (which are
  rejected — there is no materialized document to pass them). This makes the whole
  view definition JSON-serializable, the basis for view designs stored as data.
- `resort()` swaps in a new column set/filter over the same summary — dynamic
  re-sorting without reloading anything.
- Ephemeral views are not registered with the CacheManager; `dispose()` releases
  them.

The same guardrails as `db.query()` apply (coverage check, no decrypt, no view-tree
operations in filters).

### Cross-database and cross-tenant views: `queryViewAcross()`

Classic persistent VirtualViews can aggregate documents from multiple databases and
tenants by adding one data provider per source. Ephemeral summary views support the
same via the standalone `queryViewAcross()` helper — each source database contributes
entries from its **own** summary buffer under its own origin, still without
materializing a single document:

```typescript
import { queryViewAcross } from "mindoodb";

const view = await queryViewAcross(
  [
    { db: salesDb },                                        // same tenant …
    { db: archiveDb, filter: v.eq(v.field("year"), 2025) }, // … or another tenant
  ],
  {
    filter: v.eq(v.field("type"), "deal"),   // shared filter (per-source filter overrides)
    columns: [
      VirtualViewColumn.category("region"),
      VirtualViewColumn.sorted("amount", ColumnSorting.DESCENDING),
    ],
  }
);
```

- Origins default to `<tenantId>/<storeId>#ephemeral`, so sources from different
  databases/tenants never collide; pass explicit `origin`s to include the same
  database twice (e.g. with different filters).
- A per-source `filter` **replaces** the shared definition filter for that source.
- The guardrails run **per source**: every referenced field must be covered by
  that source's summary configuration.
- `view.bindTo()` subscribes to the change feeds of **all** sources; `resort()`
  rebuilds across all sources and keeps the live binding.
- Since each source reads from its own tenant's summary store, cross-tenant views
  need no key sharing — summaries only ever contain fields the local tenant could
  already read.

## Reactive updates

### Change listeners: `db.addChangeListener()`

```typescript
const unsubscribe = db.addChangeListener((event) => {
  // event.changes: Array<{ docId, isDeleted, lastModified }>
  // event.cursor:  latest changefeed cursor
});
```

- **Hook point** is `updateIndex` — the common choke point of all mutation paths
  (local writes, sync ingest, access flips, witness updates). Identical replays are
  short-circuited before the hook, so listeners only hear about actual changes.
- **Coalescing**: one event per sync batch (`syncStoreChanges` holds emission for
  the whole run), one per event-loop turn for local writes. Batch imports never fire
  per-document.
- Listener errors are caught and logged — they never propagate into write/sync
  paths.
- **No replay guarantee**: the event is a "there is news up to cursor X" signal.
  Consumers needing completeness read `iterateChangesSince(cursor)` from their own
  cursor, which also makes late-registered listeners correct.

### Live views: `view.bindTo(db)` / `view.onDidUpdate()`

```typescript
const view = new VirtualView([...]);
// ... add data provider ...

const offUpdate = view.onDidUpdate(({ addedCount, removedCount }) => {
  rerenderUI();
});
const unbind = view.bindTo(db);   // auto-update on change events
```

- `bindTo` registers a change listener and triggers `view.update()` with coalesced
  scheduling: while an update runs, further events only set a pending flag and one
  follow-up update runs afterwards — no update backlog. Providers are cursor-based
  and idempotent, so the event payload is not inspected.
- `onDidUpdate` fires after every applied change batch (including the intermediate
  batches of interruptible updates) — the hook point for UI re-rendering.
- Ephemeral views support the same: `ephemeralView.bindTo()` (subscribing to all
  source databases); the binding survives `resort()` and is released by
  `dispose()`.

### Live queries: `db.queryLive()`

```typescript
const subscription = db.queryLive(
  { filter: v.eq(v.field("type"), "task") },
  (result) => renderList(result.rows),
);

// later:
await subscription.refresh();   // force re-delivery
subscription.unsubscribe();
```

- Delivers the initial result asynchronously, keeps the summary current via the
  change listener, and re-evaluates the query after every coalesced change event.
- **Result fingerprinting**: `onResult` only fires when the result actually changed
  (docIds + `lastModified` of the matches, in order). Changes to non-matching
  documents cost only the in-memory scan — no UI cycle.
- Re-evaluations are single-flight with a pending flag (no evaluation backlog);
  evaluation errors go to the optional `onError` callback.
- React/Vue hooks (`useQuery`, `useView`) are intentionally left to the app SDK;
  the subscription signature above is the connection point.

## Deliberate non-goals

- **No per-field secondary indexes** (B-tree/inverted): the linear in-memory scan
  is sufficient for the target scale and keeps write paths cheap.
- The `dbsetup` design document intentionally stays **minimal**: one document, one
  `summarySetup` field, last-writer-wins per Automerge merge semantics. There is no
  per-user or per-device configuration layering in this iteration.
- **Full-text search** stays out of scope, but the summary store is a suitable
  future data source for it.
