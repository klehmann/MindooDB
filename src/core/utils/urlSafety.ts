/**
 * Cross-platform URL safety helpers for SSRF mitigation.
 *
 * A MindooDB server can be told (by an authenticated admin) to sync FROM an
 * arbitrary remote URL, and a remote server can answer a server-initiated fetch
 * with a redirect. Both are SSRF vectors: an attacker could point the fetch at
 * cloud metadata endpoints (`169.254.169.254`), loopback admin panels, or other
 * internal services. These helpers reject obviously-internal targets using only
 * literal parsing — no DNS — so they run unchanged in the browser and Node.
 *
 * DNS-rebinding (a public name that resolves to a private IP) is NOT covered by
 * literal parsing; the Node server additionally re-validates after resolution
 * where it can. Literal blocking removes the cheap, high-signal vectors and is
 * the portable baseline.
 */

/** Thrown when a URL is rejected by {@link assertSafeSyncUrl}. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeUrlOptions {
  /**
   * Require the `https:` scheme. Defaults to `true`. Set to `false` only for
   * trusted local development where a plaintext sync server is acceptable.
   */
  requireHttps?: boolean;
  /**
   * Allow loopback/private/link-local hosts. Defaults to `false`. Set to `true`
   * only for development/test against a local server.
   */
  allowPrivate?: boolean;
}

/** Strip IPv6 brackets and a zone id, lowercase the host. */
function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) {
    host = host.slice(0, zoneIdx);
  }
  return host;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** True for an IPv4 literal in a loopback/private/link-local/reserved range. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Malformed dotted-quad: treat as unsafe rather than guess.
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/** True for an IPv6 literal that is loopback/link-local/ULA/unspecified/mapped. */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local (fc00::/7)
  // IPv4-mapped (::ffff:a.b.c.d) — evaluate the embedded IPv4.
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * True when the host is a literal loopback/private/link-local address or a
 * well-known internal name. DNS names that are not obviously internal pass here
 * and (on the server) are re-checked after resolution.
 */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "ip6-localhost" || host === "ip6-loopback") return true;
  // `.local` mDNS and the unqualified metadata alias used by some clouds.
  if (host.endsWith(".local")) return true;
  if (host === "metadata" || host === "metadata.google.internal") return true;
  if (host.includes(":") && !isIpv4(host)) return isPrivateIpv6(host);
  if (isIpv4(host)) return isPrivateIpv4(host);
  return false;
}

/**
 * Parse and validate a sync-server URL, throwing {@link UnsafeUrlError} when it
 * uses a disallowed scheme or targets an internal host. Returns the parsed URL
 * on success.
 */
export function assertSafeSyncUrl(rawUrl: string, options: SafeUrlOptions = {}): URL {
  const requireHttps = options.requireHttps ?? true;
  const allowPrivate = options.allowPrivate ?? false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Invalid sync URL: ${rawUrl}`);
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "https:" && scheme !== "http:") {
    throw new UnsafeUrlError(`Unsupported URL scheme "${parsed.protocol}" (only http/https allowed)`);
  }
  if (requireHttps && scheme !== "https:") {
    throw new UnsafeUrlError(`Sync URL must use https (got "${parsed.protocol}")`);
  }
  if (!allowPrivate && isBlockedHostLiteral(parsed.hostname)) {
    throw new UnsafeUrlError(
      `Sync URL host "${parsed.hostname}" is a loopback/private/link-local address and is not allowed`,
    );
  }
  return parsed;
}

/** True when two URLs share scheme, hostname and (normalized) port. */
export function isSameOrigin(a: URL, b: URL): boolean {
  const portOf = (u: URL) => (u.port !== "" ? u.port : u.protocol === "https:" ? "443" : "80");
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    portOf(a) === portOf(b)
  );
}
