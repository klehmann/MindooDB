/**
 * Shared database ID validation used by local clients and sync servers.
 *
 * Database IDs are embedded in server routes and storage names, so keep the
 * accepted character set intentionally narrow and consistent everywhere.
 */
export const DATABASE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
export const MAX_DATABASE_ID_LENGTH = 64;
export const DATABASE_ID_REQUIREMENTS =
  "Database IDs must be 1-64 characters, start with a letter or digit, and contain only letters, digits, dots, and hyphens.";

export function getDatabaseIdValidationError(value: unknown, fieldName = "dbId"): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${fieldName} is required and must be a non-empty string`;
  }

  if (value.length > MAX_DATABASE_ID_LENGTH) {
    return `${fieldName} must be at most ${MAX_DATABASE_ID_LENGTH} characters`;
  }

  if (!DATABASE_ID_REGEX.test(value)) {
    return `${fieldName} must start with a letter or digit and contain only letters, digits, dots, and hyphens`;
  }

  return null;
}

export function isValidDatabaseId(value: unknown): value is string {
  return getDatabaseIdValidationError(value) === null;
}

export function validateDatabaseId(value: unknown, fieldName = "dbId"): string {
  const error = getDatabaseIdValidationError(value, fieldName);
  if (error) {
    throw new Error(error);
  }
  return value as string;
}
