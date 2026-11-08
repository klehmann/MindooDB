import type { MindooDB } from "../core/types";
import {
  ColumnSorting,
  SelectedOnly,
  TotalMode,
  VirtualViewFactory,
  type VirtualView,
  type VirtualViewBuilder,
} from "../core/indexing/virtualviews";
import { SummaryVirtualViewDataProvider } from "../core/indexing/summary/SummaryVirtualViewDataProvider";
import {
  createViewLanguage,
  evaluateExpression,
  formatMindooDBFormulaExpression,
  parseMindooDBFormulaExpression,
} from "../core/expressions";
import type { BaseMindooDB } from "../core/BaseMindooDB";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { FilingIndex } from "../core/filing";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

interface MailDoc extends Record<string, unknown> {
  type: string;
  subject: string;
  receivedAt: number;
  isRead: boolean;
}

const v = createViewLanguage<MailDoc>();

async function createMail(db: MindooDB, subject: string, receivedAt: number, isRead = false): Promise<string> {
  const doc = await db.createDocument();
  await db.changeDoc(doc, (d) => {
    Object.assign(d.getData(), { type: "message", subject, receivedAt, isRead });
  });
  return doc.getId();
}

/** "category > subject" lines of the expanded view (documents only), in view order. */
async function rows(view: VirtualView): Promise<string[]> {
  const nav = VirtualViewFactory.createNavigator(view).build().expandAll();
  const result: string[] = [];
  for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
    if (entry.isDocument()) {
      const parent = entry.getParent();
      const category = parent && parent.getParent() ? String(parent.getCategoryValue()) : "-";
      result.push(`${category} > ${entry.getColumnValues().subject}`);
    }
  }
  return result;
}

function folderView(mailDb: MindooDB, filingDb: MindooDB, useFullDocuments = false): VirtualViewBuilder {
  return VirtualViewFactory.createView()
    .withFilingStore("mail", { db: filingDb, store: "mail" })
    .addCategoryColumn("folder", { expression: v.folders("mail") })
    .addSortedColumn("receivedAt", ColumnSorting.DESCENDING)
    .addDisplayColumn("subject")
    .addTotalColumn("unread", TotalMode.SUM, { expression: v.ifElse(v.field("isRead"), 0, 1) })
    .withDB("mail", mailDb, v.and(v.eq(v.field("type"), "message"), v.inFolder("mail")), { useFullDocuments });
}

