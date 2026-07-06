import { resolveFieldPath } from "../summary/extractSummaryFields";
import type { ResolvedFulltextConfig } from "./types";

/**
 * Automerge materializes rich-text block markers as the Unicode object
 * replacement character; treat it (and other separator/control chars) as
 * whitespace so words on both sides of a block boundary stay separate
 * tokens.
 */
const BLOCK_MARKER_RE = /[\u{FFFC}\u{0000}-\u{0008}\u{000B}\u{000C}\u{000E}-\u{001F}]/gu;

function normalizeText(text: string): string {
  return text.replace(BLOCK_MARKER_RE, " ");
}

/** Keys of rich-text span objects that never carry indexable content. */
const SPAN_METADATA_KEYS = new Set(["type", "marks", "parents", "attr", "attrs"]);

/**
 * Collect indexable plain text from an arbitrary materialized document
 * value:
 *
 * - strings are taken as-is (Automerge text fields materialize as plain
 *   strings; rich-text block markers are normalized to whitespace)
 * - arrays contribute the text of their elements, joined by whitespace
 * - rich-text span objects (`{ type: "text", value }`) and tagged
 *   immutable strings (`{ type: "immutableString", value }`) contribute
 *   their `value`; block spans contribute a boundary space
 * - other objects contribute the text of their own values (metadata keys
 *   of span shapes are skipped), so span arrays stored as plain JSON and
 *   nested structures are searchable without special-casing every shape
 * - numbers/booleans/null are NOT indexed (full-text is for text;
 *   structured values belong in query filters)
 *
 * Depth is capped defensively so cyclic-ish/pathological structures can
 * never stall indexing.
 */
export function collectPlainText(value: unknown, depth: number = 0): string {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (value === null || typeof value !== "object" || depth > 16) {
    return "";
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = collectPlainText(item, depth + 1);
      if (text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join(" ");
  }

  const raw = value as Record<string, unknown>;
  // Rich-text span shapes and tagged immutable strings.
  if (typeof raw.type === "string") {
    if ((raw.type === "text" || raw.type === "immutableString") && typeof raw.value === "string") {
      return normalizeText(raw.value);
    }
    if (raw.type === "block") {
      return "";
    }
  }

  const parts: string[] = [];
  for (const [key, item] of Object.entries(raw)) {
    if (SPAN_METADATA_KEYS.has(key)) {
      continue;
    }
    const text = collectPlainText(item, depth + 1);
    if (text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join(" ");
}

/** Truncation that never leaves a surrogate half at the cut point. */
function truncateText(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return text.slice(0, end);
}

/**
 * Fields following the encrypted-field convention hold ciphertext —
 * useless in a full-text index. Explicit `include` still wins for callers
 * who really want it.
 */
function isEncryptedConventionField(key: string): boolean {
  return key.endsWith("_encrypted") || key.endsWith("_encrypted_key");
}

/**
 * Extract the indexable text map for one document payload according to
 * the resolved configuration:
 *
 * - explicit `include` paths (any nesting, keyed by the full dot-path), or
 * - auto mode (empty `include`): every non-underscore top-level field
 *   whose extracted text is non-empty (encrypted-convention fields are
 *   skipped)
 *
 * Every value is capped at `maxFieldBytes` (truncated, not skipped).
 */
export function extractFulltextFields(
  data: Record<string, unknown>,
  config: ResolvedFulltextConfig
): Record<string, string> {
  const fields: Record<string, string> = {};

  if (config.include.length > 0) {
    for (const path of config.include) {
      const text = collectPlainText(resolveFieldPath(data, path));
      if (text.trim().length > 0) {
        fields[path] = truncateText(text, config.maxFieldBytes);
      }
    }
    return fields;
  }

  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("_") || isEncryptedConventionField(key)) {
      continue;
    }
    const text = collectPlainText(value);
    if (text.trim().length > 0) {
      fields[key] = truncateText(text, config.maxFieldBytes);
    }
  }
  return fields;
}
