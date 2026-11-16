/**
 * Primitives of the invitation / join-request inbox (docs/invitations.md):
 * identifiers, link fragments, hashes, the device-signed envelope, and the
 * seal that makes the invitation's private half readable by admins only.
 *
 * Free of tenant dependencies so the server and both clients share it.
 */
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { RSAEncryption } from "../crypto/RSAEncryption";
import { normalizePublicKeyPem, fingerprintPublicKeyPem } from "../userkeys/fingerprint";
import { bytesToBase64, base64ToBytes } from "../utils/base64";
import type { JoinRequest } from "../types";
import type {
  AdminSealedBlob,
  InvitationLink,
  JoinRequestSubmission,
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Domain prefix of the device signature over a submission (kept out of the app-signable domains). */
export const JOIN_REQUEST_ENVELOPE_DOMAIN = "mindoodb-joinrequest/v1";

const NONCE_HASH_DOMAIN = "mindoodb-invite-nonce/v1";
const REQUEST_HMAC_DOMAIN = "mindoodb-joinrequest-hmac/v1";
const INVITATION_KEY_FP_BYTES = 16;

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return base64ToBytes(padded);
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Lowercase RFC 4648 base32 without padding: valid inside document ids. */
function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function randomBytes(cryptoAdapter: CryptoAdapter, length: number): Uint8Array {
  return cryptoAdapter.getRandomValues(new Uint8Array(length));
}

/**
 * New invitation id: 80 random bits, lowercase base32 (16 characters). Starts
 * with a letter-or-digit; the document id `invite_<id>` keeps the id rules.
 */
export function newInvitationId(cryptoAdapter: CryptoAdapter): string {
  return bytesToBase32(randomBytes(cryptoAdapter, 10));
}

/** New join-request document id (`jr_` + 128 random bits). */
export function newJoinRequestDocId(cryptoAdapter: CryptoAdapter): string {
  return `jr_${bytesToBase32(randomBytes(cryptoAdapter, 16))}`;
}

/** New row id inside an invitation list. */
export function newInvitationRowId(cryptoAdapter: CryptoAdapter): string {
  return bytesToBase32(randomBytes(cryptoAdapter, 8));
}

/** New per-person link secret (128 bits, base64url, 22 characters). */
export function newInvitationNonce(cryptoAdapter: CryptoAdapter): string {
  return bytesToBase64Url(randomBytes(cryptoAdapter, 16));
}

const INVITATION_ID_PATTERN = /^[a-z2-7]{8,32}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidInvitationId(id: unknown): id is string {
  return typeof id === "string" && INVITATION_ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

async function sha256(subtle: SubtleCrypto, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", data.slice() as unknown as BufferSource));
}

function domainBytes(domain: string, payload: Uint8Array): Uint8Array {
  const prefix = encoder.encode(domain);
  const out = new Uint8Array(prefix.length + 1 + payload.length);
  out.set(prefix, 0);
  out[prefix.length] = 0;
  out.set(payload, prefix.length + 1);
  return out;
}

/** Public hash of a link nonce (base64url). The nonce itself never leaves the admins and the link. */
export async function hashInvitationNonce(subtle: SubtleCrypto, nonce: string): Promise<string> {
  return bytesToBase64Url(await sha256(subtle, domainBytes(NONCE_HASH_DOMAIN, encoder.encode(nonce))));
}

function pemBody(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

/**
 * Fingerprint of the invitation public key as carried in the link (`f=`):
 * the first 128 bits of SHA-256 over the SPKI, base64url. A joining device
 * compares it with the key the server hands out, so a server cannot slip in
 * a key of its own and read the requests.
 */
export async function invitationKeyFingerprint(subtle: SubtleCrypto, publicKeyPem: string): Promise<string> {
  const digest = await sha256(subtle, pemBody(publicKeyPem));
  return bytesToBase64Url(digest.slice(0, INVITATION_KEY_FP_BYTES));
}

/** Short fingerprint of a device signing key (same format as directory device ids). */
export function deviceKeyFingerprint(subtle: SubtleCrypto, signingPublicKeyPem: string): Promise<string> {
  return fingerprintPublicKeyPem(signingPublicKeyPem, subtle);
}

function canonicalRequestJson(tenantId: string, invitationId: string, request: JoinRequest): string {
  const norm = (value: string | undefined) => (typeof value === "string" && value ? normalizePublicKeyPem(value) : null);
  // Fixed key order: this string is hashed on two devices.
  return JSON.stringify([
    "v1",
    tenantId,
    invitationId,
    norm(request.signingPublicKey),
    norm(request.encryptionPublicKey),
    norm(request.userPublicKey),
    norm(request.deviceSelfGrantPublicKey),
    request.username ?? null,
    request.label ?? null,
  ]);
}

/** Hash binding a decoded join request to its tenant and invitation. */
export async function joinRequestHash(
  subtle: SubtleCrypto,
  tenantId: string,
  invitationId: string,
  request: JoinRequest,
): Promise<Uint8Array> {
  return sha256(subtle, encoder.encode(canonicalRequestJson(tenantId, invitationId, request)));
}

async function importHmacKey(subtle: SubtleCrypto, nonce: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return subtle.importKey(
    "raw",
    base64UrlToBytes(nonce).slice() as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** HMAC proving the requester holds the personal link (its nonce). */
export async function computeJoinRequestHmac(
  subtle: SubtleCrypto,
  nonce: string,
  requestHash: Uint8Array,
): Promise<string> {
  const key = await importHmacKey(subtle, nonce, "sign");
  const mac = await subtle.sign("HMAC", key, domainBytes(REQUEST_HMAC_DOMAIN, requestHash).slice() as unknown as BufferSource);
  return bytesToBase64(new Uint8Array(mac));
}

export async function verifyJoinRequestHmac(
  subtle: SubtleCrypto,
  nonce: string,
  requestHash: Uint8Array,
  hmac: string,
): Promise<boolean> {
  try {
    const key = await importHmacKey(subtle, nonce, "verify");
    return await subtle.verify(
      "HMAC",
      key,
      base64ToBytes(hmac).slice() as unknown as BufferSource,
      domainBytes(REQUEST_HMAC_DOMAIN, requestHash).slice() as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Six-digit code both sides can read out to each other. Needed when there is
 * no nonce to prove the link (open links, requests sent without a link).
 */
export function verificationCodeFromHash(requestHash: Uint8Array): string {
  const value =
    ((requestHash[0] << 24) | (requestHash[1] << 16) | (requestHash[2] << 8) | requestHash[3]) >>> 0;
  const digits = String(value % 1_000_000).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

// ---------------------------------------------------------------------------
// Device-signed envelope
// ---------------------------------------------------------------------------

/**
 * Bytes the joining device signs: the outer fields and a hash of the sealed
 * request, under {@link JOIN_REQUEST_ENVELOPE_DOMAIN}. The admin checks that
 * the inner request names the same device key, which binds the two.
 */
export async function joinRequestEnvelopeBytes(
  subtle: SubtleCrypto,
  submission: Omit<JoinRequestSubmission, "signature">,
): Promise<Uint8Array> {
  const sealedHash = bytesToBase64Url(await sha256(subtle, encoder.encode(submission.sealedRequest)));
  const statement = JSON.stringify([
    "v1",
    submission.tenantId,
    submission.invitationId,
    submission.nonceHash ?? null,
    normalizePublicKeyPem(submission.deviceSigningPublicKey),
    submission.createdAt,
    sealedHash,
  ]);
  return domainBytes(JOIN_REQUEST_ENVELOPE_DOMAIN, encoder.encode(statement));
}

export async function verifyJoinRequestEnvelope(
  subtle: SubtleCrypto,
  submission: JoinRequestSubmission,
): Promise<boolean> {
  try {
    const key = await subtle.importKey(
      "spki",
      pemBody(submission.deviceSigningPublicKey).slice() as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      { name: "Ed25519" },
      key,
      base64ToBytes(submission.signature).slice() as unknown as BufferSource,
      (await joinRequestEnvelopeBytes(subtle, submission)).slice() as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Bytes a device signs to withdraw its request. */
export function joinRequestWithdrawalBytes(input: { tenantId: string; docId: string; createdAt: number }): Uint8Array {
  return domainBytes(
    JOIN_REQUEST_ENVELOPE_DOMAIN,
    encoder.encode(JSON.stringify(["withdraw-v1", input.tenantId, input.docId, input.createdAt])),
  );
}

/** Bytes a member device signs to read the inbox summary (count of pending requests). */
export function joinRequestSummaryBytes(input: { tenantId: string; createdAt: number }): Uint8Array {
  return domainBytes(
    JOIN_REQUEST_ENVELOPE_DOMAIN,
    encoder.encode(JSON.stringify(["summary-v1", input.tenantId, input.createdAt])),
  );
}

export async function verifyEd25519(
  subtle: SubtleCrypto,
  publicKeyPem: string,
  signatureBase64: string,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const key = await subtle.importKey(
      "spki",
      pemBody(publicKeyPem).slice() as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      { name: "Ed25519" },
      key,
      base64ToBytes(signatureBase64).slice() as unknown as BufferSource,
      bytes.slice() as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

export async function verifyJoinRequestWithdrawal(
  subtle: SubtleCrypto,
  input: { tenantId: string; docId: string; createdAt: number; deviceSigningPublicKey: string; signature: string },
): Promise<boolean> {
  try {
    const key = await subtle.importKey(
      "spki",
      pemBody(input.deviceSigningPublicKey).slice() as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      { name: "Ed25519" },
      key,
      base64ToBytes(input.signature).slice() as unknown as BufferSource,
      joinRequestWithdrawalBytes(input).slice() as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Admin seal
// ---------------------------------------------------------------------------

/** An admin encryption key the sealed invitation parts are wrapped to. */
export interface AdminRecipient {
  encryptionPublicKey: string;
}

/**
 * Seal `plaintext` to every admin encryption key: one AES-256-GCM key, wrapped
 * with RSA-OAEP to each admin. `existingKey` re-encrypts under the key of an
 * earlier seal (fresh IV), so other admins' wraps stay valid.
 */
export async function sealForAdmins(
  cryptoAdapter: CryptoAdapter,
  plaintext: Uint8Array,
  recipients: AdminRecipient[],
  existing?: { aesKey: Uint8Array; wraps: Record<string, string> },
): Promise<{ blob: AdminSealedBlob; aesKey: Uint8Array }> {
  const subtle = cryptoAdapter.getSubtle();
  const aesKey = existing?.aesKey ?? cryptoAdapter.getRandomValues(new Uint8Array(32));
  const key = await subtle.importKey("raw", aesKey.slice() as unknown as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = cryptoAdapter.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, plaintext.slice() as unknown as BufferSource),
  );
  const combined = new Uint8Array(12 + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, 12);

  const rsa = new RSAEncryption(cryptoAdapter);
  const wraps: Record<string, string> = { ...(existing?.wraps ?? {}) };
  for (const recipient of recipients) {
    const fp = await fingerprintPublicKeyPem(recipient.encryptionPublicKey, subtle);
    if (!wraps[fp]) {
      wraps[fp] = await rsa.wrapKeyToBase64(aesKey, recipient.encryptionPublicKey);
    }
  }
  return { blob: { v: 1, ciphertext: bytesToBase64(combined), wraps }, aesKey };
}

/** Open an admin seal with one admin's RSA private key; null when no wrap addresses it. */
export async function openAdminSeal(
  cryptoAdapter: CryptoAdapter,
  blob: AdminSealedBlob,
  admin: { encryptionPublicKey: string; encryptionPrivateKey: CryptoKey },
): Promise<{ plaintext: Uint8Array; aesKey: Uint8Array } | null> {
  const subtle = cryptoAdapter.getSubtle();
  const fp = await fingerprintPublicKeyPem(admin.encryptionPublicKey, subtle);
  const wrapped = blob.wraps?.[fp];
  if (!wrapped) return null;
  const rsa = new RSAEncryption(cryptoAdapter);
  const aesKey = await rsa.unwrapKeyFromBase64(wrapped, admin.encryptionPrivateKey);
  const key = await subtle.importKey("raw", aesKey.slice() as unknown as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
  const combined = base64ToBytes(blob.ciphertext);
  const plaintext = new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) as unknown as BufferSource },
      key,
      combined.slice(12) as unknown as BufferSource,
    ),
  );
  return { plaintext, aesKey };
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Link fragment
// ---------------------------------------------------------------------------

/** Longest tenant label carried in a link (keeps mailto links short). */
export const MAX_INVITATION_LINK_LABEL_CHARS = 80;

/** Trimmed, control-character-free label, cut to {@link MAX_INVITATION_LINK_LABEL_CHARS}. */
function cleanInvitationLabel(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_INVITATION_LINK_LABEL_CHARS) : undefined;
}

/**
 * `s=<server>&t=<tenantId>&i=<inviteId>&n=<nonce>&f=<keyFingerprint>&l=<label>`, no
 * leading `#`. Shared (open) links have no `n`; `l` (tenant label) is optional. Everything after `#` stays in
 * the browser: the fragment never reaches the web server that serves Haven.
 */
export function buildInvitationLinkFragment(link: InvitationLink): string {
  const params = new URLSearchParams();
  params.set("s", link.serverUrl.replace(/\/$/, ""));
  params.set("t", link.tenantId);
  params.set("i", link.invitationId);
  if (link.nonce) params.set("n", link.nonce);
  params.set("f", link.keyFingerprint);
  const label = cleanInvitationLabel(link.tenantLabel);
  if (label) params.set("l", label);
  return params.toString();
}

/** Parse a link fragment (with or without `#`, or a full URL); null when it is not an invitation. */
export function parseInvitationLinkFragment(input: string): InvitationLink | null {
  if (typeof input !== "string") return null;
  const hashIndex = input.indexOf("#");
  const fragment = hashIndex >= 0 ? input.slice(hashIndex + 1) : input;
  const params = new URLSearchParams(fragment);
  const serverUrl = params.get("s")?.trim() ?? "";
  const tenantId = params.get("t")?.trim().toLowerCase() ?? "";
  const invitationId = params.get("i")?.trim() ?? "";
  const nonce = params.get("n")?.trim() || undefined;
  const keyFingerprint = params.get("f")?.trim() ?? "";
  if (!/^https?:\/\//i.test(serverUrl) || !tenantId || !isValidInvitationId(invitationId)) return null;
  if (!FINGERPRINT_PATTERN.test(keyFingerprint)) return null;
  if (nonce !== undefined && !NONCE_PATTERN.test(nonce)) return null;
  const tenantLabel = cleanInvitationLabel(params.get("l") ?? undefined);
  return {
    serverUrl: serverUrl.replace(/\/$/, ""),
    tenantId,
    invitationId,
    nonce,
    keyFingerprint,
    ...(tenantLabel ? { tenantLabel } : {}),
  };
}