describe.each([
  ["summary", false],
  ["documents", true],
])("filing views (%s path)", (_label, useFullDocuments) => {
  let mailDb: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-filing-views");
    mailDb = await ctx.tenant.openDB("mail");
  }, 30000);

  it("categorizes by folder, re-evaluates exactly the moved document and ignores foreign refs", async () => {
    const m1 = await createMail(mailDb, "one", 1);
    const m2 = await createMail(mailDb, "two", 2, true);
    const m3 = await createMail(mailDb, "three", 3);
    await createMail(mailDb, "unfiled", 4);
    const filing = mailDb.filing!("mail");
    await filing.add(m1, "inbox");
    await filing.add(m2, ["inbox", "projA"]);
    await filing.add(m3, "projA");
    // Refs to databases that are not part of the view are ignored.
    await filing.add("mdbref:/otherdb/doc_x", "inbox");

    const view = await folderView(mailDb, mailDb, useFullDocuments).buildAndUpdate();
    expect(view.getDataSourceInfo("mail")?.source).toBe(useFullDocuments ? "documents" : "summary");
    expect(await rows(view)).toEqual([
      "inbox > two",
      "inbox > one",
      "projA > three",
      "projA > two",
    ]);
    // Unread totals per folder come for free from the category totals.
    const inbox = view.getRoot().getChildCategories().find((c) => c.getCategoryValue() === "inbox")!;
    expect(inbox.getTotalValues()?.unread).toBe(1);
    expect(inbox.getDescendantDocumentCount()).toBe(2);

    const stats: Array<{ addedCount: number; removedCount: number }> = [];
    view.onDidUpdate((s) => stats.push(s));
    await filing.move(m1, { from: "inbox", to: "projA" });
    await view.update();
    expect(await rows(view)).toEqual([
      "inbox > two",
      "projA > three",
      "projA > two",
      "projA > one",
    ]);
    expect(stats).toEqual([{ addedCount: 1, removedCount: 0 }]);

    await filing.remove(m3);
    await view.update();
    expect(await rows(view)).toEqual(["inbox > two", "projA > two", "projA > one"]);

    // The documents themselves were never changed by filing.
    const doc = await mailDb.getDocument(m1);
    expect(doc.getData().subject).toBe("one");
  }, 60000);

  it("drops a deleted folder's rows and brings them back when it is recreated", async () => {
    const m1 = await createMail(mailDb, "one", 1);
    const filing = mailDb.filing!("mail");
    await filing.createFolder({ name: "Archive", folderId: "archive" });
    await filing.add(m1, ["archive", "inbox"]);
    const view = await folderView(mailDb, mailDb, useFullDocuments).buildAndUpdate();
    expect(await rows(view)).toEqual(["archive > one", "inbox > one"]);

    await filing.deleteFolder("archive", { keepFiling: true });
    await view.update();
    expect(await rows(view)).toEqual(["inbox > one"]);

    await filing.createFolder({ name: "Archive", folderId: "archive" });
    await view.update();
    expect(await rows(view)).toEqual(["archive > one", "inbox > one"]);
  }, 60000);

  it("keeps a separate filing database (private folders over a shared database)", async () => {
    const m1 = await createMail(mailDb, "one", 1);
    const m2 = await createMail(mailDb, "two", 2);
    const ctx2 = mailDb.getTenant();
    const privateDb = await ctx2.openDB("myfolders");
    const filing = privateDb.filing!("mail");
    await filing.add({ dbId: "mail", docId: m1 }, "mine");
    const view = await folderView(mailDb, privateDb, useFullDocuments).buildAndUpdate();
    expect(await rows(view)).toEqual(["mine > one"]);

    // Live: binding the data database also binds the filing database.
    view.bindTo(mailDb);
    await filing.add({ dbId: "mail", docId: m2 }, "mine");
    await waitFor(async () => (await rows(view)).length === 2);
    expect(await rows(view)).toEqual(["mine > two", "mine > one"]);
    view.unbind();
    // No sidecar landed in the mail database.
    expect((await mailDb.getAllDocumentIds()).some((id) => id.startsWith("fil_"))).toBe(false);
  }, 60000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("filing views across databases and tenants", () => {
  it("shows one folder with documents of two databases and of another tenant", async () => {
    const ctxA = await createWitnessingTenant("tenant-filing-a");
    const ctxB = await createWitnessingTenant("tenant-filing-b");
    const mailDb = await ctxA.tenant.openDB("mail");
    const crmDb = await ctxA.tenant.openDB("crm");
    const foreignDb = await ctxB.tenant.openDB("shared");
    const filingDb = await ctxA.tenant.openDB("folders");

    const mail = await createMail(mailDb, "mail doc", 1);
    const crm = await createMail(crmDb, "crm doc", 2);
    const foreign = await createMail(foreignDb, "foreign doc", 3);

    const filing = filingDb.filing!("project");
    await filing.add({ dbId: "mail", docId: mail }, "p1");
    await filing.add(`mdbref:/crm/${crm}`, "p1");
    await filing.add(`mdbref://tenant-filing-b/shared/${foreign}`, ["p1", "p2"]);

    const view = await VirtualViewFactory.createView()
      .withFilingStore("project", filingDb.filing!("project"))
      .addCategoryColumn("folder", { expression: v.folders("project") })
      .addSortedColumn("receivedAt", ColumnSorting.ASCENDING)
      .addDisplayColumn("subject")
      .withDB("mail", mailDb, v.inFolder("project"))
      .withDB("crm", crmDb, v.inFolder("project"))
      .withDB("foreign", foreignDb, v.inFolder("project"))
      .buildAndUpdate();
    expect(await rows(view)).toEqual([
      "p1 > mail doc",
      "p1 > crm doc",
      "p1 > foreign doc",
      "p2 > foreign doc",
    ]);
  }, 60000);

  it("rejects folder expressions in ad-hoc queries with a clear error", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-query");
    const db = await ctx.tenant.openDB("mail");
    await createMail(db, "x", 1);
    await expect(db.query!({ filter: v.inFolder("mail") })).rejects.toThrow(/withFilingStore/);
  }, 30000);

  it("rejects views that use a filing store they did not register", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-missing");
    const db = await ctx.tenant.openDB("mail");
    await expect(
      VirtualViewFactory.createView()
        .addCategoryColumn("folder", { expression: v.folders("mail") })
        .withDB("mail", db)
        .build(),
    ).rejects.toThrow(/withFilingStore\("mail"/);
  }, 30000);
});

