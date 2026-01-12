/**
 * Shared types and enums for the VirtualView system
 */

import type { MindooDoc } from "../../types";

/**
 * Column sorting direction
 */
export enum ColumnSorting {
  NONE = "none",
  ASCENDING = "ascending",
  DESCENDING = "descending",
}

/**
 * Total/aggregation mode for category columns
 */
export enum TotalMode {
  NONE = "none",
  SUM = "sum",
  AVERAGE = "average",
}

/**
 * Controls whether categories appear before or after documents in the view
 */
export enum CategorizationStyle {
  /** Documents appear before categories (Domino default) */
  DOCUMENT_THEN_CATEGORY = "document_then_category",
  /** Categories appear before documents */
  CATEGORY_THEN_DOCUMENT = "category_then_document",
}

/**
 * Navigator filter options for categories
 */
export enum WithCategories {
  YES = "yes",
  NO = "no",
}

/**
 * Navigator filter options for documents
 */
export enum WithDocuments {
  YES = "yes",
  NO = "no",
}

/**
 * Navigator filter for selected entries only
 */
export enum SelectedOnly {
  YES = "yes",
  NO = "no",
}

/**
 * Special sentinel values for range scans in the sorted map
 */
export const LOW_SORTVAL = Symbol("LOW_SORTVAL");
export const HIGH_SORTVAL = Symbol("HIGH_SORTVAL");
export const LOW_ORIGIN = "~~LOW~";
export const HIGH_ORIGIN = "~~HIGH~";

/**
 * Origin identifier for VirtualView-created entries (categories, root)
 */
export const ORIGIN_VIRTUALVIEW = "virtualview";

/**
 * Scoped document ID - combines origin with document ID for uniqueness across origins
 */
export interface ScopedDocId {
  origin: string;
  docId: string;
}

/**
 * Creates a scoped document ID
 */
export function createScopedDocId(origin: string, docId: string): ScopedDocId {
  return { origin, docId };
}

/**
 * Creates a string key from a scoped document ID for use in Maps/Sets
 */
export function scopedDocIdKey(scopedId: ScopedDocId): string {
  return `${scopedId.origin}:${scopedId.docId}`;
}

/**
 * Parses a scoped document ID key back to its components
 */
export function parseScopedDocIdKey(key: string): ScopedDocId {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid scoped doc ID key: ${key}`);
  }
  return {
    origin: key.substring(0, colonIndex),
    docId: key.substring(colonIndex + 1),
  };
}

/**
 * Column value function type - computes a column value from document data
 * 
 * @param doc The document to compute the value for
 * @param columnValues Previously computed column values (for dependent columns)
 * @param origin The origin identifier of the data provider
 * @returns The computed column value
 */
export type ColumnValueFunction = (
  doc: MindooDoc,
  columnValues: Record<string, unknown>,
  origin: string
) => unknown;

/**
 * Filter function type - determines if a document should be included in the view
 * 
 * @param doc The document to check
 * @returns true if the document should be included, false otherwise
 */
export type DocumentFilterFunction = (doc: MindooDoc) => boolean;

/**
 * Entry data for additions in a VirtualViewDataChange
 */
export interface EntryData {
  /** Document UNID */
  docId: string;
  /** Computed column values */
  values: Record<string, unknown>;
}

/**
 * Data type sort order for mixed-type column comparisons
 * Numbers < Dates < Strings < null
 */
export function getDataTypeSortOrder(val: unknown): number {
  if (val === null || val === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (typeof val === "number") {
    return 1; // Numbers first
  }
  if (val instanceof Date || (typeof val === "number" && !isNaN(val))) {
    return 2; // Dates second
  }
  if (typeof val === "string") {
    return 3; // Strings third
  }
  // Other types - compare as strings
  return 4;
}

/**
 * Compare two values for sorting, handling different types
 */
export function compareValues(a: unknown, b: unknown, descending: boolean): number {
  // Handle special sentinel values
  if (a === LOW_SORTVAL) {
    return b === LOW_SORTVAL ? 0 : -1;
  }
  if (b === LOW_SORTVAL) {
    return 1;
  }
  if (a === HIGH_SORTVAL) {
    return b === HIGH_SORTVAL ? 0 : 1;
  }
  if (b === HIGH_SORTVAL) {
    return -1;
  }

  // Treat empty strings as null
  if (a === "") a = null;
  if (b === "") b = null;

  // Handle nulls - nulls sort to the end
  if (a === null || a === undefined) {
    if (b === null || b === undefined) {
      return 0;
    }
    return descending ? -1 : 1;
  }
  if (b === null || b === undefined) {
    return descending ? 1 : -1;
  }

  // Compare by data type first
  const typeOrder1 = getDataTypeSortOrder(a);
  const typeOrder2 = getDataTypeSortOrder(b);
  if (typeOrder1 !== typeOrder2) {
    return (descending ? -1 : 1) * (typeOrder1 - typeOrder2);
  }

  // Same type comparison
  let result = 0;
  if (typeof a === "string" && typeof b === "string") {
    result = a.localeCompare(b, undefined, { sensitivity: "base" });
  } else if (typeof a === "number" && typeof b === "number") {
    result = a - b;
  } else if (a instanceof Date && b instanceof Date) {
    result = a.getTime() - b.getTime();
  } else {
    // Fallback: convert to string and compare
    result = String(a).localeCompare(String(b));
  }

  return descending ? -result : result;
}
