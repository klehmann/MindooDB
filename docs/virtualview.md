# VirtualView - Hierarchical Document Views for MindooDB

## Overview

VirtualView is a powerful indexing system that creates hierarchical, sorted views of documents from one or more MindooDB instances. It enables categorized browsing, sorting, navigation, and aggregation (totals) across documents—inspired by the proven view paradigm from HCL Notes/Domino.

## Origin and Inspiration

The VirtualView system is inspired by and adapted from **Karsten Lehmann's Domino JNA project** ([GitHub: klehmann/domino-jna](https://github.com/klehmann/domino-jna)), which provides a high-performance Java API for HCL Notes/Domino. The Domino JNA VirtualView implementation demonstrated how to create dynamic views that can:

- Combine documents from multiple databases
- Apply custom categorization and sorting
- Compute category totals (SUM, AVERAGE)
- Navigate hierarchically through the view structure
- Exact key and range lookups

This concept has been ported to TypeScript for the MindooDB ecosystem, adapting the architecture to use:
- MindooDB's `iterateChangesSince()` for incremental updates
- TypeScript functions instead of Domino formula language
- Simple callback-based access control instead of Domino ACLs

## Key Concepts

### What is a VirtualView?

A VirtualView is an **in-memory tree structure** that organizes documents into categories. Think of it as a dynamic table of contents for your documents:

```
📁 Sales (3 documents, Total: $250,000)
  📁 2024 (2 documents, Total: $150,000)
    📄 Acme Corp Deal - $100,000
    📄 Beta Inc Deal - $50,000
  📁 2025 (1 document, Total: $100,000)
    📄 Gamma LLC Deal - $100,000
📁 Engineering (2 documents, Total: $180,000)
  📄 Project Alpha - $80,000
  📄 Project Beta - $100,000
```

### Key Features

| Feature | Description |
|---------|-------------|
| **Categorization** | Group documents into hierarchical categories based on field values |
| **Sorting** | Sort categories and documents by one or more columns (ascending/descending) |
| **Totals** | Compute SUM or AVERAGE aggregations on category rows |
| **Multi-Database** | Combine documents from multiple MindooDB instances (different "origins") |
| **Multi-Tenant** | Span views across different MindooTenants for cross-tenant reporting |
| **Incremental Updates** | Efficiently update views using `iterateChangesSince()` |
| **Navigation** | Traverse the view hierarchy with expand/collapse and selection support |
| **Access Control** | Filter visible entries via callback-based access checks |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          VirtualView                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │ VirtualViewColumn│  │ VirtualViewColumn│  │ VirtualViewColumn│   │
│  │ (Category: Dept) │  │ (Sort: Name)     │  │ (Total: Salary)  │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                        Root Entry                            │   │
│  │  ├── Category: Sales                                         │   │
│  │  │   ├── Document: doc1 (origin: db1)                        │   │
│  │  │   └── Document: doc2 (origin: db2)                        │   │
│  │  └── Category: Engineering                                   │   │
│  │      └── Document: doc3 (origin: db1)                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         ▲                              ▲
         │                              │
┌─────────────────────┐      ┌─────────────────────┐
│ MindooDBDataProvider│      │ MindooDBDataProvider│
│   origin: "db1"     │      │   origin: "db2"     │
│   db: mindooDB1     │      │   db: mindooDB2     │
└─────────────────────┘      └─────────────────────┘
         ▲                              ▲
         │                              │
┌─────────────────────┐      ┌─────────────────────┐
│     MindooDB 1      │      │     MindooDB 2      │
│  (e.g., Tenant A)   │      │  (e.g., Tenant B)   │
└─────────────────────┘      └─────────────────────┘
```

## Getting Started

### Basic Example: Simple Categorized View

```typescript
import {
  VirtualViewFactory,
  VirtualViewColumn,
  ColumnSorting,
  TotalMode,
} from "./indexing/virtualviews";

