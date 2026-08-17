import type { StoreEntryAttachmentRef, StoreEntryMetadata } from "../types";

/**
 * Author entry signatures (security hardening, audit finding #5).
 *
 * Historically (early betas) a store entry's author signature (`StoreEntryMetadata.signature`)
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
 *
 * Exception — backward-compatible trailing extensions: a strictly trailing,
 * optional block whose absence produces ZERO bytes (so the layout is
 * byte-identical to the prior version for entries that do not carry the new
 * data) does NOT bump this value. The `attachmentRefs` block and the
 * `provenance` block (see {@link buildEntrySigningBytes}) are such extensions:
 * entries without attachments and without provenance — including every entry
 * signed before those fields existed — are unaffected and keep verifying.
 */
export const ENTRY_SIGNATURE_LAYOUT_VERSION = 0x01;

/**
 * Tag byte introducing the trailing provenance block. Two independent optional
 * trailing blocks now exist, so the second one is tagged: a verifier rebuilds
 * the layout rather than parsing it, but the tag makes an accidental collision
 * between "an attachmentRefs count" and "a provenance block" impossible.
 */
export const ENTRY_PROVENANCE_BLOCK_TAG = 0x02;
export const ENTRY_RECIPIENTS_BLOCK_TAG = 0x03;

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
  /**
   * Optional snapshot of the document's attachment references as of this entry
   * (see {@link StoreEntryMetadata.attachmentRefs}). Encoded as a backward-compatible
   * TRAILING block (see {@link buildEntrySigningBytes}): when absent or empty it
   * contributes ZERO bytes, so attachment-free entries (every legacy entry) keep
   * the original v1 signing input and verify unchanged. Treat empty as absent.
   */
  attachmentRefs?: StoreEntryAttachmentRef[];
  /**
   * Optional record of the entry this one was copied from (see
   * {@link EntryProvenance}). Encoded as a tagged, backward-compatible TRAILING
   * block (see {@link buildEntrySigningBytes}): when absent it contributes ZERO
   * bytes, so entries that were not produced by a copy keep the original v1
   * signing input and verify unchanged.
   *
   * Binding provenance into the signature is what makes it trustworthy: the
   * copying user attests to the origin claim, so a relay cannot attach, strip or
   * rewrite it after the fact.
   */
  provenance?: EntryProvenance;
  recipients?: import("../userkeys/sealedTypes").EntryRecipients;
}

/**
 * A verifiable record of where a copied entry came from.
 *
 * Written by the `replay` copy strategy, which re-signs every entry as the
 * copying user and would otherwise lose all trace of the original author. The
 * record is not a bare claim: it embeds the source entry's own signed field
 * projection together with the original author's signature over it, so a reader
 * can rebuild those bytes and verify them against the embedded public key. A
 * successful verification proves the named author really signed an entry with
 * this exact `contentHash` — i.e. this exact payload.
 *
 * What it does NOT establish is that the key belongs to who it claims to: that
 * is a directory question, answerable in-tenant and out-of-band across tenants.
 *
 * Note that copying a copy nests provenance (the source projection carries its
 * own provenance, because the original signature only verifies over the exact
 * bytes that were signed). Chains therefore grow one level per generation of
 * copying.
 */
