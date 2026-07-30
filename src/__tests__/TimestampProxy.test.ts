/**
 * Tests for the RFC 3161 timestamp proxy: provider allowlist parsing (the SSRF
 * boundary) and the forwarding/failover behaviour.
 */

import {
  BUILT_IN_TSA_PROVIDERS,
  MAX_TIMESTAMP_REQUEST_BYTES,
  parseTsaProviders,
  requestTimestampToken,
  TimestampProxyError,
  toPublicTsaProviders,
  type TsaProviderConfig,
} from "../node/server/timestampProxy";

const silent = () => undefined;

/** Minimal DER SEQUENCE, standing in for a TimeStampReq/Resp. */
function derBytes(length = 8): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x30;
  bytes[1] = length - 2;
  return bytes;
}

function derResponse(bytes: Uint8Array = derBytes(64)): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": "application/timestamp-reply" },
  });
}

describe("parseTsaProviders", () => {
  test("returns nothing when unset, so the proxy is opt-in", () => {
    expect(parseTsaProviders(undefined, { warn: silent })).toEqual([]);
    expect(parseTsaProviders("", { warn: silent })).toEqual([]);
    expect(parseTsaProviders("  , ,", { warn: silent })).toEqual([]);
  });

  test("resolves built-in ids", () => {
    const providers = parseTsaProviders("aimoda,opentsa", { warn: silent });
    expect(providers.map((provider) => provider.id)).toEqual(["aimoda", "opentsa"]);
    expect(providers[0].url).toBe(BUILT_IN_TSA_PROVIDERS.aimoda.url);
  });

  test("accepts custom id=url entries with trust flags", () => {
    const providers = parseTsaProviders("belgium=http://tsa.belgium.be/connect!+", {
      warn: silent,
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "belgium",
      url: "http://tsa.belgium.be/connect",
      qualified: true,
      rootInPublicTrustStores: true,
    });
  });

  test("allows http, because every qualified TSA we can use is http-only", () => {
    const providers = parseTsaProviders("plain=http://tsa.example.com/tsr", { warn: silent });
    expect(providers).toHaveLength(1);
  });

  test.each([
    "internal=http://127.0.0.1:8080/tsr",
    "meta=http://169.254.169.254/latest",
    "loop=http://localhost/tsr",
    "priv=http://10.1.2.3/tsr",
  ])("rejects internal target %s (SSRF)", (entry) => {
    expect(parseTsaProviders(entry, { warn: silent })).toEqual([]);
  });

  test("permits internal targets only when insecure URLs are explicitly allowed", () => {
    const providers = parseTsaProviders("dev=http://127.0.0.1:318/tsr", {
      warn: silent,
      allowInsecureUrls: true,
    });
    expect(providers).toHaveLength(1);
  });

  test.each(["ftp=ftp://tsa.example.com", "bad id=https://tsa.example.com", "UNKNOWN"])(
    "ignores malformed entry %s",
    (entry) => {
      expect(parseTsaProviders(entry, { warn: silent })).toEqual([]);
    },
  );

  test("ignores duplicates, keeping the first", () => {
    const providers = parseTsaProviders("aimoda,aimoda=https://evil.example.com", {
      warn: silent,
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].url).toBe(BUILT_IN_TSA_PROVIDERS.aimoda.url);
  });
});

describe("toPublicTsaProviders", () => {
  test("never advertises the upstream URL", () => {
    const providers = parseTsaProviders("aimoda", { warn: silent });
    const advertised = toPublicTsaProviders(providers);
    expect(advertised[0]).not.toHaveProperty("url");
    expect(advertised[0].id).toBe("aimoda");
  });
});

describe("requestTimestampToken", () => {
  const providers: TsaProviderConfig[] = [
    { id: "first", name: "First", url: "https://tsa-one.example.com", qualified: false, rootInPublicTrustStores: true },
    { id: "second", name: "Second", url: "https://tsa-two.example.com", qualified: false, rootInPublicTrustStores: false },
  ];

  test("forwards the request and returns the DER answer", async () => {
    const token = derBytes(32);
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => derResponse(token));

    const result = await requestTimestampToken({
      providers,
      request: derBytes(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.providerId).toBe("first");
    expect(Array.from(result.response)).toEqual(Array.from(token));
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/timestamp-query",
    );
  });

  test("honours a preferred provider", async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => derResponse());
    const result = await requestTimestampToken({
      providers,
      request: derBytes(),
      preferredProviderId: "second",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.providerId).toBe("second");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://tsa-two.example.com");
  });

  test("rejects a provider id that is not configured", async () => {
    await expect(
      requestTimestampToken({
        providers,
        request: derBytes(),
        preferredProviderId: "https://evil.example.com",
        fetchImpl: (async () => derResponse()) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("fails over to the next provider and records why", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(derResponse());

    const result = await requestTimestampToken({
      providers,
      request: derBytes(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.providerId).toBe("second");
    expect(result.attempts[0]).toMatchObject({ providerId: "first", ok: false, httpStatus: 503 });
  });

  test("reports 502 with per-provider detail when all fail", async () => {
    const fetchImpl = jest.fn(async () => new Response("nope", { status: 500 }));
    const error = await requestTimestampToken({
      providers,
      request: derBytes(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(TimestampProxyError);
    expect((error as TimestampProxyError).status).toBe(502);
    expect((error as TimestampProxyError).attempts).toHaveLength(2);
  });

  test("rejects an answer that is not DER, such as a captive-portal page", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    await expect(
      requestTimestampToken({
        providers: [providers[0]],
        request: derBytes(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(TimestampProxyError);
  });

  test("rejects an oversized response before buffering it", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(derBytes(64).slice().buffer as ArrayBuffer, {
          status: 200,
          headers: {
            "content-type": "application/timestamp-reply",
            "content-length": String(50 * 1024 * 1024),
          },
        }),
    );
    await expect(
      requestTimestampToken({
        providers: [providers[0]],
        request: derBytes(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(TimestampProxyError);
  });

  test("rejects an oversized or non-DER request without contacting anyone", async () => {
    const fetchImpl = jest.fn(async () => derResponse());

    await expect(
      requestTimestampToken({
        providers,
        request: new Uint8Array(MAX_TIMESTAMP_REQUEST_BYTES + 1).fill(0x30),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 413 });

    await expect(
      requestTimestampToken({
        providers,
        request: new Uint8Array([0x01, 0x02]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("reports 503 when no provider is configured", async () => {
    await expect(
      requestTimestampToken({ providers: [], request: derBytes() }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
