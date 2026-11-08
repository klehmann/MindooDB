import type { VirtualView } from "./VirtualView";
import type { VirtualViewEntryData } from "./VirtualViewEntryData";
import { ViewEntrySortKey } from "./ViewEntrySortKey";
import type { ViewEntrySortKeyComparator } from "./ViewEntrySortKeyComparator";
import { VirtualViewNavigator } from "./VirtualViewNavigator";
import { WithCategories, WithDocuments } from "./types";

/**
 * Position of a document entry in a merged read: its document sort key.
 * JSON-serializable, so it can travel as a paging token.
 */
export interface MergedEntryKey {
  /** Document sort values. */
  v: unknown[];
  /** Origin of the entry. */
  o: string;
  /** Document id of the entry. */
  d: string;
}

/** One page of a merged read. */
export interface MergedNavigatorPage {
  entries: VirtualViewEntryData[];
  /**
   * Key of the last returned entry — pass it as `after` (forward) or
   * `before` (backward) to read the next page; `null` when the read
   * reached the end.
   */
  nextKey: MergedEntryKey | null;
}

/** Options of {@link VirtualViewMergedNavigator}. */
export interface MergedNavigatorOptions {
  /** Optional visibility filter (e.g. reader checks); hidden entries are skipped. */
  accessCheck?: (entry: VirtualViewEntryData) => boolean;
}

/** Ordered document stream below one category, with seek support. */
class CategoryDocumentStream {
  private readonly docs: VirtualViewEntryData[];
  private index: number;
  private readonly step: number;

  constructor(
    root: VirtualViewEntryData,
    comparator: ViewEntrySortKeyComparator,
    descending: boolean,
    seek: ViewEntrySortKey | null,
  ) {
    const children = root.getChildEntries();
    if (children.every((child) => child.isDocument())) {
      // Leaf category (the usual case): children are already sorted.
      this.docs = children;
    } else {
      // Sub-categories: their documents are grouped by category, not by the
      // document sort key the merge needs — collect and sort them.
      const docs: VirtualViewEntryData[] = [];
      const stack = [...children];
      while (stack.length > 0) {
        const entry = stack.pop()!;
        if (entry.isDocument()) {
          docs.push(entry);
        } else {
          stack.push(...entry.getChildEntries());
        }
      }
      docs.sort((a, b) => comparator.compare(a.getSortKey(), b.getSortKey()));
      this.docs = docs;
    }
    this.step = descending ? -1 : 1;
    if (!seek) {
      this.index = descending ? this.docs.length - 1 : 0;
      return;
    }
    // First index whose key is > seek (ascending order of `docs`).
    let lo = 0;
    let hi = this.docs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (comparator.compare(this.docs[mid].getSortKey(), seek) > 0) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    if (descending) {
      // Last index whose key is < seek.
      let last = lo - 1;
      while (last >= 0 && comparator.compare(this.docs[last].getSortKey(), seek) >= 0) {
        last--;
      }
      this.index = last;
    } else {
      this.index = lo;
    }
  }

  /** The next document entry in read direction, or `null`. */
  next(): VirtualViewEntryData | null {
    if (this.index < 0 || this.index >= this.docs.length) {
      return null;
    }
    const entry = this.docs[this.index];
    this.index += this.step;
    return entry;
  }
}

/**
 * Reads the documents of SEVERAL categories of one view as one sorted list
 * — a k-way merge over the document sort columns. All categories of a view
 * share the same column design, so their documents' sort keys are
 * comparable.
 *
 * Typical use: one persistent "mail by folder" view, where the folder is
 * the first (multi-value) category, read as "inbox of accounts A and B" or
 * "all folders named Projects" without rebuilding anything. A document in
 * several of the read categories appears once: its occurrences share the
 * same sort key (values, origin, doc id), so they meet in the merge and the
 * duplicate is dropped.
 *
 * Only document entries are returned (sub-categories below the given
 * categories are walked through; their documents are merged by the
 * document sort columns, not grouped). Paging is key-based: a page costs
 * O(page size × number of categories), plus a binary search per category
 * to find the start (a category with sub-categories is collected and sorted
 * first, O(n log n) in its size).
 */
