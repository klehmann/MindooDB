/**
 * Helpers for reading and writing the public-key fields of a `grantaccess`
 * directory document in a way that is forward- and backward-compatible
 * (docs/accesscontrol.md §6.5).
 *
 * Active devices and revoked devices live in TWO SEPARATE lists:
 *
 *  - `userKeyPairs`: the ACTIVE device key pairs, an array of
 *    `{ signingPublicKey, encryptionPublicKey, label? }` objects. Pairing the
 *    keys per device keeps a device's signing and encryption keys together and
 *    lets each carry an optional human-readable label. This is the canonical
 *    list the server/auth treat as granting access. Because revoked devices are
 *    NOT in this list, any reader (old or new) that treats `userKeyPairs` as
 *    "the keys that have access" is correct without understanding revocation.
 *  - `revokedUserKeyPairs`: the RETAINED revoked device key pairs (§6.5), same
 *    shape plus an optional `revokedAt` timestamp. Membership in this list — not
 *    a per-entry flag — is what marks a device revoked. Retaining them lets
 *    admin UIs list "devices with revoked access" and optionally restore them.
 *
 * For older clients that predate `userKeyPairs`, writers also mirror the ACTIVE
 * keys into the legacy forms, read in this order of authority:
 *
 *  1. `userKeyPairs` (the active list above; authoritative once present).
 *  2. `userSigningPublicKeys` / `userEncryptionPublicKeys`: two parallel string
 *     arrays (previous form). Index-aligned by convention; no labels.
 *  3. `userSigningPublicKey` / `userEncryptionPublicKey`: single legacy scalars
 *     (oldest form).
 *
 * The most specific present form wins. Critically, a present-but-EMPTY
 * `userKeyPairs` is authoritative (it denotes a grant with no active devices,
 * §6.5): we must NOT fall back to a stale lower form and resurrect access that
 * revocation removed.
 *
 * Writers ({@link applyKeyPairFields}) keep the legacy forms mirrored so older
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
 * Parse an array of `{ signingPublicKey, encryptionPublicKey, label? }` entries
 * into {@link GrantKeyPair}s, de-duplicated by signing key. When `markRevoked`
 * is set (parsing `revokedUserKeyPairs`), every parsed pair is marked revoked
 * and carries its `revokedAt` timestamp.
 */
function parsePairEntries(value: unknown, markRevoked: boolean): GrantKeyPair[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const pairs: GrantKeyPair[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const signingPublicKey = asScalarString(rec.signingPublicKey);
    if (!signingPublicKey || seen.has(signingPublicKey)) continue;
    seen.add(signingPublicKey);
    const encryptionPublicKey = asScalarString(rec.encryptionPublicKey) ?? "";
    const label = asLabel(rec.label);
    const pair: GrantKeyPair = { signingPublicKey, encryptionPublicKey };
    if (label !== undefined) pair.label = label;
    if (markRevoked) {
      pair.revoked = true;
      if (typeof rec.revokedAt === "number") pair.revokedAt = rec.revokedAt;
    }
    pairs.push(pair);
  }
  return pairs;
}

/** True when the document uses the canonical two-list form (active and/or revoked). */
function hasCanonicalKeyLists(data: Record<string, unknown>): boolean {
  return Array.isArray(data.userKeyPairs) || Array.isArray(data.revokedUserKeyPairs);
}

/** The active pairs from the canonical `userKeyPairs` list. */
function canonicalActivePairs(data: Record<string, unknown>): GrantKeyPair[] {
  return parsePairEntries(data.userKeyPairs, false);
}

/**
 * The revoked pairs from the canonical `revokedUserKeyPairs` list, each marked
 * revoked and carrying its `revokedAt` timestamp.
 */
function canonicalRevokedPairs(data: Record<string, unknown>): GrantKeyPair[] {
  return parsePairEntries(data.revokedUserKeyPairs, true);
}

