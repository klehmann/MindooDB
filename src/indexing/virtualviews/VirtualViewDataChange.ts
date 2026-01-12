import type { EntryData } from "./types";

/**
 * Encapsulates changes in a VirtualView data set from one data provider.
 * Used to batch additions and removals for efficient processing.
 */
export class VirtualViewDataChange {
  /** Origin identifier (which data provider) */
  readonly origin: string;
  
  /** Document IDs to remove from the view */
  private _removals: Set<string> = new Set();
  
  /** Document IDs and their computed values to add to the view */
  private _additions: Map<string, EntryData> = new Map();

  constructor(origin: string) {
    this.origin = origin;
  }

  /**
   * Mark a document for removal from the view
   * 
   * @param docId Document ID to remove
   */
  removeEntry(docId: string): void {
    this._removals.add(docId);
  }

  /**
   * Add a document to the view with computed column values
   * 
   * @param docId Document ID
   * @param values Computed column values
   */
  addEntry(docId: string, values: Record<string, unknown>): void {
    this._additions.set(docId, { docId, values });
  }

  /**
   * Get all document IDs marked for removal
   */
  getRemovals(): Set<string> {
    return this._removals;
  }

  /**
   * Get all additions (document ID -> entry data)
   */
  getAdditions(): Map<string, EntryData> {
    return this._additions;
  }

  /**
   * Check if there are any changes to apply
   */
  hasChanges(): boolean {
    return this._removals.size > 0 || this._additions.size > 0;
  }

  /**
   * Get total number of changes (removals + additions)
   */
  getChangeCount(): number {
    return this._removals.size + this._additions.size;
  }

  /**
   * Clear all changes
   */
  clear(): void {
    this._removals.clear();
    this._additions.clear();
  }

  toString(): string {
    return `VirtualViewDataChange [origin=${this.origin}, removals=${this._removals.size}, additions=${this._additions.size}]`;
  }
}
