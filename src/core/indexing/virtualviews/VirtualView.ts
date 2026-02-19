import { VirtualViewColumn } from "./VirtualViewColumn";
import { VirtualViewEntryData } from "./VirtualViewEntryData";
import { VirtualViewDataChange } from "./VirtualViewDataChange";
import { ViewEntrySortKey } from "./ViewEntrySortKey";
import { ViewEntrySortKeyComparator } from "./ViewEntrySortKeyComparator";
import type { IVirtualViewDataProvider } from "./IVirtualViewDataProvider";
import {
  CategorizationStyle,
  ColumnSorting,
  TotalMode,
  ORIGIN_VIRTUALVIEW,
  scopedDocIdKey,
  createScopedDocId,
} from "./types";
import type { LocalCacheStore } from "../../cache/LocalCacheStore";
import type { ICacheable } from "../../cache/CacheManager";
import type { CacheManager } from "../../cache/CacheManager";

/**
 * VirtualView creates a hierarchical, sorted view of documents from one or more MindooDB instances.
 * Documents are organized into categories (tree structure) with sorting and optional totals.
 */
export class VirtualView {
  /** All columns in the view */
  private readonly columns: VirtualViewColumn[];
  
  /** Category columns (in order) */
  private readonly categoryColumns: VirtualViewColumn[];
  
  /** Non-category sorted columns */
  private readonly sortColumns: VirtualViewColumn[];
  
  /** Columns with total aggregation */
  private readonly totalColumns: VirtualViewColumn[];
  
  /** Columns with value functions */
  private readonly valueFunctionColumns: VirtualViewColumn[];
  
  /** Descending flags for document sort columns */
  private readonly docOrderDescending: boolean[];
  
  /** Whether the view has any total columns */
  private readonly viewHasTotalColumns: boolean;
  
  /** Categorization style (categories before/after documents) */
  private categorizationStyle: CategorizationStyle = CategorizationStyle.DOCUMENT_THEN_CATEGORY;
  
  /** Whether the index has been built */
  private indexBuilt: boolean = false;
  
  /** Root entry of the view tree */
  private rootEntry: VirtualViewEntryData | null = null;
  
  /** Counter for generating category IDs */
  private categoryIdCounter: number = 4;
  
  /** Map of origin:docId -> list of entry occurrences */
  private entriesByDocId: Map<string, VirtualViewEntryData[]> = new Map();
  
  /** Data providers */
  private dataProviderByOrigin: Map<string, IVirtualViewDataProvider> = new Map();
  
  /** Entries pending sibling index recalculation */
  private pendingSiblingIndexFlush: Map<string, VirtualViewEntryData[]> = new Map();
  
  /** Last index update timestamp */
  private lastIndexUpdateTime: number | null = null;

  // Local cache support
  private cacheManager: CacheManager | null = null;
  private viewCacheId: string | null = null;
  private viewCacheVersion: string | null = null;
  private isDirty: boolean = false;

  constructor(columns: VirtualViewColumn[]) {
    this.columns = [...columns];
    this.categoryColumns = [];
    this.sortColumns = [];
    this.totalColumns = [];
    this.valueFunctionColumns = [];

    // Categorize columns
    for (const column of columns) {
      if (column.isCategory) {
        this.categoryColumns.push(column);
      } else if (column.sorting !== ColumnSorting.NONE) {
        this.sortColumns.push(column);
      }
      
      if (column.valueFunction) {
        this.valueFunctionColumns.push(column);
      }
      
      if (column.totalMode !== TotalMode.NONE) {
        this.totalColumns.push(column);
      }
    }

    // Build descending flags for document columns
    this.docOrderDescending = this.sortColumns.map(
      col => col.sorting === ColumnSorting.DESCENDING
    );
    
    // If no sort columns, add a default ascending flag
    if (this.docOrderDescending.length === 0) {
      this.docOrderDescending.push(false);
    }
    
    this.viewHasTotalColumns = this.totalColumns.length > 0;
  }

