# Bulk Materialization

This document specifies how MindooDB materializes many documents at once with a bounded number of store round trips, instead of one round trip per document. It targets the case that hurts most: a database opened directly against a remote server through `ClientNetworkContentAddressedStore`, where every store call is an HTTP request.

It is a companion to [DB Open and Sync Optimization](./db-open-and-sync-optimization.md), which describes the single-document materialization planner and the metadata-first open that this design builds on.

## The Problem

Metadata-first open keeps `openDB` cheap: the changefeed index is built from metadata alone and no document body is materialized. That property holds only as long as nobody walks the whole changefeed. Three background consumers do exactly that:

- the summary buffer catch-up (`scheduleSummaryAutoUpdate`),
- the full-text index catch-up (`scheduleFulltextAutoUpdate`),
- Haven's attachment extraction pass.

All three consume `iterateChangesSince`, which materializes each yielded document. Against a local store that is fine. Against a remote store, materializing one document costs two to three HTTP requests:

| Step | Call | Requests |
|---|---|---|
| Entry metadata for the document | `scanAllMetadata(store, { docId })` → `scanEntriesSince` | 1 (more if the document has over 1000 entries) |
| Snapshot payload, when the planner selected one | `store.getEntries([snapshotId])` | 0 or 1 |
| Uncovered replay entries | `store.getEntries(entryIdsToApply)` | 1 |

For a 5,000-document database that is 10,000–15,000 requests, issued strictly sequentially — `DEFAULT_ITERATE_PREFETCH_WINDOW_DOCS` is `0`, so the look-ahead in `prefetchIterationWindow` is disabled by default and each document waits for the previous one. With the server's default sync rate limit of 1,000 requests per minute, a first open takes ten minutes or more and spends much of it being throttled.

The first response was to switch those passes off for server-mode targets (`OpenDBOptions.autoIndexing: false`). That removed the flood but also removed the summary buffer and the full-text index, which is what makes a database feel fast. This design is what allowed the gate to be lifted again; the option remains for hosts that want the passes off regardless.

## Goals and Non-Goals

The goal is a bounded request count for materializing N documents: proportional to total payload bytes divided by a page budget, not to N. A cold open of 5,000 documents should cost tens of requests, not tens of thousands.

Explicit non-goals: no change to the trust model (the server still never decrypts anything, and no client-produced artifact becomes authoritative), no new server-side index, and no change to what a client can see — key visibility stays exactly as it is today.

## Where the Requests Go

Two request classes need to be eliminated, and they have different fixes.

**Metadata requests** exist because `loadDocumentInternal` re-scans the store for the document's entry metadata even though `syncStoreChanges` just walked past that same metadata during its unfiltered scan and threw it away. This is fixable without touching the wire protocol.

**Payload requests** exist because each document fetches only its own entries. This is fixable by fetching the union of entries for a window of documents in one call — `getEntries` already accepts an arbitrary id list and the server already allows up to `MAX_ENTRY_IDS` (100,000) ids per call, so the wire format needs no change either. The binary framing (`getEntriesBinary`) already avoids base64 overhead.

## Design

Parts 1 and 2 are implemented; Part 3 is deferred until measurement justifies a protocol change.

### Part 1 — Reuse the metadata the sync walk already read

The metadata-first branch of `syncStoreChangesInternal` already computes each document's complete entry metadata as `allDocMetadata` — from the unfiltered cold-sync batch, or from an explicit per-document scan on an incremental walk — and then discards it. `BaseMindooDB.scannedEntryMetadata` keeps it instead, and `loadDocumentInternal` consumes it in place of its own `scanAllMetadata(store, { docId })` call.

The correctness constraint is coverage: the map must hold *every* entry of a document, never a partial history, or the document materializes from a truncated DAG. Both sources above are complete by construction, so the constraint is satisfied at the point of writing rather than by a later check.

Invalidation hangs off `updateIndex`, which every path that writes entries for a document passes through — a later sync batch, a local `changeDoc`, a witness receipt. The retained metadata is therefore dropped the moment new entries exist for that document, and the retaining call in the sync path deliberately runs *after* `updateIndex` so it is not immediately invalidated by its own index update. `purgeMaterializedDocument` and the stale-checkpoint rebuild clear it too.

