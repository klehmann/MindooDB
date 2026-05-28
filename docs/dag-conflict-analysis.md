# Document DAG and Conflict Analysis

## Overview

MindooDB stores each document as an append-only history of cryptographically signed and encrypted changes. Those changes form a **document DAG**: every document entry points to the entries it depends on, and concurrent offline work naturally creates multiple branches. MindooDB can analyze that DAG to explain how a document evolved, which branches existed, where they merged, and whether user-visible conflicts occurred along the way.

This matters because CRDT-based systems are intentionally optimistic. Users can edit offline, sync later, and expect the system to converge without a central lock. Most concurrent edits merge automatically and safely. But some application fields represent a single semantic decision, such as a title, approval state, assignment, due date, or external reference. If two replicas concurrently write different values to the same field, the underlying CRDT must choose a deterministic visible value while preserving the alternatives. MindooDB's conflict analysis APIs make those moments discoverable.

The goal is not to make app developers handle every merge manually. The goal is to provide observability: a database, admin tool, server job, or future Haven UI can answer "what happened here?" without exposing Automerge internals to application code.

## Problems This Solves

### Understanding Offline Collaboration

In a traditional server-first database, write conflicts are often rejected immediately. In MindooDB, writes are accepted locally and reconciled later. This is what enables local-first collaboration, but it also means important events may only become visible when histories are inspected after sync.

DAG analysis answers questions such as:

- Which users or devices created concurrent branches?
- Which entries were active heads at a point in time?
- Which entry merged multiple branches?
- Which branch-local state would a user have seen before convergence?
- Was a document deleted, undeleted, or merged while offline?

### Explaining Automatic Convergence

Automerge handles most concurrent edits without conflict. Concurrent inserts into lists or text are preserved. Concurrent writes to different fields both survive. The difficult case is a concurrent write to the same object property or list index. Automerge picks a deterministic visible winner but keeps the other values as conflict metadata.

Conflict analysis helps surface those cases in MindooDB terms:

- document ID
- MindooDB DAG entry ID
- author signing key
- timestamp
- logical JSON path
- optional winner/alternative value summaries

The API does **not** return Automerge documents, raw patches, or mutable CRDT objects.

### Supporting Audits and Operations

Some applications need more than latest state. They need to prove how state was reached. Conflict and DAG analysis can support:

- audit trails for regulated workflows
- background health checks on shared databases
- support tooling for customer-reported data surprises
- dashboards showing documents that experienced concurrent edits
- server-side daily reports that flag unresolved conflicts
- future Haven visualizations for branches, merges, and conflict paths

## The MindooDB Document DAG

Every document lifecycle entry participates in the replay graph:

- `doc_create`
- `doc_change`
- `doc_delete`
- `doc_undelete`

Snapshots (`doc_snapshot`) are materialization shortcuts. They are useful for loading historical or branch-local states quickly, but they are not themselves user edits.

Each replay entry contains `dependencyIds`, pointing to the parent entries that were known when the change was created. A simple linear document has one active head. Concurrent offline edits produce two or more heads until a later change observes and depends on them.

```text
doc_create
    |
    +-- doc_change by user A
    |
    +-- doc_change by user B
            |
       later merge/change sees both heads
```

The DAG is metadata-readable. MindooDB can identify forks, merge points, active heads, branch ancestry, and replay order without decrypting document payloads. Payload decryption is only needed when a tool asks for materialized branch state or conflict details.

## DAG Analysis Capabilities

MindooDB already exposes DAG-oriented APIs for history tooling:

```typescript
analyzeDocumentDagAtTimestamp(
  docId: string,
  timestamp: DocumentDagAnalysisTimestamp
): Promise<DocumentDagAnalysisResult>
```

This returns a metadata-level view containing active heads, graph lanes, entries, branches, fork points, merge points, and lifecycle state. It is designed for UI tools such as Haven's DAG explorer.

For branch-local inspection, MindooDB also exposes:

```typescript
materializeDocumentBranchAtEntry(
  docId: string,
  headEntryId: string
): Promise<DocumentDagBranchMaterializationResult | null>
```

and:

```typescript
materializeDocumentBranchAtTimestamp(
  docId: string,
  timestamp: DocumentDagAnalysisTimestamp,
  headEntryId: string
): Promise<DocumentDagBranchMaterializationResult | null>
```

These APIs reconstruct what a specific branch saw without forcing callers to understand the CRDT backend.

## Conflict Analysis Capabilities

Conflict analysis builds on the DAG. It takes one or more document IDs, scans their document histories, and emits findings as a stream.

```typescript
analyzeDocumentConflicts(
  docIds: string[],
  options?: DocumentConflictAnalysisOptions
): AsyncGenerator<DocumentConflictAnalysisEvent, void, unknown>
```

For single-document reporting, use:

```typescript
getDocumentConflictReport(
  docId: string,
  options?: DocumentConflictReportOptions
): Promise<DocumentConflictReport>
```

The streaming API is the primary API because conflict analysis may touch many documents and long histories. It gives browsers and servers a way to report progress, cancel work, and stop early.

## Quick Mode vs Full Mode

Conflict analysis supports two main usage patterns.

### Quick Mode

Quick mode answers: "Did this document have a user-visible conflict?"

It is useful for:

- badge counts
- daily server scans
- filtering large document sets
- deciding whether to fetch a detailed report

Quick mode can stop after the first conflict per document or after `maxConflictsPerDoc`.

```typescript
for await (const event of db.analyzeDocumentConflicts([docId], {
  mode: "quick",
  maxConflictsPerDoc: 1,
})) {
  if (event.type === "conflictDetected") {
    console.log("Document has a conflict", event.conflict.paths);
  }
}
```

### Full Mode

Full mode answers: "Where did conflicts happen over time, and were they later resolved?"

