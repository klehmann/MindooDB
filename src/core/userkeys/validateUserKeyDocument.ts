import type { MindooTenantDirectory } from "../types";
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
