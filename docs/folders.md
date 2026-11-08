# Folders (Filing) in MindooDB

Folders let users and apps **file documents into named folders without changing the documents**. A document can sit in any number of folders, folders can contain documents from several databases and even other tenants, and a folder can be private while the documents in it are shared.

Folders plug into [VirtualViews](virtualview.md): one view shows all folders of a design at once, with the folder as a (multi-value) category, and is maintained incrementally like every other view.

## Overview

```ts
import { createViewLanguage, VirtualViewFactory, ColumnSorting, TotalMode } from "mindoodb";

// 1. File documents (writes only small sidecar documents)
const filing = db.filing("mail");                        // a filing store in this database
const projects = await filing.createFolder({ name: "Projects" });
await filing.add(mailId, projects.folderId);
await filing.move(mailId, { from: projects.folderId, to: "archive" });

// 2. Show them in a view
const v = createViewLanguage<Mail>();
const view = await VirtualViewFactory.createView()
  .withFilingStore("mail", { db, store: "mail" })
  .addCategoryColumn("folder", { expression: v.folders("mail") })
  .addSortedColumn("receivedAt", ColumnSorting.DESCENDING)
  .addDisplayColumn("subject")
  .addTotalColumn("unread", TotalMode.SUM, { expression: v.ifElse(v.field("isRead"), 0, 1) })
  .withDB("mail", db, v.and(v.eq(v.field("type"), "message"), v.inFolder("mail")))
  .buildAndUpdate();
```

## Architecture

### Sidecar documents instead of a field in the document

Folder membership is **not** stored in the filed document. Instead, every filed document gets exactly one small **sidecar document** per filing store, in the **filing database** (any database you choose — the same database, a team database or a personal one):

```jsonc
// docId: fil_<store tag>_r<keyed hash of store + target>
{
  "type": "$filing",
  "store": "mail",                 // the filing store ("set of folders")
  "ref": "doc_8f3…",              // the filed document (see "References")
  "f:inbox": 1731050000000,        // folder id -> filed at (epoch ms)
  "f:fld_projA": 1731051234000
}
```

- **Moving** a document is one small change of one small document. The filed document is never touched — no new Automerge change on a large mail with attachments, no signature, no history entry on it.
- **Concurrent filing on two devices merges.** The sidecar id is deterministic, so two replicas filing the same document for the first time write into the *same* document (custom-id documents share seeded Automerge ancestry). Memberships are top-level fields (`f:<folderId>`) rather than a nested map on purpose: two replicas would each create their own nested map object, and Automerge keeps only one of two concurrently assigned objects. Top-level keys merge key by key.
- The sidecar id is a **keyed hash** (HMAC-SHA256 with a subkey derived from the database key, see `MindooTenant.computeKeyedHash`) of store and target. Everyone with the key computes the same id; a sync server without the key cannot tell which document a sidecar belongs to.
- Removing a document from all folders leaves a sidecar without `f:` fields; re-filing reuses it.

### Folder definitions

A folder is a document of the same store:

```jsonc
{ "type": "$folder", "store": "mail", "folderId": "fld_projA",
  "name": "Project A", "parentId": "fld_projects", "role": null, "design": "mailfolder", "deleted": false }
```

- `folderId` is stable; views categorize by it, so **renaming or moving a folder in the hierarchy changes no row**. Show the name via a lookup (`filing.listFolders()`).
- Deleting a folder marks the definition `deleted: true` and (by default) removes the folder from all known sidecars. Membership keys that a replica adds concurrently stay hidden because the folder is marked deleted. Re-creating a folder with the same `folderId` revives it.
- Folder ids must not contain a backslash (the category path separator) or control characters.

### References

A sidecar stores its target **relative to the filing database**, always by physical identity:

| Reference | Meaning |
|---|---|
| `"<docId>"` | document in the filing database itself |
| `"mdbref:/<dbId>/<docId>"` | document in another database of the same tenant |
| `"mdbref://<tenantId>/<dbId>/<docId>"` | document in a database of another tenant |

The API accepts these strings or `{ tenantId?, dbId?, docId }` objects. Views translate references into the physical key `<tenantId>/<dbId>/<docId>` and match them against their data sources; references to databases that are not a source of the view are ignored.

### The filing index

