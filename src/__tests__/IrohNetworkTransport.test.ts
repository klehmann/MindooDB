import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import {
  IrohNetworkTransport,
  IrohPeerStore,
  createStoreIrohHandler,
  serveIrohRpc,
} from "../core/appendonlystores/network/IrohNetworkTransport";
import { createLoopbackIrohPair } from "../core/appendonlystores/network/IrohStreamIO";
import type { StoreEntry } from "../core/types";

function createTestEntry(id: string): StoreEntry {
  const encryptedData = new Uint8Array([9, 8, 7]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId: "doc1",
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

describe("Iroh P2P framing", () => {
  test("IrohPeerStore syncs encrypted entries over loopback streams", async () => {
    const { a, b } = createLoopbackIrohPair();
    const local = new InMemoryContentAddressedStore("peer-a", StoreKind.docs);
    const remote = new InMemoryContentAddressedStore("peer-b", StoreKind.docs);
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    await local.putEntries([createTestEntry("id1")]);
    const peer = new IrohPeerStore(a, "loopback:b", "peer-b", StoreKind.docs);
    const pending = peer.putEntries(await local.getEntries(["id1"]));
    const { value: stream } = await incoming;
    void serveIrohRpc(stream!, createStoreIrohHandler(remote));
    await pending;
    const got = await remote.getEntries(["id1"]);
    expect(got).toHaveLength(1);
    expect(got[0].contentHash).toBe("hash-id1");
  });

  test("IrohNetworkTransport RPC reaches a custom handler", async () => {
    const { a, b } = createLoopbackIrohPair();
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    const transport = new IrohNetworkTransport(a, "loopback:b", { tenantId: "t1" });
    const pending = transport.requestChallenge("alice");
    const { value: stream } = await incoming;
    void serveIrohRpc(stream!, async (method, args) => {
      if (method === "requestChallenge") {
        return `challenge-for-${args[0] ?? "anon"}`;
      }
      throw new Error(`unexpected ${method}`);
    });
    await expect(pending).resolves.toBe("challenge-for-alice");
  });
});
