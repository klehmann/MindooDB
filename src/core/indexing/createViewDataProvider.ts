import type { MindooDB } from "../types";
import type { MindooDBAppBooleanExpression } from "../expressions/types";
import { analyzeExpressionRequirements, getReferencedFields } from "../expressions";
import { evaluateExpression, expressionToBoolean } from "../expressions/evaluateExpression";
import type { IVirtualViewDataProvider } from "./virtualviews/IVirtualViewDataProvider";
import { MindooDBVirtualViewDataProvider } from "./virtualviews/MindooDBVirtualViewDataProvider";
import { VirtualViewColumn, type VirtualViewColumnOptions } from "./virtualviews/VirtualViewColumn";
import type { DocumentFilterFunction } from "./virtualviews/types";
import { SummaryVirtualViewDataProvider } from "./summary/SummaryVirtualViewDataProvider";

/**
 * Options for {@link createViewDataProvider} — the summary-first data
 * provider factory.
 */
export interface CreateViewDataProviderOptions {
  /** Unique origin identifier for this data provider. */
  origin: string;

  /** The database feeding this provider. */
  db: MindooDB;

  /**
   * The view's columns. Needed to decide whether the view can be served
   * from the summary buffer (declarative `expression`/field columns) or
   * requires materialized documents (JS `valueFunction` columns).
   */
  columns: Array<VirtualViewColumn | VirtualViewColumnOptions>;

  /**
   * Document filter: a declarative expression (summary-capable) or a JS
   * function receiving the materialized document (forces the full-document
   * path, since summary entries cannot be passed to it).
   */
  filter?: MindooDBAppBooleanExpression | DocumentFilterFunction;

  /**
   * Force this provider to materialize full documents instead of reading
   * the summary buffer — the escape hatch for views that need data the
   * summary cannot deliver (decrypted fields, uncovered fields) or that
   * deliberately want per-document JS evaluation. Expensive by design,
   * mirroring `allowFullScan` on `db.query()`.
   */
  useFullDocuments?: boolean;

  /**
   * Copy every (non-underscore) document field into the view entry.
   * Implies the full-document path (see
   * {@link MindooDBVirtualViewDataProvider}).
   */
  includeAllDocumentFields?: boolean;
}

/** Where a created view data provider reads its data from. */
export type ViewDataProviderSource = "summary" | "documents";

export interface CreateViewDataProviderResult {
  provider: IVirtualViewDataProvider;
  /** The path the factory chose. */
  source: ViewDataProviderSource;
  /**
   * When `source` is `"documents"`, the reasons why the summary path was
   * not usable (empty for an explicit `useFullDocuments` request). Useful
   * for logging/diagnosing why a view runs on the slow path.
   */
  fallbackReasons: string[];
}

/**
 * Create a VirtualView data provider for a database, preferring the
 * document summary buffer for the best indexing performance. The summary
 * path is chosen whenever the view definition can be answered from the
 * summary; otherwise the factory transparently falls back to the
 * materialized-document provider and reports why.
 *
 * The full-document path is used when any of these hold:
 * - `useFullDocuments: true` (explicit request) or `includeAllDocumentFields`,
 * - the filter is a JS function or a column uses a JS `valueFunction`,
 * - an expression needs decryption or a view-tree context,
 * - a referenced field is not covered by the database's summary
 *   configuration (see the `dbsetup` design document).
 *
 * Async because the summary configuration may live in the synced `dbsetup`
 * document and has to be loaded before coverage can be decided.
 */
