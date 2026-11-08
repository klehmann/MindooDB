import type { MindooDB } from "../core/types";
import { ColumnSorting, VirtualViewFactory } from "../core/indexing/virtualviews";
import { createViewLanguage } from "../core/expressions";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

/**
 * Benchmark for incremental summary views and the view cache: run with
 * `MINDOODB_BENCH=1 npm test -- SummaryDeltaViewJournal.bench`.
 * Measures, for a summary-backed view over N documents:
 * - the view update after ONE changed document (summary scan vs delta),
 * - the view cache flush after that change (bytes and time),
 * - restoring the view from the cache.
 */
const run = process.env.MINDOODB_BENCH === "1" ? describe : describe.skip;
const N = Number(process.env.MINDOODB_BENCH_DOCS ?? 20000);

const v = createViewLanguage<{ type: string; subject: string; folder: string; receivedAt: number }>();

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

run("benchmark: summary delta + view cache journal", () => {
  it(`incremental update and cache flush over ${N} documents`, async () => {
    const ctx = await createWitnessingTenant("tenant-bench-summary-delta");
    const db: MindooDB = await ctx.tenant.openDB("bench");
    const batch = 1000;
    for (let i = 0; i < N; i += batch) {
      await db.createDocuments(
        Array.from({ length: Math.min(batch, N - i) }, (_, j) => ({
          initialValues: {
            type: "message",
            subject: `mail ${i + j}`,
            folder: `f${(i + j) % 20}`,
            receivedAt: i + j,
          },
        })),
      );
    }

    const build = () =>
      VirtualViewFactory.createView()
        .addCategoryColumn("folder")
        .addSortedColumn("receivedAt", ColumnSorting.DESCENDING)
        .addDisplayColumn("subject")
        .withDB("mail", db, v.eq(v.field("type"), "message"))
        .build();

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 3600000 });
    const view = await build();
    await view.setCacheManager(cacheManager, "bench", "v1", { minCacheFlushIntervalMs: 0 });
    let t = performance.now();
    await view.update();
    const initialMs = performance.now() - t;
    await cacheManager.flush({ force: true } as never);

    const ids = (await db.getAllDocumentIds()).slice(0, 25);
    const updateMs: number[] = [];
    const flushMs: number[] = [];
    const flushBytes: number[] = [];
    const putSpy = jest.spyOn(cacheStore, "put");
    for (const id of ids) {
      const doc = await db.getDocument(id);
      await db.changeDoc(doc, (d) => {
        d.getData().subject = `changed ${id}`;
      });
      await db.getSummaryStore!().update();
      t = performance.now();
      await view.update();
      updateMs.push(performance.now() - t);

      putSpy.mockClear();
      t = performance.now();
      await view.flushToCache(cacheStore);
      flushMs.push(performance.now() - t);
      flushBytes.push(
        putSpy.mock.calls
          .filter(([type]) => type === "vv" || type === "vvj")
          .reduce((sum, [, , bytes]) => sum + (bytes as Uint8Array).length, 0),
      );
    }
    putSpy.mockRestore();

    const view2 = await build();
    t = performance.now();
    await view2.setCacheManager(cacheManager, "bench", "v1");
    const restoreMs = performance.now() - t;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          documents: N,
          initialBuildMs: Math.round(initialMs),
          updateAfterOneChangeMedianMs: Number(median(updateMs).toFixed(2)),
          cacheFlushAfterOneChangeMedianMs: Number(median(flushMs).toFixed(2)),
          cacheFlushAfterOneChangeMedianBytes: median(flushBytes),
          restoreMs: Math.round(restoreMs),
        },
        null,
        2,
      ),
    );
    await cacheManager.dispose();
  }, 600000);
});
