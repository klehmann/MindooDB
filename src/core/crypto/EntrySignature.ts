import type { StoreEntryMetadata } from "../types";

/**
 * Author entry signatures (security hardening, audit finding #5).
 *
 * Historically a store entry's author signature (`StoreEntryMetadata.signature`)
 * covered ONLY the encrypted payload bytes. That leaves every cleartext metadata
 * field (`entryType`, `docId`, `decryptionKeyId`, `createdAt`, `dependencyIds`,
 * `contentHash`, ...) unauthenticated: a relay holding any trusted key could
 * tweak metadata on an un-witnessed/legacy entry and the legacy signature would
 * still verify.
 *
 * This module adds a second, stronger author signature
 * (`StoreEntryMetadata.metadataSignature`) computed over a **fixed, versioned,
 * length-prefixed byte layout** that binds the security-relevant metadata
 * alongside the `contentHash` (which itself is `SHA-256(encryptedData)`, so the
 * ciphertext is transitively bound). It mirrors {@link WitnessReceipt} in style
 * and is intentionally free of tenant/IO dependencies so it can be reused on
 * both client and server and unit-tested in isolation.
 *
 * Backward compatibility: writers populate BOTH `signature` (legacy, over
 * ciphertext) and `metadataSignature`. Verifiers prefer `metadataSignature`
 * when present and fall back to the legacy `signature` for v1/legacy entries
 * that predate this field, so old entries remain readable.
 */

/**
 * Version byte of the canonical entry-signature layout. Any change to the field
 * set or ordering MUST bump this value (and verifiers MUST reject unknown
 * versions).
 */
export const ENTRY_SIGNATURE_LAYOUT_VERSION = 0x01;

/**
 * The exact set of metadata fields bound by an author's `metadataSignature`, in
 * the order they appear in the byte layout.
 */
export interface EntrySignatureFields {
  entryType: string;
  id: string;
  docId: string;
  decryptionKeyId: string;
  createdAt: number;
  dependencyIds: string[];
  /** SHA-256 of the encrypted payload (transitively binds the ciphertext). */
  contentHash: string;
  /** Ed25519 public key (PEM) of the author. */
  createdByPublicKey: string;
}

/** Options for the version-aware entry-signature verifiers. */
export interface VerifyEntrySignatureOptions {
  /**
   * When true, an entry that lacks a `metadataSignature` (legacy/v1) is
   * rejected instead of falling back to the ciphertext-only signature. Callers
   * set this per entry based on the tenant's `requireMetadataSignatureSince`
   * cutoff vs. the entry's trusted time.
   */
  requireMetadataSignature?: boolean;
}

const textEncoder = new TextEncoder();

function pushLengthPrefixed(parts: Uint8Array[], bytes: Uint8Array): void {
  const lengthPrefix = new Uint8Array(4);
  new DataView(lengthPrefix.buffer).setUint32(0, bytes.length, false /* big-endian */);
  parts.push(lengthPrefix, bytes);
}

function pushString(parts: Uint8Array[], value: string): void {
  pushLengthPrefixed(parts, textEncoder.encode(value));
}

function pushUint32BE(parts: Uint8Array[], value: number): void {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, false /* big-endian */);
  parts.push(buf);
}

