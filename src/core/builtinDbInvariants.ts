import { Automerge } from "./automerge-adapter";
import { signingKeysEqual } from "./accesscontrol/DirectoryStateNode";
import { DIRECTORY_DB_ID, USER_DIRECTORY_DB_ID } from "./types";

/**
 * Builtin database write invariants that hold even when the ACL master switch
 * is engaged (docs/userkeys.md §6.5). These are not `evaluateAccess` rules —
 * that function short-circuits to allow when no policy exists or the master
 * switch is on.
 *
 * `directory`: only the tenant admin may write.
 * `userdirectory`: admin may create and delete; only the person named by the
 * document's `username_hash` may change. The tenant founder signs with the
 * admin key, so an owner match still allows a change (they must wrap their
 * own userkey). The admin may not change anyone else's document, so a planted
 * public key cannot be swapped in after the fact. Anyone may read.
 *
 * Personal documents (see {@link PERSONAL_DOC_ID_PREFIXES}) are the exception
 * inside `userdirectory`: they carry their owner's own data and are not
 * readable by the server, which means it cannot read `username_hash` out of
 * them. Ownership for those is the person who signed `doc_create`, resolved
 * from grants — no decryption involved. That person may change and delete
 * their own document.
 */

export type BuiltinWriteOp = "doc_create" | "doc_change" | "doc_delete" | "doc_undelete" | "doc_snapshot";

/**
 * Document-id prefixes inside `userdirectory` that hold one person's private
 * data instead of published key material. The prefix is the discriminator
 * because it is plain metadata: a sealed document's payload is opaque to the
 * server, so any rule reading the payload could not be enforced there.
 *
 * `wks_` — roamed workspace and application list (one document per save id).
 * `dev_` — one device's peer-sync record (Iroh endpoint id and label).
 * `qtn_` — one device's record of entries a server refused (one document per
 *   author, database, document and rejection class).
 * `dcert_` — a device certificate the person issued with their device
 *   self-grant key (docs/userkeys.md §9.6), encrypted with `$publicinfos` so
 *   the server can verify it.
 *
 * They differ in who may *read* them, which this rule does not care about:
 * `wks_` documents are sealed to their owner, while `dev_` and `qtn_` are
 * encrypted with the tenant `default` key — so every member can discover peers
 * and audit refused writes while the hoster still sees ciphertext. Ownership is
 * the creator either way.
 */
export const PERSONAL_DOC_ID_PREFIXES = ["wks_", "dev_", "qtn_", "dcert_"] as const;

/** Is this a personal-data document id inside `userdirectory`? */
export function isPersonalUserdirectoryDocId(docId: string | undefined | null): boolean {
  if (!docId) return false;
  return PERSONAL_DOC_ID_PREFIXES.some((prefix) => docId.startsWith(prefix));
}

export interface BuiltinWriteInput {
  dbId: string;
  op: BuiltinWriteOp;
  signerKey: string;
  adminPublicKey: string;
  /** `username_hash` stored on the userkey document, when known. */
  documentUsernameHash?: string | null;
  /** `username_hash` of the signer's grant at the entry's trusted time. */
  signerUsernameHash?: string | null;
  /**
   * Document id. Only needed to recognize personal documents; the userkey rule
   * keys off `username_hash` alone.
   */
  docId?: string;
  /**
   * `username_hash` of the person who signed this document's `doc_create`.
   * Ownership of a personal document, resolvable without decrypting it.
   */
  creatorUsernameHash?: string | null;
}

