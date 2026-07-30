/**
 * RFC 3161 timestamp proxy.
 *
 * Sealing a document (see the TeamSketchbook seal feature) needs a third-party
 * attested time: the client hashes its own signature and asks a Time-Stamping
 * Authority to sign that hash together with the TSA's clock reading.
 *
 * Most public TSAs cannot be called from a browser — they are http-only or send
 * no CORS headers — so the server offers an authenticated proxy. It forwards
 * opaque DER bytes and never parses them; the *client* verifies the returned
 * token (messageImprint equality and chain to a trusted root), which is what
 * makes a hostile or buggy proxy a denial-of-service risk rather than a forgery
 * risk.
 *
 * SSRF is the hazard a forwarding endpoint always carries, so target URLs come
 * only from server-side env config. A client may name a provider `id`; it can
 * never supply a URL.
 */

import { assertSafeSyncUrl, UnsafeUrlError } from "../../core/utils/urlSafety.js";

/** Content type mandated by RFC 3161 §3.4 for a request. */
export const TIMESTAMP_QUERY_CONTENT_TYPE = "application/timestamp-query";
/** Content type mandated by RFC 3161 §3.4 for a response. */
export const TIMESTAMP_REPLY_CONTENT_TYPE = "application/timestamp-reply";

/**
 * A TimeStampReq is a hash plus a little ASN.1 framing — a few hundred bytes at
 * most. Anything larger is either a bug or an attempt to use us as an upload
 * relay.
 */
export const MAX_TIMESTAMP_REQUEST_BYTES = 8 * 1024;
/**
 * A TimeStampResp carries the token and the TSA certificate chain. Real tokens
 * run 2–8 KB; the cap bounds memory when an upstream misbehaves.
 */
export const MAX_TIMESTAMP_RESPONSE_BYTES = 128 * 1024;
/** Per-provider timeout. Failover to the next provider is preferable to waiting. */
export const DEFAULT_TIMESTAMP_TIMEOUT_MS = 10_000;

/** A configured upstream TSA, including the URL that never leaves the server. */
export interface TsaProviderConfig {
  id: string;
  name: string;
  url: string;
  /** TSA policy OID to request, when the provider publishes one. */
  policyOid?: string;
  /** eIDAS-qualified (or equivalent national-scheme) trust service. */
  qualified: boolean;
  /**
   * Whether the token chains to a root that ships in common trust stores. When
   * false the verifier must be handed the chain explicitly — the evidence
   * bundle does that anyway, but it changes what third-party tooling can check
   * unaided.
   */
  rootInPublicTrustStores: boolean;
}

/** The provider description advertised to clients — deliberately without `url`. */
export type PublicTsaProvider = Omit<TsaProviderConfig, "url">;

/**
 * Providers a client can name by id without the operator writing a URL.
 *
 * Terms of use differ and are the operator's call, which is why nothing here is
 * enabled by default:
 * - `aimoda` and `opentsa` state that general production use is fine;
 * - `freetsa` is a community service with no usage restriction;
 * - the DigiCert/Sectigo endpoints are provided for their own certificate
 *   customers' code signing, so using them as general infrastructure is not
 *   clearly permitted — they are listed for completeness, not recommended.
 */
export const BUILT_IN_TSA_PROVIDERS: Readonly<Record<string, TsaProviderConfig>> = Object.freeze({
  aimoda: {
    id: "aimoda",
    name: "ai.moda RFC 3161 proxy",
    url: "https://rfc3161.ai.moda",
    qualified: false,
    rootInPublicTrustStores: true,
  },
  opentsa: {
    id: "opentsa",
    name: "Open TSA (open-tsa.eu)",
    url: "https://tsr.open-tsa.eu",
    qualified: false,
    rootInPublicTrustStores: false,
  },
  freetsa: {
    id: "freetsa",
    name: "FreeTSA",
    url: "https://freetsa.org/tsr",
    qualified: false,
    rootInPublicTrustStores: false,
  },
  digicert: {
    id: "digicert",
    name: "DigiCert",
    url: "http://timestamp.digicert.com",
    qualified: false,
    rootInPublicTrustStores: true,
  },
  sectigo: {
    id: "sectigo",
    name: "Sectigo",
    url: "http://timestamp.sectigo.com",
    qualified: false,
    rootInPublicTrustStores: true,
  },
  "sectigo-qualified": {
    id: "sectigo-qualified",
    name: "Sectigo Qualified",
    url: "http://timestamp.sectigo.com/qualified",
    qualified: true,
    rootInPublicTrustStores: true,
  },
});

