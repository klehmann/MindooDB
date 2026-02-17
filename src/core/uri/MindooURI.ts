/**
 * MindooDB URI scheme for out-of-band exchange of join requests and responses.
 *
 * Format: mdb://<type>/<base64url-encoded-JSON>
 *
 * Examples:
 *   mdb://join-request/eyJ2IjoxLCJ1c2VybmFtZSI6...
 *   mdb://join-response/eyJ2IjoxLCJ0ZW5hbnRJZCI6...
 *
 * All payloads include a "v" field (version number) for forward compatibility.
 * Uses base64url encoding (URL-safe, no padding) so URIs remain valid
 * in all contexts (URLs, QR codes, email, chat).
 */

/**
 * Supported MindooDB URI types.
 */
export type MindooURIType = "join-request" | "join-response";

const VALID_TYPES: ReadonlySet<string> = new Set<MindooURIType>([
  "join-request",
  "join-response",
]);

const MDB_SCHEME = "mdb://";

/**
 * Result of decoding a mdb:// URI.
 */
export interface DecodedMindooURI<T = unknown> {
  /** The URI type (e.g. "join-request", "join-response") */
  type: MindooURIType;
  /** The version number from the payload */
  version: number;
  /** The decoded payload object */
  payload: T;
}

/**
 * Encode a payload object into a mdb:// URI string.
 *
 * The payload MUST contain a "v" field with a numeric version.
 *
 * @param type The URI type (e.g. "join-request")
 * @param payload The payload object to encode (must include "v" field)
 * @returns A mdb:// URI string
 * @throws Error if the type is invalid or payload is missing "v" field
 */
export function encodeMindooURI(type: MindooURIType, payload: Record<string, unknown>): string {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid MindooDB URI type: "${type}". Valid types: ${[...VALID_TYPES].join(", ")}`);
  }

  if (typeof payload.v !== "number" || !Number.isInteger(payload.v) || payload.v < 1) {
    throw new Error(`MindooDB URI payload must contain a "v" field with a positive integer version number`);
  }

  const jsonStr = JSON.stringify(payload);
  const base64url = toBase64Url(jsonStr);
  return `${MDB_SCHEME}${type}/${base64url}`;
}

/**
 * Decode a mdb:// URI string back into its type and payload.
 *
 * @param uri The mdb:// URI string to decode
 * @returns The decoded URI with type, version, and payload
 * @throws Error if the URI is malformed or has an invalid type
 */
export function decodeMindooURI<T = unknown>(uri: string): DecodedMindooURI<T> {
  if (!uri.startsWith(MDB_SCHEME)) {
    throw new Error(`Invalid MindooDB URI: must start with "${MDB_SCHEME}"`);
  }

  const remainder = uri.substring(MDB_SCHEME.length);
  const slashIdx = remainder.indexOf("/");

  if (slashIdx === -1) {
    throw new Error(`Invalid MindooDB URI: missing type/payload separator "/"`);
  }

  const type = remainder.substring(0, slashIdx);
  const base64urlPayload = remainder.substring(slashIdx + 1);

  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid MindooDB URI type: "${type}". Valid types: ${[...VALID_TYPES].join(", ")}`);
  }

  if (!base64urlPayload) {
    throw new Error(`Invalid MindooDB URI: empty payload`);
  }

  let jsonStr: string;
  try {
    jsonStr = fromBase64Url(base64urlPayload);
  } catch {
    throw new Error(`Invalid MindooDB URI: payload is not valid base64url`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Invalid MindooDB URI: payload is not valid JSON`);
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Invalid MindooDB URI: payload must be a JSON object`);
  }

  if (typeof payload.v !== "number" || !Number.isInteger(payload.v) || payload.v < 1) {
    throw new Error(`Invalid MindooDB URI: payload must contain a "v" field with a positive integer version number`);
  }

  return {
    type: type as MindooURIType,
    version: payload.v as number,
    payload: payload as T,
  };
}

/**
 * Check if a string is a valid mdb:// URI.
 *
 * Performs structural validation only (scheme, type, base64url payload).
 * Does not validate the payload contents.
 *
 * @param value The string to check
 * @returns True if the string is a valid mdb:// URI
 */
export function isMindooURI(value: string): boolean {
  if (!value.startsWith(MDB_SCHEME)) {
    return false;
  }

  const remainder = value.substring(MDB_SCHEME.length);
  const slashIdx = remainder.indexOf("/");

  if (slashIdx === -1) {
    return false;
  }

  const type = remainder.substring(0, slashIdx);
  const base64urlPayload = remainder.substring(slashIdx + 1);

  if (!VALID_TYPES.has(type) || !base64urlPayload) {
    return false;
  }

  try {
    const jsonStr = fromBase64Url(base64urlPayload);
    const parsed = JSON.parse(jsonStr);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// ==================== Base64url Helpers ====================

/**
 * Encode a UTF-8 string to base64url (URL-safe, no padding).
 */
function toBase64Url(str: string): string {
  // Use Buffer if available (Node.js), otherwise TextEncoder + btoa (browser)
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a base64url string to UTF-8 string.
 */
function fromBase64Url(base64url: string): string {
  // Restore standard base64 characters and padding
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - (base64.length % 4)) % 4;
  base64 += "=".repeat(paddingNeeded);

  // Use Buffer if available (Node.js), otherwise atob + TextDecoder (browser)
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").toString("utf-8");
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
