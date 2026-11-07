import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { base64ToBytes, bytesToBase64 } from "./fingerprint";
import { decryptAesGcm, encryptAesGcm, openBundle } from "./sealedCrypto";
import type { EntryRecipients } from "./sealedTypes";

/**
 * A value sealed to named people (their published User-Keys) or devices,
 * stored as an ordinary field of a document whose own key is something else,
 * e.g. a `$publicinfos` document in `directory`. Same construction as a sealed
 * document, applied to one value:
 *
 * - `ciphertext`: AES-256-GCM (`iv || ct+tag`) of the value under a fresh
 *   random content key;
 * - `recipients`: that content key in a sealed bundle (one RSA-OAEP wrap per
 *   recipient key), the same block a sealed document entry carries;
 * - `to`: the fingerprints of the recipient keys (no names: the field sits in
 *   documents the server can read, and User-Key fingerprints are public in
 *   `userdirectory` anyway), so a writer can check the recipients without
 *   opening it.
 *
 * Whoever holds none of the wrapped keys (a `$publicinfos`-only member, the
 * sync server) sees only ciphertext. There is no re-keying: when a recipient
 * changes, write the value again.
 */
export interface SealedValue {
  v: 1;
  ciphertext: string;
  recipients: EntryRecipients;
  to: Array<{ kind: "user" | "device"; keyFingerprint: string }>;
}

export const SEALED_VALUE_VERSION = 1 as const;

/** Whether `value` has the shape of a {@link SealedValue}. */
export function isSealedValue(value: unknown): value is SealedValue {
  if (!value || typeof value !== "object") return false;
  const sealed = value as Record<string, unknown>;
  const recipients = sealed.recipients as Record<string, unknown> | undefined;
  return (
    sealed.v === SEALED_VALUE_VERSION &&
    typeof sealed.ciphertext === "string" &&
    !!recipients &&
    typeof recipients.bundle === "string" &&
    Array.isArray(recipients.wraps)
  );
}

/** Plain JSON copy (Automerge raw strings `{ val }` become strings). */
function plainCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (value && typeof value === "object") {
    if (typeof (value as { val?: unknown }).val === "string" && Object.keys(value).length === 1) {
      return (value as { val: string }).val;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainCopy(entry)]));
  }
  return value;
}

/**
 * Normalizes a stored sealed value (as read back from a document) to plain
 * JSON, or returns null when it is not one.
 */
export function readSealedValue(value: unknown): SealedValue | null {
  const plain = plainCopy(value);
  return isSealedValue(plain) ? plain : null;
}

/** Encrypts `value` under a fresh content key; the caller seals the key. */
export async function encryptSealedValueContent(
  crypto: CryptoAdapter,
  value: Uint8Array,
): Promise<{ contentKey: Uint8Array; ciphertext: string }> {
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  return { contentKey, ciphertext: bytesToBase64(await encryptAesGcm(crypto, contentKey, value)) };
}

/**
 * Opens a sealed value with any of `privateKeys` (User-Key generations and the
 * device key). Returns null when none of them is a recipient or the value is
 * damaged; never throws for "not for me".
 */
export async function openSealedValueWithKeys(input: {
  crypto: CryptoAdapter;
  sealed: SealedValue;
  privateKeys: CryptoKey[];
}): Promise<Uint8Array | null> {
  for (const privateKey of input.privateKeys) {
    try {
      const [contentKey] = await openBundle({ crypto: input.crypto, recipients: input.sealed.recipients, privateKey });
      if (!contentKey) continue;
      return await decryptAesGcm(input.crypto, contentKey, base64ToBytes(input.sealed.ciphertext));
    } catch {
      // not a recipient with this key: try the next one
    }
  }
  return null;
}