/** Provider ids are used in URLs, filenames and manifests — keep them boring. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ParseTsaProvidersOptions {
  /** Permit http and loopback/private targets (local development, self-hosted TSA on the same box). */
  allowInsecureUrls?: boolean;
  /** Sink for configuration warnings; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Parse `MINDOODB_TSA_PROVIDERS`.
 *
 * Comma-separated entries, each either a built-in id (`aimoda`) or a custom
 * `id=url` pair (`inhouse=https://tsa.corp.example/tsr`). A trailing `!` on an
 * entry marks it qualified, and `+` marks its root as publicly trusted:
 *
 *   MINDOODB_TSA_PROVIDERS="aimoda,opentsa,belgium=http://tsa.belgium.be/connect!+"
 *
 * Unset or empty disables the proxy entirely. That is the safe default: a
 * forwarding endpoint is outbound network access the operator should opt into,
 * and Haven can still reach the browser-callable TSA directly without it.
 */
export function parseTsaProviders(
  raw: string | undefined,
  options: ParseTsaProvidersOptions = {},
): TsaProviderConfig[] {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const allowInsecure = options.allowInsecureUrls ?? false;

  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const providers: TsaProviderConfig[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let spec = entry;
    let qualified = false;
    let publiclyTrusted: boolean | undefined;

    // Flags are suffixes so a URL containing them is still parsed correctly.
    while (spec.endsWith("!") || spec.endsWith("+")) {
      if (spec.endsWith("!")) qualified = true;
      else publiclyTrusted = true;
      spec = spec.slice(0, -1);
    }

    const eq = spec.indexOf("=");
    const id = (eq === -1 ? spec : spec.slice(0, eq)).trim().toLowerCase();
    const url = eq === -1 ? undefined : spec.slice(eq + 1).trim();

    if (!PROVIDER_ID_PATTERN.test(id)) {
      warn(`[timestampProxy] Ignoring TSA provider "${entry}": invalid id "${id}"`);
      continue;
    }
    if (seen.has(id)) {
      warn(`[timestampProxy] Ignoring duplicate TSA provider id "${id}"`);
      continue;
    }

    let resolved: TsaProviderConfig;
    if (url === undefined) {
      const builtIn = BUILT_IN_TSA_PROVIDERS[id];
      if (!builtIn) {
        warn(
          `[timestampProxy] Ignoring TSA provider "${id}": not a built-in id and no URL given (use "${id}=https://...")`,
        );
        continue;
      }
      resolved = { ...builtIn };
      if (qualified) resolved.qualified = true;
      if (publiclyTrusted !== undefined) resolved.rootInPublicTrustStores = publiclyTrusted;
    } else {
      resolved = {
        id,
        name: id,
        url,
        qualified,
        rootInPublicTrustStores: publiclyTrusted ?? false,
      };
    }

    try {
      // http is deliberately allowed: every eIDAS-qualified TSA we can use is
      // http-only. The token is signed, so transport confidentiality only hides
      // an opaque hash. Internal hosts stay blocked — that is the SSRF guard.
      assertSafeSyncUrl(resolved.url, {
        requireHttps: false,
        allowPrivate: allowInsecure,
      });
    } catch (error) {
      const reason = error instanceof UnsafeUrlError ? error.message : String(error);
      warn(`[timestampProxy] Ignoring TSA provider "${id}": ${reason}`);
      continue;
    }

    seen.add(id);
    providers.push(resolved);
  }

  return providers;
}

/** Drop the URL before a provider list is handed to a client. */
export function toPublicTsaProviders(providers: TsaProviderConfig[]): PublicTsaProvider[] {
  return providers.map(({ url: _url, ...rest }) => ({ ...rest }));
}

export class TimestampProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Per-provider failures, for logging and for a client that wants to retry elsewhere. */
    readonly attempts: TimestampAttempt[] = [],
  ) {
    super(message);
    this.name = "TimestampProxyError";
  }
}

export interface TimestampAttempt {
  providerId: string;
  ok: boolean;
  error?: string;
  httpStatus?: number;
  durationMs: number;
}

export interface TimestampProxyResult {
  providerId: string;
  providerName: string;
  /** Raw DER TimeStampResp. The caller does not interpret it. */
  response: Uint8Array;
  attempts: TimestampAttempt[];
}

