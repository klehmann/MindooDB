/**
 * How a rejection's class decides whether the sync cursor may be held.
 *
 * Holding the cursor means re-offering the same entry on the next run. That is
 * right for exactly one kind of refusal — an author key the target has not
 * learned from `directory` yet — because it goes away on its own. For every
 * other kind, the next attempt earns the same refusal, so holding pins the
 * cursor to that entry and the pair re-scans and re-offers it on every run for
 * as long as it exists.
 *
 * The tests here are mostly about that second half: proving the sync makes
 * progress. A wrongly held cursor does not fail loudly — it keeps working,
 * just never finishing, and never reporting a clean run.
 */
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import type {
  PutRejectionClass,
  SyncScanCursorRecord,
  SyncScanCursorStore,
} from "../core/appendonlystores/types";
import {
  syncEntriesBetweenStores,
  syncScanCursorKey,
} from "../core/appendonlystores/syncStores";
import type { Logger } from "../core/logging";
import type { ContentAddressedStore, StoreEntry } from "../core/types";

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as Logger;

function createCursorStore(): SyncScanCursorStore & { size(): number } {
  const records = new Map<string, SyncScanCursorRecord>();
  return {
    get: (key) => records.get(key) ?? null,
    save: (key, record) => {
      records.set(key, record);
    },
    delete: (key) => {
      records.delete(key);
    },
    size: () => records.size,
  };
}

