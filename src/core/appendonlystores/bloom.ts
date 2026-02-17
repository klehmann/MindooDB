/**
 * Bloom filter for compact set-membership summaries of store entry IDs.
 *
 * During network sync, a local store needs to determine which of its entry IDs
 * are missing from a remote store.  Naively this requires sending every local ID
 * to the remote for an exact `hasEntries` check — an O(n) network round-trip
 * that dominates sync latency for large stores.
 *
 * A bloom filter provides a probabilistic shortcut: the remote store serializes
 * its full ID set into a compact bitset ({@link StoreIdBloomSummary}) and sends
 * it to the local side in a single response.  The local side then tests each of
 * its own IDs against the bloom filter:
 *
 *   - **Definite negative** — the ID is certainly absent on the remote; no
 *     round-trip needed, the entry can be pushed immediately.
 *   - **Probable positive** — the ID *might* exist on the remote (subject to a
 *     configurable false-positive rate, default 1 %).  Only these IDs require a
 *     follow-up `hasEntries` call to confirm.
 *
 * This is used by {@link BasicOnDiskContentAddressedStore.getIdBloomSummary} and
 * consumed by the sync loop in `BaseMindooDB` to partition IDs into
 * "definitely missing" and "maybe existing" buckets before making any network
 * calls.
 *
 * ### Implementation details
 *
 * - Uses **enhanced double hashing** (FNV-1a + DJB2) to derive `k` bit
 *   positions from a single ID string, avoiding the need for `k` independent
 *   hash functions.
 * - Bit-array size and hash count are computed from the classic bloom filter
 *   formulas to satisfy the requested false-positive rate.
 * - The filter is versioned (`"bloom-v1"`) so future changes to hashing or
 *   encoding remain backward-compatible.
 *
 * @module bloom
 */

import type { StoreIdBloomSummary } from "./types";

/** Default probability of a false positive (1 %). */
const DEFAULT_FALSE_POSITIVE_RATE = 0.01;

/** Salt mixed into every hash to namespace this bloom filter version. */
const DEFAULT_SALT = "mindoodb-bloom-v1";

/**
 * FNV-1a 32-bit hash.
 *
 * Used as the first of two independent hash bases for enhanced double hashing.
 * FNV-1a is fast, has good avalanche properties, and is simple to implement
 * without external dependencies.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * DJB2 32-bit hash (Daniel J. Bernstein).
 *
 * Used as the second hash base.  Chosen for its simplicity and because it is
 * sufficiently independent from FNV-1a to give good bit dispersion when
 * combined via enhanced double hashing: h(i) = h1 + i * h2.
 */
