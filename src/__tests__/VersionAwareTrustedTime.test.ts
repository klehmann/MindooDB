import {
  ChangeRevisionResult,
  MindooDB,
  RevisionCursor,
  StoreEntryMetadata,
} from "../core/types";
import { createWitnessingTenant, WitnessingTenantContext } from "./_helpers/witnessingTenant";
import { WitnessingInMemoryContentAddressedStore } from "./_helpers/witnessingStore";

/**
 * Feed-level coverage for the version-aware trusted-time rule
 * (docs/accesscontrol.md §8; plan "Version-aware trusted time"). The directory
 * time-travel chain consumes `iterateChangeRevisionsSince` verbatim, so pinning
 * the feed's `trustedTime` pins what the chain (and access-control judgment)
 * sees:
 *
 *   - witnessed             -> receivedAt
 *   - versioned + un-witnessed (provisional) -> now (floats to head)
 *   - legacy + un-witnessed -> its stable createdAt
 *
 * It also covers the resume-cursor gate change: legacy un-witnessed entries are
 * STABLE and must let the cursor advance, while versioned un-witnessed entries
 * are provisional and must park the cursor before them.
 */

const witnessStore = (db: MindooDB): WitnessingInMemoryContentAddressedStore =>
  db.getStore() as unknown as WitnessingInMemoryContentAddressedStore;

function clearFeedCache(db: MindooDB): void {
  (db as unknown as { revisionFeedDocCache: Map<string, unknown> }).revisionFeedDocCache.clear();
}

async function collect(
  db: MindooDB,
  cursor: RevisionCursor | null = null,
): Promise<ChangeRevisionResult[]> {
  const out: ChangeRevisionResult[] = [];
  for await (const rev of db.iterateChangeRevisionsSince(cursor)) {
    out.push(rev);
  }
  return out;
}

async function entriesForDoc(db: MindooDB, docId: string): Promise<StoreEntryMetadata[]> {
  return db.getStore().findNewEntriesForDoc([], docId);
}

describe("version-aware trusted time (revision feed)", () => {
  let ctx: WitnessingTenantContext;

  afterEach(async () => {
    await (ctx?.tenant as unknown as { disposeCacheManager?: () => Promise<void> })?.disposeCacheManager?.();
  });

  it("a legacy (no entryVersion) un-witnessed entry takes its stable createdAt", async () => {
    ctx = await createWitnessingTenant("vatt-legacy");
    const db = await ctx.tenant.openDB("legacy-db");
    const store = witnessStore(db);

    store.witnessingEnabled = false;
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.syncStoreChanges();

    const create = (await entriesForDoc(db, docId)).find((m) => m.entryType === "doc_create")!;
    expect(create).toBeDefined();
    // Make it legacy: strip the version it was written with.
    store.clearEntryVersion(create.id);
    clearFeedCache(db);

    const rev = (await collect(db)).find((r) => r.entryId === create.id)!;
    expect(rev).toBeDefined();
    expect(rev.witnessed).toBe(false);
    expect(rev.trustedTime).toBe(create.createdAt);
  }, 60000);

  it("a versioned un-witnessed entry floats to the provisional head (now)", async () => {
    ctx = await createWitnessingTenant("vatt-versioned");
    const db = await ctx.tenant.openDB("versioned-db");
    const store = witnessStore(db);

    store.witnessingEnabled = false;
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.syncStoreChanges();

    const create = (await entriesForDoc(db, docId)).find((m) => m.entryType === "doc_create")!;
    // SDK writes entryVersion on creation, so this is a versioned entry; do NOT strip it.
    expect(create.entryVersion).toBeDefined();
    clearFeedCache(db);

    const before = Date.now();
    const rev = (await collect(db)).find((r) => r.entryId === create.id)!;
    const after = Date.now();

    expect(rev.witnessed).toBe(false);
    // Trusted time is the wall-clock now at feed time, strictly later than the
    // (earlier) createdAt of the persisted entry.
    expect(rev.trustedTime).toBeGreaterThanOrEqual(before);
    expect(rev.trustedTime).toBeLessThanOrEqual(after);
    expect(rev.trustedTime).toBeGreaterThanOrEqual(create.createdAt);
  }, 60000);

  it("orders a legacy un-witnessed create before a later witnessed edit", async () => {
    ctx = await createWitnessingTenant("vatt-mixed");
    const db = await ctx.tenant.openDB("mixed-db");
    const store = witnessStore(db);

    store.witnessingEnabled = false;
    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(await db.getDocument(docId), (d) => {
      (d.getData() as Record<string, unknown>).edited = true;
    });
    await db.syncStoreChanges();

    const metas = await entriesForDoc(db, docId);
    const create = metas.find((m) => m.entryType === "doc_create")!;
    const edit = metas.find((m) => m.entryType === "doc_change")!;
    expect(create).toBeDefined();
    expect(edit).toBeDefined();

    // Legacy create stays at its createdAt; the edit is witnessed at a time
    // AFTER that, modeling a later trusted acceptance.
    store.clearEntryVersion(create.id);
    const editTime = create.createdAt + 60_000;
    store.forceReceivedAt(edit.id, editTime);
    clearFeedCache(db);

    const revs = (await collect(db)).filter((r) => r.docId === docId);
    // Non-decreasing trusted time across the doc's revisions.
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i].trustedTime).toBeGreaterThanOrEqual(revs[i - 1].trustedTime);
    }
    const createRev = revs.find((r) => r.entryId === create.id)!;
    const editRev = revs.find((r) => r.entryId === edit.id)!;
    expect(createRev.trustedTime).toBe(create.createdAt);
    expect(editRev.trustedTime).toBe(editTime);
    expect(revs.indexOf(createRev)).toBeLessThan(revs.indexOf(editRev));
  }, 60000);

  it("lets the resume cursor advance past legacy un-witnessed entries but parks before versioned ones", async () => {
    ctx = await createWitnessingTenant("vatt-cursor");
    const db = await ctx.tenant.openDB("cursor-db");
    const store = witnessStore(db);

    // A legacy un-witnessed doc: stable, so the cursor may advance over it.
    store.witnessingEnabled = false;
    const legacyDoc = await db.createDocument();
    await db.syncStoreChanges();
    const legacyCreate = (await entriesForDoc(db, legacyDoc.getId())).find(
      (m) => m.entryType === "doc_create",
    )!;
    store.clearEntryVersion(legacyCreate.id);
    clearFeedCache(db);

    const firstPass = await collect(db);
    const legacyRev = firstPass.find((r) => r.entryId === legacyCreate.id)!;
    expect(legacyRev.witnessed).toBe(false);
    // The cursor advanced through the stable legacy entry (it is not provisional).
    const stableCursor = firstPass[firstPass.length - 1].cursor;
    expect(stableCursor).not.toBeNull();

    // Resuming from that watermark re-discovers nothing: legacy un-witnessed
    // entries no longer force a perpetual re-scan.
    expect(await collect(db, stableCursor)).toEqual([]);

    // Now add a versioned un-witnessed doc (provisional): the cursor must park
    // before it, so resuming from the legacy watermark re-discovers it.
    const versionedDoc = await db.createDocument();
    await db.syncStoreChanges();
    clearFeedCache(db);

    const resumed = await collect(db, stableCursor);
    const versionedRev = resumed.find((r) => r.docId === versionedDoc.getId());
    expect(versionedRev).toBeDefined();
    expect(versionedRev!.witnessed).toBe(false);
  }, 60000);
});
