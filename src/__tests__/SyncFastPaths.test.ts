/**
 * Fast paths of the store-to-store sync for fresh replicas.
 *
 * A first sync is mostly empty stores: pushing from a replica that has
 * nothing yet, pulling an attachment store nobody wrote to, filling a target
 * that holds nothing. None of these should cost a request on the other side
 * beyond what the transfer itself needs, and the local processing of a page
 * should not hold up the transfer of the next one.
 */
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import {
  syncEntriesBetweenStores,
  type SyncScanCursorRecord,
  type SyncScanCursorStore,
} from "../core/appendonlystores/syncStores";
import type { Logger } from "../core/logging";
import type { StoreEntry } from "../core/types";

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as Logger;

function createCursorStore(): SyncScanCursorStore {
  const records = new Map<string, SyncScanCursorRecord>();
  return {
    get: (key) => records.get(key) ?? null,
    save: (key, record) => {
      records.set(key, record);
    },
    delete: (key) => {
      records.delete(key);
    },
  };
}

function createEntry(id: string): StoreEntry {
  const encryptedData = new Uint8Array([1, 2, 3]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId: `doc-${id}`,
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

async function createStore(ids: string[]): Promise<InMemoryContentAddressedStore> {
  const store = new InMemoryContentAddressedStore("notes", StoreKind.docs);
  if (ids.length > 0) {
    await store.putEntries(ids.map(createEntry));
  }
  return store;
}

/** Record which methods of a store the sync called. */
function spyOnStore(store: InMemoryContentAddressedStore): string[] {
  const calls: string[] = [];
  for (const method of [
    "getStoreHead",
    "getIdBloomSummary",
    "scanEntriesSince",
    "hasEntries",
    "getEntries",
    "putEntries",
  ] as const) {
    const original = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
    (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      calls.push(method);
      return original(...args);
    };
  }
  return calls;
}

describe("sync fast paths for fresh replicas", () => {
  test("an empty source ends the sync before touching the target", async () => {
    const source = await createStore([]);
    const target = await createStore(["t1"]);
    const sourceCalls = spyOnStore(source);
    const targetCalls = spyOnStore(target);

    const result = await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors: createCursorStore(),
    });

    expect(result).toMatchObject({ transferred: 0, scanned: 0, cancelled: false });
    expect(sourceCalls).toEqual(["getStoreHead"]);
    expect(targetCalls).toEqual([]);
  });

  test("an empty target is filled without bloom or existence checks", async () => {
    const ids = ["e1", "e2", "e3", "e4", "e5"];
    const source = await createStore(ids);
    const target = await createStore([]);
    const sourceCalls = spyOnStore(source);
    const targetCalls = spyOnStore(target);

    const result = await syncEntriesBetweenStores(source, target, { pageSize: 2 }, {
      logger: silentLogger,
      cursors: createCursorStore(),
    });

    expect(result.transferred).toBe(ids.length);
    expect((await target.getAllIds()).sort()).toEqual(ids);
    expect(targetCalls).not.toContain("hasEntries");
    expect(targetCalls).not.toContain("getIdBloomSummary");
    // The source head carries the entry count, so the progress denominator
    // needs no bloom summary of the source either.
    expect(sourceCalls).not.toContain("getIdBloomSummary");
  });

  test("a non-empty target still skips entries it already has", async () => {
    const source = await createStore(["e1", "e2", "e3"]);
    const target = await createStore(["e2"]);
    const offered: string[] = [];
    const accept = target.putEntries.bind(target);
    target.putEntries = async (entries: StoreEntry[]) => {
      offered.push(...entries.map((entry) => entry.id));
      return accept(entries);
    };

    const result = await syncEntriesBetweenStores(source, target, undefined, {
      logger: silentLogger,
      cursors: createCursorStore(),
    });

    expect(result.transferred).toBe(2);
    expect(offered.sort()).toEqual(["e1", "e3"]);
  });

  test("the next page transfers while the previous one is processed", async () => {
    const source = await createStore(["e1", "e2", "e3", "e4"]);
    const target = await createStore([]);
    const events: string[] = [];
    const accept = target.putEntries.bind(target);
    target.putEntries = async (entries: StoreEntry[]) => {
      events.push(`put ${entries.map((entry) => entry.id).join(",")}`);
      return accept(entries);
    };
    let page = 0;
    const onPageTransferred = async () => {
      const current = ++page;
      events.push(`process ${current} start`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push(`process ${current} end`);
    };

    await syncEntriesBetweenStores(source, target, { pageSize: 2 }, {
      logger: silentLogger,
      cursors: createCursorStore(),
      onPageTransferred,
    });

    // Page 2 lands while page 1 is still processing, and the sync returns
    // only once the last page has been processed.
    expect(events.indexOf("put e3,e4")).toBeLessThan(events.indexOf("process 1 end"));
    expect(events[events.length - 1]).toBe("process 2 end");
  });

  test("a processing error fails the sync", async () => {
    const source = await createStore(["e1", "e2", "e3", "e4"]);
    const target = await createStore([]);

    await expect(
      syncEntriesBetweenStores(source, target, { pageSize: 2 }, {
        logger: silentLogger,
        cursors: createCursorStore(),
        onPageTransferred: async () => {
          throw new Error("index broke");
        },
      }),
    ).rejects.toThrow("index broke");
  });
});

describe("document loads during index catch-up", () => {
  test("concurrent loads of one document materialize it once", async () => {
    const { makeTenant } = await import("./_helpers/multiDevice");
    const fixture = await makeTenant({ tenantId: "tenant-load-share" });
    const db = await fixture.host.tenant.openDB("notes");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().title = "shared";
    });
    const internals = db as unknown as {
      docCache: Map<string, unknown>;
      loadDocumentUncoalesced: (docId: string) => Promise<unknown>;
    };
    internals.docCache.clear();
    const original = internals.loadDocumentUncoalesced.bind(db);
    let materializations = 0;
    internals.loadDocumentUncoalesced = async (docId: string) => {
      materializations++;
      return original(docId);
    };

    // What the summary buffer and the full-text index do when they follow
    // the same changefeed page.
    const [a, b] = await Promise.all([db.getDocument(doc.getId()), db.getDocument(doc.getId())]);

    expect(a.getData().title).toBe("shared");
    expect(b.getData().title).toBe("shared");
    expect(materializations).toBe(1);
  });
});
