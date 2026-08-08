/**
 * Shared database ID validation used by local clients and sync servers.
 *
 * Database IDs are embedded in server routes and storage names, so keep the
 * accepted character set intentionally narrow and consistent everywhere.
 */
export const DATABASE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_DATABASE_ID_LENGTH = 64;
export const DATABASE_ID_REQUIREMENTS =
  "Database IDs must be 1-64 characters, start with a letter or digit, and contain only letters, digits, dots, hyphens, and underscores.";

export function getDatabaseIdValidationError(value: unknown, fieldName = "dbId"): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${fieldName} is required and must be a non-empty string`;
  }

  if (value.length > MAX_DATABASE_ID_LENGTH) {
    return `${fieldName} ${JSON.stringify(value.slice(0, MAX_DATABASE_ID_LENGTH))}… must be at most ${MAX_DATABASE_ID_LENGTH} characters`;
  }

  if (!DATABASE_ID_REGEX.test(value)) {
    return `${fieldName} ${JSON.stringify(value)} must start with a letter or digit and contain only letters, digits, dots, hyphens, and underscores`;
  }

  return null;
}

export function isValidDatabaseId(value: unknown): value is string {
  return getDatabaseIdValidationError(value) === null;
}

/**
 * Stricter rule for database IDs that are being **created**, as opposed to
 * opened. A database ID becomes a directory name verbatim
 * (`<basePath>/<dbId>/<storeKind>` in `BasicOnDiskContentAddressedStore`), so
 * two IDs that a case-insensitive file system cannot tell apart — `Sales` and
 * `sales` — would share one store and silently mix their entries. New IDs are
 * therefore lowercase-only.
 *
 * Opening stays on the laxer {@link getDatabaseIdValidationError} so databases
 * created before this rule existed remain reachable.
 */
export const NEW_DATABASE_ID_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Base names Windows reserves for character devices. Reserved both bare and
 * with an extension (`nul` and `nul.txt` alike), so the check compares the part
 * before the first dot. Creating a directory with one of these names fails on
 * Windows, so reject them up front rather than at first write.
 */
export const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

export const NEW_DATABASE_ID_REQUIREMENTS =
  "Database IDs must be 1-64 characters, start with a lowercase letter or digit, and contain only lowercase letters, digits, dots, hyphens, and underscores.";

export function getNewDatabaseIdValidationError(
  value: unknown,
  fieldName = "dbId",
): string | null {
  const baseError = getDatabaseIdValidationError(value, fieldName);
  if (baseError) {
    return baseError;
  }

  const id = value as string;

  if (!NEW_DATABASE_ID_REGEX.test(id)) {
    return `${fieldName} ${JSON.stringify(id)} must be lowercase: database IDs become directory names, and file systems on Windows and macOS cannot tell ${JSON.stringify(id.toLowerCase())} apart from it`;
  }

  const baseName = id.split(".")[0];
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) {
    return `${fieldName} ${JSON.stringify(id)} is reserved: Windows cannot create a directory named ${JSON.stringify(baseName)}`;
  }

  if (id.endsWith(".")) {
    return `${fieldName} ${JSON.stringify(id)} must not end with a dot: Windows strips trailing dots from directory names`;
  }

  return null;
}

export function isValidNewDatabaseId(value: unknown): value is string {
  return getNewDatabaseIdValidationError(value) === null;
}

export function validateNewDatabaseId(value: unknown, fieldName = "dbId"): string {
  const error = getNewDatabaseIdValidationError(value, fieldName);
  if (error) {
    throw new Error(error);
  }
  return value as string;
}

export function validateDatabaseId(value: unknown, fieldName = "dbId"): string {
  const error = getDatabaseIdValidationError(value, fieldName);
  if (error) {
    throw new Error(error);
  }
  return value as string;
}
