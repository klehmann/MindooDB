/**
 * VirtualView system for creating hierarchical, sorted views of MindooDB documents.
 * 
 * This module provides:
 * - VirtualView: Main class for creating categorized, sorted views
 * - VirtualViewColumn: Column definitions with sorting, categories, and totals
 * - VirtualViewNavigator: Navigation through the view tree structure
 * - MindooDBVirtualViewDataProvider: Data provider using MindooDB.processChangesSince
 * - VirtualViewFactory: Builder pattern for easy view construction
 * 
 * Example usage:
 * ```typescript
 * import {
 *   VirtualViewFactory,
 *   VirtualViewColumn,
 *   ColumnSorting,
 *   TotalMode,
 * } from "./indexing/virtualviews";
 * 
 * // Create a view with categories and sorting
 * const view = await VirtualViewFactory.createView()
 *   .addCategoryColumn("department", { title: "Department" })
 *   .addCategoryColumn("year", { sorting: ColumnSorting.DESCENDING })
 *   .addSortedColumn("lastName")
 *   .addDisplayColumn("firstName")
 *   .addTotalColumn("salary", TotalMode.SUM)
 *   .withDB("mydb", myDatabase, (doc) => doc.getData().type === "employee")
 *   .buildAndUpdate();
 * 
 * // Navigate the view
 * const nav = VirtualViewFactory.createNavigator(view)
 *   .hideEmptyCategories()
 *   .expandAll()
 *   .build();
 * 
 * for await (const entry of nav.entriesForward()) {
 *   console.log(entry.getPositionStr(), entry.getColumnValues());
 * }
 * ```
 */

// Types and enums
export {
  ColumnSorting,
  TotalMode,
  CategorizationStyle,
  WithCategories,
  WithDocuments,
  SelectedOnly,
  LOW_SORTVAL,
  HIGH_SORTVAL,
  LOW_ORIGIN,
  HIGH_ORIGIN,
  ORIGIN_VIRTUALVIEW,
  type ScopedDocId,
  createScopedDocId,
  scopedDocIdKey,
  parseScopedDocIdKey,
  type ColumnValueFunction,
  type DocumentFilterFunction,
  type EntryData,
  getDataTypeSortOrder,
  compareValues,
} from "./types";

// Core classes
export { VirtualView } from "./VirtualView";
export { VirtualViewColumn, type VirtualViewColumnOptions } from "./VirtualViewColumn";
export { VirtualViewEntryData } from "./VirtualViewEntryData";
export { VirtualViewDataChange } from "./VirtualViewDataChange";
export { ViewEntrySortKey } from "./ViewEntrySortKey";
export { ViewEntrySortKeyComparator } from "./ViewEntrySortKeyComparator";

// Navigation
export { VirtualViewNavigator } from "./VirtualViewNavigator";

// Data providers
export { type IVirtualViewDataProvider } from "./IVirtualViewDataProvider";
export {
  MindooDBVirtualViewDataProvider,
  type MindooDBVirtualViewDataProviderOptions,
} from "./MindooDBVirtualViewDataProvider";

// Access control
export {
  type IViewEntryAccessCheck,
  AllowAllAccessCheck,
  CallbackAccessCheck,
} from "./IViewEntryAccessCheck";

// Factory and builders
export {
  VirtualViewFactory,
  VirtualViewBuilder,
  VirtualViewNavigatorBuilder,
} from "./VirtualViewFactory";
