/**
 * Helpers for reading and writing the public-key fields of a `grantaccess`
 * directory document in a way that is forward- and backward-compatible
 * (docs/accesscontrol.md §6.5).
 *
 * There are THREE historical representations, read in this order of authority:
 *
 *  1. `userKeyPairs`: an array of `{ signingPublicKey, encryptionPublicKey,
 *     label? }` objects (the current form). Pairing the keys per device keeps
 *     a device's signing and encryption keys together and lets each carry an
 *     optional human-readable label. This is the canonical form written today.
 *  2. `userSigningPublicKeys` / `userEncryptionPublicKeys`: two parallel string
 *     arrays (previous form). Index-aligned by convention; no labels.
 *  3. `userSigningPublicKey` / `userEncryptionPublicKey`: single legacy scalars
 *     (oldest form).
 *
 * The most specific present form wins. Critically, a present-but-EMPTY higher
 * form is authoritative (it denotes a fully-revoked grant, §6.5): we must NOT
 * fall back to a stale lower form and resurrect access that revocation removed.
 *
 * Writers ({@link applyKeyPairFields}) keep all three forms mirrored so older
 * clients (which only understand the array or scalar forms) keep working.
 *
 * These functions are pure (operate on a plain data object) so they can be
 * reused by the directory cache builder, the time-travel node builder, and the
 * server, and unit-tested in isolation.
 */

import type { GrantKeyPair } from "../types";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function asScalarString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The signing keys from the legacy (pre-`userKeyPairs`) representation: the
 * `userSigningPublicKeys` array if present (authoritative even when empty),
 * else the legacy scalar.
 */
function legacySigningKeys(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.userSigningPublicKeys)) {
    return Array.from(new Set(asStringArray(data.userSigningPublicKeys)));
  }
  const scalar = asScalarString(data.userSigningPublicKey);
  return scalar ? [scalar] : [];
}

/** Encryption keys from the legacy representation (array else scalar). */
function legacyEncryptionKeys(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.userEncryptionPublicKeys)) {
    return Array.from(new Set(asStringArray(data.userEncryptionPublicKeys)));
  }
  const scalar = asScalarString(data.userEncryptionPublicKey);
  return scalar ? [scalar] : [];
}

/**
 * All device key pairs granted by this document, in the canonical
 * `{ signingPublicKey, encryptionPublicKey, label? }` shape (§6.5).
 *
 * Prefers the `userKeyPairs` array (authoritative even when empty). For older
 * documents it reconstructs pairs from the parallel signing/encryption arrays
 * (index-aligned) or the legacy scalars. De-duplicated by signing key.
 */
export function extractKeyPairs(data: Record<string, unknown>): GrantKeyPair[] {
  if (Array.isArray(data.userKeyPairs)) {
    const seen = new Set<string>();
    const pairs: GrantKeyPair[] = [];
    for (const entry of data.userKeyPairs) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const signingPublicKey = asScalarString(rec.signingPublicKey);
      if (!signingPublicKey || seen.has(signingPublicKey)) continue;
      seen.add(signingPublicKey);
      const encryptionPublicKey = asScalarString(rec.encryptionPublicKey) ?? "";
      const label = asLabel(rec.label);
      pairs.push(
        label !== undefined
          ? { signingPublicKey, encryptionPublicKey, label }
          : { signingPublicKey, encryptionPublicKey },
      );
    }
    return pairs;
  }

  // Legacy: reconstruct pairs from the parallel arrays / scalars by index.
  const signing = legacySigningKeys(data);
  const encryption = legacyEncryptionKeys(data);
  const seen = new Set<string>();
  const pairs: GrantKeyPair[] = [];
  signing.forEach((signingPublicKey, index) => {
    if (seen.has(signingPublicKey)) return;
    seen.add(signingPublicKey);
    pairs.push({ signingPublicKey, encryptionPublicKey: encryption[index] ?? "" });
  });
  return pairs;
}

/**
 * Write all three key representations onto `data` from the canonical list of
 * pairs (§6.5), so newer readers use `userKeyPairs` while older readers still
 * see the mirrored array/scalar forms. An empty `pairs` yields empty arrays
 * (authoritative full revocation); the legacy scalars are left untouched in
 * that case (the empty arrays/`userKeyPairs` already prevent resurrection).
 */
