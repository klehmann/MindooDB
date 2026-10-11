/**
 * JSON-safe encoding for store RPC arguments and results: every Uint8Array
 * (signatures, bloom bits, …) becomes `{ $bytes: "<base64>" }` and back.
 * Entry payloads do not go through this codec; they travel as raw bytes over
 * the transport's binary channel (see {@link StoreRpcClientTransport}).
 */

const BYTES_KEY = "$bytes";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Deep copy of `value` with Uint8Arrays replaced by `{ $bytes }` objects. */
export function encodeRpcValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BYTES_KEY]: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeRpcValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = encodeRpcValue(entry);
      }
    }
    return out;
  }
  return value;
}

/** Inverse of {@link encodeRpcValue}. */
export function decodeRpcValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeRpcValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === BYTES_KEY && typeof record[BYTES_KEY] === "string") {
      return base64ToBytes(record[BYTES_KEY] as string);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = decodeRpcValue(record[key]);
    }
    return out;
  }
  return value;
}

/** Concatenates entry payloads into one buffer for the binary channel. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Splits a buffer produced by {@link concatBytes} again (views, no copies). */
export function splitBytes(bytes: Uint8Array, lengths: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const length of lengths) {
    out.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.byteLength) {
    throw new Error(`Store RPC: payload has ${bytes.byteLength} bytes, entries declare ${offset}`);
  }
  return out;
}
