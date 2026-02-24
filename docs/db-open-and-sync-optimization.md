# DB Open and Sync Optimization

This guide explains how MindooDB opens databases quickly, keeps sync throughput high, and preserves correctness for multi-writer CRDT histories. It covers the design rationale, integration steps, correctness guarantees, and operational tuning knobs.

## Overview

Opening a MindooDB database involves reconstructing Automerge document state from encrypted, content-addressed entries. In a naive implementation every entry for every document would be fetched, decrypted, and replayed on each startup. That approach does not scale: a database with thousands of documents and deep change history would take seconds to minutes before becoming usable.

MindooDB addresses this with three complementary strategies:

1. **Causal materialization planning** determines the minimal set of entries needed to reconstruct each document, using the dependency graph rather than timestamps. This avoids replaying entries that a snapshot already covers and handles concurrent offline branches correctly.

2. **Metadata-first open** defers full document decryption and Automerge reconstruction until a document is actually accessed. The database becomes usable (document list available, indexes updating) before all documents are fully hydrated.

3. **Deterministic changefeed iteration** guarantees that local indexers (such as virtual views) can resume after restarts without missing or double-processing any document update.

Together these strategies reduce cold-start latency from proportional-to-full-history to proportional-to-accessed-documents, while keeping the correctness properties that CRDT-based multi-writer collaboration requires.

## Why Causal Planning Replaces Timestamp Filtering

Earlier versions of MindooDB selected the newest snapshot by `createdAt` timestamp and replayed all entries created after it. This is not causally safe in a multi-writer system. Consider two users who work offline: User A creates changes 1-5 and a snapshot, User B independently creates changes 6-10 and a different snapshot. Neither snapshot covers the other user's branch. Picking the "newest" snapshot and replaying entries with later timestamps can silently skip an entire branch of valid changes.

The causal materialization planner solves this by operating on the dependency graph (`dependencyIds`) instead of timestamps. For each document it:

1. Identifies the current DAG heads (entries with no descendants among replay entries).
2. Walks backward from those heads to compute the full set of entries needed for latest state.
3. Evaluates each available snapshot by how many of those needed entries it causally covers.
4. Selects the snapshot with maximal causal coverage (using `createdAt` only as a tie-breaker when coverage is equal).
5. Returns only the uncovered entries in dependency-first topological order.

The planner works entirely on unencrypted metadata (`StoreEntryMetadata`), so it can run server-side for network-backed stores without requiring access to decryption keys.

### Integration: How to Use the Planner

The planner is exposed as two methods on every `ContentAddressedStore` implementation:

```typescript
// Plan for a single document
const plan = await store.planDocumentMaterialization(docId, { includeDiagnostics: true });
// plan.snapshotEntryId   — snapshot to load first (or null)
// plan.entryIdsToApply   — ordered entry IDs to replay after the snapshot
// plan.diagnostics       — optional debug info (head IDs, coverage counts)

// Plan for many documents in one call (important for network stores)
const batchPlan = await store.planDocumentMaterializationBatch(docIds);
// batchPlan.plans — array of per-document plans
```

`BaseMindooDB.loadDocumentInternal` already uses this API internally. If you are building a custom store implementation, you can delegate to the shared `computeDocumentMaterializationPlan` function in `MaterializationPlanner.ts` rather than reimplementing the graph logic.

## Fast Open: Metadata-First Startup

When MindooDB opens a database, it needs to know which documents exist and when they last changed, so that `iterateChangesSince` and `getAllDocumentIds` work correctly. However, fully materializing every document (fetching entries, verifying signatures, decrypting, and applying Automerge changes) is expensive and often unnecessary at startup.

MindooDB therefore splits startup into two phases:

**Phase 1 — Index update (fast).** For each document that has new entries since the last sync, MindooDB reads only entry metadata (type, timestamps, document ID) and updates the internal changefeed index. No payloads are fetched or decrypted. The document list and changefeed cursors become usable immediately.

**Phase 2 — Lazy materialization (on demand).** When application code calls `getDocument(docId)`, the document is materialized using the causal planner: fetch the planned snapshot and replay entries, verify signatures, decrypt, and apply Automerge changes. The result is cached for subsequent access.

