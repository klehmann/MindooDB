/**
 * Rate-limit resolution shared by the server's limiter tiers.
 *
 * Kept out of {@link MindooDBServer} so the interaction between the global net
 * and the per-route tiers is testable on its own: it is the part that is easy
 * to get wrong, and getting it wrong is silent — a global cap below a tier cap
 * simply replaces that tier, and the tier's configuration stops meaning
 * anything.
 */

import type { ServerRateLimitsConfig } from "./types";

export interface ResolvedRateLimit {
  windowMs: number;
  max: number;
}

export interface ResolvedGlobalRateLimit extends ResolvedRateLimit {
  /** Requests the tiers may spend inside the global window, plus headroom. */
  tierFloor: number;
  /** True when the resolved max rejects traffic a tier would still allow. */
  shadowsTiers: boolean;
}

/**
 * Resolve the global limiter against the tiers it is supposed to back up.
 *
 * Without an explicit `rateLimits.global`, the ceiling is derived from the
 * tiers so the net catches only traffic no tier claims. An explicit value is
 * honoured — an operator may want a hard cap — but reported as shadowing so
 * the caller can say so at startup instead of leaving it to be discovered as
 * mysterious 429s.
 */
export function resolveGlobalRateLimit(
  configured: ServerRateLimitsConfig["global"],
  tiers: {
    sync: ResolvedRateLimit;
    auth: ResolvedRateLimit;
    defaultWindowMs: number;
    headroom: number;
  },
): ResolvedGlobalRateLimit {
  const windowMs = configured?.windowMs ?? tiers.defaultWindowMs;

  // Tier windows need not match the global one; compare rates, not raw maxima.
  const perWindow = (tier: ResolvedRateLimit): number =>
    Math.ceil((tier.max / tier.windowMs) * windowMs);
  const tierFloor = perWindow(tiers.sync) + perWindow(tiers.auth) + tiers.headroom;

  if (configured?.max === undefined) {
    return { windowMs, max: tierFloor, tierFloor, shadowsTiers: false };
  }
  return {
    windowMs,
    max: configured.max,
    tierFloor,
    shadowsTiers: configured.max < tierFloor,
  };
}

/**
 * Bucket key for the sync tier.
 *
 * The principal is what makes this usable behind a NAT or a CDN: keyed on the
 * address alone, one client opening several databases spends everyone else's
 * budget. The address stays in the key so that callers we could not
 * authenticate still get separated per source rather than sharing one
 * "anonymous" bucket.
 */
export function buildSyncRateLimitKey(
  tenantId: string | undefined,
  principal: string | undefined,
  ip: string | undefined,
): string {
  return `sync:${tenantId ?? "unknown"}:${principal ?? "anonymous"}:${ip ?? "unknown"}`;
}

/**
 * Rate-limit defaults. Auth and sync have separate tiers because a single
 * challenge/authenticate handshake is two requests; with multiple tenants,
 * store kinds, and token renewals the auth budget exhausts quickly if set
 * too low. These can be overridden in config.json under `rateLimits.auth`
 * and `rateLimits.sync`.
 */
export const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 120;
export const DEFAULT_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Sync is keyed per authenticated principal, and a client legitimately opens
 * several databases at once: a host like Teacher's Desk reads six, and a cold
 * pass over one of them costs a few hundred batched requests. A budget sized
 * for a single database turns that normal open into a throttled one.
 */
export const DEFAULT_SYNC_RATE_LIMIT_MAX = 3_000;

/**
 * The global limiter is a coarse net for unauthenticated floods and unknown
 * routes; the per-tier limiters are the real budgets. It runs first, so a
 * global max below a tier max silently replaces that tier — the sync budget
 * was unreachable while this was a hardcoded 500. The default is therefore
 * derived from the tiers, and an override that would shadow one is honoured
 * but flagged at startup rather than quietly applied.
 */
export const DEFAULT_GLOBAL_RATE_LIMIT_WINDOW_MS = 60_000;
export const GLOBAL_RATE_LIMIT_TIER_HEADROOM = 500;

/**
 * Timestamping gets its own budget rather than sharing the sync one. Sync is
 * chatty and high-volume; sealing a document is a deliberate, rare user action.
 * Sharing a bucket would let ordinary sync traffic starve the seal endpoint, and
 * a runaway seal loop degrade sync.
 *
 * The daily cap matters more than the burst cap: proxying collapses every user
 * onto the server's IP, so one tenant can exhaust an upstream's per-IP allowance
 * (open-tsa.eu publishes 60/minute) and lock out everyone else on this server.
 */
