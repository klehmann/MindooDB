import { MindooDB } from "../core/types";
import {
  ColumnSorting,
  MindooDBVirtualViewDataProvider,
  VirtualView,
  VirtualViewColumn,
  type VirtualViewUpdateProgress,
} from "../core/indexing/virtualviews";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

/**
 * Coverage for batched VirtualView updates: progress reporting, interruption
 * (via `onProgress` return value or `AbortSignal`), and cursor-based
 * resumption. An interrupted run must leave the view and the provider cursor
 * consistent so the next `update()` continues exactly where it stopped.
 */
describe("VirtualView update progress & interruption", () => {
  const ORIGIN = "progress-test-origin";
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-vv-progress");
    db = await ctx.tenant.openDB("vv-progress-db");
  }, 30000);

  async function createDocs(count: number, startIndex = 0): Promise<string[]> {
    const ids: string[] = [];
    for (let i = startIndex; i < startIndex + count; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        const data = d.getData();
        data.name = `doc-${String(i).padStart(3, "0")}`;
        data.index = i;
      });
      ids.push(doc.getId());
    }
    await db.syncStoreChanges();
    return ids;
  }

  function buildView(): { view: VirtualView; provider: MindooDBVirtualViewDataProvider } {
    const view = new VirtualView([VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)]);
    const provider = new MindooDBVirtualViewDataProvider({ origin: ORIGIN, db });
    provider.init(view);
    view.addDataProvider(provider);
    return { view, provider };
  }

  describe("countChangesSince", () => {
    it("counts remaining changes without iterating", async () => {
      await createDocs(7);
      expect(db.countChangesSince!(null)).toBe(7);

      // Consume 3 changes and count the rest from the resulting cursor
      let consumed = 0;
      let cursor = null as any;
      for await (const result of db.iterateChangesSince(null)) {
        cursor = result.cursor;
        if (++consumed === 3) break;
      }
      expect(db.countChangesSince!(cursor)).toBe(4);

      // At the latest cursor there is nothing left
      expect(db.countChangesSince!(db.getLatestChangeCursor!())).toBe(0);
    }, 30000);
  });

  describe("progress reporting", () => {
    it("reports batch progress with a total and a final report", async () => {
      await createDocs(25);
      const { view } = buildView();

      const reports: VirtualViewUpdateProgress[] = [];
      await view.update({
        applyBatchSize: 10,
        onProgress: (p) => {
          reports.push({ ...p });
        },
      });

      // Batch boundaries at 10 and 20, plus the final report at 25
      expect(reports.map((r) => r.processed)).toEqual([10, 20, 25]);
      for (const report of reports) {
        expect(report.total).toBe(25);
        expect(report.origin).toBe(ORIGIN);
      }
      expect(view.getRoot().getDescendantDocumentCount()).toBe(25);
    }, 30000);
  });

  describe("interruption and resumption", () => {
    it("stops after the current batch when onProgress returns false, then resumes", async () => {
      const docIds = await createDocs(25);
      const { view, provider } = buildView();

      const reports: number[] = [];
      await view.update({
        applyBatchSize: 10,
        onProgress: (p) => {
          reports.push(p.processed);
          return false; // stop after the first batch
        },
      });

      // Only the first batch was applied, and the cursor points behind it
      expect(reports).toEqual([10]);
      expect(view.getRoot().getDescendantDocumentCount()).toBe(10);
      expect(provider.getCursor()).not.toBeNull();
      expect(db.countChangesSince!(provider.getCursor())).toBe(15);

      // Resuming picks up the remaining documents without duplicating work
      const resumeReports: number[] = [];
      await view.update({
        applyBatchSize: 10,
        onProgress: (p) => {
          resumeReports.push(p.processed);
        },
      });

      expect(resumeReports).toEqual([10, 15]);
      expect(view.getRoot().getDescendantDocumentCount()).toBe(25);
      for (const docId of docIds) {
        expect(view.getEntries(ORIGIN, docId)).toHaveLength(1);
      }
    }, 30000);

    it("stops at the next batch boundary when the AbortSignal fires", async () => {
      await createDocs(25);
      const { view, provider } = buildView();

      const controller = new AbortController();
      const reports: number[] = [];
      await view.update({
        applyBatchSize: 10,
        signal: controller.signal,
        onProgress: (p) => {
          reports.push(p.processed);
          if (p.processed >= 20) {
            controller.abort();
          }
        },
      });

      expect(reports).toEqual([10, 20]);
      expect(view.getRoot().getDescendantDocumentCount()).toBe(20);

      // An already-aborted signal makes update() a no-op
      await view.update({ signal: controller.signal });
      expect(view.getRoot().getDescendantDocumentCount()).toBe(20);

      // A fresh update finishes the run from the saved cursor
      await view.update();
      expect(view.getRoot().getDescendantDocumentCount()).toBe(25);
      expect(db.countChangesSince!(provider.getCursor())).toBe(0);
    }, 30000);

    it("resumes from a cursor restored via importCacheState", async () => {
      await createDocs(12);
      const { view, provider } = buildView();

      await view.update({
        applyBatchSize: 5,
        onProgress: () => false, // stop after the first batch of 5
      });
      expect(view.getRoot().getDescendantDocumentCount()).toBe(5);

      // Simulate app restart: rebuild view + provider from the cached state
      const cacheState = provider.exportCacheState();
      const { view: view2, provider: provider2 } = buildView();
      provider2.importCacheState(cacheState);

      // Re-apply the first batch's entries as the view cache would contain
      // them; here we only verify the cursor-based resumption semantics.
      await view2.update();
      expect(db.countChangesSince!(provider2.getCursor())).toBe(0);
      // The rebuilt (empty) view received only the remaining 7 documents.
      expect(view2.getRoot().getDescendantDocumentCount()).toBe(7);
    }, 30000);
  });
});
