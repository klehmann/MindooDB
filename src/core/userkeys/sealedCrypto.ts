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

export async function sealBundle(input: {
  crypto: CryptoAdapter;
  generations: Uint8Array[];
  wrapsTo: Array<{ kind: "user" | "device"; fingerprint: string; publicKeyPem: string }>;
}): Promise<EntryRecipients> {
  const bundleKey = input.crypto.getRandomValues(new Uint8Array(32));
  const bundle = await encryptAesGcm(input.crypto, bundleKey, concatGenerations(input.generations));
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
  };
}

export async function openBundle(input: {
  crypto: CryptoAdapter;
  recipients: EntryRecipients;
  privateKey: CryptoKey;
}): Promise<Uint8Array[]> {
  const rsa = new RSAEncryption(input.crypto);
  let lastError: unknown;
  for (const wrap of input.recipients.wraps) {
    try {
      const bundleKey = await rsa.decrypt(base64ToBytes(wrap.wrapped), input.privateKey);
      const packed = await decryptAesGcm(input.crypto, bundleKey, base64ToBytes(input.recipients.bundle));
      return splitGenerations(packed).reverse();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no recipient wrap opened");
}
