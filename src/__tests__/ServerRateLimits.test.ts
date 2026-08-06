import {
  buildSyncRateLimitKey,
  resolveGlobalRateLimit,
} from "../node/server/rateLimits";

const TIERS = {
  sync: { windowMs: 60_000, max: 3_000 },
  auth: { windowMs: 60_000, max: 120 },
  defaultWindowMs: 60_000,
  headroom: 500,
};

describe("global rate limit resolution", () => {
  test("the default leaves room for the tiers to spend their budgets", () => {
    const resolved = resolveGlobalRateLimit(undefined, TIERS);

    expect(resolved.max).toBe(3_000 + 120 + 500);
    expect(resolved.windowMs).toBe(60_000);
    expect(resolved.shadowsTiers).toBe(false);
  });

  test("the default tracks a raised sync ceiling instead of capping it", () => {
    const resolved = resolveGlobalRateLimit(undefined, {
      ...TIERS,
      sync: { windowMs: 60_000, max: 10_000 },
    });

    expect(resolved.max).toBeGreaterThan(10_000);
  });

  test("tier windows shorter than the global one are converted, not compared raw", () => {
    // 100 requests per 10s is 600 per minute, not 100.
    const resolved = resolveGlobalRateLimit(undefined, {
      ...TIERS,
      sync: { windowMs: 10_000, max: 100 },
      auth: { windowMs: 60_000, max: 0 },
    });

    expect(resolved.max).toBe(600 + 0 + 500);
  });

  test("an explicit ceiling below the tiers is honoured but reported as shadowing", () => {
    const resolved = resolveGlobalRateLimit({ max: 500 }, TIERS);

    expect(resolved.max).toBe(500);
    expect(resolved.shadowsTiers).toBe(true);
    expect(resolved.tierFloor).toBe(3_620);
  });

  test("an explicit ceiling above the tiers is not flagged", () => {
    const resolved = resolveGlobalRateLimit({ max: 50_000 }, TIERS);

    expect(resolved.max).toBe(50_000);
    expect(resolved.shadowsTiers).toBe(false);
  });
});

describe("sync rate limit keying", () => {
  test("two identities behind one address get separate budgets", () => {
    const alice = buildSyncRateLimitKey("acme", "alice-device-key", "203.0.113.7");
    const bob = buildSyncRateLimitKey("acme", "bob-device-key", "203.0.113.7");

    expect(alice).not.toBe(bob);
  });

  test("one identity keeps one budget across databases and store kinds", () => {
    // Nothing database- or endpoint-specific belongs in the key: the six
    // databases a host opens must share the caller's budget.
    expect(buildSyncRateLimitKey("acme", "alice-device-key", "203.0.113.7")).toBe(
      buildSyncRateLimitKey("acme", "alice-device-key", "203.0.113.7"),
    );
  });

  test("tenants are separated even for the same address", () => {
    expect(buildSyncRateLimitKey("acme", "alice", "203.0.113.7")).not.toBe(
      buildSyncRateLimitKey("globex", "alice", "203.0.113.7"),
    );
  });

  test("unauthenticated callers are still separated by address", () => {
    expect(buildSyncRateLimitKey("acme", undefined, "203.0.113.7")).not.toBe(
      buildSyncRateLimitKey("acme", undefined, "198.51.100.4"),
    );
  });
});
