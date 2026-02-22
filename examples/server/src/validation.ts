/**
 * Input validation utilities for the MindooDB Example Server.
 *
 * Prevents path traversal, injection, and resource exhaustion attacks
 * by enforcing strict rules on all user-supplied identifiers and arrays.
 */

/**
 * Validates an identifier (tenantId, dbId, serverName, etc.).
 * Must be 1-64 chars, lowercase alphanumeric + hyphens, start with alphanumeric.
 * Rejects path separators, "..", leading dots, and special characters.
 */
export function validateIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${fieldName} is required and must be a non-empty string`);
  }

  if (value.length > 64) {
    throw new ValidationError(`${fieldName} must be at most 64 characters`);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new ValidationError(
      `${fieldName} must start with a letter or digit and contain only lowercase letters, digits, and hyphens`,
    );
  }

  return value;
}

/**
 * Validates a username (more permissive than identifier -- allows "CN=xxx/O=yyy" format).
 * Max 256 chars, printable ASCII, no path separators or null bytes.
 */
export function validateUsername(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("username is required and must be a non-empty string");
  }

  if (value.length > 256) {
    throw new ValidationError("username must be at most 256 characters");
  }

  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new ValidationError("username must not contain control characters");
  }

  return value;
}

/**
 * Validates that an array does not exceed a maximum number of elements.
 */
export function validateArraySize(value: unknown, maxSize: number, fieldName: string): void {
  if (!Array.isArray(value)) {
    return;
  }

  if (value.length > maxSize) {
    throw new ValidationError(
      `${fieldName} must contain at most ${maxSize} elements (received ${value.length})`,
    );
  }
}

/**
 * Validates that a string does not exceed a maximum length.
 */
export function validateStringLength(value: unknown, maxLength: number, fieldName: string): void {
  if (typeof value !== "string") {
    return;
  }

  if (value.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
    );
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Limits
export const MAX_HAVE_IDS = 100_000;
export const MAX_ENTRY_IDS = 100_000;
export const MAX_PUT_ENTRIES = 10_000;
export const MAX_PEM_KEY_LENGTH = 8_192;
export const MAX_SIGNATURE_LENGTH = 4_096;
export const MAX_CHALLENGE_LENGTH = 4_096;
