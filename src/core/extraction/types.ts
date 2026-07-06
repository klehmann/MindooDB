/**
 * Attachment text extraction setup (docs/fulltext-search.md).
 *
 * Configures host-side extraction services (e.g. Haven's OCR service):
 * which databases want expensive attachment-content extraction (OCR for
 * images and scanned PDFs) whose results are persisted at the attachment
 * entry via `MindooDoc.setAttachmentExtractedText()` and synced with the
 * document. This is deliberately separate from `fulltextSetup.attachments`
 * (cheap, index-local extractors that run on every device): extraction
 * services run once per attachment, write the result into the document,
 * and every replica gets the text for free.
 *
 * Stored in the synced setup document (`dbsetup`, field
 * `extractionSetup`) — same pattern as `summarySetup`/`fulltextSetup`.
 */
export interface ExtractionConfig {
  /** Master switch. Default: false (no extraction service activity). */
  enabled?: boolean;

  /**
   * Tesseract-style language codes for OCR (e.g. ["deu", "eng"]).
   * Services use this to load the matching trained data. Default is
   * service-defined.
   */
  languages?: string[];

  /**
   * Restrict extraction to these MIME types (prefix match allowed, e.g.
   * "image/"). Default: service-defined (typically images + PDFs).
   */
  mimeTypes?: string[];

  /**
   * Cap on persisted text per attachment in characters. Values above the
   * hard limit (ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS) are clamped by the
   * write path.
   */
  maxCharsPerAttachment?: number;
}

/**
 * Field of the `dbsetup` document holding the {@link ExtractionConfig}.
 */
export const EXTRACTION_SETUP_FIELD = "extractionSetup";

/**
 * Validate and strip an untrusted `extractionSetup` value from the setup
 * document down to the known, well-typed fields. Returns `undefined` when
 * the value is not an object — callers fall back to "not configured".
 */
export function sanitizeExtractionConfig(value: unknown): ExtractionConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const config: ExtractionConfig = {};
  if (typeof raw.enabled === "boolean") {
    config.enabled = raw.enabled;
  }
  if (Array.isArray(raw.languages)) {
    const languages = raw.languages.filter(
      (item): item is string => typeof item === "string" && item.length > 0 && item.length <= 35
    );
    if (languages.length > 0) {
      config.languages = languages;
    }
  }
  if (Array.isArray(raw.mimeTypes)) {
    const mimeTypes = raw.mimeTypes.filter(
      (item): item is string => typeof item === "string" && item.length > 0 && item.length <= 255
    );
    if (mimeTypes.length > 0) {
      config.mimeTypes = mimeTypes;
    }
  }
  if (
    typeof raw.maxCharsPerAttachment === "number" &&
    Number.isFinite(raw.maxCharsPerAttachment) &&
    raw.maxCharsPerAttachment > 0
  ) {
    config.maxCharsPerAttachment = Math.floor(raw.maxCharsPerAttachment);
  }
  return config;
}
