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
