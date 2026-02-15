/**
 * PBKDF2 Key Derivation Adapter
 * Implements PBKDF2 key derivation using node-forge
 */

import forge from "node-forge";

export interface PBKDF2Params {
  name: "PBKDF2";
  salt: BufferSource;
  iterations: number;
  hash: "SHA-256";
}

export interface DeriveKeyParams {
  name: "AES-GCM";
  length: number;
}

/**
 * Derive a key using PBKDF2
 */
export async function pbkdf2DeriveKey(
  params: PBKDF2Params,
  baseKey: ArrayBuffer,
  derivedKeyParams: DeriveKeyParams
): Promise<CryptoKey> {
  // Ensure salt is a proper ArrayBuffer
  let saltBytes: Uint8Array;
  if (params.salt instanceof Uint8Array) {
    saltBytes = params.salt;
  } else if (params.salt instanceof ArrayBuffer) {
    saltBytes = new Uint8Array(params.salt);
  } else {
    // ArrayBufferView - copy to ensure we have ArrayBuffer
    const view = params.salt as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    saltBytes = copy;
  }
  
  // Ensure baseKey is a proper ArrayBuffer
  let baseKeyBuffer: ArrayBuffer;
  if (baseKey instanceof ArrayBuffer) {
    baseKeyBuffer = baseKey;
  } else {
    const view = new Uint8Array(baseKey);
    const copy = new Uint8Array(view.length);
    copy.set(view);
    baseKeyBuffer = copy.buffer;
  }
  
  // Derive key using PBKDF2
  // node-forge pbkdf2 expects password as string and salt as string
  // Convert buffers to binary strings using getBytes()
  const baseKeyBuf = forge.util.createBuffer(baseKeyBuffer);
  const baseKeyStr = baseKeyBuf.getBytes();
  const saltBuf = forge.util.createBuffer(saltBytes.buffer as ArrayBuffer);
  const saltStr = saltBuf.getBytes();
  
  const keyLength = derivedKeyParams.length / 8; // Convert bits to bytes
  const derivedKey = forge.pkcs5.pbkdf2(
    baseKeyStr,
    saltStr,
    params.iterations,
    keyLength,
    forge.md.sha256.create()
  );
  
  // Convert string to Uint8Array
  // derivedKey is a binary string, convert to bytes
  const keyMaterial = new Uint8Array(keyLength);
  for (let i = 0; i < keyLength && i < derivedKey.length; i++) {
    keyMaterial[i] = derivedKey.charCodeAt(i) & 0xff;
  }
  
  // Return a CryptoKey-like object that can be used for encryption/decryption
  return {
    type: "secret",
    extractable: false,
    algorithm: derivedKeyParams,
    usages: ["encrypt", "decrypt"],
    // Store raw key material for use in encryption/decryption
    _rawKey: keyMaterial.buffer,
  } as any;
}