export interface BuiltinWriteDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Prefixes of **personal databases**: `<prefix><grantDocId>` belongs to the
 * person whose `grantaccess` document has that id (docs/accesscontrol.md
 * §6.11). Built in, like the `directory` and `userdirectory` invariants:
 *
 * - read and sync only for the devices on that grant, identities whose grant
 *   lists the prefix in `accessPrefixes` (a service such as the mail gateway
 *   that serves every person's outbox), and the tenant admin,
 * - deposit (push of sealed creates only, §6.10) only for identities whose
 *   grant lists the prefix in `depositPrefixes`,
 *
 * whatever a configured policy says; a policy can add prefixes
 * (`personalDatabasePrefixes`) and can deny more, never allow more.
 *
 * `mmail_` — MindooMail's mailbox (`mmail_${user.persondocid}` in Haven); the
 *   mail gateway deposits incoming mail.
 * `mmailout_` — MindooMail's outbox: the person writes outgoing mail, the mail
 *   gateway (accessPrefixes) reads it, sends it and writes status documents.
 * `mbusy_` — free/busy: the person's client publishes the busy times of their
 *   calendar (no details). The rights are the other way round: other members
 *   may read it, read-only, under the tenant's `freeBusy` setting; only the
 *   owner's devices write.
 */
export const BUILTIN_PERSONAL_DATABASE_PREFIXES = ["mmail_", "mmailout_", "mbusy_"] as const;

/**
 * Default document-id prefixes a depositor may use in a built-in personal
 * database (docs/accesscontrol.md §6.11): deposits into a mailbox are MindooMail
 * messages (`memo_…`), so documents of other kinds (events, status, folders)
 * there are always the owner's own. A grant's `depositDocIdPrefixes` overrides
 * this per database prefix.
 */
export const BUILTIN_PERSONAL_DEPOSIT_DOC_ID_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  mmail_: ["memo_"],
};

/** A valid personal-database prefix: lowercase letters and digits, ending in `_`. */
export const PERSONAL_DATABASE_PREFIX_REGEX = /^[a-z][a-z0-9]*_$/;

/**
 * The owner of a personal database: the matching prefix and the grant id
 * that follows it, or `null` when `dbId` is not a personal database.
 */
export function personalDatabaseOwner(
  dbId: string,
  extraPrefixes: readonly string[] = [],
): { prefix: string; grantDocId: string } | null {
  for (const prefix of [...BUILTIN_PERSONAL_DATABASE_PREFIXES, ...extraPrefixes]) {
    if (dbId.startsWith(prefix) && dbId.length > prefix.length) {
      return { prefix, grantDocId: dbId.slice(prefix.length) };
    }
  }
  return null;
}

export function hasBuiltinWriteInvariant(dbId: string): boolean {
  return dbId === DIRECTORY_DB_ID || dbId === USER_DIRECTORY_DB_ID;
}

export function evaluateBuiltinWrite(input: BuiltinWriteInput): BuiltinWriteDecision {
  if (input.dbId === DIRECTORY_DB_ID) {
    if (!signingKeysEqual(input.signerKey, input.adminPublicKey)) {
      return { allowed: false, reason: "Admin-only database: only the admin key can modify data" };
    }
    return { allowed: true, reason: "directory admin write" };
  }

  if (input.dbId === USER_DIRECTORY_DB_ID) {
    const isAdmin = signingKeysEqual(input.signerKey, input.adminPublicKey);
    if (isPersonalUserdirectoryDocId(input.docId)) {
      return evaluatePersonalDocWrite(input, isAdmin);
    }
    if (input.op === "doc_delete") {
      return isAdmin
        ? { allowed: true, reason: "userdirectory admin delete" }
        : { allowed: false, reason: "userdirectory: only the admin can delete" };
    }
    if (input.op === "doc_undelete") {
      if (isAdmin) return { allowed: true, reason: "userdirectory admin undelete" };
      if (
        input.documentUsernameHash &&
        input.signerUsernameHash &&
        input.documentUsernameHash === input.signerUsernameHash
      ) {
        return { allowed: true, reason: "userdirectory owner undelete" };
      }
      return {
        allowed: false,
        reason: "userdirectory: undelete requires the admin or a matching username_hash",
      };
    }
    if (input.op === "doc_create") {
      if (isAdmin) return { allowed: true, reason: "userdirectory admin create" };
      if (
        input.documentUsernameHash &&
        input.signerUsernameHash &&
        input.documentUsernameHash === input.signerUsernameHash
      ) {
        return { allowed: true, reason: "userdirectory self create" };
      }
      return {
        allowed: false,
        reason: "userdirectory: create requires the admin or a matching username_hash",
      };
    }
    // change / snapshot: owning person only. The tenant founder is both admin
    // and owner; matching hashes allow that wrap. Admin edits of anyone else
    // stay denied so a planted public key cannot be swapped after the fact.
    if (
      input.documentUsernameHash &&
      input.signerUsernameHash &&
      input.documentUsernameHash === input.signerUsernameHash
    ) {
      return { allowed: true, reason: "userdirectory owner change" };
    }
    if (isAdmin) {
      return { allowed: false, reason: "userdirectory: the admin cannot change userkey documents" };
    }
    if (!input.documentUsernameHash) {
      return { allowed: false, reason: "userdirectory: document username_hash could not be resolved" };
    }
    if (!input.signerUsernameHash) {
      return { allowed: false, reason: "userdirectory: signer is not a granted device" };
    }
    return { allowed: false, reason: "userdirectory: only the owning person can change" };
  }

  return { allowed: true, reason: "no builtin invariant" };
}

