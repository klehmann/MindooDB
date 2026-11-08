import { ViewEntrySortKey } from "./ViewEntrySortKey";
import { ViewEntrySortKeyComparator } from "./ViewEntrySortKeyComparator";
import { LOW_SORTVAL, HIGH_SORTVAL, LOW_ORIGIN, HIGH_ORIGIN, baseSensitivityCollator } from "./types";
import type { VirtualView } from "./VirtualView";

/**
 * State only entries with children need (categories and the root): the
 * child index, counts and totals. Document entries — the vast majority —
 * never allocate it.
 */
class ChildState {
  /** Child entries by sort key */
  readonly childEntriesBySortKey: Map<string, VirtualViewEntryData> = new Map();
  /** Cached array of sorted child entries (maintained incrementally once built) */
  sortedChildrenCache: VirtualViewEntryData[] | null = null;
  /** Number of direct children */
  childCount: number = 0;
  /** Number of direct child categories */
  childCategoryCount: number = 0;
  /** Number of direct child documents */
  childDocumentCount: number = 0;
  /** Total number of descendants */
  descendantCount: number = 0;
  /** Total number of descendant documents */
  descendantDocumentCount: number = 0;
  /** Total number of descendant categories */
  descendantCategoryCount: number = 0;
  /** Totals for category aggregations (lower-cased column name -> sum) */
  totalValues: Map<string, number> | null = null;
}

const EMPTY_CHILDREN: readonly VirtualViewEntryData[] = Object.freeze([]);
const EMPTY_VALUES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Store column values as an ordinary object: entries of one view get the
 * same keys in the same order, so V8 gives them one shared hidden class
 * and stores the values inline — much smaller than a Map per entry.
 * `__proto__` is defined as an own property instead of being assigned.
 */
