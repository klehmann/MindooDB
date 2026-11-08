import {
  ColumnSorting,
  TotalMode,
  VirtualView,
  VirtualViewColumn,
  VirtualViewDataChange,
  VirtualViewNavigator,
  WithCategories,
  WithDocuments,
} from "../core/indexing/virtualviews";

function buildView(): VirtualView {
  const view = new VirtualView([
    VirtualViewColumn.category("folder", { sorting: ColumnSorting.ASCENDING }),
    VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING),
    VirtualViewColumn.total("amount", TotalMode.SUM),
  ]);
  const change = new VirtualViewDataChange("o");
  change.addEntry("d1", { folder: "A", name: "b", amount: 2 });
  change.addEntry("d2", { folder: "A", name: "c", amount: 3 });
  change.addEntry("d3", { folder: "B", name: "a", amount: 5 });
  view.applyChanges(change);
  return view;
}

describe("VirtualViewEntryData (compact entries)", () => {
  it("document entries have no children, counts or totals", () => {
    const view = buildView();
    const [doc] = view.getEntries("o", "d1");
    expect(doc.isDocument()).toBe(true);
    expect(doc.getChildEntries()).toEqual([]);
    expect(doc.getChildCount()).toBe(0);
    expect(doc.getDescendantCount()).toBe(0);
    expect(doc.getDescendantDocumentCount()).toBe(0);
    expect(doc.getTotalValues()).toEqual({});
    expect(doc.getTotalValue("amount")).toBeNull();
    expect(doc.hasChildEntry(doc.getSortKey())).toBe(false);
    expect(doc.getChildEntry(doc.getSortKey())).toBeUndefined();
    expect(doc.removeChildEntry(doc.getSortKey())).toBe(false);

    const category = doc.getParent()!;
    expect(category.getChildCount()).toBe(2);
    expect(category.getDescendantDocumentCount()).toBe(2);
    expect(category.getTotalValue("amount")).toBe(5);
    expect(category.getColumnValue("amount")).toBe(5);
    expect(view.getRoot().getDescendantDocumentCount()).toBe(3);
  });

  it("keeps counts and totals right when entries leave and come back", () => {
    const view = buildView();
    const remove = new VirtualViewDataChange("o");
    remove.removeEntry("d1");
    view.applyChanges(remove);
    const [d2] = view.getEntries("o", "d2");
    const categoryA = d2.getParent()!;
    expect(categoryA.getChildCount()).toBe(1);
    expect(categoryA.getTotalValue("amount")).toBe(3);

    const removeAll = new VirtualViewDataChange("o");
    removeAll.removeEntry("d2");
    view.applyChanges(removeAll);
    expect(view.getRoot().getChildCount()).toBe(1);
    expect(view.getRoot().getDescendantDocumentCount()).toBe(1);

    const add = new VirtualViewDataChange("o");
    add.addEntry("d4", { folder: "A", name: "z", amount: 7 });
    view.applyChanges(add);
    const [d4] = view.getEntries("o", "d4");
    expect(d4.getParent()!.getTotalValue("amount")).toBe(7);
    expect(view.getRoot().getDescendantDocumentCount()).toBe(2);
  });

  it("stores column values as a copy and skips undefined", () => {
    const view = buildView();
    const [doc] = view.getEntries("o", "d1");
    doc.setColumnValues({ a: 1, b: undefined, c: "x" });
    expect(doc.getColumnValues()).toEqual({ a: 1, c: "x" });
    expect(Object.keys(doc.getColumnValues())).toEqual(["a", "c"]);
    expect(doc.getColumnValue("b")).toBeUndefined();
    expect(doc.getColumnValue("toString")).toBeUndefined();
    expect(doc.getAsString("toString", "-")).toBe("-");

    const copy = doc.getColumnValues();
    copy.a = 99;
    expect(doc.getColumnValue("a")).toBe(1);

    doc.setColumnValue("a", 2);
    doc.setColumnValue("d", [1, 2]);
    doc.setColumnValue("c", undefined);
    expect(doc.getColumnValues()).toEqual({ a: 2, d: [1, 2] });
    expect(doc.getAsStringList("d", null)).toEqual(["1", "2"]);
    expect(doc.getAsNumber("a", null)).toBe(2);
    doc.setColumnValue("missing", undefined);
    expect(doc.getColumnValues()).toEqual({ a: 2, d: [1, 2] });

    doc.setColumnValues({});
    expect(doc.getColumnValues()).toEqual({});
  });

  it("treats __proto__ as an ordinary column name", () => {
    const view = buildView();
    const [doc] = view.getEntries("o", "d1");
    const values = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as Record<string, unknown>;
    doc.setColumnValues(values);
    expect(doc.getColumnValue("__proto__")).toEqual({ polluted: true });
    expect(doc.getColumnValue("polluted")).toBeUndefined();
    const out = doc.getColumnValues();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    doc.setColumnValue("__proto__", undefined);
    expect(doc.getColumnValues()).toEqual({ x: 1 });
  });

  it("computes positions from the current sibling indexes (no stale positions)", () => {
    const view = buildView();
    const navigator = new VirtualViewNavigator(view, view.getRoot(), WithCategories.YES, WithDocuments.YES);
    const [d3] = view.getEntries("o", "d3");
    expect(d3.getPositionStr()).toBe("2.1");
    const [d2] = view.getEntries("o", "d2");
    expect(d2.getPosition()).toEqual([1, 2]);

    // A new first category shifts every later position.
    const add = new VirtualViewDataChange("o");
    add.addEntry("d0", { folder: "0", name: "a", amount: 1 });
    add.addEntry("d5", { folder: "A", name: "a", amount: 1 });
    view.applyChanges(add);
    expect(d3.getPositionStr()).toBe("3.1");
    expect(d2.getPosition()).toEqual([2, 3]);
    expect(navigator.getSortedEntriesMultiple("o", new Set(["d3", "d0", "d2"])).map((e) => e.docId)).toEqual([
      "d0",
      "d2",
      "d3",
    ]);
  });
});
