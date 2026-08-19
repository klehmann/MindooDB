/**
 * JSON wire codec for store-entry metadata.
 *
 * Binary fields (`signature`, `metadataSignature`, `receivedDateSignature`,
 * `encryptedData`) travel as standard base64; everything else is plain JSON.
 * Client {@link HttpTransport} and server {@link MindooDBServer} MUST use this
 * codec rather than parallel field lists — signed trailing blocks
 * (`attachmentRefs`, `provenance`, `recipients`) are bound into
 * `metadataSignature`, and dropping any of them on the wire makes the server
 * reject the entry with "invalid author signature".
 */

import { base64ToBytes, bytesToBase64 } from "../../crypto/EntrySignature";
import type { EntryProvenance } from "../../crypto/EntrySignature";
import type {
  StoreEntry,
  StoreEntryAttachmentRef,
  StoreEntryMetadata,
  StoreEntryType,
} from "../../types";
import type { EntryRecipients } from "../../userkeys/sealedTypes";

/** JSON-safe metadata: binary fields are standard-base64 strings. */
export interface SerializedEntryMetadata {
  entryType: StoreEntryType;
  id: string;
  contentHash: string;
  docId: string;
  dependencyIds: string[];
  createdAt: number;
  receiptOrder?: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  snapshotHeadHashes?: string[];
  snapshotHeadEntryIds?: string[];
  signature: string;
  metadataSignature?: string;
  originalSize: number;
  encryptedSize: number;
  receivedAt?: number;
  receivedByPublicKey?: string;
  receivedDateSignature?: string;
  attachmentRefs?: StoreEntryAttachmentRef[];
  provenance?: EntryProvenance;
  /**
   * Sealed-document recipient block. Bound into `metadataSignature` as trailing
   * tag `0x03`; must round-trip or verification fails on ingest.
   */
  recipients?: EntryRecipients;
  entryVersion?: number;
}

export interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string;
}

export function serializeEntryMetadata(metadata: StoreEntryMetadata): SerializedEntryMetadata {
  return {
    entryType: metadata.entryType,
    id: metadata.id,
    contentHash: metadata.contentHash,
    docId: metadata.docId,
    dependencyIds: metadata.dependencyIds,
    createdAt: metadata.createdAt,
    receiptOrder: metadata.receiptOrder,
    createdByPublicKey: metadata.createdByPublicKey,
    decryptionKeyId: metadata.decryptionKeyId,
    snapshotHeadHashes: metadata.snapshotHeadHashes,
    snapshotHeadEntryIds: metadata.snapshotHeadEntryIds,
    signature: bytesToBase64(metadata.signature),
    metadataSignature: metadata.metadataSignature
      ? bytesToBase64(metadata.metadataSignature)
      : undefined,
    originalSize: metadata.originalSize,
    encryptedSize: metadata.encryptedSize,
    receivedAt: metadata.receivedAt,
    receivedByPublicKey: metadata.receivedByPublicKey,
    receivedDateSignature: metadata.receivedDateSignature
      ? bytesToBase64(metadata.receivedDateSignature)
      : undefined,
    // Signed trailing blocks: plain JSON, no binary. Must survive the
    // round-trip or metadataSignature verification fails on the receiver.
    attachmentRefs: metadata.attachmentRefs,
    provenance: metadata.provenance,
    recipients: metadata.recipients,
    entryVersion: metadata.entryVersion,
  };
}

export function deserializeEntryMetadata(serialized: SerializedEntryMetadata): StoreEntryMetadata {
  return {
    entryType: serialized.entryType,
    id: serialized.id,
    contentHash: serialized.contentHash,
    docId: serialized.docId,
    dependencyIds: serialized.dependencyIds,
    createdAt: serialized.createdAt,
    receiptOrder: serialized.receiptOrder,
    createdByPublicKey: serialized.createdByPublicKey,
    decryptionKeyId: serialized.decryptionKeyId,
    snapshotHeadHashes: serialized.snapshotHeadHashes,
    snapshotHeadEntryIds: serialized.snapshotHeadEntryIds,
    signature: base64ToBytes(serialized.signature),
    metadataSignature: serialized.metadataSignature
      ? base64ToBytes(serialized.metadataSignature)
      : undefined,
    originalSize: serialized.originalSize,
    encryptedSize: serialized.encryptedSize,
    receivedAt: serialized.receivedAt,
    receivedByPublicKey: serialized.receivedByPublicKey,
    receivedDateSignature: serialized.receivedDateSignature
      ? base64ToBytes(serialized.receivedDateSignature)
      : undefined,
    attachmentRefs: serialized.attachmentRefs,
    provenance: serialized.provenance,
    recipients: serialized.recipients,
    entryVersion: serialized.entryVersion,
  };
}

export function serializeStoreEntry(entry: StoreEntry): SerializedEntry {
  return {
    ...serializeEntryMetadata(entry),
    encryptedData: bytesToBase64(entry.encryptedData),
  };
}

export function deserializeStoreEntry(serialized: SerializedEntry): StoreEntry {
  return {
    ...deserializeEntryMetadata(serialized),
    encryptedData: base64ToBytes(serialized.encryptedData),
  };
}