This means the time to "database is open and responsive" is proportional to the number of _metadata entries_ (small, fast) rather than the number of _full document materializations_ (large, slow). For a remote `ClientNetworkContentAddressedStore`, this is the difference between one metadata scan request and hundreds of individual document fetch requests at startup.

### When to Use Eager vs. Lazy Materialization

For most applications, the default lazy behavior is appropriate. Consider switching to eager (pre-fetching all documents at startup) only if your application will immediately access the majority of documents — for example, a full-text search index that must be populated before the UI becomes interactive.

## Dense Sync

When synchronizing a database from a remote server to a local device, transferring the complete change history for every document can be wasteful. Dense sync reduces the transfer to the minimum needed for local usability by wiring the batch materialization planner into the `syncEntriesFromStore` transfer path.

### How It Works

Dense sync is activated by passing `mode: "dense"` in the `SyncOptions` for `pullChangesFrom` or `pushChangesTo`. The algorithm runs in five phases:

1. **Discover documents.** The source store is queried for all `doc_create` and `doc_delete` metadata entries. This gives the target the full document list and deletion markers without transferring any payload bytes.

2. **Compute batch plan.** The source's `planDocumentMaterializationBatch` is called for all discovered document IDs. For each document, the planner determines the best snapshot (by causal coverage) and the minimal set of uncovered change entries needed to reconstruct the latest Automerge state.

3. **Merge needed entry IDs.** The plan output is merged with all `doc_create` and `doc_delete` entry IDs. This ensures that the target can build its metadata index correctly — `doc_create` entries carry the `decryptionKeyId` needed for key resolution, and `doc_delete` entries ensure deletion tracking is up to date.

4. **Filter against target.** The merged set of needed IDs is checked against the target store using the bloom-filter fast path (when available) plus exact `hasEntries` verification. Only entries the target does not already have are scheduled for transfer.

5. **Transfer missing entries.** The remaining entries are fetched from the source and written to the target in configurable page-sized batches, with progress callbacks at each step.

Attachment chunks (`attachment_chunk` entries) are intentionally excluded from the dense transfer set. They are not part of the Automerge document DAG and can be fetched on demand when the application actually accesses an attachment. This prevents large binary files from blocking the initial sync.

### Integration

```typescript
// Pull only what is needed for the current document state
await db.pullChangesFrom(remoteStore, {
  mode: "dense",
  onProgress: (p) => console.log(p.phase, p.message),
});

// Access documents normally — they are materialized from snapshot + uncovered changes
const doc = await db.getDocument(docId);
```

The `onProgress` callback reports a `"planning"` phase (while the batch planner runs on the source) in addition to the standard `"preparing"`, `"transferring"`, and `"complete"` phases. This gives the UI enough information to show a meaningful progress indicator during initial setup.

### Dense Sync vs Full Sync

| Aspect | Full sync (`"full"`, default) | Dense sync (`"dense"`) |
|---|---|---|
| Entries transferred | All entries the target is missing | Only snapshot + uncovered changes + lifecycle entries |
| Attachments | Transferred with everything else | Skipped (fetched on access) |
| History depth | Complete — time-travel available immediately | Latest state only — time-travel requires a subsequent full sync |
| Network calls | Proportional to entry count (paginated scan) | ~5–6 calls regardless of document count (batch planner + fetch) |
| Best for | Server-to-server replication, archiving | Mobile initial setup, metered connections |

An optional **retention window** can be configured to keep a sliding window of recent history (for example, the last 30 days of changes) available locally for time-travel, while still avoiding full-history transfer for documents with years of edit history.

Dense sync is especially valuable for mobile clients with limited bandwidth and storage, where transferring megabytes of historical changes per document would make initial setup unacceptably slow.

## Deterministic Changefeed: `iterateChangesSince`

Local indexers such as virtual views use `iterateChangesSince` to incrementally process document changes. For this to work correctly across restarts, the changefeed must satisfy two properties:

1. **Gap-free:** Every document update must eventually appear in the iteration. If an indexer misses an update, its index becomes silently inconsistent.
2. **Deterministic ordering:** The same sequence of updates must produce the same iteration order, regardless of when or how many times the database is opened.

