import { VirtualViewColumn } from "./VirtualViewColumn";
import { VirtualViewEntryData } from "./VirtualViewEntryData";
import { VirtualViewDataChange } from "./VirtualViewDataChange";
import { ViewEntrySortKey } from "./ViewEntrySortKey";
import { ViewEntrySortKeyComparator } from "./ViewEntrySortKeyComparator";
import type { IVirtualViewDataProvider, VirtualViewUpdateOptions } from "./IVirtualViewDataProvider";
import {
  CategorizationStyle,
  ColumnSorting,
  TotalMode,
  ORIGIN_VIRTUALVIEW,
  scopedDocIdKey,
  createScopedDocId,
  parseScopedDocIdKey,
} from "./types";
import type { LocalCacheStore } from "../../cache/LocalCacheStore";
import type { ICacheable } from "../../cache/CacheManager";
import type { CacheManager } from "../../cache/CacheManager";
import type { MindooDB } from "../../types";
import { VirtualViewFilingJoin, isFilingAwareDataProvider, type FilingJoinState } from "./VirtualViewFilingJoin";

/** Statistics passed to {@link VirtualView.onDidUpdate} listeners. */
export interface VirtualViewUpdateStats {
  /** Entries added or replaced by the applied change batch. */
  addedCount: number;
  /** Entries removed by the applied change batch. */
  removedCount: number;
}

/**
 * How a `withDB` data source was resolved at build time (see
 * `createViewDataProvider`): read via {@link VirtualView.getDataSourceInfo}
 * to log or surface in a UI why a view runs on the slow document path.
 */
export interface ViewDataSourceInfo {
  /** The data path chosen for this origin. */
  source: "summary" | "documents";
  /**
   * When `source` is `"documents"`, the reasons why the summary path was
   * not usable (empty for an explicit `useFullDocuments` request).
   */
  fallbackReasons: string[];
}

/**
 * Compact serialized sort key stored in the virtual-view tree cache.
 */
interface SerializedVirtualViewSortKey {
  /** Whether this sort key represents a category entry instead of a document entry. */
  c: boolean;
  /** Sort values used by the entry comparator. */
  v: unknown[];
  /** Source data-provider origin for the entry represented by this key. */
  o: string;
  /** Document or category id for the entry represented by this key. */
  d: string;
}

/**
 * Cached count values for a virtual-view entry.
 */
type SerializedVirtualViewCounts = [
  childCount: number,
  childCategoryCount: number,
  childDocumentCount: number,
  descendantCount: number,
  descendantDocumentCount: number,
  descendantCategoryCount: number,
];

/**
 * Compact serialized virtual-view tree node stored in the local cache.
 *
 * Short property names keep the persisted cache smaller; the comments document
 * the expanded meaning of each field for editor hover help.
 */
interface SerializedVirtualViewNode {
  /** Source data-provider origin for this entry. */
  o: string;
  /** Document or generated category id for this entry. */
  d: string;
  /** Sort key needed to restore this entry without recalculating sort values. */
  sk: SerializedVirtualViewSortKey;
  /** Materialized column values for this entry, keyed by column name. */
  cv: Record<string, unknown>;
  /** Tree indentation level for this entry. */
  il: number;
  /** Position of this entry among its siblings. */
  si: number;
  /** Category-order direction flag used by this entry's child comparator. */
  cod: boolean;
  /** Cached child and descendant counts, stored in restore argument order. */
  cnt: SerializedVirtualViewCounts;
  /** Recursively serialized child entries. */
  ch: SerializedVirtualViewNode[];
  /** Cached total values for total columns, omitted when the entry has no totals. */
  tv?: Record<string, number>;
  /** Internal decryption key metadata for document entries, omitted for categories/root. */
  dk?: string;
}

/** One applied change batch in the view-cache journal (compact keys). */
interface SerializedViewChange {
  /** Origin. */
  o: string;
  /** Removed doc ids. */
  r: string[];
  /** Additions: [docId, column values, decryption key id?]. */
  a: Array<[string, Record<string, unknown>, string?] | [string, Record<string, unknown>]>;
}

/** One journal segment (`vvj` record) written by a cache flush. */
interface SerializedJournalSegment {
  changes: SerializedViewChange[];
  providerStates: Record<string, unknown>;
  filing?: FilingJoinState;
  categoryIdCounter?: number;
}

