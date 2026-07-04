import type { ResolvedSummaryConfig } from "./types";

/**
 * Resolve a dot-separated path against a plain JS object. Only object
 * traversal is supported (no array indices) — mirroring the field-path
 * semantics of the expression language's `getFieldValue`.
 */
export function resolveFieldPath(data: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) {
    return data[path];
  }
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Scalars and flat arrays of scalars qualify for auto-include. */
function isAutoIncludableValue(value: unknown): boolean {
  if (isScalar(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isScalar(item));
  }
  return false;
}

/**
 * Approximate serialized size of a value (JSON string length). Good enough
 * as a guard against pathologically large summary values; not an exact
 * byte count for multi-byte characters.
 */
export function estimateValueSize(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return value.length + 2;
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : json.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isExcluded(path: string, exclude: string[]): boolean {
  for (const excluded of exclude) {
    if (path === excluded || path.startsWith(excluded + ".")) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the summary field map for one document payload according to the
 * resolved configuration:
 *
 * 1. auto-include (when enabled): every non-underscore top-level field with
 *    a scalar (or scalar-array) value whose serialized size stays within
 *    `maxValueBytes`
 * 2. explicit `include` paths: any value type, no size cap, keyed by the
 *    full dot-path
 * 3. `exclude` wins over both (and covers nested paths)
 */
export function extractSummaryFields(
  data: Record<string, unknown>,
  config: ResolvedSummaryConfig
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  if (config.autoInclude) {
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_")) {
        continue;
      }
      if (isExcluded(key, config.exclude)) {
        continue;
      }
      if (!isAutoIncludableValue(value)) {
        continue;
      }
      if (estimateValueSize(value) > config.maxValueBytes) {
        continue;
      }
      fields[key] = value;
    }
  }

  for (const path of config.include) {
    if (isExcluded(path, config.exclude)) {
      continue;
    }
    const value = resolveFieldPath(data, path);
    if (value !== undefined) {
      fields[path] = value;
    }
  }

  return fields;
}

/**
 * Path-aware lookup on an extracted summary field map: explicit include
 * entries are stored under their full dot-path, auto-included fields under
 * the top-level name (so nested lookups traverse the stored value).
 */
export function getSummaryFieldValue(
  fields: Record<string, unknown>,
  path: string
): unknown {
  if (Object.prototype.hasOwnProperty.call(fields, path)) {
    return fields[path];
  }
  return resolveFieldPath(fields, path);
}

/**
 * Builds the document object expressions are evaluated against from a
 * stored summary field map. Explicit include entries are stored flat under
 * their full dot-path (`"meta.owner"`); expression evaluation resolves
 * `field` paths by object traversal, so dot-keys are expanded into nested
 * objects here. Maps without dot-keys are returned as-is (no copy).
 */
export function buildSummaryEvaluationDoc(fields: Record<string, unknown>): Record<string, unknown> {
  let hasDotKey = false;
  for (const key of Object.keys(fields)) {
    if (key.includes(".")) {
      hasDotKey = true;
      break;
    }
  }
  if (!hasDotKey) {
    return fields;
  }

  const doc: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!key.includes(".")) {
      doc[key] = value;
      continue;
    }
    const parts = key.split(".");
    let current = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = current[parts[i]];
      if (next !== null && typeof next === "object" && !Array.isArray(next)) {
        current = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        current[parts[i]] = created;
        current = created;
      }
    }
    current[parts[parts.length - 1]] = value;
  }
  return doc;
}

/**
 * Whether a field path is covered by the summary configuration, i.e.
 * queries against it can be answered from the summary buffer.
 *
 * Top-level fields (and nested paths below them) are covered by
 * auto-include; nested paths are additionally covered when explicitly
 * included. Excluded paths are never covered. Note that coverage is a
 * configuration-level statement — an individual document may still lack a
 * value (missing field, non-scalar value, or above the size cap).
 */
export function isFieldPathCovered(path: string, config: ResolvedSummaryConfig): boolean {
  if (isExcluded(path, config.exclude)) {
    return false;
  }
  for (const included of config.include) {
    if (path === included || path.startsWith(included + ".")) {
      return true;
    }
  }
  if (config.autoInclude) {
    const topLevel = path.includes(".") ? path.slice(0, path.indexOf(".")) : path;
    if (!topLevel.startsWith("_")) {
      return true;
    }
  }
  return false;
}