  /**
   * Set the categorization style
   */
  setCategorizationStyle(style: CategorizationStyle): this {
    if (!this.indexBuilt) {
      this.categorizationStyle = style;
    }
    return this;
  }

  getCategorizationStyle(): CategorizationStyle {
    return this.categorizationStyle;
  }

  getColumns(): VirtualViewColumn[] {
    return [...this.columns];
  }

  getCategoryColumns(): VirtualViewColumn[] {
    return [...this.categoryColumns];
  }

  getSortColumns(): VirtualViewColumn[] {
    return [...this.sortColumns];
  }

  getTotalColumns(): VirtualViewColumn[] {
    return [...this.totalColumns];
  }

  /**
   * Add a data provider to the view
   */
  addDataProvider(provider: IVirtualViewDataProvider): this {
    const origin = provider.getOrigin();
    if (this.dataProviderByOrigin.has(origin)) {
      throw new Error(`Data provider with origin '${origin}' already added`);
    }
    this.dataProviderByOrigin.set(origin, provider);
    return this;
  }

  /**
   * Get all data providers
   */
  getDataProviders(): IterableIterator<IVirtualViewDataProvider> {
    return this.dataProviderByOrigin.values();
  }

  /**
   * Get a data provider by origin
   */
  getDataProvider(origin: string): IVirtualViewDataProvider | undefined {
    return this.dataProviderByOrigin.get(origin);
  }

  /**
   * Update all data providers (async)
   */
  async update(): Promise<void> {
    for (const provider of this.dataProviderByOrigin.values()) {
      await provider.update();
    }
  }

  /**
   * Update a specific data provider by origin
   */
  async updateOrigin(origin: string): Promise<void> {
    const provider = this.dataProviderByOrigin.get(origin);
    if (provider) {
      await provider.update();
    }
  }

  /**
   * Get the root entry of the view
   */
  getRoot(): VirtualViewEntryData {
    if (!this.rootEntry) {
      // Create root comparator
      let rootChildComparator: ViewEntrySortKeyComparator;
      if (this.categoryColumns.length === 0) {
        rootChildComparator = new ViewEntrySortKeyComparator(
          this.categorizationStyle,
          false,
          this.docOrderDescending
        );
      } else {
        rootChildComparator = new ViewEntrySortKeyComparator(
          this.categorizationStyle,
          this.categoryColumns[0].sorting === ColumnSorting.DESCENDING,
          this.docOrderDescending
        );
      }

      const rootSortKey = ViewEntrySortKey.createSortKey(true, [], ORIGIN_VIRTUALVIEW, "root");
      const rootDocId = this.createNewCategoryId();
      
      this.rootEntry = new VirtualViewEntryData(
        this,
        null,
        ORIGIN_VIRTUALVIEW,
        rootDocId,
        rootSortKey,
        rootChildComparator
      );
      this.rootEntry.setColumnValues({});
      this.rootEntry.setSiblingIndex(0);
    }
    return this.rootEntry;
  }

  /**
   * Generate a new category ID
   */
  private createNewCategoryId(): string {
    this.categoryIdCounter += 4;
    return `cat_${this.categoryIdCounter}`;
  }

  /**
   * Get the last index update time
   */
  getLastModifiedTime(): number | null {
    return this.lastIndexUpdateTime;
  }

