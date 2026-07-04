import type { MindooDB } from "../types";
import type { MindooDBAppBooleanExpression } from "../expressions/types";
import { analyzeExpressionRequirements, getReferencedFields } from "../expressions";
import type { DocumentSummaryStore } from "../indexing/summary/DocumentSummaryStore";
import { SummaryVirtualViewDataProvider } from "../indexing/summary/SummaryVirtualViewDataProvider";
import { VirtualView } from "../indexing/virtualviews/VirtualView";
import { VirtualViewColumn, type VirtualViewColumnOptions } from "../indexing/virtualviews/VirtualViewColumn";
import type { VirtualViewUpdateOptions } from "../indexing/virtualviews/IVirtualViewDataProvider";
import type { CategorizationStyle } from "../indexing/virtualviews/types";
import { MindooQueryError } from "./types";

/**
 * Declarative definition of an ephemeral, summary-backed view. Fully
 * JSON-serializable when columns use `expression` instead of
 * `valueFunction` — the basis for view designs stored/synchronized as
 * data.
 */
export interface MindooQueryViewDefinition {
  /**
   * Expression filter selecting which documents appear in the view.
   * Applies to every source unless a source provides its own filter.
   */
  filter?: MindooDBAppBooleanExpression;
  /** View columns (categories/sorting/totals work as in persistent views). */
  columns: Array<VirtualViewColumn | VirtualViewColumnOptions>;
  categorizationStyle?: CategorizationStyle;
}

/**
 * One database feeding an ephemeral summary view. Like persistent
 * VirtualViews, ephemeral views can combine multiple sources — different
 * databases and even different tenants — each contributing entries under
 * its own origin.
 */
export interface EphemeralViewSource {
  /** The database whose summary buffer feeds this source. */
  db: MindooDB;

  /**
   * Per-source filter. When set it replaces the definition-level filter
   * for this source (e.g. different document types per database).
   */
  filter?: MindooDBAppBooleanExpression;

  /**
   * Origin identifier for entries of this source. Must be unique within
   * the view. Defaults to `<tenantId>/<storeId>#ephemeral`, which is
   * already unique across databases and tenants.
   */
  origin?: string;
}

/** Internally resolved source: summary store and origin are settled. */
interface ResolvedViewSource {
  db: MindooDB;
  summary: DocumentSummaryStore;
  origin: string;
  filter?: MindooDBAppBooleanExpression;
}

function defaultEphemeralOrigin(db: MindooDB): string {
  return `${db.getTenant().getId()}/${db.getStore().getId()}#ephemeral`;
}

function resolveSources(sources: EphemeralViewSource[]): ResolvedViewSource[] {
  if (sources.length === 0) {
    throw new MindooQueryError("An ephemeral view needs at least one source database.");
  }
  const resolved: ResolvedViewSource[] = [];
  const seenOrigins = new Set<string>();
  for (const source of sources) {
    if (!source.db.getSummaryStore) {
      throw new MindooQueryError("A source database does not support summary stores.");
    }
    const origin = source.origin ?? defaultEphemeralOrigin(source.db);
    if (seenOrigins.has(origin)) {
      throw new MindooQueryError(
        `Duplicate view source origin "${origin}" — pass distinct 'origin' values when combining the same database twice.`
      );
    }
    seenOrigins.add(origin);
    resolved.push({
      db: source.db,
      summary: source.db.getSummaryStore(),
      origin,
      filter: source.filter,
    });
  }
  return resolved;
}

/**
 * An ephemeral VirtualView over one or more document summary buffers,
 * created by `db.queryView()` (single database) or {@link queryViewAcross}
 * (multiple databases/tenants).
 *
 * Unlike persistent views it is not registered with a CacheManager —
 * building it is a pure in-memory sort over summary entries, so dynamic
 * re-sorting is cheap: {@link resort} swaps in a new column set over the
 * SAME summaries (no document reload, no changefeed re-consumption).
 */
export class EphemeralSummaryView {
  private view: VirtualView;
  private providers: SummaryVirtualViewDataProvider[] = [];
  private disposed = false;
  /** Whether a live binding is active (survives resort rebuilds). */
  private liveBound = false;

  constructor(
    private readonly sources: ResolvedViewSource[],
    private definition: MindooQueryViewDefinition
  ) {
    this.view = this.buildView(definition);
  }

  private buildView(definition: MindooQueryViewDefinition): VirtualView {
    validateViewDefinition(this.sources, definition);
    const columns = definition.columns.map((column) =>
      column instanceof VirtualViewColumn ? column : new VirtualViewColumn(column)
    );
    const view = new VirtualView(columns);
    if (definition.categorizationStyle !== undefined) {
      view.setCategorizationStyle(definition.categorizationStyle);
    }
    this.providers = [];
    for (const source of this.sources) {
      const provider = new SummaryVirtualViewDataProvider({
        origin: source.origin,
        summary: source.summary,
        filter: source.filter ?? definition.filter,
      });
      provider.init(view);
      view.addDataProvider(provider);
      this.providers.push(provider);
    }
    return view;
  }

  /** The underlying VirtualView (navigators, entries, totals as usual). */
  getView(): VirtualView {
    this.assertNotDisposed();
    return this.view;
  }

  /** Bring the view up to date (summary updates + entry propagation). */
  async update(options?: VirtualViewUpdateOptions): Promise<void> {
    this.assertNotDisposed();
    await this.view.update(options);
  }

