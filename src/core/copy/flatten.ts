/**
 * The flatten copy strategy.
 *
 * Reads the source document's state — at its head, or as of
 * {@link CopyDocumentOptions.atTimestamp} — and writes it into the target as a
 * brand-new document with a single revision. History, original authors and the
 * CRDT structure are all deliberately left behind; what arrives is a clean
 * document that happens to have the same content.
 *
 * Unlike the two history strategies this one goes entirely through the public
 * document API, which is what makes it work regardless of tenant, key or
 * document id: `createDocument` + one `changeDoc`, with attachments re-uploaded
 * through `addAttachmentStream` so they get fresh chunk ids in the target.
 *
 * **Caveat worth knowing:** materializing an Automerge document to plain JS
 * collapses its text fields into ordinary strings. A flattened copy therefore
 * loses the character-level text CRDT structure, and concurrent edits to those
 * fields merge as whole-value conflicts rather than per-character. That is
 * usually the right trade for a fresh document, but it is the reason
 * `mode: "history"` exists.
 *
 * @module
 */

import { CUSTOM_DOC_ID_REGEX } from "../types";
import type { MindooDoc, MindooDocPayload } from "../types";
import type { CopyEngineHost } from "./host";
import type { CopyContext } from "./feasibility";
import type { CopyProgressReporter } from "./copyDocument";
import type { CopyDocumentOptions, CopyDocumentResult } from "./types";

/**
 * Document-level provenance for a flattened copy.
 *
 * Per-change provenance would be meaningless here — the copy has exactly one
 * change, authored by the copying user, that corresponds to no single source
 * revision — so the origin is recorded once in the payload instead, which also
 * keeps flatten free of any store-format concern.
 */
export interface FlattenedDocumentProvenance {
  /** When the copy ran (epoch millis). */
  copiedAt: number;
  /** Tenant the content came from. */
  sourceTenantId: string;
  /** Database the content came from. */
  sourceDbId: string;
  /** Document the content came from. */
  sourceDocId: string;
  /**
   * The point in the source's history that was captured, when the caller asked
   * for a specific one via {@link CopyDocumentOptions.atTimestamp}.
   */
  sourceAtTimestamp?: number;
  /** Signing key of the user who made the copy. */
  copiedByPublicKey: string;
}

/** Payload key holding {@link FlattenedDocumentProvenance}. */
const PROVENANCE_FIELD = "_provenance";

/**
 * Materialize the source payload as plain data the target can accept.
 *
 * `_`-prefixed keys are MindooDB's own namespace (`_attachments`,
 * `_lastModified`) and are managed by the target database, so they are dropped
 * rather than copied over stale.
 */
function copyablePayload(payload: MindooDocPayload): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith("_")) continue;
    copy[key] = structuredClone(value);
  }
  return copy;
}

