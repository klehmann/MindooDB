import { StoreEntryMetadata } from "../types";

/**
 * Witness receipts (docs/accesscontrol.md §5).
 *
 * A witness receipt is an Ed25519 signature, produced by a trusted sync server
 * ("witness"), attesting that a store entry was accepted into the tenant at a
 * specific `receivedAt` time and satisfied the Tier 1 (identity) access policy
 * at that moment. Other replicas trust this attestation instead of
 * re-evaluating Tier 1 forever, which keeps the system stable under eventual
 * consistency (§4, Scenario C).
 *
 * The signature is computed over a **fixed, versioned, length-prefixed byte
 * layout** rather than JSON, to avoid canonicalization ambiguity. The layout
 * deliberately binds every attribute Tier 1 depends on — `entryType`, `dbid`
 * and `decryptionKeyId` in particular — so a relay cannot transplant a receipt
 * onto a different operation type, database, or key (§5.2).
 *
 * This module is intentionally free of any tenant/IO dependencies so it can be
 * unit-tested in isolation and reused on both client and server.
 */

/**
 * Version byte of the canonical signing layout. Any change to the field set or
 * ordering MUST bump this value (and verifiers MUST reject unknown versions).
 */
export const WITNESS_RECEIPT_LAYOUT_VERSION = 0x01;

/**
 * The exact set of fields bound by a witness receipt signature, in the order
 * they appear in the byte layout (§5.2).
 */
export interface WitnessReceiptFields {
  /** Store entry operation type, e.g. `doc_create` / `doc_change`. */
  entryType: string;
  /**
   * The database the witness accepted the entry under. This is the sync/store
   * context, not necessarily a standalone metadata field; binding it prevents
   * an entry witnessed for one database being presented as belonging to another.
   */
  dbid: string;
  /** SHA-256 hash of the encrypted payload. */
  contentHash: string;
  /** Store entry id. */
  id: string;
  /** Document id the entry belongs to. */
  docId: string;
  /** Id of the symmetric key the entry was encrypted with. */
  decryptionKeyId: string;
  /** Author-reported creation time (ms epoch). */
  createdAt: number;
  /** Ed25519 public key (PEM) of the author. */
  createdByPublicKey: string;
  /** Witness-assigned acceptance time (ms epoch). */
  receivedAt: number;
  /** Ed25519 public key (PEM) of the witness. */
  receivedByPublicKey: string;
}

const textEncoder = new TextEncoder();

/**
 * Append a 32-bit big-endian length prefix followed by the raw bytes.
 * `len(x)` in the §5.2 layout.
 */
function pushLengthPrefixed(parts: Uint8Array[], bytes: Uint8Array): void {
  const lengthPrefix = new Uint8Array(4);
  new DataView(lengthPrefix.buffer).setUint32(0, bytes.length, false /* big-endian */);
  parts.push(lengthPrefix, bytes);
}

/** Append a UTF-8, length-prefixed string. */
function pushString(parts: Uint8Array[], value: string): void {
  pushLengthPrefixed(parts, textEncoder.encode(value));
}

