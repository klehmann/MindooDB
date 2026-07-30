/**
 * Building and verifying the provenance record attached to copied entries.
 *
 * When a document is copied with `mode: "history"` but the original signatures
 * cannot be carried over (see `feasibility.ts` for exactly when that is), every
 * produced entry is re-signed by the copying user. That would normally erase
 * all trace of who actually wrote each revision. The provenance record puts it
 * back — and does so verifiably rather than as an unbacked assertion, by
 * embedding the source entry's own signed projection together with the original
 * author's signature over it.
 *
 * @module
 */

import {
  buildEntrySigningBytes,
  bytesToBase64,
  entrySignatureFieldsFromEntry,
  importEd25519PublicKeyFromPem,
  base64ToBytes,
  type EntryProvenance,
} from "../crypto/EntrySignature";
import type { StoreEntryMetadata } from "../types";

/** Outcome of {@link verifyEntryProvenance}. */
export type ProvenanceVerificationStatus =
  /** The entry carries no provenance record: it was not produced by a copy. */
  | "absent"
  /** The original author's signature over the embedded projection verifies. */
  | "verified"
  /**
   * The record is present and well-formed but carries no source signature,
   * because the source entry predates `metadataSignature`. Informative, not
   * provable.
   */
  | "unverifiable"
  /** A source signature is present and does NOT verify. Treat as tampering. */
  | "invalid";

/** Result of verifying an entry's provenance record. */
export interface ProvenanceVerification {
  /** What could be established about the record. */
  status: ProvenanceVerificationStatus;
  /** The record itself, when the entry has one. */
  provenance?: EntryProvenance;
  /**
   * True when this entry's `contentHash` equals the source entry's, i.e. the
   * copy holds byte-identical ciphertext and the verified original signature
   * therefore covers *this* entry's payload too.
   *
   * False when the copy was re-encrypted (a different tenant or key). The
   * provenance then still proves the named author signed the original payload,
   * but nothing ties that payload to this entry's ciphertext beyond the copying
   * user's own signature.
   */
  payloadUnchanged: boolean;
  /** Human-readable explanation for a non-`verified` status. */
  reason?: string;
}

/**
 * Capture a source entry as a provenance record for its copy.
 *
 * The projection is taken with the same canonicalization the signer used, so
 * rebuilding it reproduces the original signing input exactly.
 */
export function buildProvenanceFromEntry(
  sourceEntry: StoreEntryMetadata,
  sourceTenantId: string,
  sourceDbId: string,
): EntryProvenance {
  return {
    sourceTenantId,
    sourceDbId,
    source: entrySignatureFieldsFromEntry(sourceEntry),
    sourceMetadataSignature: sourceEntry.metadataSignature
      ? bytesToBase64(sourceEntry.metadataSignature)
      : undefined,
  };
}

/**
 * Verify that the original author named in an entry's provenance record really
 * signed the payload the record describes.
 *
 * This is a purely cryptographic check against the public key embedded in the
 * record, which is what makes it work across tenants where the source author is
 * absent from the local directory. It deliberately does NOT establish that the
 * key belongs to the person it claims to — confirm that against the tenant
 * directory in-tenant, or out of band across tenants.
 *
 * A caller that also wants to know the copy itself is intact should verify the
 * entry's own `metadataSignature` as usual; that signature binds this record,
 * so a relay cannot attach, alter or remove it.
 */
export async function verifyEntryProvenance(
  entry: Pick<StoreEntryMetadata, "contentHash"> & { provenance?: EntryProvenance },
  subtle: SubtleCrypto,
): Promise<ProvenanceVerification> {
  const provenance = entry.provenance;
  if (!provenance) {
    return { status: "absent", payloadUnchanged: false };
  }

  const payloadUnchanged = entry.contentHash === provenance.source.contentHash;

  if (!provenance.sourceMetadataSignature) {
    return {
      status: "unverifiable",
      provenance,
      payloadUnchanged,
      reason:
        "The source entry predates metadataSignature, so the origin claim cannot " +
        "be checked cryptographically. It is still bound to the copying user's " +
        "own signature.",
    };
  }

  const signingBytes = buildEntrySigningBytes(provenance.source);
  let verified: boolean;
  try {
    const cryptoKey = await importEd25519PublicKeyFromPem(
      provenance.source.createdByPublicKey,
      subtle,
    );
    verified = await subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      base64ToBytes(provenance.sourceMetadataSignature).buffer as ArrayBuffer,
      signingBytes.buffer as ArrayBuffer,
    );
  } catch (error) {
    return {
      status: "invalid",
      provenance,
      payloadUnchanged,
      reason: `Provenance verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!verified) {
    return {
      status: "invalid",
      provenance,
      payloadUnchanged,
      reason:
        "The embedded source signature does not match the embedded source " +
        "projection. The provenance record has been tampered with or was " +
        "fabricated.",
    };
  }

  return { status: "verified", provenance, payloadUnchanged };
}