  /**
   * Apply changes from a data provider
   */
  applyChanges(change: VirtualViewDataChange): void {
    this.indexBuilt = true;
    let indexChanged = false;

    const origin = change.origin;
    const categoryEntriesToCheck: VirtualViewEntryData[] = [];

    // Collect all doc IDs to remove (both explicit removals and additions that need re-adding)
    const docIdsToRemove = new Set<string>();
    for (const docId of change.getRemovals()) {
      docIdsToRemove.add(docId);
    }
    for (const docId of change.getAdditions().keys()) {
      docIdsToRemove.add(docId);
    }

    // Process removals
    for (const docId of docIdsToRemove) {
      const scopedKey = scopedDocIdKey(createScopedDocId(origin, docId));
      const entries = this.entriesByDocId.get(scopedKey);
      
      if (entries) {
        for (const entry of entries) {
          // Don't remove our own entries (categories, root)
          if (entry.isCategory() || entry.origin === ORIGIN_VIRTUALVIEW) {
            continue;
          }

          const parentEntry = entry.getParent();
          if (parentEntry && parentEntry.removeChildEntry(entry.getSortKey())) {
            indexChanged = true;
            
            // Update totals
            if (this.viewHasTotalColumns) {
              this.removeDocFromTotalsOfParents(entry);
            }
            
            // Update descendant counts
            this.removeDocFromCountsOfParents(entry);
            
            // Mark for sibling index recalculation
            this.markEntryForSiblingIndexFlush(parentEntry);
            
            // Check if parent category is now empty
            if (parentEntry.isCategory()) {
              categoryEntriesToCheck.push(parentEntry);
            }
          }
        }
        this.entriesByDocId.delete(scopedKey);
      }
    }

    // Process additions
    const root = this.getRoot();
    for (const [docId, entryData] of change.getAdditions()) {
      const columnValues = entryData.values;

      // Compute value function columns
      for (const column of this.valueFunctionColumns) {
        if (column.valueFunction) {
          // Note: For additions, we don't have the original MindooDoc
          // The data provider should have already computed all values
          // This is for consistency if values depend on each other
        }
      }

      // Check if document should be accepted (can be overridden)
      if (!this.isAccepted(origin, docId, columnValues)) {
        continue;
      }

      // Add entry to the view
      const addedEntries = this.addEntry(origin, docId, columnValues, root, this.categoryColumns);
      if (addedEntries.length > 0) {
        indexChanged = true;
        const scopedKey = scopedDocIdKey(createScopedDocId(origin, docId));
        this.entriesByDocId.set(scopedKey, addedEntries);
      }
    }

    // Clean up empty category entries
    for (const categoryEntry of categoryEntriesToCheck) {
      if (categoryEntry.getChildCount() === 0) {
        this.removeCategoryFromParent(categoryEntry);
        indexChanged = true;
      }
    }

    // Recalculate sibling indexes
    this.processPendingSiblingIndexUpdates();

    if (indexChanged) {
      this.lastIndexUpdateTime = Date.now();
      this.markViewDirty();
    }
  }

  /**
   * Override this method to filter entries
   */
  protected isAccepted(
    origin: string,
    docId: string,
    columnValues: Record<string, unknown>
  ): boolean {
    return true;
  }

