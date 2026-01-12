/**
 * This sort key is used to sort VirtualViewEntryData objects within one level of the
 * VirtualView tree structure. It sorts category elements at the top followed by documents and
 * contains the values of the columns that are used for sorting, followed by the origin and doc id.
 */
export class ViewEntrySortKey {
  /** Whether this key represents a category entry */
  readonly isCategory: boolean;
  
  /** Sort values for the entry */
  readonly values: readonly unknown[];
  
  /** Origin identifier (which data provider) */
  readonly origin: string;
  
  /** Document ID (UNID) */
  readonly docId: string;
  
  /** Whether this is a scan key (for range queries) vs a regular sort key */
  readonly isScanKey: boolean;
  
  /** Cached hash code */
  private _hashCode: number | null = null;

  private constructor(
    isCategory: boolean,
    values: unknown[],
    origin: string,
    docId: string,
    isScanKey: boolean
  ) {
    this.isCategory = isCategory;
    this.values = Object.freeze([...values]);
    this.origin = origin;
    this.docId = docId;
    this.isScanKey = isScanKey;
  }

  /**
   * Creates a scan key for range queries (used with LOW_SORTVAL/HIGH_SORTVAL)
   */
  static createScanKey(
    isCategory: boolean,
    values: unknown[],
    origin: string,
    docId: string
  ): ViewEntrySortKey {
    return new ViewEntrySortKey(isCategory, values, origin, docId, true);
  }

  /**
   * Creates a regular sort key for entries
   */
  static createSortKey(
    isCategory: boolean,
    values: unknown[],
    origin: string,
    docId: string
  ): ViewEntrySortKey {
    return new ViewEntrySortKey(isCategory, values, origin, docId, false);
  }

  /**
   * Generates a unique string key for use in Maps/Sets
   */
  toKey(): string {
    const typePrefix = this.isCategory ? "C" : "D";
    const valuesStr = JSON.stringify(this.values);
    return `${typePrefix}:${valuesStr}:${this.origin}:${this.docId}`;
  }

  /**
   * Returns a hash code for this sort key
   */
  hashCode(): number {
    if (this._hashCode === null) {
      let hash = this.isCategory ? 1 : 0;
      hash = hash * 31 + this.hashString(this.origin);
      hash = hash * 31 + this.hashString(this.docId);
      for (const val of this.values) {
        hash = hash * 31 + this.hashValue(val);
      }
      this._hashCode = hash;
    }
    return this._hashCode;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  private hashValue(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === "number") return val;
    if (typeof val === "string") return this.hashString(val);
    if (val instanceof Date) return val.getTime();
    return this.hashString(String(val));
  }

  /**
   * Checks equality with another sort key
   */
  equals(other: ViewEntrySortKey): boolean {
    if (this === other) return true;
    if (this.isCategory !== other.isCategory) return false;
    if (this.origin !== other.origin) return false;
    if (this.docId !== other.docId) return false;
    if (this.values.length !== other.values.length) return false;
    
    for (let i = 0; i < this.values.length; i++) {
      const v1 = this.values[i];
      const v2 = other.values[i];
      
      if (v1 instanceof Date && v2 instanceof Date) {
        if (v1.getTime() !== v2.getTime()) return false;
      } else if (v1 !== v2) {
        return false;
      }
    }
    
    return true;
  }

  toString(): string {
    const type = this.isCategory ? "category" : "document";
    return `ViewEntrySortKey [type=${type}, values=${JSON.stringify(this.values)}, origin=${this.origin}, docId=${this.docId}]`;
  }
}
