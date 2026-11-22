import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import type { BaseMindooTenant } from "../core/BaseMindooTenant";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import {
  StoreKind,
  type ContentAddressedStoreFactory,
  type CreateStoreResult,
  type MindooTenant,
  type OpenStoreOptions,
} from "../core/types";

const PASSWORD = "identity-pass";

/**
 * Persistent stores per database (like a device's on-disk factory), but a
 * fresh pair of in-memory stores for every ephemeral open, as Haven does for
 * a recipient's mailbox.
 */
class EphemeralAwareFactory implements ContentAddressedStoreFactory {
  readonly persistent = new IsolatedInMemoryStoreFactory();
  readonly calls: Array<{ dbId: string; ephemeral: boolean }> = [];

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    const ephemeral = options?.ephemeral === true;
    this.calls.push({ dbId, ephemeral });
    if (!ephemeral) return this.persistent.createStore(dbId, options);
    return {
      docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
      attachmentStore: new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options),
    };
  }
}

async function setup(label: string) {
  const cryptoAdapter = new NodeCryptoAdapter();
  const cacheStore = new InMemoryLocalCacheStore();
  const storeFactory = new EphemeralAwareFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter, undefined, cacheStore);
  const adminUser = await factory.createUserId(`cn=admin/o=${label}`, PASSWORD);
  const appUser = await factory.createUserId(`cn=user/o=${label}`, PASSWORD);
  await factory.ensureUserKeyPair(appUser, PASSWORD);
  const { tenant } = await factory.createTenant({
    tenantId: `${label}-${Date.now().toString(16)}`,
    adminUser,
    adminPassword: PASSWORD,
    appUser,
    // A password: the tenant persists its cache (see TenantCacheKeyGuard.test.ts).
    userPassword: PASSWORD,
  });
  return { tenant, cacheStore, storeFactory };
}

async function cacheRecordCount(cacheStore: InMemoryLocalCacheStore): Promise<number> {
  let count = 0;
  for (const type of ["db-meta", "doc", "summary", "fulltext", "vv"]) {
    count += (await cacheStore.list(type)).length;
  }
  return count;
}

async function docIds(tenant: MindooTenant, dbId: string, ephemeral: boolean): Promise<string[]> {
  const db = await tenant.openDB(dbId, ephemeral ? { ephemeral: true } : undefined);
  return (await db.getAllDocumentIds()).sort();
}

describe("ephemeral databases", () => {
  jest.setTimeout(120000);

  test("get their own stores, apart from the live database of the same id", async () => {
    const { tenant, storeFactory } = await setup("ephemeral-own");
    const live = await tenant.openDB("mailbox");
    const kept = await live.createDocument();

    const ephemeral = await tenant.openDB("mailbox", { ephemeral: true });
    expect(ephemeral).not.toBe(live);
    expect(storeFactory.calls).toContainEqual({ dbId: "mailbox", ephemeral: true });
    expect(await docIds(tenant, "mailbox", true)).toEqual([]);

    const deposited = await ephemeral.createDocument();
    expect(await docIds(tenant, "mailbox", true)).toEqual([deposited.getId()]);
    expect(await docIds(tenant, "mailbox", false)).toEqual([kept.getId()]);
    // A plain open still returns the live instance.
    expect(await tenant.openDB("mailbox")).toBe(live);
  });

  test("persist no derived cache", async () => {
    const { tenant, cacheStore } = await setup("ephemeral-cache");
    const cacheManager = (tenant as unknown as BaseMindooTenant).getCacheManager()!;
    const live = await tenant.openDB("notes");
    const note = await live.createDocument();
    await live.changeDoc(note, (d) => {
      d.getData().title = "kept in the cache";
    });
    await cacheManager.flush();
    const before = await cacheRecordCount(cacheStore);
    expect(before).toBeGreaterThan(0);

    const ephemeral = await tenant.openDB("outgoing-copy", { ephemeral: true });
    for (let i = 0; i < 3; i++) {
      const doc = await ephemeral.createDocument();
      await ephemeral.changeDoc(doc, (d) => {
        d.getData().title = `not cached ${i}`;
      });
    }
    await cacheManager.flush();
    expect(await cacheRecordCount(cacheStore)).toBe(before);
  });

  test("closeEphemeralDB drops the instance; the next open starts empty", async () => {
    const { tenant } = await setup("ephemeral-close");
    const first = await tenant.openDB("mailbox", { ephemeral: true });
    await first.createDocument();
    expect(await tenant.openDB("mailbox", { ephemeral: true })).toBe(first);

    expect(await tenant.closeEphemeralDB!("mailbox")).toBe(true);
    expect(await tenant.closeEphemeralDB!("mailbox")).toBe(false);

    const second = await tenant.openDB("mailbox", { ephemeral: true });
    expect(second).not.toBe(first);
    expect(await second.getAllDocumentIds()).toEqual([]);
  });

  test("closeEphemeralDB leaves the live database open", async () => {
    const { tenant } = await setup("ephemeral-live");
    const live = await tenant.openDB("mailbox");
    expect(await tenant.closeEphemeralDB!("mailbox")).toBe(false);
    expect(await tenant.openDB("mailbox")).toBe(live);
  });

  test("are refused for time travel and the directory", async () => {
    const { tenant } = await setup("ephemeral-refused");
    await expect(tenant.openDB("notes", { ephemeral: true, timeTravelDate: Date.now() })).rejects.toThrow(/ephemeral/);
    await expect(tenant.openDB("directory", { ephemeral: true })).rejects.toThrow(/ephemeral/);
  });
});
