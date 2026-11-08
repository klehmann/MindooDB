import {
  ColumnSorting,
  VirtualView,
  VirtualViewColumn,
  VirtualViewDataChange,
  VirtualViewFactory,
  type MergedEntryKey,
} from "../core/indexing/virtualviews";

function mailView(): VirtualView {
  return new VirtualView([
    VirtualViewColumn.category("folder", { sorting: ColumnSorting.ASCENDING }),
    VirtualViewColumn.sorted("receivedAt", ColumnSorting.DESCENDING),
    VirtualViewColumn.display("subject"),
  ]);
}

function add(view: VirtualView, origin: string, rows: Array<[string, string | string[], number]>): void {
  const change = new VirtualViewDataChange(origin);
  for (const [docId, folder, receivedAt] of rows) {
    change.addEntry(docId, { folder, receivedAt, subject: docId });
  }
  view.applyChanges(change);
}

function ids(entries: Array<{ docId: string }>): string[] {
  return entries.map((e) => e.docId);
}

describe("VirtualViewMergedNavigator (rootCategoryPaths)", () => {
  let view: VirtualView;

  beforeEach(() => {
    view = mailView();
    add(view, "mail", [
      ["a1", "acc1/inbox", 10],
      ["a2", "acc1/inbox", 7],
      ["a3", "acc1/inbox", 3],
      ["b1", "acc2/INBOX", 9],
      ["b2", "acc2/INBOX", 4],
      ["l1", ["mindoomail/inbox", "acc1/inbox"], 8], // in two of the read folders
      ["x1", "acc1/sent", 11],
    ]);
  });

  it("merges several categories by the document sort columns and drops duplicates", async () => {
    const nav = VirtualViewFactory.createMergedNavigator(view, [
      ["acc1/inbox"],
      ["acc2/INBOX"],
      ["mindoomail/inbox"],
      ["does-not-exist"],
    ]);
    expect(nav.getRootEntries()).toHaveLength(3);
    const all: string[] = [];
    for await (const entry of nav.entriesForward()) {
      all.push(entry.docId);
    }
    expect(all).toEqual(["a1", "b1", "l1", "a2", "b2", "a3"]);
    expect(nav.countDocuments()).toBe(6);
    expect(nav.getDocumentCountUpperBound()).toBe(7);

    const back: string[] = [];
    for await (const entry of nav.entriesBackward()) {
      back.push(entry.docId);
    }
    expect(back).toEqual([...all].reverse());
  });

  it("pages forward and backward with key cursors", () => {
    const nav = VirtualViewFactory.createMergedNavigator(view, [["acc1/inbox"], ["acc2/INBOX"], ["mindoomail/inbox"]]);
    const pages: string[][] = [];
    let after: MergedEntryKey | null = null;
    do {
      const page = nav.readForward({ after, limit: 2 });
      pages.push(ids(page.entries));
      after = page.nextKey;
    } while (after);
    expect(pages).toEqual([["a1", "b1"], ["l1", "a2"], ["b2", "a3"]]);

    const first = nav.readBackward({ limit: 4 });
    expect(ids(first.entries)).toEqual(["a3", "b2", "a2", "l1"]);
    const second = nav.readBackward({ before: first.nextKey, limit: 4 });
    expect(ids(second.entries)).toEqual(["b1", "a1"]);
    expect(second.nextKey).toBeNull();
  });

  it("keeps paging stable when the view changes between pages", () => {
    const nav = VirtualViewFactory.createMergedNavigator(view, [["acc1/inbox"], ["acc2/INBOX"]]);
    const page1 = nav.readForward({ limit: 2 });
    expect(ids(page1.entries)).toEqual(["a1", "b1"]);
    // A newer mail arrives (before the cursor) and an older one (after it).
    add(view, "mail", [
      ["new", "acc2/INBOX", 12],
      ["old", "acc2/INBOX", 1],
    ]);
    const nav2 = VirtualViewFactory.createMergedNavigator(view, [["acc1/inbox"], ["acc2/INBOX"]]);
    const page2 = nav2.readForward({ after: page1.nextKey, limit: 10 });
    expect(ids(page2.entries)).toEqual(["l1", "a2", "b2", "a3", "old"]);
  });

  it("supports cursor-style navigation and access checks", () => {
    const nav = VirtualViewFactory.createMergedNavigator(view, [["acc1/inbox"], ["acc2/INBOX"]], {
      accessCheck: (entry) => entry.docId !== "b1",
    });
    expect(nav.gotoFirst()).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("a1");
    expect(nav.gotoNext()).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("l1");
    expect(nav.gotoPrev()).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("a1");
    expect(nav.gotoPrev()).toBe(false);
    expect(nav.gotoLast()).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("a3");
    expect(nav.gotoKey({ v: [7], o: "mail", d: "a2" })).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("a2");
    // Tree positions of the underlying view work as tokens as well.
    const pos = nav.getCurrentEntry()!.getPositionStr();
    nav.gotoFirst();
    expect(nav.gotoPos(pos)).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("a2");
    expect(nav.gotoNext()).toBe(true);
    expect(nav.getCurrentEntry()?.docId).toBe("b2");
    // A document outside the merged categories is not reachable.
    const sent = VirtualViewFactory.createMergedNavigator(view, [["acc1/sent"]]);
    sent.gotoFirst();
    expect(nav.getPos(sent.getCurrentEntry()!.getPositionStr())).toBeNull();
  });

  it("merges categories that have sub-categories by the document sort key", async () => {
    const nested = new VirtualView([
      VirtualViewColumn.category("folder", { sorting: ColumnSorting.ASCENDING }),
      VirtualViewColumn.category("year", { sorting: ColumnSorting.ASCENDING }),
      VirtualViewColumn.sorted("receivedAt", ColumnSorting.ASCENDING),
    ]);
    const change = new VirtualViewDataChange("o");
    change.addEntry("p1", { folder: "p", year: 2025, receivedAt: 5 });
    change.addEntry("p2", { folder: "p", year: 2024, receivedAt: 9 });
    change.addEntry("q1", { folder: "q", year: 2024, receivedAt: 7 });
    nested.applyChanges(change);
    const nav = VirtualViewFactory.createMergedNavigator(nested, [["p"], ["q"]]);
    const all: string[] = [];
    for await (const entry of nav.entriesForward()) {
      all.push(entry.docId);
    }
    expect(all).toEqual(["p1", "q1", "p2"]);
    expect(ids(nav.readForward({ after: { v: [5], o: "o", d: "p1" }, limit: 5 }).entries)).toEqual(["q1", "p2"]);
  });

  it("returns nothing for no matching categories", () => {
    const nav = VirtualViewFactory.createMergedNavigator(view, [["nope"]]);
    expect(nav.readForward().entries).toEqual([]);
    expect(nav.gotoFirst()).toBe(false);
  });
});
