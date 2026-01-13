import { ViewEntrySortKey } from "./ViewEntrySortKey";
import {
  CategorizationStyle,
  LOW_SORTVAL,
  HIGH_SORTVAL,
  LOW_ORIGIN,
  HIGH_ORIGIN,
  compareValues,
} from "./types";

/**
 * Comparator to sort ViewEntrySortKey objects within one level of the VirtualView tree structure.
 * Handles categorization style (categories before/after documents), sort direction per column,
 * and type-aware value comparison.
 */
export class ViewEntrySortKeyComparator {
  /** Whether categories should appear before documents */
  private readonly categoriesOnTopOfDocuments: boolean;
  
  /** Whether categories should be sorted in descending order */
  private readonly categoryOrderDescending: boolean;
  
  /** Per-column descending flags for document sorting */
  private readonly docOrderPerColumnDescending: readonly boolean[];

  constructor(
    categorizationStyle: CategorizationStyle,
    categoryOrderDescending: boolean,
    docOrderPerColumnDescending: boolean[]
  ) {
    this.categoriesOnTopOfDocuments =
      categorizationStyle === CategorizationStyle.CATEGORY_THEN_DOCUMENT;
    this.categoryOrderDescending = categoryOrderDescending;
    this.docOrderPerColumnDescending = Object.freeze([...docOrderPerColumnDescending]);
  }

  /**
   * Compare two sort keys for ordering
   * 
   * @param o1 First sort key
   * @param o2 Second sort key
   * @returns Negative if o1 < o2, positive if o1 > o2, 0 if equal
   */
  compare(o1: ViewEntrySortKey, o2: ViewEntrySortKey): number {
    const values1 = o1.values;
    const values2 = o2.values;

    const isCategory1 = o1.isCategory;
    const isCategory2 = o2.isCategory;

    // Handle category vs document ordering
    if (isCategory1 && !isCategory2) {
      return this.categoriesOnTopOfDocuments ? -1 : 1;
    }
    if (!isCategory1 && isCategory2) {
      return this.categoriesOnTopOfDocuments ? 1 : -1;
    }

    // Both are categories
    if (isCategory1 && isCategory2) {
      return this.compareCategories(o1, o2, values1, values2);
    }

    // Both are documents
    return this.compareDocuments(o1, o2, values1, values2);
  }

  private compareCategories(
    o1: ViewEntrySortKey,
    o2: ViewEntrySortKey,
    values1: readonly unknown[],
    values2: readonly unknown[]
  ): number {
    const catVal1 = values1.length > 0 ? values1[0] : null;
    const catVal2 = values2.length > 0 ? values2[0] : null;

    // Handle special sentinel values
    if (catVal1 === LOW_SORTVAL) {
      return catVal2 === LOW_SORTVAL ? 0 : -1;
    }
    if (catVal2 === LOW_SORTVAL) {
      return 1;
    }
    if (catVal1 === HIGH_SORTVAL) {
      return catVal2 === HIGH_SORTVAL ? 0 : 1;
    }
    if (catVal2 === HIGH_SORTVAL) {
      return -1;
    }

    // Sort null category values to the bottom ("(Not categorized)")
    if (catVal1 === null || catVal1 === undefined) {
      if (catVal2 === null || catVal2 === undefined) {
        return this.compareOriginAndDocId(o1, o2);
      }
      return this.categoryOrderDescending ? -1 : 1;
    }
    if (catVal2 === null || catVal2 === undefined) {
      return this.categoryOrderDescending ? 1 : -1;
    }

    // Compare category values
    const result = compareValues(catVal1, catVal2, this.categoryOrderDescending);
    if (result !== 0) {
      return result;
    }

    // Category values are equal, sort by origin and doc id
    return this.compareOriginAndDocId(o1, o2);
  }

  private compareDocuments(
    o1: ViewEntrySortKey,
    o2: ViewEntrySortKey,
    values1: readonly unknown[],
    values2: readonly unknown[]
  ): number {
    const nrOfValues = Math.max(values1.length, values2.length);

    for (let i = 0; i < nrOfValues; i++) {
      let currValue1 = i < values1.length ? values1[i] : null;
      let currValue2 = i < values2.length ? values2[i] : null;

      // Handle special sentinel values
      if (currValue1 === LOW_SORTVAL) {
        return currValue2 === LOW_SORTVAL ? 0 : -1;
      }
      if (currValue2 === LOW_SORTVAL) {
        return 1;
      }
      if (currValue1 === HIGH_SORTVAL) {
        return currValue2 === HIGH_SORTVAL ? 0 : 1;
      }
      if (currValue2 === HIGH_SORTVAL) {
        return -1;
      }

      // Determine descending flag for this column
      const descending = i < this.docOrderPerColumnDescending.length
        ? this.docOrderPerColumnDescending[i]
        : false;

      const result = compareValues(currValue1, currValue2, descending);
      if (result !== 0) {
        return result;
      }
    }

    // All column sort values equal, now sort by origin and doc id
    return this.compareOriginAndDocId(o1, o2);
  }

  private compareOriginAndDocId(o1: ViewEntrySortKey, o2: ViewEntrySortKey): number {
    const origin1 = o1.origin;
    const origin2 = o2.origin;

    // Handle special origin values
    if (origin1 === LOW_ORIGIN) {
      return origin2 === LOW_ORIGIN ? 0 : -1;
    }
    if (origin2 === LOW_ORIGIN) {
      return 1;
    }
    if (origin1 === HIGH_ORIGIN) {
      return origin2 === HIGH_ORIGIN ? 0 : 1;
    }
    if (origin2 === HIGH_ORIGIN) {
      return -1;
    }

    // Compare origins
    const originResult = origin1.localeCompare(origin2);
    if (originResult !== 0) {
      return originResult;
    }

    // Compare doc ids
    return o1.docId.localeCompare(o2.docId);
  }
}
