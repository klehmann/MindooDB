import { MindooDB, ProcessChangesCursor, StoreEntryMetadata } from "../core/types";
import {
  ColumnSorting,
  MindooDBVirtualViewDataProvider,
  VirtualView,
  VirtualViewColumn,
} from "../core/indexing/virtualviews";
import { createWitnessingTenant, WitnessingTenantContext } from "./_helpers/witnessingTenant";
import { WitnessingInMemoryContentAddressedStore } from "./_helpers/witnessingStore";

/**
 * Coverage for the per-document "awaiting witness" flag
 * (plan "Version-aware trusted time", Phase 6). A document is awaiting witness
 * iff at least one of its store entries is versioned but not yet witnessed
 * ({@link isProvisional}). The flag is built on the same predicate as the
 * version-aware trusted-time rule, so it can never diverge.
 *
 * The flag must:
 *   1. be true for a freshly-created versioned-but-un-witnessed doc, false for
 *      legacy (no entryVersion) and witnessed docs;
 *   2. clear once a witness receipt arrives — and because that receipt changes
 *      only `receivedAt` (not Automerge content), the doc must still be
 *      re-delivered on the metadata feed (the `applyNewEntriesToCachedDocument`
 *      heads-unchanged early-return fix);
 *   3. drive a VirtualView filtered on witness status: a fresh doc is dropped
 *      and re-admitted once witnessed.
 */

const witnessStore = (db: MindooDB): WitnessingInMemoryContentAddressedStore =>
  db.getStore() as unknown as WitnessingInMemoryContentAddressedStore;

/** Evict the in-memory materialized doc so the next read re-loads from the store. */
function evictDocCache(db: MindooDB, docId: string): void {
  (db as unknown as { docCache: Map<string, unknown> }).docCache.delete(docId);
}

async function createEntryForDoc(db: MindooDB, docId: string): Promise<StoreEntryMetadata> {
  const entries = await db.getStore().findNewEntriesForDoc([], docId);
  const create = entries.find((m) => m.entryType === "doc_create");
  if (!create) throw new Error(`no doc_create entry for ${docId}`);
  return create;
}

describe("awaiting-witness flag", () => {
  let ctx: WitnessingTenantContext;

  afterEach(async () => {
    await (ctx?.tenant as unknown as { disposeCacheManager?: () => Promise<void> })?.disposeCacheManager?.();
  });

  it("is true for a versioned, un-witnessed local document", async () => {
    ctx = await createWitnessingTenant("aw-versioned");
    const db = await ctx.tenant.openDB("aw-versioned-db");
    witnessStore(db).witnessingEnabled = false;

    const doc = await db.createDocument();
    expect(doc.isAwaitingWitness()).toBe(true);
    // Versioned but not yet witnessed: awaiting, not witnessed.
    expect(doc.isWitnessed()).toBe(false);

    // Survives a reload from the store (recomputed from metadata).
    await db.syncStoreChanges();
    evictDocCache(db, doc.getId());
    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded!.isAwaitingWitness()).toBe(true);
    expect(reloaded!.isWitnessed()).toBe(false);
  }, 60000);

  it("is false for a legacy (no entryVersion) un-witnessed document", async () => {
    ctx = await createWitnessingTenant("aw-legacy");
    const db = await ctx.tenant.openDB("aw-legacy-db");
    const store = witnessStore(db);
    store.witnessingEnabled = false;

    const doc = await db.createDocument();
    await db.syncStoreChanges();
    const create = await createEntryForDoc(db, doc.getId());

    // Make it legacy: pre-witness entries carry no entryVersion and are never
    // awaiting witness (already synced within the tenant, never to be witnessed).
    store.clearEntryVersion(create.id);
    evictDocCache(db, doc.getId());
    const reloaded = await db.getDocument(doc.getId());
    // Legacy (no entryVersion): neither awaiting witness nor witnessed.
    expect(reloaded!.isAwaitingWitness()).toBe(false);
    expect(reloaded!.isWitnessed()).toBe(false);
  }, 60000);

  it("is false for a witnessed document", async () => {
    ctx = await createWitnessingTenant("aw-witnessed");
    // witnessing enabled by default: every entry is stamped with a receivedAt.
    const db = await ctx.tenant.openDB("aw-witnessed-db");

    const doc = await db.createDocument();
    await db.syncStoreChanges();
    evictDocCache(db, doc.getId());
    const reloaded = await db.getDocument(doc.getId());
    // Versioned + witnessed: witnessed, no longer awaiting.
    expect(reloaded!.isAwaitingWitness()).toBe(false);
    expect(reloaded!.isWitnessed()).toBe(true);
  }, 60000);

  it("clears once a witness receipt arrives and re-delivers the doc on the metadata feed", async () => {
    ctx = await createWitnessingTenant("aw-clear");
    const db = await ctx.tenant.openDB("aw-clear-db");
    const store = witnessStore(db);
    store.witnessingEnabled = false;

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.syncStoreChanges();
    expect((await db.getDocument(docId))!.isAwaitingWitness()).toBe(true);
    expect((await db.getDocument(docId))!.isWitnessed()).toBe(false);

    // Watermark after creation (flag still set).
    const cursorAfterCreate: ProcessChangesCursor | null = db.getLatestChangeCursor?.() ?? null;

    // A trusted witness accepts the entry: re-stamp with receivedAt + a fresh
    // receiptOrder, modeling the witness write-back so the cursor scan
    // re-discovers it.
    const create = await createEntryForDoc(db, docId);
    store.restampWithFreshReceiptOrder(create.id, store.nextWitnessTime());

    await db.syncStoreChanges();

    // Flag clears and the doc is now witnessed...
    expect((await db.getDocument(docId))!.isAwaitingWitness()).toBe(false);
    expect((await db.getDocument(docId))!.isWitnessed()).toBe(true);

    // ...and the witness-status flip re-delivered the doc on the metadata feed
    // (changeSeq bumped even though the Automerge content is unchanged).
    const redelivered: string[] = [];
    for await (const change of db.iterateChangeMetadataSince(cursorAfterCreate)) {
      redelivered.push(change.docId);
    }
    expect(redelivered).toContain(docId);
  }, 60000);

  it("drives a VirtualView filtered on witness status (dropped, then re-admitted)", async () => {
    ctx = await createWitnessingTenant("aw-view");
    const db = await ctx.tenant.openDB("aw-view-db");
    const store = witnessStore(db);
    store.witnessingEnabled = false;

    const origin = "aw-view-origin";
    const view = new VirtualView([VirtualViewColumn.sorted("name", ColumnSorting.ASCENDING)]);
    const provider = new MindooDBVirtualViewDataProvider({
      origin,
      db,
      // Only surface fully-witnessed documents.
      filterFunction: (doc) => !doc.isAwaitingWitness(),
    });
    provider.init(view);

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.syncStoreChanges();

    // Awaiting witness -> excluded by the filter.
    await provider.update();
    expect(view.getEntries(origin, docId)).toHaveLength(0);

    // Witness it -> the doc is re-delivered and now passes the filter.
    const create = await createEntryForDoc(db, docId);
    store.restampWithFreshReceiptOrder(create.id, store.nextWitnessTime());
    await db.syncStoreChanges();

    await provider.update();
    expect(view.getEntries(origin, docId).length).toBeGreaterThan(0);
  }, 60000);
});
