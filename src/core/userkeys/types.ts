import { encodeAclIdComponent } from "../accesscontrol/types";

export const USERKEY_FORM = "userdirectory";
export const USERKEY_TYPE = "userkey";
export const USERKEY_SCHEMA_VERSION = 1;
export const USERKEY_DOC_ID_PREFIX = "userkey_";
export const USERKEY_PRIVATE_SALT = "userkey";
/** Matches `BaseMindooTenantDirectory.USERNAME_HASH_VERSION` (write version 3). */
export const USERKEY_USERNAME_HASH_VERSION = 3;

export type UserKeyWaitState = "approved" | "waiting" | "unknown";

export interface PendingUserKeyDevice {
  fingerprint: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  label?: string;
  addedAt?: number;
}

export type UserKeyDeviceStatus = "approved" | "pending" | "declined";

export interface UserKeyDeviceRow {
  fingerprint: string;
  signingPublicKey?: string;
  encryptionPublicKey?: string;
  label?: string;
  addedAt?: number;
  status: UserKeyDeviceStatus;
}

export interface UserKeyEnrollmentStatus {
  state: UserKeyWaitState;
  /** True while the published document has no person-written wrap. */
  pending: boolean;
  missingKeys: string[];
}

export function userKeyDocumentId(grantDocId: string): string {
  // Grant ids used to be mixed-case (e.g. `033p0Fh2PNGwn0yTqWp7UE`). Custom
  // document ids may only be `^[a-z][a-z0-9_]*$`. Encode like ACL ids so
  // MongoDB hex object ids pass through unchanged and legacy ids stay valid.
  return `${USERKEY_DOC_ID_PREFIX}${encodeAclIdComponent(grantDocId)}`;
}

export interface UserKeyDeviceWrap {
  wrappedKey: string;
  label?: string;
  approvedAt: number;
  approvedBySigningPublicKey: string;
}

export interface UserKeyGeneration {
  publicKey: string;
  fingerprint: string;
  createdAt: number;
  retiredAt?: number;
  deviceWraps: Record<string, UserKeyDeviceWrap>;
}

export interface RejectedUserKeyDevice {
  signingPublicKey?: string;
  rejectedAt: number;
  rejectedBySigningPublicKey: string;
}

export interface UserKeyDocumentPayload {
  form: typeof USERKEY_FORM;
  type: typeof USERKEY_TYPE;
  schemaVersion: number;
  username_hash: string;
  username_hash_v: number;
  userKeys: Record<string, UserKeyGeneration>;
  rejectedDevices?: Record<string, RejectedUserKeyDevice>;
}

export function currentUserKeyEpoch(payload: UserKeyDocumentPayload): string | null {
  const epochs = Object.keys(payload.userKeys ?? {}).filter((k) => /^\d+$/.test(k));
  if (epochs.length === 0) return null;
  return epochs.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
}

export function isPendingUserKeyDocument(payload: UserKeyDocumentPayload): boolean {
  const epochs = Object.values(payload.userKeys ?? {});
  if (epochs.length === 0) return true;
  return epochs.every((gen) => Object.keys(gen.deviceWraps ?? {}).length === 0);
}

export class UserKeyMismatchError extends Error {
  readonly name = "UserKeyMismatchError";
  constructor(
    message = "Published user public key does not match the key this device generated",
  ) {
    super(message);
  }
}
