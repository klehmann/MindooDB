import type { StoreEntry } from "../core/types";
import { HttpTransport } from "../appendonlystores/network/HttpTransport";
import { NetworkError, NetworkErrorType } from "../core/appendonlystores/network/types";

function createEntry(id: string, encryptedBytes: number): StoreEntry {
  return {
    entryType: "attachment_chunk",
    id,
    contentHash: `hash-${id}`,
    docId: `doc-${id}`,
    dependencyIds: [],
    createdAt: 1,
    receiptOrder: 1,
    createdByPublicKey: "-----BEGIN PUBLIC KEY-----\nSIGNING\n-----END PUBLIC KEY-----",
    decryptionKeyId: `key-${id}`,
    signature: new Uint8Array(64).fill(7),
    originalSize: encryptedBytes,
    encryptedSize: encryptedBytes,
    encryptedData: new Uint8Array(encryptedBytes).fill(9),
  };
}

function serializeEntryForSizing(entry: StoreEntry) {
  return {
    entryType: entry.entryType,
    id: entry.id,
    contentHash: entry.contentHash,
    docId: entry.docId,
    dependencyIds: entry.dependencyIds,
    createdAt: entry.createdAt,
    receiptOrder: entry.receiptOrder,
    createdByPublicKey: entry.createdByPublicKey,
    decryptionKeyId: entry.decryptionKeyId,
    signature: Buffer.from(entry.signature).toString("base64"),
    originalSize: entry.originalSize,
    encryptedSize: entry.encryptedSize,
    encryptedData: Buffer.from(entry.encryptedData).toString("base64"),
  };
}

function computePutEntriesBodyBytes(entry: StoreEntry): number {
  return new TextEncoder().encode(JSON.stringify({
    tenantId: "tenant-a",
    dbId: "main",
    entries: [serializeEntryForSizing(entry)],
  })).length;
}

describe("HttpTransport.putEntries", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("batches putEntries to stay within the advertised server body limit", async () => {
    const entry = createEntry("entry-1", 2048);
    const limitBytes = computePutEntriesBodyBytes(entry);
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://sync.example.com/.well-known/mindoodb-server-info") {
        return new Response(JSON.stringify({
          name: "CN=sync.example.com",
          signingPublicKey: "signing",
          encryptionPublicKey: "encryption",
          maxJsonRequestBodyBytes: limitBytes,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://sync.example.com/tenant-a/sync/docs/putEntries") {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 1,
    });

    await transport.putEntries("token", [
      createEntry("entry-1", 2048),
      createEntry("entry-2", 2048),
      createEntry("entry-3", 2048),
    ]);

    const putEntriesCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url === "https://sync.example.com/tenant-a/sync/docs/putEntries";
    });
    expect(putEntriesCalls).toHaveLength(3);
    for (const [, init] of putEntriesCalls) {
      const body = JSON.parse(String(init?.body)) as { entries: Array<{ id: string }> };
      expect(body.entries).toHaveLength(1);
    }
  });

  test("splits and retries putEntries batches after a 413 response", async () => {
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://sync.example.com/.well-known/mindoodb-server-info") {
        return new Response(JSON.stringify({
          name: "CN=sync.example.com",
          signingPublicKey: "signing",
          encryptionPublicKey: "encryption",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://sync.example.com/tenant-a/sync/docs/putEntries") {
        const body = JSON.parse(String(init?.body)) as { entries: Array<{ id: string }> };
        if (body.entries.length > 1) {
          return new Response(JSON.stringify({ error: "Request body too large" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 1,
    });

    await transport.putEntries("token", [
      createEntry("entry-1", 2048),
      createEntry("entry-2", 2048),
    ]);

    const putEntriesCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url === "https://sync.example.com/tenant-a/sync/docs/putEntries";
    });
    expect(putEntriesCalls).toHaveLength(3);
    const batchSizes = putEntriesCalls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { entries: Array<{ id: string }> };
      return body.entries.length;
    });
    expect(batchSizes).toEqual([2, 1, 1]);
  });

  test("fails clearly when a single entry exceeds the advertised server body limit", async () => {
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://sync.example.com/.well-known/mindoodb-server-info") {
        return new Response(JSON.stringify({
          name: "CN=sync.example.com",
          signingPublicKey: "signing",
          encryptionPublicKey: "encryption",
          maxJsonRequestBodyBytes: 32,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 1,
    });

    await expect(transport.putEntries("token", [createEntry("entry-1", 2048)])).rejects.toMatchObject({
      name: "NetworkError",
      type: NetworkErrorType.PAYLOAD_TOO_LARGE,
    } satisfies Partial<NetworkError>);
  });
});

describe("HttpTransport rate limiting", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("does not retry 429 responses", async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ error: "Too many sync requests, please try again later" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }));
    global.fetch = fetchMock as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 3,
      retryDelayMs: 1,
    });

    await expect(transport.findNewEntries("token", [])).rejects.toMatchObject({
      name: "NetworkError",
      type: NetworkErrorType.RATE_LIMITED,
      message: "Too many sync requests, please try again later",
    } satisfies Partial<NetworkError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("captures Retry-After metadata for 429 responses", async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ error: "Too many sync requests, please try again later" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "7",
        },
      }));
    global.fetch = fetchMock as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 1,
    });

    await expect(transport.findNewEntries("token", [])).rejects.toMatchObject({
      name: "NetworkError",
      type: NetworkErrorType.RATE_LIMITED,
      retryAfterMs: 7000,
    } satisfies Partial<NetworkError>);
  });
});

describe("HttpTransport getLatestScanCursor", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("requests the latest scan cursor from the remote store", async () => {
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://sync.example.com/tenant-a/sync/docs/getLatestScanCursor?tenantId=tenant-a&dbId=main") {
        return new Response(JSON.stringify({
          cursor: {
            receiptOrder: 12,
            id: "entry-12",
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 1,
    });

    await expect(transport.getLatestScanCursor("token")).resolves.toEqual({
      receiptOrder: 12,
      id: "entry-12",
    });
  });
});
