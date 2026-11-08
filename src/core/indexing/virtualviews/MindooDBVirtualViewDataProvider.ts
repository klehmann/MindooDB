import type { MindooDB, MindooDoc, ProcessChangesCursor } from "../../types";
import type { IVirtualViewDataProvider, VirtualViewUpdateOptions } from "./IVirtualViewDataProvider";
import type { VirtualView } from "./VirtualView";
import type { VirtualViewColumn } from "./VirtualViewColumn";
import { VirtualViewDataChange } from "./VirtualViewDataChange";
import type { DocumentFilterFunction } from "./types";
import { evaluateExpression } from "../../expressions/evaluateExpression";
import type { FilingRefChanges, IFilingAwareDataProvider } from "./VirtualViewFilingJoin";

/**
 * Options for creating a MindooDBVirtualViewDataProvider
 */
export interface MindooDBVirtualViewDataProviderOptions {
  /** Unique origin identifier for this data provider */
  origin: string;
  
  /** The MindooDB to read documents from */
  db: MindooDB;
  
  /** Optional filter function to select which documents to include */
  filterFunction?: DocumentFilterFunction;

  /**
   * When `true`, every (non-underscore) document field is copied into the
   * view entry's column values, mirroring the legacy behavior. Defaults to
   * `false`: only the fields the view's columns reference are kept, which
   * significantly reduces memory usage and view-cache size for documents
   * with large payloads. Enable this for consumers that need free-form
   * field access on view entries (e.g. formula languages evaluating
   * arbitrary fields at read time).
   */
  includeAllDocumentFields?: boolean;

  /**
   * Physical identity `"<tenantId>/<dbId>"` of `db`, used to match filing
   * references (`folders()` / `inFolder()`). Defaults to the database's
   * own tenant and store id.
   */
  dbKey?: string;
}

/** `"<tenantId>/<dbId>"`, or `null` for database doubles without that identity. */
function physicalDbKey(db: MindooDB): string | null {
  try {
    const tenantId = db.getTenant?.()?.getId?.();
    const dbId = db.getStore?.()?.getId?.();
    return typeof tenantId === "string" && typeof dbId === "string" ? `${tenantId}/${dbId}` : null;
  } catch {
    return null;
  }
}

/**
 * Filter function variant that also receives the folder lookup of the
 * view's joined filing stores (used for declarative filters converted to
 * functions, so `folders()` / `inFolder()` work on the document path).
 */
export type FilingAwareDocumentFilter = ((doc: MindooDoc) => boolean) & {
  withFolders?: (doc: MindooDoc, folders: ((store: string) => readonly string[]) | undefined) => boolean;
};

/**
 * Data provider that reads documents from a MindooDB and provides them
 * to a VirtualView. Incremental updates are driven by
 * `iterateChangesSince`, which prefetches upcoming documents in parallel
 * and emits lightweight tombstones for deleted and inaccessible documents,
 * so removals never pay document materialization.
 */
export class MindooDBVirtualViewDataProvider implements IVirtualViewDataProvider, IFilingAwareDataProvider {
  private readonly origin: string;
  private readonly db: MindooDB;
  private readonly filterFunction: DocumentFilterFunction | null;
  private readonly includeAllDocumentFields: boolean;
  
  private view: VirtualView | null = null;
  private cursor: ProcessChangesCursor | null = null;
  
  /** Track documents currently in the view from this provider */
  private knownDocIds: Set<string> = new Set();

  private readonly dbKey: string | null;
  /** Documents whose folder membership changed (see onFilingChanges). */
  private pendingFilingDocIds: Set<string> = new Set();
  /** Rescan the whole changefeed on the next update (first build, log overflow). */
  private pendingFilingAll: boolean = false;

  constructor(options: MindooDBVirtualViewDataProviderOptions) {
    this.origin = options.origin;
    this.db = options.db;
    this.filterFunction = options.filterFunction ?? null;
    this.includeAllDocumentFields = options.includeAllDocumentFields ?? false;
    this.dbKey = options.dbKey ?? physicalDbKey(options.db);
  }

  onFilingChanges(changes: FilingRefChanges): void {
    if (changes === "all") {
      this.pendingFilingAll = true;
      this.pendingFilingDocIds.clear();
      return;
    }
    if (this.pendingFilingAll || !this.dbKey) {
      return;
    }
    const prefix = `${this.dbKey}/`;
    for (const ref of changes) {
      if (ref.startsWith(prefix)) {
        this.pendingFilingDocIds.add(ref.slice(prefix.length));
      }
    }
  }

