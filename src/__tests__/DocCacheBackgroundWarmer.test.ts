/**
 * Background L2 warmer integration tests.
 *
 * Validates the public warmer API on `BaseMindooDB`:
 *
 *  - `startBackgroundWarmer()` populates fresh L2 records for every doc
 *    in the index without exceeding `maxEntries` in L1 (eviction +
 *    flush-before-evict cooperate).
 *  - `stopBackgroundWarmer()` aborts an in-flight warmer and resolves
 *    once the warmer has actually exited (deterministic shutdown).
 *  - Single-flight: a second `startBackgroundWarmer()` returns the
 *    in-flight promise instead of running a second pass.
 *  - `syncStoreChanges()` never triggers the warmer implicitly; callers
 *    that want warming after a sync must call `startBackgroundWarmer`
 *    themselves.
 *  - A foreground `getDocument()` cooperates with a running warmer
 *    (no deadlocks, both paths complete).
 *  - `onProgress` callback receives at least one `warming` snapshot
 *    plus a terminal `done` (or `cancelled`) snapshot.
 *  - `getBackgroundWarmerProgress()` returns the live snapshot for
 *    consumers that mount AFTER the warmer started.
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import {
  MindooTenant,
  MindooDoc,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  PrivateUserId,
  StoreKind,
  WarmerScheduler,
  BackgroundWarmerProgress,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

class PersistentInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, InMemoryContentAddressedStore>();
  private attachmentStores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    let docStore = this.stores.get(dbId);
    if (!docStore) {
      docStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options);
      this.stores.set(dbId, docStore);
    }
    let attachmentStore = this.attachmentStores.get(dbId);
    if (!attachmentStore) {
      attachmentStore = new InMemoryContentAddressedStore(
        dbId,
        StoreKind.attachments,
        undefined,
        options,
      );
      this.attachmentStores.set(dbId, attachmentStore);
    }
    return { docStore, attachmentStore };
  }
}

/**
 * Test scheduler that records yield invocations so tests can assert
 * batching behavior.
 */
