import type { VirtualView } from "./VirtualView";
import type { VirtualViewEntryData } from "./VirtualViewEntryData";
import type { IViewEntryAccessCheck } from "./IViewEntryAccessCheck";
import {
  WithCategories,
  WithDocuments,
  SelectedOnly,
  scopedDocIdKey,
  createScopedDocId,
  ORIGIN_VIRTUALVIEW,
  ScopedDocId,
  compareValues,
} from "./types";

/**
 * Traversal state for navigating within child entries of a parent
 */
interface TraversalInfo {
  parentEntry: VirtualViewEntryData;
  withCategories: boolean;
  withDocuments: boolean;
  childEntries: VirtualViewEntryData[];
  currentIndex: number;
}

/**
 * Navigator for traversing a VirtualView tree structure.
 * Handles expanded/collapsed states, selection, and access control.
 */
export class VirtualViewNavigator {
  private readonly view: VirtualView;
  private topEntry: VirtualViewEntryData;
  private readonly withCategories: boolean;
  private readonly withDocuments: boolean;
  private readonly accessCheck: IViewEntryAccessCheck | null;
  private readonly dontShowEmptyCategories: boolean;

  /** Stack of traversal states for navigation */
  private currentEntryStack: TraversalInfo[] = [];

  /** Selection state - if selectAll is true, this is a deselection list */
  private selectedOrDeselectedEntries: Set<string> = new Set();
  private selectAll: boolean = false;

  /** Expansion state - if expandAllByDefault is true, this is a collapse list */
  private expandedOrCollapsedEntries: Set<string> = new Set();
  private expandAllByDefault: boolean = false;
  private expandLevel: number = 0;

  constructor(
    view: VirtualView,
    topEntry: VirtualViewEntryData,
    withCategories: WithCategories,
    withDocuments: WithDocuments,
    accessCheck: IViewEntryAccessCheck | null = null,
    dontShowEmptyCategories: boolean = false
  ) {
    this.view = view;
    this.topEntry = topEntry;
    this.withCategories = withCategories === WithCategories.YES;
    this.withDocuments = withDocuments === WithDocuments.YES;
    this.accessCheck = accessCheck;
    this.dontShowEmptyCategories = dontShowEmptyCategories;

    if (!this.withCategories && !this.withDocuments) {
      throw new Error("Navigator must include categories, documents, or both");
    }

    // Initialize traversal at top entry
    this.initializeTraversal();
  }

  private initializeTraversal(): void {
    this.currentEntryStack = [];
    if (this.topEntry) {
      this.currentEntryStack.push(this.createTraversalInfo(this.topEntry));
    }
  }

  private createTraversalInfo(parentEntry: VirtualViewEntryData): TraversalInfo {
    // Always get all child entries for traversal purposes
    // Filtering happens when we return entries (getCurrentEntry)
    const childEntries = parentEntry.getChildEntries();

    return {
      parentEntry,
      withCategories: this.withCategories,
      withDocuments: this.withDocuments,
      childEntries,
      currentIndex: -1, // Before first entry
    };
  }

  getView(): VirtualView {
    return this.view;
  }

  isDontShowEmptyCategories(): boolean {
    return this.dontShowEmptyCategories;
  }

  /**
   * Set a new root for navigation (restrict to subtree)
   */
  setRoot(newRoot: VirtualViewEntryData): this {
    this.topEntry = newRoot;
    this.initializeTraversal();
    return this;
  }

  // ===== Navigation Methods =====

  /**
   * Get the current entry at the cursor position
   */
  getCurrentEntry(): VirtualViewEntryData | null {
    if (this.currentEntryStack.length === 0) {
      return null;
    }
    const info = this.currentEntryStack[this.currentEntryStack.length - 1];
    if (info.currentIndex < 0 || info.currentIndex >= info.childEntries.length) {
      return null;
    }
    const entry = info.childEntries[info.currentIndex];
    
    // Check visibility
    if (!this.isVisible(entry)) {
      return null;
    }
    
    // Filter by type
    if (entry.isCategory() && !this.withCategories) {
      return null;
    }
    if (entry.isDocument() && !this.withDocuments) {
      return null;
    }
    
    return entry;
  }

