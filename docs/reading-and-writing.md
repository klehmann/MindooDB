# Reading and Writing Documents

A MindooDB document is an [Automerge](https://automerge.org) CRDT: a JSON-like tree of maps, lists and values that several devices can change offline and merge later. How a change merges depends on **how you write it** and on the **type of the field**. This guide shows both with examples.

- [Read a document](#read-a-document)
- [Field types](#field-types)
- [Write inside `changeDoc()`](#write-inside-changedoc)
- [Text and rich text](#text-and-rich-text)
- [Counters](#counters)
- [Patch APIs](#patch-apis)
- [How concurrent edits merge](#how-concurrent-edits-merge)
- [Pitfalls](#pitfalls)

All examples assume an open database:

```javascript
import { MindooValue } from "mindoodb";

const db = await tenant.openDB("projects");
```

## Read a document

```javascript
const doc = await db.getDocument(docId);
const data = doc.getData();

data.title;          // "Project plan"
data.tags[0];        // "urgent"
data.meta.owner;     // "cn=jane/o=acme"
data.due;            // Date (a timestamp field)
data.votes;          // 3 (a counter field reads as a number)
```

`getData()` returns plain JavaScript values. It does not tell you how a value is stored: collaborative text and atomic strings both read as strings, counters as numbers. Ask `getFieldType()` when you need to know:

```javascript
doc.getFieldType("title");              // "text"
doc.getFieldType("status");             // "atomic"
doc.getFieldType("votes");              // "counter"
doc.getFieldType(["meta", "content"]);  // "richText"
doc.getFieldType("missing");            // undefined
await db.getFieldType(doc, ["rows", 0, "amount"]); // "number"
```

To find documents instead of reading one you already know, use [`db.query()` and the summary buffer](./adhoc-queries.md); materializing documents one by one is the expensive path (see [Best Practices §4](./best-practices.md)).

## Field types

| `getFieldType()` | How you write it | Merges on concurrent writes | Reads back as |
|---|---|---|---|
| `"text"` | a plain string | edits through `updateText()` / `textSplice` merge character by character; a plain assignment replaces the whole value | `string` |
| `"richText"` | `applyRichTextPatch()` / `applyRichTextStepsPatch()` | marks and blocks merge | `string` (use `getRichTextSnapshot()` for spans) |
| `"atomic"` | `MindooValue.atomic("open")` | one write wins as a whole | `string` |
| `"counter"` | `MindooValue.counter(0)`, then `incrementCounter()` | increments are summed | `number` |
| `"timestamp"` | `MindooValue.timestamp(new Date())` | one write wins | `Date` |
| `"number"`, `"boolean"`, `"null"` | plain value | one write wins | as written |
| `"bytes"` | `Uint8Array` | one write wins | `Uint8Array` |
| `"list"` | array | inserts and deletes from both sides are kept | array |
| `"map"` | object | different keys merge, same key: one write wins | object |

Pick the type when you create the field. Ids, status and enum values, URLs and hashes should be `atomic`, so two concurrent writes never produce a mix. Tallies several people change should be counters.

## Write inside `changeDoc()`

`changeDoc()` hands you the document; edit `getData()` like a plain object. Every edit is recorded at the depth it happens, also nested and in lists:

```javascript
const doc = await db.createDocument({
  initialValues: {
    title: "Project plan",
    status: MindooValue.atomic("open"),
    votes: MindooValue.counter(0),
    tags: ["planning"],
    meta: { owner: "cn=karsten/o=acme" },
    rows: [{ id: "r1", amount: 100 }],
  },
});

await db.changeDoc(doc, (d) => {
  const data = d.getData();

  data.status = MindooValue.atomic("in-progress"); // replace a field
  data.meta.owner = "cn=jane/o=acme";              // nested field
  delete data.meta.draft;                           // nested delete

  data.tags.push("q1");                             // list insert
  data.tags.splice(0, 1);                           // list delete
  data.rows[0].amount = 150;                        // field of a list element
  data.rows.push({ id: "r2", amount: MindooValue.counter(0) });

  const row = data.rows.find((r) => r.id === "r2");
  row.note = "new";                                 // via a found element
});
```

- The callback may be `async`; await other work inside it if you need to.
- Reads inside the callback see your edits so far (`data.tags.length` after a `push` is the new length).
- List methods (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`) and `list[list.length] = value` are stored as list inserts and deletes, so concurrent inserts from another device are both kept.
- Editing one element (`data.rows[0].amount = 150`) merges with edits to other elements. Reassigning the whole list or object (`data.rows = [...]`) replaces it.
- Everything in one callback becomes one change entry and one history step.

## Text and rich text

Every string is an Automerge text. How it merges depends on how you write it:

```javascript
await db.changeDoc(doc, (d) => {
  // Stores only the changed part: merges with concurrent typing elsewhere in the text.
  d.updateText("body", newBody);
  d.updateText(["rows", 0, "note"], "updated note");

  // Replaces the whole value: concurrent edits do not merge into it.
  d.getData().title = "New title";
});
```

When an editor already knows the positions, send them directly. `baseHeads` (from `doc.getHeads()` when the editor loaded the text) replays the edits on that version and then merges them:

```javascript
await db.applyTextPatch(doc, {
  path: ["body"],
  baseHeads,
  edits: [{ index: 12, deleteCount: 3, insert: "new" }],
});
```

For comments or highlights that must keep pointing at the same characters while others edit, use [text cursors](./getting-started.md) (`db.getTextCursors()` / `db.resolveTextCursors()`).

**Rich text** is a text with marks (bold, links, ...) and block markers (paragraphs, headings, ...). Do not assign it and do not use `updateText()` on it (it throws for rich text): an assignment drops the formatting, and `updateText()` knows nothing of blocks. Use the rich-text APIs:

```javascript
const snapshot = await db.getRichTextSnapshot(doc, ["content"]);

// A whole span list; Automerge works out the difference.
await db.applyRichTextPatch(doc, {
  path: ["content"],
  baseHeads: snapshot.heads,
  spans: [
    { type: "block", value: { type: "h1" } },
    { type: "text", value: "Project plan" },
    { type: "block", value: { type: "p" } },
    { type: "text", value: "Starts in " },
    { type: "text", value: "January", marks: { bold: true } },
  ],
});

// Or positional steps, e.g. from editor transactions.
await db.applyRichTextStepsPatch(doc, {
  path: ["content"],
  baseHeads: snapshot.heads,
  steps: [
    { type: "splice", index: 31, deleteCount: 0, insert: " 2027",
      marks: [{ index: 31, length: 5, marks: { italic: true } }] },
  ],
});
```

## Counters

```javascript
await db.changeDoc(doc, (d) => {
  d.incrementCounter("votes", 1);                // votes + 1
  d.incrementCounter(["rows", 1, "amount"], -5); // rows[1].amount - 5
  d.getData().votes;                             // already the new value
});
```

The path is the list of keys from the document root: `["rows", 1, "amount"]` is the field `amount` of the second element (index 1) of the list `rows`, i.e. `data.rows[1].amount`. In the document created above that is the counter of the row `r2`. A single string (`"votes"`) is a top-level field.

Two devices that each add 1 to `votes: 3` give `5` after syncing. Never write `data.votes = data.votes + 1`: that replaces the counter with a plain number, and concurrent updates are lost. A missing field is created as a counter by the first increment; incrementing a plain number throws.

Increments are applied in call order together with the other edits: an assignment after an increment replaces the counter, an increment after it adds to the new one.

## Patch APIs

The same edits are available as data, for code that receives operations instead of running a callback (sync bridges, the App SDK, agent tools):

```javascript
await db.applyJsonPatch(doc, {
  set: [
    { path: ["status"], value: MindooValue.atomic("done") },
    { path: ["meta", "owner"], value: "cn=jane/o=acme" },
  ],
  unset: [{ path: ["meta", "draft"] }],
  listInsert: [{ path: ["tags"], index: 1, values: ["q1"] }],
  listDelete: [{ path: ["tags"], index: 0, deleteCount: 1 }],
  textSplice: [{ path: ["title"], index: 0, deleteCount: 0, insert: "New " }],
  counterIncrement: [{ path: ["votes"], delta: 1 }],
});
```

Several kinds in one change (one history step), all or nothing:

```javascript
await db.applyDocumentUpdate(doc, {
  set: { status: MindooValue.atomic("review") },
  json: { listInsert: [{ path: ["tags"], index: 0, values: ["review"] }] },
  text: [{ path: ["body"], edits: [{ index: 0, deleteCount: 0, insert: "Draft: " }] }],
  richText: [{ path: ["content"], spans }],
});
```

## How concurrent edits merge

Karsten and Jane both start from `{ title: "Project plan", tags: ["start"], status: "open" }` and edit offline:

| Karsten | Jane | After sync on both devices |
|---|---|---|
| `data.tags.push("karsten")` | `data.tags.push("jane")` | both entries kept |
| `d.updateText("title", "Project plan 2027")` | `d.updateText("title", "New project plan")` | `"New project plan 2027"` |
| `data.meta.status = "in progress"` | `data.meta.owner = "Jane"` | both fields set |
| `data.status = MindooValue.atomic("done")` | `data.status = MindooValue.atomic("blocked")` | one of the two, the same on both devices |
| `d.incrementCounter("votes", 1)` | `d.incrementCounter("votes", 1)` | `+2` |
| `data.tags = ["a"]` | `data.tags = ["b"]` | one of the two lists |

The last case is why you edit lists instead of reassigning them. When one value wins, the other is kept as conflict metadata; see [DAG Conflict Analysis](./dag-conflict-analysis.md) to show it to users.

## Pitfalls

- **Reassigning instead of editing.** `data.tags = [...data.tags, x]` replaces the list; use `data.tags.push(x)`.
- **Assigning text that others edit.** `data.body = newBody` replaces the text; use `d.updateText("body", newBody)`.
- **Plain strings for status values.** Concurrent text edits can mix two values; write `MindooValue.atomic(...)`.
- **Arithmetic on counters.** Use `incrementCounter()`, not `+ 1`.
- **Lists have no holes.** `data.tags[10] = x` past the end, named properties on lists and `delete data.tags[0]` throw; use `push` and `splice`.
- **Removed elements.** An element proxy you removed with `splice` can no longer be edited in the same callback (it throws instead of editing a different element).
- **Reads return plain values.** Write the typed value again (`MindooValue.atomic(...)`) when you replace an atomic or timestamp field.
