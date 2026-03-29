import type { EncryptedPrivateKey } from "../types";
import type { CryptoAdapter } from "./CryptoAdapter";
import { DEFAULT_PBKDF2_ITERATIONS, resolvePbkdf2Iterations } from "./pbkdf2Iterations";

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildCombinedSalt(saltBytes: Uint8Array, saltString: string): Uint8Array {
  const saltStringBytes = new TextEncoder().encode(saltString);
  const combinedSalt = new Uint8Array(saltBytes.length + saltStringBytes.length);
  combinedSalt.set(saltBytes);
  combinedSalt.set(saltStringBytes, saltBytes.length);
  return combinedSalt;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function encryptPrivateKey(
  cryptoAdapter: CryptoAdapter,
  privateKeyBytes: Uint8Array,
  password: string,
  saltString: string,
): Promise<EncryptedPrivateKey> {
  const subtle = cryptoAdapter.getSubtle();
  const randomValues = cryptoAdapter.getRandomValues.bind(cryptoAdapter);

  const salt = new Uint8Array(16);
  randomValues(salt);

  const iv = new Uint8Array(12);
  randomValues(iv);

  const combinedSalt = buildCombinedSalt(salt, saltString);
  const passwordKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
  const derivedKey = await subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(combinedSalt),
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt"],
  );

  const encrypted = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: 128,
    },
    derivedKey,
    privateKeyBytes.buffer as ArrayBuffer,
  );

  const encryptedArray = new Uint8Array(encrypted);
  const tagLength = 16;
  const ciphertext = encryptedArray.slice(0, encryptedArray.length - tagLength);
  const tag = encryptedArray.slice(encryptedArray.length - tagLength);

  return {
    ciphertext: uint8ArrayToBase64(ciphertext),
    iv: uint8ArrayToBase64(iv),
    tag: uint8ArrayToBase64(tag),
    salt: uint8ArrayToBase64(salt),
    iterations,
  };
}

export async function decryptPrivateKey(
  cryptoAdapter: CryptoAdapter,
  encryptedKey: EncryptedPrivateKey,
  password: string,
  saltString: string,
): Promise<ArrayBuffer> {
  const subtle = cryptoAdapter.getSubtle();

  const ciphertext = base64ToUint8Array(encryptedKey.ciphertext);
  const iv = base64ToUint8Array(encryptedKey.iv);
  const tag = base64ToUint8Array(encryptedKey.tag);
  const saltBytes = base64ToUint8Array(encryptedKey.salt);
  const iterations = encryptedKey.iterations || resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);

  const combinedSalt = buildCombinedSalt(saltBytes, saltString);
  const passwordKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );

  const derivedKey = await subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(combinedSalt),
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(tag, ciphertext.length);

  return subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: 128 },
    derivedKey,
    new Uint8Array(ciphertextWithTag),
  );
}
