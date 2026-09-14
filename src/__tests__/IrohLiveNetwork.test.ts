/**
 * Live Iroh network: a real MindooDBServer (native `@number0/iroh`) plus a
 * second native client. Opt-in — needs outbound access to n0 relays.
 *
 *   MINDOODB_IROH_LIVE=1 pnpm test:iroh
 */
import { IrohNetworkTransport } from "../core/appendonlystores/network/IrohNetworkTransport";
import {
  canUseNativeIroh,
  connectIrohStore,
  IROH_LIVE_FEED_DB_ID,
  skipIrohLiveUnlessEnabled,
  startIrohLiveServer,
  type IrohLiveServer,
} from "./_helpers/irohLiveServer";

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const describeLive = skipIrohLiveUnlessEnabled() ? describe.skip : describe;

describeLive("Iroh live network (MindooDBServer)", () => {
  jest.setTimeout(180_000);

  let live: IrohLiveServer;

  beforeAll(async () => {
    if (!(await canUseNativeIroh())) {
      throw new Error("@number0/iroh is not installed. From mindoodb: pnpm add -D @number0/iroh");
    }
    live = await startIrohLiveServer();
  });

  afterAll(async () => {
    await live?.stop();
  });

  test("publishes a ticket and answers discovery plus authenticated store reads", async () => {
    expect(live.info.ticket.startsWith("endpoint")).toBe(true);
    expect(live.info.ticket.length).toBeGreaterThan(40);

    const { store, io } = await connectIrohStore(live, "directory");
    try {
      const discovery = new IrohNetworkTransport(io, live.info.ticket, {
        tenantId: "discovery",
      });
      await expect(discovery.getServerInfo()).resolves.toMatchObject({
        name: live.info.serverName,
      });
      await expect(discovery.getTenantPublicInfosFingerprints(live.info.tenantId)).resolves.toEqual(
        expect.objectContaining({
          tenantId: live.info.tenantId,
          fingerprints: expect.any(Array),
        }),
      );

      const head = await store.getStoreHead();
      expect(head.maxReceiptOrder).toBeGreaterThan(0);
      const ids = await store.getAllIds();
      expect(ids.length).toBeGreaterThan(0);
    } finally {
      await io.close?.();
    }
  });

  test("A receives a change event when B pushes, without blocking RPC", async () => {
    const first = await connectIrohStore(live, IROH_LIVE_FEED_DB_ID);
    const second = await connectIrohStore(live, IROH_LIVE_FEED_DB_ID);
    try {
      const events: Array<{ dbId: string; maxReceiptOrder?: number }> = [];
      const unsub = first.store.subscribeToChanges((event) => {
        events.push(event);
      });
      await waitUntil(() => live.server.getSyncEventListenerCount() > 0);

      const notes = await live.tenant.openDB(IROH_LIVE_FEED_DB_ID);
      await notes.createDocument();
      await notes.syncStoreChanges();
      const pushed = await notes.pushChangesTo(second.store);
      expect(pushed.cancelled).toBe(false);

      await waitUntil(() => events.some((event) => event.dbId === IROH_LIVE_FEED_DB_ID));
      const change = events.find((event) => event.dbId === IROH_LIVE_FEED_DB_ID);
      expect(change?.maxReceiptOrder).toBeGreaterThan(0);

      const ids = await first.store.getAllIds();
      expect(ids.length).toBeGreaterThan(0);

      unsub();
      await waitUntil(() => live.server.getSyncEventListenerCount() === 0);
    } finally {
      await first.io.close?.();
      await second.io.close?.();
    }
  });

  test("change feed survives QUIC idle and then delivers a later push", async () => {
    const first = await connectIrohStore(live, IROH_LIVE_FEED_DB_ID);
    const second = await connectIrohStore(live, IROH_LIVE_FEED_DB_ID);
    try {
      const events: Array<{ dbId: string }> = [];
      const unsub = first.store.subscribeToChanges((event) => {
        events.push(event);
      });
      await waitUntil(() => live.server.getSyncEventListenerCount() > 0);
      await new Promise((resolve) => setTimeout(resolve, 45_000));

      const notes = await live.tenant.openDB(IROH_LIVE_FEED_DB_ID);
      await notes.createDocument();
      await notes.syncStoreChanges();
      await notes.pushChangesTo(second.store);
      await waitUntil(() => events.some((event) => event.dbId === IROH_LIVE_FEED_DB_ID), 30_000);

      unsub();
      await waitUntil(() => live.server.getSyncEventListenerCount() === 0);
    } finally {
      await first.io.close?.();
      await second.io.close?.();
    }
  });

  test("parallel transfer batches share one QUIC connection", async () => {
    const remote = await connectIrohStore(live, IROH_LIVE_FEED_DB_ID);
    try {
      const notes = await live.tenant.openDB(IROH_LIVE_FEED_DB_ID);
      for (let i = 0; i < 6; i += 1) {
        await notes.createDocument();
      }
      await notes.syncStoreChanges();
      const pushed = await notes.pushChangesTo(remote.store, {
        transferBatchSize: 1,
        maxConcurrentBatches: 3,
      });
      expect(pushed.cancelled).toBe(false);
      expect(pushed.transferredEntries).toBeGreaterThan(1);
      expect((await remote.store.getStoreHead()).maxReceiptOrder).toBeGreaterThan(0);
    } finally {
      await remote.io.close?.();
    }
  });

  test("a second native client sees the same directory entries and can push over Iroh", async () => {
    const first = await connectIrohStore(live, "directory");
    const second = await connectIrohStore(live, "directory");
    try {
      const firstIds = await first.store.getAllIds();
      const secondIds = await second.store.getAllIds();
      expect(secondIds.sort()).toEqual(firstIds.sort());

      const directory = await live.tenant.openDB("directory", { adminOnlyDb: true });
      const pushed = await directory.pushChangesTo(second.store);
      expect(pushed.cancelled).toBe(false);
      expect((await second.store.getStoreHead()).maxReceiptOrder).toBeGreaterThan(0);
    } finally {
      await first.io.close?.();
      await second.io.close?.();
    }
  });
});
