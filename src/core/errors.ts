/**
 * Error thrown when a symmetric encryption key is not found in the KeyBag.
 * This error is used to identify documents that cannot be decrypted because
 * the user doesn't have access to the required encryption key.
 */
export class SymmetricKeyNotFoundError extends Error {
  public readonly keyId: string;

  constructor(keyId: string) {
    super(`Symmetric key not found: ${keyId}`);
    this.name = "SymmetricKeyNotFoundError";
    this.keyId = keyId;
  }
}

/**
 * Error thrown when a document id cannot be resolved in the database (no
 * `doc_create` entry exists). Callers that treat "missing" as a regular
 * outcome (e.g. probing several databases for an id) should catch this via
 * {@link isDocumentMissingError} instead of matching message strings.
 */
export class DocumentNotFoundError extends Error {
  public readonly docId: string;

  constructor(docId: string) {
    super(`Document ${docId} not found`);
    this.name = "DocumentNotFoundError";
    this.docId = docId;
  }
}

/**
 * Error thrown when a document exists but its latest lifecycle entry is a
 * deletion, so it cannot be materialized through the regular read/write APIs.
 */
export class DocumentDeletedError extends Error {
  public readonly docId: string;

  constructor(docId: string) {
    super(`Document ${docId} has been deleted`);
    this.name = "DocumentDeletedError";
    this.docId = docId;
  }
}

/**
 * True when `error` signals that a document id cannot be materialized —
 * either unknown ({@link DocumentNotFoundError}) or deleted
 * ({@link DocumentDeletedError}). Checks the error `name` in addition to
 * `instanceof` so it stays reliable when two module copies of mindoodb are
 * loaded (e.g. a bundled app next to a linked workspace build).
 */
export function isDocumentMissingError(error: unknown): boolean {
  if (error instanceof DocumentNotFoundError || error instanceof DocumentDeletedError) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === "DocumentNotFoundError" || error.name === "DocumentDeletedError")
  );
}

/**
 * Error thrown by `ContentAddressedStore.resolveDependencies()` when the walk
 * reaches an entry id the store does not hold — the start entry itself, or a
 * dependency some entry on the chain points to.
 *
 * Returning the chain up to the gap would hand callers an incomplete result
 * that looks complete: an attachment read from it comes back empty or
 * truncated without any error. The fields name the gap so it can be analysed
 * (which chain, which id, who referenced it, how far the walk got).
 *
 * The message starts with `"Missing dependency"` so a caller can still
 * recognise it after a network hop, where only the message survives; use
 * {@link isMissingDependencyError}.
 */
export class MissingDependencyError extends Error {
  /** The entry the walk started from. */
  public readonly startId: string;
  /** The entry id that is not in the store. */
  public readonly missingId: string;
  /** The entry whose `dependencyIds` named `missingId`; `null` when the start entry itself is missing. */
  public readonly referencedBy: string | null;
  /** Hops from the start entry to the missing one (0 = the start entry). */
  public readonly depth: number;
  /** Entries found before the walk hit the gap. */
  public readonly resolvedCount: number;

  constructor(details: {
    startId: string;
    missingId: string;
    referencedBy: string | null;
    depth: number;
    resolvedCount: number;
  }) {
    super(
      details.referencedBy === null
        ? `Missing dependency: start entry ${details.missingId} is not in the store`
        : `Missing dependency: entry ${details.missingId} (referenced by ${details.referencedBy}, ` +
            `${details.depth} hop(s) from ${details.startId}, ${details.resolvedCount} entries resolved before it) ` +
            `is not in the store`,
    );
    this.name = "MissingDependencyError";
    this.startId = details.startId;
    this.missingId = details.missingId;
    this.referencedBy = details.referencedBy;
    this.depth = details.depth;
    this.resolvedCount = details.resolvedCount;
  }
}

/**
 * True when `error` is a {@link MissingDependencyError}, also when it crossed a
 * network or RPC boundary and arrives as a plain error carrying its message, or
 * when two module copies of mindoodb are loaded.
 */
export function isMissingDependencyError(error: unknown): boolean {
  if (error instanceof MissingDependencyError) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === "MissingDependencyError" || error.message.includes("Missing dependency:"))
  );
}
