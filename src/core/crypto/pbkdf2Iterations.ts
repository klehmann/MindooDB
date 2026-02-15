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
