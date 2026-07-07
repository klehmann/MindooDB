import { SyncEventBus, type SyncChangeEvent } from "../node/server/SyncEventBus";
import { HttpTransport } from "../appendonlystores/network/HttpTransport";
import { NetworkErrorType, type StoreChangeEvent } from "../core/appendonlystores/network/types";

describe("SyncEventBus (sync-v5 phase 5)", () => {
  test("delivers published events to all subscribers", () => {
    const bus = new SyncEventBus();
    const received1: SyncChangeEvent[] = [];
    const received2: SyncChangeEvent[] = [];
    bus.subscribe((event) => received1.push(event));
    bus.subscribe((event) => received2.push(event));

    const event: SyncChangeEvent = {
      tenantId: "tenant-a",
      dbId: "contacts",
      storeKind: "docs",
      epoch: "epoch-1",
      maxReceiptOrder: 42,
    };
    bus.publish(event);

    expect(received1).toEqual([event]);
    expect(received2).toEqual([event]);
    expect(bus.listenerCount).toBe(2);
  });

  test("unsubscribe stops delivery and updates listenerCount", () => {
    const bus = new SyncEventBus();
    const received: SyncChangeEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.publish({ tenantId: "t", dbId: "db", storeKind: "docs" });
    unsubscribe();
    bus.publish({ tenantId: "t", dbId: "db", storeKind: "docs" });

    expect(received.length).toBe(1);
    expect(bus.listenerCount).toBe(0);
  });

  test("a throwing subscriber never affects the publisher or other subscribers", () => {
    const bus = new SyncEventBus();
    const received: SyncChangeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("broken subscriber");
    });
    bus.subscribe((event) => received.push(event));

    expect(() => bus.publish({ tenantId: "t", dbId: "db", storeKind: "docs" })).not.toThrow();
    expect(received.length).toBe(1);
  });
});

describe("HttpTransport.subscribeToChanges SSE parsing (sync-v5 phase 5)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeTransport(): HttpTransport {
    return new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "contacts",
      retryAttempts: 1,
    });
  }

  /** Build an SSE Response whose body streams the given chunks, then closes. */
  function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  test("parses change events, ignores heartbeats and unknown events", async () => {
    global.fetch = jest.fn(async () =>
      sseResponse([
        ": heartbeat\n\n",
        'event: change\ndata: {"dbId":"contacts","storeKind":"docs","epoch":"e1","maxReceiptOrder":5}\n\n',
        'event: something-else\ndata: {"dbId":"other"}\n\n',
        // A change event split across two reads must still parse.
        'event: change\ndata: {"dbId":"contacts",',
        '"storeKind":"docs","maxReceiptOrder":6}\n\n',
      ]),
    ) as typeof fetch;

    const events: StoreChangeEvent[] = [];
    await makeTransport().subscribeToChanges("token", (event) => events.push(event));

    expect(events).toEqual([
      { dbId: "contacts", storeKind: "docs", epoch: "e1", maxReceiptOrder: 5 },
      { dbId: "contacts", storeKind: "docs", maxReceiptOrder: 6 },
    ]);

    const fetchMock = global.fetch as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://sync.example.com/tenant-a/sync/docs/events?dbId=contacts",
    );
    expect((init.headers as Record<string, string>)["Accept"]).toBe("text/event-stream");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token");
  });

  test("ignores malformed change payloads instead of failing the stream", async () => {
    global.fetch = jest.fn(async () =>
      sseResponse([
        "event: change\ndata: {not-json\n\n",
        'event: change\ndata: {"storeKind":"docs"}\n\n', // missing dbId → dropped
        'event: change\ndata: {"dbId":"contacts","storeKind":"docs"}\n\n',
      ]),
    ) as typeof fetch;

    const events: StoreChangeEvent[] = [];
    await makeTransport().subscribeToChanges("token", (event) => events.push(event));

    expect(events).toEqual([{ dbId: "contacts", storeKind: "docs" }]);
  });

  test("rejects with INVALID_TOKEN on a 401 response", async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    ) as typeof fetch;

    await expect(
      makeTransport().subscribeToChanges("bad-token", () => {}),
    ).rejects.toMatchObject({ name: "NetworkError", type: NetworkErrorType.INVALID_TOKEN });
  });

  test("treats environments without response streaming as unsupported", async () => {
    global.fetch = jest.fn(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "body", { value: null });
      return response;
    }) as typeof fetch;

    await expect(
      makeTransport().subscribeToChanges("token", () => {}),
    ).rejects.toThrow(/streaming/);
  });

  test("resolves quietly when the caller aborts mid-stream", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            encoder.encode('event: change\ndata: {"dbId":"contacts","storeKind":"docs"}\n\n'),
          );
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            streamController.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const events: StoreChangeEvent[] = [];
    const subscription = makeTransport().subscribeToChanges(
      "token",
      (event) => {
        events.push(event);
        controller.abort();
      },
      { signal: controller.signal },
    );

    await expect(subscription).resolves.toBeUndefined();
    expect(events.length).toBe(1);
  });
});
