import type { MindooDB, MindooDoc, ProcessChangesCursor } from "../../types";
import type { IVirtualViewDataProvider, VirtualViewUpdateOptions } from "./IVirtualViewDataProvider";
import type { VirtualView } from "./VirtualView";
import type { VirtualViewColumn } from "./VirtualViewColumn";
import { VirtualViewDataChange } from "./VirtualViewDataChange";
import type { DocumentFilterFunction } from "./types";

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
}

/**
 * Data provider that reads documents from a MindooDB and provides them
 * to a VirtualView. Incremental updates are driven by
 * `iterateChangesSince`, which prefetches upcoming documents in parallel
 * and emits lightweight tombstones for deleted and inaccessible documents,
 * so removals never pay document materialization.
 */
export class MindooDBVirtualViewDataProvider implements IVirtualViewDataProvider {
  private readonly origin: string;
  private readonly db: MindooDB;
  private readonly filterFunction: DocumentFilterFunction | null;
  private readonly includeAllDocumentFields: boolean;
  
  private view: VirtualView | null = null;
  private cursor: ProcessChangesCursor | null = null;
  
  /** Track documents currently in the view from this provider */
  private knownDocIds: Set<string> = new Set();

  constructor(options: MindooDBVirtualViewDataProviderOptions) {
    this.origin = options.origin;
    this.db = options.db;
    this.filterFunction = options.filterFunction ?? null;
    this.includeAllDocumentFields = options.includeAllDocumentFields ?? false;
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

    // Drive incremental updates from the document changefeed. Deleted and
    // inaccessible documents arrive as lightweight tombstones (never
    // materialized), and upcoming live documents are prefetched in parallel
    // by the iterator's built-in prefetch window.
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor)) {
      const docId = doc.getId();

      if (doc.isDeleted()) {
        if (this.knownDocIds.has(docId)) {
          change.removeEntry(docId);
          this.knownDocIds.delete(docId);
        }
      } else {
        const passesFilter = !this.filterFunction || this.filterFunction(doc);

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
    };
  }

  importCacheState(state: unknown): void {
    const s = state as { cursor?: ProcessChangesCursor | null; knownDocIds?: string[] };
    this.cursor = s.cursor ?? null;
    if (s.knownDocIds) {
      this.knownDocIds = new Set(s.knownDocIds);
    }
  }
}
