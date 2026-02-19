import { ViewEntrySortKey } from "./ViewEntrySortKey";
import { ViewEntrySortKeyComparator } from "./ViewEntrySortKeyComparator";
import { LOW_SORTVAL, HIGH_SORTVAL, LOW_ORIGIN, HIGH_ORIGIN } from "./types";
import type { VirtualView } from "./VirtualView";

/**
 * Entry in a VirtualView, representing a document or category.
 * Forms a tree structure with sorted child entries.
 */
export class VirtualViewEntryData {
  /** Reference to the parent view */
  private readonly parentView: VirtualView;
  
  /** Parent entry in the tree (null for root) */
  private _parent: VirtualViewEntryData | null;
  
  /** Origin identifier (which data provider) */
  readonly origin: string;
  
  /** Document ID (UNID) - for categories, this is a generated ID */
  readonly docId: string;
  
  /** Sort key for ordering within parent */
  private readonly sortKey: ViewEntrySortKey;
  
  /** Comparator for ordering child entries */
  private readonly childrenComparator: ViewEntrySortKeyComparator;
  
  /** Column values for this entry */
  private columnValues: Map<string, unknown> = new Map();
  
  /** Sorted child entries by sort key */
  private childEntriesBySortKey: Map<string, VirtualViewEntryData> = new Map();
  
  /** Cached array of sorted child entries (invalidated on changes) */
  private sortedChildrenCache: VirtualViewEntryData[] | null = null;
  
  /** Sibling index within parent (1-based) */
  private siblingIndex: number = 0;
  
  /** Cached level in the tree (distance from root) */
  private _level: number | null = null;
  
  /** Indent levels for subcategories (e.g., "2024\03" has indent 1 for "03") */
  private indentLevels: number = 0;
  
  /** Cached position array */
  private _position: number[] | null = null;
  
  /** Cached position string */
  private _positionStr: string | null = null;

  // Counts
  /** Number of direct children */
  private _childCount: number = 0;
  /** Number of direct child categories */
  private _childCategoryCount: number = 0;
  /** Number of direct child documents */
  private _childDocumentCount: number = 0;
  /** Total number of descendants */
  private _descendantCount: number = 0;
  /** Total number of descendant documents */
  private _descendantDocumentCount: number = 0;
  /** Total number of descendant categories */
  private _descendantCategoryCount: number = 0;

  // Totals for category entries
  private totalValues: Map<string, number> = new Map();

  constructor(
    parentView: VirtualView,
    parent: VirtualViewEntryData | null,
    origin: string,
    docId: string,
    sortKey: ViewEntrySortKey,
    childrenComparator: ViewEntrySortKeyComparator
  ) {
    this.parentView = parentView;
    this._parent = parent;
    this.origin = origin;
    this.docId = docId;
    this.sortKey = sortKey;
    this.childrenComparator = childrenComparator;
  }

  // Getters
  getParentView(): VirtualView {
    return this.parentView;
  }

  getParent(): VirtualViewEntryData | null {
    return this._parent;
  }

  getSortKey(): ViewEntrySortKey {
    return this.sortKey;
  }

  getChildrenComparator(): ViewEntrySortKeyComparator {
    return this.childrenComparator;
  }

  // Type checks
  isCategory(): boolean {
    return this.sortKey.isCategory;
  }

  isDocument(): boolean {
    return !this.sortKey.isCategory;
  }

  isRoot(): boolean {
    return this._parent === null;
  }

  // Count getters
  getChildCount(): number {
    return this._childCount;
  }

  getChildCategoryCount(): number {
    return this._childCategoryCount;
  }

  getChildDocumentCount(): number {
    return this._childDocumentCount;
  }

  getDescendantCount(): number {
    return this._descendantCount;
  }

  getDescendantDocumentCount(): number {
    return this._descendantDocumentCount;
  }

  getDescendantCategoryCount(): number {
    return this._descendantCategoryCount;
  }

  getSiblingCount(): number {
    return this._parent ? this._parent.getChildCount() : 0;
  }

  // Column values
  getColumnValue(name: string): unknown {
    return this.columnValues.get(name);
  }

