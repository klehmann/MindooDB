import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { BaseMindooTenant } from "../core/BaseMindooTenant";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { KeyBag } from "../core/keys/KeyBag";
import {
  MindooDB,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { createViewLanguage } from "../core/expressions";

/**
 * A store factory that caches and returns the same store instance for a
 * given dbId, simulating persistent storage across simulated restarts.
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

const v = createViewLanguage<Record<string, unknown>>();

const CACHE_RECORD_TYPES = ["db-meta", "doc", "summary", "fulltext", "vv"] as const;

async function listIdsUnderPrefix(
  cacheStore: InMemoryLocalCacheStore,
  prefix: string,
): Promise<string[]> {
  const matches: string[] = [];
  for (const type of CACHE_RECORD_TYPES) {
    for (const id of await cacheStore.list(type)) {
      if (id === prefix || id.startsWith(`${prefix}/`)) {
        matches.push(`${type}:${id}`);
      }
    }
  }
  return matches;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Coverage for summary-first time travel (persisted snapshot caches):
 *
 * - a summary store on a time-travel instance reflects the cutoff state
 * - `db.query()` on a time-travel instance answers from the summary
 * - `persistTimeTravelCache` writes under a cutoff-scoped prefix and a
 *   re-open of the same cutoff restores from it
 * - the default (no opt-in) leaves no persisted records behind
 * - `purgeTimeTravelCache()` removes exactly the cutoff's records
 * - the open-time probe activates a setup-document-configured summary
 */
describe("Time travel summary + persisted cache", () => {
  const cryptoAdapter = new NodeCryptoAdapter();
  const tenantId = "test-tt-summary-tenant";
  const dbId = "tt-db";

  let cacheStore: InMemoryLocalCacheStore;
  let factory: BaseMindooTenantFactory;
  let tenant: BaseMindooTenant;
  let liveDb: MindooDB;

  beforeEach(async () => {
    cacheStore = new InMemoryLocalCacheStore();
    factory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      cryptoAdapter,
      undefined,
      cacheStore,
    );

    const userPassword = "userpass123";
    const user = await factory.createUserId("CN=user/O=tttest", userPassword);
    const userKeyBag = new KeyBag(
      user.userEncryptionKeyPair.privateKey,
      userPassword,
      cryptoAdapter,
    );

    const adminUserPassword = "adminpass123";
    const adminUser = await factory.createUserId("CN=admin/O=tttest", adminUserPassword);
    await userKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await userKeyBag.createTenantKey(tenantId);
    tenant = (await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      userKeyBag,
    )) as BaseMindooTenant;

    const directory = await tenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(user),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );

    liveDb = await tenant.openDB(dbId);
  }, 30000);

  afterEach(async () => {
    await tenant.disposeCacheManager?.();
  });

  /**
   * Populate the live db with two docs, capture a cutoff, then change one
   * doc and create a third afterwards. Returns the cutoff timestamp and
   * the doc ids.
   */
  async function seedDataAroundCutoff() {
    const docA = await liveDb.createDocument();
    await liveDb.changeDoc(docA, (d) => {
      d.getData().type = "task";
      d.getData().name = "Alpha";
      d.getData().amount = 1;
    });
    const docB = await liveDb.createDocument();
    await liveDb.changeDoc(docB, (d) => {
      d.getData().type = "task";
      d.getData().name = "Beta";
      d.getData().amount = 2;
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    const cutoff = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Post-cutoff changes: modify docA, create docC.
    await liveDb.changeDoc(docA, (d) => {
      d.getData().amount = 100;
    });
    const docC = await liveDb.createDocument();
    await liveDb.changeDoc(docC, (d) => {
      d.getData().type = "task";
      d.getData().name = "Gamma";
      d.getData().amount = 3;
    });

    return { cutoff, docAId: docA.getId(), docBId: docB.getId(), docCId: docC.getId() };
  }

  /**
   * Simulate an app restart: dispose the tenant's cache manager (flush +
   * stop timer), install a fresh one over the same store, and clear the
   * tenant's internal DB cache so openDB creates fresh instances.
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

  it("summary on a time-travel instance reflects the cutoff state and answers queries", async () => {
    const { cutoff, docAId, docBId, docCId } = await seedDataAroundCutoff();

    const ttDb = await tenant.openDB(dbId, { timeTravelDate: cutoff });
    expect(ttDb.isTimeTravelMode()).toBe(true);

    const summary = ttDb.getSummaryStore!();
    await summary.update();

    const entryA = summary.getEntry(docAId);
    const entryB = summary.getEntry(docBId);
    expect(entryA?.fields.amount).toBe(1); // post-cutoff change invisible
    expect(entryB?.fields.amount).toBe(2);
    expect(summary.getEntry(docCId)).toBeUndefined(); // created after cutoff

    const result = await ttDb.query!({
      filter: v.eq(v.field("type"), "task"),
      sortBy: [{ field: "amount", direction: "ascending" }],
    });
    expect(result.coverage).toBe("full");
    expect(result.rows.map((r) => r.fields.name)).toEqual(["Alpha", "Beta"]);
    expect(result.rows.map((r) => r.fields.amount)).toEqual([1, 2]);

    // The live db still sees the post-cutoff state.
    const liveSummary = liveDb.getSummaryStore!();
    await liveSummary.update();
    expect(liveSummary.getEntry(docAId)?.fields.amount).toBe(100);
    expect(liveSummary.getEntry(docCId)).toBeDefined();
  }, 30000);

  it("persistTimeTravelCache writes under a cutoff-scoped prefix and restores on re-open", async () => {
    const { cutoff, docAId } = await seedDataAroundCutoff();

    const ttDb = await tenant.openDB(dbId, {
      timeTravelDate: cutoff,
      persistTimeTravelCache: true,
    });
    const ttPrefix = (ttDb as any).getCachePrefix() as string;
    expect(ttPrefix).toContain(`/tt/${cutoff}`);

    const summary = ttDb.getSummaryStore!();
    await summary.update();
    expect(summary.getEntry(docAId)?.fields.amount).toBe(1);

    // Flush and verify the persisted records live under the cutoff prefix
    // (and never under the live prefix).
    await (tenant as any).cacheManager.flush({ force: true });
    const ttRecords = await listIdsUnderPrefix(cacheStore, ttPrefix);
    expect(ttRecords.some((id) => id.startsWith("db-meta:"))).toBe(true);
    expect(ttRecords.some((id) => id.startsWith("summary:"))).toBe(true);

    const livePrefix = (liveDb as any).getCachePrefix() as string;
    expect(ttPrefix).not.toBe(livePrefix);
    expect(ttPrefix.startsWith(`${livePrefix}/tt/`)).toBe(true);
    const liveMetaIds = (await cacheStore.list("db-meta")).filter((id) => id === livePrefix);
    expect(liveMetaIds).toHaveLength(1);

    // Re-open the same cutoff after a restart: the summary restores from
    // the persisted buckets (entries present before any changefeed run).
    await simulateRestart();
    const ttDb2 = await tenant.openDB(dbId, {
      timeTravelDate: cutoff,
      persistTimeTravelCache: true,
    });
    expect((ttDb2 as any).getCachePrefix()).toBe(ttPrefix);

    const summary2 = ttDb2.getSummaryStore!();
    await (summary2 as any).ensureRestored();
    expect(summary2.getEntry(docAId)?.fields.amount).toBe(1);

    const result = await ttDb2.query!({ filter: v.eq(v.field("type"), "task") });
    expect(result.total).toBe(2);
    expect(result.coverage).toBe("full");
  }, 30000);

  it("a time-travel open without the opt-in leaves no persisted records behind", async () => {
    const { cutoff } = await seedDataAroundCutoff();

    const ttDb = await tenant.openDB(dbId, { timeTravelDate: cutoff });
    const summary = ttDb.getSummaryStore!();
    await summary.update();
    expect(summary.getSize()).toBeGreaterThan(0);

    await (tenant as any).cacheManager.flush({ force: true });
    const ttPrefix = `${(liveDb as any).getCachePrefix()}/tt/${cutoff}`;
    expect(await listIdsUnderPrefix(cacheStore, ttPrefix)).toHaveLength(0);
  }, 30000);

  it("purgeTimeTravelCache removes exactly the cutoff's records", async () => {
    const { cutoff } = await seedDataAroundCutoff();

    // Persist two distinct cutoffs.
    const cutoff2 = cutoff + 1;
    for (const date of [cutoff, cutoff2]) {
      const ttDb = await tenant.openDB(dbId, {
        timeTravelDate: date,
        persistTimeTravelCache: true,
      });
      await ttDb.getSummaryStore!().update();
    }
    await (tenant as any).cacheManager.flush({ force: true });

    const livePrefix = (liveDb as any).getCachePrefix() as string;
    const prefix1 = `${livePrefix}/tt/${cutoff}`;
    const prefix2 = `${livePrefix}/tt/${cutoff2}`;
    expect((await listIdsUnderPrefix(cacheStore, prefix1)).length).toBeGreaterThan(0);
    expect((await listIdsUnderPrefix(cacheStore, prefix2)).length).toBeGreaterThan(0);

    await tenant.purgeTimeTravelCache(dbId, cutoff);

    // Cutoff 1 is gone, cutoff 2 and the live cache stay intact.
    expect(await listIdsUnderPrefix(cacheStore, prefix1)).toHaveLength(0);
    expect((await listIdsUnderPrefix(cacheStore, prefix2)).length).toBeGreaterThan(0);
    expect((await cacheStore.list("db-meta")).some((id) => id === livePrefix)).toBe(true);

    // The open snapshot instance was evicted: a later flush cannot
    // resurrect the purged records.
    await (tenant as any).cacheManager.flush({ force: true });
    expect(await listIdsUnderPrefix(cacheStore, prefix1)).toHaveLength(0);

    // Purging a never-persisted cutoff is a no-op (no throw).
    await tenant.purgeTimeTravelCache(dbId, cutoff + 999);
  }, 30000);

  it("listTimeTravelCacheDates enumerates the persisted cutoffs of a database", async () => {
    const { cutoff } = await seedDataAroundCutoff();

    // Nothing persisted yet.
    expect(await tenant.listTimeTravelCacheDates(dbId)).toEqual([]);

    // Persist two cutoffs; open a third WITHOUT the opt-in (must not appear).
    const cutoff2 = cutoff + 1;
    for (const date of [cutoff, cutoff2]) {
      const ttDb = await tenant.openDB(dbId, {
        timeTravelDate: date,
        persistTimeTravelCache: true,
      });
      await ttDb.getSummaryStore!().update();
    }
    const inMemoryTt = await tenant.openDB(dbId, { timeTravelDate: cutoff + 2 });
    await inMemoryTt.getSummaryStore!().update();
    await (tenant as any).cacheManager.flush({ force: true });

    expect(await tenant.listTimeTravelCacheDates(dbId)).toEqual([cutoff, cutoff2]);

    // A database without any persisted time-travel cache reports nothing.
    expect(await tenant.listTimeTravelCacheDates("other-db")).toEqual([]);

    // After purging one cutoff only the other remains.
    await tenant.purgeTimeTravelCache(dbId, cutoff);
    expect(await tenant.listTimeTravelCacheDates(dbId)).toEqual([cutoff2]);
  }, 30000);

  it("activates a setup-document-configured summary at time-travel open", async () => {
    const docA = await liveDb.createDocument();
    await liveDb.changeDoc(docA, (d) => {
      d.getData().type = "task";
      d.getData().name = "Alpha";
    });
    await liveDb.setSummarySetup!({ include: ["name"] });

    await new Promise((resolve) => setTimeout(resolve, 15));
    const cutoff = Date.now();

    const ttDb = await tenant.openDB(dbId, { timeTravelDate: cutoff });

    // The open-time probe is fire-and-forget: wait for the store to appear
    // and fill without any explicit getSummaryStore()/update() call.
    await waitFor(() => {
      const store = (ttDb as any).summaryStore;
      return store != null && store.getSize() > 0;
    });

    const summary = ttDb.getSummaryStore!();
    expect(summary.getEntry(docA.getId())?.fields.name).toBe("Alpha");
  }, 30000);
});