  private foldersLookup(docId: string): ((store: string) => readonly string[]) | undefined {
    const join = this.view?.getFilingJoin();
    if (!join || !this.dbKey) {
      return undefined;
    }
    const physRef = `${this.dbKey}/${docId}`;
    return (store: string) => join.foldersOf(store, physRef);
  }

  private passesFilter(doc: MindooDoc): boolean {
    if (!this.filterFunction) {
      return true;
    }
    const filter = this.filterFunction as FilingAwareDocumentFilter;
    return filter.withFolders
      ? filter.withFolders(doc, this.foldersLookup(doc.getId()))
      : filter(doc);
  }

  /** Re-evaluate one document (or drop it) after a filing change. */
  private async reevaluate(
    docId: string,
    columns: VirtualViewColumn[],
    change: VirtualViewDataChange,
  ): Promise<void> {
    let doc: MindooDoc | null = null;
    try {
      doc = await this.db.getDocument(docId);
      if (doc.isDeleted()) {
        doc = null;
      }
    } catch {
      // Unknown, deleted or unreadable: not in the view.
      doc = null;
    }
    if (doc && this.passesFilter(doc)) {
      change.addEntry(docId, this.computeColumnValues(doc, columns), doc.getDecryptionKeyId());
      this.knownDocIds.add(docId);
    } else if (this.knownDocIds.has(docId)) {
      change.removeEntry(docId);
      this.knownDocIds.delete(docId);
    }
  }

  getOrigin(): string {
    return this.origin;
  }

  init(view: VirtualView): void {
    this.view = view;
  }

