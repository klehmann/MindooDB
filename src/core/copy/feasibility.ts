/**
 * Pure strategy resolution for document copies.
 *
 * Everything here is a side-effect-free function of a {@link CopyContext} plus
 * the caller's {@link CopyDocumentOptions}, which keeps the "can I do this, and
 * what would it cost me" question answerable without touching a store, and
 * keeps the rules unit-testable in isolation from the copy engine.
 *
 * @module
 */

import type {
  CopyDocumentOptions,
  CopyFeasibility,
  CopyFeasibilityReason,
  CopyFeasibilityReasonCode,
  CopyStrategy,
} from "./types";
import { isSealedKeyId } from "../userkeys/sealedTypes";

/** The tenant directory database id. Never a valid copy source or target. */
export const DIRECTORY_DB_ID = "directory";

/**
 * Everything the resolver needs to know about the source and target, gathered
 * by the copy engine before any work starts.
 *
 * @internal
 */
export interface CopyContext {
  /** Tenant owning the source database. */
  sourceTenantId: string;
  /** Tenant owning the target database. */
  targetTenantId: string;
  /** Source database (store) id. */
  sourceDbId: string;
  /** Target database (store) id. */
  targetDbId: string;
  /** The document id being read from the source. */
  sourceDocId: string;
  /** The document id that will be written in the target, already resolved. */
  targetDocId: string;
  /** The `decryptionKeyId` the source document's entries currently use. */
  sourceDecryptionKeyId: string;
  /** The `decryptionKeyId` the copy will be written under, already resolved. */
  targetDecryptionKeyId: string;
  /** True when source and target document entries live in the same store. */
  sameStore: boolean;
  /** True when the target store already holds an entry for {@link targetDocId}. */
  targetHasDocId: boolean;
}

/**
 * Resolve the effective target `decryptionKeyId` for a copy.
 *
 * Within one tenant the source document's own key is kept, so a copy stays
 * readable by exactly the same people and — crucially — stays eligible for
 * authorship preservation. Across tenants the source key id is meaningless
 * (key ids resolve tenant-scoped), so the copy falls back to the target
 * tenant's `"default"` key.
 */
export function resolveTargetDecryptionKeyId(
  requested: string | undefined,
  sourceDecryptionKeyId: string,
  sameTenant: boolean,
): string {
  if (requested) return requested;
  if (isSealedKeyId(sourceDecryptionKeyId)) return "default";
  return sameTenant ? sourceDecryptionKeyId : "default";
}

/** Build a reason record with a stable code and a human-readable message. */
function reason(
  code: CopyFeasibilityReasonCode,
  message: string,
): CopyFeasibilityReason {
  return { code, message };
}

/**
 * Decide what a copy would do, and whether it can run at all.
 *
 * The rules, in order:
 *
 * 1. Neither side may be the tenant directory database.
 * 2. `flatten` mode always resolves to the flatten strategy and never preserves
 *    authorship (there is no original entry left to preserve).
 * 3. `history` mode preserves authorship only in the exact configuration where
 *    the original `metadataSignature` remains valid: same tenant, same document
 *    id, same key, different database. Anything else re-authors.
 * 4. Asking for `authorship: "preserve"` outside that configuration is refused
 *    rather than silently downgraded, because a caller who asked for it is
 *    relying on the signatures being real.
 */