export function applyKeyPairFields(data: Record<string, unknown>, pairs: GrantKeyPair[]): void {
  data.userKeyPairs = pairs.map((pair) => {
    const entry: Record<string, unknown> = {
      signingPublicKey: pair.signingPublicKey,
      encryptionPublicKey: pair.encryptionPublicKey,
    };
    if (pair.label !== undefined && pair.label.length > 0) {
      entry.label = pair.label;
    }
    return entry;
  });
  // Mirror the parallel-array form for readers that predate userKeyPairs.
  data.userSigningPublicKeys = pairs.map((pair) => pair.signingPublicKey);
  data.userEncryptionPublicKeys = pairs
    .map((pair) => pair.encryptionPublicKey)
    .filter((key) => key.length > 0);
  // Keep the legacy scalars pointing at the primary (first) pair for the
  // oldest readers. Only updated when at least one pair remains.
  if (pairs.length > 0) {
    data.userSigningPublicKey = pairs[0].signingPublicKey;
    data.userEncryptionPublicKey = pairs[0].encryptionPublicKey;
  }
}

/**
 * Merge `additional` pairs into `existing`, keyed by signing public key. A new
 * entry with the same signing key replaces the existing one (so its encryption
 * key and/or label are updated). Order is preserved: existing pairs first
 * (updated in place), then brand-new pairs in input order.
 */
export function mergeKeyPairs(existing: GrantKeyPair[], additional: GrantKeyPair[]): GrantKeyPair[] {
  const merged = new Map<string, GrantKeyPair>();
  for (const pair of existing) merged.set(pair.signingPublicKey, pair);
  for (const pair of additional) merged.set(pair.signingPublicKey, pair);
  return Array.from(merged.values());
}

/**
 * All signing public keys granted by this document. Prefers `userKeyPairs`,
 * then the `userSigningPublicKeys` array, then the legacy scalar. Returns a
 * de-duplicated list (possibly empty, e.g. when all keys were removed to fully
 * revoke the user).
 */
export function extractSigningPublicKeys(data: Record<string, unknown>): string[] {
  // The canonical `userKeyPairs` form is authoritative once present, even when
  // empty: an empty grant is how a fully-revoked user is represented (§6.5), so
  // we must not fall back to the legacy arrays/scalars in that case.
  if (Array.isArray(data.userKeyPairs)) {
    return Array.from(new Set(extractKeyPairs(data).map((pair) => pair.signingPublicKey)));
  }
  return legacySigningKeys(data);
}

/**
 * All encryption public keys granted by this document. Prefers `userKeyPairs`,
 * then the `userEncryptionPublicKeys` array, then the legacy scalar.
 */
export function extractEncryptionPublicKeys(data: Record<string, unknown>): string[] {
  // See extractSigningPublicKeys: a present (even empty) userKeyPairs is authoritative.
  if (Array.isArray(data.userKeyPairs)) {
    return Array.from(
      new Set(
        extractKeyPairs(data)
          .map((pair) => pair.encryptionPublicKey)
          .filter((key) => key.length > 0),
      ),
    );
  }
  return legacyEncryptionKeys(data);
}

/**
 * The primary signing/encryption key for legacy consumers that still expect a
 * single value. Returns the first array element, else the scalar, else null.
 */
export function primarySigningPublicKey(data: Record<string, unknown>): string | null {
  return extractSigningPublicKeys(data)[0] ?? null;
}

export function primaryEncryptionPublicKey(data: Record<string, unknown>): string | null {
  return extractEncryptionPublicKeys(data)[0] ?? null;
}

/**
 * Signing public keys whose device must wipe the local tenant on next connect
 * (`wipeRequestedForSigningKeys`, §6.5). Self-contained key values, not
 * references into the grant arrays.
 */
export function extractWipeRequestedSigningKeys(data: Record<string, unknown>): string[] {
  return Array.from(new Set(asStringArray(data.wipeRequestedForSigningKeys)));
}
