# Change Attribution (AI agents)

Every MindooDB entry is signed by a user key, so the history already says *who* wrote a change. Change attribution adds *how*: a change can be marked as produced by an AI agent acting on that user's behalf, for example the built-in Haven assistant or an external WebMCP/MCP client. History views can then show "Alice (AI agent)" instead of just "Alice".

## Where it is stored

The attribution is written into the **message of the Automerge change** that forms the encrypted payload of every `doc_create`, `doc_change`, `doc_delete` and `doc_undelete` entry. It is **not** a field of the plaintext `StoreEntryMetadata`.

That placement is deliberate:

- **Private:** it is encrypted together with the document payload. Sync servers that hold no document keys cannot see which documents an agent touched.
- **Tamper-evident:** the entry signature covers the encrypted payload, so the attribution cannot be added, removed or changed after the fact without invalidating the entry.
- **Durable:** snapshots (`Automerge.save`) keep the change history including messages, and history copies (`copyDocumentTo` with `mode: "history"`) carry the original change bytes along.
- **Compatible:** runtimes that know nothing about attribution ignore the message. No store, sync or server change is needed.

The message is a small JSON object under one reserved key, so ordinary commit messages are never misread:

```json
{"mindoo.attribution":{"v":1,"kind":"agent","via":"haven-assistant","app":"todos","tool":"todo_create","model":"…","runId":"…","confirmed":true}}
```

## The type

```typescript
interface ChangeAttribution {
  v: number;                 // format version, currently 1
  kind: "agent";             // what produced the change
  via: "haven-assistant" | "webmcp" | "mcp" | string; // channel the agent used
  app?: string;              // application whose tool wrote the change
  tool?: string;             // tool name
  model?: string;            // language model, when the writer knows it
  runId?: string;            // groups the changes of one agent run
  confirmed?: boolean;       // the user confirmed the tool call before it ran
}
```

Fields are short labels. Never put prompts, tool inputs or document content into them. Labels are trimmed and capped at 128 characters, empty ones are dropped, and the whole message is limited to 1024 characters. A malformed attribution (missing `via`, other `kind`) makes the write throw before anything is stored, so a caller never silently writes an unattributed agent change.

## Writing

Pass `attribution` (the `v` field is optional) to any write:

```typescript
const attribution = { kind: "agent", via: "haven-assistant", app: "todos", tool: "todo_create", runId };

const doc = await db.createDocument({ initialValues: { title: "Buy milk" }, attribution });
await db.changeDoc(doc, (d) => { d.getData().done = true; }, { attribution });
await db.applyDocumentUpdate(doc, { set: { title: "Buy oat milk" } }, { attribution });
await db.deleteDocument(doc.getId(), { attribution });
await db.undeleteDocument(doc.getId(), { attribution });
```

| API | Option |
| --- | --- |
| `createDocument`, `createDocuments` (per input) | `CreateOptions.attribution` |
| `changeDoc` | `ChangeOptions.attribution` |
| `applyDocumentUpdate`, `applyJsonPatch`, `applyTextPatch`, `applyRichTextPatch`, `applyRichTextStepsPatch` | third argument `PatchOptions.attribution` |
| `deleteDocument`, `deleteDocuments` | `DeleteOptions.attribution` |
| `undeleteDocument` | `UndeleteOptions.attribution` |
| `addRecipients`, `removeRecipients`, `setRecipients` | `RecipientChangeOptions.attribution` |

Notes:

- **Convergent custom ids:** `createDocument({ id })` without `assumeUniqueId` starts with fixed seed bytes shared by all replicas, so that `doc_create` entry cannot carry an attribution. Values written afterwards (or the extra `initialValues` change of `createDocuments`) do.
- **Raw Automerge changes:** `applyAutomergeChanges` stores the change bytes a client produced. Their message is whatever that client set; MindooDB cannot add an attribution without changing the change hash. A client that wants its changes attributed writes the message itself, e.g. `Automerge.change(doc, encodeChangeAttribution(attribution), fn)`.
- **Flatten copies** (`copyDocumentTo` default mode) create a new document written by the copying user; they carry no attribution.

## Reading

`iterateDocumentHistory()` decrypts every entry anyway, so it reports the attribution for free:

```typescript
for await (const entry of db.iterateDocumentHistory(docId)) {
  if (entry.attribution) {
    console.log(`${entry.changeCreatedByPublicKey} via ${entry.attribution.via} (${entry.attribution.tool})`);
  }
}
```

- `getDocumentHistoryPage()` stays metadata-only by default. With `{ includeAttribution: true }` it loads, verifies and decrypts the returned entries (bounded by `limit`) and fills `entry.attribution`. Entries whose signature does not verify or that this replica cannot decrypt report none.
- `describeDocumentDagEntry()` returns `decodedChange.attribution` next to the raw `decodedChange.message`.
- `decodeChangeAttribution(message)` and `encodeChangeAttribution(attribution)` are exported for code that handles Automerge messages itself. Decoding is tolerant: absent, foreign, broken or oversized messages yield `undefined`, unknown fields are ignored.

Entries written before attribution existed, ordinary user changes and snapshot entries have no `attribution`.

## Trust model

The signature proves which user key wrote a change. The attribution is that user's runtime stating how the change came about. It is reliable against outsiders (they cannot forge or strip it), but it is a self-declaration of the writer: a modified client could leave it out or set it. Treat it as an honest-runtime label for transparency, not as proof that no agent was involved.