  async update(options?: VirtualViewUpdateOptions): Promise<void> {
    if (!this.view) {
      throw new Error("Data provider not initialized - call init() first");
    }
    const view = this.view;

    const applyBatchSize = options?.applyBatchSize ?? 100;
    const onProgress = options?.onProgress;
    const signal = options?.signal;
    // Best-effort total for progress reporting; changes arriving mid-run
    // are not counted. Only computed when someone listens for progress.
    const total = onProgress ? (this.db.countChangesSince?.(this.cursor) ?? 0) : 0;

    const columns = view.getColumns();
    let change = new VirtualViewDataChange(this.origin);
    let processed = 0;
    let processedInBatch = 0;

    const applyPendingChanges = () => {
      if (change.hasChanges()) {
        view.applyChanges(change);
        change = new VirtualViewDataChange(this.origin);
      }
    };

    // Returns true when the run should stop after the just-applied batch.
    // At this point `this.cursor` matches the applied view state, so a
    // subsequent update() resumes exactly where this run left off.
    // The signal is checked after the callback so an abort triggered inside
    // `onProgress` takes effect at the same batch boundary.
    const stopRequested = (): boolean => {
      const callbackStop =
        onProgress?.({ processed, total, origin: this.origin }) === false;
      return callbackStop || signal?.aborted === true;
    };

    if (signal?.aborted) {
      return;
    }

    // Folder membership changed for a set of documents that may not have
    // changed themselves: re-evaluate them after the changefeed run. When
    // everything has to be re-checked, simply rescan the changefeed.
    if (this.pendingFilingAll) {
      this.pendingFilingAll = false;
      this.pendingFilingDocIds.clear();
      this.cursor = null;
    }
    const filingDocIds = this.pendingFilingDocIds;
    const processedDocIds = filingDocIds.size > 0 ? new Set<string>() : null;

    // Drive incremental updates from the document changefeed. Deleted and
    // inaccessible documents arrive as lightweight tombstones (never
    // materialized), and upcoming live documents are prefetched in parallel
    // by the iterator's built-in prefetch window.
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor)) {
      const docId = doc.getId();
      processedDocIds?.add(docId);

      if (doc.isDeleted()) {
        if (this.knownDocIds.has(docId)) {
          change.removeEntry(docId);
          this.knownDocIds.delete(docId);
        }
      } else {
        const passesFilter = this.passesFilter(doc);

        if (passesFilter) {
          const columnValues = this.computeColumnValues(doc, columns);
          // Propagate the source document's encryption key id into the
          // view entry. This metadata is later used by
          // `VirtualView.purgeEntriesByDecryptionKeyId` to drop entries in
          // bulk when a key is revoked, without re-reading the database.
          change.addEntry(docId, columnValues, doc.getDecryptionKeyId());
          this.knownDocIds.add(docId);
        } else if (this.knownDocIds.has(docId)) {
          change.removeEntry(docId);
          this.knownDocIds.delete(docId);
        }
      }

      this.cursor = cursor;
      processed++;
      processedInBatch++;

      if (processedInBatch >= applyBatchSize) {
        applyPendingChanges();
        processedInBatch = 0;
        if (stopRequested()) {
          return;
        }
      }
    }

    // Filing-driven re-evaluations (documents the changefeed run did not
    // already cover).
    if (filingDocIds.size > 0) {
      for (const docId of filingDocIds) {
        if (!processedDocIds!.has(docId)) {
          await this.reevaluate(docId, columns, change);
        }
      }
      if (this.pendingFilingDocIds === filingDocIds) {
        this.pendingFilingDocIds = new Set();
      } else {
        for (const docId of filingDocIds) this.pendingFilingDocIds.delete(docId);
      }
    }

    // Apply any remaining changes and emit a final progress report.
    applyPendingChanges();
    if (onProgress) {
      onProgress({ processed, total, origin: this.origin });
    }
  }

  /**
   * Compute column values for a document using column value functions.
   *
   * By default only the fields the view's columns reference are copied into
   * the result, keeping view entries (and the serialized view cache) small.
   * With `includeAllDocumentFields: true` every non-underscore document
   * field is copied first, mirroring the legacy behavior for consumers that
   * need free-form field access on view entries.
   */
  private computeColumnValues(
    doc: MindooDoc,
    columns: VirtualViewColumn[]
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const docData = doc.getData();

    if (this.includeAllDocumentFields) {
      // Copy all fields from the document (skipping internal fields)
      for (const [key, value] of Object.entries(docData)) {
        if (!key.startsWith("_")) {
          values[key] = value;
        }
      }
    }

    // Apply column value functions (which may override or add values)
    for (const column of columns) {
      if (column.valueFunction) {
        const computedValue = column.valueFunction(doc, values, this.origin);
        values[column.name] = computedValue;
      } else if (column.expression) {
        // Declarative expression columns (JSON-serializable view designs):
        // evaluated against the full document payload plus metadata.
        values[column.name] = evaluateExpression(column.expression, {
          doc: docData as Record<string, unknown>,
          values,
          origin: this.origin,
          docId: doc.getId(),
          createdAt: new Date(doc.getCreatedAt()).toISOString(),
          lastModifiedAt: new Date(doc.getLastModified()).toISOString(),
          decryptionKeyId: doc.getDecryptionKeyId(),
          witnessed: doc.isWitnessed(),
          awaitingWitness: doc.isAwaitingWitness(),
          variables: {},
          folders: this.foldersLookup(doc.getId()),
        });
      } else if (values[column.name] === undefined) {
        // If no value function and no value from doc, use the document data directly
        // This handles the case where the column name matches a document field
        values[column.name] = docData[column.name];
      }
    }

    return values;
  }

  /**
   * Reset the provider state (useful for full rebuilds)
   */
  reset(): void {
    this.cursor = null;
    this.knownDocIds.clear();
    this.pendingFilingAll = false;
    this.pendingFilingDocIds.clear();
  }

  /**
   * Get the current cursor position
   */
  getCursor(): ProcessChangesCursor | null {
    return this.cursor;
  }

  /**
   * Get the number of documents currently tracked by this provider
   */
  getKnownDocCount(): number {
    return this.knownDocIds.size;
  }

  // ---------------------------------------------------------------------------
  // Cache serialization
  // ---------------------------------------------------------------------------

  exportCacheState(): unknown {
    return {
      cursor: this.cursor,
      knownDocIds: Array.from(this.knownDocIds),
      pendingFilingAll: this.pendingFilingAll || undefined,
      pendingFilingDocIds: this.pendingFilingDocIds.size > 0 ? Array.from(this.pendingFilingDocIds) : undefined,
    };
  }

  importCacheState(state: unknown): void {
    const s = state as {
      cursor?: ProcessChangesCursor | null;
      knownDocIds?: string[];
      pendingFilingAll?: boolean;
      pendingFilingDocIds?: string[];
    };
    this.cursor = s.cursor ?? null;
    if (s.knownDocIds) {
      this.knownDocIds = new Set(s.knownDocIds);
    }
    this.pendingFilingAll = s.pendingFilingAll === true;
    this.pendingFilingDocIds = new Set(s.pendingFilingDocIds ?? []);
  }
}
