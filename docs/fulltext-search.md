# Full-Text Search

## Overview

MindooDB ships a client-side full-text index — the `DocumentFullTextIndex` —
as a second derived index next to the [document summary store](adhoc-queries.md).
It is fed from the same changefeed, persists encrypted through the same
`LocalCacheStore`, and is configured through the same synced `dbsetup`
document (field `fulltextSetup`, next to `summarySetup`):

```
iterateChangesSince (cursor, tombstones)
        │
        ├──────────► DocumentSummaryStore     ← short scalar fields (RAM, linear scan)
        │
        └──────────► DocumentFullTextIndex    ← tokenized text (MiniSearch engine)
                            │
                            ├───► db.searchText("solar panels")
                            └───► db.query({ text: { query: "solar" }, filter, sortBy })
```

The two indexes divide the work: **short scalar fields** live in the summary
buffer and power filters/sorting; **long text** (Markdown bodies, e-mail
contents, rich-text documents, extracted attachment text) is tokenized into
the full-text index and never bloats the RAM-resident summary. A combined
query (`filter` + `text`) uses both.

Unlike the summary, the full-text index is **opt-in** (`enabled: false` by
default): it costs indexing time and memory, so only databases whose apps
actually search should pay for it.

## Enabling and configuring

```typescript
// Recommended: persist the configuration in the synced dbsetup document.
await db.setFulltextSetup({ enabled: true });

// Read it back (null when not configured):
const config = await db.getFulltextSetup();

// Or configure in code only (detaches from the dbsetup document):
const index = db.getFullTextIndex({ enabled: true, include: ["body", "meta.notes"] });
```

`FulltextConfig` options:

