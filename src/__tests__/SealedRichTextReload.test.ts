import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { CacheManager } from "../core/cache/CacheManager";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { USER_DIRECTORY_DB_ID, type MindooTenant } from "../core/types";
import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";

/**
 * A sealed document ("for people", `recipients: []` = only me) must survive
 * repeated rich-text updates that each happen in a fresh session, i.e. a
 * tenant reopened from the same stores with an empty in-memory sealed cache.
 */
describe("sealed document rich-text updates across sessions", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  /** Persistent local cache (Haven: IndexedDB) shared by all sessions. */
  const cacheStore = new InMemoryLocalCacheStore();

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-rt-reload" });
    alice = await addPerson(fixture, "alice", "laptop");
    await syncAll(fixture, "directory");
    await alice.factory.ensureUserKeyPair!(alice.user, alice.password);
    alice.tenant.noteUserDirectoryFetched!();
    await alice.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  /** New page load: new factory + tenant over the same persisted stores. */
  async function newSession(): Promise<MindooTenant> {
    const factory = new BaseMindooTenantFactory(
      alice.storeFactory,
      fixture.crypto,
      undefined,
      cacheStore,
    );
    const tenant = await factory.openTenant(
      fixture.tenantId,
      fixture.adminUser.userSigningKeyPair.publicKey,
      fixture.adminUser.userEncryptionKeyPair.publicKey,
      alice.user,
      alice.password,
      alice.keyBag,
    );
    await tenant.openDB(USER_DIRECTORY_DB_ID);
    await tenant.reconcileUserKeys!();
    return tenant;
  }

  /** End of a page load: flush the local cache like a closing tab would. */
  async function endSession(tenant: MindooTenant): Promise<void> {
    const cm = (tenant as any).cacheManager as CacheManager | null;
    if (cm) await cm.dispose();
  }

  /** Tab closed before the next periodic flush: drop pending cache state. */
  function abandonSession(tenant: MindooTenant): void {
    const cm = (tenant as any).cacheManager as any;
    if (!cm) return;
    cm.disposed = true;
    if (cm.timer !== null) clearTimeout(cm.timer);
    cm.timer = null;
  }

  const spans = [
    { type: "block", value: { type: "paragraph", attrs: {}, parents: [] } },
    { type: "text", value: "x" },
  ] as any;

  async function richTextUpdate(tenant: MindooTenant, docId: string, n: number): Promise<void> {
    const db = await tenant.openDB("probe");
    const doc = await db.getDocument(docId);
    const heads = doc.getHeads();
    await db.applyDocumentUpdate(doc, {
      set: { n },
      richText: [{ path: ["body"], baseHeads: heads, spans }],
    });
    await db.syncStoreChanges();
    const reread = await db.getDocument(docId);
    expect(reread.getData().n).toBe(n);
    await endSession(tenant);
  }

  it("stays readable after two rich-text updates in separate sessions", async () => {
    // Session 1: create sealed for me only, then a plain update.
    const s1 = await newSession();
    const db1 = await s1.openDB("probe");
    const doc = await db1.createDocument({
      recipients: [],
      initialValues: { type: "probe", n: 1 },
    });
    const docId = doc.getId();
    await db1.syncStoreChanges();
    await db1.applyDocumentUpdate(doc, { set: { n: 2 } });
    await db1.syncStoreChanges();
    await endSession(s1);

    // Session 2 and 3: the same rich-text update, each in a fresh session.
    await richTextUpdate(await newSession(), docId, 3);
    await richTextUpdate(await newSession(), docId, 3);

    // Session 4: plain read.
    const s4 = await newSession();
    const db4 = await s4.openDB("probe");
    const loaded = await db4.getDocument(docId);
    expect(loaded.getData().n).toBe(3);
    const rt = await db4.getRichTextSnapshot(loaded, ["body"]);
    expect(rt.spans.length).toBeGreaterThan(0);
  });

  it("stays readable when the next session first sees the rich-text entry in its open-time delta", async () => {
    const s1 = await newSession();
    const db1 = await s1.openDB("probe");
    const doc = await db1.createDocument({
      recipients: [],
      initialValues: { type: "probe", n: 1 },
    });
    const docId = doc.getId();
    await db1.applyDocumentUpdate(doc, { set: { n: 2 } });
    await db1.syncStoreChanges();
    await endSession(s1);

    // Session 2: the periodic cache flush ran before the edit and the tab is
    // closed before the next one, so the persisted checkpoint does not cover
    // the rich-text entry.
    const s2 = await newSession();
    const db2 = await s2.openDB("probe");
    await ((s2 as any).cacheManager as CacheManager).flush();
    const doc2 = await db2.getDocument(docId);
    await db2.applyDocumentUpdate(doc2, {
      set: { n: 3 },
      richText: [{ path: ["body"], baseHeads: doc2.getHeads(), spans }],
    });
    await db2.syncStoreChanges();
    expect((await db2.getDocument(docId)).getData().n).toBe(3);
    abandonSession(s2);

    // Session 3: warm start with an unchanged KeyBag (no visibility
    // reconcile, empty sealed cache); the open-time delta carries the
    // session-2 entry, which has no recipients block of its own.
    const s3 = await newSession();
    const db3 = await s3.openDB("probe");
    expect(await db3.getAllDocumentIds()).toContain(docId);
    const loaded = await db3.getDocument(docId);
    expect(loaded.getData().n).toBe(3);
    const rt = await db3.getRichTextSnapshot(loaded, ["body"]);
    expect(rt.spans.length).toBeGreaterThan(0);
  });
});