Reads consume: metadata for a document is needed exactly once, and after that the materialized document lives in L1/L2. Combined with a cap of 200,000 retained entries, a very large cold open degrades to per-document scans instead of growing without bound. Time-travel instances skip the mechanism entirely — their scans are cutoff-scoped and an ad-hoc historical open does not repay the extra invariant.

#### Warm opens: one bulk scan instead of the walk

Retaining what the sync walk read covers a cold open and nothing else. An open that restores its index from the cache checkpoint finds no new entries, processes no documents, and so retains no metadata — and a changefeed pass over an empty document cache then scans once per document, which is the original flood in a different disguise. It is also the common case for a large database whose first pass never completed.

`warmScannedEntryMetadataFromStore` closes that gap: when a prefetch window contains at least eight documents without retained metadata, the whole store's metadata is read in one paged scan and the map is filled from it. The cost becomes a request per 1000 entries rather than a request per document, and because the map is now populated, the batched entry fetch has something to plan from.

The scan is all-or-nothing. It is ordered by receipt order, not by document, so a run stopped halfway would leave arbitrary documents with a partial history — precisely the truncated-DAG hazard the coverage rule exists to prevent. If the store holds more entries than the cap allows, nothing is retained and the per-document path stays in charge. It runs at most once per database instance, whether it succeeded, failed, or bailed on size.

### Part 2 — Fetch entries for a window of documents in one call

`prefetchIterationWindow` currently loads a window of documents with `Promise.all(docIds.map(loadDocumentInternal))`, which turns the sequential flood into a parallel burst — the same request count, now more likely to trip the rate limiter. Replace the body with a batch:

1. Take the next window of uncached, visible, non-deleted document ids from the index snapshot.
2. Get each document's entry metadata from the Part 1 map, falling back to a scan for uncovered documents.
3. Compute each plan locally with `computeDocumentMaterializationPlan`. No server call is needed: the planner works on metadata alone. (`planDocumentMaterializationBatch` remains the right call for a store whose metadata is not local, such as the dense-sync path.)
4. Union `snapshotEntryId` and `entryIdsToApply` across the window, subtract ids already held, and fetch the remainder in pages bounded by a byte budget computed from the metadata's `encryptedSize`.
5. Materialize each document in the window against the fetched entries, then drop the buffer.

The fetched entries live in a per-batch `Map<string, StoreEntry>` (`materializationEntryBuffer`), installed for the duration of the window and cleared in a `finally`. Reads go through a single private `fetchEntries(ids)` helper that serves what the buffer holds, fetches the remainder from the store, and returns entries in the requested order. A partial buffer is always safe, because a miss is just a normal fetch — which is what makes it correct to install the buffer for paths it does not fully cover.

`loadDocumentInternal` routes both its snapshot load and its replay load through the helper. The access-control quarantine path and the revision fold still call `store.getEntries` directly; they remain correct and simply do not benefit yet. Moving them onto `fetchEntries` is a mechanical follow-up.

The prefetch window is enabled by default (`DocumentCacheConfig.iteratePrefetchWindowDocs`, 32 documents, previously 0). It is kept well under the 128-document L1 cache so a window cannot evict itself before iteration reaches it.

#### The window must track a runway, not re-scan after every yield

`prefetchIterationWindow` runs after every yielded document, which makes its cheap-path behavior load-bearing. Two properties are required, and enabling the window without them turns a pass into something worse than the per-document path it replaces:

- **Bounded lookahead.** The window scan skips cached documents. A call that keeps scanning until it has collected a full window of *uncached* documents therefore starts where the last one stopped and runs away from the cursor — after k yields it has materialized 32·k documents. Past the L1 cache size those evict each other, iteration arrives at documents that were already fetched and evicted, and each re-load triggers another runaway window.
- **Refill hysteresis.** Even with a bounded scan, refilling on every yield admits exactly one new document per call, which is one batched fetch per document — the flood again, in batched clothing.

