# VirtualView - Hierarchical Document Views for MindooDB

## Overview

VirtualView is a powerful indexing system that creates hierarchical, sorted views of documents from one or more MindooDB instances. It enables categorized browsing, sorting, navigation, and aggregation (totals) across documents—inspired by the proven view paradigm from HCL Notes/Domino.

## Origin and Inspiration

The VirtualView system is inspired by and adapted from **Karsten Lehmann's Domino JNA project** ([GitHub: klehmann/domino-jna](https://github.com/klehmann/domino-jna)), which provides a high-performance Java API for HCL Notes/Domino. The Domino JNA VirtualView implementation demonstrated how to create dynamic, in-memory views that can:

- Combine documents from multiple databases
- Apply custom categorization and sorting
- Compute category totals (SUM, AVERAGE)
- Navigate hierarchically through the view structure

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

VirtualView can span across different MindooTenants, enabling powerful cross-tenant analytics and reporting scenarios.

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
2. **Process changes**: On `update()`, the provider calls `iterateChangesSince()` to get changed documents
3. **Generate changes**: For each document:
   - If deleted or no longer matches filter → add to removals
   - If new or modified → compute column values, add to additions
4. **Apply changes**: `VirtualView.applyChanges()` removes old entries, adds new ones, cleans up empty categories
5. **Update totals**: Category totals are incrementally updated (add new values, subtract removed values)

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
view.update(): Promise<void>             // Update all data providers
view.updateOrigin(origin): Promise<void> // Update specific provider
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

VirtualView maintains an in-memory tree structure. For large document sets:
- Each entry consumes memory for column values and tree pointers
- Category entries are shared across documents with the same category value
- Consider limiting the number of columns to reduce per-entry memory

### Incremental Updates

- Incremental updates are O(changed documents), not O(total documents)
- Empty category cleanup is automatic after removals
- Totals are updated incrementally (add/subtract), not recomputed

### Large Views

For very large views (millions of documents):
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
