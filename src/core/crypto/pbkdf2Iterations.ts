export const DEFAULT_PBKDF2_ITERATIONS = 310000;
export const MIN_PBKDF2_ITERATIONS = 60000;

/**
 * Resolve PBKDF2 iterations from runtime overrides with safe bounds.
 *
 * Override order:
 * 1) globalThis.__MINDOODB_PBKDF2_ITERATIONS (useful for RN/Expo runtime config)
 * 2) process.env.MINDOODB_PBKDF2_ITERATIONS
 * 3) defaultIterations
 */
export function resolvePbkdf2Iterations(defaultIterations: number = DEFAULT_PBKDF2_ITERATIONS): number {
  const override = readOverride();
  if (override === undefined) {
    return defaultIterations;
  }

  const parsed = Number(override);
  if (!Number.isFinite(parsed)) {
    return defaultIterations;
  }

  const intValue = Math.floor(parsed);
  if (intValue < MIN_PBKDF2_ITERATIONS) {
    return MIN_PBKDF2_ITERATIONS;
  }
  return intValue;
}

/**
 * Resolve the PBKDF2 iteration count to use when DECRYPTING a stored key blob.
 *
 * Security hardening: a stored blob's `iterations` value is
 * attacker-influenceable (a stolen identity file with `"iterations": 1` would
 * otherwise make offline password cracking trivially cheap). We therefore floor
 * any stored value at {@link MIN_PBKDF2_ITERATIONS}. This is backward compatible
 * because every legitimately-written blob already used at least the floor on the
 * encrypt path; flooring a tampered/too-low value simply derives a different key
 * and the AES-GCM tag check then fails (a safe denial, not a downgrade).
 */
export function resolveStoredIterations(stored: number | undefined | null): number {
  const fallback = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
  if (stored === undefined || stored === null) {
    return fallback;
  }
  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(parsed));
}

function readOverride(): unknown {
  try {
    if (typeof globalThis !== "undefined") {
      const g = globalThis as typeof globalThis & { __MINDOODB_PBKDF2_ITERATIONS?: unknown };
      if (g.__MINDOODB_PBKDF2_ITERATIONS !== undefined) {
        return g.__MINDOODB_PBKDF2_ITERATIONS;
      }
    }
  } catch {
    // no-op
  }

  try {
    if (typeof process !== "undefined" && process.env) {
      const fromEnv = process.env.MINDOODB_PBKDF2_ITERATIONS;
      if (fromEnv !== undefined) {
        return fromEnv;
      }
    }
  } catch {
    // no-op
  }

  return undefined;
}
