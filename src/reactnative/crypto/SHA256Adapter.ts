/**
 * SHA-256 Digest Adapter
 * Implements SHA-256 hashing using node-forge
 */

import forge from "node-forge";

/**
 * Compute SHA-256 digest of data
 */
export async function sha256Digest(data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const md = forge.md.sha256.create();
  const dataBuf = forge.util.createBuffer(bytes.buffer as ArrayBuffer);
  md.update(dataBuf.getBytes());
  const hash = md.digest();
  
  // Convert hash to Uint8Array
  const hashHex = hash.toHex();
  const hashBytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hashBytes.length; i++) {
    hashBytes[i] = parseInt(hashHex.substr(i * 2, 2), 16);
  }
  
  return hashBytes.buffer;
}
