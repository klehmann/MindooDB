# Copying Documents Between Databases

## Overview

MindooDB can copy a document from one database into another, either collapsed
into a single revision or with its full history intact. The same machinery,
applied to many documents at once, is how you **shard** a database that has
grown too large — split it by period or tenant-defined partition, keep every
signature and every revision, and reclaim the original afterwards.

> **Sharding never needs the encryption keys.** Because entry signatures do not
> bind the database id, a document's whole history can move to another database
> as pure ciphertext: nothing is decrypted, nothing is re-encrypted, nothing is
> re-signed. An infrastructure operator who cannot read a single document can
> still split the database, and the documents arrive still carrying their
> original authors' signatures. Being able to *administer* data and being able
> to *read* it stay separate privileges — see [Sharding is a keyless
> operation](#sharding-is-a-keyless-operation).

Three methods make up the API, all on `MindooDB`:

| Method | Purpose |
| ------------------------ | -------------------------------------------------- |
| `copyDocumentTo()` | Copy one document into another database |
| `canCopyDocumentTo()` | Ask what a copy *would* do, without writing |
| `copyDocumentsTo()` | Copy many documents in one pass (the shard primitive) |

The zero-config call does the safe, obvious thing:

```typescript
// A flattened copy under a fresh document id, authored by the current user.
const result = await sourceDb.copyDocumentTo(docId, targetDb);
console.log(result.targetDocId);
```

## The three strategies

You never choose a strategy directly. You state *what you want* — how much
history, and whether the original authors must survive — and MindooDB resolves
the strategy from that plus the source/target context.

### flatten (the default)

Reads the document's state at head (or at `atTimestamp`) and writes it into the
target as a brand-new document with a single revision. History, original authors
and the CRDT structure are all deliberately left behind.

Flatten always works: any tenant, any key, any document id. It goes entirely
through the public document API, and attachments are re-uploaded so they get
fresh chunk ids in the target.

The payload rides along inside the `doc_create` change (via
`CreateOptions.initialValues`), so a plain flatten costs **one store entry**, no
matter how many revisions the source had. A second entry is added only for
something the create genuinely cannot carry:

| Situation | Entries | Why |
| ----------------------------- | ------- | --------------------------------------------------- |
| `targetDocId: "new"`, no provenance, no attachments | 1 | Payload seeded into `doc_create` |
| Provenance enabled (the default) | 2 | `_provenance` is in the reserved `_` namespace, which `initialValues` will not seed |
| Attachments | 2 | `addAttachmentStream` only works inside `changeDoc` |
| `targetDocId: "same"` or an explicit id | 2 | A caller-provided id is seeded from a hard-coded Automerge change so independent replicas converge on the same hash; baking content into it would diverge that hash per document |

Pass `provenance: false` when flattening a large document set and you do not
need the origin marker — it halves the store entries.

```typescript
const result = await sourceDb.copyDocumentTo(docId, targetDb, {
  mode: "flatten",       // the default
  atTimestamp: cutoff,   // optional: copy the state as of a past moment
});
```

**Caveat — text collapses.** Materializing an Automerge document to plain JS
turns its text fields into ordinary strings. A flattened copy therefore loses
character-level text CRDT structure, and later concurrent edits to those fields
merge as whole-value conflicts rather than per-character. That is usually the
right trade for a fresh document, and it is the reason `mode: "history"` exists.

### graft — the only way to keep the original signers

Copies the original store entries **byte-for-byte**. The original authors'
signatures remain valid because nothing they signed has changed.

This is possible in exactly one configuration, and it is a cryptographic
constraint rather than a policy choice:

- `mode: "history"`,
- source and target in the **same tenant**,
- `targetDocId` resolves to the **same document id**,
- the **same `decryptionKeyId`**,
- source and target are **different databases**.

The reason is `metadataSignature`, which binds an entry's `id`, `docId`,
`decryptionKeyId`, `contentHash` and `createdByPublicKey`. Change any of them
and you need a signature only the original author could produce. Notably it does
**not** bind the database id — which is precisely what makes moving entries to
another database legal, and what makes sharding possible.

Because a graft changes none of those fields, it never has to decrypt, re-encrypt
or re-sign anything: it moves ciphertext. That is what makes sharding a
[keyless operation](#sharding-is-a-keyless-operation).

```typescript
const result = await sourceDb.copyDocumentTo(docId, targetDb, {
  mode: "history",
  targetDocId: "same",
  authorship: "preserve",
});
result.authorshipPreserved; // true
```

Requesting `authorship: "preserve"` where it cannot be honored **throws**. It
never silently downgrades to a re-authored copy, because a caller who asked for
preserved authorship and got something else has an audit problem, not a
convenience problem. Use `canCopyDocumentTo()` to test first.

### replay — full history, re-authored, with verifiable provenance

Carries every historical change so the copy has the same Automerge revision
graph as the source and supports time travel — but re-signs each entry as the
copying user, re-encrypting first when the tenant or key changed. The original
authorship is not lost: it is recorded as a verifiable
[provenance record](#provenance) on every entry.

```typescript
const result = await sourceDb.copyDocumentTo(docId, otherTenantDb, {
  mode: "history",   // authorship defaults to "reauthor"
});
result.strategy;             // "replay"
result.authorshipPreserved;  // false
```

### The authorship matrix

| Same tenant | Same doc id | Same key | Mode | Strategy | Signers |
| ----------- | ----------- | -------- | --------- | -------- | -------------- |
| yes | yes | yes | history | graft | original |
| yes | yes | yes | flatten | flatten | copying user |
| yes | no | yes | history | replay | copying user |
| yes | yes | no | history | replay | copying user |
| no | any | any | history | replay | copying user |
| any | any | any | flatten | flatten | copying user |

Ask before committing:

```typescript
const feasibility = await sourceDb.canCopyDocumentTo(docId, targetDb, {
  mode: "history",
  targetDocId: "same",
  authorship: "preserve",
});

if (!feasibility.allowed) {
  for (const reason of feasibility.reasons) {
    console.log(reason.code, reason.message);
    // e.g. "different_key", "The target uses a different decryptionKeyId…"
  }
}
```

Reason codes are stable and safe to branch on: `different_tenant`,
`different_doc_id`, `different_key`, `flatten_mode`,
`same_database_same_doc_id`, `directory_database`. The tenant directory database
is never a valid copy source or target.

## Provenance

When entries are re-authored, the store-level author becomes the copying user.
Without something extra, that would erase all trace of who actually wrote each
revision. The provenance record puts it back — and does so **verifiably** rather
than as an unbacked assertion, by embedding the source entry's own signed field
projection together with the original author's signature over it.

```typescript
import { verifyEntryProvenance } from "mindoodb";

const verification = await verifyEntryProvenance(entry, subtle);
switch (verification.status) {
  case "verified":     // the named author really signed this payload
  case "unverifiable": // legacy source entry, predates metadataSignature
  case "invalid":      // signature does not match — treat as tampering
  case "absent":       // not a copied entry
}
verification.provenance?.source.createdByPublicKey; // the original author
verification.payloadUnchanged; // see below
```

Three properties are worth understanding:

- **It verifies across tenants.** The check is purely cryptographic, against the
  public key embedded in the record, so it still works where the source author
  is absent from the local directory. It does *not* establish that the key
  belongs to the person it claims to — confirm that against the tenant directory
  in-tenant, or out of band across tenants.
- **It cannot be forged or stripped by a relay.** The record is bound into the
  copy's own `metadataSignature` as a tagged trailing block, so attaching,
  altering or removing it invalidates the entry.
- **`payloadUnchanged` matters.** When true, the copy holds byte-identical
  ciphertext and the verified original signature therefore covers *this* entry's
  payload too. When false (a re-encrypted copy), the provenance still proves the
  named author signed the original payload, but nothing ties that payload to
  this entry's bytes beyond the copying user's own signature.

Provenance chains through copies of copies: the immediate record names the
intermediate database, and its nested `source.provenance` still names the
original. Set `provenance: false` to opt out. A graft gets none — the originals
are right there on the entries.

For a flattened copy, per-change provenance would be meaningless (there is one
change, corresponding to no single source revision), so the origin is recorded
once in the payload as a `_provenance` object instead.

## Attachments

Attachments are carried by default (`includeAttachments: false` to skip). How
depends on whether the copy crosses a store boundary:

- **Different database** — chunk ids are kept exactly as they are and only the
  `docId` metadata field is re-homed. Nothing can collide, since the target has
  never seen those ids, and leaving them alone is what lets the document's
  change bytes replay unmodified: the payload's `lastChunkId` values still
  resolve.
- **Same database, new document id** (duplicating a document in place) — the ids
  *must* be re-prefixed, because the stores implement an id write as
  remove-then-insert, so a verbatim copy would clobber the source's own chunk
  metadata. The copied history keeps referring to the source's chunks (still
  present, identical bytes, so attachment time travel still works) and one
  trailing change re-points the copy's current revision at the chunks it owns.

Two caveats:

- **No cross-database dedup.** Content deduplication is per store. A chunk
  copied into another database is genuinely duplicated storage, which
  `CopyDocumentResult.copiedBytes` reports honestly.
- **Same-tenant, same-key copies do dedup.** Attachment payloads use a
  deterministic IV, so re-encrypting the same chunk under the same key
  reproduces the same ciphertext and `contentHash`. Duplicating a document
  inside one database stores the bytes once.

## Sharding a growing database

A database that keeps growing eventually strains sync, indexing and backup. The
fix is to split it into period-scoped shards, and MindooDB is unusually
well-suited to it: entry signatures do not bind the database id, so an entire
document history can move to a new database with every original signature still
valid.

### Sharding is a keyless operation

This is worth stating plainly, because it is unusual in an end-to-end encrypted
system and it changes who is allowed to run a migration.

A shard is a `graft`, and a graft moves **ciphertext**. It does not decrypt
payloads, does not re-encrypt them, and does not re-sign anything — it copies
the stored bytes and re-homes store-level metadata. Selecting *which* documents
to move reads only store metadata (the document id prefix), so not even the
selection step needs a key. The result is that **the entire operation completes
without a single encrypt or decrypt call**, which the test suite asserts
directly by instrumenting the tenant's crypto methods during a shard.

Two consequences follow:

- **Administering data and reading data are separate privileges.** An
  infrastructure operator, an automated maintenance job, or a hosting provider
  can split a database they have no ability to read. There is a test for exactly
  this: a custodian whose key bag lacks the document key fails to open a single
  document, shards the database successfully anyway, and the documents arrive
  intact — still carrying the *original* author's signature, not the
  custodian's.
- **It scales.** There is no per-entry cryptographic cost, so shard time is
  bounded by I/O rather than by CPU. A multi-gigabyte database costs the same
  per byte as a small one.

The keyless property is specific to the graft path (`mode: "history"` +
`targetDocId: "same"` + `authorship: "preserve"`, within one tenant and under an
unchanged key). Flattening, changing the `decryptionKeyId`, or copying across
tenants all require the keys, because those genuinely have to transform the
content.

### Partition on the document id prefix

Put the shard key in the document id, using the `<prefix>_<base62>` scheme:

```typescript
const doc = await db.createDocument({ idPrefix: "inv202506" });
```

Selection then reads store metadata only — no payload is ever decrypted just to
place a document. Partitioning on an encrypted payload field instead would
forfeit the keyless property described above, since every document would have to
be decrypted merely to decide where it belongs.

Prefixes do not nest. A monthly scheme like `inv202506` cannot be selected a
year at a time via `inv2025`; pass the twelve monthly prefixes instead:

```typescript
const months = Array.from({ length: 12 }, (_, i) =>
  `inv2025${String(i + 1).padStart(2, "0")}`);
await monolith.copyDocumentsTo({ idPrefix: months }, shard2025, shardOptions);
```

Keep the shard key **also as a document field** if you need a scoped write
freeze to be expressible as an access-control rule — Tier 2 rules match on
content, not on the id.

### The shard call

```typescript
const shardOptions = {
  mode: "history",
  targetDocId: "same",
  authorship: "preserve",
} as const;

const result = await monolith.copyDocumentsTo(
  { idPrefix: "inv2025" },
  shard2025,
  { ...shardOptions, onProgress: (p) => console.log(p.phase, p.copiedEntries) },
);

result.copiedDocIds; // successfully copied source ids
result.failed;       // per-document errors; the run does not abort on them
```

Per-document failures are collected rather than fatal, mirroring how
`pushChangesTo` reports `rejectedEntries`. Pass an `AbortSignal` to stop early.

### Online migration: no global downtime

Every produced entry id is deterministic, so a shard pass is **idempotent and
resumable**, and a second pass over a live source transfers only the delta. That
turns a big-bang migration into a convergent loop:

1. **Bulk pass** against the live database. Users keep working; this can take as
   long as it takes.
2. **Repeat** until a pass reports `copiedEntries === 0`. Each pass carries only
   what changed since the last one, so the passes get shorter.
3. **Cutover.** Deny writes to the sharded document set on the source, take one
   final pass (now small), and point clients at the shard.
4. **Reclaim** the source, whenever convenient (see below).

The write freeze in step 3 has a granularity trade-off. A **Tier 1** rule
(`denyDocChange` on the source database, or a deny rule matching identities)
is evaluated by the server witness without decrypting anything, so it is cheap
and unbypassable — but it is database-wide, freezing documents outside the shard
too. A **Tier 2** rule scoped to the shard-key document field freezes exactly the
migrating set and leaves the rest writable, but it is content-based: the witness
cannot evaluate it, so enforcement defers to clients plus
quarantine-on-materialization. Prefer Tier 1 for a short cutover window; reach
for Tier 2 only when a database-wide freeze is unacceptable.

### Access control follows the database, not the document

Rules are keyed by database id, so entries that were legal in the source are not
automatically legal in the shard. This bites hardest with a graft, which carries
the *original* authors' signatures: the witness evaluates Tier 1 against the
**target** `dbid` on push.

MindooDB checks this up front. Before writing anything, a history copy asks the
target's policy about each distinct (signer, operation) pair and refuses with an
actionable message if any would be denied — rather than writing entries the
witness would reject afterwards.

The defaults are permissive: a database with no policy of its own and no
matching rule allows everything, so a shard into a brand-new database just
works. Only when the target sets a baseline `denyDoc*` flag (or a matching deny
rule) do you need to grant the original authors the corresponding rights there.
The alternatives, if you would rather not: copy with `authorship: "reauthor"` so
the entries are signed by the copying user, or pass
`bypassAccessControlPrecheck` for a trusted bulk path (the server witness still
enforces the rules).

Note that the copy engine cannot evaluate Tier 2 (content) rules — a graft never
decrypts anything — so the preflight reports those as undecidable rather than
guessing.

### Reclaiming the source

Copied entries are **provisional until they are re-witnessed**, and a purge is
irreversible, so reclaim only after the shard has been pushed *and witnessed*.
There is no rush: the source can carry the duplicated data for as long as you
like, which is exactly why the purge can be deferred well past cutover.

```typescript
import { buildDocHistoryPurgeRequest } from "mindoodb";

const request = buildDocHistoryPurgeRequest(result, {
  dbId: "monolith",          // the SOURCE database. Never the shard target.
  requestId: "shard-2025-reclaim",
  preparedByPublicKey: adminSigningPublicKey,
  reason: "Reclaim space after sharding 2025 invoices",
});
```

This introduces no new purge machinery; it only shapes the copy result for the
existing pipeline. The admin publishes the request into the directory database
and the server's `executePendingPurges` denylists each document id before
deleting it, so a stale replica cannot re-push into the gap.

The denylist is keyed by **database id**, which is what makes the round trip
safe: purging `monolith` leaves the shard — holding the same document ids under
a different database id — completely untouched.

For a very large shard, split `copiedDocIds` across several requests: the id
list lives inside a single directory document, and idempotency is tracked per
`requestId`. The helper refuses to build a request from a run that had failures,
so re-run the copy until it completes cleanly first.

### Reading the shards back as one

Splitting for writes does not mean splitting for reads. A
[Virtual View](virtualview.md) recombines any number of databases behind one
sorted, categorized result:

```typescript
const view = await VirtualViewFactory.createView()
  .addCategoryColumn("customer")
  .addSortedColumn("date")
  .withDB("2025", shard2025, v.eq(v.field("type"), "invoice"))
  .withDB("2026", shard2026, v.eq(v.field("type"), "invoice"))
  .buildAndUpdate();
```

For an ad-hoc query, `queryViewAcross([{ db: shard2025 }, { db: shard2026 }],
definition)` does the same thing without a persistent view.

This performs well because each source resolves **summary-first**: when the view
can be answered from the document summary buffer, no document is materialized
and no payload is decrypted. Keep that path by using declarative expression
filters — a JS filter function forfeits it and forces the document path for that
source. Verify per origin rather than assuming:

```typescript
view.getDataSourceInfo("2025");
// { source: "summary", fallbackReasons: [] }
// or { source: "documents", fallbackReasons: ["the filter is a JS function …"] }
```

Because resolution is per source, one badly-configured shard degrades only
itself.

## Options reference

Every option is documented in TSDoc on `CopyDocumentOptions`; the highlights:

| Option | Default | Notes |
| ---------------------------- | ---------- | ----------------------------------------------- |
| `mode` | `"flatten"` | `"history"` carries the whole revision graph |
| `targetDocId` | `"new"` | `"same"`, `"new"`, or an explicit id |
| `idPrefix` | — | Prefix for the generated id when `"new"` |
| `authorship` | `"reauthor"` | `"preserve"` throws where it cannot be honored |
| `decryptionKeyId` | source key, else `"default"` | Changing it forces re-encryption |
| `provenance` | `true` | Verifiable origin record on each entry |
| `atTimestamp` | — | Flatten only |
| `includeAttachments` | `true` | |
| `signingKeyPair` / `signingKeyPassword` | current user | Attribute a migration to a service identity |
| `onProgress` | — | `CopyProgress`, shaped like `SyncProgress` |
| `signal` | — | Cancellation; a cancelled copy is safe to re-run |
| `batchSize` | `200` | Entries per `putEntries` call |
| `bypassAccessControlPrecheck` | `false` | Trusted bulk paths only |

`copyDocumentsTo()` takes the same options except that `targetDocId` is limited
to `"same"` / `"new"` — with many documents in flight, an explicit id is
meaningless.

## Related documentation

- [Access Control](accesscontrol.md) — rules, tiers, and the witness
- [Time Travel](timetravel.md) — what a history copy preserves
- [Virtual Views](virtualview.md) — recombining shards for reading
- [Ad-hoc Queries](adhoc-queries.md) — the summary buffer and its cost model
- [Attachments](attachments.md) — chunking and the deterministic-IV envelope