export class VirtualViewMergedNavigator {
  private readonly view: VirtualView;
  private readonly roots: VirtualViewEntryData[];
  private readonly accessCheck: ((entry: VirtualViewEntryData) => boolean) | null;
  private current: VirtualViewEntryData | null = null;

  constructor(view: VirtualView, rootCategoryPaths: unknown[][], options?: MergedNavigatorOptions) {
    this.view = view;
    this.accessCheck = options?.accessCheck ?? null;
    const lookup = new VirtualViewNavigator(view, view.getRoot(), WithCategories.YES, WithDocuments.YES, null, false);
    const roots: VirtualViewEntryData[] = [];
    const seen = new Set<VirtualViewEntryData>();
    for (const path of rootCategoryPaths) {
      if (!Array.isArray(path) || path.length === 0) {
        continue;
      }
      const entry = lookup.findCategoryEntryByParts(path);
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        roots.push(entry);
      }
    }
    this.roots = roots;
  }

  getView(): VirtualView {
    return this.view;
  }

  /** The category entries that were found (missing paths are left out). */
  getRootEntries(): VirtualViewEntryData[] {
    return [...this.roots];
  }

  /**
   * Sum of the documents below the categories — an upper bound of the
   * merged count (documents in several of them count more than once).
   * Use {@link countDocuments} for the exact number.
   */
  getDocumentCountUpperBound(): number {
    return this.roots.reduce((sum, root) => sum + root.getDescendantDocumentCount(), 0);
  }

  /** Exact number of distinct, visible documents (walks all of them). */
  countDocuments(): number {
    let count = 0;
    for (const _ of this.documents("forward", null)) {
      count++;
    }
    return count;
  }

  /** Comparator for document sort keys (any leaf category's child comparator). */
  private comparator(): ViewEntrySortKeyComparator | null {
    return this.roots.length > 0 ? this.roots[0].getChildrenComparator() : null;
  }

  static keyOf(entry: VirtualViewEntryData): MergedEntryKey {
    const sortKey = entry.getSortKey();
    return { v: [...sortKey.values], o: sortKey.origin, d: sortKey.docId };
  }

  private static toSortKey(key: MergedEntryKey): ViewEntrySortKey {
    return ViewEntrySortKey.createSortKey(false, key.v, key.o, key.d);
  }

  /** The merged, de-duplicated document stream in one direction. */
  *documents(direction: "forward" | "backward", start: MergedEntryKey | null): Generator<VirtualViewEntryData> {
    const comparator = this.comparator();
    if (!comparator) {
      return;
    }
    const descending = direction === "backward";
    const seek = start ? VirtualViewMergedNavigator.toSortKey(start) : null;
    const streams = this.roots.map((root) => new CategoryDocumentStream(root, comparator, descending, seek));
    const heads = streams.map((stream) => stream.next());
    let last: ViewEntrySortKey | null = null;
    while (true) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        if (!head) continue;
        if (best === -1) {
          best = i;
          continue;
        }
        const cmp = comparator.compare(head.getSortKey(), heads[best]!.getSortKey());
        if (descending ? cmp > 0 : cmp < 0) {
          best = i;
        }
      }
      if (best === -1) {
        return;
      }
      const entry = heads[best]!;
      heads[best] = streams[best].next();
      const key = entry.getSortKey();
      if (last && comparator.compare(key, last) === 0) {
        continue; // same document from another category
      }
      last = key;
      if (this.accessCheck && !this.accessCheck(entry)) {
        continue;
      }
      yield entry;
    }
  }

  private readPage(direction: "forward" | "backward", start: MergedEntryKey | null, limit: number): MergedNavigatorPage {
    const entries: VirtualViewEntryData[] = [];
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) {
      return { entries, nextKey: start };
    }
    let more = false;
    for (const entry of this.documents(direction, start)) {
      if (entries.length === max) {
        more = true;
        break;
      }
      entries.push(entry);
    }
    return {
      entries,
      nextKey: more && entries.length > 0 ? VirtualViewMergedNavigator.keyOf(entries[entries.length - 1]) : null,
    };
  }

  /** Read up to `limit` documents in view order, after `after` (exclusive). */
  readForward(options?: { after?: MergedEntryKey | null; limit?: number }): MergedNavigatorPage {
    return this.readPage("forward", options?.after ?? null, options?.limit ?? 50);
  }

  /** Read up to `limit` documents in reverse view order, before `before` (exclusive). */
  readBackward(options?: { before?: MergedEntryKey | null; limit?: number }): MergedNavigatorPage {
    return this.readPage("backward", options?.before ?? null, options?.limit ?? 50);
  }

  /** Iterate all documents forward (async, like `VirtualViewNavigator.entriesForward`). */
  async *entriesForward(after?: MergedEntryKey | null): AsyncGenerator<VirtualViewEntryData> {
    yield* this.documents("forward", after ?? null);
  }

  /** Iterate all documents backward. */
  async *entriesBackward(before?: MergedEntryKey | null): AsyncGenerator<VirtualViewEntryData> {
    yield* this.documents("backward", before ?? null);
  }

  // ----- cursor-style navigation -----

  getCurrentEntry(): VirtualViewEntryData | null {
    return this.current;
  }

  gotoFirst(): boolean {
    return this.moveTo(this.documents("forward", null).next().value ?? null);
  }

  gotoLast(): boolean {
    return this.moveTo(this.documents("backward", null).next().value ?? null);
  }

  gotoNext(): boolean {
    if (!this.current) return this.gotoFirst();
    const next = this.documents("forward", VirtualViewMergedNavigator.keyOf(this.current)).next().value ?? null;
    return next ? this.moveTo(next) : false;
  }

  gotoPrev(): boolean {
    if (!this.current) return this.gotoLast();
    const prev = this.documents("backward", VirtualViewMergedNavigator.keyOf(this.current)).next().value ?? null;
    return prev ? this.moveTo(prev) : false;
  }

  /** Move the cursor to the document with this key (or the first after it). */
  gotoKey(key: MergedEntryKey): boolean {
    const comparator = this.comparator();
    if (!comparator) return false;
    // Start just before the key: read backward from it would skip it, so
    // read forward from the previous entry instead.
    const target = VirtualViewMergedNavigator.toSortKey(key);
    for (const entry of this.documents("forward", null)) {
      if (comparator.compare(entry.getSortKey(), target) >= 0) {
        return this.moveTo(entry);
      }
    }
    return false;
  }

  /**
   * The document at a tree position string of the underlying view (as
   * returned by `entry.getPositionStr()`), when it belongs to one of the
   * merged categories — so hosts can keep using ordinary positions as
   * paging tokens. `null` otherwise.
   */
  getPos(position: string): VirtualViewEntryData | null {
    const lookup = new VirtualViewNavigator(this.view, this.view.getRoot(), WithCategories.YES, WithDocuments.YES, null, false);
    const entry = lookup.getPos(position);
    if (!entry || !entry.isDocument()) {
      return null;
    }
    for (let parent = entry.getParent(); parent; parent = parent.getParent()) {
      if (this.roots.includes(parent)) {
        return entry;
      }
    }
    return null;
  }

  /** Move the cursor to the document at a tree position (see {@link getPos}). */
  gotoPos(position: string): boolean {
    return this.moveTo(this.getPos(position));
  }

  private moveTo(entry: VirtualViewEntryData | null): boolean {
    if (!entry) return false;
    this.current = entry;
    return true;
  }
}
