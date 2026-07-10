import type { DbChangeEvent, MindooDB, MindooDoc } from "../core/types";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, StoreKind } from "../core/types";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import type {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
} from "../core/appendonlystores/types";
import {
  ColumnSorting,
  MindooDBVirtualViewDataProvider,
  VirtualView,
  VirtualViewColumn,
} from "../core/indexing/virtualviews";
import { createViewLanguage } from "../core/expressions";
import type { MindooQueryResult } from "../core/query/types";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

const v = createViewLanguage<Record<string, unknown>>();

/** Let the coalescing setTimeout(0) timer fire. */
async function flushChangeEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Poll until `condition` holds (or fail after `timeoutMs`). */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Coverage for the reactive layer (plan phase 6): coalesced change
 * listeners in BaseMindooDB, live VirtualViews (`bindTo`/`onDidUpdate`),
 * and live queries (`db.queryLive`) with result fingerprinting.
 */
describe("change listeners (db.addChangeListener)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-reactive");
    db = await ctx.tenant.openDB("reactive-db");
  }, 30000);

  it("notifies about local writes with docId, lastModified and cursor", async () => {
    const events: DbChangeEvent[] = [];
    const unsubscribe = db.addChangeListener!((event) => {
      events.push(event);
    });

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "Alice";
    });
    await flushChangeEvents();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const all = events.flatMap((e) => e.changes);
    const change = all.find((c) => c.docId === doc.getId());
    expect(change).toBeDefined();
    expect(change!.isDeleted).toBe(false);
    expect(change!.lastModified).toBeGreaterThan(0);
    expect(events[events.length - 1].cursor).not.toBeNull();

    unsubscribe();
  }, 30000);

  it("tags local writes with origin: \"local\"", async () => {
    const events: DbChangeEvent[] = [];
    const unsubscribe = db.addChangeListener!((event) => {
      events.push(event);
    });

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "Alice";
    });
    // Haven's write helpers follow every edit with an explicit
    // syncStoreChanges(); the user's edit must still surface as a local-origin
    // event (the trailing sync flush emits a separate ingest event we ignore).
    await db.syncStoreChanges();
    await flushChangeEvents();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.origin === "local")).toBe(true);
    const localEvent = events.find((e) => e.origin === "local");
    expect(localEvent!.changes.some((c) => c.docId === doc.getId())).toBe(true);

    unsubscribe();
  }, 30000);

  it("keeps origin: \"local\" for a change on a warm doc followed immediately by syncStoreChanges", async () => {
    // Warm up: create + first change, then let all coalescing timers fire.
    // This primes per-doc write counters so the next change completes without
    // a macrotask yield between its index update and the trailing sync —
    // exactly the Haven write-helper sequence that used to lose the race:
    // the setTimeout(0) "local" emission was suppressed by the sync's
    // notification hold and the write surfaced only as "ingest".
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().step = 1;
    });
    await db.syncStoreChanges();
    await flushChangeEvents();

    const events: DbChangeEvent[] = [];
    const unsubscribe = db.addChangeListener!((event) => {
      events.push(event);
    });

    await db.changeDoc(doc, (d) => {
      d.getData().step = 2;
    });
    await db.syncStoreChanges();
    await flushChangeEvents();

    const localEvent = events.find(
      (e) => e.origin === "local" && e.changes.some((c) => c.docId === doc.getId()),
    );
    expect(localEvent).toBeDefined();

    unsubscribe();
  }, 30000);

  it("reports deletions with isDeleted: true", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "Alice";
    });
    await flushChangeEvents();

    const events: DbChangeEvent[] = [];
    const unsubscribe = db.addChangeListener!((event) => {
      events.push(event);
    });

    await db.deleteDocument(doc.getId());
    await flushChangeEvents();

    const change = events.flatMap((e) => e.changes).find((c) => c.docId === doc.getId());
    expect(change).toBeDefined();
    expect(change!.isDeleted).toBe(true);

    unsubscribe();
  }, 30000);

  it("coalesces changes made during a notification hold into one event", async () => {
    const events: DbChangeEvent[] = [];
    const unsubscribe = db.addChangeListener!((event) => {
      events.push(event);
    });

    const internal = db as unknown as {
      beginChangeNotificationHold(): void;
      endChangeNotificationHold(): void;
    };

    internal.beginChangeNotificationHold();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        d.getData().index = i;
      });
      ids.push(doc.getId());
    }
    await flushChangeEvents();
    expect(events).toHaveLength(0); // suppressed while the hold is active

    internal.endChangeNotificationHold();
    expect(events).toHaveLength(1);
    const docIds = events[0].changes.map((c) => c.docId).sort();
    expect(docIds).toEqual([...ids].sort());

    unsubscribe();
  }, 30000);

  it("stops notifying after unsubscribe", async () => {
    const events: DbChangeEvent[] = [];
    const unsubscribe = db.addChangeListener!((event) => {
      events.push(event);
    });
    unsubscribe();

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "x";
    });
    await flushChangeEvents();

    expect(events).toHaveLength(0);
  }, 30000);

  it("isolates listener exceptions from the write path and other listeners", async () => {
    const received: DbChangeEvent[] = [];
    const unsubscribe1 = db.addChangeListener!(() => {
      throw new Error("listener boom");
    });
    const unsubscribe2 = db.addChangeListener!((event) => {
      received.push(event);
    });

    const doc = await db.createDocument();
    await expect(
      db.changeDoc(doc, (d) => {
        d.getData().name = "still works";
      })
    ).resolves.not.toThrow();
    await flushChangeEvents();

    expect(received.length).toBeGreaterThanOrEqual(1);

    unsubscribe1();
    unsubscribe2();
  }, 30000);
});

