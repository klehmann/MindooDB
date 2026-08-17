import { Automerge } from "./automerge-adapter";
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
 */

export type BuiltinWriteOp = "doc_create" | "doc_change" | "doc_delete" | "doc_undelete" | "doc_snapshot";

export interface BuiltinWriteInput {
  dbId: string;
  op: BuiltinWriteOp;
  signerKey: string;
  adminPublicKey: string;
  /** `username_hash` stored on the userkey document, when known. */
  documentUsernameHash?: string | null;
  /** `username_hash` of the signer's grant at the entry's trusted time. */
  signerUsernameHash?: string | null;
}

export interface BuiltinWriteDecision {
  allowed: boolean;
  reason: string;
}

export function hasBuiltinWriteInvariant(dbId: string): boolean {
  return dbId === DIRECTORY_DB_ID || dbId === USER_DIRECTORY_DB_ID;
}

export function evaluateBuiltinWrite(input: BuiltinWriteInput): BuiltinWriteDecision {
  if (input.dbId === DIRECTORY_DB_ID) {
    if (input.signerKey !== input.adminPublicKey) {
      return { allowed: false, reason: "Admin-only database: only the admin key can modify data" };
    }
    return { allowed: true, reason: "directory admin write" };
  }

  if (input.dbId === USER_DIRECTORY_DB_ID) {
    const isAdmin = input.signerKey === input.adminPublicKey;
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
}): boolean {
  if (input.dbId === DIRECTORY_DB_ID) {
    return input.signerKey !== input.adminPublicKey;
  }
  if (input.dbId === USER_DIRECTORY_DB_ID) {
    const isAdmin = input.signerKey === input.adminPublicKey;
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