/**
 * Personal `userdirectory` document: the creating person owns it. Creating
 * needs nothing but a grant — a member may store their own data — while
 * changing is the owner's alone, so nobody can overwrite someone else's
 * workspace even though every member syncs the (unreadable) bytes.
 *
 * The admin may delete but not change, mirroring the userkey rule: cleaning up
 * after a departed member has to be possible, editing a document one cannot
 * even read has no legitimate use.
 */
function evaluatePersonalDocWrite(
  input: BuiltinWriteInput,
  isAdmin: boolean,
): BuiltinWriteDecision {
  const isOwner = Boolean(
    input.creatorUsernameHash &&
      input.signerUsernameHash &&
      input.creatorUsernameHash === input.signerUsernameHash,
  );
  if (input.op === "doc_create") {
    // The creator becomes the owner, so there is nothing to compare against
    // yet. A grant is still required: `signerUsernameHash` is null for a
    // signing key the directory does not know.
    if (isAdmin || input.signerUsernameHash) {
      return { allowed: true, reason: "userdirectory personal create" };
    }
    return {
      allowed: false,
      reason: "userdirectory: personal documents require a granted device",
    };
  }
  if (input.op === "doc_delete" || input.op === "doc_undelete") {
    if (isOwner) {
      return { allowed: true, reason: `userdirectory personal owner ${input.op}` };
    }
    if (isAdmin) {
      return { allowed: true, reason: `userdirectory personal admin ${input.op}` };
    }
    return {
      allowed: false,
      reason: `userdirectory: only the owning person or the admin can ${
        input.op === "doc_delete" ? "delete" : "undelete"
      } a personal document`,
    };
  }
  if (isOwner) {
    return { allowed: true, reason: "userdirectory personal owner change" };
  }
  if (isAdmin) {
    return {
      allowed: false,
      reason: "userdirectory: the admin cannot change a personal document",
    };
  }
  if (!input.creatorUsernameHash) {
    return {
      allowed: false,
      reason: "userdirectory: personal document owner could not be resolved",
    };
  }
  if (!input.signerUsernameHash) {
    return { allowed: false, reason: "userdirectory: signer is not a granted device" };
  }
  return {
    allowed: false,
    reason: "userdirectory: only the owning person can change a personal document",
  };
}

