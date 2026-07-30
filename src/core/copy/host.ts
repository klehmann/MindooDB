/**
 * The narrow seam the copy engine uses to reach into a database.
 *
 * `BaseMindooDB` is already very large, so the copy engine lives in its own
 * module and receives only what it needs through {@link CopyEngineHost} rather
 * than being written as more methods on the class. A handful of the things it
 * needs (entry signing, the attachment-ref snapshot) are private on
 * `BaseMindooDB`; the class exposes them here through one `@internal` accessor
 * instead of widening their visibility.
 *
 * @internal
 * @module
 */

import type { ContentAddressedStore } from "../appendonlystores/types";
import type { AccessDecision, RuleType } from "../accesscontrol/types";
import type { EntryProvenance } from "../crypto/EntrySignature";
import type {
  MindooDB,
  MindooDocPayload,
  MindooTenant,
  SigningKeyPair,
  StoreEntryAttachmentRef,
  StoreEntryMetadata,
} from "../types";

/**
 * Everything the copy engine needs from one side of a copy.
 *
 * @internal
 */
export interface CopyEngineHost {
  /** The database itself, for the strategies that go through the public API. */
  readonly db: MindooDB;
  /** The tenant owning {@link db}. */
  readonly tenant: MindooTenant;
  /** The document entry store. */
  readonly store: ContentAddressedStore;
  /** The attachment chunk store. */
  readonly attachmentStore: ContentAddressedStore;

  /**
   * Compute the author's metadata-binding signature for an entry, using the
   * supplied signing key when given and the current user's key otherwise.
   * Mirrors what every ordinary write path does, so copied entries are
   * indistinguishable in structure from natively written ones.
   */
  computeEntryMetadataSignature(
    meta: Pick<
      StoreEntryMetadata,
      | "entryType"
      | "id"
      | "docId"
      | "decryptionKeyId"
      | "createdAt"
      | "dependencyIds"
      | "contentHash"
      | "createdByPublicKey"
      | "attachmentRefs"
    > & { provenance?: EntryProvenance },
    signing?: { signingKeyPair?: SigningKeyPair; signingKeyPassword?: string },
  ): Promise<Uint8Array>;

  /**
   * Build the canonical, sorted attachment-ref snapshot for a payload, matching
   * exactly what the writer would have signed.
   */
  collectAttachmentRefs(doc: MindooDocPayload): StoreEntryAttachmentRef[];

  /**
   * Decrypt an attachment chunk payload.
   *
   * Attachment chunks use a different envelope from document changes (a
   * deterministic IV, so identical plaintext yields identical ciphertext), and
   * the tenant's attachment crypto is not part of the public `MindooTenant`
   * surface — hence the passthrough here rather than widening that interface.
   */
  decryptAttachmentPayload(
    encryptedPayload: Uint8Array,
    decryptionKeyId: string,
  ): Promise<Uint8Array>;

  /** Encrypt an attachment chunk payload. Counterpart of {@link decryptAttachmentPayload}. */
  encryptAttachmentPayload(
    payload: Uint8Array,
    decryptionKeyId: string,
  ): Promise<Uint8Array>;

  /** Materialize newly written store entries into the in-memory document state. */
  syncStoreChanges(): Promise<void>;

  /**
   * Evaluate this database's write policy for an entry signed by `signerKey`,
   * exactly as the ordinary write paths do. Resolves to `null` when access
   * control is not enforced here.
   *
   * The copy engine writes entries straight to the store rather than through
   * `changeDoc`, so it does not inherit that precheck and has to run its own —
   * see `preflight.ts` for why that matters most when grafting.
   */
  evaluateWriteAccess(
    op: RuleType,
    signerKey: string,
    isAuthor: boolean,
  ): Promise<AccessDecision | null>;

  /**
   * Whether a Tier 2 (content) rule governs `op` on this database. A copy
   * cannot evaluate one — grafting never decrypts anything — so the preflight
   * reports such cases as undecidable instead of guessing.
   */
  hasWriteContentRules(op: RuleType): Promise<boolean>;

  /**
   * Write one `doc_change` that re-points `_attachments[].lastChunkId` at the
   * given chunk ids, keyed by attachment id.
   *
   * Needed only when a document is duplicated inside its own database, where
   * the copied chunks had to be renamed (see `attachments.ts`). There is no
   * public API for this — `changeDoc` deliberately does not let a caller write
   * `_attachments` directly — so the database exposes it here.
   */
  remapAttachmentPointers(
    docId: string,
    lastChunkIdByAttachmentId: Map<string, string>,
    signing?: { signingKeyPair: SigningKeyPair; signingKeyPassword: string },
  ): Promise<void>;
}
