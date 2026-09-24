import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreKind } from "../core/appendonlystores/types";
import {
  IrohNetworkTransport,
  IrohPeerStore,
  createStoreIrohHandler,
  serveIrohRpc,
} from "../core/appendonlystores/network/IrohNetworkTransport";
import {
  createLoopbackIrohPair,
  decodeIrohFrame,
  encodeIrohFrame,
  isBenignIrohClose,
} from "../core/appendonlystores/network/IrohStreamIO";
import {
  NetworkError,
  NetworkErrorType,
} from "../core/appendonlystores/network/types";
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

  // Over Iroh every failure used to arrive as NETWORK_ERROR carrying only a
  // message string, so callers could not tell a refused write from a broken
  // link except by matching on text. The handler's classification now travels
  // with the response.
  test("a NetworkError from the handler keeps its type across the link", async () => {
    const { a, b } = createLoopbackIrohPair();
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    const transport = new IrohNetworkTransport(a, "loopback:b", { tenantId: "t1" });
    const pending = transport.requestChallenge("alice");
    const { value: stream } = await incoming;
    void serveIrohRpc(stream!, async () => {
      throw new NetworkError(NetworkErrorType.ACCESS_DENIED, "denied by Tier 1 policy");
    });
    await expect(pending).rejects.toMatchObject({
      name: "NetworkError",
      type: NetworkErrorType.ACCESS_DENIED,
      message: expect.stringContaining("denied by Tier 1 policy"),
    });
  });

  test("a plain error from the handler still arrives as a network failure", async () => {
    const { a, b } = createLoopbackIrohPair();
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    const transport = new IrohNetworkTransport(a, "loopback:b", { tenantId: "t1" });
    const pending = transport.requestChallenge("alice");
    const { value: stream } = await incoming;
    void serveIrohRpc(stream!, async () => {
      throw new Error("the handler blew up");
    });
    await expect(pending).rejects.toMatchObject({
      type: NetworkErrorType.NETWORK_ERROR,
    });
  });

  test("ignores an error type the far side made up", async () => {
    // `errorType` crosses the wire, so an unrecognised value must not become
    // the client's error type.
    const { a, b } = createLoopbackIrohPair();
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    const transport = new IrohNetworkTransport(a, "loopback:b", { tenantId: "t1" });
    const pending = transport.requestChallenge("alice");
    const { value: stream } = await incoming;
    void (async () => {
      const stream2 = stream!;
      const bytes = await stream2.recv();
      const request = decodeIrohFrame(bytes!) as { id: number };
      await stream2.send(
        encodeIrohFrame({
          id: request.id,
          ok: false,
          error: "nope",
          errorType: "INVENTED_TYPE",
        }),
      );
    })();
    await expect(pending).rejects.toMatchObject({
      type: NetworkErrorType.NETWORK_ERROR,
    });
  });

  test("isBenignIrohClose treats peer disconnects as clean", () => {
    expect(
      isBenignIrohClose(
        new Error('ConnectionLost(ApplicationClosed(ApplicationClose { error_code: 0, reason: b"" }))'),
      ),
    ).toBe(true);
    expect(isBenignIrohClose(new Error("Unknown Iroh RPC method foo"))).toBe(false);
  });
});
