/**
 * Compile-time check that the document-copy public surface is reachable from
 * the package root exactly as `docs/document-copy.md` shows it. Not a test —
 * `_helpers/` is excluded from the jest run; it only has to typecheck.
 */

import { verifyEntryProvenance, buildDocHistoryPurgeRequest } from "../../index";
import type {
  CopyAdmissionPreflight,
  CopyDocumentOptions,
  CopyDocumentResult,
  CopyDocumentsOptions,
  CopyDocumentsResult,
  CopyFeasibility,
  CopyFeasibilityReasonCode,
  CopyProgress,
  CopyStrategy,
  EntryProvenance,
  FlattenedDocumentProvenance,
  ProvenanceVerification,
} from "../../index";

export const shardOptions: CopyDocumentsOptions = {
  mode: "history",
  targetDocId: "same",
  authorship: "preserve",
};

const singleOptions: CopyDocumentOptions = {
  ...shardOptions,
  targetDocId: "same",
  provenance: true,
  batchSize: 200,
};

void singleOptions;
void verifyEntryProvenance;
void buildDocHistoryPurgeRequest;

export type _Surface = [
  CopyAdmissionPreflight,
  CopyDocumentResult,
  CopyDocumentsResult,
  CopyFeasibility,
  CopyFeasibilityReasonCode,
  CopyProgress,
  CopyStrategy,
  EntryProvenance,
  FlattenedDocumentProvenance,
  ProvenanceVerification,
];