Each (database, store) pair has one shared **filing index** — which document is in which folders, plus the folder definitions. It is maintained incrementally from the filing database's changefeed, restricted by id prefix to the store's own documents (so a large team database with other documents costs nothing extra), and persisted through the database's cache manager. Every view joining the store shares it, just like the summary buffer is shared per database.

The index keeps a short **change log**: each view asks "which documents changed folders since my last update?" and re-evaluates exactly those.

### How views join folders

A view has two kinds of sources: **data sources** (`withDB`, the filed documents) and **filing stores** (`withFilingStore`). On every `update()` the view

1. brings the filing indexes up to date **first** (otherwise a fresh build would briefly show rows without their folders),
2. hands the delta of documents whose membership changed to the data providers,
3. updates the data providers as usual. A provider re-evaluates a document when the document changed (changefeed) **or** its folders changed — even though the document itself did not. This is the same pattern the summary provider already uses for full-text matches whose relevance changes.

`folders(store)` and `inFolder(store, id?)` look up the index in O(1). Both work on the summary path and on the materialized-document path.

**Driving from the folder.** When the filter is `inFolder(store, "<id>")` — alone or as one operand of a top-level `and` — only that folder's members can match, so the summary provider reads the members instead of scanning the summary buffer. Views over all folders use the normal path.

### Live views

`view.bindTo(db)` also binds the filing databases of the view, so filing, moving and removing update a live view immediately.

### Persistence

The filing index persists its state (sidecar memberships, folder definitions, changefeed cursor and change log) through the database's `CacheManager`. A view's cache stores how far it has consumed each index's change log. After a restart the view replays only the filing changes made since; if the index had to be rebuilt (other generation) or the view is too far behind, the view re-evaluates everything once. A restored index never reuses the sequence numbers of its change log: if the app stopped after a view had consumed changes the index had not persisted yet, the sequence jumps past them and such a view re-evaluates once instead of skipping changes.

## Advantages over HCL Domino folders

Domino folders store a list of note IDs inside the folder note, one index per folder. MindooDB keeps what makes Domino folders useful and removes their main limits:

| | HCL Domino folders | MindooDB folders |
|---|---|---|
| File without edit rights on the document | yes | yes — only write access to the filing database is needed, read access to the target is enough |
| Change to the document when filing | none | none |
| Cost of moving a document | rewrite of two folder ID tables | one small change of one small sidecar |
| Concurrent filing on two replicas | replication conflicts of the folder note possible | merges key by key, one sidecar per document by construction |
| Documents of other databases in a folder | no | yes (`mdbref:/…`) |
| Documents of other tenants in a folder | no | yes (`mdbref://…`) |
| Private folders over shared documents | private folders, stored per user in the database (or desktop) | filing database is a personal database: private and synced across the user's devices, invisible to others |
| Indexes | one index per folder | one index per folder **design**: all folders with the same columns share one view, the folder is the first category — 200 folders cost one index |
| Unread / total counts per folder | separate unread tables | category totals and descendant counts of the view, offline as well |
| Selection formula next to the folder | no (folder contents are the selection) | yes — `inFolder()` is an expression, AND-combined with any other filter |
| Reading several folders as one list | no | `VirtualViewFactory.createMergedNavigator(view, [["a"], ["b"]])` (k-way merge, duplicates removed) |
| Server can see folder contents | yes (ID table in the folder note) | no — sidecars are encrypted, their ids are keyed hashes |

## Using folders with MindooDB Core

### Filing API (`db.filing(store)`)

```ts
const filing = db.filing("mail");                  // same instance for the same store name
// Optional: encrypt the store with a named key (all replicas must use the same):
// db.filing("private", { decryptionKeyId: "my-key" })

await filing.add(ref, "inbox");                    // ref: "<docId>" | "mdbref:/db/doc" | { dbId?, tenantId?, docId }
await filing.add(ref, ["inbox", "todo"]);
await filing.move(ref, { from: "inbox", to: "done" });
await filing.move(ref, { to: "done" });            // leave every other folder of the store
await filing.remove(ref, "todo");
await filing.remove(ref);                          // remove from every folder

await filing.foldersOf(ref);                       // ["done"]
await filing.count("done");
for await (const { ref, target, filedAt } of filing.contents("done")) { /* no view needed */ }

const folder = await filing.createFolder({ name: "Project A", parentId: "fld_projects", design: "mailfolder" });
await filing.createFolder({ name: "Inbox", folderId: "inbox", role: "inbox" });   // fixed id: replicas converge
await filing.renameFolder(folder.folderId, "Project Alpha");
await filing.updateFolder(folder.folderId, { parentId: null });
await filing.listFolders();
await filing.deleteFolder(folder.folderId);        // { keepFiling: true } keeps sidecar keys (hidden)
```