// Create a view that categorizes employees by department
const view = await VirtualViewFactory.createView()
  // Category column: groups documents by department
  .addCategoryColumn("department", {
    title: "Department",
    sorting: ColumnSorting.ASCENDING,
  })
  // Sorted column: sorts employees within each department
  .addSortedColumn("lastName", ColumnSorting.ASCENDING)
  .addSortedColumn("firstName", ColumnSorting.ASCENDING)
  // Display column: shown but not used for sorting
  .addDisplayColumn("email")
  // Total column: computes sum of salaries per category
  .addTotalColumn("salary", TotalMode.SUM)
  // Add a MindooDB as data source
  .withDB("employees", employeeDatabase, (doc) => {
    // Filter: only include employee documents
    return doc.getData().type === "employee";
  })
  // Build and fetch initial data
  .buildAndUpdate();

// Navigate the view
const nav = VirtualViewFactory.createNavigator(view)
  .expandAll()
  .build();

// Iterate through all entries
for await (const entry of nav.entriesForward()) {
  const indent = "  ".repeat(entry.getLevel());
  if (entry.isCategory()) {
    const totalSalary = entry.getColumnValue("salary");
    console.log(`${indent}📁 ${entry.getCategoryValue()} (Total: $${totalSalary})`);
  } else {
    const values = entry.getColumnValues();
    console.log(`${indent}📄 ${values.lastName}, ${values.firstName} - $${values.salary}`);
  }
}
```

### Output

```
📁 Engineering (Total: $260000)
  📄 Johnson, Alice - $130000
  📄 Smith, Bob - $130000
📁 Sales (Total: $200000)
  📄 Brown, Charlie - $100000
  📄 Williams, Diana - $100000
```

## Multi-Database Views

One of VirtualView's most powerful features is the ability to combine documents from multiple MindooDB instances into a single unified view. Each source is identified by an "origin" string.

### Example: Cross-Database Product Catalog

```typescript
import { VirtualViewFactory, ColumnSorting } from "./indexing/virtualviews";

// Assume we have two product databases
const usProductsDB: MindooDB = /* US products */;
const euProductsDB: MindooDB = /* EU products */;

// Create a unified view across both regions
const unifiedCatalog = await VirtualViewFactory.createView()
  .addCategoryColumn("category", { sorting: ColumnSorting.ASCENDING })
  .addCategoryColumn("subcategory", { sorting: ColumnSorting.ASCENDING })
  .addSortedColumn("productName", ColumnSorting.ASCENDING)
  .addDisplayColumn("sku")
  .addDisplayColumn("price")
  // Value function to compute region from origin
  .addColumnFromOptions({
    name: "region",
    valueFunction: (doc, values, origin) => {
      return origin === "us-products" ? "United States" : "Europe";
    },
  })
  // Add US products database
  .withDB("us-products", usProductsDB, (doc) => doc.getData().type === "product")
  // Add EU products database
  .withDB("eu-products", euProductsDB, (doc) => doc.getData().type === "product")
  .buildAndUpdate();

// The view now contains products from both databases
// Each entry has an "origin" property indicating which database it came from
```

## Multi-Tenant Views

VirtualView can span across different MindooTenants, enabling powerful cross-tenant analytics and reporting scenarios (e.g. two organisations have their own tenant and share data in a third one).

### Example: Cross-Tenant Reporting Dashboard

```typescript
import { VirtualViewFactory, ColumnSorting, TotalMode } from "./indexing/virtualviews";

// Get databases from different tenants
async function createCrossOrganizationReport(
  tenantDirectory: MindooTenantDirectory,
  tenantIds: string[]
): Promise<VirtualView> {
  const builder = VirtualViewFactory.createView()
    .addCategoryColumn("organization", { 
      title: "Organization",
      sorting: ColumnSorting.ASCENDING 
    })
    .addCategoryColumn("quarter", { 
      title: "Quarter",
      sorting: ColumnSorting.DESCENDING 
    })
    .addSortedColumn("projectName", ColumnSorting.ASCENDING)
    .addTotalColumn("revenue", TotalMode.SUM)
    .addTotalColumn("expenses", TotalMode.SUM);

  // Add each tenant's database as a data provider
  for (const tenantId of tenantIds) {
    const tenant = await tenantDirectory.getTenant(tenantId);
    const db = await tenant.getDatabase("projects");
    
    builder.withMindooDB({
      origin: `tenant-${tenantId}`,
      db,
      filterFunction: (doc) => doc.getData().type === "project",
    });
  }

  return builder.buildAndUpdate();
}