function djb2_32(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Compute the optimal bit-array size and number of hash functions for a bloom
 * filter given the expected item count and desired false-positive rate.
 *
 * Uses the standard formulas:
 *   m = -(n * ln(p)) / (ln2)^2   (bit count)
 *   k = (m / n) * ln2             (hash count)
 *
 * A minimum of 64 bits and 1 hash is enforced so the filter remains valid
 * even for very small or empty sets.
 *
 * @param itemCount          Expected number of distinct IDs.
 * @param falsePositiveRate  Target false-positive probability (0 < p < 1).
 * @returns Optimal `bitCount` and `hashCount`.
 */
function computeBloomShape(itemCount: number, falsePositiveRate: number): { bitCount: number; hashCount: number } {
  if (itemCount <= 0) {
    return { bitCount: 64, hashCount: 2 };
  }

  const ln2 = Math.log(2);
  const bitCount = Math.max(
    64,
    Math.ceil((-itemCount * Math.log(falsePositiveRate)) / (ln2 * ln2))
  );
  const hashCount = Math.max(1, Math.round((bitCount / itemCount) * ln2));
  return { bitCount, hashCount };
}

/** Set a single bit in a byte-packed bitset. */
function setBit(bitset: Uint8Array, bitIndex: number): void {
  const byteIndex = Math.floor(bitIndex / 8);
  const bitOffset = bitIndex % 8;
  bitset[byteIndex] |= 1 << bitOffset;
}

/** Test whether a single bit is set in a byte-packed bitset. */
function getBit(bitset: Uint8Array, bitIndex: number): boolean {
  const byteIndex = Math.floor(bitIndex / 8);
  const bitOffset = bitIndex % 8;
  return (bitset[byteIndex] & (1 << bitOffset)) !== 0;
}

/**
 * Derive `hashCount` bit-positions for an ID using enhanced double hashing.
 *
 * Enhanced double hashing computes k positions as:
 *   index_i = (h1 + i * h2) mod bitCount
 *
 * where h1 = FNV-1a(salt + id) and h2 = DJB2(id + salt).  The salt is
 * prepended/appended in opposite order to reduce correlation between the two
 * hash values.
 *
 * @param id        The entry ID to hash.
 * @param bitCount  Total bits in the bloom filter.
 * @param hashCount Number of bit positions to produce.
 * @param salt      Version-specific salt string.
 * @returns Array of `hashCount` bit-positions in [0, bitCount).
 */
function bloomIndexes(id: string, bitCount: number, hashCount: number, salt: string): number[] {
  const h1 = fnv1a32(`${salt}:${id}`);
  const h2 = djb2_32(`${id}:${salt}`) || 1;
  const indexes: number[] = [];
  for (let i = 0; i < hashCount; i++) {
    indexes.push((h1 + i * h2) % bitCount);
  }
  return indexes;
}

/**
 * Build a bloom filter summary from a list of entry IDs.
 *
 * The resulting {@link StoreIdBloomSummary} is a compact, serializable
 * representation that can be transferred over the network (e.g. in sync
 * protocol responses) and later queried with {@link bloomMightContainId}.
 *
 * Typical usage in the on-disk store:
 * ```ts
 * const ids = await store.getAllIds();
 * const summary = createIdBloomSummary(ids);
 * // send summary to the syncing peer
 * ```
 *
 * @param ids               Array of entry ID strings to include in the filter.
 * @param falsePositiveRate Target false-positive probability (default 1 %).
 * @returns A serializable bloom filter summary (base64-encoded bitset).
 */
export function createIdBloomSummary(ids: string[], falsePositiveRate: number = DEFAULT_FALSE_POSITIVE_RATE): StoreIdBloomSummary {
  const { bitCount, hashCount } = computeBloomShape(ids.length, falsePositiveRate);
  const bitset = new Uint8Array(Math.ceil(bitCount / 8));

  for (const id of ids) {
    const indexes = bloomIndexes(id, bitCount, hashCount, DEFAULT_SALT);
    for (const idx of indexes) {
      setBit(bitset, idx);
    }
  }

  return {
    version: "bloom-v1",
    totalIds: ids.length,
    bitCount,
    hashCount,
    salt: DEFAULT_SALT,
    bitsetBase64: Buffer.from(bitset).toString("base64"),
  };
}

/**
 * Test whether an entry ID *might* be present in a bloom filter summary.
 *
 * - Returns `false` only when the ID is **definitely absent** — at least one
 *   of its bit-positions is unset, so the ID was never inserted.
 * - Returns `true` when the ID **might be present** — all bit-positions are
 *   set, but this could be a false positive (probability ≤ the configured
 *   false-positive rate).
 *
 * If the summary version is unrecognized, conservatively returns `true` to
 * avoid incorrectly skipping entries during sync.
 *
 * Used in the sync loop to partition local IDs:
 * ```ts
 * for (const id of localIds) {
 *   if (bloomMightContainId(remoteBloom, id)) {
 *     maybeExisting.push(id);   // needs exact hasEntries() check
 *   } else {
 *     definitelyMissing.push(id); // can push without round-trip
 *   }
 * }
 * ```
 *
 * @param summary  The bloom filter summary obtained from the remote store.
 * @param id       The entry ID to test.
 * @returns `true` if the ID might be in the set; `false` if it is definitely not.
 */
export function bloomMightContainId(summary: StoreIdBloomSummary, id: string): boolean {
  if (summary.version !== "bloom-v1") {
    return true;
  }
  const bitset = new Uint8Array(Buffer.from(summary.bitsetBase64, "base64"));
  const indexes = bloomIndexes(id, summary.bitCount, summary.hashCount, summary.salt);
  for (const idx of indexes) {
    if (!getBit(bitset, idx)) {
      return false;
    }
  }
  return true;
}