function pushInt64BE(parts: Uint8Array[], value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Entry signature int64 field must be an integer, got: ${value}`);
  }
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, BigInt(value), false /* big-endian */);
  parts.push(buf);
}

/**
 * Build the canonical, versioned, length-prefixed byte layout the author signs
 * over.
 *
 * Layout:
 * ```
 * version(1 byte)
 *  || len(entryType)          || entryType
 *  || len(id)                 || id
 *  || len(docId)              || docId
 *  || len(decryptionKeyId)    || decryptionKeyId
 *  || int64BE(createdAt)
 *  || uint32BE(dependencyIds.length)
 *  || ( len(dep) || dep ) *   (in array order)
 *  || len(contentHash)        || contentHash
 *  || len(createdByPublicKey) || createdByPublicKey
 * ```
 */
export function buildEntrySigningBytes(
  fields: EntrySignatureFields,
  version: number = ENTRY_SIGNATURE_LAYOUT_VERSION,
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([version & 0xff]));
  pushString(parts, fields.entryType);
  pushString(parts, fields.id);
  pushString(parts, fields.docId);
  pushString(parts, fields.decryptionKeyId);
  pushInt64BE(parts, fields.createdAt);
  pushUint32BE(parts, fields.dependencyIds.length);
  for (const dep of fields.dependencyIds) {
    pushString(parts, dep);
  }
  pushString(parts, fields.contentHash);
  pushString(parts, fields.createdByPublicKey);

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Project the signed fields out of an entry's metadata. */
export function entrySignatureFieldsFromEntry(
  entry: Pick<
    StoreEntryMetadata,
    | "entryType"
    | "id"
    | "docId"
    | "decryptionKeyId"
    | "createdAt"
    | "dependencyIds"
    | "contentHash"
    | "createdByPublicKey"
  >,
): EntrySignatureFields {
  return {
    entryType: entry.entryType,
    id: entry.id,
    docId: entry.docId,
    decryptionKeyId: entry.decryptionKeyId,
    createdAt: entry.createdAt,
    dependencyIds: entry.dependencyIds,
    contentHash: entry.contentHash,
    createdByPublicKey: entry.createdByPublicKey,
  };
}

/** Convert a PEM-encoded SPKI public key to an ArrayBuffer (dependency-free). */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Sign the canonical entry layout with an already-imported Ed25519 private key.
 * Returns the raw signature bytes to store as `metadataSignature`.
 */
export async function signEntryMetadata(
  fields: EntrySignatureFields,
  signingPrivateKey: CryptoKey,
  subtle: SubtleCrypto,
  version: number = ENTRY_SIGNATURE_LAYOUT_VERSION,
): Promise<Uint8Array> {
  const bytes = buildEntrySigningBytes(fields, version);
  const signature = await subtle.sign({ name: "Ed25519" }, signingPrivateKey, bytes.buffer as ArrayBuffer);
  return new Uint8Array(signature);
}

/**
 * Pure cryptographic verification of an entry's author signature, version-aware.
 *
 * - If `metadataSignature` is present, verifies it over {@link buildEntrySigningBytes}
 *   (strong, metadata-binding scheme; v2+).
 * - Otherwise falls back to the legacy `signature` over `encryptedData`
 *   (v1/legacy entries that predate the metadata-binding scheme).
 *
 * This does NOT decide whether the author key is *trusted* — callers must
 * separately confirm the key via the tenant directory.
 */
export async function verifyEntrySignatureWithImportedKey(
  entry: Pick<
    StoreEntryMetadata,
    | "entryType"
    | "id"
    | "docId"
    | "decryptionKeyId"
    | "createdAt"
    | "dependencyIds"
    | "contentHash"
    | "createdByPublicKey"
    | "signature"
  > & { metadataSignature?: Uint8Array },
  encryptedData: Uint8Array,
  cryptoKey: CryptoKey,
  subtle: SubtleCrypto,
  opts?: VerifyEntrySignatureOptions,
): Promise<boolean> {
  if (entry.metadataSignature) {
    const bytes = buildEntrySigningBytes(entrySignatureFieldsFromEntry(entry));
    return subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      entry.metadataSignature.buffer as ArrayBuffer,
      bytes.buffer as ArrayBuffer,
    );
  }
  // Storage-format floor (audit #5 follow-up): when the tenant requires the
  // metadata-binding signature for this entry's trusted time, refuse to accept
  // the weaker legacy ciphertext-only signature. Returning false routes the
  // entry to the caller's fail-closed / quarantine path.
  if (opts?.requireMetadataSignature) {
    return false;
  }
  return subtle.verify(
    { name: "Ed25519" },
    cryptoKey,
    entry.signature.buffer as ArrayBuffer,
    encryptedData.buffer as ArrayBuffer,
  );
}

/**
 * Same as {@link verifyEntrySignatureWithImportedKey} but imports the author's
 * PEM-encoded public key first. Convenient for one-off verifications (e.g. on
 * the server's push path) where no key cache is available.
 */
export async function verifyEntrySignatureCrypto(
  entry: Pick<
    StoreEntryMetadata,
    | "entryType"
    | "id"
    | "docId"
    | "decryptionKeyId"
    | "createdAt"
    | "dependencyIds"
    | "contentHash"
    | "createdByPublicKey"
    | "signature"
  > & { metadataSignature?: Uint8Array },
  encryptedData: Uint8Array,
  authorPublicKeyPem: string,
  subtle: SubtleCrypto,
  opts?: VerifyEntrySignatureOptions,
): Promise<boolean> {
  const cryptoKey = await subtle.importKey(
    "spki",
    pemToArrayBuffer(authorPublicKeyPem),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return verifyEntrySignatureWithImportedKey(entry, encryptedData, cryptoKey, subtle, opts);
}
