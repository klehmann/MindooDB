export const SEALED_KEY_PREFIX = "$sealed:";
export const ENCRYPT_FOR_FIELD = "_encryptFor";

export function sealedKeyId(docId: string): string {
  return `${SEALED_KEY_PREFIX}${docId}`;
}

export function isSealedKeyId(keyId: string): boolean {
  return keyId.startsWith(SEALED_KEY_PREFIX);
}

/** The document whose key series `keyId` names (`$sealed:<docId>`), or `undefined`. */
export function sealedKeyDocId(keyId: string): string | undefined {
  return isSealedKeyId(keyId) ? keyId.slice(SEALED_KEY_PREFIX.length) : undefined;
}

/**
 * The group document of a document encrypted with another document's key series
 * (`groupKeyDocId` on create), or `undefined` for an own series or a named key.
 */
export function groupKeyDocIdOf(keyId: string, docId: string): string | undefined {
  const owner = sealedKeyDocId(keyId);
  return owner !== undefined && owner !== docId ? owner : undefined;
}

export type RecipientSpec =
  | string
  | { user: string }
  | { device: string; label?: string }
  | { devicePem: string; label: string };

export interface RecipientOptions {
  includeSelf?: boolean;
  strict?: boolean;
}

export interface EncryptForEntry {
  kind: "user" | "device";
  label?: string;
  addedAt: number;
  addedBy: string;
  /** Fingerprint of the public key wrapped to; used for `sealed` on the handle. */
  keyFingerprint?: string;
  /**
   * Legacy field from when recipients could be expanded from a directory group.
   * No longer written. Still read so older documents keep their payload shape.
   */
  viaGroup?: string;
  removedAt?: number;
  removedBy?: string;
}

export interface RecipientChangeOptions {
  signingKeyPair?: import("../types").SigningKeyPair;
  signingKeyPassword?: string;
  bypassAccessControlPrecheck?: boolean;
  /** See `ChangeOptions.attribution`. */
  attribution?: import("../changeAttribution").ChangeAttributionInput;
  change?: (doc: import("../types").MindooDoc) => void | Promise<void>;
  strict?: boolean;
  /** When setting the list, also keep the caller (default true). */
  includeSelf?: boolean;
}

export interface ResolvedRecipient {
  kind: "user" | "device";
  id: string;
  keyFingerprint: string;
  label?: string;
  addedInEpoch: number;
  sealed: boolean;
}

export interface EntryRecipientWrap {
  kind: "user" | "device";
  keyFingerprint: string;
  wrapped: string;
}

export interface EntryRecipients {
  epoch: number;
  bundle: string;
  wraps: EntryRecipientWrap[];
  namesEncrypted?: string;
}

export interface RecipientChangeResult {
  epoch: number;
  rotated: boolean;
  added: ResolvedRecipient[];
  removed: ResolvedRecipient[];
  skipped: Array<{ spec: RecipientSpec; reason: string }>;
  entryId: string;
}
