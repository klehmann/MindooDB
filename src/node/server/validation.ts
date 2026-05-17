/**
 * Input validation utilities for the MindooDB Example Server.
 *
 * Prevents path traversal, injection, and resource exhaustion attacks
 * by enforcing strict rules on all user-supplied identifiers and arrays.
 */

import { getDatabaseIdValidationError } from "../../core/databaseIdValidation";
import {
  getTenantIdValidationError,
  RESERVED_TENANT_NAMES,
} from "../../core/tenantIdValidation";

/**
 * Validates an identifier (dbId, serverName, etc.).
 * Must be 1-64 chars, ASCII letters/digits/dots/hyphens, start with alphanumeric.
 * Rejects path separators, "..", leading dots, and special characters.
 */
export function validateIdentifier(value: unknown, fieldName: string): string {
  const error = getDatabaseIdValidationError(value, fieldName);
  if (error) {
    throw new ValidationError(error);
  }
  return value as string;
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

/**
 * Validates tenant ID syntax without checking reserved route names.
 */
export function validateTenantIdFormat(value: unknown): string {
  const error = getTenantIdValidationError(value, "tenantId", {
    allowReserved: true,
  });
  if (error) {
    throw new ValidationError(error);
  }

  return value as string;
}

/**
 * Validates a tenant ID: must pass tenant ID syntax rules and must not be reserved.
 */
export function validateTenantId(value: unknown): string {
  const id = validateTenantIdFormat(value);
  if (RESERVED_TENANT_NAMES.has(id)) {
    throw new ValidationError(
      `tenantId "${id}" is reserved and cannot be used`,
    );
  }
  return id;
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
