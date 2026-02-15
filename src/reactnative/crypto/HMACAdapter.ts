/**
 * HMAC-SHA256 Adapter
 * Implements HMAC-SHA256 signing and verification using node-forge
 */

import forge from "node-forge";

/**
 * Sign data with HMAC-SHA256
 */
export async function hmacSign(key: ArrayBuffer, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const keyBytes = new Uint8Array(key);
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  
  const hmac = forge.hmac.create();
  const keyBuf = forge.util.createBuffer(keyBytes.buffer as ArrayBuffer);
  const dataBuf = forge.util.createBuffer(dataBytes.buffer as ArrayBuffer);
  hmac.start("sha256", keyBuf.getBytes());
  hmac.update(dataBuf.getBytes());
  const signature = hmac.digest();
  
  // Convert signature to Uint8Array
  const sigHex = signature.toHex();
  const sigBytes = new Uint8Array(sigHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(sigHex.substr(i * 2, 2), 16);
  }
  
  return sigBytes.buffer;
}

/**
 * Verify HMAC-SHA256 signature
 */
export async function hmacVerify(
  key: ArrayBuffer,
  signature: ArrayBuffer | Uint8Array,
  data: ArrayBuffer | Uint8Array
): Promise<boolean> {
  const expectedSignature = await hmacSign(key, data);
  const sigBytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  const expectedBytes = new Uint8Array(expectedSignature);
  
  if (sigBytes.length !== expectedBytes.length) {
    return false;
  }
  
  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < sigBytes.length; i++) {
    result |= sigBytes[i] ^ expectedBytes[i];
  }
  return result === 0;
}
