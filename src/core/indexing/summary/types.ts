import type { ProcessChangesCursor } from "../../types";

/**
 * Fixed ID of the per-database setup document. It syncs like any other
 * document, giving users/apps (e.g. the Haven UI) one shared place to
 * configure database-level settings across all replicas. Custom-ID
 * documents share seeded Automerge ancestry, so independently created
 * `dbsetup` documents merge cleanly.
 */
export const DB_SETUP_DOC_ID = "dbsetup";

/**
 * Field of the {@link DB_SETUP_DOC_ID} document holding the
 * {@link SummaryConfig} used by summary stores that were not given an
 * explicit configuration in code.
 */
export const SUMMARY_SETUP_FIELD = "summarySetup";

/**
 * Configuration describing which document fields are copied into the
 * summary buffer (see docs/adhoc-queries.md).
 *
 * The summary is a derived, local index — unlike Notes summary items the
 * configuration is NOT part of the documents. Changing it never rewrites
 * documents; it only triggers a resumable backfill run over the changefeed.
 */
export interface SummaryConfig {
  /**
   * When `true` (default), every non-underscore top-level field whose value
   * is a scalar (string/number/boolean/null) or an array of scalars is
   * included automatically, as long as its serialized size does not exceed
   * {@link maxValueBytes}.
   */
  autoInclude?: boolean;

  /**
   * Size cap (approximate, JSON-serialized length) for auto-included
   * values. Values above the cap are skipped — queries on such fields see
   * them as absent. Explicitly `include`d paths are NOT subject to the cap.
   * Default: 1024.
   */
  maxValueBytes?: number;

  /**
   * Dot-separated paths to include explicitly. Unlike auto-include these
   * may be nested (`"meta.author"`), may resolve to non-scalar values, and
   * bypass the size cap. The value is stored under the full path as key.
   */
  include?: string[];

  /**
   * Dot-separated paths to exclude. Wins over auto-include and `include`;
   * an exclude also covers all nested paths below it.
   */
  exclude?: string[];
}

/** {@link SummaryConfig} with all defaults applied. */
export interface ResolvedSummaryConfig {
  autoInclude: boolean;
  maxValueBytes: number;
  include: string[];
  exclude: string[];
}

export const DEFAULT_SUMMARY_MAX_VALUE_BYTES = 1024;

export function resolveSummaryConfig(config?: SummaryConfig): ResolvedSummaryConfig {
  return {
    autoInclude: config?.autoInclude ?? true,
    maxValueBytes: Math.max(0, config?.maxValueBytes ?? DEFAULT_SUMMARY_MAX_VALUE_BYTES),
    include: [...(config?.include ?? [])],
    exclude: [...(config?.exclude ?? [])],
  };
}

/**
 * Extract a {@link SummaryConfig} from an untyped value (the
 * `summarySetup` field of the synced setup document). Unknown properties
 * are dropped and wrongly-typed ones ignored, so a malformed document can
 * never break summary maintenance. Returns `undefined` when the value is
 * not an object (missing field, deleted document) — callers fall back to
 * the default configuration.
 */
export function sanitizeSummaryConfig(value: unknown): SummaryConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const config: SummaryConfig = {};
  if (typeof raw.autoInclude === "boolean") {
    config.autoInclude = raw.autoInclude;
  }
  if (typeof raw.maxValueBytes === "number" && Number.isFinite(raw.maxValueBytes)) {
    config.maxValueBytes = raw.maxValueBytes;
  }
  const stringList = (input: unknown): string[] | undefined =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string")
      : undefined;
  const include = stringList(raw.include);
  if (include) {
    config.include = include;
  }
  const exclude = stringList(raw.exclude);
  if (exclude) {
    config.exclude = exclude;
  }
  return config;
}

/**
 * Deterministic fingerprint of a summary configuration. Persisted alongside
 * the summary cache; a mismatch on restore (or a config change at runtime)
 * marks the summary as `"rebuilding"` and triggers a backfill.
 */
export function computeSummaryConfigFingerprint(config: ResolvedSummaryConfig): string {
  return JSON.stringify({
    autoInclude: config.autoInclude,
    maxValueBytes: config.maxValueBytes,
    include: [...config.include].sort(),
    exclude: [...config.exclude].sort(),
  });
}

/** One document's entry in the summary buffer. */
export interface DocumentSummaryEntry {
  docId: string;
  /**
   * Flat map of extracted values. Auto-included top-level fields are keyed
   * by field name; explicitly included paths are keyed by their full
   * dot-path. Use `getSummaryFieldValue()` for path-aware lookups.
   */
  fields: Record<string, unknown>;
  lastModified: number;
  /** Changefeed sequence of the change this entry was extracted from. */
  changeSeq: number;
  decryptionKeyId: string | null;
}

/**
 * Coverage state reported by query results: `"full"` when the summary
 * reflects the current configuration for all documents, `"rebuilding"`
 * while a config-change backfill is still in progress (entries extracted
 * with the previous configuration may still be served).
 */
export type SummaryCoverage = "full" | "rebuilding";

/** Serialized shape of one persisted summary bucket. */
export interface SummaryBucketPayload {
  entries: DocumentSummaryEntry[];
}

/** Serialized shape of the persisted summary metadata record. */
export interface SummaryMetaPayload {
  cursor: ProcessChangesCursor | null;
  configFingerprint: string;
  bucketCount: number;
  needsBackfill: boolean;
  backfillCursor: ProcessChangesCursor | null;
}
