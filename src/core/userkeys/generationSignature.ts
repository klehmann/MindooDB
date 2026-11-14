import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { base64ToBytes, bytesToBase64, normalizePublicKeyPem, spkiToPem } from "./fingerprint";
import type { UserKeyGeneration } from "./types";

/**
 * Signed User-Key generations (docs/userkeys.md §9.3).
 *
 * Every person has two kinds of Ed25519 keys around their User-Key:
 *
 * - a **generation signing key**, derived with HKDF from one generation's
 *   private User-Key bytes. Only devices that hold that generation can derive
 *   it, so a signature with it proves "this came from a holder of generation
 *   N". Its public half is stored on the generation (`signingPublicKey`).
 * - the person's **device self-grant key**, generated once and wrapped to
 *   every approved device. It counts only when the admin names it in the
 *   person's grant (`deviceSelfGrant`).
 *
 * A new generation is signed by the previous generation's signing key, by the
 * self-grant key, or by both.
 */

const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const GENERATION_KEY_INFO = "mindoodb-userkey-generation-signing-v1";
const GENERATION_MESSAGE_TAG = "mindoodb-userkey-generation-v1";

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function pemBody(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

function base64UrlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/** Ed25519 key pair from a 32-byte seed. */
async function ed25519FromSeed(
  crypto: CryptoAdapter,
  seed: Uint8Array,
): Promise<{ privateKey: CryptoKey; pkcs8: Uint8Array; publicKeyPem: string }> {
  const pkcs8 = concat(ED25519_PKCS8_PREFIX, seed);
  return { ...(await ed25519FromPkcs8(crypto, pkcs8)), pkcs8 };
}

/** Import an Ed25519 PKCS8 private key and compute its PEM public key. */
export async function ed25519FromPkcs8(
  crypto: CryptoAdapter,
  pkcs8: Uint8Array,
): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  const subtle = crypto.getSubtle();
  const extractable = await subtle.importKey("pkcs8", toBuffer(pkcs8), { name: "Ed25519" }, true, [
    "sign",
  ]);
  const jwk = (await subtle.exportKey("jwk", extractable)) as JsonWebKey;
  if (!jwk.x) throw new Error("Ed25519 key export did not include the public key");
  const spki = concat(ED25519_SPKI_PREFIX, base64UrlToBytes(jwk.x));
  const privateKey = await subtle.importKey("pkcs8", toBuffer(pkcs8), { name: "Ed25519" }, false, [
    "sign",
  ]);
  return { privateKey, publicKeyPem: spkiToPem(toBuffer(spki)) };
}

/**
 * The generation signing key: HKDF-SHA-256 over the generation's private
 * User-Key bytes (PKCS8), used as an Ed25519 seed. Deterministic, so every
 * holder of the generation derives the same key and nothing extra is stored.
 */
export async function deriveGenerationSigningKey(
  crypto: CryptoAdapter,
  userKeyPkcs8: Uint8Array,
): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  const subtle = crypto.getSubtle();
  const ikm = await subtle.importKey("raw", toBuffer(userKeyPkcs8), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(GENERATION_KEY_INFO),
    },
    ikm,
    256,
  );
  const { privateKey, publicKeyPem } = await ed25519FromSeed(crypto, new Uint8Array(bits));
  return { privateKey, publicKeyPem };
}

/** Fresh Ed25519 pair for the device self-grant key (PKCS8 private bytes + PEM). */
export async function generateSelfGrantKeyPair(
  crypto: CryptoAdapter,
): Promise<{ privateKeyBytes: Uint8Array; publicKeyPem: string }> {
  const subtle = crypto.getSubtle();
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const spki = await subtle.exportKey("spki", pair.publicKey);
  return { privateKeyBytes: pkcs8, publicKeyPem: spkiToPem(spki) };
}

/**
 * The bytes a generation signature covers: the person, the epoch and the
 * generation's identity. Wraps and `retiredAt` are left out on purpose; they
 * change during the generation's life.
 */
export function userKeyGenerationSigningMessage(
  usernameHash: string,
  epoch: string,
  gen: Pick<UserKeyGeneration, "publicKey" | "fingerprint" | "createdAt" | "signingPublicKey">,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      GENERATION_MESSAGE_TAG,
      usernameHash,
      epoch,
      normalizePublicKeyPem(gen.publicKey ?? ""),
      gen.fingerprint ?? "",
      normalizePublicKeyPem(gen.signingPublicKey ?? ""),
      gen.createdAt ?? 0,
    ]),
  );
}

export async function signEd25519(
  crypto: CryptoAdapter,
  privateKey: CryptoKey,
  message: Uint8Array,
): Promise<string> {
  const signature = await crypto.getSubtle().sign({ name: "Ed25519" }, privateKey, toBuffer(message));
  return bytesToBase64(new Uint8Array(signature));
}

export async function verifyEd25519(
  crypto: CryptoAdapter,
  publicKeyPem: string,
  signatureB64: string,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const subtle = crypto.getSubtle();
    const key = await subtle.importKey("spki", toBuffer(pemBody(publicKeyPem)), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await subtle.verify(
      { name: "Ed25519" },
      key,
      toBuffer(base64ToBytes(signatureB64)),
      toBuffer(message),
    );
  } catch {
    return false;
  }
}

/** Value identity of a generation: the parts a signature binds. */
export function generationValueKey(gen: Pick<UserKeyGeneration, "publicKey" | "signingPublicKey">): string {
  return `${normalizePublicKeyPem(gen.publicKey ?? "")}|${normalizePublicKeyPem(gen.signingPublicKey ?? "")}`;
}