  getColumnValues(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.columnValues) {
      result[key] = value;
    }
    return result;
  }

  setColumnValues(values: Record<string, unknown>): void {
    this.columnValues.clear();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        this.columnValues.set(key, value);
      }
    }
  }

  setColumnValue(name: string, value: unknown): void {
    if (value === undefined) {
      this.columnValues.delete(name);
    } else {
      this.columnValues.set(name, value);
    }
  }

  getAsString(name: string, defaultValue: string): string {
    const val = this.columnValues.get(name);
    if (val === null || val === undefined) return defaultValue;
    return String(val);
  }

  getAsNumber(name: string, defaultValue: number | null): number | null {
    const val = this.columnValues.get(name);
    if (val === null || val === undefined) return defaultValue;
    if (typeof val === "number") return val;
    const parsed = parseFloat(String(val));
    return isNaN(parsed) ? defaultValue : parsed;
  }

  getAsStringList(name: string, defaultValue: string[] | null): string[] | null {
    const val = this.columnValues.get(name);
    if (val === null || val === undefined) return defaultValue;
    if (Array.isArray(val)) {
      return val.map(v => String(v));
    }
    return [String(val)];
  }

  // Category value (first sort key value for categories)
  getCategoryValue(): unknown {
    if (this.isCategory()) {
      const values = this.sortKey.values;
      return values.length > 0 ? values[0] : null;
    }
    return null;
  }

  // Child entry management
  /**
   * Get all child entries as a sorted array
   */
  getChildEntries(): VirtualViewEntryData[] {
    if (this.sortedChildrenCache === null) {
      const entries = Array.from(this.childEntriesBySortKey.values());
      entries.sort((a, b) => this.childrenComparator.compare(a.sortKey, b.sortKey));
      this.sortedChildrenCache = entries;
    }
    return this.sortedChildrenCache;
  }

  /**
   * Get child entry by sort key
   */
  getChildEntry(sortKey: ViewEntrySortKey): VirtualViewEntryData | undefined {
    return this.childEntriesBySortKey.get(sortKey.toKey());
  }

  /**
   * Check if a child entry exists
   */
  hasChildEntry(sortKey: ViewEntrySortKey): boolean {
    return this.childEntriesBySortKey.has(sortKey.toKey());
  }

  /**
   * Add a child entry
   * @returns true if the entry was added (didn't exist before)
   */
  addChildEntry(entry: VirtualViewEntryData): boolean {
    const key = entry.sortKey.toKey();
    if (this.childEntriesBySortKey.has(key)) {
      return false;
    }
    this.childEntriesBySortKey.set(key, entry);
    this.sortedChildrenCache = null; // Invalidate cache
    this._childCount++;
    if (entry.isCategory()) {
      this._childCategoryCount++;
    } else {
      this._childDocumentCount++;
    }
    return true;
  }

  /**
   * Remove a child entry
   * @returns true if the entry was removed
   */
  removeChildEntry(sortKey: ViewEntrySortKey): boolean {
    const key = sortKey.toKey();
    const entry = this.childEntriesBySortKey.get(key);
    if (!entry) {
      return false;
    }
    this.childEntriesBySortKey.delete(key);
    this.sortedChildrenCache = null; // Invalidate cache
    this._childCount--;
    if (entry.isCategory()) {
      this._childCategoryCount--;
    } else {
      this._childDocumentCount--;
    }
    return true;
  }

  /**
   * Get child categories only
   */
  getChildCategories(): VirtualViewEntryData[] {
    return this.getChildEntries().filter(e => e.isCategory());
  }

  /**
   * Get child documents only
   */
  getChildDocuments(): VirtualViewEntryData[] {
    return this.getChildEntries().filter(e => e.isDocument());
  }

  /**
   * Get child entries in a range (for range scans)
   */
  getChildEntriesInRange(
    isCategory: boolean,
    startValue: unknown,
    endValue: unknown,
    descending: boolean = false
  ): VirtualViewEntryData[] {
    const entries = this.getChildEntries().filter(e => {
      if (e.isCategory() !== isCategory) return false;
      const val = e.sortKey.values.length > 0 ? e.sortKey.values[0] : null;
      
      // Simple range check (could be optimized with binary search)
      if (startValue !== LOW_SORTVAL && val !== null && val !== undefined) {
        if (typeof val === "string" && typeof startValue === "string") {
          if (val.localeCompare(startValue, undefined, { sensitivity: "base" }) < 0) return false;
        } else if (typeof val === "number" && typeof startValue === "number") {
          if (val < startValue) return false;
        }
      }
      if (endValue !== HIGH_SORTVAL && val !== null && val !== undefined) {
        if (typeof val === "string" && typeof endValue === "string") {
          if (val.localeCompare(endValue, undefined, { sensitivity: "base" }) > 0) return false;
        } else if (typeof val === "number" && typeof endValue === "number") {
          if (val > endValue) return false;
        }
      }
      return true;
    });
    
    return descending ? entries.reverse() : entries;
  }

  // Sibling index
  getSiblingIndex(): number {
    return this.siblingIndex;
  }

  setSiblingIndex(index: number): void {
    if (this.siblingIndex !== index) {
      this.siblingIndex = index;
      // Invalidate cached position
      this._position = null;
      this._positionStr = null;
    }
  }

  // Indent levels
  getIndentLevels(): number {
    return this.indentLevels;
  }

  setIndentLevels(levels: number): void {
    this.indentLevels = levels;
  }

  // Level in tree
  getLevel(): number {
    if (this._level === null) {
      this._level = -1;
      let parent = this._parent;
      while (parent !== null) {
        this._level++;
        parent = parent._parent;
      }
    }
    return this._level;
  }

  // Position
  getPosition(): number[] {
    if (this._position === null) {
      if (this.isRoot()) {
        this._position = [0];
      } else {
        const positions: number[] = [this.siblingIndex];
        let parent = this._parent;
        while (parent !== null) {
          const parentSiblingIdx = parent.siblingIndex;
          parent = parent._parent;
          if (parent !== null) {
            // Ignore root sibling position
            positions.unshift(parentSiblingIdx);
          }
        }
        this._position = positions;
      }
    }
    return this._position;
  }

  getPositionStr(): string {
    if (this._positionStr === null) {
      this._positionStr = this.getPosition().join(".");
    }
    return this._positionStr;
  }

  // Descendant count management
  incrementDescendantCount(isCategory: boolean): void {
    this._descendantCount++;
    if (isCategory) {
      this._descendantCategoryCount++;
    } else {
      this._descendantDocumentCount++;
    }
  }

  decrementDescendantCount(isCategory: boolean): void {
    this._descendantCount--;
    if (isCategory) {
      this._descendantCategoryCount--;
    } else {
      this._descendantDocumentCount--;
    }
  }

  // Total values (for category aggregations)
  addTotalValue(itemName: string, value: number): number {
    const key = itemName.toLowerCase();
    const current = this.totalValues.get(key) ?? 0;
    const newValue = current + value;
    this.totalValues.set(key, newValue);
    return newValue;
  }

  getTotalValue(itemName: string): number | null {
    const key = itemName.toLowerCase();
    return this.totalValues.get(key) ?? null;
  }

  getTotalValues(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.totalValues) {
      result[key] = value;
    }
    return result;
  }

  // Invalidate caches when structure changes
  invalidatePositionCache(): void {
    this._position = null;
    this._positionStr = null;
    this._level = null;
  }

  /** @internal Add a pre-built child during cache restoration (bypasses incremental count tracking). */
  _addRestoredChild(entry: VirtualViewEntryData): void {
    this.childEntriesBySortKey.set(entry.getSortKey().toKey(), entry);
    this.sortedChildrenCache = null;
  }

  /** @internal Set count values directly during cache restoration. */
  _restoreCounts(
    cc: number, ccc: number, cdc: number,
    dc: number, ddc: number, dcc: number,
  ): void {
    this._childCount = cc;
    this._childCategoryCount = ccc;
    this._childDocumentCount = cdc;
    this._descendantCount = dc;
    this._descendantDocumentCount = ddc;
    this._descendantCategoryCount = dcc;
  }

  /** @internal Set total values directly during cache restoration. */
  _restoreTotalValues(totals: Record<string, number>): void {
    this.totalValues.clear();
    for (const [key, value] of Object.entries(totals)) {
      this.totalValues.set(key, value);
    }
  }

  toString(): string {
    const type = this.isDocument() ? "document" : this.isCategory() ? "category" : "root";
    return `VirtualViewEntry [pos=${this.getPositionStr()}, level=${this.getLevel()}, type=${type}, origin=${this.origin}, docId=${this.docId}, columnValues=${JSON.stringify(this.getColumnValues())}]`;
  }
}
