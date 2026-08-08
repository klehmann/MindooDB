/**
 * Core utility functions for MindooDB.
 */

export {
  generateObjectId,
  OBJECT_ID_LENGTH,
  generateDocId,
  generateTenantId,
  matchesDocIdPrefix,
  generateDocEntryId,
  generateDepsFingerprint,
  generateAttachmentChunkId,
  generateUniqueAttachmentChunkId,
  generateFileUuid7,
  generateChunkUuid7,
  parseDocEntryId,
  parseAttachmentChunkId,
  isDocEntryId,
  isAttachmentChunkId,
  extractDocIdFromEntryId,
  computeContentHash,
} from './idGeneration';

export {
  semanticNow,
  setSemanticTimeSourceForTesting,
  createQuantizedTimeSource,
} from './timeSource';
