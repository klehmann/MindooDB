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