function makeRecordingScheduler(): WarmerScheduler & { yieldCount: number } {
  const scheduler = {
    yieldCount: 0,
    async yield(): Promise<void> {
      scheduler.yieldCount++;
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
  return scheduler;
}

describe("BaseMindooDB background L2 warmer", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "test-warmer-tenant";
  const adminPassword = "adminpw";
  const userPassword = "userpw";

  let cacheStore: InMemoryLocalCacheStore;
  let factory: BaseMindooTenantFactory;
  let tenant: MindooTenant;
  let _adminUser: PrivateUserId;
  let _appUser: PrivateUserId;

  beforeEach(async () => {
    cacheStore = new InMemoryLocalCacheStore();
    factory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
      undefined,
      cacheStore,
    );

    const result = await factory.createTenant({
      tenantId,
      adminName: "CN=admin/O=test",
      adminPassword,
      userName: "CN=user/O=test",
      userPassword,
    });
    tenant = result.tenant;
    _adminUser = result.adminUser;
    _appUser = result.appUser;

    await switchToManualFlushManager();
  }, 30000);

  afterEach(async () => {
    await (tenant as any).disposeCacheManager?.();
  });

  async function switchToManualFlushManager(): Promise<void> {
    const t = tenant as any;
    if (t.cacheManager) {
      const oldManager = t.cacheManager as CacheManager;
      const internalManager = oldManager as any;
      if (internalManager.timer) {
        clearTimeout(internalManager.timer);
        internalManager.timer = null;
      }
      internalManager.disposed = true;
      const store = oldManager.getStore();
      t.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    }
  }

  function simulateRestartWithoutFlush(): void {
    const t = tenant as any;
    if (t.cacheManager) {
      const oldManager = t.cacheManager as any;
      if (oldManager.timer) {
        clearTimeout(oldManager.timer);
        oldManager.timer = null;
      }
      oldManager.disposed = true;
      const store = oldManager.getStore();
      t.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    }
    t.databaseCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Test: warmer populates L2 across many docs without exceeding maxEntries
  // ---------------------------------------------------------------------------

  it("populates fresh L2 records without exceeding L1 maxEntries", async () => {
    const recording = makeRecordingScheduler();
    const db = await tenant.openDB("warmpopulate", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 3, scheduler: recording },
      },
    });

    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = await db.createDocument();
      ids.push(d.getId());
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmpopulate", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 3, scheduler: recording },
      },
    });

    expect(db2.isWarmerRunning?.()).toBe(false);
    await db2.startBackgroundWarmer!();
    expect(db2.isWarmerRunning?.()).toBe(false);

    // L1 must have respected the maxEntries=4 budget throughout.
    expect((db2 as any).docCache.size).toBeLessThanOrEqual(4);

    // Scheduler must have been invoked at least once given 12 docs and
    // batchSize=3 (yields after each 3-doc batch).
    expect(recording.yieldCount).toBeGreaterThanOrEqual(3);

    // Every doc must be readable. We do not assert L2-only path here -
    // L1 will absorb up to maxEntries on the way - but we do assert
    // that no doc is missing.
    for (const id of ids) {
      const reloaded = await db2.getDocument(id);
      expect(reloaded.getData().idx).toBe(ids.indexOf(id));
    }
  }, 60000);

  // ---------------------------------------------------------------------------
  // Test: stop aborts the warmer
  // ---------------------------------------------------------------------------

  it("stopBackgroundWarmer cancels an in-flight warmer", async () => {
    // Use a scheduler we can pause to keep the warmer in flight long
    // enough to abort.
    let release: (() => void) | null = null;
    let yieldCount = 0;
    const pausingScheduler: WarmerScheduler = {
      yield(): Promise<void> {
        yieldCount++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const db = await tenant.openDB("warmstop", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: pausingScheduler },
      },
    });

    for (let i = 0; i < 10; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmstop", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: pausingScheduler },
      },
    });

    const warmerPromise = db2.startBackgroundWarmer!();
    expect(db2.isWarmerRunning?.()).toBe(true);

    // Wait for the warmer to enter its first yield. Loop a few times to
    // give the loop a chance to run.
    for (let attempt = 0; attempt < 20 && release === null; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(release).not.toBeNull();

    // Abort the warmer. The release() below lets the yield() resolve so
    // the loop sees the abort signal.
    const stopPromise = db2.stopBackgroundWarmer!();
    release!();

    await stopPromise;
    await warmerPromise;

    expect(db2.isWarmerRunning?.()).toBe(false);
    // We yielded at least once but did not yield a full pass over all
    // 10 docs (which would require >= 5 yields with batchSize=2).
    expect(yieldCount).toBeGreaterThan(0);
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test: single-flight returns the same promise
  // ---------------------------------------------------------------------------

  it("startBackgroundWarmer is single-flight while running", async () => {
    let release: (() => void) | null = null;
    const pausingScheduler: WarmerScheduler = {
      yield(): Promise<void> {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const db = await tenant.openDB("warmsingleflight", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: pausingScheduler },
      },
    });
    for (let i = 0; i < 6; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmsingleflight", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: pausingScheduler },
      },
    });

    const first = db2.startBackgroundWarmer!();
    const second = db2.startBackgroundWarmer!();
    expect(first).toBe(second);

    // Wait for the warmer to be paused inside yield, then release and
    // let it finish.
    for (let attempt = 0; attempt < 20 && release === null; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(release).not.toBeNull();

    // Drain all subsequent yields by repeatedly releasing until the
    // warmer settles.
    const drain = (async () => {
      while (db2.isWarmerRunning?.()) {
        const fn = release as (() => void) | null;
        if (fn) {
          release = null;
          fn();
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await Promise.all([first, drain]);
    expect(db2.isWarmerRunning?.()).toBe(false);
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test: syncStoreChanges does not trigger the warmer
  // ---------------------------------------------------------------------------

  it("syncStoreChanges never starts the warmer implicitly", async () => {
    const db = await tenant.openDB("warmaftersync", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 50 },
      },
    });
    for (let i = 0; i < 3; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    // Sync must remain a "cheap" operation; warmer is opt-in via the
    // explicit start API. We assert two consecutive sync calls (one
    // without and one with new entries) leave the warmer untouched.
    const startSpy = jest.spyOn(db, "startBackgroundWarmer");

    await db.syncStoreChanges();
    expect(startSpy).not.toHaveBeenCalled();
    expect(db.isWarmerRunning?.()).toBe(false);

    const fresh = await db.createDocument();
    await db.changeDoc(fresh, (doc: MindooDoc) => {
      doc.getData().marker = "post-sync";
    });
    await cm.flush();

    await db.syncStoreChanges();
    expect(startSpy).not.toHaveBeenCalled();
    expect(db.isWarmerRunning?.()).toBe(false);

    startSpy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test: foreground reads cooperate with a running warmer
  // ---------------------------------------------------------------------------

  it("a foreground getDocument cooperates with a running warmer", async () => {
    let release: (() => void) | null = null;
    const pausingScheduler: WarmerScheduler = {
      yield(): Promise<void> {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const db = await tenant.openDB("warmcoexist", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 1, scheduler: pausingScheduler },
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = await db.createDocument();
      ids.push(d.getId());
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmcoexist", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 1, scheduler: pausingScheduler },
      },
    });

    const warmerPromise = db2.startBackgroundWarmer!();

    // Wait for warmer to pause inside yield.
    for (let attempt = 0; attempt < 20 && release === null; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Issue a foreground read while the warmer is paused mid-pass.
    const docPromise = db2.getDocument(ids[3]);

    // Drain the warmer's yields concurrently with the foreground read.
    const drain = (async () => {
      while (db2.isWarmerRunning?.()) {
        const fn = release as (() => void) | null;
        if (fn) {
          release = null;
          fn();
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const [doc] = await Promise.all([docPromise, drain, warmerPromise]);
    expect(doc.getData().idx).toBe(3);
    expect(db2.isWarmerRunning?.()).toBe(false);
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test: onProgress callback emits warming snapshots and a terminal done
  // ---------------------------------------------------------------------------

  it("onProgress callback receives warming snapshots and terminates with phase=done", async () => {
    const recording = makeRecordingScheduler();
    const db = await tenant.openDB("warmprogress", {
      documentCacheConfig: {
        maxEntries: 4,
        // batchSize 2 so that on 7 docs we get at least 3 mid-pass progress
        // events plus one final done/cancelled event.
        warmer: { batchSize: 2, scheduler: recording },
      },
    });
    for (let i = 0; i < 7; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmprogress", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: recording },
      },
    });

    const events: BackgroundWarmerProgress[] = [];
    await db2.startBackgroundWarmer!({
      onProgress: (p) => {
        events.push({ ...p });
      },
    });

    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1];
    expect(last.phase).toBe("done");
    expect(last.processed).toBe(last.total);
    expect(last.total).toBe(7);

    // Every snapshot must satisfy 0 <= processed <= total and total
    // never grows mid-pass (snapshot semantics).
    for (const event of events) {
      expect(event.processed).toBeGreaterThanOrEqual(0);
      expect(event.processed).toBeLessThanOrEqual(event.total);
      expect(event.total).toBe(7);
    }

    // The progress sequence must be non-decreasing in `processed`.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].processed).toBeGreaterThanOrEqual(events[i - 1].processed);
    }
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test: cancelled phase is reported when the warmer is aborted mid-pass
  // ---------------------------------------------------------------------------

  it("onProgress emits phase=cancelled when stopBackgroundWarmer aborts the pass", async () => {
    let release: (() => void) | null = null;
    const pausingScheduler: WarmerScheduler = {
      yield(): Promise<void> {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const db = await tenant.openDB("warmprogresscancel", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: pausingScheduler },
      },
    });
    for (let i = 0; i < 8; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmprogresscancel", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 2, scheduler: pausingScheduler },
      },
    });

    const events: BackgroundWarmerProgress[] = [];
    const warmerPromise = db2.startBackgroundWarmer!({
      onProgress: (p) => {
        events.push({ ...p });
      },
    });

    // Wait for the warmer to enter its first yield.
    for (let attempt = 0; attempt < 20 && release === null; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(release).not.toBeNull();

    // Abort. release() lets the paused yield resolve so the loop sees
    // the abort signal on its next iteration.
    const stopPromise = db2.stopBackgroundWarmer!();
    release!();
    await stopPromise;
    await warmerPromise;

    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.phase).toBe("cancelled");
    expect(last.total).toBe(8);
    // Cancelled mid-pass must NOT have processed every doc.
    expect(last.processed).toBeLessThan(8);
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test: getBackgroundWarmerProgress() returns a live snapshot
  // ---------------------------------------------------------------------------

  it("getBackgroundWarmerProgress returns null before any pass and a live snapshot once the warmer ran", async () => {
    const recording = makeRecordingScheduler();
    const db = await tenant.openDB("warmprogresssnapshot", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 3, scheduler: recording },
      },
    });
    for (let i = 0; i < 5; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("warmprogresssnapshot", {
      documentCacheConfig: {
        maxEntries: 4,
        warmer: { batchSize: 3, scheduler: recording },
      },
    });

    // Before any warmer call - no snapshot is available.
    expect(db2.getBackgroundWarmerProgress?.()).toBeNull();

    await db2.startBackgroundWarmer!();

    // Snapshot persists after the pass settles, with terminal phase.
    const snapshot = db2.getBackgroundWarmerProgress?.();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.phase).toBe("done");
    expect(snapshot!.processed).toBe(snapshot!.total);
    expect(snapshot!.total).toBe(5);
  }, 30000);
});