function createEntry(id: string): StoreEntry {
  const encryptedData = new Uint8Array([1, 2, 3]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId: "doc1",
    dependencyIds: [],
    createdAt: 1000,
    createdByPublicKey: "test-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([4, 5]),
    originalSize: encryptedData.length,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}

/**
 * A target that refuses one entry with a given class and accepts the rest,
 * recording every id it was ever offered so a re-offer is visible.
 */
function createRefusingTarget(refuseId: string, rejectionClass: PutRejectionClass) {
  const target = new InMemoryContentAddressedStore("notes", StoreKind.docs);
  const accept = target.putEntries.bind(target);
  const offered: string[] = [];

  target.putEntries = async (entries: StoreEntry[]) => {
    offered.push(...entries.map((entry) => entry.id));
    await accept(entries.filter((entry) => entry.id !== refuseId));
    return {
      receipts: [],
      rejected: entries
        .filter((entry) => entry.id === refuseId)
        .map((entry) => ({
          id: entry.id,
          reason: `refused ${entry.id}`,
          rejectionClass,
        })),
    };
  };

  return { target: target as ContentAddressedStore, offered };
}

async function createSource(ids: string[]): Promise<ContentAddressedStore> {
  const source = new InMemoryContentAddressedStore("notes", StoreKind.docs);
  await source.putEntries(ids.map(createEntry));
  return source;
}

describe("rejection class decides whether the cursor is held", () => {
  const ids = ["e1", "e2", "e3"];

  test("an untrusted key holds the cursor, because the key is expected to arrive", async () => {
    const source = await createSource(ids);
    const { target, offered } = createRefusingTarget("e2", "untrusted-key");
    const cursors = createCursorStore();

    const first = await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors,
      rejectionPolicy: "hold",
    });
    expect(first.cursorHeldForRetry).toBe(true);

    // Held means re-offered: the target gets another chance to accept it once
    // it has replicated the grant.
    const second = await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors,
      rejectionPolicy: "hold",
    });
    expect(second.cursorHeldForRetry).toBe(true);
    expect(offered.filter((id) => id === "e2").length).toBeGreaterThan(1);
  });

  test.each<PutRejectionClass>(["policy", "purged", "revoked-key", "signature"])(
    "a %s rejection does not hold the cursor",
    async (rejectionClass) => {
      const source = await createSource(ids);
      const { target } = createRefusingTarget("e2", rejectionClass);
      const cursors = createCursorStore();

      const result = await syncEntriesBetweenStores(source, target, undefined, {
        logger: silentLogger,
        cursors,
        rejectionPolicy: "hold",
      });

      expect(result.rejected).toHaveLength(1);
      expect(result.cursorHeldForRetry).not.toBe(true);
      // Everything else went across in the same run.
      expect(await target.getAllIds()).toEqual(expect.arrayContaining(["e1", "e3"]));
    },
  );

  test("a policy rejection is offered once, not on every run forever", async () => {
    // The loop this guards against: an entry whose author lost the right is
    // refused identically every time, so a held cursor would re-send it on
    // every run for as long as the entry exists.
    const source = await createSource(ids);
    const { target, offered } = createRefusingTarget("e2", "policy");
    const cursors = createCursorStore();

    for (let run = 0; run < 5; run++) {
      await syncEntriesBetweenStores(source, target, undefined, {
        logger: silentLogger,
        cursors,
        rejectionPolicy: "hold",
      });
    }

    expect(offered.filter((id) => id === "e2")).toHaveLength(1);
  });

  test("the cursor reaches the end, so an idle run scans nothing", async () => {
    // This is the cost a wrongly held cursor imposes. It does not block the
    // entries behind the refused one — those still transfer in the same run —
    // it stops the cursor from ever reaching the end. Every later sync then
    // re-scans from the pinned position instead of resuming cheaply, for as
    // long as both sides exist.
    const source = await createSource(ids);
    const { target } = createRefusingTarget("e2", "policy");
    const cursors = createCursorStore();

    const first = await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors,
      rejectionPolicy: "hold",
    });
    expect(first.scanned).toBeGreaterThan(0);

    const idle = await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors,
      rejectionPolicy: "hold",
    });
    expect(idle.scanned).toBe(0);
    expect(idle.rejected ?? []).toHaveLength(0);
  });

  test("holds at the self-resolving rejection even when a final one comes first", async () => {
    // A mixed page must not pin the cursor to the entry that will never be
    // accepted: that would re-offer the self-resolving one too, but only as a
    // side effect of a cursor that has stopped moving for good.
    const source = await createSource(["e1", "e2", "e3"]);
    const target = new InMemoryContentAddressedStore("notes", StoreKind.docs);
    const accept = target.putEntries.bind(target);
    target.putEntries = async (entries: StoreEntry[]) => {
      await accept(entries.filter((entry) => entry.id === "e3"));
      return {
        receipts: [],
        rejected: entries
          .filter((entry) => entry.id !== "e3")
          .map((entry) => ({
            id: entry.id,
            reason: `refused ${entry.id}`,
            // e1 is final, e2 can resolve.
            rejectionClass: (entry.id === "e1" ? "purged" : "untrusted-key") as PutRejectionClass,
          })),
      };
    };
    const cursors = createCursorStore();

    const result = await syncEntriesBetweenStores(
      source,
      target as ContentAddressedStore,
      undefined,
      { logger: silentLogger, cursors, rejectionPolicy: "hold" },
    );

    expect(result.cursorHeldForRetry).toBe(true);
    // The held position is behind e2, not behind e1: e1 is already accounted
    // for and re-offering it would achieve nothing.
    const record = cursors.get(syncScanCursorKey(source, target as ContentAddressedStore));
    expect(record?.cursor.id).toBe("e1");
  });

  test("gives up on a self-resolving rejection that never resolves", async () => {
    // A hold is a bet that the target will learn the author's key from
    // `directory` shortly. When the bet is wrong — a grant that was never
    // replicated, a device removed mid-flight, a forged key — nothing ends the
    // wait on its own, and the pair re-scans from the same position forever.
    const source = await createSource(ids);
    const { target, offered } = createRefusingTarget("e2", "untrusted-key");
    const cursors = createCursorStore();
    const run = () =>
      syncEntriesBetweenStores(source, target, undefined, {
        logger: silentLogger,
        cursors,
        rejectionPolicy: "hold",
        maxHoldAttempts: 3,
      });

    // Within the budget it keeps waiting, and keeps re-offering.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await run();
      expect(result.cursorHeldForRetry).toBe(true);
      expect(result.abandoned ?? []).toHaveLength(0);
    }
    expect(offered.filter((id) => id === "e2").length).toBeGreaterThan(1);

    // Then it stops waiting, reports the entry as given up on, and moves.
    const exhausted = await run();
    expect(exhausted.cursorHeldForRetry).not.toBe(true);
    expect(exhausted.abandoned?.map((entry) => entry.id)).toEqual(["e2"]);

    const afterwards = await run();
    expect(afterwards.cursorHeldForRetry).not.toBe(true);
    expect(afterwards.rejected ?? []).toHaveLength(0);
    expect(afterwards.scanned).toBe(0);
  });

  test("the retry budget restarts when the cursor waits on a different entry", async () => {
    // Otherwise a pair that hits a series of separate, genuinely transient
    // refusals would exhaust one shared budget and start discarding entries
    // that each would have been accepted on their own second attempt.
    const source = await createSource(["e1", "e2", "e3"]);
    // Both are refused at first. An entry the target once accepted is never
    // offered again, so the switch has to happen inside the refused set.
    const refused = new Set(["e1", "e2"]);
    const target = new InMemoryContentAddressedStore("notes", StoreKind.docs);
    const accept = target.putEntries.bind(target);
    target.putEntries = async (entries: StoreEntry[]) => {
      await accept(entries.filter((entry) => !refused.has(entry.id)));
      return {
        receipts: [],
        rejected: entries
          .filter((entry) => refused.has(entry.id))
          .map((entry) => ({
            id: entry.id,
            reason: `not signed by a trusted user`,
            rejectionClass: "untrusted-key" as PutRejectionClass,
          })),
      };
    };
    const cursors = createCursorStore();
    const run = () =>
      syncEntriesBetweenStores(source, target as ContentAddressedStore, undefined, {
        logger: silentLogger,
        cursors,
        rejectionPolicy: "hold",
        maxHoldAttempts: 2,
      });

    await run();
    await run();
    // The target learns e1's author, so e2 becomes the new sticking point.
    refused.delete("e1");
    const third = await run();
    expect(third.cursorHeldForRetry).toBe(true);
    expect(third.abandoned ?? []).toHaveLength(0);
    // Counting restarted: the budget belongs to the entry, not to the pair.
    const record = cursors.get(syncScanCursorKey(source, target as ContentAddressedStore));
    expect(record?.hold).toEqual({ id: "e2", attempts: 1 });
  });

  test("forgets the retry budget once the cursor moves on", async () => {
    const source = await createSource(ids);
    const { target } = createRefusingTarget("e2", "untrusted-key");
    const cursors = createCursorStore();
    const key = syncScanCursorKey(source, target);

    await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors,
      rejectionPolicy: "hold",
      maxHoldAttempts: 1,
    });
    expect(cursors.get(key)?.hold).toEqual({ id: "e2", attempts: 1 });

    // Budget spent: the entry is given up on and the persisted record must not
    // keep a stale wait around for whatever is rejected next.
    await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors,
      rejectionPolicy: "hold",
      maxHoldAttempts: 1,
    });
    expect(cursors.get(key)?.hold).toBeUndefined();
  });

  test("a client never holds, whatever the class", async () => {
    // Clients push with "advance" precisely so one refused entry cannot stall a
    // database. The class must not quietly reintroduce a hold there.
    const source = await createSource(ids);
    const { target, offered } = createRefusingTarget("e2", "untrusted-key");
    const cursors = createCursorStore();

    for (let run = 0; run < 3; run++) {
      const result = await syncEntriesBetweenStores(source, target, undefined, {
        logger: silentLogger,
        cursors,
        rejectionPolicy: "advance",
      });
      expect(result.cursorHeldForRetry).not.toBe(true);
    }

    expect(offered.filter((id) => id === "e2")).toHaveLength(1);
  });
});
