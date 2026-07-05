export { DocumentFullTextIndex } from "./DocumentFullTextIndex";
export {
  MiniSearchAdapter,
  createTokenizer,
  type SearchEngineAdapter,
} from "./SearchEngineAdapter";
export {
  resolveFulltextConfig,
  sanitizeFulltextConfig,
  computeFulltextConfigFingerprint,
  FULLTEXT_SETUP_FIELD,
  FULLTEXT_ATTACHMENT_FIELD,
  FULLTEXT_INDEX_FORMAT_VERSION,
  DEFAULT_FULLTEXT_MAX_FIELD_BYTES,
  type FulltextConfig,
  type ResolvedFulltextConfig,
  type FulltextCoverage,
  type FulltextSearchHit,
  type FulltextSearchOptions,
  type FulltextSearchResult,
  type AttachmentTextExtractor,
} from "./types";
export { collectPlainText, extractFulltextFields } from "./extractFulltextText";
