import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import {
  createStoreIrohHandler,
  listenForIrohPeers,
} from "../core/appendonlystores/network/IrohNetworkTransport";
import {
  createLoopbackIrohPair,
  decodeIrohFrame,
  encodeIrohFrame,
  type IrohRpcResponse,
} from "../core/appendonlystores/network/IrohStreamIO";
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

/**
 * A listener that gates writes looks at `args[0]` with `Array.isArray` and then
 * hands `args` to the store via `apply`. `apply` accepts any array-like, so an
 * object `{"0": [...], "length": 1}` used to look empty to the gate and still
 * reach the store in full.
 */
describe("Iroh RPC arguments must be a real array", () => {
  async function sendRaw(args: unknown): Promise<{ response: IrohRpcResponse; store: InMemoryContentAddressedStore; gateSaw: number }> {
    const { a, b } = createLoopbackIrohPair();
    const store = new InMemoryContentAddressedStore("db", StoreKind.docs);
    let gateSaw = -1;
    void listenForIrohPeers(b, async (method, rpcArgs, ctx) => {
      const incoming = Array.isArray(rpcArgs) ? rpcArgs[0] : undefined;
      gateSaw = Array.isArray(incoming) ? incoming.length : 0;
      return createStoreIrohHandler(store)(method, rpcArgs, ctx);
    });
    const stream = await a.connect(await b.getLocalTicket());
    await stream.send(encodeIrohFrame({ id: 1, method: "store.putEntries", args, ctx: { dbId: "db" } }));
    const reply = await stream.recv();
    return { response: decodeIrohFrame(reply!) as IrohRpcResponse, store, gateSaw };
  }

  test("an array-like object is refused before any handler runs", async () => {
    const { response, store, gateSaw } = await sendRaw({ 0: [createTestEntry("smuggled")], length: 1 });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/arguments as an array/);
    expect(gateSaw).toBe(-1);
    expect(await store.getAllIds()).toEqual([]);
  });

  test("the store handler refuses an array-like object on its own too", async () => {
    const store = new InMemoryContentAddressedStore("db", StoreKind.docs);
    const handler = createStoreIrohHandler(store);
    await expect(
      handler("putEntries", { 0: [createTestEntry("smuggled")], length: 1 } as unknown as unknown[]),
    ).rejects.toThrow(/arguments as an array/);
    expect(await store.getAllIds()).toEqual([]);
  });

  test("a real array still goes through", async () => {
    const { response, store, gateSaw } = await sendRaw([[createTestEntry("normal")]]);
    expect(response.ok).toBe(true);
    expect(gateSaw).toBe(1);
    expect(await store.getAllIds()).toEqual(["normal"]);
  });
});
