export const SEALED_KEY_PREFIX = "$sealed:";
export const ENCRYPT_FOR_FIELD = "_encryptFor";

export function sealedKeyId(docId: string): string {
  return `${SEALED_KEY_PREFIX}${docId}`;
}

export function isSealedKeyId(keyId: string): boolean {
  return keyId.startsWith(SEALED_KEY_PREFIX);
}

export type RecipientSpec =
  | string
  | { user: string }
  | { device: string; label?: string }
  | { devicePem: string; label: string }
  | { group: string };

export interface RecipientOptions {
  includeSelf?: boolean;
  strict?: boolean;
}

export interface EncryptForEntry {
  kind: "user" | "device" | "group";
  label?: string;
  addedAt: number;
  addedBy: string;
  /** Fingerprint of the public key wrapped to; used for `sealed` on the handle. */
  keyFingerprint?: string;
  viaGroup?: string;
  removedAt?: number;
  removedBy?: string;
}

export interface RecipientChangeOptions {
  signingKeyPair?: import("../types").SigningKeyPair;
  signingKeyPassword?: string;
  bypassAccessControlPrecheck?: boolean;
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
  viaGroup?: string;
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
