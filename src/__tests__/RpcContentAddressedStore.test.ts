import { RpcContentAddressedStoreFactory, type StoreRpcClientTransport } from "../core/appendonlystores/rpc/RpcContentAddressedStore";
import { StoreRpcServer } from "../core/appendonlystores/rpc/StoreRpcServer";
import { SqliteContentAddressedStoreFactory } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { createMemorySqliteBackend } from "../core/appendonlystores/sqlite/SqliteDriver";
import type { StoreEntry } from "../core/types";

function entry(docId: string, id: string, size = 8, dependencyIds: string[] = []): StoreEntry {
  const encryptedData = new Uint8Array(size).map((_, i) => (i * 7 + id.length) % 256);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId,
    dependencyIds,
    createdAt: 1000 + id.length,
    createdByPublicKey: "test-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, id.length]),
    originalSize: size,
    encryptedSize: size,
    encryptedData,
  };
}

/** In-process transport: JSON round trip for calls, a map for the binary channel. */
function setup() {
  const toServer = new Map<string, Uint8Array>();
  const toClient = new Map<string, Uint8Array>();
  const server = new StoreRpcServer({
    createFactory: () => new SqliteContentAddressedStoreFactory(() => createMemorySqliteBackend()),
    bytes: {
      async take(blobId) {
        const bytes = toServer.get(blobId) ?? null;
        toServer.delete(blobId);
        return bytes;
      },
      async offer(blobId, bytes) {
        toClient.set(blobId, bytes);
      },
    },
  });
  let calls = 0;
  const transport: StoreRpcClientTransport = {
    async call(request) {
      calls += 1;
      const wire = JSON.parse(JSON.stringify(request));
      return JSON.parse(JSON.stringify((await server.handle(wire)) ?? null));
    },
    async sendBytes(blobId, bytes) {
      toServer.set(blobId, bytes.slice());
    },
    async receiveBytes(blobId) {
      const bytes = toClient.get(blobId);
      toClient.delete(blobId);
      if (!bytes) throw new Error("missing blob");
      return bytes;
    },
  };
  const factory = new RpcContentAddressedStoreFactory(transport, { scope: "tenant-test" });
  return { factory, callCount: () => calls, pendingBytes: () => toServer.size + toClient.size };
}

describe("RpcContentAddressedStore", () => {
  test("round-trips entries with payloads and binary metadata", async () => {
    const { factory, pendingBytes } = setup();
    const { docStore } = factory.createStore("db1");
    const entries = [entry("doc-a", "a1", 20), entry("doc-a", "a2", 0, ["a1"]), entry("doc-b", "b1", 300)];
    await docStore.putEntries(entries);

    const loaded = await docStore.getEntries(["b1", "missing", "a1", "a2"]);
    expect(loaded.map((e) => e.id)).toEqual(["b1", "a1", "a2"]);
    for (const got of loaded) {
      const original = entries.find((e) => e.id === got.id)!;
      expect(Array.from(got.encryptedData)).toEqual(Array.from(original.encryptedData));
      expect(got.signature).toBeInstanceOf(Uint8Array);
      expect(Array.from(got.signature)).toEqual(Array.from(original.signature));
    }
    expect(pendingBytes()).toBe(0);
  });

  test("forwards queries and optional methods", async () => {
    const { factory } = setup();
    const { docStore, attachmentStore } = factory.createStore("db1");
    await docStore.putEntries([entry("doc-a", "a1"), entry("doc-a", "a2", 8, ["a1"]), entry("doc-b", "b1")]);

    expect(await docStore.hasEntries(["a1", "x", "b1"])).toEqual(["a1", "b1"]);
    expect((await docStore.findNewEntriesForDoc(["a1"], "doc-a")).map((m) => m.id)).toEqual(["a2"]);
    expect((await docStore.getAllIds()).sort()).toEqual(["a1", "a2", "b1"]);
    expect(await docStore.resolveDependencies("a2")).toEqual(["a1", "a2"]);
    expect(typeof docStore.scanEntriesSince).toBe("function");
    expect(docStore.getCompactionStatus).toBeUndefined();
    const page = await docStore.scanEntriesSince!(null, 2);
    expect(page.entries).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect((await docStore.getStoreHead!()).maxReceiptOrder).toBe(3);
    expect(await attachmentStore.getAllIds()).toEqual([]);

    await docStore.deleteEntriesById!(["b1"]);
    expect(await docStore.hasEntries(["b1"])).toEqual([]);
    await docStore.clearAllLocalData!();
    expect(await docStore.getAllIds()).toEqual([]);
  });

  test("keeps stores apart per scope and database", async () => {
    const one = setup();
    const a = one.factory.createStore("db1").docStore;
    const b = one.factory.createStore("db2").docStore;
    await a.putEntries([entry("doc-a", "a1")]);
    expect(await b.getAllIds()).toEqual([]);
    expect(a.getCacheIdentity!()).toBe("rpc:tenant-test:db1:docs");
  });

  test("puts a batch with one call and skips entries already stored", async () => {
    const { factory, callCount } = setup();
    const { docStore } = factory.createStore("db1");
    const batch = Array.from({ length: 200 }, (_, i) => entry(`doc-${i % 5}`, `e${i}`, 64));
    await docStore.putEntries(batch);
    expect(callCount()).toBe(1);
    await docStore.putEntries(batch.slice(0, 10));
    expect((await docStore.getAllIds()).length).toBe(200);
  });
});