/** Append a 64-bit big-endian integer (`int64BE` in the §5.2 layout). */
function pushInt64BE(parts: Uint8Array[], value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Witness receipt int64 field must be an integer, got: ${value}`);
  }
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, BigInt(value), false /* big-endian */);
  parts.push(buf);
}

/**
 * Build the canonical, versioned, length-prefixed byte layout that a witness
 * signs over (docs/accesscontrol.md §5.2).
 *
 * Layout:
 * ```
 * version(1 byte)
 *  || len(entryType)          || entryType
 *  || len(dbid)               || dbid
 *  || len(contentHash)        || contentHash
 *  || len(id)                 || id
 *  || len(docId)              || docId
 *  || len(decryptionKeyId)    || decryptionKeyId
 *  || int64BE(createdAt)
 *  || len(createdByPublicKey) || createdByPublicKey
 *  || int64BE(receivedAt)
 *  || len(receivedByPublicKey)|| receivedByPublicKey
 * ```
 */
export function buildWitnessSigningBytes(
  fields: WitnessReceiptFields,
  version: number = WITNESS_RECEIPT_LAYOUT_VERSION
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([version & 0xff]));
  pushString(parts, fields.entryType);
  pushString(parts, fields.dbid);
  pushString(parts, fields.contentHash);
  pushString(parts, fields.id);
  pushString(parts, fields.docId);
  pushString(parts, fields.decryptionKeyId);
  pushInt64BE(parts, fields.createdAt);
  pushString(parts, fields.createdByPublicKey);
  pushInt64BE(parts, fields.receivedAt);
  pushString(parts, fields.receivedByPublicKey);

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Derive the {@link WitnessReceiptFields} for an entry the witness is about to
 * stamp. `dbid`, `receivedAt` and `receivedByPublicKey` come from the witness's
 * own context (which database it accepted the entry under, its clock, its key);
 * everything else is read from the entry's existing metadata.
 */
export function witnessFieldsFromEntry(
  entry: Pick<
    StoreEntryMetadata,
    "entryType" | "contentHash" | "id" | "docId" | "decryptionKeyId" | "createdAt" | "createdByPublicKey"
  >,
  context: { dbid: string; receivedAt: number; receivedByPublicKey: string }
): WitnessReceiptFields {
  return {
    entryType: entry.entryType,
    dbid: context.dbid,
    contentHash: entry.contentHash,
    id: entry.id,
    docId: entry.docId,
    decryptionKeyId: entry.decryptionKeyId,
    createdAt: entry.createdAt,
    createdByPublicKey: entry.createdByPublicKey,
    receivedAt: context.receivedAt,
    receivedByPublicKey: context.receivedByPublicKey,
  };
}

/**
 * Convert a PEM-encoded SPKI public key to an ArrayBuffer. Mirrors
 * `BaseMindooTenant.pemToArrayBuffer` but kept dependency-free here.
 */
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
 * Sign a witness receipt over {@link buildWitnessSigningBytes} using an already
 * imported Ed25519 private `CryptoKey`. The caller (the witness/server) is
 * responsible for decrypting and importing its own signing key.
 *
 * @returns the raw Ed25519 signature bytes (store as `receivedDateSignature`).
 */
export async function signWitnessReceipt(
  fields: WitnessReceiptFields,
  signingPrivateKey: CryptoKey,
  subtle: SubtleCrypto,
  version: number = WITNESS_RECEIPT_LAYOUT_VERSION
): Promise<Uint8Array> {
  const bytes = buildWitnessSigningBytes(fields, version);
  const signature = await subtle.sign({ name: "Ed25519" }, signingPrivateKey, bytes.buffer as ArrayBuffer);
  return new Uint8Array(signature);
}

/**
 * The witness fields a server stamps onto an accepted entry (§5.3): the
 * acceptance time, the witness identity, and the signature binding them to the
 * entry. Merging this into an entry's metadata produces a witnessed entry.
 */
export interface StampedWitnessFields {
  receivedAt: number;
  receivedByPublicKey: string;
  receivedDateSignature: Uint8Array;
}

/**
 * A server's witness identity: its public key (PEM, stored as
 * `receivedByPublicKey`) and the imported Ed25519 private key used to sign.
 * Kept as a small struct so the server store can stamp receipts without
 * depending on the full tenant crypto stack.
 */
export interface WitnessSigner {
  publicKeyPem: string;
  signingPrivateKey: CryptoKey;
  subtle: SubtleCrypto;
}

/**
 * Produce the witness fields for an entry the server has decided to accept
 * (§5.3). The caller merges the returned fields into the stored metadata and
 * echoes them back to the pushing client so every replica gets the receipt.
 */
export async function stampEntryReceipt(
  entry: Pick<
    StoreEntryMetadata,
    "entryType" | "contentHash" | "id" | "docId" | "decryptionKeyId" | "createdAt" | "createdByPublicKey"
  >,
  context: { dbid: string; receivedAt: number },
  signer: WitnessSigner
): Promise<StampedWitnessFields> {
  const fields = witnessFieldsFromEntry(entry, {
    dbid: context.dbid,
    receivedAt: context.receivedAt,
    receivedByPublicKey: signer.publicKeyPem,
  });
  const signature = await signWitnessReceipt(fields, signer.signingPrivateKey, signer.subtle);
  return {
    receivedAt: context.receivedAt,
    receivedByPublicKey: signer.publicKeyPem,
    receivedDateSignature: signature,
  };
}

/**
 * Verify a witness receipt signature against the witness public key (PEM).
 *
 * This is a pure cryptographic check of the signature over the §5.2 layout. It
 * does NOT decide whether the witness is *trusted* — callers must separately
 * confirm `receivedByPublicKey` is in the tenant's trusted-witness list and run
 * the receipt-time validation rules (§5.4: per-witness monotonicity, wall-clock
 * sanity) before relying on the attestation.
 *
 * Unknown layout versions are rejected.
 */
export async function verifyWitnessReceipt(
  fields: WitnessReceiptFields,
  signature: Uint8Array,
  witnessPublicKeyPem: string,
  subtle: SubtleCrypto,
  version: number = WITNESS_RECEIPT_LAYOUT_VERSION
): Promise<boolean> {
  if (version !== WITNESS_RECEIPT_LAYOUT_VERSION) {
    return false;
  }
  const bytes = buildWitnessSigningBytes(fields, version);
  const cryptoKey = await subtle.importKey(
    "spki",
    pemToArrayBuffer(witnessPublicKeyPem),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return subtle.verify(
    { name: "Ed25519" },
    cryptoKey,
    signature.buffer as ArrayBuffer,
    bytes.buffer as ArrayBuffer
  );
}
