/**
 * Public types for copying documents between MindooDB databases.
 *
 * See `docs/document-copy.md` for the full picture (strategy matrix, sharding
 * playbook, caveats). The short version:
 *
 * - **flatten** collapses a document's whole history into a single new change
 *   in the target. Cheap, always available, loses history and authorship.
 * - **graft** copies the original store entries byte-for-byte. The ONLY way to
 *   keep the original signers, and only legal within one tenant, under the same
 *   document id and the same encryption key, into a different database.
 * - **replay** re-writes every historical change under a new identity: the
 *   Automerge history survives intact, the store-level author becomes the
 *   copying user, and the original authorship is recorded as a verifiable
 *   {@link EntryProvenance} record instead.
 *
 * @module
 */

import type { SigningKeyPair } from "../types";

/**
 * How much of the source document's history the copy carries over.
 *
 * - `"flatten"` — read the document's state (at head, or at
 *   {@link CopyDocumentOptions.atTimestamp}) and write it as one fresh change.
 * - `"history"` — carry every historical change, so the copy has the same
 *   Automerge revision graph as the source and supports time travel.
 *
 * @defaultValue `"flatten"`
 */
export type CopyDocumentMode = "flatten" | "history";

/**
 * Whether the copied entries keep the original authors' signatures.
 *
 * - `"reauthor"` — the copying user signs every produced entry. Always
 *   possible.
 * - `"preserve"` — the original entries are copied byte-for-byte so the
 *   original authors' signatures stay valid. Only possible in one exact
 *   configuration (see {@link CopyDocumentOptions.authorship}); requesting it
 *   anywhere else throws rather than silently downgrading.
 *
 * @defaultValue `"reauthor"`
 */
export type CopyDocumentAuthorship = "preserve" | "reauthor";

/**
 * The concrete execution strategy chosen for a copy, resolved from
 * {@link CopyDocumentOptions.mode} and {@link CopyDocumentOptions.authorship}
 * plus the source/target context. Reported on {@link CopyFeasibility} and
 * {@link CopyDocumentResult} so callers can see what actually ran.
 */
export type CopyStrategy = "flatten" | "graft" | "replay";

/**
 * Why a requested copy cannot run, or cannot preserve authorship. Codes are
 * stable and safe to branch on; `message` is for humans and may change.
 */
export type CopyFeasibilityReasonCode =
  /** Source and target belong to different tenants, so the payload must be
   *  re-encrypted under the target tenant key and the source authors are not
   *  in the target tenant's directory. */
  | "different_tenant"
  /** The copy lands under a new document id, which changes the entry ids and
   *  therefore invalidates the original authors' metadata signatures. */
  | "different_doc_id"
  /** The target uses a different `decryptionKeyId`, forcing re-encryption,
   *  which changes `contentHash` and invalidates the original signatures. */
  | "different_key"
  /** Flatten mode produces a single new change, so there is no original entry
   *  whose authorship could be preserved. */
  | "flatten_mode"
  /** Source and target resolve to the same store under the same document id:
   *  there is nothing to copy. */
  | "same_database_same_doc_id"
  /** The tenant directory database is never a valid copy source or target. */
  | "directory_database";

/** One structured explanation attached to a {@link CopyFeasibility}. */
export interface CopyFeasibilityReason {
  /** Stable, branchable identifier for the condition. */
  code: CopyFeasibilityReasonCode;
  /** Human-readable explanation, suitable for surfacing in a UI or an error. */
  message: string;
}

/**
 * The outcome of the pure strategy resolver: what a copy *would* do, computed
 * without writing anything. Returned by `canCopyDocumentTo()` so a caller can
 * explain the plan (or the refusal) before committing to it.
 */