function toValueRecord(values: Record<string, unknown>): Record<string, unknown> {
  let record: Record<string, unknown> | null = null;
  for (const key in values) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const value = values[key];
    if (value === undefined) continue;
    if (record === null) record = {};
    if (key === "__proto__") {
      Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
    } else {
      record[key] = value;
    }
  }
  return record ?? (EMPTY_VALUES as Record<string, unknown>);
}

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

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
  
  /** Column values for this entry (treated as immutable; replaced on change) */
  private columnValues: Record<string, unknown> = EMPTY_VALUES as Record<string, unknown>;

  /**
   * Encryption key id of the source document at the time this entry was
   * inserted.
   *
   * Only meaningful for document entries (categories and root leave it
   * `undefined`). Stored so `VirtualView.purgeEntriesByDecryptionKeyId`
   * can locate and remove every entry tied to a revoked key without
   * having to re-read the underlying database. This value is never part
   * of the public column data exposed to view consumers.
   */
  private decryptionKeyId?: string;
  
  /** Children, counts and totals; created with the first child (see {@link ChildState}) */
  private children: ChildState | null = null;
  
  /** Sibling index within parent (1-based) */
  private siblingIndex: number = 0;
  
  /** Cached level in the tree (distance from root) */
  private _level: number | null = null;
  
  /** Indent levels for subcategories (e.g., "2024\03" has indent 1 for "03") */
  private indentLevels: number = 0;
  

  constructor(
    parentView: VirtualView,
    parent: VirtualViewEntryData | null,
    origin: string,
    docId: string,
    sortKey: ViewEntrySortKey,
    childrenComparator: ViewEntrySortKeyComparator,
    decryptionKeyId?: string,
  ) {
    this.parentView = parentView;
    this._parent = parent;
    this.origin = origin;
    this.docId = docId;
    this.sortKey = sortKey;
    this.childrenComparator = childrenComparator;
    this.decryptionKeyId = decryptionKeyId;
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

  /**
   * Encryption key id of the source document, or `undefined` for
   * non-document entries (categories, root, or document entries created
   * before this field was introduced).
   */
  getDecryptionKeyId(): string | undefined {
    return this.decryptionKeyId;
  }

  /**
   * Update the cached encryption key id. Intended for restore paths and
   * tests; ordinary insert/update flows set the value via the constructor.
   */
  setDecryptionKeyId(decryptionKeyId: string | undefined): void {
    this.decryptionKeyId = decryptionKeyId;
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
    return this.children?.childCount ?? 0;
  }

  getChildCategoryCount(): number {
    return this.children?.childCategoryCount ?? 0;
  }

  getChildDocumentCount(): number {
    return this.children?.childDocumentCount ?? 0;
  }

  getDescendantCount(): number {
    return this.children?.descendantCount ?? 0;
  }

  getDescendantDocumentCount(): number {
    return this.children?.descendantDocumentCount ?? 0;
  }

  getDescendantCategoryCount(): number {
    return this.children?.descendantCategoryCount ?? 0;
  }

  private childState(): ChildState {
    return (this.children ??= new ChildState());
  }

  getSiblingCount(): number {
    return this._parent ? this._parent.getChildCount() : 0;
  }

  // Column values
  getColumnValue(name: string): unknown {
    return hasOwn(this.columnValues, name) ? this.columnValues[name] : undefined;
  }

  getColumnValues(): Record<string, unknown> {
    // Spread defines own properties (also `__proto__`); callers may mutate the copy.
    return { ...this.columnValues };
  }

  setColumnValues(values: Record<string, unknown>): void {
    this.columnValues = toValueRecord(values);
  }

  setColumnValue(name: string, value: unknown): void {
    if (value === undefined && !hasOwn(this.columnValues, name)) {
      return;
    }
    // Copy instead of mutating: keeps the record in fast mode (a delete
    // would turn it into a dictionary) and never touches a shared record.
    const next: Record<string, unknown> = {};
    for (const key in this.columnValues) {
      if (key !== name && hasOwn(this.columnValues, key)) {
        next[key] = this.columnValues[key];
      }
    }
    if (value !== undefined) {
      next[name] = value;
    }
    this.columnValues = toValueRecord(next);
  }

  getAsString(name: string, defaultValue: string): string {
    const val = this.getColumnValue(name);
    if (val === null || val === undefined) return defaultValue;
    return String(val);
  }

  getAsNumber(name: string, defaultValue: number | null): number | null {
    const val = this.getColumnValue(name);
    if (val === null || val === undefined) return defaultValue;
    if (typeof val === "number") return val;
    const parsed = parseFloat(String(val));
    return isNaN(parsed) ? defaultValue : parsed;
  }

  getAsStringList(name: string, defaultValue: string[] | null): string[] | null {
    const val = this.getColumnValue(name);
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
    const children = this.children;
    if (children === null) {
      return EMPTY_CHILDREN as VirtualViewEntryData[];
    }
    if (children.sortedChildrenCache === null) {
      const entries = Array.from(children.childEntriesBySortKey.values());
      entries.sort((a, b) => this.childrenComparator.compare(a.sortKey, b.sortKey));
      children.sortedChildrenCache = entries;
    }
    return children.sortedChildrenCache;
  }

  /**
   * Get child entry by sort key
   */
  getChildEntry(sortKey: ViewEntrySortKey): VirtualViewEntryData | undefined {
    return this.children?.childEntriesBySortKey.get(sortKey.toKey());
  }

  /**
   * Check if a child entry exists
   */
  hasChildEntry(sortKey: ViewEntrySortKey): boolean {
    return this.children?.childEntriesBySortKey.has(sortKey.toKey()) ?? false;
  }

  /**
   * Add a child entry
   * @returns true if the entry was added (didn't exist before)
   */
  addChildEntry(entry: VirtualViewEntryData): boolean {
    const key = entry.sortKey.toKey();
    const children = this.childState();
    if (children.childEntriesBySortKey.has(key)) {
      return false;
    }
    children.childEntriesBySortKey.set(key, entry);
    if (children.sortedChildrenCache !== null) {
      // Maintain the sorted cache incrementally: O(log n) position lookup +
      // one splice instead of invalidation + full re-sort on next read.
      const insertAt = this.findSortedInsertIndex(children.sortedChildrenCache, entry);
      children.sortedChildrenCache.splice(insertAt, 0, entry);
    }
    children.childCount++;
    if (entry.isCategory()) {
      children.childCategoryCount++;
    } else {
      children.childDocumentCount++;
    }
    return true;
  }

  /**
   * Remove a child entry
   * @returns true if the entry was removed
   */
  removeChildEntry(sortKey: ViewEntrySortKey): boolean {
    const children = this.children;
    if (children === null) {
      return false;
    }
    const key = sortKey.toKey();
    const entry = children.childEntriesBySortKey.get(key);
    if (!entry) {
      return false;
    }
    children.childEntriesBySortKey.delete(key);
    if (children.sortedChildrenCache !== null) {
      const removeAt = this.findSortedEntryIndex(children.sortedChildrenCache, entry);
      if (removeAt >= 0) {
        children.sortedChildrenCache.splice(removeAt, 1);
      } else {
        // Should not happen; fall back to a full re-sort on next read.
        children.sortedChildrenCache = null;
      }
    }
    children.childCount--;
    if (entry.isCategory()) {
      children.childCategoryCount--;
    } else {
      children.childDocumentCount--;
    }
    return true;
  }

  /**
   * Binary search for the insertion position of `entry` in the sorted
   * children cache (first index whose sort key compares greater).
   */
  private findSortedInsertIndex(sorted: VirtualViewEntryData[], entry: VirtualViewEntryData): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.childrenComparator.compare(sorted[mid].sortKey, entry.sortKey) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Locate an existing entry in the sorted children cache: binary search to
   * the equal-compare range, then scan it for the exact instance (distinct
   * sort keys can compare equal, e.g. case-insensitive collation ties).
   * Returns -1 when not found.
   */
  private findSortedEntryIndex(sorted: VirtualViewEntryData[], entry: VirtualViewEntryData): number {
    // Lower bound: first index with compare >= 0
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.childrenComparator.compare(sorted[mid].sortKey, entry.sortKey) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    for (
      let i = lo;
      i < sorted.length && this.childrenComparator.compare(sorted[i].sortKey, entry.sortKey) === 0;
      i++
    ) {
      if (sorted[i] === entry) {
        return i;
      }
    }
    return -1;
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
      
      // Range check using the shared collator (constructing a collator per
      // localeCompare call dominates the cost of large range scans).
      if (startValue !== LOW_SORTVAL && val !== null && val !== undefined) {
        if (typeof val === "string" && typeof startValue === "string") {
          if (baseSensitivityCollator.compare(val, startValue) < 0) return false;
        } else if (typeof val === "number" && typeof startValue === "number") {
          if (val < startValue) return false;
        }
      }
      if (endValue !== HIGH_SORTVAL && val !== null && val !== undefined) {
        if (typeof val === "string" && typeof endValue === "string") {
          if (baseSensitivityCollator.compare(val, endValue) > 0) return false;
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
    this.siblingIndex = index;
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

  // Position (computed on demand from the sibling indexes: O(depth), and
  // never cached per entry — a view keeps tens of thousands of entries)
  getPosition(): number[] {
    if (this.isRoot()) {
      return [0];
    }
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
    return positions;
  }

  getPositionStr(): string {
    return this.getPosition().join(".");
  }

  // Descendant count management
  incrementDescendantCount(isCategory: boolean): void {
    const children = this.childState();
    children.descendantCount++;
    if (isCategory) {
      children.descendantCategoryCount++;
    } else {
      children.descendantDocumentCount++;
    }
  }

  decrementDescendantCount(isCategory: boolean): void {
    const children = this.childState();
    children.descendantCount--;
    if (isCategory) {
      children.descendantCategoryCount--;
    } else {
      children.descendantDocumentCount--;
    }
  }

  // Total values (for category aggregations)
  addTotalValue(itemName: string, value: number): number {
    const key = itemName.toLowerCase();
    const children = this.childState();
    const totals = (children.totalValues ??= new Map());
    const current = totals.get(key) ?? 0;
    const newValue = current + value;
    totals.set(key, newValue);
    return newValue;
  }

  getTotalValue(itemName: string): number | null {
    const key = itemName.toLowerCase();
    return this.children?.totalValues?.get(key) ?? null;
  }

  getTotalValues(): Record<string, number> {
    const result: Record<string, number> = {};
    const totals = this.children?.totalValues;
    if (totals) {
      for (const [key, value] of totals) {
        result[key] = value;
      }
    }
    return result;
  }

  // Invalidate caches when structure changes
  invalidatePositionCache(): void {
    this._level = null;
  }

  /** @internal Add a pre-built child during cache restoration (bypasses incremental count tracking). */
  _addRestoredChild(entry: VirtualViewEntryData): void {
    const children = this.childState();
    children.childEntriesBySortKey.set(entry.getSortKey().toKey(), entry);
    children.sortedChildrenCache = null;
  }

  /** @internal Set count values directly during cache restoration. */
  _restoreCounts(
    cc: number, ccc: number, cdc: number,
    dc: number, ddc: number, dcc: number,
  ): void {
    if (this.children === null && cc === 0 && ccc === 0 && cdc === 0 && dc === 0 && ddc === 0 && dcc === 0) {
      return;
    }
    const children = this.childState();
    children.childCount = cc;
    children.childCategoryCount = ccc;
    children.childDocumentCount = cdc;
    children.descendantCount = dc;
    children.descendantDocumentCount = ddc;
    children.descendantCategoryCount = dcc;
  }

  /** @internal Set total values directly during cache restoration. */
  _restoreTotalValues(totals: Record<string, number>): void {
    const entries = Object.entries(totals);
    if (entries.length === 0) {
      if (this.children?.totalValues) this.children.totalValues = null;
      return;
    }
    this.childState().totalValues = new Map(entries);
  }

  toString(): string {
    const type = this.isDocument() ? "document" : this.isCategory() ? "category" : "root";
    return `VirtualViewEntry [pos=${this.getPositionStr()}, level=${this.getLevel()}, type=${type}, origin=${this.origin}, docId=${this.docId}, columnValues=${JSON.stringify(this.getColumnValues())}]`;
  }
}