Both are handled by threading a `prefetchedThrough` index through the generator: a call with at least half a window of runway left returns without touching the store, and a refill resumes at `prefetchedThrough` instead of at the cursor. The state lives in the generator, not on the instance, so concurrent iterations do not share a runway. Because a refill can happen with half a window left, the window reaches up to 1.5× its size ahead of the cursor; `iteratePrefetchWindowDocs` is clamped to half of `maxEntries` so that stays inside the cache.

A test measures this: 80 documents against a 48-document cache cost 426 `getEntries` calls with the unbounded window and 10 with the runway.

### Part 3 — A multi-document metadata filter (optional, protocol change)

The warm-up scan reads the whole store, which is the right trade when a bulk pass is under way but wasteful when only a few scattered documents are missing. Extending `StoreScanFilters` with `docIds?: string[]` alongside the existing `docId` would let a specific window's metadata arrive in one targeted scan instead. It touches every store implementation plus the server's `handleScanEntriesSince` and must be capability-gated with a fallback, so it stays deferred until measurement shows the whole-store scan is the wrong shape.

## Batching Parameters

| Parameter | Default | Rationale |
|---|---|---|
| Window size (documents) | 32 | Bounds plan computation and eager materialization; clamped to half of `maxEntries` so the 1.5× runway stays inside the 128-document L1 cache. |
| Refill threshold (documents of runway) | half the window | Refilling sooner costs a fetch per document; refilling later stalls iteration on the store. |
| Page budget (ciphertext bytes) | 8 MB | Bounds peak memory and response size; derived from `encryptedSize` in the metadata, so it is known before fetching. |
| Ids per fetch | 5,000 | Well under the server's `MAX_ENTRY_IDS` of 100,000; the byte budget is the binding constraint in practice. |
| Metadata map cap (entries) | 200,000 | Bounded fallback to per-document scans for very large cold opens. |
| Warm-up threshold (uncovered documents per window) | 8 | A store-wide metadata scan costs a request per 1000 entries, so it repays itself after a handful of per-document scans. |
| Rate-limit retries | 3 (250 ms / 1 s / 3 s, `Retry-After` honoured, capped at 10 s) | Waiting out a throttle beats falling back to the per-document path, which issues more requests. |

A document whose own entries exceed the page budget gets its own page. The budget bounds a batch, never a single document, so an oversized document degrades to today's behavior instead of failing.

## Failure Handling and Backpressure

Prefetch is opportunistic: a batch fetch that throws is logged, the buffer is left null, and the per-document loads proceed against the store exactly as before. A prefetch failure must never surface as an iteration error, because the same documents are still reachable through the slow path.

Rate limits and oversized pages are handled rather than treated as failures, since falling back to the per-document path under throttling means issuing *more* requests, not fewer. Prefetch requests — both the warm-up scan and the entry pages — retry a rate limit up to three times with a 250 ms / 1 s / 3 s backoff, honouring a longer `Retry-After` when the server sends one, capped at 10 s so a prefetch cannot hang. A page rejected as too large is split in half and retried, down to a single entry; the page budget is built from `encryptedSize` metadata, which does not account for framing overhead, so halving is cheaper than guessing conservatively.

Errors are classified by shape (`name === "NetworkError"` plus the `type` field) rather than by `instanceof`, because the error crosses module and bundle boundaries where prototype identity is not reliable.

## Correctness Constraints

Batching changes *when* entries are fetched, never *which* entries are applied or how they are verified. Specifically:

- **Signature verification and decryption are unchanged.** Each entry is verified and decrypted exactly as it is on the single-document path; the buffer only replaces the transport step. In particular, snapshot head verification (`snapshotHeadsMatch`) still runs per document.
- **Admin-only databases** still filter entries by the admin public key after the fetch. The buffer may contain entries that a given document's materialization then rejects.
- **Key visibility is per client.** The batch fetches the entries the account may read and drops what the local KeyBag cannot decrypt, exactly as the per-document path does. A document that is invisible to this client stays invisible; no shared artifact crosses key boundaries.
- **Time-travel opens** run against a store already scoped by `creationDateUntil`, so a buffer built from that store's scans inherits the cutoff. No extra filtering is required, but the batch must not be shared between a live and a time-travel instance.
- **Access control.** When the tenant enforces access control, materialization goes through the Tier 2 quarantine path, which loads entries itself and is unaffected by the buffer today. Routing it through `fetchEntries` later must not bypass per-entry evaluation — only the transport step may change.