export interface CopyFeasibility {
  /** Whether the copy can run at all with the requested options. */
  allowed: boolean;
  /**
   * The strategy that would execute. Meaningful only when {@link allowed} is
   * true.
   */
  strategy: CopyStrategy;
  /**
   * Whether the original authors' signatures would survive. True only for the
   * `graft` strategy.
   */
  authorshipPreserved: boolean;
  /**
   * True when the target database already holds the destination document id.
   * The copy then *merges* into that document (CRDT union of both histories)
   * rather than creating a separate one.
   */
  willMergeIntoExisting: boolean;
  /** True when source and target document entries live in the same store. */
  sameStore: boolean;
  /**
   * True when payloads must be decrypted and re-encrypted, because the tenant
   * or the `decryptionKeyId` differs. Implies the copy needs read access to the
   * source key and write access to the target key.
   */
  requiresReEncryption: boolean;
  /**
   * Why the copy is disallowed, or why authorship cannot be preserved. Empty
   * when the copy runs exactly as requested. Populated even when
   * {@link allowed} is true, to explain a `reauthor` outcome.
   */
  reasons: CopyFeasibilityReason[];
}

/**
 * Lifecycle stage of a running copy. Mirrors `SyncProgress.phase` so a UI can
 * reuse the same progress rendering for syncs and copies.
 */
export type CopyProgressPhase =
  | "preparing"
  | "planning"
  | "transferring"
  | "processing"
  | "complete";

/**
 * Progress event emitted during a copy. Shaped to match `SyncProgress` so the
 * two are interchangeable in a progress UI.
 */
export interface CopyProgress {
  /** Current lifecycle stage. */
  phase: CopyProgressPhase;
  /** Human-readable status description suitable for display. */
  message: string;
  /** Cumulative entries written to the target so far. */
  copiedEntries: number;
  /**
   * Cumulative encrypted payload size (bytes) written to the target, summed
   * from each entry's `encryptedSize`. Note this is real duplicated storage for
   * a cross-database copy: content deduplication is per-store.
   */
  copiedBytes: number;
  /** Cumulative source entries whose metadata has been examined. */
  scannedEntries: number;
  /**
   * Total entries on the source that are in scope, when known. Fixed for the
   * run, so `scannedEntries / totalSourceEntries` is a stable completion ratio.
   */
  totalSourceEntries?: number;
  /** The document currently being copied, during a bulk copy. */
  currentDocId?: string;
  /** Documents finished so far, during a bulk copy. */
  documentsCompleted?: number;
  /** Total documents selected, during a bulk copy. */
  totalDocuments?: number;
}

/**
 * Options for copying a single document into another database.
 *
 * Defaults are chosen so the zero-config call — `sourceDb.copyDocumentTo(id,
 * targetDb)` — does the safe, obvious thing: a flattened copy under a fresh
 * document id, authored by the current user.
 */
export interface CopyDocumentOptions {
  /**
   * How much history to carry over.
   *
   * @defaultValue `"flatten"`
   */
  mode?: CopyDocumentMode;

  /**
   * The document id to write in the target database.
   *
   * - `"new"` — allocate a fresh id (with {@link idPrefix} when given).
   * - `"same"` — reuse the source document id. Required for authorship
   *   preservation. If the target database already holds that id the copy
   *   **merges** into the existing document instead of creating a new one;
   *   {@link CopyDocumentResult.mergedIntoExisting} reports when that happened.
   * - an explicit string — use exactly this id. Must satisfy the same
   *   constraints as `CreateOptions.id`.
   *
   * @defaultValue `"new"`
   */
  targetDocId?: "same" | "new" | string;

  /**
   * Prefix for the generated id when {@link targetDocId} is `"new"`. Same rules
   * as `CreateOptions.idPrefix` (1-10 alphanumerics, starting with a letter).
   * Ignored for any other {@link targetDocId} value.
   */
  idPrefix?: string;