export function resolveCopyFeasibility(
  context: CopyContext,
  options: CopyDocumentOptions = {},
): CopyFeasibility {
  const mode = options.mode ?? "flatten";
  const authorship = options.authorship ?? "reauthor";
  const wantsPreserve = authorship === "preserve";

  const sameTenant = context.sourceTenantId === context.targetTenantId;
  const sameDocId = context.sourceDocId === context.targetDocId;
  const sameKey = context.sourceDecryptionKeyId === context.targetDecryptionKeyId;
  // Key ids resolve per tenant, so an identical id across tenants still names a
  // different key and still forces re-encryption.
  const requiresReEncryption = !sameTenant || !sameKey;

  const reasons: CopyFeasibilityReason[] = [];

  const isDirectory = (dbId: string): boolean => dbId === DIRECTORY_DB_ID;
  if (isDirectory(context.sourceDbId) || isDirectory(context.targetDbId)) {
    reasons.push(
      reason(
        "directory_database",
        "The tenant directory database cannot be used as a copy source or target.",
      ),
    );
    return {
      allowed: false,
      strategy: mode === "flatten" ? "flatten" : "replay",
      authorshipPreserved: false,
      willMergeIntoExisting: false,
      sameStore: context.sameStore,
      requiresReEncryption,
      reasons,
    };
  }

  if (context.sameStore && sameDocId) {
    reasons.push(
      reason(
        "same_database_same_doc_id",
        `Source and target are the same database (${context.sourceDbId}) and the ` +
          `target document id is unchanged (${context.targetDocId}), so there is ` +
          "nothing to copy. Use targetDocId 'new' to duplicate in place.",
      ),
    );
    return {
      allowed: false,
      strategy: mode === "flatten" ? "flatten" : "replay",
      authorshipPreserved: false,
      willMergeIntoExisting: true,
      sameStore: true,
      requiresReEncryption,
      reasons,
    };
  }

  if (mode === "flatten") {
    if (wantsPreserve) {
      reasons.push(
        reason(
          "flatten_mode",
          "Flatten mode writes a single new change, so there is no original " +
            "entry whose authorship could be preserved. Use mode 'history' with " +
            "authorship 'preserve'.",
        ),
      );
      return {
        allowed: false,
        strategy: "flatten",
        authorshipPreserved: false,
        willMergeIntoExisting: context.targetHasDocId,
        sameStore: context.sameStore,
        requiresReEncryption,
        reasons,
      };
    }
    return {
      allowed: true,
      strategy: "flatten",
      authorshipPreserved: false,
      willMergeIntoExisting: context.targetHasDocId,
      sameStore: context.sameStore,
      requiresReEncryption,
      reasons,
    };
  }

  // mode === "history": collect every condition that blocks preservation.
  if (!sameTenant) {
    reasons.push(
      reason(
        "different_tenant",
        `Source tenant '${context.sourceTenantId}' differs from target tenant ` +
          `'${context.targetTenantId}'. The payload must be re-encrypted under the ` +
          "target tenant key, and the source authors' keys are not in the target " +
          "tenant's directory, so their signatures could not be verified there.",
      ),
    );
  }
  if (!sameDocId) {
    reasons.push(
      reason(
        "different_doc_id",
        `The copy lands under document id '${context.targetDocId}' instead of ` +
          `'${context.sourceDocId}'. Entry ids embed the document id and the ` +
          "author's metadataSignature binds both, so the original signatures " +
          "cannot carry over. Use targetDocId 'same' to preserve authorship.",
      ),
    );
  }
  if (!sameKey) {
    reasons.push(
      reason(
        "different_key",
        `The copy is encrypted under key '${context.targetDecryptionKeyId}' instead ` +
          `of '${context.sourceDecryptionKeyId}'. Re-encryption changes contentHash, ` +
          "which the author's metadataSignature binds.",
      ),
    );
  }

  const canPreserve = reasons.length === 0;
  if (wantsPreserve && !canPreserve) {
    return {
      allowed: false,
      strategy: "replay",
      authorshipPreserved: false,
      willMergeIntoExisting: context.targetHasDocId,
      sameStore: context.sameStore,
      requiresReEncryption,
      reasons,
    };
  }

  const strategy: CopyStrategy = wantsPreserve ? "graft" : "replay";
  return {
    allowed: true,
    strategy,
    authorshipPreserved: strategy === "graft",
    willMergeIntoExisting: context.targetHasDocId,
    sameStore: context.sameStore,
    requiresReEncryption,
    // A successful graft has nothing to explain. A replay lists what would have
    // had to be true for authorship to survive, so callers can tell an
    // unavoidable re-author from an accidental one.
    reasons: strategy === "graft" ? [] : reasons,
  };
}

/**
 * Turn an unusable {@link CopyFeasibility} into the error thrown by
 * `copyDocumentTo` / `copyDocumentsTo`.
 */
export function copyFeasibilityError(feasibility: CopyFeasibility): Error {
  const detail = feasibility.reasons
    .map((entry) => `[${entry.code}] ${entry.message}`)
    .join(" ");
  return new Error(`Document copy is not possible with the requested options. ${detail}`);
}
