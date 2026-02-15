/**
 * AES-GCM Adapter
 * Implements AES-GCM encryption/decryption using node-forge
 */

import forge from "node-forge";

export interface AESGCMParams {
  name: "AES-GCM";
  iv: BufferSource;
  tagLength?: number; // in bits, default 128
}

/**
 * Encrypt data with AES-GCM
 */
export async function aesGcmEncrypt(
  params: AESGCMParams,
  key: CryptoKey | ArrayBuffer,
  data: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer> {
  // Extract raw key material
  const rawKey = (key as any)._rawKey || key;
  const keyBytes = rawKey instanceof ArrayBuffer ? new Uint8Array(rawKey) : new Uint8Array(rawKey);
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  
  // Ensure IV is a proper ArrayBuffer
  let ivBytes: Uint8Array;
  if (params.iv instanceof Uint8Array) {
    ivBytes = params.iv;
  } else if (params.iv instanceof ArrayBuffer) {
    ivBytes = new Uint8Array(params.iv);
  } else {
    // ArrayBufferView - copy to ensure we have ArrayBuffer
    const view = params.iv as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    ivBytes = copy;
  }
  
  // Create cipher - node-forge expects key as ByteBuffer
  const cipher = forge.cipher.createCipher("AES-GCM", forge.util.createBuffer(keyBytes.buffer as ArrayBuffer));
  cipher.start({
    iv: forge.util.createBuffer(ivBytes.buffer as ArrayBuffer),
    tagLength: (params.tagLength || 128) / 8, // Convert bits to bytes
  });
  cipher.update(forge.util.createBuffer(dataBytes.buffer as ArrayBuffer));
  cipher.finish();
  
  // Get ciphertext and tag
  const encrypted = cipher.output;
  const tag = cipher.mode.tag;
  
  // Combine ciphertext and tag (Web Crypto API appends tag automatically)
  // node-forge ByteBuffer has a toBytes() method that returns a string
  const encryptedHex = encrypted.toHex();
  const encryptedBytes = new Uint8Array(encryptedHex.length / 2);
  for (let i = 0; i < encryptedBytes.length; i++) {
    encryptedBytes[i] = parseInt(encryptedHex.substr(i * 2, 2), 16);
  }
  
  const tagHex = tag.toHex();
  const tagBytes = new Uint8Array(tagHex.length / 2);
  for (let i = 0; i < tagBytes.length; i++) {
    tagBytes[i] = parseInt(tagHex.substr(i * 2, 2), 16);
  }
  
  // Combine: ciphertext + tag
  const result = new Uint8Array(encryptedBytes.length + tagBytes.length);
  result.set(encryptedBytes, 0);
  result.set(tagBytes, encryptedBytes.length);
  
  return result.buffer;
}

/**
 * Decrypt data with AES-GCM
 */
export async function aesGcmDecrypt(
  params: AESGCMParams,
  key: CryptoKey | ArrayBuffer,
  data: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer> {
  // Extract raw key material
  const rawKey = (key as any)._rawKey || key;
  const keyBytes = rawKey instanceof ArrayBuffer ? new Uint8Array(rawKey) : new Uint8Array(rawKey);
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let ivBytes: Uint8Array;
  if (params.iv instanceof Uint8Array) {
    ivBytes = params.iv;
  } else if (params.iv instanceof ArrayBuffer) {
    ivBytes = new Uint8Array(params.iv);
  } else {
    // ArrayBufferView
    const view = params.iv as ArrayBufferView;
    ivBytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  
  // Extract tag (last 16 bytes for 128-bit tag)
  const tagLength = (params.tagLength || 128) / 8; // Convert bits to bytes
  if (dataBytes.length < tagLength) {
    throw new Error("Encrypted data too short (missing tag)");
  }
  const ciphertext = dataBytes.slice(0, dataBytes.length - tagLength);
  const tag = dataBytes.slice(dataBytes.length - tagLength);
  
  // Create decipher - node-forge expects key as ByteBuffer
  const decipher = forge.cipher.createDecipher("AES-GCM", forge.util.createBuffer(keyBytes.buffer as ArrayBuffer));
  decipher.start({
    iv: forge.util.createBuffer(ivBytes.buffer as ArrayBuffer),
    tagLength: tagLength * 8, // Convert bytes to bits for node-forge
    tag: forge.util.createBuffer(tag.buffer as ArrayBuffer),
  });
  decipher.update(forge.util.createBuffer(ciphertext.buffer as ArrayBuffer));
  const success = decipher.finish();
  
  if (!success) {
    throw new Error("AES-GCM decryption failed: authentication tag mismatch");
  }
  
  const decrypted = decipher.output;
  const decryptedHex = decrypted.toHex();
  const decryptedBytes = new Uint8Array(decryptedHex.length / 2);
  for (let i = 0; i < decryptedBytes.length; i++) {
    decryptedBytes[i] = parseInt(decryptedHex.substr(i * 2, 2), 16);
  }
  
  return decryptedBytes.buffer;
}