MindooDB achieves this with a monotonically increasing sequence number (`changeSeq`) assigned to each document update in the internal index. The `ProcessChangesCursor` returned by the iterator includes this sequence number. On restart, passing the last persisted cursor resumes iteration from exactly where it left off.

Important implementation details:

- The iterator takes a snapshot of the internal index at the start of each generator run, so concurrent updates during iteration do not reorder or skip entries.
- `changeSeq` is persisted as part of the database checkpoint, so it survives process restarts.
- The legacy `lastModified` / `docId` cursor fields are still present for backward compatibility but are no longer the primary ordering key.

### Integration: Correct Cursor Usage

Always persist the cursor after successfully processing each batch of changes:

```typescript
let cursor: ProcessChangesCursor | null = loadPersistedCursor();
for await (const { doc, cursor: newCursor } of db.iterateChangesSince(cursor)) {
  await processDocument(doc);
  cursor = newCursor;
  await persistCursor(cursor);   // durable write before moving on
}
```

If the process is killed between `processDocument` and `persistCursor`, the same document will be re-processed on restart. Design your processing to be idempotent so that reprocessing is harmless.

## Crash and Restart Resilience

Long-running operations like initial database hydration or full view index rebuilds can take minutes. If the process is killed mid-way, MindooDB should not restart from zero.

The resilience strategy has three parts:

1. **Checkpointed progress.** The internal index, processed-entry cursor, and `changeSeq` counter are persisted together as a checkpoint. After a restart, MindooDB loads the checkpoint and resumes from where it left off rather than re-scanning the entire store.

2. **Idempotent batches.** Document processing and index updates are designed to be safe to repeat. If a batch is partially applied before a crash, replaying it produces the same result.

3. **Cursor advancement after durable writes.** The checkpoint is updated only _after_ the corresponding work has been durably written. This ensures that a crash never causes the cursor to advance past unfinished work.

## Snapshot Scheduling

Snapshots are a performance optimization, not a correctness requirement. A document can always be reconstructed from its full change history. However, documents with hundreds of changes benefit significantly from periodic snapshots that allow the planner to skip most of the replay.

MindooDB creates snapshots automatically using an adaptive policy:

- **Trigger:** A snapshot is considered when the number of changes since the last snapshot exceeds a configurable threshold (default: 100 changes).
- **Cooldown:** To avoid snapshot churn on frequently edited documents, a minimum time must elapse since the last snapshot (default: 10 minutes).
- **Best-effort:** Snapshot creation runs after a successful `changeDoc` call. If it fails (for example, due to a network error on a remote store), the failure is logged but does not block the change operation.
- **Coverage metadata:** Each snapshot records the Automerge heads it represents (`snapshotHeadHashes`) and the corresponding entry IDs (`snapshotHeadEntryIds`), so the planner can evaluate coverage without decrypting the snapshot payload.

Over time, older snapshots that are fully superseded by newer ones can be pruned to reclaim storage. The planner always selects the snapshot with the best causal coverage, so pruning obsolete snapshots does not affect correctness.

## Operational Tuning

Start with the defaults and adjust based on measured behavior. The key metrics to watch are:

| Metric | What it tells you | Where to look |
|---|---|---|
| Startup latency (p50 / p95) | How fast the database becomes usable | Application-level timing around `openDB` |
| Bytes transferred in dense sync | Network cost of initial device setup | `SyncProgress` callback totals |
| Replay entries per materialization | How much work the planner avoids | `MaterializationPlanDiagnostics.uncoveredLatestEntryCount` |
| Snapshot write frequency | How often snapshots are created | Log output from `maybeWriteSnapshotForDocument` |

**If startup is too slow,** verify that metadata-first open is active (documents should not be fully materialized during `syncStoreChanges`). If a custom integration is eagerly calling `getDocument` for every doc at startup, consider deferring those calls.

**If document access is too slow,** the likely cause is too many replay entries per materialization. Lower the snapshot change threshold or reduce the cooldown window so that snapshots are created more frequently.

**If storage or write amplification is too high,** increase the snapshot cooldown or raise the change threshold so that fewer snapshots are written. Consider pruning old snapshots that have been fully superseded.
