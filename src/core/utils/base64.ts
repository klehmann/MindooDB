/**
 * Platform-neutral Base64 helpers.
 *
 * Node's `Buffer` is the fast path when it exists; everywhere else (browsers,
 * React Native, Cloudflare Workers without `nodejs_compat`) the helpers fall
 * back to `btoa`/`atob`. `Buffer` is looked up on `globalThis` instead of being
 * referenced as a free identifier, so bundlers never pull in a polyfill.
 */

interface BufferLike {
  from(data: ArrayBufferLike, byteOffset?: number, length?: number): { toString(encoding: string): string };
  from(data: string, encoding: string): Uint8Array;
}

function nodeBuffer(): BufferLike | undefined {
  return (globalThis as { Buffer?: BufferLike }).Buffer;
}

/** Characters per `String.fromCharCode.apply` call; stays below argument-count limits. */
const CHUNK = 0x8000;

/** Encode bytes as standard Base64 (with padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = nodeBuffer();
  if (buffer) {
    return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/** Decode standard Base64 into bytes. */
export function base64ToBytes(value: string): Uint8Array {
  const buffer = nodeBuffer();
  if (buffer) {
    const decoded = buffer.from(value, "base64");
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength).slice();
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encode a string's UTF-8 bytes as standard Base64. */
export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

/** Decode standard Base64 into a UTF-8 string. */
export function base64ToUtf8(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}
