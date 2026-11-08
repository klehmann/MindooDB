// Folders ("Ablage") for MindooDB: documents are filed into folders through
// small sidecar documents in a filing database, never by changing the filed
// document. See docs/folders.md.

export {
  MindooFilingStore,
  type FilingStoreOptions,
  type FilingEntry,
  type CreateFolderInput,
  type UpdateFolderInput,
} from "./MindooFilingStore";
export {
  FilingIndex,
  FILING_SIDECAR_TYPE,
  FILING_FOLDER_TYPE,
  FILING_FOLDER_FIELD_PREFIX,
  readFolderFields,
  type FilingFolder,
  type FilingIndexChanges,
} from "./FilingIndex";
export {
  resolveFilingRef,
  formatFilingRef,
  physicalFilingRefKey,
  parsePhysicalFilingRefKey,
  physicalDbKey,
  type FilingTarget,
  type FilingRefInput,
  type FilingRefBase,
} from "./refs";
