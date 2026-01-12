import type { MindooDB, MindooDoc } from "../../types";
import { VirtualView } from "./VirtualView";
import { VirtualViewColumn, VirtualViewColumnOptions } from "./VirtualViewColumn";
import type { VirtualViewEntryData } from "./VirtualViewEntryData";
import { VirtualViewNavigator } from "./VirtualViewNavigator";
import type { IVirtualViewDataProvider } from "./IVirtualViewDataProvider";
import { MindooDBVirtualViewDataProvider, MindooDBVirtualViewDataProviderOptions } from "./MindooDBVirtualViewDataProvider";
import type { IViewEntryAccessCheck } from "./IViewEntryAccessCheck";
import { AllowAllAccessCheck, CallbackAccessCheck } from "./IViewEntryAccessCheck";
import {
  CategorizationStyle,
  ColumnSorting,
  TotalMode,
  WithCategories,
  WithDocuments,
  DocumentFilterFunction,
} from "./types";

/**
 * Builder for creating VirtualView instances with a fluent API
 */
export class VirtualViewBuilder {
  private columns: VirtualViewColumn[] = [];
  private categorizationStyle: CategorizationStyle = CategorizationStyle.DOCUMENT_THEN_CATEGORY;
  private dataProviders: IVirtualViewDataProvider[] = [];

  /**
   * Add a column to the view
   */
  addColumn(column: VirtualViewColumn): this {
    this.columns.push(column);
    return this;
  }

  /**
   * Add a column using options
   */
  addColumnFromOptions(options: VirtualViewColumnOptions): this {
    this.columns.push(new VirtualViewColumn(options));
    return this;
  }

  /**
   * Add a category column
   */
  addCategoryColumn(
    name: string,
    options?: Partial<Omit<VirtualViewColumnOptions, "name" | "isCategory">>
  ): this {
    this.columns.push(VirtualViewColumn.category(name, options));
    return this;
  }

  /**
   * Add a sorted column
   */
  addSortedColumn(
    name: string,
    sorting: ColumnSorting = ColumnSorting.ASCENDING,
    options?: Partial<Omit<VirtualViewColumnOptions, "name" | "sorting">>
  ): this {
    this.columns.push(VirtualViewColumn.sorted(name, sorting, options));
    return this;
  }

  /**
   * Add a display-only column
   */
  addDisplayColumn(
    name: string,
    options?: Partial<Omit<VirtualViewColumnOptions, "name">>
  ): this {
    this.columns.push(VirtualViewColumn.display(name, options));
    return this;
  }

  /**
   * Add a total column
   */
  addTotalColumn(
    name: string,
    totalMode: TotalMode,
    options?: Partial<Omit<VirtualViewColumnOptions, "name" | "totalMode">>
  ): this {
    this.columns.push(VirtualViewColumn.total(name, totalMode, options));
    return this;
  }

  /**
   * Set the categorization style
   */
  withCategorizationStyle(style: CategorizationStyle): this {
    this.categorizationStyle = style;
    return this;
  }

  /**
   * Add a MindooDB data provider
   */
  withMindooDB(options: MindooDBVirtualViewDataProviderOptions): this {
    this.dataProviders.push(new MindooDBVirtualViewDataProvider(options));
    return this;
  }

  /**
   * Add a MindooDB with simplified options
   */
  withDB(
    origin: string,
    db: MindooDB,
    filterFunction?: DocumentFilterFunction
  ): this {
    this.dataProviders.push(
      new MindooDBVirtualViewDataProvider({
        origin,
        db,
        filterFunction,
      })
    );
    return this;
  }

  /**
   * Add a custom data provider
   */
  withDataProvider(provider: IVirtualViewDataProvider): this {
    this.dataProviders.push(provider);
    return this;
  }

