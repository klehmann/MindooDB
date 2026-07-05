import MiniSearch from "minisearch";
import type { FulltextSearchHit, FulltextSearchOptions } from "./types";
import { FULLTEXT_INDEX_FORMAT_VERSION } from "./types";

/**
 * Narrow interface between the {@link DocumentFullTextIndex} and the
 * underlying search engine. Everything engine-specific (MiniSearch today;
 * Orama, vector search, ... later) stays behind this seam — including the
 * serialization format, so an engine swap is just a format-version bump
 * that triggers a rebuild.
 */
export interface SearchEngineAdapter {
  /** Add or replace the indexed text fields of a document. */
  add(docId: string, fields: Record<string, string>): void;
  /** Remove a document from the index (no-op when absent). */
  remove(docId: string): void;
  has(docId: string): boolean;
  search(query: string, options?: FulltextSearchOptions): FulltextSearchHit[];
  getDocumentCount(): number;
  /** All field names the index currently knows. */
  getFieldNames(): string[];
  /** Serialize the full engine state (loadable via {@link load}). */
  serialize(): Uint8Array;
  /**
   * Restore state produced by {@link serialize}. Throws when the payload
   * is unreadable or from an incompatible format version — callers treat
   * that as "start empty and rebuild".
   */
  load(bytes: Uint8Array): void;
  /** Drop all indexed documents. */
  clear(): void;
}

/**
 * Build the tokenizer for a language: `Intl.Segmenter` word segmentation
 * where available (correct for CJK and other scripts without word
 * spaces), otherwise a Unicode letters/digits fallback (e.g. React
 * Native/Hermes without `Intl.Segmenter`).
 */