describe("one coalesced event per sync batch", () => {
  /** Store factory returning the same store instance per dbId (shared data). */
  class SharedStoreFactory implements ContentAddressedStoreFactory {
    private stores = new Map<string, InMemoryContentAddressedStore>();

    createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
      let docStore = this.stores.get(`${dbId}/docs`);
      if (!docStore) {
        docStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs);
        this.stores.set(`${dbId}/docs`, docStore);
      }
      let attachmentStore = this.stores.get(`${dbId}/attachments`);
      if (!attachmentStore) {
        attachmentStore = new InMemoryContentAddressedStore(dbId, StoreKind.attachments);
        this.stores.set(`${dbId}/attachments`, attachmentStore);
      }
      return { docStore, attachmentStore };
    }
  }

  it("emits a single event for a whole sync ingest", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const storeFactory = new SharedStoreFactory();
    const tenantId = `t-reactive-${Date.now()}`;

    // Instance 1 (writer)
    const factory1 = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
    const setup = await factory1.createTenant({
      tenantId,
      adminName: "CN=admin/O=reactive",
      adminPassword: "admin-pass",
      userName: "CN=user/O=reactive",
      userPassword: "user-pass",
    });
    const db1 = await setup.tenant.openDB("sync-db");

    // Instance 2 (reader) over the same store, same key material
    const factory2 = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
    const keyBag2 = new KeyBag(
      setup.appUser.userEncryptionKeyPair.privateKey,
      "user-pass",
      cryptoAdapter
    );
    await keyBag2.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await setup.keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!
    );
    await keyBag2.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await setup.keyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!
    );
    const tenant2 = await factory2.openTenant(
      tenantId,
      setup.adminUser.userSigningKeyPair.publicKey,
      setup.adminUser.userEncryptionKeyPair.publicKey,
      setup.appUser,
      "user-pass",
      keyBag2
    );
    const db2 = await tenant2.openDB("sync-db");

    // Register the listener BEFORE the writer produces new documents.
    const events: DbChangeEvent[] = [];
    const unsubscribe = db2.addChangeListener!((event) => {
      events.push(event);
    });

    const docCount = 5;
    for (let i = 0; i < docCount; i++) {
      const doc = await db1.createDocument();
      await db1.changeDoc(doc, (d: MindooDoc) => {
        d.getData().index = i;
      });
    }

    await db2.syncStoreChanges();
    await flushChangeEvents();

    // All ingested documents arrive as ONE coalesced event.
    expect(events).toHaveLength(1);
    expect(events[0].changes).toHaveLength(docCount);
    expect(events[0].cursor).not.toBeNull();
    // Documents received via a sync batch are tagged ingest, never local, so
    // an auto-push driver never mistakes pulled data for a user edit.
    expect(events[0].origin).toBe("ingest");

    unsubscribe();
  }, 60000);
});

