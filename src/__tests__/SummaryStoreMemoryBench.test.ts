/**
 * Opt-in benchmark: heap retained by a DocumentSummaryStore.
 *
 * Builds the summary of N mail-like documents (atomic strings) once from
 * the documents (cold) and once restored from its cache (warm) and reports
 * the heap the store retains: measured as the heap that becomes free when
 * the store is released, so documents, caches and the database's own index
 * do not count. Needs `--expose-gc`:
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npm test -- SummaryStoreMemoryBench
 *
 * BENCH_DOCS (default 10000) picks the number of documents.
 */
import { DocumentSummaryStore } from "../core/indexing/summary/DocumentSummaryStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { MindooValue } from "../core/values";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

const RUN = process.env.BENCH === "1";
const DOCS = Number(process.env.BENCH_DOCS ?? 10000);
const gc = (globalThis as unknown as { gc?: () => void }).gc;

function heapUsed(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}

function textGenerator(seed: number): (length: number) => string {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "abcdefghijklmnopqrstuvwxyz ";
  return (length) => {
    const chars: string[] = new Array(length);
    for (let i = 0; i < length; i++) chars[i] = alphabet[Math.floor(next() * alphabet.length)];
    return chars.join("");
  };
}

const FOLDERS = ["Inbox", "Archive", "Sent", "Projects", "Customers", "Invoices", "Newsletter", "Team", "Travel", "Private"];

(RUN ? describe : describe.skip)("DocumentSummaryStore memory benchmark", () => {
  it("reports heap per summary entry", async () => {
    if (!gc) {
      console.warn("Run with NODE_OPTIONS=--expose-gc for stable numbers.");
    }
    const ctx = await createWitnessingTenant("tenant-summary-memory");
    const db = await ctx.tenant.openDB("mail", { autoIndexing: false } as never);
    const text = textGenerator(42);
    const a = (value: string) => MindooValue.atomic(value);
    for (let start = 0; start < DOCS; start += 500) {
      await db.createDocuments(
        Array.from({ length: Math.min(500, DOCS - start) }, (_, k) => {
          const i = start + k;
          return {
            initialValues: {
              type: a("message"),
              subject: a(text(50)),
              from: a(`${text(14)} <sender${i % 500}@example.com>`),
              to: a("me@example.com"),
              receivedAt: a(new Date(Date.UTC(2024, 0, 1) + i * 600_000).toISOString()),
              folder: a(FOLDERS[i % FOLDERS.length]),
              isRead: i % 4 !== 0,
              size: 2000 + (i % 7000),
              preview: a(text(140)),
              body: a(text(1500)),
            },
          };
        }),
      );
    }

    const cacheStore = new InMemoryLocalCacheStore();
    const cacheManager = new CacheManager(cacheStore, { flushIntervalMs: 600_000 });

    // Cold: built from the documents.
    let cold: DocumentSummaryStore | null = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    cold.attachCache(cacheManager, "bench-summary");
    let started = performance.now();
    await cold.update();
    const coldMs = performance.now() - started;
    await cold.flushToCache(cacheStore, { force: true });
    expect(cold.getSize()).toBe(DOCS);
    const withCold = heapUsed();
    await cacheManager.deregister(cold);
    cold = null;
    const coldBytes = withCold - heapUsed();

    // Warm: restored from the snapshot.
    let warm: DocumentSummaryStore | null = new DocumentSummaryStore(db, undefined, { minFlushIntervalDuringUpdateMs: 0 });
    warm.attachCache(cacheManager, "bench-summary");
    started = performance.now();
    await warm.update();
    const warmMs = performance.now() - started;
    expect(warm.getSize()).toBe(DOCS);
    const withWarm = heapUsed();
    await cacheManager.deregister(warm);
    warm = null;
    const warmBytes = withWarm - heapUsed();

    let snapshotBytes = 0;
    for (const id of await cacheStore.list("summary")) {
      snapshotBytes += (await cacheStore.get("summary", id))!.length;
    }
    console.log(
      [
        `summary store, ${DOCS} mails:`,
        `cold (from documents): ${(coldBytes / 1048576).toFixed(1)} MB, ${Math.round(coldBytes / DOCS)} B/doc, update ${coldMs.toFixed(0)} ms`,
        `warm (from cache):     ${(warmBytes / 1048576).toFixed(1)} MB, ${Math.round(warmBytes / DOCS)} B/doc, restore ${warmMs.toFixed(0)} ms`,
        `snapshot: ${(snapshotBytes / 1048576).toFixed(1)} MB`,
      ].join("\n"),
    );
    await cacheManager.dispose();
  }, 600_000);
});
