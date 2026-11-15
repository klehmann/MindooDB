import type { MindooTenantDirectory, StoreEntryMetadata } from "../types";
import {
  USERKEY_FORM,
  USERKEY_TYPE,
  type UserKeyDocumentPayload,
} from "./types";

export interface ValidateUserKeyInput {
  payload: unknown;
  /** Signing public key of the `doc_create` entry (or of the change being judged). */
  signerKey: string;
  usernameHashCandidates: string[];
  directory: MindooTenantDirectory;
  /** Admin create of a pending document is valid even though the signer is not the person. */
  adminPublicKey?: string;
  trustedTime?: number;
  /**
   * The `doc_create` entry being judged, with its witness receipt, and its
   * database. When the entry carries a receipt, a delegated admin signer is
   * judged at the witness time (docs/accesscontrol.md §6.13) instead of now, so
   * a pending document it created stays valid after its deactivation.
   */
  createEntry?: { meta: StoreEntryMetadata; dbid: string };
}

function hasWitnessReceipt(meta: StoreEntryMetadata): boolean {
  return meta.receivedAt !== undefined && !!meta.receivedByPublicKey && !!meta.receivedDateSignature;
}

/**
 * §6.4 binding: the payload has the userkey shape, `username_hash` matches
 * the person, and the create signer is either that person or the tenant admin.
 */
export async function validateUserKeyDocument(
  input: ValidateUserKeyInput,
): Promise<UserKeyDocumentPayload | null> {
  const payload = asUserKeyPayload(input.payload);
  if (!payload) return null;
  if (!input.usernameHashCandidates.includes(payload.username_hash)) {
    return null;
  }
  if (input.adminPublicKey && input.signerKey === input.adminPublicKey) {
    return payload;
  }
  // A delegated admin (docs/accesscontrol.md §6.13) may create pending
  // documents as well, while its window covers the create's time: the witness
  // time when the create carries a receipt, otherwise now.
  if (input.adminPublicKey) {
    const stamped =
      input.createEntry &&
      hasWitnessReceipt(input.createEntry.meta) &&
      typeof input.directory.isAdminSignedEntry === "function";
    if (stamped) {
      if (await input.directory.isAdminSignedEntry!(input.createEntry!.meta, input.createEntry!.dbid)) {
        return payload;
      }
    } else if (
      typeof input.directory.isAdminAt === "function" &&
      (await input.directory.isAdminAt(input.signerKey, input.trustedTime ?? Number.MAX_SAFE_INTEGER))
    ) {
      return payload;
    }
  }
  if (typeof input.directory.resolveUsernameHashForSigningKey !== "function") {
    return null;
  }
  const signerHash = await input.directory.resolveUsernameHashForSigningKey(
    input.signerKey,
    input.trustedTime ?? Number.MAX_SAFE_INTEGER,
  );
  if (!signerHash || signerHash !== payload.username_hash) {
    return null;
  }
  return payload;
}

export function asUserKeyPayload(payload: unknown): UserKeyDocumentPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (data.form !== USERKEY_FORM || data.type !== USERKEY_TYPE) return null;
  if (typeof data.username_hash !== "string" || data.username_hash.length === 0) {
    return null;
  }
  if (!data.userKeys || typeof data.userKeys !== "object") return null;
  return data as unknown as UserKeyDocumentPayload;
}