  /**
   * Caller assertion that the document ids being written are random enough that
   * no other replica can create the same id concurrently — the copy equivalent
   * of `CreateOptions.assumeUniqueId`.
   *
   * **Flatten only, and only when the copy keeps a caller-provided id**
   * ({@link targetDocId} `"same"` or an explicit string). It has no meaning for
   * `mode: "history"`, which copies the source's own `doc_create` entry rather
   * than synthesizing one, and none for {@link targetDocId} `"new"`, whose ids
   * MindooDB generates and already knows to be unique.
   *
   * Without it, a flatten under a caller-provided id costs **two** store
   * entries: the id is seeded from a hard-coded Automerge change so that two
   * replicas creating it independently converge on the same hash, and content
   * cannot be baked into that change without diverging it. With it, the create
   * takes the generated-id path and the payload folds into a single entry —
   * halving the storage and the write cost of a large flatten migration.
   *
   * Safe when the ids were minted by MindooDB (`<prefix>_<22-char-base62>` from
   * `createDocument`, ~128 bits of uuidv7 entropy) or by an equivalent random
   * scheme.
   *
   * WARNING: do NOT set this for semantic or well-known ids (`"settings"`,
   * `"config"`, a natural key imported from another system). If two replicas
   * create the same id with this flag, their `doc_create` entries share no
   * Automerge ancestry and the document **forks** instead of converging. The
   * risk is concurrent creation on replicas that have not synced — a single
   * operator running one migration into a fresh target is not exposed to it,
   * and re-running a copy is still idempotent either way.
   *
   * @defaultValue `false`
   */
  assumeUniqueTargetDocId?: boolean;

  /**
   * Whether to keep the original authors' signatures on the copied entries.
   *
   * `"preserve"` is only legal when ALL of the following hold, and **throws**
   * otherwise rather than silently downgrading:
   *
   * - {@link mode} is `"history"`,
   * - source and target are in the same tenant,
   * - {@link targetDocId} resolves to the source document id,
   * - {@link decryptionKeyId} is unchanged,
   * - source and target are different databases.
   *
   * The constraint is cryptographic, not a policy choice: an entry's
   * `metadataSignature` binds its id, `docId`, `decryptionKeyId` and
   * `contentHash`, so changing any of them requires a signature only the
   * original author could produce. Use `canCopyDocumentTo()` to test first.
   *
   * @defaultValue `"reauthor"`
   */
  authorship?: CopyDocumentAuthorship;

  /**
   * Symmetric key id to encrypt the copy under, in the target tenant.
   * Defaults to the source document's key id when the tenant is unchanged,
   * otherwise to `"default"` (the target tenant key).
   *
   * Changing it forces decrypt + re-encrypt, which changes `contentHash` and
   * therefore rules out {@link authorship} `"preserve"`.
   */
  decryptionKeyId?: string;

  /**
   * Record a verifiable {@link EntryProvenance} on each copied entry (history
   * modes), or a document-level `_provenance` object in the payload (flatten
   * mode), capturing where the copy came from and who originally authored it.
   *
   * Provenance is *self-verifying*: it carries the original entry's signed
   * field projection plus the original author's signature, so a reader can
   * confirm the original author really signed this payload. Has no effect on
   * `graft`, where the original signature is still present on the entry itself.
   *
   * @defaultValue `true`
   */
  provenance?: boolean;

  /**
   * Copy the document's state as of this timestamp (epoch millis) rather than
   * its current head.
   *
   * Flatten mode only — ignored by `history` mode, which always carries the
   * whole revision graph.
   */
  atTimestamp?: number;

  /**
   * Copy the document's attachments as well as its content.
   *
   * @defaultValue `true`
   */
  includeAttachments?: boolean;

  /**
   * Sign the produced entries with this key pair instead of the current user's
   * key. Useful for attributing a bulk import or migration to a dedicated
   * service identity. Must be supplied together with
   * {@link signingKeyPassword}.
   *
   * Ignored by `graft`, which does not re-sign anything.
   */
  signingKeyPair?: SigningKeyPair;

  /** Password decrypting {@link signingKeyPair}'s private key. Required with it. */
  signingKeyPassword?: string;

  /** Called as the copy progresses. See {@link CopyProgress}. */
  onProgress?: (progress: CopyProgress) => void;

  /**
   * Cancels the copy. Because every produced entry id is deterministic, a
   * cancelled copy is safe to re-run: already-written entries are skipped.
   * {@link CopyDocumentResult.targetDocId} is returned even when cancelled, so
   * the caller can resume against the same target id.
   */
  signal?: AbortSignal;

  /**
   * Entries written to the target store per `putEntries` call.
   *
   * @defaultValue `200`
   */
  batchSize?: number;