/** Rewrite the snapshot once the journal holds more than this share of its entries. */
const JOURNAL_COMPACT_RATIO = 0.1;
/** ...but never for fewer journal entries than this (tiny views). */
const JOURNAL_MIN_COMPACT_ENTRIES = 100;

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

  /** Filing stores joined into this view (`withFilingStore`), or null. */
  private filingJoin: VirtualViewFilingJoin | null = null;

  /** Build-time data-source decision per origin (only for builder `withDB` sources) */
  private dataSourceInfoByOrigin: Map<string, ViewDataSourceInfo> = new Map();
  
  /** Entries pending sibling index recalculation */
  private pendingSiblingIndexFlush: Set<VirtualViewEntryData> = new Set();
  
  /** Last index update timestamp */
  private lastIndexUpdateTime: number | null = null;

  // Local cache support
  private cacheManager: CacheManager | null = null;
  private viewCacheId: string | null = null;
  private viewCacheVersion: string | null = null;
  private isDirty: boolean = false;
  /**
   * Minimum time between full serializations of the view cache. Serializing
   * the whole tree is expensive, so active editing sessions should not pay
   * it on every periodic cache flush (default flush interval is 5 s). A
   * deferred flush keeps the dirty flag set and lands once the interval has
   * elapsed; shutdown/deregister flushes bypass the interval (`force`).
   */
  private minCacheFlushIntervalMs: number = 15000;
  /** Timestamp of the last completed cache serialization. */
  private lastCacheFlushAt: number = 0;
  /** Whether the most recent flush attempt was deferred by the min interval. */
  private lastFlushDeferred: boolean = false;

  // Change journal (see flushToCache): applied change batches since the
  // last flush, appended to the cache as small segments instead of
  // rewriting the whole tree; the snapshot is rewritten only when the
  // journal outgrows JOURNAL_COMPACT_RATIO of it, or on forced flushes.
  private journalPending: SerializedViewChange[] = [];
  private journalEntriesSinceSnapshot: number = 0;
  /** Document entries in the last written/restored snapshot, `null` = none yet. */
  private snapshotDocCount: number | null = null;
  private nextJournalSegment: number = 0;
  private replayingJournal: boolean = false;

  // Live-view support (see bindTo/onDidUpdate)
  private updateListeners: Set<(stats: VirtualViewUpdateStats) => void> = new Set();
  private liveUnsubscribes: Array<() => void> = [];
  private liveUpdateRunning: boolean = false;
  private liveUpdatePending: boolean = false;
  private liveBoundDbs: Set<MindooDB> = new Set();

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
   * Record how a data source was resolved at build time (summary vs
   * documents). Called by the view builder; not intended for user code.
   */
  setDataSourceInfo(origin: string, info: ViewDataSourceInfo): this {
    this.dataSourceInfoByOrigin.set(origin, { ...info, fallbackReasons: [...info.fallbackReasons] });
    return this;
  }

  /**
   * How the `withDB` source with the given origin was resolved at build
   * time: `"summary"` (fast path, no document materialization) or
   * `"documents"` with the {@link ViewDataSourceInfo.fallbackReasons}
   * explaining why the summary path was not usable. Returns `undefined`
   * for sources that were not resolved by the builder (custom providers,
   * `withMindooDB`, unknown origins).
   */
  getDataSourceInfo(origin: string): ViewDataSourceInfo | undefined {
    const info = this.dataSourceInfoByOrigin.get(origin);
    return info ? { ...info, fallbackReasons: [...info.fallbackReasons] } : undefined;
  }

  /**
   * The build-time data-source decision for every `withDB` origin (see
   * {@link getDataSourceInfo}).
   */
  getAllDataSourceInfos(): Map<string, ViewDataSourceInfo> {
    return new Map(
      Array.from(this.dataSourceInfoByOrigin, ([origin, info]) => [
        origin,
        { ...info, fallbackReasons: [...info.fallbackReasons] },
      ])
    );
  }

  /**
   * Update all data providers (async)
   *
   * @param options Optional batching/progress/cancellation options,
   *   forwarded to each data provider (see {@link VirtualViewUpdateOptions}).
   */
  async update(options?: VirtualViewUpdateOptions): Promise<void> {
    await this.refreshFilingJoin();
    for (const provider of this.dataProviderByOrigin.values()) {
      await provider.update(options);
    }
  }

  /**
   * Attach the filing stores this view joins (`withFilingStore`). Called by
   * the view builder before the first update; not intended for user code.
   */
  setFilingJoin(join: VirtualViewFilingJoin | null): this {
    this.filingJoin = join;
    return this;
  }

  /** The filing stores joined into this view, or `null`. */
  getFilingJoin(): VirtualViewFilingJoin | null {
    return this.filingJoin;
  }

  /**
   * Bring the joined filing indexes up to date FIRST (otherwise a fresh
   * build would briefly show rows without their folders) and hand the
   * membership delta to every provider; providers keep it until they have
   * processed it, so an interrupted provider update loses nothing.
   */
  private async refreshFilingJoin(): Promise<void> {
    if (!this.filingJoin) {
      return;
    }
    const changes = await this.filingJoin.refresh();
    if (changes !== "all" && changes.size === 0) {
      return;
    }
    for (const provider of this.dataProviderByOrigin.values()) {
      if (isFilingAwareDataProvider(provider)) {
        provider.onFilingChanges(changes);
      }
    }
    this.markViewDirty();
  }

  /**
   * Update a specific data provider by origin
   *
   * @param options Optional batching/progress/cancellation options,
   *   forwarded to the data provider (see {@link VirtualViewUpdateOptions}).
   */
  async updateOrigin(origin: string, options?: VirtualViewUpdateOptions): Promise<void> {
    const provider = this.dataProviderByOrigin.get(origin);
    if (provider) {
      await this.refreshFilingJoin();
      await provider.update(options);
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
    if (this.cacheManager && !this.replayingJournal && change.hasChanges()) {
      this.journalPending.push({
        o: change.origin,
        r: Array.from(change.getRemovals()),
        a: Array.from(change.getAdditions().values(), (entry) =>
          entry.decryptionKeyId !== undefined
            ? [entry.docId, entry.values, entry.decryptionKeyId]
            : [entry.docId, entry.values],
        ),
      });
    }

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
      const addedEntries = this.addEntry(origin, docId, columnValues, root, this.categoryColumns, entryData.decryptionKeyId);
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

    // Notify live-view listeners after every applied change batch (this
    // covers both full updates and the intermediate batches produced by
    // `VirtualViewUpdateOptions.applyBatchSize`).
    if (this.updateListeners.size > 0) {
      const stats: VirtualViewUpdateStats = {
        addedCount: change.getAdditions().size,
        removedCount: change.getRemovals().size,
      };
      for (const listener of this.updateListeners) {
        try {
          listener(stats);
        } catch (error) {
          // Listener errors must not disturb view maintenance.
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Live views (reactive support)
  // ---------------------------------------------------------------------------

  /**
   * Register a listener fired after every applied change batch with
   * `{ addedCount, removedCount }` — the hook point for UI re-rendering.
   * Also fires for the intermediate batches of interruptible updates.
   *
   * @returns An unsubscribe function.
   */
  onDidUpdate(listener: (stats: VirtualViewUpdateStats) => void): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  /**
   * Bind this view to a database's change feed: whenever the database
   * reports changes, `update()` runs automatically (coalesced — while an
   * update is running further events only set a pending flag, and one
   * follow-up update runs afterwards, so there is never an update
   * backlog). Providers are cursor-based and idempotent, so no event
   * payload inspection is needed.
   *
   * An initial update is scheduled immediately. Call the returned
   * function (or {@link unbind}) to detach.
   */
  bindTo(db: MindooDB): () => void {
    if (!db.addChangeListener) {
      throw new Error("This MindooDB instance does not support change listeners.");
    }
    const unsubscribes: Array<() => void> = [
      db.addChangeListener(() => {
        this.scheduleLiveUpdate();
      }),
    ];
    // Filing changes live in the filing databases: bind those too (once
    // per view), so filing/moving documents updates the view live.
    for (const filingDb of this.filingJoin?.getDatabases() ?? []) {
      if (filingDb === db || this.liveBoundDbs.has(filingDb) || !filingDb.addChangeListener) {
        continue;
      }
      this.liveBoundDbs.add(filingDb);
      const unsubscribeFiling = filingDb.addChangeListener(() => {
        this.scheduleLiveUpdate();
      });
      unsubscribes.push(() => {
        unsubscribeFiling();
        this.liveBoundDbs.delete(filingDb);
      });
    }
    this.liveBoundDbs.add(db);
    const unsubscribe = () => {
      for (const fn of unsubscribes) fn();
      this.liveBoundDbs.delete(db);
    };
    this.liveUnsubscribes.push(unsubscribe);
    this.scheduleLiveUpdate();
    return () => {
      unsubscribe();
      this.liveUnsubscribes = this.liveUnsubscribes.filter((fn) => fn !== unsubscribe);
    };
  }

  /** Detach all change-feed bindings created via {@link bindTo}. */
  unbind(): void {
    for (const unsubscribe of this.liveUnsubscribes) {
      unsubscribe();
    }
    this.liveUnsubscribes = [];
  }

  private scheduleLiveUpdate(): void {
    if (this.liveUpdateRunning) {
      this.liveUpdatePending = true;
      return;
    }
    void this.runLiveUpdate();
  }

  private async runLiveUpdate(): Promise<void> {
    this.liveUpdateRunning = true;
    try {
      do {
        this.liveUpdatePending = false;
        try {
          await this.update();
        } catch (error) {
          // Live updates are fire-and-forget; the next change event retries.
        }
      } while (this.liveUpdatePending);
    } finally {
      this.liveUpdateRunning = false;
    }
  }

  /**
   * Remove every document entry sourced from `origin` whose stored
   * `decryptionKeyId` matches the given key id.
   *
   * Used by the key visibility reconciliation layer when a key is
   * revoked so view consumers stop seeing entries they can no longer
   * decrypt. Implemented in terms of `applyChanges` so that removal
   * triggers the normal cleanup paths (empty parent categories collapse,
   * change notifications fire, etc.).
   *
   * The function is a no-op when no matching document entries exist, so
   * callers may invoke it speculatively without performance concerns.
   */
  purgeEntriesByDecryptionKeyId(origin: string, decryptionKeyId: string): void {
    const change = new VirtualViewDataChange(origin);
    for (const [scopedKey, entries] of this.entriesByDocId.entries()) {
      const parsed = parseScopedDocIdKey(scopedKey);
      if (parsed.origin !== origin) {
        continue;
      }
      if (entries.some((entry) => entry.isDocument() && entry.getDecryptionKeyId() === decryptionKeyId)) {
        change.removeEntry(parsed.docId);
      }
    }

    if (change.hasChanges()) {
      this.applyChanges(change);
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
    remainingCategoryColumns: VirtualViewColumn[],
    decryptionKeyId?: string,
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
        childComparator,
        decryptionKeyId,
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
        const addedEntries = this.addEntry(origin, docId, columnValues, currentParent, remainingColumns, decryptionKeyId);
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
        const addedEntries = this.addEntry(origin, docId, columnValues, existingCategory, remainingColumns, decryptionKeyId);
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
    this.pendingSiblingIndexFlush.add(entry);
  }

  private processPendingSiblingIndexUpdates(): void {
    for (const entry of this.pendingSiblingIndexFlush) {
      const children = entry.getChildEntries();
      let pos = 1;
      for (const child of children) {
        child.setSiblingIndex(pos++);
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
  async setCacheManager(
    cacheManager: CacheManager,
    viewId: string,
    version: string,
    options?: { minCacheFlushIntervalMs?: number },
  ): Promise<boolean> {
    this.cacheManager = cacheManager;
    this.viewCacheId = viewId;
    this.viewCacheVersion = version;
    if (options?.minCacheFlushIntervalMs !== undefined) {
      this.minCacheFlushIntervalMs = Math.max(0, options.minCacheFlushIntervalMs);
    }
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
    if (this.lastFlushDeferred) {
      // The last flush attempt was deferred by the min flush interval: keep
      // the dirty flag and re-arm the cache manager so the deferred state
      // lands on a later flush cycle.
      this.lastFlushDeferred = false;
      this.cacheManager?.markDirty();
      return;
    }
    this.isDirty = false;
  }

  /**
   * Export the view state to the cache store — as snapshot + change
   * journal:
   *
   * - Normally only the change batches applied since the last flush are
   *   appended as a small journal segment (`vvj` records), together with
   *   the data providers' cursors. Cost: O(changes), not O(view).
   * - The full tree snapshot (`vv`) is rewritten when there is none yet,
   *   when the journal holds more than {@link JOURNAL_COMPACT_RATIO} of
   *   the snapshot's entries (compaction), and on forced flushes
   *   (shutdown/deregister — "on close"). Full snapshots are still
   *   throttled by {@link minCacheFlushIntervalMs}; a throttled compaction
   *   writes a journal segment instead.
   *
   * Restoring loads the snapshot and replays the journal segments written
   * after it.
   */
  async flushToCache(store: LocalCacheStore, options?: { force?: boolean }): Promise<number> {
    const now = Date.now();
    const pending = this.journalPending;
    const pendingCount = pending.reduce((sum, change) => sum + change.r.length + change.a.length, 0);
    const journalTooLarge =
      this.snapshotDocCount !== null &&
      this.journalEntriesSinceSnapshot + pendingCount >
        Math.max(JOURNAL_MIN_COMPACT_ENTRIES, this.snapshotDocCount * JOURNAL_COMPACT_RATIO);
    const wantSnapshot = options?.force === true || this.snapshotDocCount === null || journalTooLarge;
    const throttled =
      !options?.force &&
      this.lastCacheFlushAt > 0 &&
      now - this.lastCacheFlushAt < this.minCacheFlushIntervalMs;

    if (wantSnapshot && throttled && this.snapshotDocCount === null) {
      // No snapshot to append to yet: defer as before.
      this.lastFlushDeferred = true;
      return 0;
    }
    this.lastFlushDeferred = false;

    if (wantSnapshot && !throttled) {
      const journalBase = this.nextJournalSegment;
      const state = this.exportCacheState(journalBase);
      await store.put("vv", this.getCachePrefix(), state);
      this.journalPending = [];
      this.journalEntriesSinceSnapshot = 0;
      this.snapshotDocCount = this.countDocumentEntries();
      this.lastCacheFlushAt = now;
      // Every existing segment is either folded into this snapshot or a
      // leftover of an older state (e.g. after a failed restore).
      await this.deleteJournalSegments(store, () => true);
      return 1;
    }

    // Provider states without their `knownDocIds`: those equal the view's
    // document entries of the provider's origin and are rebuilt from the
    // tree on replay — writing them per segment would make every flush
    // O(view) again.
    const providerStates = this.exportProviderStates();
    for (const [origin, state] of Object.entries(providerStates)) {
      if (state && typeof state === "object" && Array.isArray((state as { knownDocIds?: unknown }).knownDocIds)) {
        providerStates[origin] = { ...(state as object), knownDocIds: undefined, knownDocIdsFromTree: true };
      }
    }
    const segment: SerializedJournalSegment = {
      changes: pending,
      providerStates,
      filing: this.filingJoin?.exportState(),
      categoryIdCounter: this.categoryIdCounter,
    };
    const segmentNo = this.nextJournalSegment;
    await store.put(
      "vvj",
      `${this.getCachePrefix()}/${String(segmentNo).padStart(10, "0")}`,
      new TextEncoder().encode(JSON.stringify(segment)),
    );
    this.nextJournalSegment = segmentNo + 1;
    this.journalPending = this.journalPending.slice(pending.length);
    this.journalEntriesSinceSnapshot += pendingCount;
    return 1;
  }

  /** Doc ids of the document entries an origin contributes to the view. */
  private documentIdsOfOrigin(origin: string): string[] {
    const docIds: string[] = [];
    for (const [scopedKey, entries] of this.entriesByDocId) {
      const parsed = parseScopedDocIdKey(scopedKey);
      if (parsed.origin === origin && entries.some((entry) => entry.isDocument())) {
        docIds.push(parsed.docId);
      }
    }
    return docIds;
  }

  private countDocumentEntries(): number {
    let count = 0;
    for (const entries of this.entriesByDocId.values()) {
      if (entries.some((entry) => entry.isDocument())) {
        count++;
      }
    }
    return count;
  }

  private exportProviderStates(): Record<string, unknown> {
    const providerStates: Record<string, unknown> = {};
    for (const [origin, provider] of this.dataProviderByOrigin) {
      if ("exportCacheState" in provider && typeof (provider as any).exportCacheState === "function") {
        providerStates[origin] = (provider as any).exportCacheState();
      }
    }
    return providerStates;
  }

  /** Journal segment numbers of this view in the store. */
  private async listJournalSegments(store: LocalCacheStore): Promise<number[]> {
    const prefix = `${this.getCachePrefix()}/`;
    const segments: number[] = [];
    for (const id of await store.list("vvj")) {
      if (id.startsWith(prefix)) {
        const segment = Number(id.slice(prefix.length));
        if (Number.isInteger(segment)) {
          segments.push(segment);
        }
      }
    }
    return segments.sort((a, b) => a - b);
  }

  private async deleteJournalSegments(store: LocalCacheStore, predicate: (segment: number) => boolean): Promise<void> {
    try {
      for (const segment of await this.listJournalSegments(store)) {
        if (predicate(segment)) {
          await store.delete("vvj", `${this.getCachePrefix()}/${String(segment).padStart(10, "0")}`);
        }
      }
    } catch {
      // Stale segments are ignored on restore (they predate the snapshot).
    }
  }

  /**
   * Serialize the entire tree structure for caching (version 2).
   * Each node stores its sort key, column values, counts, totals,
   * and children — so restoration is O(n) without re-sorting.
   */
  private exportCacheState(journalBase: number): Uint8Array {
    const root = this.getRoot();
    const providerStates = this.exportProviderStates();

    const snapshot = {
      version: 2,
      journalBase,
      categoryIdCounter: this.categoryIdCounter,
      categorizationStyle: this.categorizationStyle,
      docOrderDescending: [...this.docOrderDescending],
      providerStates,
      filing: this.filingJoin?.exportState(),
      tree: this.serializeNode(root),
    };

    return new TextEncoder().encode(JSON.stringify(snapshot));
  }

  /**
   * Serialize a subtree iteratively (explicit stack) so deep trees cannot
   * overflow the call stack.
   */
  private serializeNode(entry: VirtualViewEntryData): SerializedVirtualViewNode {
    const buildNode = (e: VirtualViewEntryData): SerializedVirtualViewNode => {
      const sk = e.getSortKey();
      const comp = e.getChildrenComparator();
      const node: SerializedVirtualViewNode = {
        o: e.origin,
        d: e.docId,
        sk: { c: sk.isCategory, v: [...sk.values], o: sk.origin, d: sk.docId },
        cv: e.getColumnValues(),
        il: e.getIndentLevels(),
        si: e.getSiblingIndex(),
        cod: comp.getCategoryOrderDescending(),
        cnt: [
          e.getChildCount(),
          e.getChildCategoryCount(),
          e.getChildDocumentCount(),
          e.getDescendantCount(),
          e.getDescendantDocumentCount(),
          e.getDescendantCategoryCount(),
        ],
        ch: [],
      };
      const tv = e.getTotalValues();
      if (tv && Object.keys(tv).length > 0) {
        node.tv = tv;
      }
      if (e.isDocument() && e.getDecryptionKeyId()) {
        node.dk = e.getDecryptionKeyId();
      }
      return node;
    };

    const rootNode = buildNode(entry);
    const stack: Array<{ entry: VirtualViewEntryData; node: SerializedVirtualViewNode }> = [
      { entry, node: rootNode },
    ];
    while (stack.length > 0) {
      const { entry: currentEntry, node } = stack.pop()!;
      for (const child of currentEntry.getChildEntries()) {
        const childNode = buildNode(child);
        node.ch.push(childNode);
        stack.push({ entry: child, node: childNode });
      }
    }
    return rootNode;
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
        if (!this.restoreFromTreeSnapshot(snapshot)) {
          return false;
        }
        await this.replayJournal(store, typeof snapshot.journalBase === "number" ? snapshot.journalBase : 0);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Replay the journal segments written after the snapshot (numbers >=
   * `journalBase`), in order; the last segment's provider cursors and
   * filing positions win. A missing or corrupt segment ends the replay:
   * later segments would build on a state that never existed, and the
   * providers' cursors of the last good segment make the next update catch
   * up from there.
   */
  private async replayJournal(store: LocalCacheStore, journalBase: number): Promise<void> {
    this.snapshotDocCount = this.countDocumentEntries();
    this.journalEntriesSinceSnapshot = 0;
    this.nextJournalSegment = journalBase;
    let segments: number[];
    try {
      segments = (await this.listJournalSegments(store)).filter((segment) => segment >= journalBase);
    } catch {
      return;
    }
    this.replayingJournal = true;
    // Only the last replayed segment's provider cursors matter.
    const lastProviderStates = new Map<string, unknown>();
    try {
      for (const segmentNo of segments) {
        if (segmentNo !== this.nextJournalSegment) {
          break; // gap
        }
        const bytes = await store.get("vvj", `${this.getCachePrefix()}/${String(segmentNo).padStart(10, "0")}`);
        if (!bytes) break;
        const segment = JSON.parse(new TextDecoder().decode(bytes)) as SerializedJournalSegment;
        for (const serialized of segment.changes ?? []) {
          const change = new VirtualViewDataChange(serialized.o);
          for (const docId of serialized.r) change.removeEntry(docId);
          for (const [docId, values, decryptionKeyId] of serialized.a) {
            change.addEntry(docId, values, decryptionKeyId);
          }
          this.applyChanges(change);
          this.journalEntriesSinceSnapshot += serialized.r.length + serialized.a.length;
        }
        for (const [origin, rawState] of Object.entries(segment.providerStates ?? {})) {
          lastProviderStates.set(origin, rawState);
        }
        this.filingJoin?.importState(segment.filing);
        if (typeof segment.categoryIdCounter === "number") {
          this.categoryIdCounter = Math.max(this.categoryIdCounter, segment.categoryIdCounter);
        }
        this.nextJournalSegment = segmentNo + 1;
      }
    } catch {
      // Keep what was replayed; see above.
    } finally {
      for (const [origin, rawState] of lastProviderStates) {
        const provider = this.dataProviderByOrigin.get(origin);
        let state = rawState;
        if (state && typeof state === "object" && (state as { knownDocIdsFromTree?: boolean }).knownDocIdsFromTree) {
          state = { ...(state as object), knownDocIds: this.documentIdsOfOrigin(origin) };
        }
        if (provider && "importCacheState" in provider && typeof (provider as any).importCacheState === "function") {
          (provider as any).importCacheState(state);
        }
      }
      this.replayingJournal = false;
      this.isDirty = false;
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
    this.filingJoin?.importState(snapshot.filing as FilingJoinState | undefined);

    this.rootEntry = this.deserializeNode(treeData, null, docOrderDesc);
    this.indexBuilt = true;
    return true;
  }

  /**
   * Restore a subtree iteratively (explicit stack) so deep trees cannot
   * overflow the call stack.
   */
  private deserializeNode(
    data: any,
    parent: VirtualViewEntryData | null,
    docOrderDesc: boolean[],
  ): VirtualViewEntryData {
    const buildEntry = (nodeData: any, nodeParent: VirtualViewEntryData | null): VirtualViewEntryData => {
      const sk = ViewEntrySortKey.createSortKey(
        nodeData.sk.c,
        nodeData.sk.v,
        nodeData.sk.o,
        nodeData.sk.d,
      );
      const comparator = new ViewEntrySortKeyComparator(
        this.categorizationStyle,
        nodeData.cod,
        docOrderDesc,
      );

      const entry = new VirtualViewEntryData(
        this,
        nodeParent,
        nodeData.o,
        nodeData.d,
        sk,
        comparator,
        nodeData.dk,
      );
      entry.setColumnValues(nodeData.cv ?? {});
      entry.setIndentLevels(nodeData.il ?? 0);
      entry.setSiblingIndex(nodeData.si ?? 0);

      if (nodeData.tv) {
        entry._restoreTotalValues(nodeData.tv);
      }

      const cnt: number[] = nodeData.cnt ?? [0, 0, 0, 0, 0, 0];
      entry._restoreCounts(cnt[0], cnt[1], cnt[2], cnt[3], cnt[4], cnt[5]);

      const scopedKey = scopedDocIdKey(createScopedDocId(nodeData.o, nodeData.d));
      const existing = this.entriesByDocId.get(scopedKey);
      if (existing) {
        existing.push(entry);
      } else {
        this.entriesByDocId.set(scopedKey, [entry]);
      }
      return entry;
    };

    const rootEntry = buildEntry(data, parent);
    const stack: Array<{ data: any; entry: VirtualViewEntryData }> = [
      { data, entry: rootEntry },
    ];
    while (stack.length > 0) {
      const { data: nodeData, entry } = stack.pop()!;
      if (nodeData.ch) {
        for (const childData of nodeData.ch) {
          const child = buildEntry(childData, entry);
          entry._addRestoredChild(child);
          stack.push({ data: childData, entry: child });
        }
      }
    }
    return rootEntry;
  }

  /**
   * Mark the view as dirty (call after applyChanges).
   */
  private markViewDirty(): void {
    this.isDirty = true;
    this.cacheManager?.markDirty();
  }
}
