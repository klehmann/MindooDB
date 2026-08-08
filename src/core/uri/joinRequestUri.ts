/**
 * Codec for `mdb://join-request/...` URIs.
 *
 * A join request carries two SPKI public keys, and the RSA-3072 encryption key
 * dominates the payload: PEM armor plus 64-character line wrapping, base64 over
 * the DER, then base64url again over the whole JSON document. The `v: 3` form
 * drops the armor and shortens the field names, which takes a typical request
 * from roughly 1100 to 700 characters. That is the difference between a QR code
 * that only scans from a full-screen dialog and one that scans inline.
 *
 * `v: 1` / `v: 2` requests (verbose, PEM-armored) stay decodable so URIs already
 * in flight — in someone's mailbox, on a printout — keep working.
 */
import type { JoinRequest } from "../types";

import { decodeMindooURI, encodeMindooURI } from "./MindooURI";

/** Transport version for the compact, PEM-stripped payload. */
const COMPACT_VERSION = 3;

const PEM_LABEL = "PUBLIC KEY";
const PEM_HEADER = `-----BEGIN ${PEM_LABEL}-----`;
const PEM_FOOTER = `-----END ${PEM_LABEL}-----`;

/** PEM wraps base64 at 64 characters; reproducing it exactly matters (see {@link toCompactKey}). */
const PEM_LINE_LENGTH = 64;

/**
 * Generous ceiling for a single base64 key body. RSA-3072 SPKI is ~532
 * characters; anything an order of magnitude beyond that is a malformed or
 * hostile URI, not a key we could use.
 */
const MAX_KEY_BASE64_CHARS = 8192;

/** Guards against a username field used as a payload smuggling channel. */
const MAX_USERNAME_CHARS = 512;

/** Device labels are a short human note (§6.5), not free-form storage. */
const MAX_LABEL_CHARS = 256;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Rebuild the canonical PEM produced by `BaseMindooTenantFactory.uint8ArrayToPEM`. */
function toPem(base64: string): string {
  const chunks = base64.match(new RegExp(`.{1,${PEM_LINE_LENGTH}}`, "g")) ?? [];
  return `${PEM_HEADER}\n${chunks.join("\n")}\n${PEM_FOOTER}`;
}

function toBareBase64(pem: string): string {
  return pem.replace(PEM_HEADER, "").replace(PEM_FOOTER, "").replace(/\s/g, "");
}

/**
 * The bare base64 body of a PEM key, but only when re-wrapping it reproduces
 * the input byte for byte.
 *
 * The directory compares public keys as exact strings when deciding whether a
 * grant belongs to a known device (`BaseMindooTenantDirectory.registerUser`), so
 * a request that came back from the wire differing by a single newline would
 * register a second person instead of a second device. Rather than assume every
 * PEM is canonically formatted, we verify the round-trip and fall back to the
 * verbose encoding when it is not.
 */
function toCompactKey(pem: string): string | null {
  if (typeof pem !== "string") {
    return null;
  }
  const bare = toBareBase64(pem);
  if (!bare || bare.length > MAX_KEY_BASE64_CHARS || !BASE64_PATTERN.test(bare)) {
    return null;
  }
  return toPem(bare) === pem ? bare : null;
}

function readCompactKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid join request: missing "${field}"`);
  }
  if (value.length > MAX_KEY_BASE64_CHARS || !BASE64_PATTERN.test(value)) {
    throw new Error(`Invalid join request: "${field}" is not a base64 public key body`);
  }
  return toPem(value);
}

function readVerboseKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid join request: missing "${field}"`);
  }
  return value;
}

function readOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, max);
}

/**
 * Encode a join request, preferring the compact `v: 3` payload.
 *
 * Falls back to the verbose form when either key is not canonically formatted
 * PEM, so the exact string the directory will compare against always survives
 * the round-trip.
 */
export function encodeJoinRequestUri(request: JoinRequest): string {
  const signing = toCompactKey(request.signingPublicKey);
  const encryption = toCompactKey(request.encryptionPublicKey);

  if (!signing || !encryption) {
    return encodeMindooURI("join-request", request as unknown as Record<string, unknown>);
  }

  const payload: Record<string, unknown> = { v: COMPACT_VERSION, s: signing, e: encryption };

  const username = readOptionalText(request.username, MAX_USERNAME_CHARS);
  if (username) {
    payload.u = username;
  }
  const label = readOptionalText(request.label, MAX_LABEL_CHARS);
  if (label) {
    payload.l = label;
  }

  return encodeMindooURI("join-request", payload);
}

/**
 * Decode any supported `mdb://join-request/...` URI into a {@link JoinRequest}
 * with PEM-armored keys, regardless of which transport version produced it.
 *
 * Unknown versions are rejected rather than best-effort parsed: silently
 * dropping a field a future version added could register a device under the
 * wrong assumptions.
 */
export function decodeJoinRequestUri(uri: string): JoinRequest {
  const decoded = decodeMindooURI<Record<string, unknown>>(uri);
  if (decoded.type !== "join-request") {
    throw new Error(`Invalid URI type: expected "join-request", got "${decoded.type}"`);
  }
  return normalizeJoinRequestPayload(decoded.payload, decoded.version);
}

/**
 * Normalize a decoded join-request payload of any transport version into the
 * PEM-armored {@link JoinRequest} shape the rest of the SDK works with.
 */
export function normalizeJoinRequestPayload(
  payload: Record<string, unknown>,
  version: number,
): JoinRequest {
  if (version === COMPACT_VERSION) {
    const username = readOptionalText(payload.u, MAX_USERNAME_CHARS);
    const label = readOptionalText(payload.l, MAX_LABEL_CHARS);
    const request: JoinRequest = {
      // The compact form is a transport detail; the semantic version is still
      // "named" (1) vs. "the admin names it" (2), derived from the payload.
      v: username ? 1 : 2,
      signingPublicKey: readCompactKey(payload.s, "s"),
      encryptionPublicKey: readCompactKey(payload.e, "e"),
    };
    if (username) {
      request.username = username;
    }
    if (label) {
      request.label = label;
    }
    return request;
  }

  if (version === 1 || version === 2) {
    const username = readOptionalText(payload.username, MAX_USERNAME_CHARS);
    const label = readOptionalText(payload.label, MAX_LABEL_CHARS);
    const request: JoinRequest = {
      v: version,
      signingPublicKey: readVerboseKey(payload.signingPublicKey, "signingPublicKey"),
      encryptionPublicKey: readVerboseKey(payload.encryptionPublicKey, "encryptionPublicKey"),
    };
    if (username) {
      request.username = username;
    }
    if (label) {
      request.label = label;
    }
    return request;
  }

  throw new Error(
    `Unsupported join request version ${version}. Update this client to accept it.`,
  );
}