export interface RequestTimestampOptions {
  providers: TsaProviderConfig[];
  /** DER-encoded TimeStampReq. */
  request: Uint8Array;
  /** Try this provider first; others remain as failover. */
  preferredProviderId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Read a response body with a hard byte cap.
 *
 * `response.arrayBuffer()` would buffer whatever the upstream sends; a TSA that
 * answers with a gigabyte (hostile, or simply broken) must not be able to take
 * the process down with it.
 */
async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`response too large (${declaredBytes} bytes, max ${maxBytes})`);
    }
  }

  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`response too large (${buffer.byteLength} bytes, max ${maxBytes})`);
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response too large (over ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    // Abandoning a partially-read body leaks the socket otherwise.
    void body.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Reject an answer that is obviously not DER before it reaches the client. */
function assertLooksLikeTimestampResponse(bytes: Uint8Array, contentType: string | null): void {
  if (bytes.byteLength < 2) {
    throw new Error("empty response");
  }
  // Every TimeStampResp is a DER SEQUENCE.
  if (bytes[0] !== 0x30) {
    const hint = contentType ? ` (content-type "${contentType}")` : "";
    throw new Error(`response is not DER${hint}`);
  }
  if (contentType) {
    const normalized = contentType.split(";")[0]!.trim().toLowerCase();
    // Some deployments answer `application/octet-stream`; only reject types that
    // are certainly wrong, such as an HTML error page from a captive proxy.
    if (normalized.startsWith("text/") || normalized === "application/json") {
      throw new Error(`unexpected content-type "${normalized}"`);
    }
  }
}

/**
 * POST the request to each provider in turn, returning the first DER answer.
 *
 * Failover is per-provider and the reason for each failure is preserved: an
 * operator debugging "sealing stopped working" needs to see that provider A
 * timed out and provider B answered 403, not a single opaque 502.
 */
export async function requestTimestampToken(
  options: RequestTimestampOptions,
): Promise<TimestampProxyResult> {
  const {
    providers,
    request,
    preferredProviderId,
    timeoutMs = DEFAULT_TIMESTAMP_TIMEOUT_MS,
    maxResponseBytes = MAX_TIMESTAMP_RESPONSE_BYTES,
    fetchImpl = fetch,
  } = options;

  if (providers.length === 0) {
    throw new TimestampProxyError("Timestamping is not enabled on this server", 503);
  }
  if (request.byteLength === 0) {
    throw new TimestampProxyError("Empty timestamp request", 400);
  }
  if (request.byteLength > MAX_TIMESTAMP_REQUEST_BYTES) {
    throw new TimestampProxyError(
      `Timestamp request too large (${request.byteLength} bytes, max ${MAX_TIMESTAMP_REQUEST_BYTES})`,
      413,
    );
  }
  if (request[0] !== 0x30) {
    throw new TimestampProxyError("Timestamp request is not DER-encoded", 400);
  }

  let ordered = providers;
  if (preferredProviderId) {
    const preferred = providers.find((provider) => provider.id === preferredProviderId);
    if (!preferred) {
      throw new TimestampProxyError(`Unknown timestamp provider "${preferredProviderId}"`, 400);
    }
    ordered = [preferred, ...providers.filter((provider) => provider.id !== preferred.id)];
  }

  const attempts: TimestampAttempt[] = [];

  for (const provider of ordered) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(provider.url, {
        method: "POST",
        headers: {
          "content-type": TIMESTAMP_QUERY_CONTENT_TYPE,
          accept: TIMESTAMP_REPLY_CONTENT_TYPE,
        },
        // A copy, because `fetch` may retain the buffer past this call.
        body: request.slice().buffer as ArrayBuffer,
        // Following a redirect would let an upstream re-point us at an internal
        // host, defeating the URL allowlist.
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        attempts.push({
          providerId: provider.id,
          ok: false,
          httpStatus: response.status,
          error: `HTTP ${response.status}`,
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      const bytes = await readCappedBody(response, maxResponseBytes);
      assertLooksLikeTimestampResponse(bytes, response.headers.get("content-type"));

      attempts.push({
        providerId: provider.id,
        ok: true,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      return {
        providerId: provider.id,
        providerName: provider.name,
        response: bytes,
        attempts,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      attempts.push({
        providerId: provider.id,
        ok: false,
        error: aborted ? `timed out after ${timeoutMs}ms` : String(error instanceof Error ? error.message : error),
        durationMs: Date.now() - startedAt,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new TimestampProxyError("No timestamp provider could be reached", 502, attempts);
}
