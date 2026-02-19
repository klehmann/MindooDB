import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { MindooTenant, MindooDoc, ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions } from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { CacheManager } from "../core/cache/CacheManager";

/**
 * A store factory that caches and returns the same store instance for
 * a given dbId, simulating persistent storage across re-opens.
 */
class PersistentInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    let store = this.stores.get(dbId);
    if (!store) {
      store = new InMemoryContentAddressedStore(dbId, undefined, options);
      this.stores.set(dbId, store);
    }
    return { docStore: store };
  }
}

/**
 * Integration tests that verify BaseMindooDB correctly uses the local cache:
 * - Populate a DB, flush the cache, re-open, verify cache-based restore
 * - Verify delta-only processing when new entries arrive after cache
 * - Verify that the cache is actually written (not empty)
 */
describe("BaseMindooDB cache integration", () => {
  const crypto = new NodeCryptoAdapter();

  let cacheStore: InMemoryLocalCacheStore;
  let factory: BaseMindooTenantFactory;
  let tenant: MindooTenant;

  beforeEach(async () => {
    cacheStore = new InMemoryLocalCacheStore();
    factory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
      undefined,
      cacheStore,
    );

    const result = await factory.createTenant({
      tenantId: "test-cache-tenant",
      adminName: "CN=admin/O=test",
      adminPassword: "adminpass",
      userName: "CN=user/O=test",
      userPassword: "userpass",
    });
    tenant = result.tenant;
  }, 30000);

  /**
   * Simulate an app restart: dispose the tenant's cache manager (flush + stop timer),
   * then clear the tenant's internal DB cache so openDB creates a fresh BaseMindooDB.
   */
  async function simulateRestart(): Promise<void> {
    const t = tenant as any;
    if (t.cacheManager) {
      await (t.cacheManager as CacheManager).dispose();
      const store = (t.cacheManager as CacheManager).getStore();
      t.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    }
    t.databaseCache.clear();
  }

  it("should write cache entries when a document is created and flushed", async () => {
    const db = await tenant.openDB("testdb");

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "Hello Cache";
    });

    expect(await cacheStore.list("doc")).toEqual([]);
    expect(await cacheStore.list("db-meta")).toEqual([]);

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    expect(cacheManager).toBeTruthy();
    await cacheManager.flush();

    const docIds = await cacheStore.list("doc");
    expect(docIds.length).toBeGreaterThanOrEqual(1);
    const metaIds = await cacheStore.list("db-meta");
    expect(metaIds.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("should restore a DB from cache instead of full rebuild", async () => {
    const db = await tenant.openDB("contacts");

    const doc1 = await db.createDocument();
    const doc1Id = doc1.getId();
    await db.changeDoc(doc1, (d: MindooDoc) => {
      const data = d.getData();
      data.name = "Alice";
      data.email = "alice@example.com";
    });

    const doc2 = await db.createDocument();
    const doc2Id = doc2.getId();
    await db.changeDoc(doc2, (d: MindooDoc) => {
      const data = d.getData();
      data.name = "Bob";
      data.email = "bob@example.com";
    });

    await simulateRestart();

    const getSpy = jest.spyOn(cacheStore, "get");

    const db2 = await tenant.openDB("contacts");

    expect(getSpy).toHaveBeenCalled();
    const getTypes = getSpy.mock.calls.map(([type]) => type);
    expect(getTypes).toContain("db-meta");
    expect(getTypes).toContain("doc");

    const restoredDoc1 = await db2.getDocument(doc1Id);
    expect(restoredDoc1.getData().name).toBe("Alice");
    expect(restoredDoc1.getData().email).toBe("alice@example.com");

    const restoredDoc2 = await db2.getDocument(doc2Id);
    expect(restoredDoc2.getData().name).toBe("Bob");
    expect(restoredDoc2.getData().email).toBe("bob@example.com");

    getSpy.mockRestore();
  }, 30000);

  it("should process delta entries after cache restore", async () => {
    const db1 = await tenant.openDB("contacts");

    const doc1 = await db1.createDocument();
    const doc1Id = doc1.getId();
    await db1.changeDoc(doc1, (d: MindooDoc) => {
      d.getData().name = "Charlie";
    });

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    await cacheManager.flush();

    const doc2 = await db1.createDocument();
    const doc2Id = doc2.getId();
    await db1.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().name = "Diana";
    });

    await simulateRestart();

    const db2 = await tenant.openDB("contacts");

    const restored1 = await db2.getDocument(doc1Id);
    expect(restored1.getData().name).toBe("Charlie");

    const restored2 = await db2.getDocument(doc2Id);
    expect(restored2.getData().name).toBe("Diana");
  }, 30000);

  it("should operate normally when no LocalCacheStore is provided", async () => {
    const noCacheFactory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
    );

    const result = await noCacheFactory.createTenant({
      tenantId: "plain-tenant",
      adminName: "CN=admin/O=test",
      adminPassword: "adminpw",
      userName: "CN=user/O=test",
      userPassword: "userpw",
    });

    expect((result.tenant as any).cacheManager).toBeNull();

    const db = await result.tenant.openDB("testdb");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "Works without cache";
    });

    expect(doc.getData().title).toBe("Works without cache");
  }, 30000);

  it("should update cache when documents are modified", async () => {
    const db = await tenant.openDB("mutable");

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().version = 1;
    });

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().version = 2;
    });

    await simulateRestart();

    const db2 = await tenant.openDB("mutable");
    const rd = await db2.getDocument(docId);
    expect(rd.getData().version).toBe(2);
  }, 30000);
});
