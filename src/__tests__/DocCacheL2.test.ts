/**
 * Phase 1 (L1/L2 doc cache split) integration tests.
 *
 * Validates the four behavioral guarantees of the L2 read path:
 *
 *  1. Fresh L2 hit (changeSeq matches) returns the persisted doc
 *     without going through full materialization.
 *  2. Stale L2 hit (changeSeq < current) applies only the missing
 *     deltas and returns an updated doc.
 *  3. L2 miss / legacy v1 record falls through to full materialization.
 *  4. Flush-before-evict: dirty docs that get evicted from L1 are
 *     persisted to L2 first, so they survive across restarts even
 *     when the in-memory cache pressure caused them to be dropped
 *     before the periodic CacheManager flush.
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
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Store factory that re-uses a single underlying store per dbId across
 * re-opens, simulating a persistent backing store.
 */
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

describe("BaseMindooDB L1/L2 document cache", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "test-l2-tenant";
  const adminPassword = "adminpw";
  const userPassword = "userpw";

  let cacheStore: InMemoryLocalCacheStore;
  let factory: BaseMindooTenantFactory;
  let tenant: MindooTenant;
  // Held only to keep references typed; the test setup pattern matches
  // DBCache.test.ts where these are stored for parity.
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

    // Replace the default 5s-interval CacheManager with a 60s one so
    // tests don't race against the auto-flush. Tests trigger flushes
    // explicitly when needed.
    await switchToManualFlushManager();
  }, 30000);

  afterEach(async () => {
    await (tenant as any).disposeCacheManager?.();
  });

  /**
   * Replace the tenant's CacheManager with one that effectively never
   * auto-flushes. Tests opt in to flushes via `cacheManager.flush()`.
   */
  async function switchToManualFlushManager(): Promise<void> {
    const t = tenant as any;
    if (t.cacheManager) {
      const oldManager = t.cacheManager as CacheManager;
      // Stop the timer without flushing pending state - we want to start
      // each test from a known clean slate.
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

  /**
   * Drop the in-memory database (and L1 doc cache) without disposing
   * the cache manager. The L2 cache store and underlying append-only
   * stores survive, simulating a process restart with whatever state
   * was previously persisted to the cache store.
   */
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

  /**
   * Read the in-memory L1 doc cache size of a freshly-opened DB.
   * Used to assert eviction behavior.
   */
  function getL1Size(db: any): number {
    return db.docCache.size as number;
  }

  /**
   * Spy on the heavy crypto path to detect when full materialization
   * runs. `applyNewEntriesToCachedDocument` is the helper invoked by
   * both the stale-L2 read path and `syncStoreChanges`. We assert call
   * counts to verify which path each test exercises.
   */
  function spyOnHeavyMaterialization(db: any): jest.SpyInstance {
    return jest.spyOn(db, "applyNewEntriesToCachedDocument");
  }

  // ---------------------------------------------------------------------------
  // Test 1: Fresh L2 hit
  // ---------------------------------------------------------------------------

  it("returns a fresh L2 hit without re-materializing the doc", async () => {
    const db = await tenant.openDB("freshhit", { documentCacheConfig: { maxEntries: 4 } });
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "Hello L2";
    });

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("freshhit", { documentCacheConfig: { maxEntries: 4 } });
    const heavySpy = spyOnHeavyMaterialization(db2);

    const reloaded = await db2.getDocument(docId);
    expect(reloaded.getData().title).toBe("Hello L2");

    // Fresh L2 hit must NOT invoke the incremental delta path.
    expect(heavySpy).not.toHaveBeenCalled();

    // The doc must now live in L1 again.
    expect((db2 as any).docCache.has(docId)).toBe(true);

    heavySpy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test 2: Stale L2 hit - applies only deltas
  // ---------------------------------------------------------------------------

  it("applies only the missing deltas on a stale L2 hit", async () => {
    const db = await tenant.openDB("stalehit", { documentCacheConfig: { maxEntries: 4 } });
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "v1";
      d.getData().counter = 1;
    });

    // Persist v1 to L2 only - the next change will update L1 + index +
    // store but leave L2 intentionally stale.
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "v2";
      d.getData().counter = 2;
    });

    // Re-flush so L2 has a v1 record AND the in-memory index reflects v2
    // after the restart pulls from the store. Without this re-flush of
    // db-meta, the restart would only see the v1 changeSeq and wouldn't
    // mark the doc as stale.
    //
    // Why we still want a stale L2 record: we manually downgrade L2 to
    // its v1-flush state below so the changeSeq sentinel is older than
    // the live index.
    const docKey = (await cm.getStore().list("doc")).find((id) => id.endsWith(`/${docId}`));
    expect(docKey).toBeTruthy();
    const v1Bytes = await cm.getStore().get("doc", docKey!);
    expect(v1Bytes).toBeTruthy();
    await cm.flush();

    simulateRestartWithoutFlush();

    // Re-write the L2 record back to its v1 contents so it carries the
    // older `changeSeq` sentinel even though the metadata checkpoint
    // (db-meta) and underlying store reflect v2.
    await cm.getStore().put("doc", docKey!, v1Bytes!);

    const db2 = await tenant.openDB("stalehit", { documentCacheConfig: { maxEntries: 4 } });

    // The DB initialization may have already touched the doc via
    // restoreFromCache + syncStoreChanges. Force an L1 miss so the next
    // getDocument has to consult L2.
    (db2 as any).docCache.delete(docId);
    (db2 as any).dirtyDocIds.delete(docId);

    const heavySpy = spyOnHeavyMaterialization(db2);

    const reloaded = await db2.getDocument(docId);
    expect(reloaded.getData().title).toBe("v2");
    expect(reloaded.getData().counter).toBe(2);

    // Stale L2 path SHOULD use the incremental helper exactly once.
    expect(heavySpy).toHaveBeenCalledTimes(1);

    // The doc must be cached in L1 with the up-to-date state and
    // marked dirty so the next flush re-anchors L2.
    expect((db2 as any).docCache.has(docId)).toBe(true);
    expect((db2 as any).dirtyDocIds.has(docId)).toBe(true);

    heavySpy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test 3: L2 miss falls through to full materialization
  // ---------------------------------------------------------------------------

  it("falls through to full materialization when there is no L2 record", async () => {
    const db = await tenant.openDB("l2miss", { documentCacheConfig: { maxEntries: 4 } });
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "no L2";
    });

    // Note: we deliberately do NOT flush - so no L2 record exists.
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("l2miss", { documentCacheConfig: { maxEntries: 4 } });

    // Spy on the L2 read path itself to confirm it returned null.
    const tryL2Spy = jest.spyOn(db2 as any, "tryLoadFromL2");

    const reloaded = await db2.getDocument(docId);
    expect(reloaded.getData().title).toBe("no L2");

    expect(tryL2Spy).toHaveBeenCalled();
    const allReturnedNull = tryL2Spy.mock.results.every(
      (result) =>
        result.type === "return" &&
        (result.value as Promise<unknown>) instanceof Promise,
    );
    // The spy wrapper returns a Promise; assert the unwrapped value.
    const resolvedValues = await Promise.all(
      tryL2Spy.mock.results.map((result) => result.value as Promise<unknown>),
    );
    expect(resolvedValues.every((value) => value === null)).toBe(true);
    expect(allReturnedNull).toBe(true);

    tryL2Spy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test 4: Flush-before-evict survival across maxEntries pressure
  // ---------------------------------------------------------------------------

  it("flushes dirty docs through L2 when L1 has to evict", async () => {
    // Tight L1 budget: only 3 docs in memory. We will create 8 dirty
    // docs without ever calling flush manually, so the only way the
    // 5+ evicted ones can survive a restart is via flush-before-evict.
    const db = await tenant.openDB("evictpressure", {
      documentCacheConfig: { maxEntries: 3 },
    });

    const docIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const d = await db.createDocument();
      const id = d.getId();
      docIds.push(id);
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
        doc.getData().payload = `value-${i}`;
      });
    }

    // L1 must have shrunk back to <= 3 (eviction kicked in).
    expect(getL1Size(db)).toBeLessThanOrEqual(3);

    // We deliberately do NOT call `cacheManager.flush()` here. The only
    // mechanism that can keep evicted docs alive is flush-before-evict.
    // After restart we should still see all 8 docs.
    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("evictpressure", {
      documentCacheConfig: { maxEntries: 3 },
    });

    for (let i = 0; i < docIds.length; i++) {
      const reloaded = await db2.getDocument(docIds[i]);
      expect(reloaded.getData().idx).toBe(i);
      expect(reloaded.getData().payload).toBe(`value-${i}`);
    }
  }, 60000);

  // ---------------------------------------------------------------------------
  // Test 5a: restoreToL2 leaves L1 empty at startup (Phase 3)
  // ---------------------------------------------------------------------------

  it("with restoreToL2=true leaves L1 empty and uses getMany", async () => {
    const db = await tenant.openDB("restoretol2", {
      documentCacheConfig: { maxEntries: 4 },
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await db.createDocument();
      ids.push(d.getId());
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    simulateRestartWithoutFlush();

    // Spy on getMany to confirm Phase 3 batched read path is used.
    const innerStore = cm.getStore();
    const getManySpy = jest.spyOn(innerStore, "getMany");

    const db2 = await tenant.openDB("restoretol2", {
      documentCacheConfig: { maxEntries: 4, restoreToL2: true },
    });

    // L1 must be empty after restore - even though L2 has records.
    expect((db2 as any).docCache.size).toBe(0);

    // restoreToL2 mode skips bulk reads since the docs aren't loaded
    // eagerly. So getMany should NOT have been called from
    // restoreFromCache during init.
    const restoreCalls = getManySpy.mock.calls.filter(
      ([type]) => type === "doc",
    );
    expect(restoreCalls.length).toBe(0);

    // Sanity-check that lazy reads still work via tryLoadFromL2.
    const reloaded = await db2.getDocument(ids[2]);
    expect(reloaded.getData().idx).toBe(2);
    expect((db2 as any).docCache.has(ids[2])).toBe(true);

    getManySpy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test 5b: default restore uses batched getMany
  // ---------------------------------------------------------------------------

  it("eager restore uses batched getMany on the cache store", async () => {
    const db = await tenant.openDB("eagerbatch", {
      documentCacheConfig: { maxEntries: 16 },
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await db.createDocument();
      ids.push(d.getId());
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    simulateRestartWithoutFlush();

    const innerStore = cm.getStore();
    const getManySpy = jest.spyOn(innerStore, "getMany");

    const db2 = await tenant.openDB("eagerbatch", {
      documentCacheConfig: { maxEntries: 16 },
    });

    const docCalls = getManySpy.mock.calls.filter(([type]) => type === "doc");
    expect(docCalls.length).toBeGreaterThan(0);

    // L1 must contain the restored docs.
    expect((db2 as any).docCache.size).toBeGreaterThanOrEqual(ids.length);

    getManySpy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test 5c: restoreBatchSize chunks the eager restore into multiple
  // getMany calls of the configured size. Bounds the transient
  // encrypted+decrypted memory peak during decryption.
  // ---------------------------------------------------------------------------

  it("eager restore honours documentCacheConfig.restoreBatchSize", async () => {
    const totalDocs = 7;
    const batchSize = 3;

    const db = await tenant.openDB("restoreBatchSize", {
      documentCacheConfig: { maxEntries: 32 },
    });
    for (let i = 0; i < totalDocs; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc: MindooDoc) => {
        doc.getData().idx = i;
      });
    }

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    simulateRestartWithoutFlush();

    const innerStore = cm.getStore();
    const getManySpy = jest.spyOn(innerStore, "getMany");

    const db2 = await tenant.openDB("restoreBatchSize", {
      documentCacheConfig: { maxEntries: 32, restoreBatchSize: batchSize },
    });

    const docCalls = getManySpy.mock.calls.filter(([type]) => type === "doc");
    expect(docCalls.length).toBe(Math.ceil(totalDocs / batchSize));
    for (const [, ids] of docCalls) {
      expect((ids as string[]).length).toBeLessThanOrEqual(batchSize);
    }

    expect((db2 as any).docCache.size).toBeGreaterThanOrEqual(totalDocs);

    getManySpy.mockRestore();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Test 6: v1 (legacy) records are skipped on restore
  // ---------------------------------------------------------------------------

  it("skips legacy v1 doc cache records on restore", async () => {
    const db = await tenant.openDB("v1skip", { documentCacheConfig: { maxEntries: 4 } });
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "with v2";
    });

    // Flush so we have a v2 record.
    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    // Forcibly downgrade the persisted doc to a v1 record by stripping
    // the version + freshness sentinels. Read the encrypted bytes,
    // decrypt+decode header, rewrite without `version`, re-encrypt+put.
    const encryptedStore = cm.getStore();
    const docKeys = await encryptedStore.list("doc");
    expect(docKeys.length).toBeGreaterThan(0);

    for (const key of docKeys) {
      const encryptedBytes = await encryptedStore.get("doc", key);
      if (!encryptedBytes) continue;

      const view = new DataView(
        encryptedBytes.buffer,
        encryptedBytes.byteOffset,
        encryptedBytes.byteLength,
      );
      const headerLen = view.getUint32(0, false);
      const headerBytes = encryptedBytes.slice(4, 4 + headerLen);
      const amBinary = encryptedBytes.slice(4 + headerLen);
      const header = JSON.parse(new TextDecoder().decode(headerBytes));

      const v1Header = JSON.stringify({
        id: header.id,
        createdAt: header.createdAt,
        lastModified: header.lastModified,
        decryptionKeyId: header.decryptionKeyId,
        isDeleted: header.isDeleted,
      });
      const v1HeaderBytes = new TextEncoder().encode(v1Header);

      const v1Value = new Uint8Array(4 + v1HeaderBytes.length + amBinary.length);
      const v1View = new DataView(v1Value.buffer);
      v1View.setUint32(0, v1HeaderBytes.length, false);
      v1Value.set(v1HeaderBytes, 4);
      v1Value.set(amBinary, 4 + v1HeaderBytes.length);

      await encryptedStore.put("doc", key, v1Value);
    }

    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("v1skip", { documentCacheConfig: { maxEntries: 4 } });

    // L1 must be empty after restore (the v1 record was skipped).
    expect((db2 as any).docCache.has(docId)).toBe(false);

    // Subsequent getDocument must still succeed by re-materializing
    // from the underlying store.
    const reloaded = await db2.getDocument(docId);
    expect(reloaded.getData().title).toBe("with v2");
  }, 30000);
});
