import type { MindooDB, MindooDoc, ProcessChangesCursor } from "../../types";
import type { IVirtualViewDataProvider } from "./IVirtualViewDataProvider";
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
  
  /** Page size for incremental processing (default: 100) */
  pageSize?: number;
}

/**
 * Data provider that reads documents from a MindooDB and provides them
 * to a VirtualView. Uses iterateChangesSince for incremental updates.
 */
export class MindooDBVirtualViewDataProvider implements IVirtualViewDataProvider {
  private readonly origin: string;
  private readonly db: MindooDB;
  private readonly filterFunction: DocumentFilterFunction | null;
  private readonly pageSize: number;
  
  private view: VirtualView | null = null;
  private cursor: ProcessChangesCursor | null = null;
  
  /** Track documents currently in the view from this provider */
  private knownDocIds: Set<string> = new Set();

  constructor(options: MindooDBVirtualViewDataProviderOptions) {
    this.origin = options.origin;
    this.db = options.db;
    this.filterFunction = options.filterFunction ?? null;
    this.pageSize = options.pageSize ?? 100;
  }

  getOrigin(): string {
    return this.origin;
  }

  init(view: VirtualView): void {
    this.view = view;
  }

  async update(): Promise<void> {
    if (!this.view) {
      throw new Error("Data provider not initialized - call init() first");
    }

    const change = new VirtualViewDataChange(this.origin);
    const columns = this.view.getColumns();

    // Process documents using iterateChangesSince for incremental updates
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor)) {
      const docId = doc.getId();
      const isDeleted = doc.isDeleted();
      
      // Check if document passes filter
      const passesFilter = !isDeleted && (!this.filterFunction || this.filterFunction(doc));
      
      if (passesFilter) {
        // Document should be in the view
        // Compute column values
        const columnValues = this.computeColumnValues(doc, columns);
        change.addEntry(docId, columnValues);
        this.knownDocIds.add(docId);
      } else if (this.knownDocIds.has(docId)) {
        // Document was in the view but no longer matches (deleted or filter changed)
        change.removeEntry(docId);
        this.knownDocIds.delete(docId);
      }
      
      // Update cursor to track progress
      this.cursor = cursor;
    }

    // Apply changes to the view if there are any
    if (change.hasChanges()) {
      this.view.applyChanges(change);
    }
  }

  /**
   * Compute column values for a document using column value functions
   */
  private computeColumnValues(
    doc: MindooDoc,
    columns: VirtualViewColumn[]
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const docData = doc.getData();

    // First, copy all fields from the document
    for (const [key, value] of Object.entries(docData)) {
      // Skip internal fields
      if (!key.startsWith("_")) {
        values[key] = value;
      }
    }

    // Then, apply column value functions (which may override or add values)
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
}
