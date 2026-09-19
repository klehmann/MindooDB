import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import {
  IROH_SYNC_STORE_METHODS,
  IrohPeerStore,
  createStoreIrohHandler,
  listenForIrohPeers,
  serveIrohRpc,
  type IrohRpcContext,
} from "../core/appendonlystores/network/IrohNetworkTransport";
import { createLoopbackIrohPair } from "../core/appendonlystores/network/IrohStreamIO";
import type { StoreEntry } from "../core/types";

const ENDPOINT_A = "a".repeat(64);
const ENDPOINT_B = "b".repeat(64);

function createTestEntry(id: string, docId = "doc1"): StoreEntry {
  const encryptedData = new Uint8Array([9, 8, 7]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId,
    dependencyIds: [],
    createdAt: Date.now(),
    createdByPublicKey: "test-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2]),
    originalSize: 3,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}

/**
 * What a Haven device must get right before it accepts peer sync: address the
 * correct replica, refuse unknown peers, and refuse RPCs that are not part of
 * syncing.
 */
describe("Iroh peer sync guards", () => {
  test("the peer store names the replica it is talking about", async () => {
    const { a, b } = createLoopbackIrohPair();
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    const peer = new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "app-db", StoreKind.docs, {
      tenantId: "tenant-1",
    });
    const pending = peer.getAllIds();

    const { value: stream } = await incoming;
    let seen: IrohRpcContext | undefined;
    void serveIrohRpc(stream!, async (_method, _args, ctx) => {
      seen = ctx;
      return [];
    });
    await pending;

    // Without this the listener cannot tell which of its local replicas the
    // caller means, and would have to guess.
    expect(seen).toEqual({ tenantId: "tenant-1", dbId: "app-db", storeKind: StoreKind.docs });
  });

  test("the scan cursor is keyed on the endpoint id, not on a ticket", () => {
    // Same peer, dialed two ways. `getCacheIdentity` feeds the persisted scan
    // cursor, so if the ticket leaked into it every network change on the peer
    // would trigger a full metadata rescan.
    const { a } = createLoopbackIrohPair();
    const byId = new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "db", StoreKind.docs);
    const byBareId = new IrohPeerStore(a, ENDPOINT_B, "db", StoreKind.docs, {
      peerEndpointId: ENDPOINT_B,
    });
    expect(byId.getCacheIdentity()).toBe(byBareId.getCacheIdentity());
    expect(byId.getCacheIdentity()).toContain(ENDPOINT_B);
  });

  test("a listener routes each caller to the replica its ctx names", async () => {
    const { a, b } = createLoopbackIrohPair();
    const docsStore = new InMemoryContentAddressedStore("shared-db", StoreKind.docs);
    const attachmentsStore = new InMemoryContentAddressedStore("shared-db", StoreKind.attachments);
    await docsStore.putEntries([createTestEntry("in-docs")]);
    await attachmentsStore.putEntries([createTestEntry("in-attachments")]);

    const replicas = new Map([
      [`tenant-1/shared-db/${StoreKind.docs}`, docsStore],
      [`tenant-1/shared-db/${StoreKind.attachments}`, attachmentsStore],
    ]);
    void listenForIrohPeers(b, async (method, args, ctx) => {
      const store = replicas.get(`${ctx?.tenantId}/${ctx?.dbId}/${ctx?.storeKind}`);
      if (!store) {
        throw new Error("No such replica");
      }
      return createStoreIrohHandler(store)(method, args, ctx);
    });

    const docsPeer = new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "shared-db", StoreKind.docs, {
      tenantId: "tenant-1",
    });
    const attachmentsPeer = new IrohPeerStore(
      a,
      `iroh:${ENDPOINT_B}`,
      "shared-db",
      StoreKind.attachments,
      { tenantId: "tenant-1" },
    );
    await expect(docsPeer.getAllIds()).resolves.toEqual(["in-docs"]);
    await expect(attachmentsPeer.getAllIds()).resolves.toEqual(["in-attachments"]);

    const unknownPeer = new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "not-here", StoreKind.docs, {
      tenantId: "tenant-1",
    });
    await expect(unknownPeer.getAllIds()).rejects.toThrow(/No such replica/);
  });

  test("the handler learns which peer is calling", async () => {
    const { a, b } = createLoopbackIrohPair();
    let caller: string | undefined;
    void listenForIrohPeers(b, async (_method, _args, _ctx, peerEndpointId) => {
      caller = peerEndpointId;
      return [];
    });
    await new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "db", StoreKind.docs).getAllIds();
    expect(caller).toBe(ENDPOINT_A);
  });

  test("an unauthorized peer is dropped before any RPC runs", async () => {
    const { a, b } = createLoopbackIrohPair();
    const store = new InMemoryContentAddressedStore("db", StoreKind.docs);
    await store.putEntries([createTestEntry("secret")]);

    let served = 0;
    void listenForIrohPeers(
      b,
      async (method, args, ctx) => {
        served += 1;
        return createStoreIrohHandler(store)(method, args, ctx);
      },
      { authorize: (peerEndpointId) => peerEndpointId === "some-other-device" },
    );

    // The stream is closed instead of served, so the RPC gets no reply.
    const peer = new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "db", StoreKind.docs);
    await expect(peer.getAllIds()).rejects.toThrow();
    expect(served).toBe(0);
  });

  test("an authorized peer is served", async () => {
    const { a, b } = createLoopbackIrohPair();
    const store = new InMemoryContentAddressedStore("db", StoreKind.docs);
    await store.putEntries([createTestEntry("shared")]);
    void listenForIrohPeers(b, createStoreIrohHandler(store), {
      authorize: (peerEndpointId) => peerEndpointId === ENDPOINT_A,
    });
    const peer = new IrohPeerStore(a, `iroh:${ENDPOINT_B}`, "db", StoreKind.docs);
    await expect(peer.getAllIds()).resolves.toEqual(["shared"]);
  });

  test("the store handler only dispatches sync methods", async () => {
    const store = new InMemoryContentAddressedStore("db", StoreKind.docs);
    await store.putEntries([createTestEntry("keep-me", "doc-to-purge")]);
    const handler = createStoreIrohHandler(store);

    // `createStoreIrohHandler` resolves methods by name off the store, so
    // without the allowlist a peer could wipe history on the listening device.
    await expect(handler("store.purgeDocHistory", ["doc-to-purge"])).rejects.toThrow(
      /not allowed/,
    );
    expect(IROH_SYNC_STORE_METHODS).not.toContain("purgeDocHistory");
    await expect(store.getEntries(["keep-me"])).resolves.toHaveLength(1);

    await expect(handler("store.getAllIds", [])).resolves.toEqual(["keep-me"]);
  });

  test("a narrowed allowlist can refuse writes", async () => {
    const store = new InMemoryContentAddressedStore("db", StoreKind.docs);
    const readOnly = createStoreIrohHandler(store, {
      allowedMethods: IROH_SYNC_STORE_METHODS.filter((method) => method !== "putEntries"),
    });
    await expect(readOnly("store.putEntries", [[createTestEntry("nope")]])).rejects.toThrow(
      /not allowed/,
    );
    await expect(store.getAllIds()).resolves.toEqual([]);
  });
});