// Usage
const crossTenantView = await createCrossOrganizationReport(
  tenantDirectory,
  ["acme-corp", "beta-inc", "gamma-llc"]
);

// Navigate the consolidated view
const nav = VirtualViewFactory.createNavigator(crossTenantView)
  .expandAll()
  .build();

for await (const entry of nav.entriesForward()) {
  if (entry.isCategory()) {
    console.log(`${entry.getCategoryValue()}: Revenue $${entry.getColumnValue("revenue")}`);
  }
}
```

## Column Types and Value Functions

### Column Types

| Type | Factory Method | Description |
|------|---------------|-------------|
| Category | `addCategoryColumn()` | Groups documents into hierarchical categories |
| Sorted | `addSortedColumn()` | Sorts documents within categories |
| Display | `addDisplayColumn()` | Shown but not used for categorization or sorting |
| Total | `addTotalColumn()` | Computes aggregations (SUM, AVERAGE) |

### Value Functions

Value functions compute column values dynamically from document data:

```typescript
const view = VirtualViewFactory.createView()
  .addCategoryColumn("yearMonth", {
    // Compute year-month from a date field
    valueFunction: (doc, values, origin) => {
      const date = new Date(doc.getData().createdAt);
      return `${date.getFullYear()}\\${String(date.getMonth() + 1).padStart(2, "0")}`;
    },
    sorting: ColumnSorting.DESCENDING,
  })
  .addDisplayColumn("fullName", {
    // Combine first and last name
    valueFunction: (doc, values, origin) => {
      const data = doc.getData();
      return `${data.firstName} ${data.lastName}`;
    },
  })
  .addDisplayColumn("age", {
    // Compute age from birth date
    valueFunction: (doc, values, origin) => {
      const birthDate = new Date(doc.getData().birthDate);
      const today = new Date();
      return Math.floor((today.getTime() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    },
  })
  // ... data providers
  .build();
```

### Declarative Expression Columns

As a JSON-serializable alternative to JS value functions, columns can carry an
`expression` in the MindooDB expression language (built with `createViewLanguage()`
or parsed from formula text):

```typescript
import { createViewLanguage } from "mindoodb";
const v = createViewLanguage<{ firstName: string; lastName: string }>();

new VirtualViewColumn({
  name: "fullName",
  expression: v.concat(v.field("firstName"), " ", v.field("lastName")),
});
```

When both are set, `valueFunction` wins for document-backed providers. Summary-backed
providers (see below) only evaluate `expression` — JS functions are rejected there
because no materialized document exists to pass them. Expression columns make a whole
view definition serializable, the basis for view designs stored/synchronized as data.

### Ephemeral Summary-Backed Views

For ad-hoc UI grids with dynamic re-sorting, `db.queryView()` builds an ephemeral
VirtualView over the document summary buffer instead of materialized documents —
constructing it is a pure in-memory sort, and `resort()` swaps column sets without
reloading anything. Like persistent views, ephemeral views can span multiple
databases and tenants: `queryViewAcross([{ db: dbA }, { db: dbB }], definition)`
adds one summary-backed data provider per source under its own origin. See
[Ad-hoc Queries](adhoc-queries.md) for the full picture (summary configuration,
coverage rules, cost model).

### Nested Categories with Backslash Separator

Use backslash (`\`) in category values to create nested subcategories:

```typescript
const view = VirtualViewFactory.createView()
  .addCategoryColumn("datePath", {
    valueFunction: (doc, values, origin) => {
      const date = new Date(doc.getData().createdAt);
      // Returns "2024\Q1\January" -> creates 3-level category hierarchy
      const quarter = `Q${Math.ceil((date.getMonth() + 1) / 3)}`;
      const month = date.toLocaleString("default", { month: "long" });
      return `${date.getFullYear()}\\${quarter}\\${month}`;
    },
    sorting: ColumnSorting.DESCENDING,
  })
  .addSortedColumn("title")
  .build();

// Results in:
// 📁 2024
//   📁 Q4
//     📁 December
//       📄 Document 1
//       📄 Document 2
//     📁 November
//       📄 Document 3
```

## Navigation

### VirtualViewNavigator

The navigator provides methods to traverse the view hierarchy:

```typescript
const nav = VirtualViewFactory.createNavigator(view)
  .hideEmptyCategories()  // Don't show categories with no documents
  .build();

// Expand/collapse control
nav.expandAll();                    // Expand all categories
nav.collapseAll();                  // Collapse all categories
nav.expandToLevel(2);               // Expand to level 2
nav.expand("virtualview", "cat_8"); // Expand specific category
nav.collapse("virtualview", "cat_8");

// Position-based navigation
nav.gotoFirst();                    // Go to first entry
nav.gotoLast();                     // Go to last entry
nav.gotoNext();                     // Go to next entry
nav.gotoPrev();                     // Go to previous entry
nav.gotoPos("1.2.3");               // Go to position "1.2.3"

// Get current entry
const entry = nav.getCurrentEntry();
console.log(entry?.getPositionStr());  // "1.2.3"
console.log(entry?.getLevel());        // 2
console.log(entry?.isCategory());      // true/false
```

### Filtering Navigation

```typescript
// Categories only
const catNav = VirtualViewFactory.createNavigator(view)
  .categoriesOnly()
  .build();

// Documents only
const docNav = VirtualViewFactory.createNavigator(view)
  .documentsOnly()
  .build();

// Start from a specific category
const subNav = VirtualViewFactory.createNavigator(view)
  .fromCategory("Sales\\2024")
  .build();
```

### Selection

```typescript
// Select entries
nav.select("db1", "doc123", true);  // Select with parent categories
nav.deselect("db1", "doc123");
nav.selectAllEntries();
nav.deselectAllEntries();

// Check selection
const isSelected = nav.isSelected("db1", "doc123");

// Iterate selected entries only
for await (const entry of nav.entriesForward(SelectedOnly.YES)) {
  console.log(`Selected: ${entry.docId}`);
}
```

## Access Control

Implement custom visibility checks using the access control interface:

```typescript
import { VirtualViewFactory, CallbackAccessCheck } from "./indexing/virtualviews";

// Simple callback-based access check
const nav = VirtualViewFactory.createNavigator(view)
  .withAccessCallback((nav, entry) => {
    // Only show entries the current user has access to
    if (entry.isCategory()) {
      return true; // Always show categories (will be hidden if empty)
    }
    
    // Check document-level permissions
    const allowedOrigins = getCurrentUserAllowedOrigins();
    return allowedOrigins.includes(entry.origin);
  })
  .hideEmptyCategories() // Hide categories that become empty due to access control
  .build();

// Or implement the full interface for complex scenarios
class RoleBasedAccessCheck implements IViewEntryAccessCheck {
  constructor(private userRoles: string[]) {}
  
  isVisible(nav: VirtualViewNavigator, entry: VirtualViewEntryData): boolean {
    if (entry.isCategory()) {
      return true;
    }
    
    const requiredRole = entry.getColumnValue("requiredRole") as string;
    return !requiredRole || this.userRoles.includes(requiredRole);
  }
}

const secureNav = VirtualViewFactory.createNavigator(view)
  .withAccessCheck(new RoleBasedAccessCheck(["admin", "manager"]))
  .hideEmptyCategories()
  .build();
```

## Incremental Updates

VirtualView uses `MindooDB.iterateChangesSince()` for efficient incremental updates:

```typescript
// Initial build
const view = await VirtualViewFactory.createView()
  .addCategoryColumn("status")
  .addSortedColumn("name")
  .withDB("tasks", taskDatabase)
  .buildAndUpdate();

// Later: refresh the view with new changes
// This only processes documents that changed since last update
await view.update();

// Or update a specific origin only
await view.updateOrigin("tasks");
```

### How Incremental Updates Work

1. **Data provider tracks cursor**: Each `MindooDBVirtualViewDataProvider` maintains a cursor from the last processed position
2. **Process changes**: On `update()`, the provider calls `iterateChangesSince()` to get changed documents. The iterator prefetches upcoming documents in parallel and emits deleted/inaccessible documents as lightweight tombstones (never materialized), so removals are cheap
3. **Generate changes**: For each document:
   - If deleted or no longer matches filter → add to removals
   - If new or modified → compute column values, add to additions
4. **Apply changes**: `VirtualView.applyChanges()` removes old entries, adds new ones, cleans up empty categories
5. **Update totals**: Category totals are incrementally updated (add new values, subtract removed values)

### Column Scoping (`includeAllDocumentFields`)

By default, the data provider stores **only the fields referenced by the view's columns** in each view entry. This keeps memory usage and the serialized view cache small, especially for documents with large payloads.

Consumers that need free-form access to arbitrary document fields on view entries (e.g. a formula language evaluating fields at read time) can opt back into the legacy behavior:

```typescript
const view = await VirtualViewFactory.createView()
  .addCategoryColumn("status")
  .addSortedColumn("name")
  .withMindooDB({
    origin: "tasks",
    db: taskDatabase,
    includeAllDocumentFields: true, // copy all non-underscore doc fields into entries
  })
  .buildAndUpdate();
```

### Progress Reporting & Interruptible Updates

Long-running update runs (e.g. the initial population of a view over a large database) can be observed and interrupted. `view.update()`, `view.updateOrigin()`, and `provider.update()` accept an optional `VirtualViewUpdateOptions` object:

```typescript
const controller = new AbortController();

await view.update({
  // Apply accumulated changes to the view after this many processed
  // documents (default: 100). Use Infinity for one atomic apply at the end.
  applyBatchSize: 200,

  // Called at every batch boundary and once at the end of the run.
  // Return false to stop cleanly after the current batch.
  onProgress: ({ processed, total, origin }) => {
    progressDialog.update(processed, total);
    return !progressDialog.cancelRequested;
  },

  // Alternative cancellation mechanism, checked at every batch boundary.
  signal: controller.signal,
});
```

Key behaviors:

- **`total`** is computed once at the start of the run via `db.countChangesSince(cursor)` — an O(log n) binary search on the change index, so progress reporting adds no meaningful overhead. Changes arriving mid-run are not included in `total`.
- **Interruption is always clean**: the current batch is applied to the view before the run stops, so the view state and the provider cursor stay consistent. Nothing is half-applied.
- **Resumption is automatic**: the provider cursor points at the last applied document, so the next `update()` call continues exactly where the interrupted run stopped — no work is repeated. This also holds across app restarts when the provider state is persisted via `exportCacheState()` / `importCacheState()` (which the view cache does automatically).

`countChangesSince(cursor)` is also available directly on the database for building "N documents pending" indicators before starting an update.

### Live Views (`bindTo` / `onDidUpdate`)

Instead of polling, a view can bind to the database's change feed and update itself:

```typescript
const offUpdate = view.onDidUpdate(({ addedCount, removedCount }) => {
  rerenderUI();   // fires after every applied change batch
});
const unbind = view.bindTo(db);   // auto-runs update() on coalesced change events
// ...
unbind();
offUpdate();
```

`bindTo` uses coalesced scheduling — while an update runs, further change events only
set a pending flag and one follow-up update runs afterwards, so there is never an
update backlog. Ephemeral views (`db.queryView()`) support the same API. See
[Ad-hoc Queries — Reactive updates](adhoc-queries.md#reactive-updates) for the
underlying change-listener contract and live queries (`db.queryLive()`).

### View Cache Flush Behavior

When a `CacheManager` is attached via `view.setCacheManager()`, the view periodically serializes its full tree to the local cache store. Because full-tree serialization is expensive, flushes are throttled: a minimum interval (default **15 seconds**, configurable via `setCacheManager(..., { minCacheFlushIntervalMs })`) must elapse between two serializations. A flush attempt inside that window is deferred — the view stays dirty and the flush lands on a later cycle. Shutdown paths (`CacheManager.dispose()` / `deregister()`) always flush immediately, so no state is lost on close.

## API Reference

### VirtualViewFactory

```typescript
// Create a view builder
VirtualViewFactory.createView(): VirtualViewBuilder

// Create a navigator builder
VirtualViewFactory.createNavigator(view: VirtualView): VirtualViewNavigatorBuilder

// Create a simple navigator (all categories and documents)
VirtualViewFactory.createSimpleNavigator(view: VirtualView): VirtualViewNavigator
```

### VirtualViewBuilder

```typescript
builder
  .addCategoryColumn(name, options?)     // Add category column
  .addSortedColumn(name, sorting?, options?)  // Add sorted column
  .addDisplayColumn(name, options?)      // Add display column
  .addTotalColumn(name, totalMode, options?)  // Add total column
  .addColumnFromOptions(options)         // Add column with full options
  .withCategorizationStyle(style)        // Categories before/after documents
  .withDB(origin, db, filterFunction?)   // Add MindooDB data source
  .withMindooDB(options)                 // Add MindooDB with full options
  .withDataProvider(provider)            // Add custom data provider
  .build(): VirtualView                  // Build the view
  .buildAndUpdate(): Promise<VirtualView>  // Build and fetch data
```

### VirtualView

```typescript
view.getColumns(): VirtualViewColumn[]
view.getCategoryColumns(): VirtualViewColumn[]
view.getSortColumns(): VirtualViewColumn[]
view.getTotalColumns(): VirtualViewColumn[]
view.getRoot(): VirtualViewEntryData
view.update(options?): Promise<void>             // Update all data providers
view.updateOrigin(origin, options?): Promise<void> // Update specific provider
// options: { applyBatchSize?, onProgress?, signal? } — see
// "Progress Reporting & Interruptible Updates" above
view.applyChanges(change): void          // Apply a VirtualViewDataChange
view.getEntries(origin, docId): VirtualViewEntryData[]
```

### VirtualViewNavigatorBuilder

```typescript
navBuilder
  .categoriesOnly()           // Include only categories
  .documentsOnly()            // Include only documents
  .hideEmptyCategories()      // Hide categories with no documents
  .withAccessCheck(check)     // Set access control check
  .withAccessCallback(fn)     // Set callback-based access check
  .fromCategory(path)         // Start from category (e.g., "Sales\\2024")
  .fromEntry(entry)           // Start from specific entry
  .build(): VirtualViewNavigator
```

### VirtualViewNavigator

```typescript
// Navigation
nav.gotoFirst(): boolean
nav.gotoLast(): boolean
nav.gotoNext(): boolean
nav.gotoPrev(): boolean
nav.gotoNextSibling(): boolean
nav.gotoPrevSibling(): boolean
nav.gotoParent(): boolean
nav.gotoFirstChild(): boolean
nav.gotoPos(posStr): boolean      // e.g., "1.2.3"

// Current entry
nav.getCurrentEntry(): VirtualViewEntryData | null

// Iteration
nav.entriesForward(selectedOnly?): AsyncGenerator<VirtualViewEntryData>
nav.entriesBackward(selectedOnly?): AsyncGenerator<VirtualViewEntryData>

// Expand/collapse
nav.expandAll(): this
nav.collapseAll(): this
nav.expandToLevel(level): this
nav.expand(origin, docId): this
nav.collapse(origin, docId): this
nav.isExpanded(entry): boolean

// Selection
nav.select(origin, docId, selectParentCategories?): this
nav.deselect(origin, docId): this
nav.selectAllEntries(): this
nav.deselectAllEntries(): this
nav.isSelected(origin, docId): boolean

// Child access
nav.childDocuments(entry, descending?): VirtualViewEntryData[]
nav.childCategories(entry, descending?): VirtualViewEntryData[]
nav.childEntries(entry, descending?): VirtualViewEntryData[]
```

### VirtualViewEntryData

```typescript
entry.origin: string              // Data source identifier
entry.docId: string               // Document ID
entry.isCategory(): boolean
entry.isDocument(): boolean
entry.isRoot(): boolean
entry.getLevel(): number          // Depth in tree (0 = first level)
entry.getPosition(): number[]     // [1, 2, 3]
entry.getPositionStr(): string    // "1.2.3"
entry.getSiblingIndex(): number   // Position among siblings (1-based)
entry.getSiblingCount(): number
entry.getIndentLevels(): number   // For subcategories

// Column values
entry.getColumnValue(name): unknown
entry.getColumnValues(): Record<string, unknown>
entry.getAsString(name, default): string
entry.getAsNumber(name, default): number | null
entry.getCategoryValue(): unknown  // First category column value

// Counts
entry.getChildCount(): number
entry.getChildCategoryCount(): number
entry.getChildDocumentCount(): number
entry.getDescendantCount(): number
entry.getDescendantDocumentCount(): number
entry.getDescendantCategoryCount(): number

// Totals (for categories)
entry.getTotalValue(itemName): number | null

// Tree navigation
entry.getParent(): VirtualViewEntryData | null
entry.getChildEntries(): VirtualViewEntryData[]
entry.getChildCategories(): VirtualViewEntryData[]
entry.getChildDocuments(): VirtualViewEntryData[]
```

## Enums

```typescript
enum ColumnSorting {
  NONE = "none",
  ASCENDING = "ascending",
  DESCENDING = "descending",
}

enum TotalMode {
  NONE = "none",
  SUM = "sum",
  AVERAGE = "average",
}

enum CategorizationStyle {
  DOCUMENT_THEN_CATEGORY = "document_then_category",  // Documents first (default)
  CATEGORY_THEN_DOCUMENT = "category_then_document",  // Categories first
}

enum WithCategories { YES = "yes", NO = "no" }
enum WithDocuments { YES = "yes", NO = "no" }
enum SelectedOnly { YES = "yes", NO = "no" }
```

## Performance Considerations

### Memory Usage

VirtualView maintains an in-memory tree structure (on-disk storage is planned).
For large document sets:
- Each entry consumes memory for column values and tree pointers
- Category entries are shared across documents with the same category value
- Consider limiting the number of columns to reduce per-entry memory

### Incremental Updates

- Incremental updates are O(changed documents), not O(total documents)
- Empty category cleanup is automatic after removals
- Totals are updated incrementally (add/subtract), not recomputed

### Large Views

For very large views:
- Consider filtering to reduce document count
- Use incremental updates rather than full rebuilds
- Consider multiple smaller views instead of one large view

## Comparison with Map/Reduce

VirtualView and Map/Reduce serve different purposes:

| Aspect | VirtualView | Map/Reduce |
|--------|-------------|------------|
| **Structure** | Hierarchical tree | Flat key-value pairs |
| **Navigation** | Parent-child traversal | Key-based lookup |
| **Categories** | Built-in, hierarchical | Must be implemented |
| **Totals** | Built-in SUM, AVERAGE | Custom reduce functions |
| **Use Case** | Browsing, drill-down | Aggregations, analytics |
| **UI Pattern** | Tree view, outline | Tables, charts |

VirtualView is ideal for:
- Document browsers with expandable categories
- Report outlines with drill-down
- Cross-database consolidated views
- Multi-tenant dashboards

## File Structure

```
src/indexing/virtualviews/
├── index.ts                           # All exports
├── types.ts                           # Enums and shared types
├── VirtualView.ts                     # Main view class
├── VirtualViewColumn.ts               # Column definition
├── VirtualViewEntryData.ts            # Tree node
├── VirtualViewDataChange.ts           # Change batch
├── ViewEntrySortKey.ts                # Sort key
├── ViewEntrySortKeyComparator.ts      # Comparator
├── VirtualViewNavigator.ts            # Navigation
├── IVirtualViewDataProvider.ts        # Provider interface
├── MindooDBVirtualViewDataProvider.ts # MindooDB provider
├── IViewEntryAccessCheck.ts           # Access control interface
└── VirtualViewFactory.ts              # Builder pattern
```