  /**
   * Add an entry to the view hierarchy
   */
  private addEntry(
    origin: string,
    docId: string,
    columnValues: Record<string, unknown>,
    targetParent: VirtualViewEntryData,
    remainingCategoryColumns: VirtualViewColumn[]
  ): VirtualViewEntryData[] {
    const createdEntries: VirtualViewEntryData[] = [];

    // If no more category columns, add as document entry
    if (remainingCategoryColumns.length === 0) {
      const docSortValues: unknown[] = [];
      for (const sortColumn of this.sortColumns) {
        const value = columnValues[sortColumn.name];
        // Use first value if array
        docSortValues.push(this.getFirstListValue(value));
      }

      const sortKey = ViewEntrySortKey.createSortKey(false, docSortValues, origin, docId);
      const childComparator = new ViewEntrySortKeyComparator(
        this.categorizationStyle,
        false,
        this.docOrderDescending
      );

      const newDocEntry = new VirtualViewEntryData(
        this,
        targetParent,
        origin,
        docId,
        sortKey,
        childComparator
      );
      newDocEntry.setColumnValues(columnValues);

      if (targetParent.addChildEntry(newDocEntry)) {
        // Update counts in parents
        this.addDocToCountsOfParents(newDocEntry);
        
        // Update totals in parents
        if (this.viewHasTotalColumns) {
          this.addDocToTotalsOfParents(newDocEntry);
        }
        
        // Mark for sibling index recalculation
        this.markEntryForSiblingIndexFlush(targetParent);
      }

      createdEntries.push(newDocEntry);
      return createdEntries;
    }

    // Process category column
    const currCategoryColumn = remainingCategoryColumns[0];
    const remainingColumns = remainingCategoryColumns.slice(1);
    const itemName = currCategoryColumn.name;
    const valueForColumn = columnValues[itemName];

    // Handle multiple category values (e.g., [cat1, cat2])
    let categoryValues: unknown[];
    if (
      valueForColumn === null ||
      valueForColumn === undefined ||
      valueForColumn === "" ||
      (Array.isArray(valueForColumn) && valueForColumn.length === 0)
    ) {
      categoryValues = [null];
    } else if (Array.isArray(valueForColumn)) {
      categoryValues = valueForColumn;
    } else {
      categoryValues = [valueForColumn];
    }

    // Create entries for each category value
    for (const categoryValue of categoryValues) {
      // Handle backslash-separated categories (e.g., "2024\03")
      if (typeof categoryValue === "string" && categoryValue.includes("\\")) {
        const parts = categoryValue.split("\\");
        let currentParent = targetParent;

        for (let indentLevel = 0; indentLevel < parts.length; indentLevel++) {
          const subCat = parts[indentLevel];
          const isLastPart = indentLevel === parts.length - 1;
          const subCatValue = subCat === "" ? null : subCat;

          const categorySortKey = ViewEntrySortKey.createSortKey(
            true,
            [subCatValue],
            ORIGIN_VIRTUALVIEW,
            ""
          );

          let existingCategory = currentParent.getChildEntry(categorySortKey);
          if (!existingCategory) {
            // Determine sort direction for children
            let childCategoryDescending: boolean;
            if (!isLastPart) {
              childCategoryDescending = currCategoryColumn.sorting === ColumnSorting.DESCENDING;
            } else {
              const nextCatColumn = remainingColumns.length > 0 ? remainingColumns[0] : null;
              childCategoryDescending = nextCatColumn?.sorting === ColumnSorting.DESCENDING;
            }

            const childComparator = new ViewEntrySortKeyComparator(
              this.categorizationStyle,
              childCategoryDescending,
              this.docOrderDescending
            );

            const newCategoryId = this.createNewCategoryId();
            existingCategory = new VirtualViewEntryData(
              this,
              currentParent,
              ORIGIN_VIRTUALVIEW,
              newCategoryId,
              categorySortKey,
              childComparator
            );

            const catColValues: Record<string, unknown> = {};
            if (subCatValue !== null) {
              catColValues[itemName] = subCatValue;
            }
            existingCategory.setIndentLevels(indentLevel);
            existingCategory.setColumnValues(catColValues);

            if (currentParent.addChildEntry(existingCategory)) {
              // Update descendant counts in parents
              let parent: VirtualViewEntryData | null = currentParent;
              while (parent !== null) {
                parent.incrementDescendantCount(true);
                parent = parent.getParent();
              }
            }

            const scopedKey = scopedDocIdKey(createScopedDocId(ORIGIN_VIRTUALVIEW, newCategoryId));
            this.entriesByDocId.set(scopedKey, [existingCategory]);
            this.markEntryForSiblingIndexFlush(currentParent);
          }

          currentParent = existingCategory;
        }

        // Continue with remaining categories under the last subcategory
        const addedEntries = this.addEntry(origin, docId, columnValues, currentParent, remainingColumns);
        createdEntries.push(...addedEntries);
      } else {
        // Simple category value
        const categorySortKey = ViewEntrySortKey.createSortKey(
          true,
          [categoryValue],
          ORIGIN_VIRTUALVIEW,
          ""
        );

        let existingCategory = targetParent.getChildEntry(categorySortKey);
        if (!existingCategory) {
          const nextCatColumn = remainingColumns.length > 0 ? remainingColumns[0] : null;
          const childCategoryDescending = nextCatColumn?.sorting === ColumnSorting.DESCENDING;

          const childComparator = new ViewEntrySortKeyComparator(
            this.categorizationStyle,
            childCategoryDescending,
            this.docOrderDescending
          );

          const newCategoryId = this.createNewCategoryId();
          existingCategory = new VirtualViewEntryData(
            this,
            targetParent,
            ORIGIN_VIRTUALVIEW,
            newCategoryId,
            categorySortKey,
            childComparator
          );

          const catColValues: Record<string, unknown> = {};
          if (categoryValue !== null) {
            catColValues[itemName] = categoryValue;
          }
          existingCategory.setColumnValues(catColValues);

          if (targetParent.addChildEntry(existingCategory)) {
            // Update descendant counts in parents
            let parent: VirtualViewEntryData | null = targetParent;
            while (parent !== null) {
              parent.incrementDescendantCount(true);
              parent = parent.getParent();
            }
          }

          const scopedKey = scopedDocIdKey(createScopedDocId(ORIGIN_VIRTUALVIEW, newCategoryId));
          this.entriesByDocId.set(scopedKey, [existingCategory]);
          this.markEntryForSiblingIndexFlush(targetParent);
        }

        // Continue with remaining categories
        const addedEntries = this.addEntry(origin, docId, columnValues, existingCategory, remainingColumns);
        createdEntries.push(...addedEntries);
      }
    }

    return createdEntries;
  }

