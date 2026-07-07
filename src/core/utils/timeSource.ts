/**
 * Semantic time source for MindooDB.
 *
 * Every timestamp that becomes part of persisted or user-visible state —
 * store-entry `createdAt`, document `lastModified`/`_lastModified`, the
 * provisional trusted-time "now" for un-witnessed entries, audit records —
 * must come from {@link semanticNow} instead of calling `Date.now()`
 * directly. Pure elapsed-time measurements (performance metrics, event-loop
 * pacing, in-memory cache TTLs) intentionally keep using `Date.now()`.
 *
 * Why a single funnel:
 * - Tests can pin or quantize the clock (see
 *   {@link createQuantizedTimeSource}) to make same-millisecond timestamp
 *   ties deterministic instead of rare — surfacing tie-handling bugs that
 *   otherwise appear as flaky failures.
 * - It is the seam for upgrading the timestamp scheme later (e.g. a hybrid
 *   logical clock that can never tie or run backwards): only this module
 *   would change, not every call site.
 */

let overrideFn: (() => number) | null = null;

/** Current semantic time in ms since epoch (wall clock unless overridden). */
export function semanticNow(): number {
  return overrideFn ? overrideFn() : Date.now();
}

/**
 * Install (or remove, with `null`) a test-only override for
 * {@link semanticNow}. Not intended for production use.
 */
export function setSemanticTimeSourceForTesting(fn: (() => number) | null): void {
  overrideFn = fn;
}

/**
 * A time source that floors the wall clock to `quantumMs` buckets. Time
 * still advances (timeouts/cooldowns keep working), but all semantic
 * timestamps produced within one quantum collide — making timestamp-tie
 * hazards deterministic for stress testing.
 */
export function createQuantizedTimeSource(quantumMs: number): () => number {
  if (!Number.isFinite(quantumMs) || quantumMs < 1) {
    throw new Error(`Invalid clock quantum: ${quantumMs}`);
  }
  return () => Math.floor(Date.now() / quantumMs) * quantumMs;
}
