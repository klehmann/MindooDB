import type { StoreEntry } from "../core/types";
import { HttpTransport } from "../appendonlystores/network/HttpTransport";
import { NetworkError, NetworkErrorType } from "../core/appendonlystores/network/types";
import {
  BINARY_ENTRIES_CONTENT_TYPE,
  BINARY_GET_ENTRIES_FORMAT,
  BINARY_PUT_ENTRIES_FORMAT,
  decodeBinaryEntryMessage,
  encodeBinaryEntryMessage,
  measureBinaryEntryMessage,
  type BinaryEntryFrame,
} from "../core/appendonlystores/network/binaryEntryFraming";

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

describe("HttpTransport binary wire format v2 (sync-v5 phase 3)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeTransport(): HttpTransport {
    return new HttpTransport({
      baseUrl: "https://sync.example.com/tenant-a",
      tenantId: "tenant-a",
      dbId: "main",
      retryAttempts: 1,
    });
  }

  function serverInfoResponse(): Response {
    return new Response(JSON.stringify({
      name: "CN=sync.example.com",
      signingPublicKey: "signing",
      encryptionPublicKey: "encryption",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function urlOf(input: string | URL | Request): string {
    return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  }

  test("putEntriesBinary sends octet-stream framing with raw payload bytes", async () => {
    const entry = createEntry("bin-1", 64);
    let capturedBody: Uint8Array | null = null;
    let capturedContentType: string | undefined;

    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === "https://sync.example.com/.well-known/mindoodb-server-info") {
        return serverInfoResponse();
      }
      if (url === "https://sync.example.com/tenant-a/sync/docs/putEntriesBinary") {
        capturedContentType = (init?.headers as Record<string, string>)["Content-Type"];
        capturedBody = new Uint8Array(init?.body as ArrayBuffer);
        return new Response(JSON.stringify({
          success: true,
          receipts: [{
            entryType: entry.entryType,
            id: entry.id,
            contentHash: entry.contentHash,
            docId: entry.docId,
            dependencyIds: entry.dependencyIds,
            createdAt: entry.createdAt,
            receiptOrder: 9,
            createdByPublicKey: entry.createdByPublicKey,
            decryptionKeyId: entry.decryptionKeyId,
            signature: Buffer.from(entry.signature).toString("base64"),
            originalSize: entry.originalSize,
            encryptedSize: entry.encryptedSize,
            receivedAt: 1234,
          }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const { receipts, rejected } = await makeTransport().putEntriesBinary("token", [entry]);
    expect(rejected).toHaveLength(0);

    expect(capturedContentType).toBe(BINARY_ENTRIES_CONTENT_TYPE);
    expect(capturedBody).not.toBeNull();

    // The wire body must decode back to the original entry: metadata as JSON,
    // payload as the raw stored bytes (no base64).
    const decoded = decodeBinaryEntryMessage(capturedBody!);
    expect(decoded.header.format).toBe(BINARY_PUT_ENTRIES_FORMAT);
    expect(decoded.header.tenantId).toBe("tenant-a");
    expect(decoded.header.dbId).toBe("main");
    expect(decoded.entries).toHaveLength(1);
    expect(decoded.entries[0].meta.id).toBe("bin-1");
    expect(decoded.entries[0].payload).toEqual(entry.encryptedData);

    // Witness receipts flow back exactly like the JSON endpoint.
    expect(receipts).toHaveLength(1);
    expect(receipts[0].id).toBe("bin-1");
    expect(receipts[0].receiptOrder).toBe(9);
    expect(receipts[0].receivedAt).toBe(1234);
  });

  test("getEntriesBinary decodes the framed response into a session batch", async () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const iv = new Uint8Array(12).fill(3);
    const wrappedKey = new Uint8Array([1, 2, 3, 4]);

    const responseBody = encodeBinaryEntryMessage({
      header: {
        format: BINARY_GET_ENTRIES_FORMAT,
        wrappedSessionKey: Buffer.from(wrappedKey).toString("base64"),
      },
      entries: [{
        meta: {
          entryType: "doc_change",
          id: "get-1",
          contentHash: "hash-get-1",
          docId: "doc-get-1",
          dependencyIds: [],
          createdAt: 1000,
          receiptOrder: 1,
          createdByPublicKey: "pk",
          decryptionKeyId: "default",
          signature: Buffer.from([7, 7]).toString("base64"),
          originalSize: 5,
          encryptedSize: 5,
          iv: Buffer.from(iv).toString("base64"),
        },
        payload,
      }],
    });

    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url === "https://sync.example.com/tenant-a/sync/docs/getEntriesBinary") {
        return new Response(responseBody.buffer as ArrayBuffer, {
          status: 200,
          headers: { "Content-Type": BINARY_ENTRIES_CONTENT_TYPE },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const batch = await makeTransport().getEntriesBinary("token", ["get-1"]);

    expect(batch.wrappedSessionKey).toEqual(wrappedKey);
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].id).toBe("get-1");
    expect(batch.entries[0].iv).toEqual(iv);
    expect(batch.entries[0].sessionEncryptedPayload).toEqual(payload);
  });

  test("getEntriesBinary rejects a response with an unknown format tag", async () => {
    const responseBody = encodeBinaryEntryMessage({
      header: { format: "not-a-real-format", wrappedSessionKey: "a2V5" },
      entries: [],
    });
    global.fetch = jest.fn(async () =>
      new Response(responseBody.buffer as ArrayBuffer, {
        status: 200,
        headers: { "Content-Type": BINARY_ENTRIES_CONTENT_TYPE },
      }),
    ) as typeof fetch;

    await expect(makeTransport().getEntriesBinary("token", ["x"])).rejects.toThrow(
      /unsupported binary entry format/,
    );
  });

  test("putEntriesBinary partitions batches against the advertised body limit", async () => {
    const entries = [createEntry("p1", 1024), createEntry("p2", 1024), createEntry("p3", 1024)];
    // Limit sized for roughly one entry per request.
    const singleFrame: BinaryEntryFrame = {
      meta: serializeEntryForSizing(entries[0]) as unknown as Record<string, unknown>,
      payload: entries[0].encryptedData,
    };
    const limitBytes = measureBinaryEntryMessage(
      { format: BINARY_PUT_ENTRIES_FORMAT, tenantId: "tenant-a", dbId: "main" },
      [singleFrame],
    ) + 64;

    const putCalls: number[] = [];
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
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
      if (url === "https://sync.example.com/tenant-a/sync/docs/putEntriesBinary") {
        const decoded = decodeBinaryEntryMessage(new Uint8Array(init?.body as ArrayBuffer));
        putCalls.push(decoded.entries.length);
        return new Response(JSON.stringify({ success: true, receipts: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    await makeTransport().putEntriesBinary("token", entries);

    expect(putCalls.length).toBeGreaterThanOrEqual(2);
    expect(putCalls.reduce((a, b) => a + b, 0)).toBe(3);
    for (const count of putCalls) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });
});

