/**
 * Shamir's secret sharing over GF(2^8) (docs/userkeys.md §12).
 *
 * Every byte of the secret is the constant term of its own random polynomial
 * of degree `threshold - 1`; share `i` holds the polynomial values at one
 * x-coordinate. Any `threshold` shares give the secret back by Lagrange
 * interpolation at x = 0, fewer reveal nothing about it.
 *
 * Share layout: `[y_0, …, y_(len-1), x]` — the secret's length plus one byte,
 * the x-coordinate last. This is the layout of the audited
 * `shamir-secret-sharing` package (Privy), so shares are interchangeable with
 * it; MindooDB carries its own copy to avoid a runtime dependency on every
 * platform and to draw randomness from the {@link CryptoAdapter}.
 *
 * Arithmetic is in GF(2^8) with the AES reduction polynomial
 * x^8 + x^4 + x^3 + x + 1 (0x11b), using log/exp tables over the generator 3.
 */
import type { CryptoAdapter } from "../crypto/CryptoAdapter";

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by the generator 3: x * 2 xor x, reduced by 0x11b
    let doubled = x << 1;
    if (doubled & 0x100) doubled ^= 0x11b;
    x = doubled ^ x;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]!;
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!;
}

/** Horner evaluation of `coefficients` (constant term first) at `x`. */
function evaluate(coefficients: Uint8Array, x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = mul(result, x) ^ coefficients[i]!;
  }
  return result;
}

/** Distinct non-zero x-coordinates, picked at random. */
function randomXCoordinates(crypto: CryptoAdapter, count: number): number[] {
  const pool: number[] = [];
  for (let x = 1; x <= 255; x++) pool.push(x);
  // Fisher-Yates with rejection sampling, so every order is equally likely.
  const byte = new Uint8Array(1);
  for (let i = pool.length - 1; i > 0; i--) {
    const bound = 256 - (256 % (i + 1));
    let r: number;
    do {
      crypto.getRandomValues(byte);
      r = byte[0]!;
    } while (r >= bound);
    const j = r % (i + 1);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

/**
 * Split `secret` into `shares` shares of which any `threshold` recover it.
 * 2 <= threshold <= shares <= 255.
 */
export function splitSecret(
  crypto: CryptoAdapter,
  secret: Uint8Array,
  shares: number,
  threshold: number,
): Uint8Array[] {
  if (!(secret instanceof Uint8Array) || secret.length === 0) {
    throw new Error("secret must be a non-empty Uint8Array");
  }
  if (!Number.isInteger(shares) || !Number.isInteger(threshold)) {
    throw new Error("shares and threshold must be integers");
  }
  if (threshold < 2 || shares < threshold || shares > 255) {
    throw new Error("need 2 <= threshold <= shares <= 255");
  }
  const xs = randomXCoordinates(crypto, shares);
  const out = xs.map((x) => {
    const share = new Uint8Array(secret.length + 1);
    share[secret.length] = x;
    return share;
  });
  const coefficients = new Uint8Array(threshold);
  for (let byteIndex = 0; byteIndex < secret.length; byteIndex++) {
    coefficients[0] = secret[byteIndex]!;
    crypto.getRandomValues(coefficients.subarray(1));
    for (let s = 0; s < shares; s++) {
      out[s]![byteIndex] = evaluate(coefficients, xs[s]!);
    }
  }
  coefficients.fill(0);
  return out;
}

/**
 * Recover the secret from shares made by {@link splitSecret}. Pass at least
 * `threshold` shares; with fewer, the result is a wrong value, not an error —
 * callers must authenticate it (MindooDB opens an AES-GCM blob with it).
 */
export function combineShares(shares: Uint8Array[]): Uint8Array {
  if (shares.length < 2) throw new Error("need at least two shares");
  const length = shares[0]!.length;
  if (length < 2) throw new Error("share too short");
  const xs: number[] = [];
  for (const share of shares) {
    if (share.length !== length) throw new Error("shares have different lengths");
    const x = share[length - 1]!;
    if (x === 0) throw new Error("invalid share x-coordinate");
    if (xs.includes(x)) throw new Error("duplicate share");
    xs.push(x);
  }
  const secret = new Uint8Array(length - 1);
  for (let byteIndex = 0; byteIndex < length - 1; byteIndex++) {
    let value = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis polynomial i at x = 0: prod_{j != i} x_j / (x_j - x_i);
      // subtraction is xor in GF(2^8).
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        basis = mul(basis, div(xs[j]!, xs[j]! ^ xs[i]!));
      }
      value ^= mul(shares[i]![byteIndex]!, basis);
    }
    secret[byteIndex] = value;
  }
  return secret;
}