describe("live views (bindTo / onDidUpdate)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-liveview");
    db = await ctx.tenant.openDB("liveview-db");
  }, 30000);

  it("updates a bound VirtualView automatically after local writes", async () => {
    const view = new VirtualView([VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)]);
    const provider = new MindooDBVirtualViewDataProvider({ origin: "live-test", db });
    provider.init(view);
    view.addDataProvider(provider);

    const updates: Array<{ addedCount: number; removedCount: number }> = [];
    const offUpdate = view.onDidUpdate((stats) => {
      updates.push(stats);
    });

    const unbind = view.bindTo(db);

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "Alice";
    });

    await waitFor(() => view.getRoot().getDescendantDocumentCount() === 1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.some((u) => u.addedCount > 0)).toBe(true);

    // Deletion propagates too
    await db.deleteDocument(doc.getId());
    await waitFor(() => view.getRoot().getDescendantDocumentCount() === 0);

    unbind();
    offUpdate();

    // After unbind, further writes no longer reach the view
    const doc2 = await db.createDocument();
    await db.changeDoc(doc2, (d) => {
      d.getData().name = "Bob";
    });
    await flushChangeEvents();
    await flushChangeEvents();
    expect(view.getRoot().getDescendantDocumentCount()).toBe(0);
  }, 30000);

  it("keeps ephemeral summary views live via bindTo", async () => {
    const view = await db.queryView!({
      columns: [VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)],
    });
    view.bindTo();

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().name = "Carol";
    });

    await waitFor(() => view.getView().getRoot().getDescendantDocumentCount() === 1);
    view.dispose();
  }, 30000);
});

describe("live queries (db.queryLive)", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-livequery");
    db = await ctx.tenant.openDB("livequery-db");
  }, 30000);

  async function createDoc(data: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
    return doc.getId();
  }

  it("delivers the initial result and re-fires only on actual result changes", async () => {
    const taskId = await createDoc({ type: "task", name: "Alpha" });
    const noteId = await createDoc({ type: "note", name: "Beta" });

    const results: MindooQueryResult[] = [];
    const subscription = db.queryLive!(
      { filter: v.eq(v.field("type"), "task") },
      (result) => {
        results.push(result);
      }
    );

    await waitFor(() => results.length === 1);
    expect(results[0].total).toBe(1);
    expect(results[0].rows[0].docId).toBe(taskId);

    // Irrelevant change (non-matching doc): scan runs, but no callback
    const noteDoc = await db.getDocument(noteId);
    await db.changeDoc(noteDoc, (d) => {
      d.getData().name = "Beta 2";
    });
    await flushChangeEvents();
    await flushChangeEvents();
    expect(results).toHaveLength(1);

    // Relevant change (new match): callback fires with the new result
    await createDoc({ type: "task", name: "Gamma" });
    await waitFor(() => results.length === 2);
    expect(results[1].total).toBe(2);

    // Content change of an existing match bumps lastModified → new fingerprint
    const taskDoc = await db.getDocument(taskId);
    await db.changeDoc(taskDoc, (d) => {
      d.getData().name = "Alpha 2";
    });
    await waitFor(() => results.length === 3);

    subscription.unsubscribe();
  }, 30000);

  it("stops after unsubscribe and supports forced refresh", async () => {
    await createDoc({ type: "task", name: "Alpha" });

    const results: MindooQueryResult[] = [];
    const subscription = db.queryLive!(
      { filter: v.eq(v.field("type"), "task") },
      (result) => {
        results.push(result);
      }
    );
    await waitFor(() => results.length === 1);

    // refresh() re-delivers even without a change
    await subscription.refresh();
    expect(results.length).toBe(2);

    subscription.unsubscribe();
    await createDoc({ type: "task", name: "Beta" });
    await flushChangeEvents();
    await flushChangeEvents();
    expect(results.length).toBe(2);
  }, 30000);

  it("reports evaluation errors through onError", async () => {
    db.getSummaryStore!({ exclude: ["secret"] });

    const errors: unknown[] = [];
    const subscription = db.queryLive!(
      { filter: v.eq(v.field("secret"), "x") },
      () => {
        throw new Error("should never deliver a result");
      },
      {
        onError: (error) => {
          errors.push(error);
        },
      }
    );

    await waitFor(() => errors.length === 1);
    expect(String(errors[0])).toMatch(/secret/);
    subscription.unsubscribe();
  }, 30000);
});
