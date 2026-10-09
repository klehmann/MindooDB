import { setSemanticTimeSourceForTesting } from "../../core/utils/timeSource";

/**
 * Semantic time (entry createdAt, document lastModified, provisional trusted
 * time) driven by the test instead of the wall clock. Time stands still until
 * the test advances it, so an instant captured between two advances lies
 * strictly between the operations on either side, however slow the machine.
 * Elapsed-time code (timeouts, cooldowns, perf metrics) keeps the real clock.
 */
export interface ManualSemanticClock {
  now(): number;
  /** Move semantic time forward and return the new instant. */
  advance(ms?: number): number;
  /** Jump to an absolute instant (also backwards, to simulate clock skew). */
  set(ms: number): void;
  /** Reinstall whatever time source was active before. */
  restore(): void;
}

export function installManualSemanticClock(start: number = Date.now()): ManualSemanticClock {
  let current = start;
  const previous = setSemanticTimeSourceForTesting(() => current);
  return {
    now: () => current,
    advance: (ms = 10) => {
      current += ms;
      return current;
    },
    set: (ms) => {
      current = ms;
    },
    restore: () => {
      setSemanticTimeSourceForTesting(previous);
    },
  };
}
