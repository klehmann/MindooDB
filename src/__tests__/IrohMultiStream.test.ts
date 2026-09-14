import {
  IrohNetworkTransport,
  listenForIrohPeers,
  rpcCall,
} from "../core/appendonlystores/network/IrohNetworkTransport";
import {
  createLoopbackIrohPair,
  encodeIrohFrame,
  type IrohConnectionHandle,
  type IrohStreamIO,
} from "../core/appendonlystores/network/IrohStreamIO";
import { StoreKind } from "../core/appendonlystores/types";
import { createMindooDBServerIrohHandler, type IrohServerStore } from "../node/server/IrohServerRpc";
import { SyncEventBus } from "../node/server/SyncEventBus";

function stubStore(): IrohServerStore {
  const missing = async () => {
    throw new Error("unexpected store method");
  };
  return {
    handleFindNewEntries: missing,
    handleFindNewEntriesForDoc: missing,
    handleFindEntries: missing,
    handleScanEntriesSince: missing,
    handleGetIdBloomSummary: missing,
    handleGetStoreHead: async () => ({ epoch: "e1", maxReceiptOrder: 3 }),
    handleGetCompactionStatus: missing,
    handleGetCapabilities: async () => ({ protocolVersion: "sync-v5" }),
    handleGetEntries: missing,
    handleGetEntriesSessionWrapped: missing,
    handleGetEntryMetadata: missing,
    handlePutEntries: missing,
    handleHasEntries: missing,
    handleGetAllIds: async () => ["a", "b", "c"],
    handleResolveDependencies: missing,
    handlePlanDocumentMaterialization: missing,
    handlePlanDocumentMaterializationBatch: missing,
    handlePlanAttachmentReadByWalkingMetadata: missing,
  };
}

function createHost(bus: SyncEventBus, store: IrohServerStore) {
  return createMindooDBServerIrohHandler({
    getServerPublicInfo: () => ({
      name: "cn=home/o=mindoo",
      signingPublicKey: "sign-pem",
      encryptionPublicKey: "enc-pem",
    }),
    getClusterRole: () => "peer",
    listTenantPublicInfosFingerprints: async () => ["fp-1"],
    getAuthService: async () => ({
      generateChallenge: async () => "challenge",
      authenticate: async () => ({ success: true, token: "jwt" }),
    }),
    getServerStore: async () => store,
    syncEventBus: bus,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function instrumentedIo(inner: IrohStreamIO): {
  io: IrohStreamIO;
  connectCount: { value: number };
  openConnectionCount: { value: number };
  openStreamCount: { value: number };
} {
  const connectCount = { value: 0 };
  const openConnectionCount = { value: 0 };
  const openStreamCount = { value: 0 };
  const io: IrohStreamIO = {
    getLocalTicket: () => inner.getLocalTicket(),
    connect: async (ticket, alpn) => {
      connectCount.value += 1;
      return inner.connect(ticket, alpn);
    },
    openConnection: async (ticket, alpn) => {
      openConnectionCount.value += 1;
      const connection = await inner.openConnection!(ticket, alpn);
      return {
        openStream: async () => {
          openStreamCount.value += 1;
          return connection.openStream();
        },
        close: () => connection.close(),
      } satisfies IrohConnectionHandle;
    },
  };
  return { io, connectCount, openConnectionCount, openStreamCount };
}

describe("Iroh multi-stream RPC", () => {
  test("rpcCall throws on a mismatched response id", async () => {
    const replies = [encodeIrohFrame({ id: 2, ok: true, result: "two" })];
    const stream = {
      send: async () => undefined,
      recv: async () => replies.shift() ?? null,
      close: async () => undefined,
    };
    await expect(rpcCall(stream, "echo", ["one"], 1)).rejects.toEqual(
      expect.objectContaining({
        name: "NetworkError",
        message: "Iroh response id mismatch: expected 1, got 2",
      }),
    );
  });

  test("openConnection runs two RPCs in parallel on separate streams", async () => {
    const { a, b } = createLoopbackIrohPair();
    const started: string[] = [];
    const release: Array<() => void> = [];
    void listenForIrohPeers(b, async (method, args) => {
      started.push(String(args[0]));
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      return `ok-${args[0]}`;
    });

    const { io, openConnectionCount, openStreamCount, connectCount } = instrumentedIo(a);
    const transport = new IrohNetworkTransport(io, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });

    const first = transport.requestChallenge("one");
    const second = transport.requestChallenge("two");
    await waitFor(() => started.length === 2);
    expect(started.sort()).toEqual(["one", "two"]);
    expect(openConnectionCount.value).toBe(1);
    expect(openStreamCount.value).toBe(2);
    expect(connectCount.value).toBe(0);

    for (const resolve of release) {
      resolve();
    }
    await expect(Promise.all([first, second])).resolves.toEqual(["ok-one", "ok-two"]);
  });

  test("change feed is a second stream on the shared connection", async () => {
    const { a, b } = createLoopbackIrohPair();
    const bus = new SyncEventBus();
    void listenForIrohPeers(b, createHost(bus, stubStore()));
    const { io, openConnectionCount, openStreamCount, connectCount } = instrumentedIo(a);
    const transport = new IrohNetworkTransport(io, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });

    await transport.getServerInfo();
    expect(openConnectionCount.value).toBe(1);
    expect(openStreamCount.value).toBe(1);

    const abort = new AbortController();
    const subscribed = transport.subscribeToChanges("token", () => undefined, { signal: abort.signal });
    await waitFor(() => bus.listenerCount === 1);
    expect(openConnectionCount.value).toBe(1);
    expect(openStreamCount.value).toBe(2);
    expect(connectCount.value).toBe(0);

    await expect(transport.getAllIds("token")).resolves.toEqual(["a", "b", "c"]);
    expect(openStreamCount.value).toBe(3);

    abort.abort();
    await subscribed;
    await waitFor(() => bus.listenerCount === 0);
  });
});
