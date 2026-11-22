import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { CacheManager } from "../core/cache/CacheManager";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import type { MindooDB, MindooTenant } from "../core/types";
import { ColumnSorting, VirtualView, VirtualViewColumn } from "../core/indexing/virtualviews";
import { MindooDBVirtualViewDataProvider } from "../core/indexing/virtualviews/MindooDBVirtualViewDataProvider";
import { addPerson, makeTenant, syncAll, type DeviceHandle, type MultiDeviceFixture } from "./_helpers/multiDevice";

/**
 * A persisted view keeps its changefeed cursor (`changeSeq`) in a cache record
 * of its own. When the database's checkpoint is older than that cursor (the
 * process ended between the two flushes) or gone (the index is rebuilt and
 * numbered anew), new documents must still reach the view instead of getting
 * numbers at or below its cursor and being skipped.
 */
describe("changefeed cursors survive a restored or rebuilt feed", () => {
  jest.setTimeout(240000);
  let fixture: MultiDeviceFixture;
  let bob: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-view-cursor-probe" });
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
  });

  async function session(cache: InMemoryLocalCacheStore): Promise<MindooTenant> {
    const factory = new BaseMindooTenantFactory(bob.storeFactory, fixture.crypto, undefined, cache);
    return await factory.openTenant(
      fixture.tenantId,
      fixture.adminUser.userSigningKeyPair.publicKey,
      fixture.adminUser.userEncryptionKeyPair.publicKey,
      bob.user,
      bob.password,
      bob.keyBag,
    );
  }
  async function endSession(tenant: MindooTenant): Promise<void> {
    const cm = (tenant as any).cacheManager as CacheManager | null;
    if (cm) await cm.dispose();
  }
  function abandonSession(tenant: MindooTenant): void {
    const cm = (tenant as any).cacheManager as any;
    if (!cm) return;
    cm.disposed = true;
    if (cm.timer !== null) clearTimeout(cm.timer);
    cm.timer = null;
  }
  function view(db: MindooDB, state?: unknown) {
    const v = new VirtualView([VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)]);
    const p = new MindooDBVirtualViewDataProvider({ origin: "main", db, includeAllDocumentFields: true });
    v.addDataProvider(p);
    p.init(v);
    if (state) p.importCacheState(state);
    return { v, p };
  }
  async function names(db: MindooDB, state: unknown): Promise<{ names: string[]; cursor: unknown }> {
    const { v, p } = view(db, state);
    await p.update();
    const out: string[] = [];
    const walk = (node: any) => {
      for (const d of node.getChildDocuments()) out.push(String(d.getColumnValue("name")));
      for (const c of node.getChildCategories()) walk(c);
    };
    walk(v.getRoot());
    return { names: out.sort(), cursor: (p.exportCacheState() as any).cursor };
  }

  async function seed(db: MindooDB, prefix: string, count: number, edits: number) {
    for (let i = 0; i < count; i++) {
      const doc = await db.createDocument({ initialValues: { name: `${prefix}${i}` } });
      for (let e = 0; e < edits; e++) {
        await db.changeDoc(doc, (d) => {
          d.getData().edit = e;
        });
      }
    }
  }

  it("control: both caches flushed together", async () => {
    const cache = new InMemoryLocalCacheStore();
    const s1 = await session(cache);
    const db1 = await s1.openDB("okdb");
    await seed(db1, "a", 6, 3);
    const persisted = view(db1);
    await persisted.p.update();
    const viewState = persisted.p.exportCacheState();
    await endSession(s1);

    const s2 = await session(cache);
    const db2 = await s2.openDB("okdb");
    await seed(db2, "c", 3, 0);
    const after = await names(db2, viewState);
    expect(after.names).toEqual(expect.arrayContaining(["c0", "c1", "c2"]));
    await endSession(s2);
  });

  it("crash: view state written after the db checkpoint", async () => {
    const cache = new InMemoryLocalCacheStore();
    const s1 = await session(cache);
    const db1 = await s1.openDB("crashdb");
    await seed(db1, "a", 5, 0);
    await endSession(s1); // db checkpoint: a0..a4

    const s2 = await session(cache);
    const db2 = await s2.openDB("crashdb");
    await seed(db2, "b", 5, 3);
    const persisted = view(db2);
    await persisted.p.update();
    const viewState = persisted.p.exportCacheState(); // the view cache record is flushed ...
    abandonSession(s2); // ... the db checkpoint is not (tab closed / killed)

    const s3 = await session(cache);
    const db3 = await s3.openDB("crashdb");
    await seed(db3, "c", 3, 0); // new mail arrives
    const after = await names(db3, viewState);
    expect(after.names).toEqual(expect.arrayContaining(["c0", "c1", "c2"]));
    await endSession(s3);
  });

  it("db cache lost, view cache kept", async () => {
    const cache = new InMemoryLocalCacheStore();
    const s1 = await session(cache);
    const db1 = await s1.openDB("lostdb");
    await seed(db1, "a", 6, 3);
    const persisted = view(db1);
    await persisted.p.update();
    const viewState = persisted.p.exportCacheState();
    await endSession(s1);

    const s2 = await session(new InMemoryLocalCacheStore()); // db checkpoint gone: cold rebuild
    const db2 = await s2.openDB("lostdb");
    await seed(db2, "c", 3, 0);
    const after = await names(db2, viewState);
    expect(after.names).toEqual(expect.arrayContaining(["c0", "c1", "c2"]));
    await endSession(s2);
  });

  it("a view cursor written before epochs reads the feed once from the start", async () => {
    const cache = new InMemoryLocalCacheStore();
    const s1 = await session(cache);
    const db1 = await s1.openDB("legacydb");
    await seed(db1, "a", 4, 2);
    const persisted = view(db1);
    await persisted.p.update();
    const state = persisted.p.exportCacheState() as { cursor: Record<string, unknown> };
    expect(state.cursor.feedEpoch).toEqual(expect.any(String));
    delete state.cursor.feedEpoch;
    const after = await names(db1, state);
    expect(after.names).toEqual(["a0", "a1", "a2", "a3"]);
    expect((after.cursor as { feedEpoch?: string }).feedEpoch).toEqual(expect.any(String));
    await endSession(s1);
  });
});
