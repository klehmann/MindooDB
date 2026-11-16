/**
 * The rescue device of recovery contacts (docs/userkeys.md §12).
 *
 * A rescue device is an ordinary device of the person — an Ed25519 signing
 * key and an RSA-OAEP 3072 encryption key — that no hardware holds. The
 * person certifies it with their device self-grant key, so it receives the
 * User-Key wraps and the self-grant key wrap like any device, and rotation
 * keeps wrapping it. Its private keys exist only encrypted with the recovery
 * secret `K`, which is split among the contacts.
 *
 * The encrypted keys ("rescue blob") are kept as small as possible because
 * every helper package carries them and a package should fit a QR code: the
 * Ed25519 seed (32 bytes) plus the two RSA primes (2 × 192 bytes). Everything
 * else — modulus, private exponent, CRT values, public keys — is derived from
 * them on recovery.
 */
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { encryptPrivateKey } from "../crypto/privateKeyEncryption";
import { ed25519FromSeed } from "../userkeys/generationSignature";
import { base64ToBytes, bytesToBase64, fingerprintPublicKeyPem, spkiToPem } from "../userkeys/fingerprint";
import type { PrivateUserId } from "../types";

const BLOB_VERSION = 1;
const BLOB_AAD = new TextEncoder().encode("mindoodb-rescue-device-v1");
const RSA_E = 65537n;

/** Public half of a rescue device, as certified and stored in `rcv_`. */
export interface RescueDevicePublicKeys {
  signingPublicKey: string;
  encryptionPublicKey: string;
  /** Fingerprint of the signing key (colon-separated hex, as everywhere). */
  signingKeyFingerprint: string;
}

/** A rescue device with its private keys opened. Memory only. */
export interface OpenedRescueDevice extends RescueDevicePublicKeys {
  signingPkcs8: Uint8Array;
  encryptionPkcs8: Uint8Array;
}

/** A freshly made rescue device: public keys, `K` and the encrypted blob. */
export interface GeneratedRescueDevice extends OpenedRescueDevice {
  /** The 32-byte recovery secret the blob is encrypted with. */
  secret: Uint8Array;
  /** Base64 AES-256-GCM ciphertext of the private keys under {@link secret}. */
  blob: string;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Big-endian, minimal length (JWK Base64urlUInt). */
function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0]);
  const hex = value.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return ((oldS % m) + m) % m;
}

async function aesKey(crypto: CryptoAdapter, secret: Uint8Array, usage: "encrypt" | "decrypt") {
  if (secret.length !== 32) throw new Error("recovery secret must be 32 bytes");
  return crypto.getSubtle().importKey("raw", toBuffer(secret), { name: "AES-GCM" }, false, [usage]);
}

/** Encode seed and primes: version | seed(32) | len(p) u16 | p | len(q) u16 | q. */
function encodeRescueKeys(seed: Uint8Array, p: Uint8Array, q: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 32 + 2 + p.length + 2 + q.length);
  let offset = 0;
  out[offset++] = BLOB_VERSION;
  out.set(seed, offset);
  offset += 32;
  for (const prime of [p, q]) {
    out[offset++] = prime.length >> 8;
    out[offset++] = prime.length & 0xff;
    out.set(prime, offset);
    offset += prime.length;
  }
  return out;
}