function usernameHashFromRecord(doc: Record<string, unknown>): string | null {
  const value = doc.username_hash;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `username_hash` from a decrypted `doc_create` payload. Create entries are
 * usually a single Automerge change; some writers persist a full document
 * binary instead. The server must accept both — otherwise every later change
 * is denied as "not the owning person" because the hash looks missing.
 */
export function recordFromCreateChangeBytes(changeBytes: Uint8Array): Record<string, unknown> | null {
  try {
    const [doc] = Automerge.applyChanges(
      Automerge.init<Record<string, unknown>>(),
      [changeBytes],
    );
    const record = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    if (Object.keys(record).length > 0) return record;
  } catch {
    // Payload may be a full Automerge document rather than a change.
  }
  try {
    return JSON.parse(
      JSON.stringify(Automerge.load<Record<string, unknown>>(changeBytes)),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function usernameHashFromCreateChangeBytes(changeBytes: Uint8Array): string | null {
  try {
    const [doc] = Automerge.applyChanges(
      Automerge.init<Record<string, unknown>>(),
      [changeBytes],
    );
    const fromChange = usernameHashFromRecord(doc as Record<string, unknown>);
    if (fromChange) return fromChange;
  } catch {
    // Payload may be a full Automerge document rather than a change.
  }
  try {
    return usernameHashFromRecord(Automerge.load<Record<string, unknown>>(changeBytes));
  } catch {
    return null;
  }
}

export function entryTypeToBuiltinOp(entryType: string): BuiltinWriteOp | null {
  switch (entryType) {
    case "doc_create":
      return "doc_create";
    case "doc_change":
    case "doc_snapshot":
      return "doc_change";
    case "doc_delete":
      return "doc_delete";
    case "doc_undelete":
      return "doc_undelete";
    default:
      return null;
  }
}

/**
 * Sync load-path filter: drop entries that are obviously illegal without
 * decrypting. Username-hash matching for userdirectory creates/changes is
 * enforced on the write path and the server; the load path rejects
 * non-admin deletes and admin-signed changes that are not the owning person.
 */
export function shouldSkipLoadedEntry(input: {
  dbId: string;
  entryType: string;
  signerKey: string;
  adminPublicKey: string;
  documentUsernameHash?: string | null;
  signerUsernameHash?: string | null;
  docId?: string;
  creatorUsernameHash?: string | null;
}): boolean {
  if (input.dbId === DIRECTORY_DB_ID) {
    return !signingKeysEqual(input.signerKey, input.adminPublicKey);
  }
  if (input.dbId === USER_DIRECTORY_DB_ID) {
    const isAdmin = signingKeysEqual(input.signerKey, input.adminPublicKey);
    if (isPersonalUserdirectoryDocId(input.docId)) {
      // Ownership of a personal document comes from its creator, so a create
      // can never be illegal here, and a delete by its owner must survive the
      // load path (the userkey rule below would drop it). Everything else is
      // dropped only when both hashes resolved and disagree: the write path
      // and the server already rejected illegal entries, and failing open on
      // an unresolvable hash beats silently discarding an owner's own change.
      if (input.entryType === "doc_create") return false;
      const isLifecycle =
        input.entryType === "doc_delete" || input.entryType === "doc_undelete";
      if (isAdmin) return !isLifecycle;
      if (!input.creatorUsernameHash || !input.signerUsernameHash) return false;
      return input.creatorUsernameHash !== input.signerUsernameHash;
    }
    if (input.entryType === "doc_delete") {
      return !isAdmin;
    }
    // Owner undelete is allowed on the write path; skipping it here would
    // leave a tombstone after a person restores their own userkey document.
    if (input.entryType === "doc_change" || input.entryType === "doc_snapshot") {
      if (!isAdmin) return false;
      if (
        input.documentUsernameHash &&
        input.signerUsernameHash &&
        input.documentUsernameHash === input.signerUsernameHash
      ) {
        return false;
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hard delete in personal databases (docs/accesscontrol.md §6.11, "Purge")
// ---------------------------------------------------------------------------

/** Document-id prefix of a purge request inside a personal database. */
export const PURGE_REQUEST_ID_PREFIX = "purgereq_";
/** `form` of a purge request document. */
export const PURGE_REQUEST_FORM = "purgerequest";

/** Whether `docId` is a purge request of a personal database. */
export function isPurgeRequestDocId(docId: string): boolean {
  return docId.startsWith(PURGE_REQUEST_ID_PREFIX);
}

/**
 * The document ids a purge request names, from its decrypted `doc_create`
 * payload (`$publicinfos`), or null when the payload is not a purge request.
 */
export function purgeRequestDocIdsFromCreateBytes(changeBytes: Uint8Array): string[] | null {
  const fromRecord = (record: Record<string, unknown> | null): string[] | null => {
    if (!record || record.form !== PURGE_REQUEST_FORM || !Array.isArray(record.docIds)) return null;
    const ids = record.docIds.map((id) => String(id)).filter((id) => id.length > 0);
    return ids.length > 0 ? ids : null;
  };
  try {
    const [doc] = Automerge.applyChanges(Automerge.init<Record<string, unknown>>(), [changeBytes]);
    const ids = fromRecord(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>);
    if (ids) return ids;
  } catch {
    // Payload may be a full Automerge document rather than a change.
  }
  try {
    return fromRecord(JSON.parse(JSON.stringify(Automerge.load<Record<string, unknown>>(changeBytes))));
  } catch {
    return null;
  }
}
