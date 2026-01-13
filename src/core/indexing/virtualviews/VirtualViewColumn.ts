import { ColumnSorting, TotalMode, ColumnValueFunction } from "./types";

/**
 * Options for creating a VirtualViewColumn
 */
export interface VirtualViewColumnOptions {
  /** Programmatic name / item name for the column */
  name: string;
  
  /** Display title for the column */
  title?: string;
  
  /** Whether this column creates categories */
  isCategory?: boolean;
  
  /** Whether this column is hidden from display */
  isHidden?: boolean;
  
  /** Sort direction for this column */
  sorting?: ColumnSorting;
  
  /** Aggregation mode for category totals */
  totalMode?: TotalMode;
  
  /** Function to compute column value from document data */
  valueFunction?: ColumnValueFunction;
}

/**
 * Defines a column in a VirtualView.
 * Columns can be used for categorization, sorting, display, and totals.
 */
export class VirtualViewColumn {
  /** Programmatic name / item name for the column */
  readonly name: string;
  
  /** Display title for the column */
  readonly title: string;
  
  /** Whether this column creates categories */
  readonly isCategory: boolean;
  
  /** Whether this column is hidden from display */
  readonly isHidden: boolean;
  
  /** Sort direction for this column */
  readonly sorting: ColumnSorting;
  
  /** Aggregation mode for category totals */
  readonly totalMode: TotalMode;
  
  /** Function to compute column value from document data */
  readonly valueFunction: ColumnValueFunction | undefined;

  constructor(options: VirtualViewColumnOptions) {
    this.name = options.name;
    this.title = options.title ?? options.name;
    this.isCategory = options.isCategory ?? false;
    this.isHidden = options.isHidden ?? false;
    this.sorting = options.sorting ?? ColumnSorting.NONE;
    this.totalMode = options.totalMode ?? TotalMode.NONE;
    this.valueFunction = options.valueFunction;

    // Validation: Category columns must be sorted
    if (this.isCategory && this.sorting === ColumnSorting.NONE) {
      throw new Error(`Category column '${this.name}' must have a sorting direction`);
    }
  }

  /**
   * Create a category column
   */
  static category(
    name: string,
    options?: Partial<Omit<VirtualViewColumnOptions, "name" | "isCategory">>
  ): VirtualViewColumn {
    return new VirtualViewColumn({
      name,
      isCategory: true,
      sorting: ColumnSorting.ASCENDING, // Default for categories
      ...options,
    });
  }

  /**
   * Create a sorted column (non-category)
   */
  static sorted(
    name: string,
    sorting: ColumnSorting = ColumnSorting.ASCENDING,
    options?: Partial<Omit<VirtualViewColumnOptions, "name" | "sorting">>
  ): VirtualViewColumn {
    return new VirtualViewColumn({
      name,
      sorting,
      ...options,
    });
  }

  /**
   * Create a display-only column (not sorted, not category)
   */
  static display(
    name: string,
    options?: Partial<Omit<VirtualViewColumnOptions, "name">>
  ): VirtualViewColumn {
    return new VirtualViewColumn({
      name,
      sorting: ColumnSorting.NONE,
      ...options,
    });
  }

  /**
   * Create a total column for category aggregation
   */
  static total(
    name: string,
    totalMode: TotalMode,
    options?: Partial<Omit<VirtualViewColumnOptions, "name" | "totalMode">>
  ): VirtualViewColumn {
    return new VirtualViewColumn({
      name,
      totalMode,
      sorting: ColumnSorting.NONE,
      ...options,
    });
  }

  toString(): string {
    return `VirtualViewColumn [name=${this.name}, title=${this.title}, isCategory=${this.isCategory}, sorting=${this.sorting}, totalMode=${this.totalMode}]`;
  }
}