function decodeRescueKeys(bytes: Uint8Array): { seed: Uint8Array; p: Uint8Array; q: Uint8Array } {
  if (bytes[0] !== BLOB_VERSION) throw new Error("unknown rescue device format");
  let offset = 1;
  const seed = bytes.slice(offset, offset + 32);
  offset += 32;
  const primes: Uint8Array[] = [];
  for (let i = 0; i < 2; i++) {
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
    primes.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  if (seed.length !== 32 || offset !== bytes.length) throw new Error("damaged rescue device keys");
  return { seed, p: primes[0]!, q: primes[1]! };
}

/** Rebuild the RSA-OAEP key pair from its two primes. */
async function rsaFromPrimes(
  crypto: CryptoAdapter,
  pBytes: Uint8Array,
  qBytes: Uint8Array,
): Promise<{ pkcs8: Uint8Array; publicKeyPem: string }> {
  const p = bytesToBigInt(pBytes);
  const q = bytesToBigInt(qBytes);
  const n = p * q;
  const d = modInverse(RSA_E, (p - 1n) * (q - 1n));
  const jwk: JsonWebKey = {
    kty: "RSA",
    alg: "RSA-OAEP-256",
    ext: true,
    n: bytesToBase64Url(bigIntToBytes(n)),
    e: bytesToBase64Url(bigIntToBytes(RSA_E)),
    d: bytesToBase64Url(bigIntToBytes(d)),
    p: bytesToBase64Url(bigIntToBytes(p)),
    q: bytesToBase64Url(bigIntToBytes(q)),
    dp: bytesToBase64Url(bigIntToBytes(d % (p - 1n))),
    dq: bytesToBase64Url(bigIntToBytes(d % (q - 1n))),
    qi: bytesToBase64Url(bigIntToBytes(modInverse(q, p))),
  };
  const subtle = crypto.getSubtle();
  const algorithm = { name: "RSA-OAEP", hash: "SHA-256" };
  const privateKey = await subtle.importKey("jwk", jwk, algorithm, true, ["decrypt"]);
  const publicKey = await subtle.importKey(
    "jwk",
    { kty: "RSA", alg: "RSA-OAEP-256", ext: true, n: jwk.n, e: jwk.e },
    algorithm,
    true,
    ["encrypt"],
  );
  return {
    pkcs8: new Uint8Array(await subtle.exportKey("pkcs8", privateKey)),
    publicKeyPem: spkiToPem(await subtle.exportKey("spki", publicKey)),
  };
}

/** Make a new rescue device and encrypt its private keys with a new secret. */
export async function generateRescueDevice(crypto: CryptoAdapter): Promise<GeneratedRescueDevice> {
  const subtle = crypto.getSubtle();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signing = await ed25519FromSeed(crypto, seed);
  const pair = (await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const jwk = (await subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwk.p || !jwk.q) throw new Error("RSA key export did not include the primes");
  const p = base64UrlToBytes(jwk.p);
  const q = base64UrlToBytes(jwk.q);
  // Rebuild from the primes right away, so a key that would not come back on
  // recovery is never certified.
  const rebuilt = await rsaFromPrimes(crypto, p, q);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: toBuffer(iv), additionalData: toBuffer(BLOB_AAD), tagLength: 128 },
      await aesKey(crypto, secret, "encrypt"),
      toBuffer(encodeRescueKeys(seed, p, q)),
    ),
  );
  const packed = new Uint8Array(12 + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, 12);
  seed.fill(0);
  return {
    secret,
    blob: bytesToBase64(packed),
    signingPublicKey: signing.publicKeyPem,
    encryptionPublicKey: rebuilt.publicKeyPem,
    signingKeyFingerprint: await fingerprintPublicKeyPem(signing.publicKeyPem, subtle),
    signingPkcs8: signing.pkcs8,
    encryptionPkcs8: rebuilt.pkcs8,
  };
}

/**
 * Open a rescue blob with the recovery secret. Throws when the secret is wrong
 * (AES-GCM authenticates it), which is how a bad share combination shows up.
 */
export async function openRescueDevice(
  crypto: CryptoAdapter,
  secret: Uint8Array,
  blob: string,
): Promise<OpenedRescueDevice> {
  const packed = base64ToBytes(blob);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.getSubtle().decrypt(
        {
          name: "AES-GCM",
          iv: toBuffer(packed.slice(0, 12)),
          additionalData: toBuffer(BLOB_AAD),
          tagLength: 128,
        },
        await aesKey(crypto, secret, "decrypt"),
        toBuffer(packed.slice(12)),
      ),
    );
  } catch {
    throw new Error("The recovery shares do not open this rescue device.");
  }
  const { seed, p, q } = decodeRescueKeys(plain);
  plain.fill(0);
  const signing = await ed25519FromSeed(crypto, seed);
  seed.fill(0);
  const rsa = await rsaFromPrimes(crypto, p, q);
  return {
    signingPublicKey: signing.publicKeyPem,
    encryptionPublicKey: rsa.publicKeyPem,
    signingKeyFingerprint: await fingerprintPublicKeyPem(signing.publicKeyPem, crypto.getSubtle()),
    signingPkcs8: signing.pkcs8,
    encryptionPkcs8: rsa.pkcs8,
  };
}

/**
 * A {@link PrivateUserId} for the rescue device, its private keys encrypted
 * with `password` exactly like {@link BaseMindooTenantFactory.createUserId}
 * does, so the regular discovery and bootstrap calls can act as it.
 */
export async function rescueDeviceUserId(
  crypto: CryptoAdapter,
  device: OpenedRescueDevice,
  username: string,
  password: string,
): Promise<PrivateUserId> {
  return {
    username,
    userSigningKeyPair: {
      publicKey: device.signingPublicKey,
      privateKey: await encryptPrivateKey(crypto, device.signingPkcs8, password, "signing"),
    },
    userEncryptionKeyPair: {
      publicKey: device.encryptionPublicKey,
      privateKey: await encryptPrivateKey(crypto, device.encryptionPkcs8, password, "encryption"),
    },
  };
}
