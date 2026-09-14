import { IrohNetworkTransport, listenForIrohPeers } from "../core/appendonlystores/network/IrohNetworkTransport";
import { createLoopbackIrohPair, type IrohStreamIO } from "../core/appendonlystores/network/IrohStreamIO";
import { StoreKind } from "../core/appendonlystores/types";
import type { StoreChangeEvent } from "../core/appendonlystores/network/types";
import {
  createMindooDBServerIrohHandler,
  IROH_CHANGE_FEED_HEARTBEAT_MS,
  type IrohServerStore,
} from "../node/server/IrohServerRpc";
import { SyncEventBus } from "../node/server/SyncEventBus";

function stubStore(overrides: Partial<IrohServerStore> = {}): IrohServerStore {
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
    handleGetAllIds: missing,
    handleResolveDependencies: missing,
    handlePlanDocumentMaterialization: missing,
    handlePlanDocumentMaterializationBatch: missing,
    handlePlanAttachmentReadByWalkingMetadata: missing,
    ...overrides,
  };
}

function startLoopback(handler: ReturnType<typeof createMindooDBServerIrohHandler>): {
  client: IrohStreamIO;
  connectCount: { value: number };
} {
  const { a, b } = createLoopbackIrohPair();
  const connectCount = { value: 0 };
  const client: IrohStreamIO = {
    getLocalTicket: () => a.getLocalTicket(),
    connect: async (ticket, alpn) => {
      connectCount.value += 1;
      return a.connect(ticket, alpn);
    },
  };
  void listenForIrohPeers(b, handler);
  return { client, connectCount };
}

function createHost(bus: SyncEventBus, store: IrohServerStore, onCtx?: (ctx: unknown) => void) {
  const inner = createMindooDBServerIrohHandler({
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
  return async (method: string, args: unknown[], ctx?: unknown) => {
    onCtx?.(ctx);
    return inner(method, args, ctx as never);
  };
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

describe("Iroh change feed", () => {
  test("filters bus events by tenant and storeKind, then acks and streams frames", async () => {
    const bus = new SyncEventBus();
    const seenCtx: unknown[] = [];
    const { client } = startLoopback(createHost(bus, stubStore(), (ctx) => seenCtx.push(ctx)));
    const transport = new IrohNetworkTransport(client, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });

    const events: StoreChangeEvent[] = [];
    const abort = new AbortController();
    const subscribed = transport.subscribeToChanges("token", (event) => events.push(event), {
      signal: abort.signal,
    });
    await waitFor(() => bus.listenerCount === 1);

    expect(seenCtx.some((ctx) => (ctx as { tenantId?: string })?.tenantId === "acme")).toBe(true);

    bus.publish({ tenantId: "other", dbId: "directory", storeKind: "docs", maxReceiptOrder: 1 });
    bus.publish({ tenantId: "acme", dbId: "notes", storeKind: "attachments", maxReceiptOrder: 2 });
    bus.publish({ tenantId: "acme", dbId: "notes", storeKind: "docs", epoch: "e2", maxReceiptOrder: 9 });
    await waitFor(() => events.length === 1);

    expect(events).toEqual([{ dbId: "notes", storeKind: "docs", epoch: "e2", maxReceiptOrder: 9 }]);

    abort.abort();
    await expect(subscribed).resolves.toBeUndefined();
    await waitFor(() => bus.listenerCount === 0);
  });

  test("keeps RPC session usable while the feed is open", async () => {
    const bus = new SyncEventBus();
    const { client } = startLoopback(createHost(bus, stubStore()));
    const transport = new IrohNetworkTransport(client, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });

    const abort = new AbortController();
    const subscribed = transport.subscribeToChanges("token", () => undefined, { signal: abort.signal });
    await waitFor(() => bus.listenerCount === 1);

    await expect(transport.getStoreHead("token")).resolves.toEqual({ epoch: "e1", maxReceiptOrder: 3 });

    abort.abort();
    await subscribed;
  });

  test("opens a dedicated connect() for subscribeToChanges", async () => {
    const bus = new SyncEventBus();
    const { client, connectCount } = startLoopback(createHost(bus, stubStore()));
    const transport = new IrohNetworkTransport(client, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });

    await transport.getServerInfo();
    const afterRpc = connectCount.value;
    const abort = new AbortController();
    const subscribed = transport.subscribeToChanges("token", () => undefined, { signal: abort.signal });
    await waitFor(() => bus.listenerCount === 1);
    expect(connectCount.value).toBe(afterRpc + 1);

    abort.abort();
    await subscribed;
  });

  test("getCapabilities advertises supportsChangeEvents", async () => {
    const bus = new SyncEventBus();
    const { client } = startLoopback(createHost(bus, stubStore()));
    const transport = new IrohNetworkTransport(client, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });
    await expect(transport.getCapabilities("token")).resolves.toMatchObject({
      protocolVersion: "sync-v5",
      supportsChangeEvents: true,
    });
  });

  test("heartbeat frames do not emit change events and timers stop on close", async () => {
    jest.useFakeTimers();
    try {
      const bus = new SyncEventBus();
      const { client } = startLoopback(createHost(bus, stubStore()));
      const transport = new IrohNetworkTransport(client, "loopback:b", {
        tenantId: "acme",
        dbId: "directory",
        storeKind: StoreKind.docs,
      });

      const events: StoreChangeEvent[] = [];
      const abort = new AbortController();
      const subscribed = transport.subscribeToChanges("token", (event) => events.push(event), {
        signal: abort.signal,
      });
      for (let i = 0; i < 40 && bus.listenerCount === 0; i += 1) {
        await Promise.resolve();
      }
      expect(bus.listenerCount).toBe(1);

      const timersWhileOpen = jest.getTimerCount();
      expect(timersWhileOpen).toBeGreaterThan(0);
      await jest.advanceTimersByTimeAsync(IROH_CHANGE_FEED_HEARTBEAT_MS);
      expect(events).toEqual([]);

      abort.abort();
      await subscribed;
      for (let i = 0; i < 40 && bus.listenerCount > 0; i += 1) {
        await Promise.resolve();
      }
      expect(bus.listenerCount).toBe(0);
      expect(jest.getTimerCount()).toBeLessThan(timersWhileOpen);
    } finally {
      jest.useRealTimers();
    }
  });

  test("without supportsChangeEvents the Iroh server path is the only one that advertises the feed", async () => {
    const { a, b } = createLoopbackIrohPair();
    void listenForIrohPeers(b, async (method) => {
      if (method === "getCapabilities") {
        return { protocolVersion: "sync-v5" };
      }
      throw new Error(`unexpected ${method}`);
    });
    const raw = new IrohNetworkTransport(a, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });
    await expect(raw.getCapabilities("token")).resolves.toEqual({ protocolVersion: "sync-v5" });
  });

  test("abort closes the stream while recv is blocked", async () => {
    const bus = new SyncEventBus();
    const { client } = startLoopback(createHost(bus, stubStore()));
    const transport = new IrohNetworkTransport(client, "loopback:b", {
      tenantId: "acme",
      dbId: "directory",
      storeKind: StoreKind.docs,
    });

    const abort = new AbortController();
    const subscribed = transport.subscribeToChanges("token", () => undefined, { signal: abort.signal });
    await waitFor(() => bus.listenerCount === 1);
    abort.abort();
    await expect(subscribed).resolves.toBeUndefined();
    await waitFor(() => bus.listenerCount === 0);
  });
});
