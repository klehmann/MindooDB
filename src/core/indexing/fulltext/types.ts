import type { ProcessChangesCursor } from "../../types";

/**
 * Field of the `dbsetup` document holding the {@link FulltextConfig} used
 * by full-text indexes that were not given an explicit configuration in
 * code. Lives next to `summarySetup` in the same synced setup document
 * (see docs/adhoc-queries.md and docs/fulltext-search.md).
 */
export const FULLTEXT_SETUP_FIELD = "fulltextSetup";

/**
 * Version of the persisted index format (serialization layout AND the
 * engine/tokenizer behavior). Part of the config fingerprint, so bumping
 * it invalidates persisted indexes and triggers a clean rebuild.
 */
export const FULLTEXT_INDEX_FORMAT_VERSION = 3;

/**
 * Default per-field cap (approximate bytes, JS string length) for text
 * extracted into the full-text index. Longer values are truncated — not
 * skipped — so a huge e-mail body still contributes its first part.
 */
export const DEFAULT_FULLTEXT_MAX_FIELD_BYTES = 256 * 1024;

/**
 * Synthetic index field holding text extracted from a document's
 * attachments (via registered {@link AttachmentTextExtractor}s). Hits
 * stay document-scoped (the Notes model): searching matches the document,
 * not an individual attachment.
 */
export const FULLTEXT_ATTACHMENT_FIELD = "_attachments";

/**
 * Configuration of the client-side full-text index (see
 * docs/fulltext-search.md).
 *
 * Like the summary configuration this is a derived, local index setting:
 * changing it never rewrites documents, it only triggers a resumable
 * backfill over the changefeed.
 */
export interface FulltextConfig {
  /**
   * Master switch. The full-text index is OPT-IN (default `false`):
   * unlike the summary buffer it costs indexing time and RAM only apps
   * that actually search should pay for.
   */
  enabled?: boolean;

  /**
   * Dot-separated document field paths to index. When empty or omitted
   * (auto mode), every non-underscore top-level field whose extracted
   * plain text is non-empty is indexed. Explicit paths may be nested and
   * may point at long-text / rich-text fields that are deliberately kept
   * out of the summary buffer.
   */
  include?: string[];

  /**
   * When `true`, text is extracted from document attachments through the
   * registered {@link AttachmentTextExtractor}s and indexed under the
   * synthetic {@link FULLTEXT_ATTACHMENT_FIELD} field. Without registered
   * extractors this setting has no effect. Default: `false`.
   */
  attachments?: boolean;

  /**
   * BCP-47 language tag steering the tokenizer (`Intl.Segmenter` locale
   * where available). Part of the config fingerprint: changing the
   * language rebuilds the index. Default: `"und"` (undetermined —
   * language-neutral Unicode segmentation).
   */
  language?: string;

  /**
   * Per-field cap (approximate bytes) for extracted text. Values above
   * the cap are truncated, not skipped.
   * Default: {@link DEFAULT_FULLTEXT_MAX_FIELD_BYTES}.
   */
  maxFieldBytes?: number;
}

/** {@link FulltextConfig} with all defaults applied. */
export interface ResolvedFulltextConfig {
  enabled: boolean;
  include: string[];
  attachments: boolean;
  language: string;
  maxFieldBytes: number;
}

export function resolveFulltextConfig(config?: FulltextConfig): ResolvedFulltextConfig {
  return {
    enabled: config?.enabled ?? false,
    include: [...(config?.include ?? [])],
    attachments: config?.attachments ?? false,
    language: config?.language ?? "und",
    maxFieldBytes: Math.max(0, config?.maxFieldBytes ?? DEFAULT_FULLTEXT_MAX_FIELD_BYTES),
  };
}

/**
 * Extract a {@link FulltextConfig} from an untyped value (the
 * `fulltextSetup` field of the synced setup document). Unknown properties
 * are dropped and wrongly-typed ones ignored, so a malformed document can
 * never break index maintenance. Returns `undefined` when the value is
 * not an object (missing field, deleted document) — callers fall back to
 * the default (disabled) configuration.
 */
