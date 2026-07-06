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