It is useful for:

- detailed support tooling
- audit reports
- Haven DAG explorer integration
- server-side operational reports

```typescript
const report = await db.getDocumentConflictReport(docId, {
  detail: "values",
});

console.log(report.conflicts);
console.log(report.resolutions);
```

## Event Stream

`analyzeDocumentConflicts()` yields events so callers can update UI or server progress incrementally.

Important event types:

- `docStart`: analysis started for a document
- `progress`: metadata or document progress update
- `conflictDetected`: one or more conflict paths were found
- `conflictResolved`: a later write resolved a previously observed path conflict
- `docDone`: analysis completed for a document
- `error`: one document failed without necessarily aborting the whole run

Example:

```typescript
const controller = new AbortController();

for await (const event of db.analyzeDocumentConflicts(docIds, {
  mode: "full",
  detail: "paths-only",
  yieldEveryMs: 16,
  signal: controller.signal,
})) {
  switch (event.type) {
    case "progress":
      updateProgress(event.scannedDocs, event.totalDocs);
      break;
    case "conflictDetected":
      showConflictBadge(event.conflict.docId, event.conflict.paths);
      break;
    case "conflictResolved":
      showResolution(event.docId, event.path.pathString);
      break;
  }
}
```

The `yieldEveryMs` option is intended for browser UIs. It allows long scans to yield back to the event loop so the interface remains responsive. Server jobs can omit it or use a larger value.

## Value Detail Levels

Conflict analysis supports two detail levels:

- `paths-only`: report where conflicts happened
- `values`: include JSON-safe summaries of the conflicting values

`paths-only` is cheaper and is the best default for large scans. `values` is useful for detail panels, support tools, or reports where the conflicting values matter.

Even with `detail: "values"`, MindooDB returns bounded, JSON-safe summaries. It does not expose live CRDT objects.

Example value summary:

```typescript
{
  pathString: "title",
  values: [
    { conflictId: "3@actor-a", preview: "Draft A", value: "Draft A", isWinner: false },
    { conflictId: "2@actor-b", preview: "Draft B", value: "Draft B", isWinner: true }
  ]
}
```

The `conflictId` is useful for stable display and debugging, but application code should not treat it as a portable business identifier.

## Performance Model

Conflict analysis is designed to avoid expensive full-document scans whenever possible.

### Metadata Preflight

The first step is metadata-only. MindooDB scans document entries and looks for concurrency candidates:

- forks
- merge entries
- multiple active heads

If a document has no concurrency candidates, it cannot contain the conflict pattern that MindooDB is looking for, so the analyzer can skip payload loading.

### Patch-Driven Inspection

For candidate documents, MindooDB replays verified changes internally. For each change, it uses backend diff information to find changed paths, then checks conflict details only for those paths. This keeps the common case proportional to the changed paths rather than the full JSON document size.

### Bounded Full Scans

There are two cases where MindooDB intentionally scans a materialized document tree:

1. Before applying a change when the current state has multiple heads. This catches conflicts that are about to be resolved.
2. After replay completes when the document still has multiple active heads. This catches unresolved active conflicts that have no later patch.

These scans are bounded to concurrency states, not performed after every change.

### Sequential Processing

Documents are processed sequentially by default. This is intentional for browser compatibility and UI responsiveness. A server process that wants parallelism can run multiple analyses externally with its own scheduling policy.

## Security and Encapsulation

Conflict analysis follows the same security rules as other MindooDB materialization paths:

- signatures are verified before encrypted payloads are trusted
- admin-only databases ignore non-admin entries
- encrypted payloads are decrypted only inside MindooDB internals
- public APIs return DTOs, not backend objects
- app-facing conflict paths exclude MindooDB bookkeeping fields such as `_lastModified`

This keeps the API stable if MindooDB later changes its CRDT backend or if Automerge changes its JavaScript API.

## Future Haven UI

The Haven UI can build on these APIs without owning the analysis logic.

Useful UI concepts include:

- DAG nodes with conflict markers
- branch lanes showing fork and merge history
- conflict badges on documents
- expandable path lists for each conflict
- optional value comparison panels
- resolution markers showing the entry that overwrote a conflicted field
- progress indicators for large database scans

The recommended Haven integration is:

1. Use `analyzeDocumentDagAtTimestamp()` for the graph layout.
2. Use `analyzeDocumentConflicts([docId], { mode: "full", detail: "paths-only" })` to mark graph nodes and paths.
3. Use `getDocumentConflictReport(docId, { detail: "values" })` only when the user opens a conflict detail view.

This keeps the initial graph fast while still allowing deep inspection on demand.

## Example: Daily Server Scan

A server can scan a database periodically and persist only lightweight findings:

```typescript
const docIds = await db.getAllDocumentIds();

for await (const event of db.analyzeDocumentConflicts(docIds, {
  mode: "quick",
  detail: "paths-only",
  maxConflictsPerDoc: 1,
})) {
  if (event.type === "conflictDetected") {
    await recordConflictFlag({
      docId: event.conflict.docId,
      paths: event.conflict.paths.map((path) => path.pathString),
    });
  }
}
```

The same scan can run in a browser, but browser callers should usually pass `yieldEveryMs` and an `AbortSignal`.

## When Conflict Analysis Is Not Needed

Many MindooDB applications will never need to present conflict details to end users. If an app's data model is mostly append-only, list-oriented, or text-oriented, Automerge can usually preserve concurrent edits without user-visible conflict resolution.

Conflict analysis becomes important when:

- fields represent exclusive decisions
- users need auditability
- external systems depend on one visible value
- support teams need to explain surprising document state
- admins need operational confidence across many offline clients

In other words: the feature is an observability layer for systems that trust local-first convergence but still need to explain it.