export async function createViewDataProvider(
  options: CreateViewDataProviderOptions
): Promise<CreateViewDataProviderResult> {
  const { origin, db, filter } = options;

  const buildDocumentProvider = (fallbackReasons: string[]): CreateViewDataProviderResult => ({
    provider: new MindooDBVirtualViewDataProvider({
      origin,
      db,
      filterFunction:
        typeof filter === "function" ? filter : filterExpressionToDocumentFilter(filter),
      includeAllDocumentFields: options.includeAllDocumentFields,
    }),
    source: "documents",
    fallbackReasons,
  });

  if (options.useFullDocuments) {
    return buildDocumentProvider([]);
  }

  const reasons = await collectSummaryFallbackReasons(options);
  if (reasons.length > 0) {
    return buildDocumentProvider(reasons);
  }

  return {
    provider: new SummaryVirtualViewDataProvider({
      origin,
      summary: db.getSummaryStore!(),
      filter: filter as MindooDBAppBooleanExpression | undefined,
    }),
    source: "summary",
    fallbackReasons: [],
  };
}

/**
 * Why a view definition cannot be served from the summary buffer (empty
 * array = summary-capable). Exposed for consumers (e.g. Haven) that want
 * to surface the decision in a UI.
 */
export async function collectSummaryFallbackReasons(
  options: Pick<CreateViewDataProviderOptions, "db" | "columns" | "filter" | "includeAllDocumentFields">
): Promise<string[]> {
  const reasons: string[] = [];
  const { db, filter } = options;

  if (options.includeAllDocumentFields) {
    reasons.push("includeAllDocumentFields copies whole documents into view entries");
  }
  if (!db.getSummaryStore) {
    reasons.push("the database does not support summary stores");
    return reasons;
  }

  if (typeof filter === "function") {
    reasons.push("the filter is a JS function that needs the materialized document");
  }

  const referencedPaths = new Set<string>();

  for (const column of options.columns) {
    const resolved = column instanceof VirtualViewColumn ? column : new VirtualViewColumn(column);
    if (resolved.valueFunction && !resolved.expression) {
      reasons.push(
        `column '${resolved.name}' uses a JS valueFunction that needs the materialized document`
      );
      continue;
    }
    if (resolved.expression) {
      const requirements = analyzeExpressionRequirements(resolved.expression);
      if (requirements.needsDecryption) {
        reasons.push(
          `column '${resolved.name}' uses decrypt expressions; encrypted fields are not stored in the summary buffer`
        );
      }
      if (requirements.needsViewContext) {
        reasons.push(
          `column '${resolved.name}' uses view-tree operations (${requirements.viewContextOperations.join(", ")})`
        );
      }
      for (const path of getReferencedFields(resolved.expression)) {
        referencedPaths.add(path);
      }
    } else {
      // Plain columns read the summary field of the same name.
      referencedPaths.add(resolved.name);
    }
  }

  if (filter && typeof filter !== "function") {
    const requirements = analyzeExpressionRequirements(filter);
    if (requirements.needsDecryption) {
      reasons.push("the filter uses decrypt expressions; encrypted fields are not stored in the summary buffer");
    }
    if (requirements.needsViewContext) {
      reasons.push(
        `the filter uses view-tree operations (${requirements.viewContextOperations.join(", ")})`
      );
    }
    for (const path of getReferencedFields(filter)) {
      referencedPaths.add(path);
    }
  }

  // Coverage is decided against the settled configuration (which may come
  // from the synced dbsetup document).
  const summary = db.getSummaryStore();
  await summary.ensureConfigLoaded();
  for (const path of referencedPaths) {
    if (!summary.isFieldCovered(path)) {
      reasons.push(`field "${path}" is not covered by the summary configuration`);
    }
  }

  return reasons;
}

/**
 * Wrap a declarative filter expression into a DocumentFilterFunction for
 * the full-document path, so the same view definition works on both paths.
 */
export function filterExpressionToDocumentFilter(
  filter: MindooDBAppBooleanExpression | undefined
): DocumentFilterFunction | undefined {
  if (!filter) {
    return undefined;
  }
  return (doc) =>
    expressionToBoolean(
      evaluateExpression(filter, {
        doc: doc.getData() as Record<string, unknown>,
        values: {},
        origin: "",
        createdAt: new Date(doc.getCreatedAt()).toISOString(),
        decryptionKeyId: doc.getDecryptionKeyId(),
        variables: {},
      })
    );
}