/** Reconstruct active pairs from the legacy parallel arrays / scalars by index. */
function legacyKeyPairs(data: Record<string, unknown>): GrantKeyPair[] {
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
 * All device key pairs on this document — active first, then revoked — in the
 * canonical `{ signingPublicKey, encryptionPublicKey, label?, revoked?,
 * revokedAt? }` shape (§6.5). Used by write paths that need to preserve the
 * full device set (e.g. relabel/merge/revoke) before re-applying.
 *
 * For older documents that predate the canonical lists it reconstructs pairs
 * from the parallel signing/encryption arrays (index-aligned) or the legacy
 * scalars. De-duplicated by signing key.
 */
export function extractKeyPairs(data: Record<string, unknown>): GrantKeyPair[] {
  if (hasCanonicalKeyLists(data)) {
    return [...canonicalActivePairs(data), ...canonicalRevokedPairs(data)];
  }
  return legacyKeyPairs(data);
}

/**
 * The active (non-revoked) device key pairs. This is the set the server/auth
 * treat as granting access; revoked pairs are retained on the document (in
 * `revokedUserKeyPairs`) but excluded here (docs/accesscontrol.md §6.5).
 */
export function extractActiveKeyPairs(data: Record<string, unknown>): GrantKeyPair[] {
  if (hasCanonicalKeyLists(data)) {
    return canonicalActivePairs(data);
  }
  return legacyKeyPairs(data);
}

/**
 * The revoked device key pairs retained on the grant document (§6.5), each
 * carrying its `revokedAt` timestamp and optional label, so admin UIs can list
 * "devices with revoked access" and optionally restore them.
 */
export function extractRevokedKeyPairs(data: Record<string, unknown>): GrantKeyPair[] {
  return canonicalRevokedPairs(data);
}

/**
 * Write the key representations onto `data` from the canonical list of pairs
 * (§6.5). Pairs are partitioned by their `revoked` flag into two lists:
 *
 *  - active pairs → `userKeyPairs` (also mirrored to the legacy array/scalar
 *    forms so older readers keep working), and
 *  - revoked pairs → `revokedUserKeyPairs` (retained with their `revokedAt`
 *    timestamp and label, but never mirrored to the legacy forms).
 *
 * Both lists are always written (possibly empty), so the document is
 * authoritative: an empty `userKeyPairs` denotes no active devices and prevents
 * any stale legacy form from resurrecting access. The legacy scalars are left
 * untouched when there is no active pair. This also heals documents written in
 * the older format (revoked pairs embedded in `userKeyPairs`) into the two-list
 * form, since revoked pairs are routed to `revokedUserKeyPairs` here.
 */
export function applyKeyPairFields(data: Record<string, unknown>, pairs: GrantKeyPair[]): void {
  const activePairs = pairs.filter((pair) => !pair.revoked);
  const revokedPairs = pairs.filter((pair) => pair.revoked === true);

  // Active devices: the canonical `userKeyPairs` list. No `revoked` flag is
  // written — membership in this list is what marks a device active.
  data.userKeyPairs = activePairs.map((pair) => {
    const entry: Record<string, unknown> = {
      signingPublicKey: pair.signingPublicKey,
      encryptionPublicKey: pair.encryptionPublicKey,
    };
    if (pair.label !== undefined && pair.label.length > 0) {
      entry.label = pair.label;
    }
    return entry;
  });

  // Revoked devices: retained in a SEPARATE list (§6.5). Membership here marks
  // a device revoked; we keep the `revokedAt` timestamp and label for admin UIs.
  data.revokedUserKeyPairs = revokedPairs.map((pair) => {
    const entry: Record<string, unknown> = {
      signingPublicKey: pair.signingPublicKey,
      encryptionPublicKey: pair.encryptionPublicKey,
    };
    if (pair.label !== undefined && pair.label.length > 0) {
      entry.label = pair.label;
    }
    if (typeof pair.revokedAt === "number") {
      entry.revokedAt = pair.revokedAt;
    }
    return entry;
  });

  // Mirror the parallel-array form (ACTIVE only) for readers that predate
  // userKeyPairs. A revoked device must never appear here.
  data.userSigningPublicKeys = activePairs.map((pair) => pair.signingPublicKey);
  data.userEncryptionPublicKeys = activePairs
    .map((pair) => pair.encryptionPublicKey)
    .filter((key) => key.length > 0);
  // Keep the legacy scalars pointing at the primary (first) ACTIVE pair for the
  // oldest readers. Only updated when at least one active pair remains.
  if (activePairs.length > 0) {
    data.userSigningPublicKey = activePairs[0].signingPublicKey;
    data.userEncryptionPublicKey = activePairs[0].encryptionPublicKey;
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
  // The canonical form is authoritative once present, even when `userKeyPairs`
  // is empty: a grant with no active devices is how a fully-revoked user is
  // represented (§6.5), so we must not fall back to the legacy arrays/scalars
  // in that case. Only ACTIVE (non-revoked) pairs count.
  if (hasCanonicalKeyLists(data)) {
    return Array.from(new Set(extractActiveKeyPairs(data).map((pair) => pair.signingPublicKey)));
  }
  return legacySigningKeys(data);
}

/**
 * All encryption public keys granted by this document. Prefers `userKeyPairs`,
 * then the `userEncryptionPublicKeys` array, then the legacy scalar.
 */
export function extractEncryptionPublicKeys(data: Record<string, unknown>): string[] {
  // See extractSigningPublicKeys: a present (even empty) canonical form is
  // authoritative, and only ACTIVE (non-revoked) pairs count.
  if (hasCanonicalKeyLists(data)) {
    return Array.from(
      new Set(
        extractActiveKeyPairs(data)
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