  /**
   * Move to the first entry
   */
  gotoFirst(): boolean {
    // Reset to top level
    while (this.currentEntryStack.length > 1) {
      this.currentEntryStack.pop();
    }
    
    const info = this.currentEntryStack[0];
    if (!info || info.childEntries.length === 0) {
      return false;
    }
    
    // Find first visible entry (raw visibility)
    for (let i = 0; i < info.childEntries.length; i++) {
      info.currentIndex = i;
      if (this.isVisibleRaw(info.childEntries[i])) {
        // Check if this matches our type filter
        const entry = this.getCurrentEntry();
        if (entry) {
          return true;
        }
        // Entry doesn't match filter, continue to navigate into it or past it
        return this.gotoNext();
      }
    }
    
    return false;
  }

  /**
   * Move to the last entry (taking expansion into account)
   */
  gotoLast(): boolean {
    // Reset to top level
    while (this.currentEntryStack.length > 1) {
      this.currentEntryStack.pop();
    }
    
    const info = this.currentEntryStack[0];
    if (!info || info.childEntries.length === 0) {
      return false;
    }
    
    // Find last visible entry
    for (let i = info.childEntries.length - 1; i >= 0; i--) {
      info.currentIndex = i;
      if (this.isVisible(info.childEntries[i])) {
        // Navigate to deepest expanded descendant
        this.gotoDeepestExpandedDescendant(info.childEntries[i]);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Move to the next entry (respecting expand states)
   */
  gotoNext(): boolean {
    const currEntry = this.getCurrentEntryRaw();
    if (!currEntry) {
      // No current entry - try to find one by moving through the tree
      if (this.gotoNextSibling()) {
        // Check if this entry should be returned
        const entry = this.getCurrentEntry();
        if (entry) return true;
        // Keep searching
        return this.gotoNext();
      }
      return false;
    }

    // If expanded and has children, go to first child
    if (this.isExpanded(currEntry) && currEntry.getChildCount() > 0) {
      const childInfo = this.createTraversalInfo(currEntry);
      if (childInfo.childEntries.length > 0) {
        childInfo.currentIndex = 0;
        // Find first visible child (visibility check only, not type filter)
        while (childInfo.currentIndex < childInfo.childEntries.length &&
               !this.isVisibleRaw(childInfo.childEntries[childInfo.currentIndex])) {
          childInfo.currentIndex++;
        }
        if (childInfo.currentIndex < childInfo.childEntries.length) {
          this.currentEntryStack.push(childInfo);
          // Check if this entry matches our filter
          const entry = this.getCurrentEntry();
          if (entry) {
            return true;
          }
          // Entry doesn't match filter (e.g., it's a category but we want documents)
          // Continue navigating
          return this.gotoNext();
        }
      }
    }

    // Try next sibling
    if (this.gotoNextSiblingRaw()) {
      // Check if this entry matches our filter
      const entry = this.getCurrentEntry();
      if (entry) {
        return true;
      }
      // Keep searching
      return this.gotoNext();
    }

    // Go up and try next sibling of parent
    while (this.gotoParent()) {
      if (this.gotoNextSiblingRaw()) {
        // Check if this entry matches our filter
        const entry = this.getCurrentEntry();
        if (entry) {
          return true;
        }
        // Keep searching
        return this.gotoNext();
      }
    }

    return false;
  }

  /**
   * Get the current entry without type filtering (for internal navigation)
   */
  private getCurrentEntryRaw(): VirtualViewEntryData | null {
    if (this.currentEntryStack.length === 0) {
      return null;
    }
    const info = this.currentEntryStack[this.currentEntryStack.length - 1];
    if (info.currentIndex < 0 || info.currentIndex >= info.childEntries.length) {
      return null;
    }
    return info.childEntries[info.currentIndex];
  }

  /**
   * Check visibility without type filtering
   */
  private isVisibleRaw(entry: VirtualViewEntryData): boolean {
    // Check access control
    if (this.accessCheck && !this.accessCheck.isVisible(this, entry)) {
      return false;
    }
    return true;
  }

  /**
   * Move to next sibling without checking type filter
   */
  private gotoNextSiblingRaw(): boolean {
    if (this.currentEntryStack.length === 0) {
      return false;
    }
    
    const info = this.currentEntryStack[this.currentEntryStack.length - 1];
    
    // Find next visible entry
    for (let i = info.currentIndex + 1; i < info.childEntries.length; i++) {
      if (this.isVisibleRaw(info.childEntries[i])) {
        info.currentIndex = i;
        return true;
      }
    }
    
    return false;
  }

  /**
   * Move to the previous entry (respecting expand states)
   */
  gotoPrev(): boolean {
    const currEntry = this.getCurrentEntry();
    if (!currEntry) {
      return false;
    }

    // Try previous sibling
    if (this.gotoPrevSibling()) {
      // Navigate to deepest expanded descendant of prev sibling
      const prevEntry = this.getCurrentEntry();
      if (prevEntry) {
        this.gotoDeepestExpandedDescendant(prevEntry);
      }
      return true;
    }

    // Go up to parent
    return this.gotoParent();
  }

  /**
   * Move to the next sibling
   */
  gotoNextSibling(): boolean {
    if (this.currentEntryStack.length === 0) {
      return false;
    }
    
    const info = this.currentEntryStack[this.currentEntryStack.length - 1];
    
    // Find next visible entry
    for (let i = info.currentIndex + 1; i < info.childEntries.length; i++) {
      if (this.isVisible(info.childEntries[i])) {
        info.currentIndex = i;
        return true;
      }
    }
    
    return false;
  }

  /**
   * Move to the previous sibling
   */
  gotoPrevSibling(): boolean {
    if (this.currentEntryStack.length === 0) {
      return false;
    }
    
    const info = this.currentEntryStack[this.currentEntryStack.length - 1];
    
    // Find previous visible entry
    for (let i = info.currentIndex - 1; i >= 0; i--) {
      if (this.isVisible(info.childEntries[i])) {
        info.currentIndex = i;
        return true;
      }
    }
    
    return false;
  }

  /**
   * Move to the parent entry
   */
  gotoParent(): boolean {
    if (this.currentEntryStack.length > 1) {
      this.currentEntryStack.pop();
      return true;
    }
    return false;
  }

  /**
   * Move to the first child of current entry
   */
  gotoFirstChild(): boolean {
    const currEntry = this.getCurrentEntry();
    if (!currEntry) {
      return false;
    }
    
    const childInfo = this.createTraversalInfo(currEntry);
    if (childInfo.childEntries.length === 0) {
      return false;
    }
    
    // Find first visible child
    for (let i = 0; i < childInfo.childEntries.length; i++) {
      if (this.isVisible(childInfo.childEntries[i])) {
        childInfo.currentIndex = i;
        this.currentEntryStack.push(childInfo);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Move to the last child of current entry
   */
  gotoLastChild(): boolean {
    const currEntry = this.getCurrentEntry();
    if (!currEntry) {
      return false;
    }
    
    const childInfo = this.createTraversalInfo(currEntry);
    if (childInfo.childEntries.length === 0) {
      return false;
    }
    
    // Find last visible child
    for (let i = childInfo.childEntries.length - 1; i >= 0; i--) {
      if (this.isVisible(childInfo.childEntries[i])) {
        childInfo.currentIndex = i;
        this.currentEntryStack.push(childInfo);
        return true;
      }
    }
    
    return false;
  }

  private gotoDeepestExpandedDescendant(entry: VirtualViewEntryData): void {
    if (entry.getChildCount() > 0 && this.isExpanded(entry)) {
      const childInfo = this.createTraversalInfo(entry);
      // Find last visible child
      for (let i = childInfo.childEntries.length - 1; i >= 0; i--) {
        if (this.isVisible(childInfo.childEntries[i])) {
          childInfo.currentIndex = i;
          this.currentEntryStack.push(childInfo);
          this.gotoDeepestExpandedDescendant(childInfo.childEntries[i]);
          return;
        }
      }
    }
  }

  /**
   * Move to a specific position (e.g., "1.2.3")
   */
  gotoPos(posStr: string): boolean {
    const pos = posStr.split(".").map(p => parseInt(p, 10));
    return this.gotoPosArray(pos);
  }

  /**
   * Move to a specific position array (e.g., [1, 2, 3])
   */
  gotoPosArray(pos: number[]): boolean {
    // Reset to top level
    this.initializeTraversal();
    
    let currentInfo = this.currentEntryStack[0];
    if (!currentInfo) {
      return false;
    }

    for (let i = 0; i < pos.length; i++) {
      const targetSiblingIndex = pos[i];
      
      // Find entry with matching sibling index
      let found = false;
      for (let j = 0; j < currentInfo.childEntries.length; j++) {
        const entry = currentInfo.childEntries[j];
        if (entry.getSiblingIndex() === targetSiblingIndex && this.isVisible(entry)) {
          currentInfo.currentIndex = j;
          found = true;
          
          // If more levels to go, push new traversal info
          if (i < pos.length - 1) {
            const nextInfo = this.createTraversalInfo(entry);
            this.currentEntryStack.push(nextInfo);
            currentInfo = nextInfo;
          }
          break;
        }
      }
      
      if (!found) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Get the entry at a specific position without moving the cursor
   * 
   * @param posStr Position string e.g. "1.2.3"
   * @returns The entry at the position or null if not found
   */
  getPos(posStr: string): VirtualViewEntryData | null {
    const pos = posStr.split(".").map(p => parseInt(p, 10));
    return this.getPosArray(pos);
  }

  /**
   * Get the entry at a specific position array without moving the cursor
   * 
   * @param pos Position array e.g. [1, 2, 3]
   * @returns The entry at the position or null if not found
   */
  getPosArray(pos: number[]): VirtualViewEntryData | null {
    // Save current state
    const savedStack = this.currentEntryStack.map(info => ({
      ...info,
      childEntries: info.childEntries,
    }));

    // Navigate to position
    const found = this.gotoPosArray(pos);
    const entry = found ? this.getCurrentEntry() : null;

    // Restore state
    this.currentEntryStack = savedStack;

    return entry;
  }

  // ===== Category Finding Methods =====

  /**
   * Find a category entry by path string (e.g., "Category1\\Category1.1")
   * Navigates through the category tree from the top entry.
   * 
   * @param category Category path with backslash separators
   * @returns The category entry or null if not found
   */
  findCategoryEntry(category: string): VirtualViewEntryData | null {
    const categoryParts = category.split("\\");
    return this.findCategoryEntryByParts(categoryParts);
  }

  /**
   * Find a category entry by array of category parts
   * Navigates through the category tree from the top entry.
   * 
   * @param categoryParts Array of category values e.g. ["Category1", "Category1.1"]
   * @returns The category entry or null if not found
   */
  findCategoryEntryByParts(categoryParts: unknown[]): VirtualViewEntryData | null {
    let currentEntry: VirtualViewEntryData | null = this.topEntry;

    for (const part of categoryParts) {
      if (!currentEntry) {
        return null;
      }

      // Find matching subcategory
      const matchingCategory = this.childCategoriesByKey(currentEntry, String(part), true, false)
        .find(() => true); // Get first match

      if (!matchingCategory) {
        return null;
      }

      currentEntry = matchingCategory;
    }

    return currentEntry;
  }

  // ===== Iteration Methods =====

  /**
   * Iterate forward through entries
   */
  async *entriesForward(selectedOnly: SelectedOnly = SelectedOnly.NO): AsyncGenerator<VirtualViewEntryData> {
    if (!this.gotoFirst()) {
      return;
    }

    do {
      const entry = this.getCurrentEntry();
      if (entry) {
        if (selectedOnly === SelectedOnly.NO || this.isSelected(entry.origin, entry.docId)) {
          yield entry;
        }
      }
    } while (selectedOnly === SelectedOnly.YES ? this.gotoNextSelected() : this.gotoNext());
  }

  /**
   * Iterate forward through entries starting from a specific position
   * 
   * @param startPos Starting position string e.g. "1.2.3"
   * @param selectedOnly Whether to only yield selected entries
   */
  async *entriesForwardFromPosition(
    startPos: string,
    selectedOnly: SelectedOnly = SelectedOnly.NO
  ): AsyncGenerator<VirtualViewEntryData> {
    if (!this.gotoPos(startPos)) {
      return;
    }

    do {
      const entry = this.getCurrentEntry();
      if (entry) {
        if (selectedOnly === SelectedOnly.NO || this.isSelected(entry.origin, entry.docId)) {
          yield entry;
        }
      }
    } while (selectedOnly === SelectedOnly.YES ? this.gotoNextSelected() : this.gotoNext());
  }

  /**
   * Iterate backward through entries
   */
  async *entriesBackward(selectedOnly: SelectedOnly = SelectedOnly.NO): AsyncGenerator<VirtualViewEntryData> {
    if (!this.gotoLast()) {
      return;
    }

    do {
      const entry = this.getCurrentEntry();
      if (entry) {
        if (selectedOnly === SelectedOnly.NO || this.isSelected(entry.origin, entry.docId)) {
          yield entry;
        }
      }
    } while (selectedOnly === SelectedOnly.YES ? this.gotoPrevSelected() : this.gotoPrev());
  }

  /**
   * Move to next selected entry
   */
  gotoNextSelected(): boolean {
    while (this.gotoNext()) {
      const entry = this.getCurrentEntry();
      if (entry && this.isSelected(entry.origin, entry.docId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Move to previous selected entry
   */
  gotoPrevSelected(): boolean {
    while (this.gotoPrev()) {
      const entry = this.getCurrentEntry();
      if (entry && this.isSelected(entry.origin, entry.docId)) {
        return true;
      }
    }
    return false;
  }

  // ===== Visibility Check =====

  private isVisible(entry: VirtualViewEntryData): boolean {
    // Check access control
    if (this.accessCheck && !this.accessCheck.isVisible(this, entry)) {
      return false;
    }
    
    // Check empty categories
    if (this.dontShowEmptyCategories && entry.isCategory()) {
      if (entry.getDescendantDocumentCount() === 0) {
        return false;
      }
    }
    
    return true;
  }

  // ===== Selection Methods =====

  /**
   * Select an entry
   */
  select(origin: string, docId: string, selectParentCategories: boolean = false): this {
    const key = scopedDocIdKey(createScopedDocId(origin, docId));
    
    if (this.selectAll) {
      this.selectedOrDeselectedEntries.delete(key);
    } else {
      this.selectedOrDeselectedEntries.add(key);
    }

    if (selectParentCategories) {
      const entries = this.view.getEntries(origin, docId);
      for (const entry of entries) {
        let parent = entry.getParent();
        while (parent && !parent.isRoot()) {
          const parentKey = scopedDocIdKey(createScopedDocId(parent.origin, parent.docId));
          if (this.selectAll) {
            this.selectedOrDeselectedEntries.delete(parentKey);
          } else {
            this.selectedOrDeselectedEntries.add(parentKey);
          }
          parent = parent.getParent();
        }
      }
    }

    return this;
  }

  /**
   * Deselect an entry
   */
  deselect(origin: string, docId: string): this {
    const key = scopedDocIdKey(createScopedDocId(origin, docId));
    
    if (this.selectAll) {
      this.selectedOrDeselectedEntries.add(key);
    } else {
      this.selectedOrDeselectedEntries.delete(key);
    }

    return this;
  }

  /**
   * Select all entries
   */
  selectAllEntries(): this {
    this.selectedOrDeselectedEntries.clear();
    this.selectAll = true;
    return this;
  }

  /**
   * Deselect all entries
   */
  deselectAllEntries(): this {
    this.selectedOrDeselectedEntries.clear();
    this.selectAll = false;
    return this;
  }

  /**
   * Check if an entry is selected
   */
  isSelected(origin: string, docId: string): boolean {
    const key = scopedDocIdKey(createScopedDocId(origin, docId));
    if (this.selectAll) {
      return !this.selectedOrDeselectedEntries.has(key);
    } else {
      return this.selectedOrDeselectedEntries.has(key);
    }
  }

  isSelectAllByDefault(): boolean {
    return this.selectAll;
  }

  /**
   * Returns whether all entries are deselected by default
   */
  isDeselectAllByDefault(): boolean {
    return !this.selectAll;
  }

  // ===== Expand/Collapse Methods =====

  /**
   * Expand an entry
   */
  expand(origin: string, docId: string): this {
    const key = scopedDocIdKey(createScopedDocId(origin, docId));
    
    if (!this.expandAllByDefault) {
      this.expandedOrCollapsedEntries.add(key);
    } else {
      this.expandedOrCollapsedEntries.delete(key);
    }

    return this;
  }

  /**
   * Collapse an entry
   */
  collapse(origin: string, docId: string): this {
    const key = scopedDocIdKey(createScopedDocId(origin, docId));
    
    if (this.expandAllByDefault) {
      this.expandedOrCollapsedEntries.add(key);
    } else {
      this.expandedOrCollapsedEntries.delete(key);
    }

    return this;
  }

  /**
   * Expand by position string
   */
  expandPos(posStr: string): this {
    const entry = this.getEntryAtPos(posStr);
    if (entry) {
      this.expand(entry.origin, entry.docId);
    }
    return this;
  }

  /**
   * Collapse by position string
   */
  collapsePos(posStr: string): this {
    const entry = this.getEntryAtPos(posStr);
    if (entry) {
      this.collapse(entry.origin, entry.docId);
    }
    return this;
  }

  /**
   * Expand by position array
   * 
   * @param pos Position array e.g. [1, 2, 3]
   */
  expandPosArray(pos: number[]): this {
    const entry = this.getPosArray(pos);
    if (entry) {
      this.expand(entry.origin, entry.docId);
    }
    return this;
  }

  /**
   * Collapse by position array
   * 
   * @param pos Position array e.g. [1, 2, 3]
   */
  collapsePosArray(pos: number[]): this {
    const entry = this.getPosArray(pos);
    if (entry) {
      this.collapse(entry.origin, entry.docId);
    }
    return this;
  }

  private getEntryAtPos(posStr: string): VirtualViewEntryData | null {
    // Save current position
    const savedStack = [...this.currentEntryStack];
    
    const found = this.gotoPos(posStr);
    const entry = found ? this.getCurrentEntry() : null;
    
    // Restore position
    this.currentEntryStack = savedStack;
    
    return entry;
  }

  /**
   * Collapse all entries
   */
  collapseAll(): this {
    this.expandedOrCollapsedEntries.clear();
    this.expandAllByDefault = false;
    return this;
  }

  /**
   * Expand all entries
   */
  expandAll(): this {
    this.expandedOrCollapsedEntries.clear();
    this.expandAllByDefault = true;
    return this;
  }

  /**
   * Expand entries up to a specific level
   */
  expandToLevel(level: number): this {
    this.expandLevel = level;
    return this;
  }

  /**
   * Check if an entry is expanded
   */
  isExpanded(entry: VirtualViewEntryData): boolean {
    // Root is always expanded
    if (entry.isRoot()) {
      return true;
    }

    // Check level-based expansion
    if (this.expandLevel > 0 && entry.getLevel() <= this.expandLevel) {
      return true;
    }

    return this.isExpandedByDocId(entry.origin, entry.docId);
  }

  /**
   * Check if an entry is expanded by origin and docId
   * Does not check expandLevel - only checks the expand/collapse state
   * 
   * @param origin Origin of the entry
   * @param docId Document ID of the entry
   * @returns true if expanded
   */
  isExpandedByDocId(origin: string, docId: string): boolean {
    const key = scopedDocIdKey(createScopedDocId(origin, docId));
    
    // Check if this is the root
    const root = this.view.getRoot();
    if (root.docId === docId && root.origin === origin) {
      return true;
    }
    
    if (this.expandAllByDefault) {
      return !this.expandedOrCollapsedEntries.has(key);
    } else {
      return this.expandedOrCollapsedEntries.has(key);
    }
  }

  isExpandAllByDefault(): boolean {
    return this.expandAllByDefault;
  }

  isCollapseAllByDefault(): boolean {
    return !this.expandAllByDefault;
  }

  getExpandLevel(): number {
    return this.expandLevel;
  }

  // ===== State Getters/Setters =====

  getSelectedOrDeselectedEntries(): Set<string> {
    return new Set(this.selectedOrDeselectedEntries);
  }

  setSelectedOrDeselectedEntries(entries: Set<string>): this {
    this.selectedOrDeselectedEntries = new Set(entries);
    return this;
  }

  getExpandedOrCollapsedEntries(): Set<string> {
    return new Set(this.expandedOrCollapsedEntries);
  }

  setExpandedOrCollapsedEntries(entries: Set<string>): this {
    this.expandedOrCollapsedEntries = new Set(entries);
    return this;
  }

  // ===== Child Entry Methods =====

  /**
   * Get child documents of an entry
   */
  childDocuments(entry: VirtualViewEntryData, descending: boolean = false): VirtualViewEntryData[] {
    const docs = entry.getChildDocuments();
    const filtered = docs.filter(e => this.isVisible(e));
    return descending ? filtered.reverse() : filtered;
  }

  /**
   * Get child categories of an entry
   */
  childCategories(entry: VirtualViewEntryData, descending: boolean = false): VirtualViewEntryData[] {
    const cats = entry.getChildCategories();
    const filtered = cats.filter(e => this.isVisible(e));
    return descending ? filtered.reverse() : filtered;
  }

  /**
   * Get all child entries of an entry
   */
  childEntries(entry: VirtualViewEntryData, descending: boolean = false): VirtualViewEntryData[] {
    const entries = entry.getChildEntries();
    const filtered = entries.filter(e => this.isVisible(e));
    return descending ? filtered.reverse() : filtered;
  }

  // ===== Range/Key-based Child Queries =====

  /**
   * Get child documents within a key range (inclusive)
   * 
   * @param entry Parent entry
   * @param startKey Start key value
   * @param endKey End key value
   * @param descending Whether to return in descending order
   * @returns Filtered child documents within the range
   */
  childDocumentsBetween(
    entry: VirtualViewEntryData,
    startKey: unknown,
    endKey: unknown,
    descending: boolean = false
  ): VirtualViewEntryData[] {
    const docs = entry.getChildDocuments();
    const filtered = docs.filter(e => {
      if (!this.isVisible(e)) return false;
      
      const sortKey = e.getSortKey();
      const firstValue = sortKey.values.length > 0 ? sortKey.values[0] : null;
      
      // Check if value is within range
      const afterStart = compareValues(firstValue, startKey, false) >= 0;
      const beforeEnd = compareValues(firstValue, endKey, false) <= 0;
      
      return afterStart && beforeEnd;
    });
    
    return descending ? filtered.reverse() : filtered;
  }

  /**
   * Get child documents by key (exact or prefix match)
   * 
   * @param entry Parent entry
   * @param key Key value to search for
   * @param isExact Whether to match exactly or by prefix
   * @param descending Whether to return in descending order
   * @returns Matching child documents
   */
  childDocumentsByKey(
    entry: VirtualViewEntryData,
    key: string,
    isExact: boolean,
    descending: boolean = false
  ): VirtualViewEntryData[] {
    if (isExact) {
      return this.childDocumentsBetween(entry, key, key, descending);
    }
    
    // Prefix match - use key to key + max char
    const endKey = key + String.fromCharCode(0xFFFF);
    return this.childDocumentsBetween(entry, key, endKey, descending);
  }

  /**
   * Get child categories within a key range (inclusive)
   * 
   * @param entry Parent entry
   * @param startKey Start key value
   * @param endKey End key value
   * @param descending Whether to return in descending order
   * @returns Filtered child categories within the range
   */
  childCategoriesBetween(
    entry: VirtualViewEntryData,
    startKey: unknown,
    endKey: unknown,
    descending: boolean = false
  ): VirtualViewEntryData[] {
    const cats = entry.getChildCategories();
    const filtered = cats.filter(e => {
      if (!this.isVisible(e)) return false;
      
      const catValue = e.getCategoryValue();
      
      // Check if value is within range
      const afterStart = compareValues(catValue, startKey, false) >= 0;
      const beforeEnd = compareValues(catValue, endKey, false) <= 0;
      
      return afterStart && beforeEnd;
    });
    
    return descending ? filtered.reverse() : filtered;
  }

  /**
   * Get child categories by key (exact or prefix match)
   * 
   * @param entry Parent entry
   * @param key Key value to search for
   * @param isExact Whether to match exactly or by prefix
   * @param descending Whether to return in descending order
   * @returns Matching child categories
   */
  childCategoriesByKey(
    entry: VirtualViewEntryData,
    key: string,
    isExact: boolean,
    descending: boolean = false
  ): VirtualViewEntryData[] {
    if (isExact) {
      return this.childCategoriesBetween(entry, key, key, descending);
    }
    
    // Prefix match - use key to key + max char
    const endKey = key + String.fromCharCode(0xFFFF);
    return this.childCategoriesBetween(entry, key, endKey, descending);
  }

  // ===== Sorted Entry Lookup =====

  /**
   * Compare two position arrays for sorting
   */
  private static comparePositions(pos1: number[], pos2: number[]): number {
    const len = Math.min(pos1.length, pos2.length);
    for (let i = 0; i < len; i++) {
      if (pos1[i] !== pos2[i]) {
        return pos1[i] - pos2[i];
      }
    }
    return pos1.length - pos2.length;
  }

  /**
   * Get all occurrences of a document in the view, sorted by position
   * 
   * @param origin Origin of the document
   * @param docId Document ID
   * @returns Array of entries sorted by position
   */
  getSortedEntries(origin: string, docId: string): VirtualViewEntryData[] {
    const entries = this.view.getEntries(origin, docId);
    return entries
      .filter(e => this.isVisible(e))
      .sort((a, b) => VirtualViewNavigator.comparePositions(a.getPosition(), b.getPosition()));
  }

  /**
   * Get all occurrences of multiple documents in the view, sorted by position
   * 
   * @param origin Origin of the documents
   * @param docIds Set of document IDs
   * @returns Array of entries sorted by position
   */
  getSortedEntriesMultiple(origin: string, docIds: Set<string>): VirtualViewEntryData[] {
    const allEntries: VirtualViewEntryData[] = [];
    
    for (const docId of docIds) {
      const entries = this.view.getEntries(origin, docId);
      allEntries.push(...entries);
    }
    
    return allEntries
      .filter(e => this.isVisible(e))
      .sort((a, b) => VirtualViewNavigator.comparePositions(a.getPosition(), b.getPosition()));
  }

  /**
   * Get all occurrences of scoped document IDs in the view, sorted by position
   * 
   * @param scopedDocIds Set of scoped document IDs (origin + docId)
   * @returns Array of entries sorted by position
   */
  getSortedEntriesScoped(scopedDocIds: Set<ScopedDocId>): VirtualViewEntryData[] {
    const allEntries: VirtualViewEntryData[] = [];
    
    for (const scopedId of scopedDocIds) {
      const entries = this.view.getEntries(scopedId.origin, scopedId.docId);
      allEntries.push(...entries);
    }
    
    return allEntries
      .filter(e => this.isVisible(e))
      .sort((a, b) => VirtualViewNavigator.comparePositions(a.getPosition(), b.getPosition()));
  }

  /**
   * Get document IDs sorted by their position in the view
   * 
   * @param origin Origin of the documents
   * @param docIds Set of document IDs
   * @returns Array of document IDs sorted by their position in the view
   */
  getSortedDocIds(origin: string, docIds: Set<string>): string[] {
    const sortedEntries = this.getSortedEntriesMultiple(origin, docIds);
    
    // Use a Set to track seen docIds and maintain order
    const seen = new Set<string>();
    const result: string[] = [];
    
    for (const entry of sortedEntries) {
      if (!seen.has(entry.docId)) {
        seen.add(entry.docId);
        result.push(entry.docId);
      }
    }
    
    return result;
  }

  /**
   * Get scoped document IDs sorted by their position in the view
   * 
   * @param scopedDocIds Set of scoped document IDs
   * @returns Array of scoped document IDs sorted by their position in the view
   */
  getSortedDocIdsScoped(scopedDocIds: Set<ScopedDocId>): ScopedDocId[] {
    const sortedEntries = this.getSortedEntriesScoped(scopedDocIds);
    
    // Use a Set to track seen docIds and maintain order
    const seen = new Set<string>();
    const result: ScopedDocId[] = [];
    
    for (const entry of sortedEntries) {
      const key = scopedDocIdKey({ origin: entry.origin, docId: entry.docId });
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ origin: entry.origin, docId: entry.docId });
      }
    }
    
    return result;
  }
}
