/**
 * Client transport for RFC 3161 timestamps.
 *
 * Two paths, because no single one works everywhere:
 *
 * - **Direct.** `https://rfc3161.ai.moda` is the only public TSA measured to
 *   send CORS headers, so a browser can reach it unaided. This keeps sealing
 *   working on a Haven with no MindooDB server at all.
 * - **Proxy.** Everything else is http-only or CORS-less — including every
 *   eIDAS-qualified authority — so those go through the tenant's server at
 *   `POST /:tenantId/timestamps/rfc3161`.
 *
 * Both carry opaque DER. **Neither is trusted.** The caller must verify that
 * the returned token's `messageImprint` equals the digest it sent and that the
 * token chains to a trusted root (see `verifyTimestampResponse` in
 * `mindoodb-seal`). With those two checks a hostile transport can withhold a
 * timestamp but cannot forge one, which is why calling a third-party proxy from
 * the browser is acceptable at all.
 */

export const TIMESTAMP_QUERY_CONTENT_TYPE = "application/timestamp-query";
export const TIMESTAMP_REPLY_CONTENT_TYPE = "application/timestamp-reply";

/** Bound on an accepted TimeStampResp; real tokens are a few KB. */
export const MAX_TIMESTAMP_RESPONSE_BYTES = 128 * 1024;
export const DEFAULT_TIMESTAMP_TIMEOUT_MS = 15_000;

/**
 * The one public TSA a browser can call directly (verified by CORS preflight:
 * reflected origin, `POST, OPTIONS`, `Content-Type`). It is a failover proxy in
 * front of DigiCert, Sectigo, Azure and others, so its tokens chain to roots
 * already in public trust stores.
 */
export const BROWSER_REACHABLE_TSA = Object.freeze({
  id: "aimoda",
  name: "ai.moda RFC 3161 proxy",
  url: "https://rfc3161.ai.moda",
});

export type TimestampSource = "direct" | "proxy";

export interface TimestampTokenResult {
  /** Raw DER TimeStampResp, unverified. */
  response: Uint8Array;
  providerId: string;
  source: TimestampSource;
}

export class TimestampRequestError extends Error {
  constructor(
    message: string,
    readonly source: TimestampSource,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "TimestampRequestError";
  }
}

interface PostTimestampOptions {
  request: Uint8Array;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

async function postTimestampQuery(
  url: string,
  source: TimestampSource,
  options: PostTimestampOptions & { headers?: Record<string, string> },
): Promise<Uint8Array> {
  const {
    request,
    timeoutMs = DEFAULT_TIMESTAMP_TIMEOUT_MS,
    fetchImpl = fetch,
    maxResponseBytes = MAX_TIMESTAMP_RESPONSE_BYTES,
    headers = {},
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": TIMESTAMP_QUERY_CONTENT_TYPE,
        accept: TIMESTAMP_REPLY_CONTENT_TYPE,
        ...headers,
      },
      body: request.slice().buffer as ArrayBuffer,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new TimestampRequestError(
        `Timestamp request failed with HTTP ${response.status}`,
        source,
        response.status,
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new TimestampRequestError("Timestamp authority returned an empty response", source);
    }
    if (buffer.byteLength > maxResponseBytes) {
      throw new TimestampRequestError(
        `Timestamp response too large (${buffer.byteLength} bytes)`,
        source,
      );
    }
    // Cheap sanity check; the real validation is CMS verification by the caller.
    if (buffer[0] !== 0x30) {
      throw new TimestampRequestError("Timestamp response is not DER-encoded", source);
    }
    return buffer;
  } catch (error) {
    if (error instanceof TimestampRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new TimestampRequestError(`Timestamp request timed out after ${timeoutMs}ms`, source);
    }
    throw new TimestampRequestError(
      `Timestamp request failed: ${error instanceof Error ? error.message : String(error)}`,
      source,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Call a CORS-enabled TSA straight from the client. */
export async function requestTimestampDirect(
  options: PostTimestampOptions & { url?: string; providerId?: string },
): Promise<TimestampTokenResult> {
  const url = options.url ?? BROWSER_REACHABLE_TSA.url;
  const response = await postTimestampQuery(url, "direct", options);
  return {
    response,
    providerId: options.providerId ?? BROWSER_REACHABLE_TSA.id,
    source: "direct",
  };
}

export interface ProxyTimestampOptions extends PostTimestampOptions {
  /** Base URL of the MindooDB server, e.g. `https://sync.example.com`. */
  serverUrl: string;
  tenantId: string;
  /** Bearer token from the tenant's existing authenticated session. */
  authToken: string;
  /** Provider id from the server's advertised list. Never a URL — the server allowlists. */
  providerId?: string;
}

/** Route through the tenant's MindooDB server, for http-only or CORS-less authorities. */
export async function requestTimestampViaProxy(
  options: ProxyTimestampOptions,
): Promise<TimestampTokenResult> {
  const base = options.serverUrl.replace(/\/+$/, "");
  const query = options.providerId ? `?provider=${encodeURIComponent(options.providerId)}` : "";
  const url = `${base}/${encodeURIComponent(options.tenantId)}/timestamps/rfc3161${query}`;

  const response = await postTimestampQuery(url, "proxy", {
    ...options,
    headers: { authorization: `Bearer ${options.authToken}` },
  });

  return {
    response,
    providerId: options.providerId ?? "server",
    source: "proxy",
  };
}

export interface TimestampWithFallbackOptions extends PostTimestampOptions {
  /** Proxy details, when the client has an authenticated server connection. */
  proxy?: Omit<ProxyTimestampOptions, keyof PostTimestampOptions>;
  /** Try the proxy first — the right order when the tenant has a qualified provider configured. */
  preferProxy?: boolean;
  /** Skip the direct call (air-gapped deployments, or policy against third-party endpoints). */
  allowDirect?: boolean;
}

/**
 * Try both transports, returning the first token obtained.
 *
 * A seal is worth little without a timestamp, so failing over is worth the
 * extra round trip. The order is caller-chosen because it is a policy question,
 * not a technical one: a tenant with a qualified provider configured wants the
 * proxy first, while a laptop with no server reachable wants the direct path.
 */
export async function requestTimestampWithFallback(
  options: TimestampWithFallbackOptions,
): Promise<TimestampTokenResult> {
  const { proxy, preferProxy = false, allowDirect = true, ...post } = options;

  const attempts: Array<() => Promise<TimestampTokenResult>> = [];
  const direct = () => requestTimestampDirect(post);
  const viaProxy = proxy ? () => requestTimestampViaProxy({ ...proxy, ...post }) : undefined;

  if (preferProxy && viaProxy) {
    attempts.push(viaProxy);
    if (allowDirect) attempts.push(direct);
  } else {
    if (allowDirect) attempts.push(direct);
    if (viaProxy) attempts.push(viaProxy);
  }

  if (attempts.length === 0) {
    throw new TimestampRequestError("No timestamp transport is available", "direct");
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new TimestampRequestError(
    `No timestamp authority could be reached (${errors.join("; ")})`,
    "direct",
  );
}