### Expressions

| Expression | Result |
|---|---|
| `v.folders(store)` | folder ids of the current document (array, empty when not filed) — use as a multi-value category |
| `v.inFolder(store)` | `true` when the document is in any folder of the store |
| `v.inFolder(store, folderId)` | `true` when the document is in that folder |
| `v.union(a, b, …)` | flattened, de-duplicated list without empty values |
| `v.split(text, separator)` | text split at the separator, empty parts dropped |

`store` is the name registered with `withFilingStore`. The expressions are JSON-serializable like the rest of the language, and available in formula text (`v.inFolder("mail", "inbox")`). A view that uses a store it did not register fails at build time; ad-hoc queries (`db.query`, `db.queryView`) reject folder expressions because they have no filing join.

### Examples

**All folders in one view, unread counts per folder:**

```ts
const view = await VirtualViewFactory.createView()
  .withFilingStore("mail", { db: mailDb, store: "mail" })
  .addCategoryColumn("folder", { expression: v.folders("mail") })
  .addSortedColumn("receivedAt", ColumnSorting.DESCENDING)
  .addDisplayColumn("subject")
  .addTotalColumn("unread", TotalMode.SUM, { expression: v.ifElse(v.field("isRead"), 0, 1) })
  .withDB("mail", mailDb, v.and(v.eq(v.field("type"), "message"), v.inFolder("mail")))
  .buildAndUpdate();

for (const category of view.getRoot().getChildCategories()) {
  console.log(category.getCategoryValue(), category.getDescendantDocumentCount(), category.getTotalValues()?.unread);
}
```

**One folder with its own design** (only its members are read):

```ts
VirtualViewFactory.createView()
  .withFilingStore("mail", { db: mailDb, store: "mail" })
  .addSortedColumn("dueDate")
  .addDisplayColumn("subject")
  .withDB("mail", mailDb, v.inFolder("mail", "fld_tasks"))
```

**Private folders over a shared database, with documents of several databases:**

```ts
const myFolders = await tenant.openDB("myfolders");            // personal database
const filing = myFolders.filing("work");
await filing.add({ dbId: "mail", docId: mailId }, "fld_customerA");
await filing.add({ dbId: "crm", docId: dealId }, "fld_customerA");

const view = await VirtualViewFactory.createView()
  .withFilingStore("work", filing)
  .addCategoryColumn("folder", { expression: v.folders("work") })
  .addSortedColumn("title")
  .withDB("mail", mailDb, v.inFolder("work"))
  .withDB("crm", crmDb, v.inFolder("work"))
  .buildAndUpdate();
view.bindTo(mailDb);                                            // binds "myfolders" as well
view.bindTo(crmDb);
```

**Provider folders stored in the document plus local folders**, as one category:

```ts
.addCategoryColumn("folder", {
  expression: v.union(v.split(v.field("mailboxTags"), "|"), v.folders("mail")),
})
```

**Reading several folders as one list** (e.g. "inbox of all accounts"):

```ts
const nav = VirtualViewFactory.createMergedNavigator(view, [["acc1/inbox"], ["acc2/INBOX"], ["inbox"]]);
let page = nav.readForward({ limit: 50 });
while (page.nextKey) {
  page = nav.readForward({ after: page.nextKey, limit: 50 });
}
```

## Folders in Haven apps

Haven apps use the same model through the app SDK: `database.filing(store)` for filing, `createViewNavigator({ filingStores: [...] })` for views with `v.folders()` / `v.inFolder()`, and the navigator option `rootCategoryPaths` for reading several folders as one list. Apps name databases by their binding id; Haven stores the physical identity. See the SDK documentation for details and examples.

## When not to use folders

If the membership belongs to the document anyway — a status, a category the author sets, folders mirrored from an IMAP/JMAP/Exchange server that rewrites the document on every server-side move — keep it as a field of the document and categorize by that field. Folders are for filing that is *about* documents: by people who may not edit them, across databases, privately, or without touching large documents.
