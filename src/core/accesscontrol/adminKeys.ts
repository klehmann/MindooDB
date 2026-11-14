/**
 * Delegated administrators (docs/accesscontrol.md §6.13).
 *
 * The tenant's `administrationPublicKey` is the **root** admin key and stays the
 * only fixed trust anchor. The root may delegate administration to further
 * signing keys by writing one `acl_adminkey_<fingerprint>` document per key into
 * the `directory` database. Each document carries a validity window in witness
 * time (`validFrom`, `validUntil`), so a key can be deactivated as of a date
 * without rewriting what it signed before.
 *
 * `isAdminAt(key, T)` is true when `key` is the root, or when the directory
 * state at `T` holds an admin-key document for `key` with
 * `validFrom ≤ T < validUntil`. `T` is the witness time (`receivedAt`) of a
 * stored entry, or the server's clock for live decisions (auth, read gate,
 * push check).
 *
 * Rules that keep witness time honest:
 * - Only the root may write `acl_adminkey_*` (and `acl_trustedwitness_*`, which
 *   decides whose receipts count). Enforced on the client and on the server.
 * - A delegated admin's directory entries count on other replicas only with a
 *   valid receipt of a trusted witness. Without one they are visible on the
 *   device that wrote them only.
 * - No retroactive effect: a window never starts or ends before the witness
 *   time of the revision that set it (see {@link adminKeyWindowFromDoc}).
 */
import { ACCESS_CONTROL_FORM, encodeAclIdComponent } from "./types";
import { CUSTOM_DOC_ID_REGEX } from "../types";

/** `type` of an admin-key document (form {@link ACCESS_CONTROL_FORM}). */
export const ADMIN_KEY_TYPE = "adminkey";

/** Document-id prefix of admin-key documents in `directory`. */
export const ACL_ADMIN_KEY_PREFIX = "acl_adminkey_";

/** Document-id prefix of trusted-witness documents in `directory` (§6.4). */
export const ACL_TRUSTED_WITNESS_DOC_PREFIX = "acl_trustedwitness_";

/**
 * Directory documents only the root admin key may write. Admin keys decide who
 * is an admin, trusted witnesses decide whose clock counts — a delegated admin
 * writing either could make itself permanent or backdate its own entries.
 */
export const ROOT_ONLY_DIRECTORY_DOC_PREFIXES: readonly string[] = [
  ACL_ADMIN_KEY_PREFIX,
  ACL_TRUSTED_WITNESS_DOC_PREFIX,
];

/** Whether only the root admin key may write `docId` in `directory`. */
export function isRootOnlyDirectoryDocId(docId: string | undefined | null): boolean {
  if (!docId) return false;
  return ROOT_ONLY_DIRECTORY_DOC_PREFIXES.some((prefix) => docId.startsWith(prefix));
}

/** An admin-key document as stored in `directory` (encrypted under `$publicinfos`). */
export interface AdminKeyDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: typeof ADMIN_KEY_TYPE;
  /** Ed25519 public key of the admin device, PEM. */
  signingPublicKey: string;
  /** RSA-OAEP public key of the admin device, PEM. */
  encryptionPublicKey: string;
  /** The admin's name, field-encrypted under `default` (as in `tenantsetup`). */
  name_encrypted?: string;
  /** Key id of `name_encrypted`; always `"default"`. */
  name_encrypted_key?: string;
  /** Device label, e.g. "Laptop". */
  label?: string;
  /** Witness time (ms) the key becomes an admin; absent: this revision's witness time. */
  validFrom?: number;
  /** Witness time (ms) the key stops being an admin; absent: no end. */
  validUntil?: number;
}

/** One admin key as projected into a directory-state node. */
export interface AdminKeySnapshot {
  signingPublicKey: string;
  encryptionPublicKey: string;
  label?: string;
  /** Effective start (ms, inclusive). */
  validFrom: number;
  /** Effective end (ms, exclusive); undefined: no end. */
  validUntil?: number;
  /** Trusted (witness) time of the document revision this snapshot came from. */
  revisionTime: number;
}

/** PEM with all whitespace removed, the form keys are compared and hashed in. */
export function normalizeSigningKey(pem: string): string {
  return pem.replace(/\s+/g, "");
}

/** Hex SHA-256 of the whitespace-free PEM: the fingerprint in the document id. */
export async function adminKeyFingerprint(pem: string, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(normalizeSigningKey(pem)));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Document id of the admin-key document for a fingerprint. */
export function aclAdminKeyDocId(fingerprint: string): string {
  const id = ACL_ADMIN_KEY_PREFIX + encodeAclIdComponent(fingerprint);
  if (!CUSTOM_DOC_ID_REGEX.test(id)) {
    throw new Error(`Internal error: computed admin-key document id "${id}" is not a valid document id`);
  }
  return id;
}