describe("filing views: driving from the folder's members", () => {
  it("reads only the folder's members when the filter is inFolder(store, id)", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-driving");
    const db = await ctx.tenant.openDB("mail");
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(await createMail(db, `m${i}`, i));
    }
    const filing = db.filing!("mail");
    await filing.add(ids[3], "small");
    await filing.add(ids[7], "small");

    const view = await VirtualViewFactory.createView()
      .withFilingStore("mail", { db, store: "mail" })
      .addSortedColumn("receivedAt", ColumnSorting.ASCENDING)
      .addDisplayColumn("subject")
      .withDB("mail", db, v.and(v.eq(v.field("type"), "message"), v.inFolder("mail", "small")))
      .build();
    const provider = Array.from(view.getDataProviders())[0];
    expect(provider).toBeInstanceOf(SummaryVirtualViewDataProvider);
    const summary = db.getSummaryStore!();
    const scanSpy = jest.spyOn(summary, "getAllEntries");
    await view.update();
    expect(scanSpy).not.toHaveBeenCalled();
    expect(await rows(view)).toEqual(["- > m3", "- > m7"]);

    await filing.move(ids[3], { from: "small", to: "other" });
    await filing.add(ids[20], "small");
    await view.update();
    expect(await rows(view)).toEqual(["- > m7", "- > m20"]);

    // A member's own change is picked up as well.
    const doc = await db.getDocument(ids[7]);
    await db.changeDoc(doc, (d) => {
      d.getData().subject = "m7 changed";
    });
    await view.update();
    expect(await rows(view)).toEqual(["- > m7 changed", "- > m20"]);
    expect(scanSpy).not.toHaveBeenCalled();
  }, 60000);
});

describe("filing views: cache restore", () => {
  it("restores view and index from the cache and applies filing changes made in between", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-cache");
    const db = await ctx.tenant.openDB("mail");
    const m1 = await createMail(db, "one", 1);
    const m2 = await createMail(db, "two", 2);
    const m3 = await createMail(db, "three", 3);
    const filing = db.filing!("mail");
    await filing.add(m1, "inbox");
    await filing.add(m2, "inbox");

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 600000 });
    (db as unknown as BaseMindooDB).setCacheManager(cacheManager);

    const view1 = await folderView(db, db).build();
    await view1.setCacheManager(cacheManager, "mail-by-folder", "v1", { minCacheFlushIntervalMs: 0 });
    await view1.update();
    expect(await rows(view1)).toEqual(["inbox > two", "inbox > one"]);
    await cacheManager.flush();
    expect((await cacheStore.list("filing")).length).toBe(1);

    // Filing changes while the "app is closed".
    await filing.move(m1, { from: "inbox", to: "done" });
    await filing.add(m3, "inbox");

    // A fresh index restored from the cache continues from its cursor.
    const index = await filing.getIndex();
    const restoredIndex = new FilingIndex(db, "mail", index.getCachePrefix().split("/").pop()!);
    restoredIndex.attachCache(cacheManager, index.getCachePrefix());
    await restoredIndex.update();
    expect(restoredIndex.foldersOf(`${db.getTenant().getId()}/mail/${m1}`)).toEqual(["done"]);

    const view2 = await folderView(db, db).build();
    const restored = await view2.setCacheManager(cacheManager, "mail-by-folder", "v1");
    expect(restored).toBe(true);
    expect(await rows(view2)).toEqual(["inbox > two", "inbox > one"]);
    const stats: Array<{ addedCount: number; removedCount: number }> = [];
    view2.onDidUpdate((s) => stats.push(s));
    await view2.update();
    expect(await rows(view2)).toEqual(["done > one", "inbox > three", "inbox > two"]);
    // Only the two documents whose filing changed were re-evaluated.
    expect(stats).toEqual([{ addedCount: 2, removedCount: 0 }]);
    await cacheManager.dispose();
  }, 60000);
});

describe("filing expressions", () => {
  it("evaluates union and split and parses the new helpers", async () => {
    const expr = v.union(v.split(v.field("tags" as never), "|"), v.folders("mail"));
    const value = evaluateExpression(expr, {
      doc: { tags: "|acc/inbox|acc/todo|" },
      values: {},
      origin: "o",
      variables: {},
      folders: (store) => (store === "mail" ? ["fld_a", "acc/todo"] : []),
    });
    expect(value).toEqual(["acc/inbox", "acc/todo", "fld_a"]);

    const parsed = parseMindooDBFormulaExpression('v.and(v.inFolder("mail", "x"), v.exists(v.union(v.folders("mail"))))');
    expect(parsed).toEqual(
      v.and(v.inFolder("mail", "x"), v.exists(v.union(v.folders("mail")))),
    );
    expect(formatMindooDBFormulaExpression(v.inFolder("mail"))).toContain('v.inFolder("mail")');
    expect(
      evaluateExpression(v.inFolder("mail", "x"), { doc: {}, values: {}, origin: "", variables: {} }),
    ).toBe(false);
  });
});
