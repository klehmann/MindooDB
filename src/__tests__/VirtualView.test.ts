import {
  VirtualView,
  VirtualViewColumn,
  VirtualViewDataChange,
  VirtualViewFactory,
  VirtualViewNavigator,
  VirtualViewEntryData,
  ColumnSorting,
  TotalMode,
  CategorizationStyle,
  WithCategories,
  WithDocuments,
  SelectedOnly,
  ScopedDocId,
} from "../core/indexing/virtualviews";

describe("VirtualView", () => {
  describe("VirtualViewColumn", () => {
    it("should create a category column", () => {
      const column = VirtualViewColumn.category("department", {
        title: "Department",
        sorting: ColumnSorting.ASCENDING,
      });

      expect(column.name).toBe("department");
      expect(column.title).toBe("Department");
      expect(column.isCategory).toBe(true);
      expect(column.sorting).toBe(ColumnSorting.ASCENDING);
    });

    it("should throw error for category column without sorting", () => {
      expect(() => {
        new VirtualViewColumn({
          name: "test",
          isCategory: true,
          sorting: ColumnSorting.NONE,
        });
      }).toThrow("Category column 'test' must have a sorting direction");
    });

    it("should create a sorted column", () => {
      const column = VirtualViewColumn.sorted("lastName", ColumnSorting.ASCENDING);

      expect(column.name).toBe("lastName");
      expect(column.isCategory).toBe(false);
      expect(column.sorting).toBe(ColumnSorting.ASCENDING);
    });

    it("should create a total column", () => {
      const column = VirtualViewColumn.total("salary", TotalMode.SUM);

      expect(column.name).toBe("salary");
      expect(column.totalMode).toBe(TotalMode.SUM);
    });
  });

  describe("VirtualView basic operations", () => {
    it("should create a view with columns", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      expect(view.getColumns()).toHaveLength(2);
      expect(view.getCategoryColumns()).toHaveLength(1);
      expect(view.getSortColumns()).toHaveLength(1);
    });

    it("should get root entry", () => {
      const view = new VirtualView([
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const root = view.getRoot();
      expect(root).toBeDefined();
      expect(root.isCategory()).toBe(true);
      expect(root.isRoot()).toBe(true);
      expect(root.getChildCount()).toBe(0);
    });

    it("should apply changes and add entries", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { category: "A", name: "Alice" });
      change.addEntry("doc2", { category: "A", name: "Bob" });
      change.addEntry("doc3", { category: "B", name: "Charlie" });

      view.applyChanges(change);

      const root = view.getRoot();
      expect(root.getChildCount()).toBe(2); // Two categories
      
      const categories = root.getChildCategories();
      expect(categories).toHaveLength(2);
      expect(categories[0].getCategoryValue()).toBe("A");
      expect(categories[1].getCategoryValue()).toBe("B");

      // Check category A has 2 documents
      expect(categories[0].getChildDocumentCount()).toBe(2);
      // Check category B has 1 document
      expect(categories[1].getChildDocumentCount()).toBe(1);
    });

    it("should handle document removal", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      // Add documents
      const change1 = new VirtualViewDataChange("test");
      change1.addEntry("doc1", { category: "A", name: "Alice" });
      change1.addEntry("doc2", { category: "A", name: "Bob" });
      view.applyChanges(change1);

      expect(view.getRoot().getDescendantDocumentCount()).toBe(2);

      // Remove one document
      const change2 = new VirtualViewDataChange("test");
      change2.removeEntry("doc1");
      view.applyChanges(change2);

      expect(view.getRoot().getDescendantDocumentCount()).toBe(1);
    });

    it("should remove empty categories", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      // Add document
      const change1 = new VirtualViewDataChange("test");
      change1.addEntry("doc1", { category: "A", name: "Alice" });
      view.applyChanges(change1);

      expect(view.getRoot().getChildCount()).toBe(1);

      // Remove the only document
      const change2 = new VirtualViewDataChange("test");
      change2.removeEntry("doc1");
      view.applyChanges(change2);

      // Category should be removed
      expect(view.getRoot().getChildCount()).toBe(0);
    });

    it("should handle backslash-separated categories", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { category: "2024\\Q1", name: "Report 1" });
      change.addEntry("doc2", { category: "2024\\Q2", name: "Report 2" });

      view.applyChanges(change);

      const root = view.getRoot();
      // Should have one top-level category "2024"
      expect(root.getChildCount()).toBe(1);
      
      const year2024 = root.getChildCategories()[0];
      expect(year2024.getCategoryValue()).toBe("2024");
      
      // Should have two subcategories Q1 and Q2
      expect(year2024.getChildCount()).toBe(2);
    });
  });

  describe("VirtualView totals", () => {
    it("should compute SUM totals for categories", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("department", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
        VirtualViewColumn.total("salary", TotalMode.SUM),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { department: "Sales", name: "Alice", salary: 50000 });
      change.addEntry("doc2", { department: "Sales", name: "Bob", salary: 60000 });
      change.addEntry("doc3", { department: "Engineering", name: "Charlie", salary: 80000 });

      view.applyChanges(change);

      const categories = view.getRoot().getChildCategories();
      
      // Find Engineering category
      const engineering = categories.find(c => c.getCategoryValue() === "Engineering");
      expect(engineering?.getColumnValue("salary")).toBe(80000);
      
      // Find Sales category
      const sales = categories.find(c => c.getCategoryValue() === "Sales");
      expect(sales?.getColumnValue("salary")).toBe(110000);
    });

    it("should compute AVERAGE totals for categories", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("department", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
        VirtualViewColumn.total("salary", TotalMode.AVERAGE),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { department: "Sales", name: "Alice", salary: 40000 });
      change.addEntry("doc2", { department: "Sales", name: "Bob", salary: 60000 });

      view.applyChanges(change);

      const sales = view.getRoot().getChildCategories()[0];
      expect(sales.getColumnValue("salary")).toBe(50000); // (40000 + 60000) / 2
    });
  });

  describe("VirtualViewNavigator", () => {
    let view: VirtualView;

    beforeEach(() => {
      view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { category: "A", name: "Alice" });
      change.addEntry("doc2", { category: "A", name: "Bob" });
      change.addEntry("doc3", { category: "B", name: "Charlie" });
      change.addEntry("doc4", { category: "B", name: "David" });

      view.applyChanges(change);
    });

    it("should navigate forward through entries", async () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.YES
      );
      nav.expandAll();

      const entries: VirtualViewEntryData[] = [];
      for await (const entry of nav.entriesForward()) {
        entries.push(entry);
      }

      // Should have 2 categories + 4 documents = 6 entries
      expect(entries).toHaveLength(6);
      
      // First should be category A
      expect(entries[0].isCategory()).toBe(true);
      expect(entries[0].getCategoryValue()).toBe("A");
      
      // Then documents in category A
      expect(entries[1].isDocument()).toBe(true);
      expect(entries[2].isDocument()).toBe(true);
      
      // Then category B
      expect(entries[3].isCategory()).toBe(true);
      expect(entries[3].getCategoryValue()).toBe("B");
    });

    it("should navigate categories only", async () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.NO
      );
      nav.expandAll();

      const entries: VirtualViewEntryData[] = [];
      for await (const entry of nav.entriesForward()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(2);
      expect(entries[0].getCategoryValue()).toBe("A");
      expect(entries[1].getCategoryValue()).toBe("B");
    });

    it("should navigate documents only", async () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.NO,
        WithDocuments.YES
      );
      nav.expandAll();

      const entries: VirtualViewEntryData[] = [];
      for await (const entry of nav.entriesForward()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(4);
      expect(entries.every(e => e.isDocument())).toBe(true);
    });

    it("should handle expand/collapse", async () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.YES
      );
      // Default is collapsed
      nav.collapseAll();

      const entries: VirtualViewEntryData[] = [];
      for await (const entry of nav.entriesForward()) {
        entries.push(entry);
      }

      // Only categories should be visible (collapsed)
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.isCategory())).toBe(true);
    });

    it("should handle position navigation", () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.YES
      );
      nav.expandAll();

      // Go to position 1 (first category)
      expect(nav.gotoPos("1")).toBe(true);
      const entry = nav.getCurrentEntry();
      expect(entry?.isCategory()).toBe(true);
      expect(entry?.getCategoryValue()).toBe("A");
    });

    it("should handle selection", () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.YES
      );

      expect(nav.isSelected("test", "doc1")).toBe(false);
      
      nav.select("test", "doc1", false);
      expect(nav.isSelected("test", "doc1")).toBe(true);
      
      nav.deselect("test", "doc1");
      expect(nav.isSelected("test", "doc1")).toBe(false);
    });

    it("should handle selectAll/deselectAll", () => {
      const nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.YES
      );

      nav.selectAllEntries();
      expect(nav.isSelected("test", "doc1")).toBe(true);
      expect(nav.isSelected("test", "doc2")).toBe(true);
      
      nav.deselect("test", "doc1");
      expect(nav.isSelected("test", "doc1")).toBe(false);
      expect(nav.isSelected("test", "doc2")).toBe(true);

      nav.deselectAllEntries();
      expect(nav.isSelected("test", "doc1")).toBe(false);
      expect(nav.isSelected("test", "doc2")).toBe(false);
    });
  });

  describe("VirtualViewFactory", () => {
    it("should build a view using the factory", () => {
      const view = VirtualViewFactory.createView()
        .addCategoryColumn("category", { title: "Category" })
        .addSortedColumn("name")
        .addTotalColumn("amount", TotalMode.SUM)
        .withCategorizationStyle(CategorizationStyle.CATEGORY_THEN_DOCUMENT)
        .build();

      expect(view.getColumns()).toHaveLength(3);
      expect(view.getCategorizationStyle()).toBe(CategorizationStyle.CATEGORY_THEN_DOCUMENT);
    });

    it("should create a navigator using the factory", () => {
      const view = VirtualViewFactory.createView()
        .addCategoryColumn("category")
        .addSortedColumn("name")
        .build();

      const nav = VirtualViewFactory.createNavigator(view)
        .hideEmptyCategories()
        .build();

      expect(nav.isDontShowEmptyCategories()).toBe(true);
    });
  });

  describe("Sorting", () => {
    it("should sort categories in ascending order", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { category: "Zebra", name: "A" });
      change.addEntry("doc2", { category: "Apple", name: "B" });
      change.addEntry("doc3", { category: "Mango", name: "C" });

      view.applyChanges(change);

      const categories = view.getRoot().getChildCategories();
      expect(categories[0].getCategoryValue()).toBe("Apple");
      expect(categories[1].getCategoryValue()).toBe("Mango");
      expect(categories[2].getCategoryValue()).toBe("Zebra");
    });

    it("should sort categories in descending order", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.DESCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { category: "Zebra", name: "A" });
      change.addEntry("doc2", { category: "Apple", name: "B" });
      change.addEntry("doc3", { category: "Mango", name: "C" });

      view.applyChanges(change);

      const categories = view.getRoot().getChildCategories();
      expect(categories[0].getCategoryValue()).toBe("Zebra");
      expect(categories[1].getCategoryValue()).toBe("Mango");
      expect(categories[2].getCategoryValue()).toBe("Apple");
    });

    it("should sort documents by multiple columns", () => {
      const view = new VirtualView([
        VirtualViewColumn.sorted("lastName", ColumnSorting.ASCENDING),
        VirtualViewColumn.sorted("firstName", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { lastName: "Smith", firstName: "John" });
      change.addEntry("doc2", { lastName: "Smith", firstName: "Alice" });
      change.addEntry("doc3", { lastName: "Jones", firstName: "Bob" });

      view.applyChanges(change);

      const docs = view.getRoot().getChildDocuments();
      expect(docs[0].getColumnValue("lastName")).toBe("Jones");
      expect(docs[1].getColumnValue("firstName")).toBe("Alice");
      expect(docs[2].getColumnValue("firstName")).toBe("John");
    });
  });

  describe("Multiple origins", () => {
    it("should handle documents from multiple origins", () => {
      const view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change1 = new VirtualViewDataChange("db1");
      change1.addEntry("doc1", { category: "A", name: "From DB1" });

      const change2 = new VirtualViewDataChange("db2");
      change2.addEntry("doc1", { category: "A", name: "From DB2" });

      view.applyChanges(change1);
      view.applyChanges(change2);

      // Should have 2 documents (same category, different origins)
      const category = view.getRoot().getChildCategories()[0];
      expect(category.getChildDocumentCount()).toBe(2);

      // Check entries from both origins exist
      const entriesDb1 = view.getEntries("db1", "doc1");
      const entriesDb2 = view.getEntries("db2", "doc1");
      expect(entriesDb1).toHaveLength(1);
      expect(entriesDb2).toHaveLength(1);
    });
  });

  describe("VirtualViewNavigator new methods", () => {
    let view: VirtualView;
    let nav: VirtualViewNavigator;

    beforeEach(() => {
      view = new VirtualView([
        VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
        VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
      ]);

      const change = new VirtualViewDataChange("test");
      change.addEntry("doc1", { category: "A", name: "Alice" });
      change.addEntry("doc2", { category: "A", name: "Bob" });
      change.addEntry("doc3", { category: "B", name: "Charlie" });
      change.addEntry("doc4", { category: "B", name: "David" });

      view.applyChanges(change);

      nav = new VirtualViewNavigator(
        view,
        view.getRoot(),
        WithCategories.YES,
        WithDocuments.YES
      );
      nav.expandAll();
    });

    describe("getPos / getPosArray", () => {
      it("should get entry at position without moving cursor", () => {
        // Navigate to a known position
        nav.gotoPos("1");
        const initialEntry = nav.getCurrentEntry();
        
        // Get entry at different position without moving cursor
        const entryAt2 = nav.getPos("2");
        expect(entryAt2).not.toBeNull();
        expect(entryAt2?.getCategoryValue()).toBe("B");
        
        // Cursor should still be at original position
        const currentEntry = nav.getCurrentEntry();
        expect(currentEntry).toBe(initialEntry);
      });

      it("should return null for non-existent position", () => {
        const entry = nav.getPos("99");
        expect(entry).toBeNull();
      });

      it("should work with getPosArray", () => {
        const entry = nav.getPosArray([1]);
        expect(entry?.getCategoryValue()).toBe("A");
      });
    });

    describe("findCategoryEntry", () => {
      it("should find category by path string", () => {
        const categoryA = nav.findCategoryEntry("A");
        expect(categoryA).not.toBeNull();
        expect(categoryA?.getCategoryValue()).toBe("A");
      });

      it("should return null for non-existent category", () => {
        const category = nav.findCategoryEntry("NonExistent");
        expect(category).toBeNull();
      });
    });

    describe("findCategoryEntry with nested categories", () => {
      it("should find nested categories by path", () => {
        // Create a view with nested categories
        const nestedView = new VirtualView([
          VirtualViewColumn.category("category", { sorting: ColumnSorting.ASCENDING }),
          VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
        ]);

        const change = new VirtualViewDataChange("test");
        change.addEntry("doc1", { category: "2024\\Q1", name: "Report 1" });
        change.addEntry("doc2", { category: "2024\\Q2", name: "Report 2" });

        nestedView.applyChanges(change);

        const nestedNav = new VirtualViewNavigator(
          nestedView,
          nestedView.getRoot(),
          WithCategories.YES,
          WithDocuments.YES
        );
        nestedNav.expandAll();

        // Find top-level category
        const year2024 = nestedNav.findCategoryEntry("2024");
        expect(year2024).not.toBeNull();
        expect(year2024?.getCategoryValue()).toBe("2024");

        // Find nested category
        const q1 = nestedNav.findCategoryEntry("2024\\Q1");
        expect(q1).not.toBeNull();
        expect(q1?.getCategoryValue()).toBe("Q1");
      });
    });

    describe("entriesForwardFromPosition", () => {
      it("should iterate from a specific position", async () => {
        const entries: VirtualViewEntryData[] = [];
        
        // Start from position 2 (category B)
        for await (const entry of nav.entriesForwardFromPosition("2")) {
          entries.push(entry);
        }

        // Should get category B and its 2 documents = 3 entries
        expect(entries.length).toBe(3);
        expect(entries[0].getCategoryValue()).toBe("B");
        expect(entries[1].isDocument()).toBe(true);
        expect(entries[2].isDocument()).toBe(true);
      });

      it("should return nothing for invalid position", async () => {
        const entries: VirtualViewEntryData[] = [];
        
        for await (const entry of nav.entriesForwardFromPosition("99")) {
          entries.push(entry);
        }

        expect(entries).toHaveLength(0);
      });
    });

    describe("childDocumentsBetween / childDocumentsByKey", () => {
      it("should filter child documents by key range", () => {
        const categoryA = view.getRoot().getChildCategories()[0];
        
        // Get documents with names starting with "A" to "B"
        const docs = nav.childDocumentsBetween(categoryA, "Alice", "Bob");
        expect(docs).toHaveLength(2);
      });

      it("should filter child documents by exact key", () => {
        const categoryA = view.getRoot().getChildCategories()[0];
        
        // Exact match
        const docs = nav.childDocumentsByKey(categoryA, "Alice", true);
        expect(docs).toHaveLength(1);
        expect(docs[0].getColumnValue("name")).toBe("Alice");
      });

      it("should filter child documents by prefix", () => {
        const categoryA = view.getRoot().getChildCategories()[0];
        
        // Prefix match - "A" should match "Alice"
        const docs = nav.childDocumentsByKey(categoryA, "A", false);
        expect(docs).toHaveLength(1);
        expect(docs[0].getColumnValue("name")).toBe("Alice");
      });
    });

    describe("childCategoriesBetween / childCategoriesByKey", () => {
      it("should filter child categories by key range", () => {
        const root = view.getRoot();
        
        // Get categories from "A" to "B"
        const cats = nav.childCategoriesBetween(root, "A", "B");
        expect(cats).toHaveLength(2);
      });

      it("should filter child categories by exact key", () => {
        const root = view.getRoot();
        
        const cats = nav.childCategoriesByKey(root, "A", true);
        expect(cats).toHaveLength(1);
        expect(cats[0].getCategoryValue()).toBe("A");
      });
    });

    describe("getSortedEntries", () => {
      it("should get sorted entries for a document", () => {
        const entries = nav.getSortedEntries("test", "doc1");
        expect(entries).toHaveLength(1);
        expect(entries[0].docId).toBe("doc1");
      });

      it("should get sorted entries for multiple documents", () => {
        const docIds = new Set(["doc1", "doc3"]);
        const entries = nav.getSortedEntriesMultiple("test", docIds);
        
        expect(entries).toHaveLength(2);
        // Entries should be sorted by position (doc1 is in A, doc3 is in B)
        expect(entries[0].docId).toBe("doc1");
        expect(entries[1].docId).toBe("doc3");
      });
    });

    describe("getSortedDocIds", () => {
      it("should return doc IDs sorted by position", () => {
        const docIds = new Set(["doc3", "doc1", "doc2"]);
        const sorted = nav.getSortedDocIds("test", docIds);
        
        expect(sorted).toHaveLength(3);
        // Should be sorted by position in view
        expect(sorted[0]).toBe("doc1");
        expect(sorted[1]).toBe("doc2");
        expect(sorted[2]).toBe("doc3");
      });
    });

    describe("getSortedDocIdsScoped", () => {
      it("should return scoped doc IDs sorted by position", () => {
        const scopedIds = new Set<ScopedDocId>([
          { origin: "test", docId: "doc3" },
          { origin: "test", docId: "doc1" },
        ]);
        const sorted = nav.getSortedDocIdsScoped(scopedIds);
        
        expect(sorted).toHaveLength(2);
        expect(sorted[0].docId).toBe("doc1");
        expect(sorted[1].docId).toBe("doc3");
      });
    });

    describe("expandPosArray / collapsePosArray", () => {
      it("should expand by position array", () => {
        nav.collapseAll();
        nav.expandPosArray([1]); // Expand category A
        
        nav.gotoPos("1");
        const categoryA = nav.getCurrentEntry();
        expect(nav.isExpanded(categoryA!)).toBe(true);
      });

      it("should collapse by position array", () => {
        nav.expandAll();
        nav.collapsePosArray([1]); // Collapse category A
        
        nav.gotoPos("1");
        const categoryA = nav.getCurrentEntry();
        expect(nav.isExpanded(categoryA!)).toBe(false);
      });
    });

    describe("isExpandedByDocId", () => {
      it("should check expansion state by docId", () => {
        nav.collapseAll();
        
        // Get category A's docId
        nav.gotoPos("1");
        const categoryA = nav.getCurrentEntry();
        const origin = categoryA!.origin;
        const docId = categoryA!.docId;
        
        expect(nav.isExpandedByDocId(origin, docId)).toBe(false);
        
        nav.expand(origin, docId);
        expect(nav.isExpandedByDocId(origin, docId)).toBe(true);
      });
    });

    describe("isDeselectAllByDefault", () => {
      it("should return true by default", () => {
        expect(nav.isDeselectAllByDefault()).toBe(true);
        expect(nav.isSelectAllByDefault()).toBe(false);
      });

      it("should return false after selectAll", () => {
        nav.selectAllEntries();
        expect(nav.isDeselectAllByDefault()).toBe(false);
        expect(nav.isSelectAllByDefault()).toBe(true);
      });

      it("should return true after deselectAll", () => {
        nav.selectAllEntries();
        nav.deselectAllEntries();
        expect(nav.isDeselectAllByDefault()).toBe(true);
      });
    });
  });
});
