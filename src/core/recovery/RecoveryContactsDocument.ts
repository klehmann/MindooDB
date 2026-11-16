/**
 * Recovery contacts document `rcv_` (docs/userkeys.md §12).
 *
 * One personal document per setup in `userdirectory`, written by the person
 * whose devices it can replace. It holds the encrypted rescue device and one
 * secret share per contact, each sealed to that contact's User-Key.
 *
 * **It uses the tenant `default` key.** Contacts must be able to read it to
 * find their share, and the recovering device never needs to: everything it
 * needs travels in the helper packages. `$publicinfos` would hand the hoster
 * the list of who would vouch for whom, which is none of its business — the
 * same reasoning as `dev_` and `qtn_` (§7.6).
 *
 * **Ids are generated** (`rcv_` plus an object id). A new contact list is a
 * new setup with a new rescue device; the old document is deleted.
 *
 * **A document is a claim until it is verified.** Anyone may create an `rcv_`
 * document naming anyone. {@link verifyRecoveryContactsDoc} accepts one only
 * when its `doc_create` was signed by a device that resolves to the grant of
 * the person the payload names (grant device or certified device), and the
 * named username hashes to the same `username_hash`. The personal-document
 * write rule then keeps everybody else from changing it.
 */
import type { BaseMindooTenantDirectory } from "../BaseMindooTenantDirectory";
import type { MindooDB, MindooDoc } from "../types";
import { USERKEY_FORM } from "../userkeys/types";

export const RECOVERY_CONTACTS_DOC_ID_PREFIX = "rcv_";
export const RECOVERY_CONTACTS_TYPE = "recoverycontacts";
export const RECOVERY_CONTACTS_SCHEMA_VERSION = 1;
/** Any two contacts together can recover; one alone cannot. */
export const RECOVERY_CONTACTS_THRESHOLD = 2;
/** At least two contacts, so that one contact alone never suffices. */
export const RECOVERY_CONTACTS_MIN = 2;

export interface RecoveryContactEntry {
  /** The contact's username, as the person picked it. Display and lookup. */
  username: string;
  /** Fingerprint of the contact's User-Key generation the share is sealed to. */
  userKeyFingerprint: string;
  /** Base64 RSA-OAEP ciphertext of the contact's share. */
  sealedShare: string;
}

export interface RecoveryContactsPayload {
  form: typeof USERKEY_FORM;
  type: typeof RECOVERY_CONTACTS_TYPE;
  schemaVersion: number;
  /** The person, as on their grant. */
  username: string;
  username_hash: string;
  threshold: number;
  createdAt: number;
  rescueDevice: {
    signingPublicKey: string;
    encryptionPublicKey: string;
    signingKeyFingerprint: string;
    /** The `dcert_` document that certifies it. */
    certificateDocId: string;
  };
  /** The rescue device's private keys, AES-256-GCM under the recovery secret. */
  rescueBlob: string;
  contacts: RecoveryContactEntry[];
}

/** A setup that passed {@link verifyRecoveryContactsDoc}. */
export interface RecoveryContactsSetup {
  docId: string;
  payload: RecoveryContactsPayload;
}

export function isRecoveryContactsDocId(docId: string | null | undefined): boolean {
  return typeof docId === "string" && docId.startsWith(RECOVERY_CONTACTS_DOC_ID_PREFIX);
}

export function asRecoveryContactsPayload(data: unknown): RecoveryContactsPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.form !== USERKEY_FORM || d.type !== RECOVERY_CONTACTS_TYPE) return null;
  for (const key of ["username", "username_hash", "rescueBlob"]) {
    if (typeof d[key] !== "string" || !(d[key] as string)) return null;
  }
  if (typeof d.threshold !== "number" || typeof d.createdAt !== "number") return null;
  const rescue = d.rescueDevice as Record<string, unknown> | undefined;
  if (!rescue || typeof rescue !== "object") return null;
  for (const key of ["signingPublicKey", "encryptionPublicKey", "signingKeyFingerprint", "certificateDocId"]) {
    if (typeof rescue[key] !== "string" || !(rescue[key] as string)) return null;
  }
  if (!Array.isArray(d.contacts)) return null;
  for (const entry of d.contacts as unknown[]) {
    const c = entry as Record<string, unknown>;
    if (!c || typeof c.username !== "string" || typeof c.userKeyFingerprint !== "string" || typeof c.sealedShare !== "string") {
      return null;
    }
  }
  return d as unknown as RecoveryContactsPayload;
}

async function resolveCreateSigner(db: MindooDB, docId: string): Promise<string | null> {
  try {
    // History is ordered causally, so `doc_create` is on the first page.
    const page = await db.getDocumentHistoryPage(docId, { limit: 10 });
    const create = page.entries.find((entry) => entry.entryType === "doc_create");
    return create?.changeCreatedByPublicKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify an `rcv_` document: payload shape, creator bound to the person the
 * payload names, username bound to that person's hash. Returns `null` for
 * anything that fails — an unverifiable setup is litter, not an error.
 */
export async function verifyRecoveryContactsDoc(input: {
  db: MindooDB;
  doc: MindooDoc;
  directory: BaseMindooTenantDirectory;
}): Promise<RecoveryContactsSetup | null> {
  const { db, doc, directory } = input;
  const docId = doc.getId();
  if (!isRecoveryContactsDocId(docId) || doc.isDeleted()) return null;
  const payload = asRecoveryContactsPayload(doc.getData());
  if (!payload) return null;
  if (!(await personalDocBelongsTo({ db, docId, directory, username: payload.username, usernameHash: payload.username_hash }))) {
    return null;
  }
  return { docId, payload: JSON.parse(JSON.stringify(payload)) as RecoveryContactsPayload };
}

/**
 * Whether a personal document was created by the person it names: its
 * `doc_create` signer resolves (grant device or certified device) to the grant
 * with `usernameHash`, and `username` hashes to that same value.
 */
export async function personalDocBelongsTo(input: {
  db: MindooDB;
  docId: string;
  directory: BaseMindooTenantDirectory;
  username: string;
  usernameHash: string;
}): Promise<boolean> {
  const creator = await resolveCreateSigner(input.db, input.docId);
  if (!creator) return false;
  const resolved = await input.directory.resolveSignerToGrant(creator, Number.MAX_SAFE_INTEGER);
  if (!resolved || resolved.grant.usernameHash !== input.usernameHash) return false;
  const candidates = await input.directory.getUsernameHashCandidates(input.username);
  return candidates.includes(input.usernameHash);
}