  private getFirstListValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.length > 0 ? value[0] : null;
    }
    return value;
  }

  private addDocToCountsOfParents(docEntry: VirtualViewEntryData): void {
    let parent = docEntry.getParent();
    while (parent !== null) {
      parent.incrementDescendantCount(false);
      parent = parent.getParent();
    }
  }

  private removeDocFromCountsOfParents(docEntry: VirtualViewEntryData): void {
    let parent = docEntry.getParent();
    while (parent !== null) {
      parent.decrementDescendantCount(false);
      parent = parent.getParent();
    }
  }

  private addDocToTotalsOfParents(docEntry: VirtualViewEntryData): void {
    const docTotalValues: Map<string, number> = new Map();
    for (const totalColumn of this.totalColumns) {
      const itemName = totalColumn.name;
      const docVal = docEntry.getAsNumber(itemName, null);
      if (docVal !== null) {
        docTotalValues.set(itemName, docVal);
      }
    }

    let parent = docEntry.getParent();
    while (parent !== null) {
      for (const [itemName, value] of docTotalValues) {
        parent.addTotalValue(itemName, value);
      }
      this.computeTotalColumnValues(parent);
      parent = parent.getParent();
    }
  }

  private removeDocFromTotalsOfParents(docEntry: VirtualViewEntryData): void {
    const docTotalValues: Map<string, number> = new Map();
    for (const totalColumn of this.totalColumns) {
      const itemName = totalColumn.name;
      const docVal = docEntry.getAsNumber(itemName, null);
      if (docVal !== null) {
        docTotalValues.set(itemName, docVal);
      }
    }

    let parent = docEntry.getParent();
    while (parent !== null) {
      for (const [itemName, value] of docTotalValues) {
        parent.addTotalValue(itemName, -value);
      }
      this.computeTotalColumnValues(parent);
      parent = parent.getParent();
    }
  }

  private computeTotalColumnValues(catEntry: VirtualViewEntryData): void {
    for (const totalColumn of this.totalColumns) {
      const itemName = totalColumn.name;
      const totalValue = catEntry.getTotalValue(itemName);

      if (totalValue === null) {
        // Remove from column values if no total
        catEntry.setColumnValue(itemName, undefined);
      } else {
        if (totalColumn.totalMode === TotalMode.SUM) {
          catEntry.setColumnValue(itemName, totalValue);
        } else if (totalColumn.totalMode === TotalMode.AVERAGE) {
          const docCount = catEntry.getDescendantDocumentCount();
          if (docCount === 0) {
            catEntry.setColumnValue(itemName, undefined);
          } else {
            catEntry.setColumnValue(itemName, totalValue / docCount);
          }
        }
      }
    }
  }

  private removeCategoryFromParent(entry: VirtualViewEntryData): void {
    const parent = entry.getParent();
    if (parent) {
      if (parent.removeChildEntry(entry.getSortKey())) {
        this.markEntryForSiblingIndexFlush(parent);

        // Remove from lookup
        const scopedKey = scopedDocIdKey(createScopedDocId(entry.origin, entry.docId));
        this.entriesByDocId.delete(scopedKey);

        // Recursively check if parent is now empty
        if (parent.isCategory() && parent.getChildCount() === 0) {
          this.removeCategoryFromParent(parent);
        }
      }
    }
  }

  private markEntryForSiblingIndexFlush(entry: VirtualViewEntryData): void {
    const key = scopedDocIdKey(createScopedDocId(entry.origin, entry.docId));
    let entries = this.pendingSiblingIndexFlush.get(key);
    if (!entries) {
      entries = [];
      this.pendingSiblingIndexFlush.set(key, entries);
    }
    if (!entries.includes(entry)) {
      entries.push(entry);
    }
  }

  private processPendingSiblingIndexUpdates(): void {
    for (const entries of this.pendingSiblingIndexFlush.values()) {
      for (const entry of entries) {
        const children = entry.getChildEntries();
        let pos = 1;
        for (const child of children) {
          child.setSiblingIndex(pos++);
        }
      }
    }
    this.pendingSiblingIndexFlush.clear();
  }

  /**
   * Get all entries for a document ID
   */
  getEntries(origin: string, docId: string): VirtualViewEntryData[] {
    const scopedKey = scopedDocIdKey(createScopedDocId(origin, docId));
    return this.entriesByDocId.get(scopedKey) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Local cache support (ICacheable)
  // ---------------------------------------------------------------------------

  /**
   * Configure caching for this VirtualView and attempt to restore from cache.
   *
   * @param cacheManager The CacheManager to register with
   * @param viewId       Stable identifier for this view
   * @param version      Schema/config version for cache invalidation
   * @returns `true` if the view was successfully restored from cache
   */
  async setCacheManager(cacheManager: CacheManager, viewId: string, version: string): Promise<boolean> {
    this.cacheManager = cacheManager;
    this.viewCacheId = viewId;
    this.viewCacheVersion = version;
    cacheManager.register(this as unknown as ICacheable);
    return this.restoreFromCache(cacheManager.getStore());
  }

  getCachePrefix(): string {
    return `${this.viewCacheId ?? "unknown"}/${this.viewCacheVersion ?? "0"}`;
  }

  hasDirtyState(): boolean {
    return this.isDirty;
  }

  clearDirty(): void {
    this.isDirty = false;
  }

  /**
   * Export the view state to the cache store.
   */
  async flushToCache(store: LocalCacheStore): Promise<number> {
    const state = this.exportCacheState();
    await store.put("vv", this.getCachePrefix(), state);
    return 1;
  }

  /**
   * Serialize the entire tree structure for caching (version 2).
   * Each node stores its sort key, column values, counts, totals,
   * and children — so restoration is O(n) without re-sorting.
   */
  private exportCacheState(): Uint8Array {
    const root = this.getRoot();

    const providerStates: Record<string, unknown> = {};
    for (const [origin, provider] of this.dataProviderByOrigin) {
      if ("exportCacheState" in provider && typeof (provider as any).exportCacheState === "function") {
        providerStates[origin] = (provider as any).exportCacheState();
      }
    }

    const snapshot = {
      version: 2,
      categoryIdCounter: this.categoryIdCounter,
      categorizationStyle: this.categorizationStyle,
      docOrderDescending: [...this.docOrderDescending],
      providerStates,
      tree: this.serializeNode(root),
    };

    return new TextEncoder().encode(JSON.stringify(snapshot));
  }

  private serializeNode(entry: VirtualViewEntryData): unknown {
    const sk = entry.getSortKey();
    const comp = entry.getChildrenComparator();

    const children = entry.getChildEntries();
    const serializedChildren = children.map(c => this.serializeNode(c));

    const node: Record<string, unknown> = {
      o: entry.origin,
      d: entry.docId,
      sk: { c: sk.isCategory, v: [...sk.values], o: sk.origin, d: sk.docId },
      cv: entry.getColumnValues(),
      il: entry.getIndentLevels(),
      si: entry.getSiblingIndex(),
      cod: comp.getCategoryOrderDescending(),
      cnt: [
        entry.getChildCount(),
        entry.getChildCategoryCount(),
        entry.getChildDocumentCount(),
        entry.getDescendantCount(),
        entry.getDescendantDocumentCount(),
        entry.getDescendantCategoryCount(),
      ],
      ch: serializedChildren,
    };

    const tv = entry.getTotalValues();
    if (tv && Object.keys(tv).length > 0) {
      node.tv = tv;
    }

    return node;
  }

  /**
   * Attempt to restore the view from cache. Returns true on success.
   */
  async restoreFromCache(store: LocalCacheStore): Promise<boolean> {
    if (!this.viewCacheId || !this.viewCacheVersion) return false;

    try {
      const bytes = await store.get("vv", this.getCachePrefix());
      if (!bytes) return false;

      const snapshot = JSON.parse(new TextDecoder().decode(bytes));

      if (snapshot.version === 2) {
        return this.restoreFromTreeSnapshot(snapshot);
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Restore the full tree structure directly from a version-2 snapshot.
   * O(n) — no re-sorting, no category re-creation, no count recalculation.
   */
  private restoreFromTreeSnapshot(snapshot: any): boolean {
    this.categoryIdCounter = snapshot.categoryIdCounter ?? 4;

    if (snapshot.categorizationStyle) {
      this.categorizationStyle = snapshot.categorizationStyle as CategorizationStyle;
    }

    const docOrderDesc: boolean[] = snapshot.docOrderDescending ?? [...this.docOrderDescending];

    if (snapshot.providerStates) {
      for (const [origin, state] of Object.entries(snapshot.providerStates)) {
        const provider = this.dataProviderByOrigin.get(origin);
        if (provider && "importCacheState" in provider && typeof (provider as any).importCacheState === "function") {
          (provider as any).importCacheState(state);
        }
      }
    }

    const treeData = snapshot.tree;
    if (!treeData) return false;

    this.rootEntry = this.deserializeNode(treeData, null, docOrderDesc);
    this.indexBuilt = true;
    return true;
  }

  private deserializeNode(
    data: any,
    parent: VirtualViewEntryData | null,
    docOrderDesc: boolean[],
  ): VirtualViewEntryData {
    const sk = ViewEntrySortKey.createSortKey(
      data.sk.c,
      data.sk.v,
      data.sk.o,
      data.sk.d,
    );
    const comparator = new ViewEntrySortKeyComparator(
      this.categorizationStyle,
      data.cod,
      docOrderDesc,
    );

    const entry = new VirtualViewEntryData(
      this,
      parent,
      data.o,
      data.d,
      sk,
      comparator,
    );
    entry.setColumnValues(data.cv ?? {});
    entry.setIndentLevels(data.il ?? 0);
    entry.setSiblingIndex(data.si ?? 0);

    if (data.tv) {
      entry._restoreTotalValues(data.tv);
    }

    const cnt: number[] = data.cnt ?? [0, 0, 0, 0, 0, 0];
    entry._restoreCounts(cnt[0], cnt[1], cnt[2], cnt[3], cnt[4], cnt[5]);

    const scopedKey = scopedDocIdKey(createScopedDocId(data.o, data.d));
    const existing = this.entriesByDocId.get(scopedKey);
    if (existing) {
      existing.push(entry);
    } else {
      this.entriesByDocId.set(scopedKey, [entry]);
    }

    if (data.ch) {
      for (const childData of data.ch) {
        const child = this.deserializeNode(childData, entry, docOrderDesc);
        entry._addRestoredChild(child);
      }
    }

    return entry;
  }

  /**
   * Mark the view as dirty (call after applyChanges).
   */
  private markViewDirty(): void {
    this.isDirty = true;
    this.cacheManager?.markDirty();
  }
}