## Why Not a Shared Server-Side Index

The tempting alternative is to have one client compute the summary rows and publish them so other clients skip materialization. Two properties of the system rule out the naive version.

Clients do not see the same data. Visibility follows the KeyBag, so a document readable by client A may be invisible to client B. A single shared summary artifact would therefore be wrong for almost every reader. The shape that survives is one shard per `decryptionKeyId`, encrypted with that key, where a client fetches only the shards for keys it holds. That preserves visibility exactly and leaks only approximate per-key document counts through shard sizes.

The harder property is trust. A client-produced index can be checked for omission and staleness — each row can name the entry ids it summarizes, and those are verifiable against signed metadata the client already has — but its *content* cannot be verified without materializing the document, which is the cost being avoided. A shared index is therefore in the same trust class as `doc_snapshot`: usable only when produced by the admin. That makes it a deployment-specific accelerator, not a general answer to "opening a remote database is slow". Bulk materialization is the general answer, and it needs no new trust assumptions.

## Rollout

**Phase 1 — metadata reuse. Done.** Removes one request per document with no wire change.

**Phase 2 — batched entry fetch. Done.** The prefetch window is on by default and its entries arrive in byte-budgeted pages.

**Phase 3 — lift the gate. Done.** Haven no longer passes `autoIndexing: false` for server-mode targets, so remote databases get their summary buffer and full-text index back. The `OpenDBOptions.autoIndexing` knob stays for hosts that want the passes off regardless.

Note the release coupling: a host that lifts the gate must run against a core with Phases 1 and 2 in it. Lifting it while resolving an older `mindoodb` restores the per-document request flood.

Haven's attachment extraction pass stays off for server-mode targets. It walks the changefeed like the index passes, but it also pulls attachment chunks and runs OCR, so it is gated on its own merits rather than on request count; the manual trigger still runs it.

**Phase 4 — warm opens and throttle handling. Done.** A warm open that would otherwise scan per document triggers one store-wide metadata scan, and prefetch requests wait out a rate limit instead of dropping to the slow path.

**Phase 5 — remaining call sites.** Route the access-control and revision-fold fetches through `fetchEntries`, and consider an adaptive page budget that stays lowered after sustained throttling instead of retrying at full size each window.

**Phase 6 — the `docIds` scan filter,** if measurement shows the whole-store warm-up scan is the wrong shape for sparse windows.

## Testing

The behavioral assertions are about request counts, which the existing test helpers already make observable: `Materialization.test.ts` instruments `scanEntriesSince` and `getEntries` on an in-memory store and asserts an upper bound for a fixed document count. The implemented phases are covered there by "materialization after a cold sync reuses the scanned metadata", "changefeed iteration fetches entries in batches, not per document", "iteration past the prefetch window refills per window, not per document", "a warm open uses one bulk metadata scan, not one per document", and the staleness pair "a document changed after the sync walk is re-scanned, not reused".

The refill test needs a database larger than both the window and the cache. An earlier version used 20 documents with default settings — below the 32-document window, so the window never refilled and the runaway it was meant to catch did not appear. Request-count tests are only as good as the ratio between document count, window, and cache; state all three explicitly.

Cases still worth covering as the remaining phases land: a document larger than the page budget, an admin-only database with foreign-signed entries in the buffer, an invisible-key document inside a batch, a `413` splitting a page, and a `429` mid-batch that recovers after the backoff.

## Metrics

| Metric | Where |
|---|---|
| Store requests per materialized document | `PerformanceCallback.onSyncOperation` |
| Entry-load time share of total materialization | `onDocumentLoad.entryLoadTime` vs `totalTime` |
| Metadata map hit rate | New counter on the Part 1 map |
| Rate-limit retries per pass | Prefetch backoff logs; sustained retries mean the pass is still too request-hungry |