/** Flatten one document into the target database. */
export async function flattenDocument(
  source: CopyEngineHost,
  target: CopyEngineHost,
  context: CopyContext,
  options: CopyDocumentOptions,
  reporter: CopyProgressReporter,
): Promise<CopyDocumentResult> {
  const { sourceDocId, targetDocId } = context;

  reporter.emit("planning", `Reading ${sourceDocId} for a flattened copy`);
  const sourceDoc =
    options.atTimestamp != null
      ? await source.db.getDocumentAtTimestamp(sourceDocId, options.atTimestamp)
      : await source.db.getDocument(sourceDocId);
  if (!sourceDoc) {
    throw new Error(
      options.atTimestamp != null
        ? `Document ${sourceDocId} did not exist at timestamp ${options.atTimestamp}.`
        : `Document ${sourceDocId} was not found in database ${context.sourceDbId}.`,
    );
  }

  const usesGeneratedId = (options.targetDocId ?? "new") === "new";
  if (!usesGeneratedId && !CUSTOM_DOC_ID_REGEX.test(targetDocId)) {
    // Ids minted by MindooDB may start with a digit, which the caller-provided
    // id rules reject. Say so here rather than letting createDocument fail with
    // a message that gives no hint about the copy.
    throw new Error(
      `Cannot flatten into document id '${targetDocId}': caller-provided ids must ` +
        `match ${CUSTOM_DOC_ID_REGEX.source}. Copy with mode 'history' to keep a ` +
        "MindooDB-generated id, or pass an explicit targetDocId that satisfies the rule.",
    );
  }

  const copiedByPublicKey =
    options.signingKeyPair?.publicKey ??
    (await target.tenant.getCurrentUserId()).userSigningPublicKey;
  const payload = copyablePayload(sourceDoc.getData());

  let provenance: FlattenedDocumentProvenance | undefined;
  if (options.provenance !== false) {
    provenance = {
      copiedAt: Date.now(),
      sourceTenantId: context.sourceTenantId,
      sourceDbId: context.sourceDbId,
      sourceDocId,
      copiedByPublicKey,
    };
    if (options.atTimestamp != null) {
      // Automerge rejects an explicit `undefined`, so optional fields have to be
      // left out entirely rather than assigned an absent value.
      provenance.sourceAtTimestamp = options.atTimestamp;
    }
  }

  const includeAttachments = options.includeAttachments !== false;
  const sourceAttachments = includeAttachments ? sourceDoc.getAttachments() : [];

  // Fold the payload into the `doc_create` change instead of writing a second
  // entry for it. A caller-provided id normally cannot do this: it is seeded
  // from a hard-coded Automerge change so independent replicas converge on the
  // same hash, and baking content into that change would diverge it per
  // document — `createDocument` rejects the combination. `assumeUniqueId` is
  // the caller's assertion that concurrent same-id creation cannot happen, so
  // convergence is moot and the create can take the generated-id path.
  //
  // `copyablePayload` has already dropped every `_`-prefixed key, so nothing is
  // silently lost to `initialValues`' own reserved-field sanitizer.
  const assumeUniqueId = !usesGeneratedId && options.assumeUniqueTargetDocId === true;
  const seedPayloadIntoCreate = usesGeneratedId || assumeUniqueId;

  const idsBefore = new Set(
    (await target.store.findNewEntriesForDoc([], targetDocId)).map((entry) => entry.id),
  );

  reporter.emit("transferring", `Writing flattened copy as ${targetDocId}`);
  const targetDoc = await target.db.createDocument({
    ...(usesGeneratedId
      ? { idPrefix: options.idPrefix }
      : { id: targetDocId, assumeUniqueId }),
    ...(seedPayloadIntoCreate ? { initialValues: payload } : {}),
    decryptionKeyId: context.targetDecryptionKeyId,
    signingKeyPair: options.signingKeyPair,
    signingKeyPassword: options.signingKeyPassword,
    bypassAccessControlPrecheck: options.bypassAccessControlPrecheck,
  });

  // Whatever the create could not carry. `_provenance` is in MindooDB's
  // reserved namespace, which `initialValues` refuses to seed, so asking for
  // provenance costs the second entry — the price of keeping the marker out of
  // the caller's field namespace, where a later re-copy would treat it as
  // ordinary content.
  const needsFollowUpChange =
    !seedPayloadIntoCreate || provenance !== undefined || sourceAttachments.length > 0;

  if (needsFollowUpChange) {
    await target.db.changeDoc(
      targetDoc,
      async (draft: MindooDoc) => {
        if (!seedPayloadIntoCreate) {
          Object.assign(draft.getData(), payload);
        }
        if (provenance) {
          draft.getData()[PROVENANCE_FIELD] = provenance;
        }
        for (const attachment of sourceAttachments) {
          if (options.signal?.aborted) break;
          await draft.addAttachmentStream(
            sourceDoc.streamAttachment(attachment.attachmentId),
            attachment.fileName,
            attachment.mimeType,
          );
        }
      },
      {
        signingKeyPair: options.signingKeyPair,
        signingKeyPassword: options.signingKeyPassword,
        bypassAccessControlPrecheck: options.bypassAccessControlPrecheck,
      },
    );
  }

  const written = (
    await target.store.findNewEntriesForDoc([], targetDoc.getId())
  ).filter((entry) => !idsBefore.has(entry.id));
  reporter.copiedEntries += written.length;
  for (const entry of written) {
    reporter.copiedBytes += entry.encryptedSize;
  }
  reporter.copiedAttachments += sourceAttachments.length;
  reporter.emit("complete", `Flattened ${sourceDocId} into ${targetDoc.getId()}`);

  return {
    sourceDocId,
    targetDocId: targetDoc.getId(),
    strategy: "flatten",
    authorshipPreserved: false,
    mergedIntoExisting: context.targetHasDocId,
    copiedEntries: written.length,
    copiedBytes: written.reduce((total, entry) => total + entry.encryptedSize, 0),
    copiedAttachments: sourceAttachments.length,
    cancelled: options.signal?.aborted ?? false,
  };
}