  /**
   * Replace the column set (and optionally the filter) and rebuild the
   * view from the summaries — dynamic re-sorting without touching
   * documents. A live binding created via {@link bindTo} carries over to
   * the new view.
   */
  async resort(
    definition: Partial<MindooQueryViewDefinition> & Pick<MindooQueryViewDefinition, "columns">,
    options?: VirtualViewUpdateOptions
  ): Promise<void> {
    this.assertNotDisposed();
    this.definition = {
      ...this.definition,
      ...definition,
    };
    this.view.unbind();
    this.view = this.buildView(this.definition);
    if (this.liveBound) {
      this.bindSources();
    }
    await this.view.update(options);
  }

  /**
   * Keep this view up to date automatically via the change feeds of ALL
   * source databases (see {@link VirtualView.bindTo}). Combine with
   * `getView().onDidUpdate()` for UI re-render hooks.
   *
   * @returns An unbind function.
   */
  bindTo(): () => void {
    this.assertNotDisposed();
    this.liveBound = true;
    this.bindSources();
    return () => {
      this.unbind();
    };
  }

  private bindSources(): void {
    for (const source of this.sources) {
      this.view.bindTo(source.db);
    }
  }

  /** Detach all change-feed bindings. */
  unbind(): void {
    this.liveBound = false;
    this.view.unbind();
  }

  /**
   * Release the view: detaches change-feed bindings and drops internal
   * state. Ephemeral views hold no CacheManager registration, so nothing
   * else needs cleanup.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.unbind();
    this.disposed = true;
    for (const provider of this.providers) {
      provider.reset();
    }
    this.providers = [];
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("This ephemeral view has been disposed.");
    }
  }
}

/**
 * Guardrails mirroring `db.query()`: expressions must be answerable from
 * the summary buffers (no decrypt, no view-tree operations in filters,
 * referenced fields covered by EACH source's summary configuration).
 */
function validateViewDefinition(sources: ResolvedViewSource[], definition: MindooQueryViewDefinition): void {
  const columnPaths = new Set<string>();

  for (const column of definition.columns) {
    const expression = column instanceof VirtualViewColumn ? column.expression : column.expression;
    if (!expression) {
      continue;
    }
    const requirements = analyzeExpressionRequirements(expression);
    if (requirements.needsDecryption) {
      throw new MindooQueryError(
        "View columns cannot use decrypt expressions: encrypted fields are not stored in the summary buffer."
      );
    }
    for (const path of getReferencedFields(expression)) {
      columnPaths.add(path);
    }
  }

  for (const source of sources) {
    const referencedPaths = new Set<string>(columnPaths);

    const filter = source.filter ?? definition.filter;
    if (filter) {
      const requirements = analyzeExpressionRequirements(filter);
      if (requirements.needsViewContext) {
        throw new MindooQueryError(
          `View filters cannot use view-tree operations (${requirements.viewContextOperations.join(", ")}).`
        );
      }
      if (requirements.needsDecryption) {
        throw new MindooQueryError(
          "View filters cannot use decrypt expressions: encrypted fields are not stored in the summary buffer."
        );
      }
      for (const path of getReferencedFields(filter)) {
        referencedPaths.add(path);
      }
    }

    for (const path of referencedPaths) {
      if (!source.summary.isFieldCovered(path)) {
        throw new MindooQueryError(
          `Field "${path}" is not covered by the summary configuration of source "${source.origin}" ` +
          `(check include/exclude in SummaryConfig).`
        );
      }
    }
  }
}

/**
 * Build an ephemeral, summary-backed VirtualView over a single database
 * and run its initial update. See {@link EphemeralSummaryView}.
 */
export async function createEphemeralSummaryView(
  db: MindooDB,
  summary: DocumentSummaryStore,
  definition: MindooQueryViewDefinition,
  options?: VirtualViewUpdateOptions
): Promise<EphemeralSummaryView> {
  const view = new EphemeralSummaryView(
    [{ db, summary, origin: defaultEphemeralOrigin(db) }],
    definition
  );
  await view.update(options);
  return view;
}

/**
 * Build an ephemeral, summary-backed VirtualView spanning MULTIPLE
 * databases — and, since every source brings its own tenant context, even
 * multiple tenants. Each source contributes entries under its own origin
 * from its own summary buffer; no documents are materialized anywhere.
 *
 * ```typescript
 * const view = await queryViewAcross(
 *   [
 *     { db: salesDb },
 *     { db: archiveDb, filter: v.eq(v.field("year"), 2025) },
 *   ],
 *   {
 *     filter: v.eq(v.field("type"), "deal"),
 *     columns: [
 *       VirtualViewColumn.category("region"),
 *       VirtualViewColumn.sorted("amount", ColumnSorting.DESCENDING),
 *     ],
 *   }
 * );
 * ```
 *
 * A per-source `filter` replaces the definition-level filter for that
 * source. `bindTo()` subscribes to the change feeds of all sources.
 */
export async function queryViewAcross(
  sources: EphemeralViewSource[],
  definition: MindooQueryViewDefinition,
  options?: VirtualViewUpdateOptions
): Promise<EphemeralSummaryView> {
  const view = new EphemeralSummaryView(resolveSources(sources), definition);
  await view.update(options);
  return view;
}
