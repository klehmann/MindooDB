import { BaseMindooDB } from "../core/BaseMindooDB";
import { ChangeRevisionResult, MindooDB, RevisionCursor } from "../core/types";
import { createWitnessingTenant, WitnessingTenantContext } from "./_helpers/witnessingTenant";
import { WitnessingInMemoryContentAddressedStore } from "./_helpers/witnessingStore";

/**
 * Targeted scenarios for the revision-feed layer that backs the directory
 * time-travel chain (docs/accesscontrol.md §8; plan "Correctness and tests").
 *
 * The property oracle ({@link ../core/accesscontrol/DirectoryTimeTravelIndex})
 * exhaustively covers the chain/projection. These scenarios pin down the *feed*
 * — the part the oracle does not exercise: the per-doc LRU + suffix re-fold, the
 * trusted-time fold under out-of-order witness receipts, the un-witnessed head
 * overlay and its witness re-stamp (write-back), snapshot-seeded cold starts,
 * and cursor resume == cold start.
 */

const witnessStore = (db: MindooDB): WitnessingInMemoryContentAddressedStore =>
  db.getStore() as unknown as WitnessingInMemoryContentAddressedStore;

/** A stable, order-independent fingerprint of a revision for cross-run equality. */
function fingerprint(rev: ChangeRevisionResult): string {
  return [
    rev.docId,
    rev.entryId,
    rev.trustedTime,
    rev.witnessed,
    JSON.stringify(rev.doc.getData()),
  ].join("|");
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

/** Re-iterate the whole feed with a forced LRU size, from a cold feed cache. */
async function collectWithCacheLimit(db: MindooDB, limit: number): Promise<string[]> {
  const internal = db as unknown as {
    revisionFeedCacheLimit: number;
    revisionFeedDocCache: Map<string, unknown>;
  };
  internal.revisionFeedDocCache.clear();
  internal.revisionFeedCacheLimit = limit;
  return (await collect(db)).map(fingerprint);
}

describe("directory revision feed scenarios", () => {
  let ctx: WitnessingTenantContext;

  afterEach(async () => {
    await (ctx?.tenant as unknown as { disposeCacheManager?: () => Promise<void> })?.disposeCacheManager?.();
  });

  it("LRU eviction at every size bound yields the identical revision sequence", async () => {
    ctx = await createWitnessingTenant("tt-scen-lru");
    const db = await ctx.tenant.openDB("lru-db");

    // Several docs, several in-place edits each, interleaved so eviction at a
    // tiny cache forces snapshot/genesis re-folds for the cold suffix.
    const docs = [];
    for (let d = 0; d < 4; d++) {
      const doc = await db.createDocument();
      docs.push(doc.getId());
    }
    for (let round = 0; round < 3; round++) {
      for (const id of docs) {
        const current = await db.getDocument(id);
        await db.changeDoc(current, (doc) => {
          (doc.getData() as Record<string, unknown>).round = round;
        });
      }
    }
    await db.syncStoreChanges();

    // Reference: large cache (no eviction). Then tiny caches (heavy eviction).
    const reference = await collectWithCacheLimit(db, 4096);
    expect(reference.length).toBeGreaterThanOrEqual(4 + 4 * 3);
    for (const limit of [1, 2, 3]) {
      const observed = await collectWithCacheLimit(db, limit);
      expect(observed).toEqual(reference);
    }
  }, 60000);

  it("folds a document in trusted-time order even when receipts arrive out of order", async () => {
    ctx = await createWitnessingTenant("tt-scen-ooo");
    const db = await ctx.tenant.openDB("ooo-db");
    const store = witnessStore(db);

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(await db.getDocument(docId), (d) => {
      (d.getData() as Record<string, unknown>).step = "first";
    });
    await db.changeDoc(await db.getDocument(docId), (d) => {
      (d.getData() as Record<string, unknown>).second = true;
    });
    await db.syncStoreChanges();

    const head = await db.getDocument(docId);
    const headData = JSON.stringify(head.getData());

    const baseline = await collect(db);
    const forDoc = baseline.filter((r) => r.docId === docId);
    expect(forDoc.length).toBeGreaterThanOrEqual(3);

    // Force the LAST-received change to a trusted time *earlier* than the first,
    // modeling a witness receipt that lands out of receipt order. Trusted times
    // here are small monotonic integers, so a large negative offset reorders it.
    const last = forDoc[forDoc.length - 1];
    store.forceReceivedAt(last.entryId, -1);
    (db as unknown as { revisionFeedDocCache: Map<string, unknown> }).revisionFeedDocCache.clear();

    const reordered = (await collect(db)).filter((r) => r.docId === docId);

    // The feed still emits this doc's revisions in non-decreasing trusted time.
    for (let i = 1; i < reordered.length; i++) {
      expect(reordered[i].trustedTime).toBeGreaterThanOrEqual(reordered[i - 1].trustedTime);
    }
    // Automerge merge is order-independent: the final (max trusted time) revision
    // still carries the full merge, identical to the materialized head.
    const finalRev = reordered[reordered.length - 1];
    expect(JSON.stringify(finalRev.doc.getData())).toBe(headData);
  }, 60000);

  it("treats an un-witnessed change as a head overlay, then absorbs it on witness re-stamp", async () => {
    ctx = await createWitnessingTenant("tt-scen-restamp");
    const db = await ctx.tenant.openDB("restamp-db");
    const store = witnessStore(db);

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(await db.getDocument(docId), (d) => {
      (d.getData() as Record<string, unknown>).v = "witnessed";
    });
    await db.syncStoreChanges();

    const witnessedCursor = (await collect(db)).slice(-1)[0].cursor;
    expect(witnessedCursor).not.toBeNull();
    const maxWitnessedTime = Math.max(...(await collect(db)).map((r) => r.trustedTime));

    // A local change persisted while un-witnessed (no receivedAt).
    store.witnessingEnabled = false;
    await db.changeDoc(await db.getDocument(docId), (d) => {
      (d.getData() as Record<string, unknown>).v = "local";
    });
    await db.syncStoreChanges();
    store.witnessingEnabled = true;

    const withLocal = (await collect(db)).filter((r) => r.docId === docId);
    const local = withLocal.find((r) => !r.witnessed);
    expect(local).toBeDefined();
    // Un-witnessed entries float to the provisional head (now >> small witnessed times).
    expect(local!.trustedTime).toBeGreaterThan(maxWitnessedTime);

    // Resuming from the witnessed watermark re-discovers the un-witnessed overlay
    // (the cursor never advances past an un-witnessed entry).
    const resumedBeforeWitness = await collect(db, witnessedCursor);
    expect(resumedBeforeWitness.some((r) => r.entryId === local!.entryId)).toBe(true);

    // Witness write-back: re-stamp with a real receivedAt + a fresh receiptOrder.
    const witnessTime = store.nextWitnessTime();
    store.restampWithFreshReceiptOrder(local!.entryId, witnessTime);
    (db as unknown as { revisionFeedDocCache: Map<string, unknown> }).revisionFeedDocCache.clear();

    const afterWitness = (await collect(db)).filter((r) => r.entryId === local!.entryId);
    expect(afterWitness).toHaveLength(1);
    expect(afterWitness[0].witnessed).toBe(true);
    expect(afterWitness[0].trustedTime).toBe(witnessTime);
  }, 60000);

  it("a cold reopen seeded from a snapshot reproduces the full revision sequence", async () => {
    ctx = await createWitnessingTenant("tt-scen-snap");
    const db = await ctx.tenant.openDB("snap-db", {
      snapshotConfig: { minChanges: 2, cooldownMs: 0 },
    });

    const doc = await db.createDocument();
    const docId = doc.getId();
    for (let i = 0; i < 5; i++) {
      await db.changeDoc(await db.getDocument(docId), (d) => {
        (d.getData() as Record<string, unknown>).counter = i;
      });
    }
    await db.syncStoreChanges();

    // A snapshot must have been written for the cold start to seed from.
    const entries = await db.getStore().findNewEntriesForDoc([], docId);
    expect(entries.some((e) => e.entryType === "doc_snapshot")).toBe(true);

    const warm = (await collect(db)).map(fingerprint);

    // Cold reopen: a brand-new DB handle over the same store with an empty feed
    // cache must seed per-doc state from the snapshot and reproduce the feed.
    const reopened = new BaseMindooDB(
      ctx.tenant as never,
      db.getStore(),
      db.getAttachmentStore(),
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
    );
    await reopened.initialize();
    const cold = (await collect(reopened)).map(fingerprint);

    expect(cold).toEqual(warm);
    const headData = JSON.stringify((await reopened.getDocument(docId)).getData());
    const lastWarm = (await collect(db)).slice(-1)[0];
    expect(JSON.stringify(lastWarm.doc.getData())).toBe(headData);
  }, 60000);

  it("incremental advance from a cursor does only the new work (no re-emission of the witnessed prefix)", async () => {
    ctx = await createWitnessingTenant("tt-scen-resume");
    const db = await ctx.tenant.openDB("resume-db");

    // First generation of witnessed changes.
    for (let i = 0; i < 4; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc) => {
        (doc.getData() as Record<string, unknown>).gen = 1;
      });
    }
    await db.syncStoreChanges();

    const firstPass = await collect(db);
    expect(firstPass.length).toBeGreaterThanOrEqual(4);
    // All witnessed, so the stable-prefix cursor advances over the whole batch.
    expect(firstPass.every((r) => r.witnessed)).toBe(true);
    const cursor = firstPass[firstPass.length - 1].cursor;
    expect(cursor).not.toBeNull();
    const firstIds = new Set(firstPass.map((r) => r.entryId));

    // Resuming immediately (no new work) re-discovers nothing.
    expect(await collect(db, cursor)).toEqual([]);

    // A second generation of witnessed changes lands after the watermark.
    for (let i = 0; i < 3; i++) {
      const d = await db.createDocument();
      await db.changeDoc(d, (doc) => {
        (doc.getData() as Record<string, unknown>).gen = 2;
      });
    }
    await db.syncStoreChanges();

    // The cold pass now covers both generations.
    const coldIds = new Set((await collect(db)).map((r) => r.entryId));
    const newlyAdded = new Set([...coldIds].filter((id) => !firstIds.has(id)));
    expect(newlyAdded.size).toBeGreaterThanOrEqual(3);

    // Incremental advance from the cursor yields EXACTLY the new entries — the
    // already-witnessed prefix is never re-emitted.
    const resumed = await collect(db, cursor);
    const resumedIds = resumed.map((r) => r.entryId);
    expect(new Set(resumedIds).size).toBe(resumedIds.length); // no duplicates
    expect(new Set(resumedIds)).toEqual(newlyAdded);
    expect(resumedIds.some((id) => firstIds.has(id))).toBe(false);
  }, 60000);
});