  /**
   * Build the VirtualView
   */
  build(): VirtualView {
    if (this.columns.length === 0) {
      throw new Error("At least one column is required");
    }

    const view = new VirtualView(this.columns);
    view.setCategorizationStyle(this.categorizationStyle);

    for (const provider of this.dataProviders) {
      provider.init(view);
      view.addDataProvider(provider);
    }

    return view;
  }

  /**
   * Build the VirtualView and run initial update
   */
  async buildAndUpdate(): Promise<VirtualView> {
    const view = this.build();
    await view.update();
    return view;
  }
}

/**
 * Builder for creating VirtualViewNavigator instances
 */
export class VirtualViewNavigatorBuilder {
  private readonly view: VirtualView;
  private withCategories: WithCategories = WithCategories.YES;
  private withDocuments: WithDocuments = WithDocuments.YES;
  private accessCheck: IViewEntryAccessCheck | null = null;
  private dontShowEmptyCategories: boolean = false;
  private rootEntry: VirtualViewEntryData | null = null;

  constructor(view: VirtualView) {
    this.view = view;
  }

  /**
   * Include only categories (no documents)
   */
  categoriesOnly(): this {
    this.withCategories = WithCategories.YES;
    this.withDocuments = WithDocuments.NO;
    return this;
  }

  /**
   * Include only documents (no categories)
   */
  documentsOnly(): this {
    this.withCategories = WithCategories.NO;
    this.withDocuments = WithDocuments.YES;
    return this;
  }

  /**
   * Don't show empty categories
   */
  hideEmptyCategories(): this {
    this.dontShowEmptyCategories = true;
    return this;
  }

  /**
   * Set a custom access check
   */
  withAccessCheck(check: IViewEntryAccessCheck): this {
    this.accessCheck = check;
    return this;
  }

  /**
   * Set a callback-based access check
   */
  withAccessCallback(
    callback: (nav: VirtualViewNavigator, entry: VirtualViewEntryData) => boolean
  ): this {
    this.accessCheck = new CallbackAccessCheck(callback);
    return this;
  }

  /**
   * Start navigation from a specific category
   */
  fromCategory(categoryPath: string): this {
    // Navigate to category by path (e.g., "Sales\\2024")
    const root = this.view.getRoot();
    const parts = categoryPath.split("\\");
    
    let current = root;
    for (const part of parts) {
      const children = current.getChildCategories();
      const match = children.find(c => {
        const catValue = c.getCategoryValue();
        return catValue !== null && String(catValue) === part;
      });
      
      if (!match) {
        // Category not found - will start from root
        break;
      }
      current = match;
    }
    
    this.rootEntry = current;
    return this;
  }

  /**
   * Start navigation from a specific entry
   */
  fromEntry(entry: VirtualViewEntryData): this {
    this.rootEntry = entry;
    return this;
  }

  /**
   * Build the navigator
   */
  build(): VirtualViewNavigator {
    const topEntry = this.rootEntry ?? this.view.getRoot();
    
    return new VirtualViewNavigator(
      this.view,
      topEntry,
      this.withCategories,
      this.withDocuments,
      this.accessCheck,
      this.dontShowEmptyCategories
    );
  }
}

/**
 * Factory for creating VirtualView instances
 */
export class VirtualViewFactory {
  /**
   * Create a new VirtualView builder
   */
  static createView(): VirtualViewBuilder {
    return new VirtualViewBuilder();
  }

  /**
   * Create a VirtualView with columns directly
   */
  static createViewWithColumns(columns: VirtualViewColumn[]): VirtualView {
    return new VirtualView(columns);
  }

  /**
   * Create a navigator builder for a view
   */
  static createNavigator(view: VirtualView): VirtualViewNavigatorBuilder {
    return new VirtualViewNavigatorBuilder(view);
  }

  /**
   * Create a simple navigator for a view (all categories and documents)
   */
  static createSimpleNavigator(view: VirtualView): VirtualViewNavigator {
    return new VirtualViewNavigatorBuilder(view).build();
  }
}