export interface EntryProvenance {
  /** Tenant the source entry was read from. */
  sourceTenantId: string;
  /** Database (store) id the source entry was read from. */
  sourceDbId: string;
  /**
   * The source entry's signed field projection, verbatim. Rebuilding
   * {@link buildEntrySigningBytes} over this reproduces exactly the bytes the
   * original author signed.
   */
  source: EntrySignatureFields;
  /**
   * The original author's `metadataSignature`, base64-encoded.
   *
   * Base64 rather than `Uint8Array` so the whole record is plain JSON and
   * survives every serializer unchanged — the on-disk store, IndexedDB and the
   * network transport each hand-encode binary metadata fields one by one, and a
   * dropped or mangled field here would break the enclosing
   * `metadataSignature`, which binds this block.
   *
   * Absent when the source entry is a legacy v1 entry that predates
   * `metadataSignature`. The provenance record is then still informative but
   * not cryptographically verifiable; `verifyEntryProvenance` reports that
   * distinction explicitly rather than failing.
   */
  sourceMetadataSignature?: string;
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

/**
 * Decode a standard-base64 string to raw bytes. Kept local so this module stays
 * free of platform dependencies and usable on both client and server.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode raw bytes as a standard-base64 string. Inverse of {@link base64ToBytes}. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to stay clear of the argument-count limit on large inputs.
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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
 *  -- trailing attachmentRefs block, PRESENT ONLY IF attachmentRefs.length > 0 --
 *  || uint32BE(attachmentRefs.length)
 *  || ( len(attachmentId) || attachmentId
 *       || len(lastChunkId) || lastChunkId
 *       || int64BE(size) ) * (one triple per ref, in array order)
 *  -- trailing provenance block, PRESENT ONLY IF provenance is set --
 *  || 0x02                          (ENTRY_PROVENANCE_BLOCK_TAG)
 *  || len(sourceTenantId)           || sourceTenantId
 *  || len(sourceDbId)               || sourceDbId
 *  || len(sourceSigningBytes)       || sourceSigningBytes   (recursive layout)
 *  || len(sourceMetadataSignature)  || sourceMetadataSignature (raw bytes,
 *                                      zero-length when absent)
 * ```
 *
 * Both trailing blocks are deliberately backward-compatible extensions: each is
 * appended ONLY when it carries data, so an attachment-free entry that is not a
 * copy (every entry written before these fields existed, and every ordinary
 * revision) produces byte-for-byte the same input as the original layout and
 * its existing signature still verifies. This is why the version byte
 * intentionally stays `0x01` and is NOT bumped despite the new fields: absence
 * is byte-identical to the prior layout. Callers MUST treat an empty
 * `attachmentRefs` array as absent (the canonicalization in
 * {@link entrySignatureFieldsFromEntry} guarantees this) and emit refs in a
 * stable order (the writer sorts by `attachmentId`) so signing and verification
 * produce identical bytes.
 *
 * The provenance block embeds the source entry's signing bytes by recursing
 * into this same function, which is what lets a verifier re-derive the exact
 * bytes the original author signed.
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

  // Backward-compatible trailing block: appended only when non-empty so that
  // attachment-free entries remain byte-identical to the original v1 layout.
  const attachmentRefs = fields.attachmentRefs;
  if (attachmentRefs && attachmentRefs.length > 0) {
    pushUint32BE(parts, attachmentRefs.length);
    for (const ref of attachmentRefs) {
      pushString(parts, ref.attachmentId);
      pushString(parts, ref.lastChunkId);
      pushInt64BE(parts, ref.size);
    }
  }

  // Second trailing block, tagged so it can never be confused with the
  // attachmentRefs count above. Recurses to embed the source entry's own
  // signing bytes verbatim.
  const provenance = fields.provenance;
  if (provenance) {
    parts.push(new Uint8Array([ENTRY_PROVENANCE_BLOCK_TAG]));
    pushString(parts, provenance.sourceTenantId);
    pushString(parts, provenance.sourceDbId);
    pushLengthPrefixed(parts, buildEntrySigningBytes(provenance.source, version));
    pushLengthPrefixed(
      parts,
      provenance.sourceMetadataSignature
        ? base64ToBytes(provenance.sourceMetadataSignature)
        : new Uint8Array(0),
    );
  }

  const recipients = fields.recipients;
  if (recipients && recipients.wraps.length > 0) {
    parts.push(new Uint8Array([ENTRY_RECIPIENTS_BLOCK_TAG]));
    pushString(parts, JSON.stringify(recipients));
  }

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
    | "attachmentRefs"
    | "recipients"
  > & { provenance?: EntryProvenance },
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
    attachmentRefs:
      entry.attachmentRefs && entry.attachmentRefs.length > 0
        ? entry.attachmentRefs
        : undefined,
    provenance: entry.provenance,
    recipients: entry.recipients,
  };
}

/** Convert a PEM-encoded SPKI public key to an ArrayBuffer (dependency-free). */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  return base64ToBytes(base64).buffer as ArrayBuffer;
}

/**
 * Import a PEM-encoded Ed25519 public key for verification. Exported so
 * provenance verification can check an embedded author key without duplicating
 * the PEM handling.
 */
export function importEd25519PublicKeyFromPem(
  publicKeyPem: string,
  subtle: SubtleCrypto,
): Promise<CryptoKey> {
  return subtle.importKey(
    "spki",
    pemToArrayBuffer(publicKeyPem),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
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
  const signature = await subtle.sign({ name: "Ed25519" }, signingPrivateKey, bytes.slice());
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
    | "attachmentRefs"
    | "signature"
  > & { metadataSignature?: Uint8Array; provenance?: EntryProvenance },
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
    | "attachmentRefs"
    | "signature"
  > & { metadataSignature?: Uint8Array; provenance?: EntryProvenance },
  encryptedData: Uint8Array,
  authorPublicKeyPem: string,
  subtle: SubtleCrypto,
  opts?: VerifyEntrySignatureOptions,
): Promise<boolean> {
  const cryptoKey = await importEd25519PublicKeyFromPem(authorPublicKeyPem, subtle);
  return verifyEntrySignatureWithImportedKey(entry, encryptedData, cryptoKey, subtle, opts);
}