export function sanitizeFulltextConfig(value: unknown): FulltextConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const config: FulltextConfig = {};
  if (typeof raw.enabled === "boolean") {
    config.enabled = raw.enabled;
  }
  if (Array.isArray(raw.include)) {
    config.include = raw.include.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw.attachments === "boolean") {
    config.attachments = raw.attachments;
  }
  if (typeof raw.language === "string" && raw.language.length > 0 && raw.language.length <= 35) {
    config.language = raw.language;
  }
  if (typeof raw.maxFieldBytes === "number" && Number.isFinite(raw.maxFieldBytes)) {
    config.maxFieldBytes = raw.maxFieldBytes;
  }
  return config;
}

/**
 * Deterministic fingerprint of a full-text configuration, including the
 * index format/engine version. Persisted alongside the index; a mismatch
 * on restore (or a config change at runtime) marks the index as
 * `"rebuilding"` and triggers a resumable backfill.
 */
export function computeFulltextConfigFingerprint(config: ResolvedFulltextConfig): string {
  return JSON.stringify({
    formatVersion: FULLTEXT_INDEX_FORMAT_VERSION,
    enabled: config.enabled,
    include: [...config.include].sort(),
    attachments: config.attachments,
    language: config.language,
    maxFieldBytes: config.maxFieldBytes,
  });
}

/**
 * Coverage state reported by search results: `"full"` when the index
 * reflects the current configuration for all documents, `"rebuilding"`
 * while a config-change backfill is still in progress.
 */
export type FulltextCoverage = "full" | "rebuilding";

/** One hit of a full-text search: document id plus relevance score. */
export interface FulltextSearchHit {
  docId: string;
  /** Relevance score (BM25-like, engine-specific scale; higher = better). */
  score: number;
}

/** Options for {@link DocumentFullTextIndex.search} / `db.searchText()`. */
export interface FulltextSearchOptions {
  /**
   * Restrict matching to these index fields (document field paths, plus
   * the synthetic {@link FULLTEXT_ATTACHMENT_FIELD}). Default: all fields.
   */
  fields?: string[];
  /** Match term prefixes (`"drag"` matches `"dragon"`). Default: `true`. */
  prefix?: boolean;
  /**
   * Fuzzy matching tolerance: `true` (edit distance scaled by term
   * length), a number (0..1 fraction of term length, or an absolute edit
   * distance > 1), or `false` to disable. Default: `false`.
   */
  fuzzy?: boolean | number;
  /**
   * How multiple query terms combine: `"AND"` (all terms must match,
   * default) or `"OR"` (any term matches).
   */
  combineWith?: "AND" | "OR";
  /** Cap the number of returned hits (applied after scoring/sorting). */
  limit?: number;
}

/** Result of {@link DocumentFullTextIndex.search} / `db.searchText()`. */
export interface FulltextSearchResult {
  /** Matching documents, best score first. */
  hits: FulltextSearchHit[];
  coverage: FulltextCoverage;
}

/** Serialized shape of the persisted full-text metadata record. */
export interface FulltextMetaPayload {
  cursor: ProcessChangesCursor | null;
  configFingerprint: string;
  needsBackfill: boolean;
  backfillCursor: ProcessChangesCursor | null;
}

/**
 * Extracts plain text from a document attachment for full-text indexing.
 *
 * Implementations are registered per database (see
 * `MindooDB.registerAttachmentTextExtractor`); the host environment
 * provides format-specific extractors (e.g. Haven registers text/CSV/JSON,
 * PDF and Office extractors from its preview parsers). Without registered
 * extractors — or with `fulltextSetup.attachments` unset — attachment
 * content is not indexed.
 */
export interface AttachmentTextExtractor {
  /** Quick capability check before any bytes are loaded. */
  supports(mimeType: string, fileName: string): boolean;
  /**
   * Extract plain text from the attachment bytes. Return `null` when the
   * content turns out to be unsupported. Thrown errors are caught and
   * logged by the index; the attachment is then skipped.
   */
  extract(
    bytes: Uint8Array,
    info: { mimeType: string; fileName: string }
  ): Promise<string | null>;
}
