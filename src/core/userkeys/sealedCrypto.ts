import { RSAEncryption } from "../crypto/RSAEncryption";
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { bytesToBase64, base64ToBytes } from "./fingerprint";
import type { EntryRecipients } from "./sealedTypes";

export async function encryptAesGcm(
  crypto: CryptoAdapter,
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const subtle = crypto.getSubtle();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey("raw", keyBytes.slice(), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice(), tagLength: 128 },
    key,
    plaintext.slice(),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function decryptAesGcm(
  crypto: CryptoAdapter,
  keyBytes: Uint8Array,
  packed: Uint8Array,
): Promise<Uint8Array> {
  const subtle = crypto.getSubtle();
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const key = await subtle.importKey("raw", keyBytes.slice(), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: iv, tagLength: 128 },
    key,
    ct,
  );
  return new Uint8Array(pt);
}

export function concatGenerations(generations: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(generations.length * 32);
  generations.forEach((g, i) => out.set(g, i * 32));
  return out;
}

export function splitGenerations(bytes: Uint8Array): Uint8Array[] {
  const gens: Uint8Array[] = [];
  for (let i = 0; i + 32 <= bytes.length; i += 32) {
    gens.push(bytes.slice(i, i + 32));
  }
  return gens;
}

/** `extra` keys as 4-byte big-endian epoch + 32-byte key each. */
export function concatExtraKeys(extra: Array<{ epoch: number; key: Uint8Array }>): Uint8Array {
  const out = new Uint8Array(extra.length * 36);
  extra.forEach((entry, i) => {
    new DataView(out.buffer).setUint32(i * 36, entry.epoch);
    out.set(entry.key, i * 36 + 4);
  });
  return out;
}

export function splitExtraKeys(bytes: Uint8Array): Array<{ epoch: number; key: Uint8Array }> {
  const out: Array<{ epoch: number; key: Uint8Array }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 36 <= bytes.length; i += 36) {
    out.push({ epoch: view.getUint32(i), key: bytes.slice(i + 4, i + 36) });
  }
  return out;
}

export async function sealBundle(input: {
  crypto: CryptoAdapter;
  generations: Uint8Array[];
  wrapsTo: Array<{ kind: "user" | "device"; fingerprint: string; publicKeyPem: string }>;
  /** Keys of concurrent rotations, see {@link EntryRecipients.extra}. */
  extra?: Array<{ epoch: number; key: Uint8Array }>;
}): Promise<EntryRecipients> {
  const bundleKey = input.crypto.getRandomValues(new Uint8Array(32));
  const bundle = await encryptAesGcm(input.crypto, bundleKey, concatGenerations(input.generations));
  const extra = input.extra?.length
    ? bytesToBase64(await encryptAesGcm(input.crypto, bundleKey, concatExtraKeys(input.extra)))
    : undefined;
  const rsa = new RSAEncryption(input.crypto);
  const wraps = [];
  for (const target of input.wrapsTo) {
    const wrapped = await rsa.encrypt(bundleKey, target.publicKeyPem);
    wraps.push({
      kind: target.kind,
      keyFingerprint: target.fingerprint,
      wrapped: bytesToBase64(wrapped),
    });
  }
  return {
    epoch: input.generations.length,
    bundle: bytesToBase64(bundle),
    wraps,
    ...(extra ? { extra } : {}),
  };
}

/**
 * Opens a recipient block with `privateKey`: the whole-history bundle first,
 * then the partial tiers. Returns the generations newest first (index 0 is the
 * current key), as they were sealed.
 */
export async function openBundle(input: {
  crypto: CryptoAdapter;
  recipients: EntryRecipients;
  privateKey: CryptoKey;
}): Promise<Uint8Array[]> {
  return (await openBundleWithExtra(input)).generations;
}

/**
 * {@link openBundle} plus the keys of concurrent rotations the block carries
 * (`extra`, whole-history readers only).
 */
export async function openBundleWithExtra(input: {
  crypto: CryptoAdapter;
  recipients: EntryRecipients;
  privateKey: CryptoKey;
}): Promise<{ generations: Uint8Array[]; extra: Array<{ epoch: number; key: Uint8Array }> }> {
  const rsa = new RSAEncryption(input.crypto);
  let lastError: unknown;
  const tiers = [
    { bundle: input.recipients.bundle, wraps: input.recipients.wraps ?? [] },
    ...(input.recipients.partial ?? []),
  ];
  for (const [index, tier] of tiers.entries()) {
    for (const wrap of tier.wraps) {
      try {
        const bundleKey = await rsa.decrypt(base64ToBytes(wrap.wrapped), input.privateKey);
        const packed = await decryptAesGcm(input.crypto, bundleKey, base64ToBytes(tier.bundle));
        const generations = splitGenerations(packed);
        let extra: Array<{ epoch: number; key: Uint8Array }> = [];
        if (index === 0 && input.recipients.extra) {
          try {
            extra = splitExtraKeys(await decryptAesGcm(input.crypto, bundleKey, base64ToBytes(input.recipients.extra)));
          } catch {
            // a damaged extra field does not cost the generations
          }
        }
        return { generations, extra };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError ?? new Error("no recipient wrap opened");
}

/**
 * Like {@link openBundle}, with the epochs the opened bundle covers: a bundle
 * always holds a contiguous run that ends at the block's epoch.
 */
export async function openBundleRange(input: {
  crypto: CryptoAdapter;
  recipients: EntryRecipients;
  privateKey: CryptoKey;
}): Promise<Array<{ epoch: number; key: Uint8Array }>> {
  return (await openBundleRangeWithExtra(input)).range;
}

/** {@link openBundleRange} plus the block's keys of concurrent rotations. */
export async function openBundleRangeWithExtra(input: {
  crypto: CryptoAdapter;
  recipients: EntryRecipients;
  privateKey: CryptoKey;
}): Promise<{ range: Array<{ epoch: number; key: Uint8Array }>; extra: Array<{ epoch: number; key: Uint8Array }> }> {
  const { generations, extra } = await openBundleWithExtra(input);
  const top =
    typeof input.recipients.epoch === "number" && input.recipients.epoch >= generations.length
      ? input.recipients.epoch
      : generations.length;
  return { range: generations.map((key, index) => ({ epoch: top - index, key })), extra };
}