  /**
   * Skip the client-side access-control write precheck on the target. For
   * trusted bulk paths only; the server witness and quarantine-on-
   * materialization still enforce the rules.
   *
   * @defaultValue `false`
   */
  bypassAccessControlPrecheck?: boolean;
}

/** Outcome of copying one document. */
export interface CopyDocumentResult {
  /** The document id that was read from the source. */
  sourceDocId: string;
  /**
   * The document id written in the target. Returned even when
   * {@link cancelled} is true, so a resumed run can target the same id and
   * benefit from deterministic-id deduplication.
   */
  targetDocId: string;
  /** The strategy that actually executed. */
  strategy: CopyStrategy;
  /** True when the original authors' signatures were kept (graft only). */
  authorshipPreserved: boolean;
  /**
   * True when the target already held {@link targetDocId}, so the copy merged
   * into that existing document rather than creating a new one.
   */
  mergedIntoExisting: boolean;
  /** Store entries written to the target (excluding ones already present). */
  copiedEntries: number;
  /**
   * Encrypted payload bytes written to the target. For a cross-database copy
   * this is genuinely duplicated storage — content dedup is per-store.
   */
  copiedBytes: number;
  /** Attachments carried over. */
  copiedAttachments: number;
  /** True when the copy stopped early because {@link CopyDocumentOptions.signal} aborted. */
  cancelled: boolean;
}

/**
 * Selects which documents a bulk copy operates on. At least one of
 * {@link docIds} or {@link idPrefix} must be given; when both are present a
 * document matching either is selected.
 */
export interface CopyDocumentSelector {
  /** Explicit document ids to copy. */
  docIds?: string[];

  /**
   * Select every document whose id matches one of these prefixes, using the
   * boundary-aware `matchesDocIdPrefix` rule: an id matches when it equals the
   * prefix exactly or begins with `<prefix>_`.
   *
   * A list is accepted because prefixes do not nest. Document id prefixes are
   * 1-10 alphanumerics with no underscore, so a monthly scheme like
   * `inv202506` cannot be selected a year at a time via `inv2025` — pass the
   * twelve monthly prefixes instead.
   *
   * Selecting by prefix reads only store metadata, which is what keeps the
   * sharding fast path keyless. Partitioning on an encrypted payload field
   * would instead require decrypting every document just to place it.
   */
  idPrefix?: string | string[];
}

/**
 * Options for a bulk copy. Identical to {@link CopyDocumentOptions} except that
 * {@link CopyDocumentOptions.targetDocId} cannot be an explicit id string —
 * with many documents in flight only the `"same"` / `"new"` policies are
 * meaningful.
 */
export interface CopyDocumentsOptions
  extends Omit<CopyDocumentOptions, "targetDocId"> {
  /**
   * Document id policy for every copied document.
   *
   * `"same"` is what sharding uses: it keeps document ids stable across the
   * split and is a precondition for {@link CopyDocumentOptions.authorship}
   * `"preserve"`.
   *
   * @defaultValue `"new"`
   */
  targetDocId?: "same" | "new";
}

/** One document that could not be copied during a bulk run. */
export interface CopyDocumentFailure {
  /** The source document id that failed. */
  docId: string;
  /** The failure message. */
  error: string;
}

/** Outcome of a bulk copy. */
export interface CopyDocumentsResult {
  /** Per-document results, in the order the documents were processed. */
  documents: CopyDocumentResult[];
  /**
   * Source document ids that copied successfully. Shaped for direct use as
   * `DocHistoryPurgeRequest.docIds` when reclaiming the source after a shard —
   * see `buildDocHistoryPurgeRequest()`.
   */
  copiedDocIds: string[];
  /**
   * Documents that failed. A bulk copy continues past per-document errors and
   * reports them here, mirroring how `pushChangesTo` reports `rejectedEntries`.
   */
  failed: CopyDocumentFailure[];
  /** Total store entries written to the target across all documents. */
  copiedEntries: number;
  /** Total encrypted payload bytes written to the target. */
  copiedBytes: number;
  /** Total attachments carried over. */
  copiedAttachments: number;
  /** True when the run stopped early because the abort signal fired. */
  cancelled: boolean;
}