export function createTokenizer(language: string): (text: string) => string[] {
  const SegmenterCtor = (Intl as unknown as { Segmenter?: new (
    locale?: string,
    options?: { granularity: string }
  ) => { segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;

  if (typeof SegmenterCtor === "function") {
    try {
      const segmenter = new SegmenterCtor(language === "und" ? undefined : language, {
        granularity: "word",
      });
      return (text: string) => {
        const tokens: string[] = [];
        for (const part of segmenter.segment(text)) {
          if (part.isWordLike) {
            tokens.push(part.segment);
          }
        }
        return tokens;
      };
    } catch {
      // Unknown locale or Segmenter quirk → fall through to the regex.
    }
  }

  let wordRe: RegExp;
  try {
    wordRe = /[\p{L}\p{N}]+/gu;
  } catch {
    // Engines without Unicode property escapes: cover ASCII plus the
    // common Latin/Cyrillic/CJK ranges.
    wordRe = /[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]+/g;
  }
  return (text: string) => text.match(wordRe) ?? [];
}

/** Serialized shape of {@link MiniSearchAdapter.serialize}. */
interface SerializedEngineState {
  formatVersion: number;
  language: string;
  fields: string[];
  /** Extracted source texts per document — needed for field-set rebuilds. */
  docs: Array<[string, Record<string, string>]>;
  /** `MiniSearch.toJSON()` output, stringified for `MiniSearch.loadJSON`. */
  index: string;
}

/** MiniSearch documents carry the id plus the raw field-text map. */
interface EngineDocument {
  __docId: string;
  fields: Record<string, string>;
}

const ID_FIELD = "__docId";

/**
 * MiniSearch-backed {@link SearchEngineAdapter}.
 *
 * MiniSearch requires the indexed field list at construction time, but
 * mindoodb documents are schemaless (auto mode indexes whatever string
 * fields documents have). The adapter therefore keeps the extracted
 * source texts per document and transparently rebuilds the MiniSearch
 * instance when a previously unseen field name appears — rare in
 * practice, since real databases converge on a stable field set quickly.
 * The kept source texts also make the serialized state self-contained.
 */
export class MiniSearchAdapter implements SearchEngineAdapter {
  private readonly language: string;
  private readonly tokenize: (text: string) => string[];
  private fieldNames: string[];
  private docs: Map<string, Record<string, string>> = new Map();
  private engine: MiniSearch<EngineDocument>;

  constructor(language: string, initialFields: string[] = []) {
    this.language = language;
    this.tokenize = createTokenizer(language);
    this.fieldNames = [...new Set(initialFields)].sort();
    this.engine = this.createEngine(this.fieldNames);
  }

  private engineOptions(fields: string[]) {
    return {
      idField: ID_FIELD,
      fields,
      extractField: (document: EngineDocument, fieldName: string): string => {
        if (fieldName === ID_FIELD) {
          return document.__docId;
        }
        return document.fields[fieldName] ?? "";
      },
      tokenize: (text: string) => this.tokenize(text),
      processTerm: (term: string) => {
        const processed = term.toLowerCase();
        return processed.length > 0 ? processed : null;
      },
    };
  }

  private createEngine(fields: string[]): MiniSearch<EngineDocument> {
    return new MiniSearch<EngineDocument>(this.engineOptions(fields));
  }

  /** Rebuild the MiniSearch instance over a grown field list. */
  private rebuildWithFields(fields: string[]): void {
    this.fieldNames = [...new Set(fields)].sort();
    this.engine = this.createEngine(this.fieldNames);
    for (const [docId, docFields] of this.docs) {
      this.engine.add({ __docId: docId, fields: docFields });
    }
  }

  add(docId: string, fields: Record<string, string>): void {
    const newFields = Object.keys(fields).filter(
      (name) => !this.fieldNames.includes(name)
    );

    // Full removal via the kept source texts, NOT discard(): discarded
    // documents keep their postings as "dirt" until a vacuum and keep
    // counting into document frequencies — with the changefeed re-adding
    // every edited document, that skews BM25 IDF (scores can even go
    // negative). remove() is synchronous and leaves no dirt behind.
    const previous = this.docs.get(docId);
    if (previous) {
      this.engine.remove({ __docId: docId, fields: previous });
    }
    this.docs.set(docId, fields);

    if (newFields.length > 0) {
      this.rebuildWithFields([...this.fieldNames, ...newFields]);
      return;
    }
    this.engine.add({ __docId: docId, fields });
  }

  remove(docId: string): void {
    const previous = this.docs.get(docId);
    if (previous) {
      this.docs.delete(docId);
      this.engine.remove({ __docId: docId, fields: previous });
    }
  }

  has(docId: string): boolean {
    return this.docs.has(docId);
  }

  search(query: string, options?: FulltextSearchOptions): FulltextSearchHit[] {
    if (query.trim().length === 0 || this.docs.size === 0) {
      return [];
    }
    const fields = options?.fields?.filter((field) => this.fieldNames.includes(field));
    if (options?.fields && (!fields || fields.length === 0)) {
      // Every requested field is unknown to the index → nothing can match.
      return [];
    }
    const results = this.engine.search(query, {
      fields,
      prefix: options?.prefix ?? true,
      fuzzy: options?.fuzzy ?? false,
      combineWith: options?.combineWith ?? "AND",
    });
    const hits: FulltextSearchHit[] = [];
    const limit = options?.limit;
    for (const result of results) {
      hits.push({ docId: String(result.id), score: result.score });
      if (limit !== undefined && hits.length >= limit) {
        break;
      }
    }
    return hits;
  }

  getDocumentCount(): number {
    return this.docs.size;
  }

  getFieldNames(): string[] {
    return [...this.fieldNames];
  }

  serialize(): Uint8Array {
    const state: SerializedEngineState = {
      formatVersion: FULLTEXT_INDEX_FORMAT_VERSION,
      language: this.language,
      fields: this.fieldNames,
      docs: Array.from(this.docs.entries()),
      index: JSON.stringify(this.engine.toJSON()),
    };
    return new TextEncoder().encode(JSON.stringify(state));
  }

  load(bytes: Uint8Array): void {
    const state = JSON.parse(new TextDecoder().decode(bytes)) as SerializedEngineState;
    if (state.formatVersion !== FULLTEXT_INDEX_FORMAT_VERSION) {
      throw new Error(
        `Unsupported full-text index format version ${state.formatVersion} (expected ${FULLTEXT_INDEX_FORMAT_VERSION}).`
      );
    }
    if (state.language !== this.language) {
      throw new Error(
        `Persisted full-text index language "${state.language}" does not match configured "${this.language}".`
      );
    }
    this.fieldNames = [...state.fields];
    this.docs = new Map(state.docs);
    this.engine = MiniSearch.loadJSON<EngineDocument>(
      state.index,
      this.engineOptions(this.fieldNames)
    );
  }

  clear(): void {
    this.docs.clear();
    this.engine = this.createEngine(this.fieldNames);
  }
}
