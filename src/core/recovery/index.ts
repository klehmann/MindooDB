export { splitSecret, combineShares } from "./shamir";
export {
  generateRescueDevice,
  openRescueDevice,
  rescueDeviceUserId,
  type RescueDevicePublicKeys,
  type OpenedRescueDevice,
  type GeneratedRescueDevice,
} from "./rescueDevice";
export {
  RECOVERY_CONTACTS_DOC_ID_PREFIX,
  RECOVERY_CONTACTS_TYPE,
  RECOVERY_CONTACTS_SCHEMA_VERSION,
  RECOVERY_CONTACTS_THRESHOLD,
  RECOVERY_CONTACTS_MIN,
  isRecoveryContactsDocId,
  asRecoveryContactsPayload,
  verifyRecoveryContactsDoc,
  personalDocBelongsTo,
  type RecoveryContactEntry,
  type RecoveryContactsPayload,
  type RecoveryContactsSetup,
} from "./RecoveryContactsDocument";
export {
  RECOVERY_PACKAGE_PREFIX,
  RecoveryPackageError,
  generateRecoveryPackagePassword,
  normalizeRecoveryPackagePassword,
  encryptRecoveryHelperPackage,
  decryptRecoveryHelperPackage,
  extractRecoveryPackageText,
  combineRecoveryHelperPackages,
  type RecoveryHelperPackage,
  type CombinedRecoveryPackages,
} from "./recoveryPackage";
export {
  RecoveryContactsError,
  rescueAttestationHolds,
  type RecoveryContactsErrorCode,
  type RescueDeviceStatus,
  type SetupRecoveryContactsResult,
  type RecoveryContactRequest,
  type SetupRecoveryContactsOptions,
} from "./RecoveryContactsManager";
export {
  RecoveryError,
  certifyDeviceWithRescueDevice,
  approveDeviceWithRescueDevice,
  type CertifyDeviceWithRescueDeviceInput,
  type CertifyDeviceWithRescueDeviceResult,
} from "./recoverWithContacts";
export {
  PAPER_RESCUE_DOC_ID_PREFIX,
  PAPER_RESCUE_TYPE,
  PAPER_RESCUE_SCHEMA_VERSION,
  openPaperRescueSecret,
  verifyPaperRescueDoc,
  type PaperRescuePayload,
  type PaperRescueRecord,
  type PaperRescueSecret,
  type CreatePaperRescueResult,
} from "./PaperRescueDevice";
export {
  rescueAttestationMessage,
  rescueDeviceJoinRequestUri,
  isRescueDeviceRef,
  rescueApprovalOf,
  type RescueDeviceRef,
  type RescueDeviceApproval,
  type RescueDeviceAttestation,
} from "./rescueApproval";