| Option          | Default   | Meaning                                                                                                                                        |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`       | `false`   | Master switch (opt-in).                                                                                                                        |
| `include`       | `[]`      | Dot-separated field paths to index. Empty = **auto mode**: every non-underscore top-level field whose extracted plain text is non-empty.       |
| `attachments`   | `false`   | Extract and index attachment text through registered `AttachmentTextExtractor`s (indexed under the synthetic `_attachments` field).            |
| `language`      | `"und"`   | BCP-47 tag steering the tokenizer (`Intl.Segmenter` locale). Changing it rebuilds the index.                                                   |
| `maxFieldBytes` | `256 KiB` | Per-field cap for extracted text. Longer values are truncated, not skipped.                                                                    |

Because `fulltextSetup` lives in the ordinary `dbsetup` document, the
configuration **syncs across replicas**: enabling full-text on one device
enables it everywhere (each device builds its own local index — see the E2EE
section). The value is sanitized on read, so a malformed document can never
break indexing. A config passed to `getFullTextIndex()` in code always wins
and detaches the index from the document.

Like the summary, a configuration change (fingerprint mismatch) triggers a
**resumable backfill** over the changefeed: the index keeps serving the
growing partial state and reports `coverage: "rebuilding"` until done.
Because tokenization is config-dependent, a config change always starts with
a fresh engine (unlike the summary, which can keep prior entries).

## What gets indexed

Text is extracted from the **materialized document** the changefeed yields
anyway, so all field types are searchable without extra configuration:

- **Plain strings** — including Automerge text fields, which materialize as
  strings. Rich-text block markers (U+FFFC) are normalized to whitespace, so
  TeamEdit's Word-style content and Markdown bodies are searchable as-is.
- **Rich-text span arrays** — `{ type: "text", value }` spans contribute
  their `value`, block spans contribute a word boundary.
- **Nested objects and arrays** — their string content is collected
  recursively (bounded depth), joined with whitespace.
- Numbers, booleans and null are **not** indexed — structured values belong
  in query filters, not the full-text index.
- Encrypted-convention fields (`*_encrypted`, `*_encrypted_key`) are skipped
  in auto mode (they hold ciphertext); an explicit `include` still wins.
- The `dbsetup` document configures the index and never appears in results.

### Attachments

With `attachments: true` **and** registered extractors, attachment text is
indexed under the synthetic `_attachments` field. Hits stay
document-scoped (the Notes model): searching matches the document, not an
individual attachment.

```typescript
db.registerAttachmentTextExtractor({
  supports: (mimeType, fileName) => mimeType === "application/pdf",
  extract: async (bytes, { mimeType, fileName }) => extractPdfText(bytes),
});
```

The host environment provides the extractors: **Haven registers extractors
for plain text/CSV/JSON/Markdown/XML/SVG, PDF (pdf.js), docx, pptx and
xlsx** on every database it opens. The extractor libraries are loaded
lazily — a database without `attachments: true` never pays for them.
Extraction failures are swallowed per attachment (a broken PDF never stalls
the pipeline), oversized attachments (> 16 MiB) are skipped, and the
collected text is capped at `maxFieldBytes` per document.

### Persisted extraction results (OCR and other expensive extraction)

Extractors run **per device** on every (re-)index — fine for cheap formats,
wasteful for OCR. For expensive extraction, persist the result **at the
attachment entry** instead:

```typescript
await db.changeDoc(doc, (d) => {
  d.setAttachmentExtractedText(attachmentId, {
    text: ocrResult,                    // capped at 100k chars; null clears
    engine: "tesseract.js@7:deu+eng",   // lets services detect stale results
    // status defaults to "done"; use { text: null, status: "failed" } or
    // "skipped" to persist a marker that suppresses retries
  });
});
```

The text is stored as optional fields (`extractedText`, `extractionStatus`,
`extractionEngine`, `extractedAt`) on the document's `_attachments` entry,
so it **syncs with the document** — extract once on any device, searchable
everywhere — and disappears together with the attachment on
`removeAttachment()`. `_`-prefixed fields are managed by MindooDB;
`setAttachmentExtractedText()` (changeDoc-only) is the sanctioned write
path.

The index feeds persisted text into the synthetic `_attachments` field
**unconditionally** — no `attachments: true`, no extractors needed (the
text is already there and obviously meant to be searchable). An attachment
with a persisted result or a `failed`/`skipped` marker is skipped by the
registered extractors; attachments without either still go through them
when `attachments: true` is set. The summary buffer never carries the text
itself — the attachment projection only exposes a `hasExtractedText` flag.

Which databases want an extraction service (e.g. Haven's OCR) is
configured next to `summarySetup`/`fulltextSetup` in the synced `dbsetup`
document:

```typescript
await db.setExtractionSetup({
  enabled: true,
  languages: ["deu", "eng"],   // OCR trained-data hint
  mimeTypes: ["image/", "application/pdf"], // optional restriction
});
const setup = await db.getExtractionSetup(); // null when not configured
```

`setExtractionSetup` is idempotent (rewriting an unchanged config produces
no new revision) and `null` removes the configuration.

## Searching

### Standalone: `db.searchText()`

```typescript
const { hits, coverage } = await db.searchText("solar panel", {
  fields: ["body", "title"],   // restrict to index fields (default: all)
  prefix: true,                // "sol" matches "solar" (default: true)
  fuzzy: 0.2,                  // edit-distance tolerance (default: off)
  combineWith: "AND",          // all terms must match (default) | "OR"
  limit: 50,
});
// hits: [{ docId, score }], best score first (BM25-style relevance)
// coverage: "full" | "rebuilding"
```

`searchText` brings the index up to date first (same catch-up semantics as
queries against the summary buffer) and throws when full-text indexing is
not enabled for the database.

### Combined with queries: the `text` clause

```typescript
const result = await db.query({
  text: { query: "solar" },                       // full-text membership + score
  filter: v.eq(v.field("type"), "article"),       // regular summary filter
});
// rows carry textScore; default order (no sortBy): best score first
```

- `text` and `filter` combine as a logical **AND**: a document must match
  the full-text search and pass the filter.
- Every row gains a **`textScore`** (relevance, higher = better). Without an
  explicit `sortBy`, results are ordered best score first; an explicit
  `sortBy` can mix regular keys with the pseudo-key
  `{ special: "textScore", direction: "descending" }`.
- A `text` clause on a database without an enabled full-text index throws a
  `MindooQueryError` with `code: "fulltext-not-enabled"` — there is
  deliberately **no silent full scan** over document bodies.
- Result `coverage` reflects both indexes: `"rebuilding"` while either the
  summary or the full-text index is backfilling.
- `db.queryLive()` supports `text` clauses too; result fingerprints include
  rounded scores, so minor score drift does not spam `onResult`.

### Pre-filtering ephemeral views

Ephemeral summary views (`db.queryView()` / `queryViewAcross()`) accept the
same `text` clause as a **source pre-filter**: only documents matching both
the full-text search and the expression filter feed the view. Categories,
sorting and totals then work over that pre-filtered set as usual:

```typescript
const view = await db.queryView({
  text: { query: "solar" },                     // full-text pre-filter (AND)
  filter: v.eq(v.field("type"), "article"),
  columns: [
    VirtualViewColumn.category("status"),
    VirtualViewColumn.sorted("due", ColumnSorting.ASCENDING),
  ],
});
```

- `resort()` can change or drop the `text` clause along with columns/filter —
  a live search box over a categorized view rebuilds purely in memory.
- With `queryViewAcross()`, a per-source `text` clause replaces the
  definition-level one for that source (same override semantics as `filter`);
  every source database needs full-text indexing enabled.
- Views bound via `bindTo()` stay live: document changes re-evaluate both the
  filter and the full-text membership, so entries enter/leave the view as
  their content starts/stops matching.

#### Match quality in formulas: `_textScore` / `_textScoreRaw`

When a view has a `text` clause, every matching document exposes its
relevance to filter and column expressions as two managed pseudo-fields
(like `_lastModified`):

- **`_textScore`** — normalized **0..1**, relative to the best hit of the
  current search (the top hit is always exactly `1.0`), rounded to 2
  decimals. This is *relative* quality within this result set, not an
  absolute measure — thresholds grade hits against the best match.
- **`_textScoreRaw`** — the engine's raw BM25-style score (unbounded,
  corpus-dependent). Useful for debugging; prefer `_textScore` in formulas.

```typescript
const view = await db.queryView({
  text: { query: "solar" },
  columns: [
    new VirtualViewColumn({
      name: "quality",
      isCategory: true,
      sorting: ColumnSorting.ASCENDING,
      expression: v.ifElse(
        v.gte(v.field("_textScore"), 0.8), "sehr guter Treffer",
        v.gte(v.field("_textScore"), 0.5), "guter Treffer",
        "schlechter Treffer",
      ),
    }),
    VirtualViewColumn.sorted("subject", ColumnSorting.ASCENDING),
  ],
});
```

Update semantics: scores are recomputed on every view update, and a
document whose (rounded) normalized score changed is re-evaluated even when
the document itself is unchanged — a new top hit shifts the normalization
of every other match, and threshold categories move accordingly. The
2-decimal rounding keeps borderline documents from flickering between
categories on minor BM25 drift.

Referencing `_textScore`/`_textScoreRaw` in a view **without** a `text`
clause is a validation error — the fields only exist for full-text
pre-filtered views. For flat, score-ordered result lists (search-result
style) `db.query({ text, sortBy })` remains the better fit; the pseudo-
fields shine when grading matches inside a categorized view.

Classic persistent VirtualViews stay structured and have no full-text
support.

## Cost model

- **Indexing** consumes the changefeed like the summary store: each changed
  document is materialized once, its text extracted and tokenized. The index
  auto-follows sync (coalesced change events, single-flight background runs)
  when enabled, so the first search after a large sync finds the index warm.
- **Activation is automatic**: enabling `fulltextSetup` (locally via
  `setFulltextSetup` or through a synced `dbsetup` change from another
  replica) activates the index immediately and starts a resumable background
  backfill. Databases whose setup document already enables indexing also
  probe it once at open (`initialize()`), so a restarted app warms the index
  without waiting for the first change event or search. System databases
  (directory, admin-only) are excluded from auto-activation.
- **The index lives in RAM** while active (like the summary buffer) and
  persists as an encrypted blob; restarts restore it and resume the cursor —
  no rebuild. `maxFieldBytes` caps the per-field contribution; the format
  version is part of the config fingerprint, so engine upgrades trigger a
  clean rebuild.
- **Search is in-memory** over the loaded engine (MiniSearch, BM25-style
  scoring) — no I/O, no document materialization.

## E2EE implications

The index is built **client-side from decrypted content** — plaintext never
leaves the device, and the persisted index is encrypted at rest through the
tenant's `EncryptedLocalCacheStore` like every other cache.

Two consequences worth designing for:

- **Per-device results**: a device whose KeyBag lacks certain decryption
  keys cannot materialize those documents and therefore indexes (and finds)
  fewer of them. Two users searching the same database may see different
  hits — this mirrors their actual read access.
- **Revocation**: purge paths (`purgeDocument`, key revocation) remove index
  entries immediately, so extracted plaintext tokens never outlive access.

## Internationalization

Tokenization uses **`Intl.Segmenter`** (word granularity) when available —
correct segmentation for CJK and other scripts without word spaces — steered
by the `language` config. Environments without `Intl.Segmenter` (e.g. React
Native/Hermes) fall back to a Unicode letters/digits tokenizer. The
`language` is part of the config fingerprint: changing it rebuilds the index
with the new segmentation.

## Engine

The index runs on **MiniSearch** behind a narrow `SearchEngineAdapter` seam
(`add/remove/search/serialize/load`). Everything engine-specific — including
the serialization format — stays behind that interface, so a future engine
swap (Orama, vector search, …) is a format-version bump that triggers a
rebuild, not an API change. Apps that built their own FlexSearch indexes can
keep them; the core index is the supported path going forward.
