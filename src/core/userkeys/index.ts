export {
  SEALED_KEY_PREFIX,
  ENCRYPT_FOR_FIELD,
  sealedKeyId,
  isSealedKeyId,
  type RecipientSpec,
  type RecipientOptions,
  type RecipientChangeOptions,
  type EncryptForEntry,
  type ResolvedRecipient,
  type EntryRecipients,
  type RecipientChangeResult,
} from "./sealedTypes";
export {
  resolveRecipientSpecs,
  newestRecipientBlock,
  resolveRecipientsFromPayload,
  isPayloadEncryptedFor,
} from "./recipients";
export {
  USERKEY_FORM,
  USERKEY_TYPE,
  USERKEY_SCHEMA_VERSION,
  USERKEY_DOC_ID_PREFIX,
  USERKEY_PRIVATE_SALT,
  userKeyDocumentId,
  currentUserKeyEpoch,
  isPendingUserKeyDocument,
  UserKeyMismatchError,
  UserKeyDecryptError,
  USERKEY_USERNAME_HASH_VERSION,
  type UserKeyDeviceWrap,
  type UserKeyGeneration,
  type RejectedUserKeyDevice,
  type UserKeyDocumentPayload,
  type PendingUserKeyDevice,
  type UserKeyDeviceRow,
  type UserKeyDeviceStatus,
  type UserKeyEnrollmentStatus,
  type UserKeyWaitState,
} from "./types";
export { canonicalizeUsername, usernamesEqual } from "../userid/canonicalUsername";
export {
  fingerprintEncryptionPublicKey,
  normalizePublicKeyPem,
  spkiToPem,
  bytesToBase64,
  base64ToBytes,
} from "./fingerprint";
export { validateUserKeyDocument, asUserKeyPayload } from "./validateUserKeyDocument";
export { resolveUserKeyDocument } from "./resolveUserKeyDocument";
export type { ResolveUserKeyDocumentInput, ResolvedUserKeyDocument } from "./resolveUserKeyDocument";
export {
  buildPendingUserKeyPayload,
  createPendingUserKeyDocument,
  wrapPrivateKeyForDevice,
  writeDeviceWrap,
  fingerprintUserPublicKey,
  unwrapPrivateKeyFromDevice,
} from "./UserKeyDocument";
export { UserKeyManager } from "./UserKeyManager";