/** Document id of the admin-key document for a signing key. */
export async function aclAdminKeyDocIdForKey(pem: string, subtle: SubtleCrypto): Promise<string> {
  return aclAdminKeyDocId(await adminKeyFingerprint(pem, subtle));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The effective window of one admin-key document revision whose witness time is
 * `revisionTime`. Neither end may lie before `revisionTime`: a deactivation
 * dated in the past ends the key at the deactivation's own witness time, and
 * an activation dated in the past starts it there. Already accepted entries
 * therefore never flip from allowed to denied (§4), and entries refused in a
 * gap never become allowed later.
 *
 * `previous` is the key's snapshot before this revision. A revision that finds
 * the key active continues its window (a deactivation keeps the original
 * start); one that finds it ended or absent opens a new window at
 * `revisionTime` (a reactivation), unless it names a later `validFrom`.
 *
 * Returns null when the document is not a usable admin-key document.
 */
export function adminKeyWindowFromDoc(
  data: Record<string, unknown>,
  revisionTime: number,
  previous: AdminKeySnapshot | null = null,
): AdminKeySnapshot | null {
  if (data.form !== ACCESS_CONTROL_FORM || data.type !== ADMIN_KEY_TYPE) return null;
  if (typeof data.signingPublicKey !== "string" || data.signingPublicKey.trim().length === 0) {
    return null;
  }
  const requestedFrom = finiteNumber(data.validFrom);
  const requestedUntil = finiteNumber(data.validUntil);
  const continuing =
    previous !== null &&
    normalizeSigningKey(previous.signingPublicKey) === normalizeSigningKey(data.signingPublicKey) &&
    isAdminKeySnapshotValidAt(previous, revisionTime);
  let validFrom = Math.max(requestedFrom ?? revisionTime, revisionTime);
  if (continuing && (requestedFrom === undefined || requestedFrom <= revisionTime)) {
    validFrom = previous!.validFrom;
  }
  const validUntil =
    requestedUntil === undefined ? undefined : Math.max(requestedUntil, revisionTime);
  return {
    signingPublicKey: data.signingPublicKey,
    encryptionPublicKey: typeof data.encryptionPublicKey === "string" ? data.encryptionPublicKey : "",
    ...(typeof data.label === "string" && data.label.trim() ? { label: data.label.trim() } : {}),
    validFrom,
    ...(validUntil !== undefined ? { validUntil } : {}),
    revisionTime,
  };
}

/** Whether `snapshot` makes its key an admin at time `T`. */
export function isAdminKeySnapshotValidAt(snapshot: AdminKeySnapshot, T: number): boolean {
  if (T < snapshot.validFrom) return false;
  if (snapshot.validUntil !== undefined && T >= snapshot.validUntil) return false;
  return true;
}

/** Display status of an admin key at time `now`. */
export type AdminKeyStatus = "active" | "ending" | "ended" | "scheduled";

export function adminKeyStatusAt(snapshot: AdminKeySnapshot, now: number): AdminKeyStatus {
  if (now < snapshot.validFrom) return "scheduled";
  if (snapshot.validUntil !== undefined) {
    return now >= snapshot.validUntil ? "ended" : "ending";
  }
  return "active";
}

/** One document revision, in the shape the store-level registry replays. */
export interface AdminKeyRevision {
  /** Trusted (witness) time of the revision. */
  trustedTime: number;
  /** The document's data after this revision, or null once deleted. */
  data: Record<string, unknown> | null;
}

/**
 * The admin-key snapshot in effect at `T` from a list of revisions of ONE
 * admin-key document: the latest revision whose trusted time is ≤ `T`
 * decides. Ties are broken by list order (later wins).
 */
export function adminKeySnapshotAt(
  revisions: readonly AdminKeyRevision[],
  T: number,
): AdminKeySnapshot | null {
  const ordered = revisions
    .map((revision, index) => ({ revision, index }))
    .filter(({ revision }) => revision.trustedTime <= T)
    .sort((a, b) => a.revision.trustedTime - b.revision.trustedTime || a.index - b.index);
  let snapshot: AdminKeySnapshot | null = null;
  for (const { revision } of ordered) {
    snapshot = revision.data ? adminKeyWindowFromDoc(revision.data, revision.trustedTime, snapshot) : null;
  }
  return snapshot;
}

/** A decision time for "now" given a head selector (`Number.MAX_SAFE_INTEGER`). */
export function adminDecisionTime(T: number, now: number = Date.now()): number {
  return T >= Number.MAX_SAFE_INTEGER ? now : T;
}

/** A delegated admin key as listed for admin UIs. */
export interface AdminKeyInfo extends AdminKeySnapshot {
  /** The admin's name, when this replica holds the tenant `default` key. */
  name?: string;
  /** Status at the time the list was taken. */
  status: AdminKeyStatus;
  /** Whether the key is an admin at the time the list was taken. */
  active: boolean;
  /**
   * The latest root revision of the key's document carries no witness receipt
   * yet, so other replicas do not see the change until a trusted witness stamps it.
   */
  pending: boolean;
}