export const DEFAULT_TIMESTAMP_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_TIMESTAMP_RATE_LIMIT_MAX = 10;
export const DEFAULT_TIMESTAMP_DAILY_LIMIT_MAX = 500;
export const TIMESTAMP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `/system/*` admin routes: aggressive per-IP throttle. */
export const DEFAULT_SYSTEM_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_SYSTEM_RATE_LIMIT_MAX = 30;

/** Device discovery scans every local tenant per request. */
export const DEVICE_DISCOVERY_RATE_LIMIT: ResolvedRateLimit = { windowMs: 60_000, max: 10 };

/** Server-to-server peer routes; replication must not crawl. */
export const PEER_RATE_LIMIT: ResolvedRateLimit = { windowMs: 60_000, max: 600 };

/** Every limiter tier of a server, resolved against `config.json`. */
export interface ServerRateLimitPolicy {
  global: ResolvedGlobalRateLimit;
  auth: ResolvedRateLimit;
  sync: ResolvedRateLimit;
  timestamp: ResolvedRateLimit & { dailyMax: number };
  system: ResolvedRateLimit;
  device: ResolvedRateLimit;
  peer: ResolvedRateLimit;
}

export function resolveServerRateLimits(
  rateLimits: ServerRateLimitsConfig | undefined,
): ServerRateLimitPolicy {
  const auth: ResolvedRateLimit = {
    windowMs: rateLimits?.auth?.windowMs ?? DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
    max: rateLimits?.auth?.max ?? DEFAULT_AUTH_RATE_LIMIT_MAX,
  };
  const sync: ResolvedRateLimit = {
    windowMs: rateLimits?.sync?.windowMs ?? DEFAULT_SYNC_RATE_LIMIT_WINDOW_MS,
    max: rateLimits?.sync?.max ?? DEFAULT_SYNC_RATE_LIMIT_MAX,
  };
  const timestamps = rateLimits?.timestamps;
  return {
    global: resolveGlobalRateLimit(rateLimits?.global, {
      sync,
      auth,
      defaultWindowMs: DEFAULT_GLOBAL_RATE_LIMIT_WINDOW_MS,
      headroom: GLOBAL_RATE_LIMIT_TIER_HEADROOM,
    }),
    auth,
    sync,
    timestamp: {
      windowMs: timestamps?.windowMs ?? DEFAULT_TIMESTAMP_RATE_LIMIT_WINDOW_MS,
      max: timestamps?.max ?? DEFAULT_TIMESTAMP_RATE_LIMIT_MAX,
      dailyMax: timestamps?.dailyMax ?? DEFAULT_TIMESTAMP_DAILY_LIMIT_MAX,
    },
    system: {
      windowMs: rateLimits?.system?.windowMs ?? DEFAULT_SYSTEM_RATE_LIMIT_WINDOW_MS,
      max: rateLimits?.system?.max ?? DEFAULT_SYSTEM_RATE_LIMIT_MAX,
    },
    device: DEVICE_DISCOVERY_RATE_LIMIT,
    peer: PEER_RATE_LIMIT,
  };
}

/**
 * Composite key for the auth tier. Challenge requests include the username so
 * that brute-forcing one account doesn't block legitimate users on the same
 * IP. Authenticate requests omit username because the challenge token is
 * already scoped to a single principal.
 */
export function buildAuthRateLimitKey(
  scope: "system" | "tenant",
  phase: "challenge" | "authenticate",
  tenantId: string | undefined,
  clientIp: string,
  body: { username?: unknown; signingPublicKey?: unknown } | undefined,
): string {
  const tenant = scope === "tenant" ? tenantId ?? "-" : "system";

  if (phase === "challenge") {
    // Bucket by username when supplied, otherwise by the signing public key a
    // key-based client identifies with, so key-based clients still get a
    // stable per-principal bucket instead of all sharing "-".
    const principal = typeof body?.username === "string" && body.username.trim()
      ? body.username.trim().toLowerCase()
      : typeof body?.signingPublicKey === "string" && body.signingPublicKey.trim()
        ? body.signingPublicKey.trim()
        : "-";
    return `${scope}:${tenant}:${phase}:${clientIp}:${principal}`;
  }

  return `${scope}:${tenant}:${phase}:${clientIp}`;
}

/** Bucket key of the timestamp tiers: tenant + principal + IP. */
export function buildTimestampRateLimitKey(
  tier: "burst" | "daily",
  tenantId: string | undefined,
  principal: string | undefined,
  clientIp: string,
): string {
  return `timestamp:${tier}:${tenantId ?? "unknown"}:${principal ?? "anonymous"}:${clientIp}`;
}
