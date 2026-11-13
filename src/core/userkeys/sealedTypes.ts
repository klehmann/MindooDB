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

/**
 * What new readers get when the caller does not say (`RecipientChangeOptions.history`).
 * `"all"` keeps a shared document complete: its existing attachments are encrypted
 * with the older generations and stay unreadable for a reader added with `"none"`.
 */
export const DEFAULT_RECIPIENT_HISTORY: "all" | "none" = "all";

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
  /**
   * First key generation (epoch) this reader holds. Absent: the whole history.
   * Set by `addRecipients(..., { history: "none" })`, cleared by `revealHistory`.
   * Every later re-seal honours it, so the reader never gets older generations.
   */
  historyFrom?: number;
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
  /**
   * Adding readers (`addRecipients`, additions of `setRecipients`).
   * `"all"` (default, {@link DEFAULT_RECIPIENT_HISTORY}): new readers decrypt
   * the history, as far back as the caller holds it.
   * `"none"`: the key rotates first and new readers get only the new
   * generation, so nothing written before they joined is readable for them
   * (including existing attachments); `revealHistory` can hand them the older
   * generations later.
   */
  history?: "all" | "none";
}

export interface ResolvedRecipient {
  kind: "user" | "device";
  id: string;
  keyFingerprint: string;
  label?: string;
  addedInEpoch: number;
  sealed: boolean;
  /** First generation this reader holds; absent for the whole history. */
  historyFrom?: number;
}

export interface EntryRecipientWrap {
  kind: "user" | "device";
  keyFingerprint: string;
  wrapped: string;
}

/**
 * Readers without the whole history: their own bundle with only the
 * generations from `from` (epoch, 1-based) up to the newest.
 */
export interface EntryRecipientTier {
  from: number;
  bundle: string;
  wraps: EntryRecipientWrap[];
}

export interface EntryRecipients {
  epoch: number;
  bundle: string;
  wraps: EntryRecipientWrap[];
  namesEncrypted?: string;
  /**
   * First epoch in `bundle`; absent means 1 (the whole series). Above 1 when the
   * replica that sealed this block did not hold the older generations itself:
   * readers entitled to more take them from the earlier blocks they can open.
   */
  bundleFrom?: number;
  /** Bundles for readers with a history limit (`historyFrom`). */
  partial?: EntryRecipientTier[];
}

/** Whether a recipient block wraps to anyone (whole history or partial). */
export function hasRecipientWraps(recipients: EntryRecipients | undefined): boolean {
  if (!recipients) return false;
  if (recipients.wraps?.length) return true;
  return (recipients.partial ?? []).some((tier) => tier.wraps?.length);
}

/** All wraps of a recipient block, whole-history and partial. */
export function allRecipientWraps(recipients: EntryRecipients | undefined): EntryRecipientWrap[] {
  if (!recipients) return [];
  return [...(recipients.wraps ?? []), ...(recipients.partial ?? []).flatMap((tier) => tier.wraps ?? [])];
}

export interface RecipientChangeResult {
  epoch: number;
  rotated: boolean;
  added: ResolvedRecipient[];
  removed: ResolvedRecipient[];
  skipped: Array<{ spec: RecipientSpec; reason: string }>;
  entryId: string;
}
