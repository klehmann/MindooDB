/**
 * Shared tenant ID validation used by local clients and sync servers.
 *
 * Tenant IDs appear in server routes, local storage namespaces, and user-visible
 * join payloads, so keep the accepted character set intentionally narrow and
 * consistent everywhere.
 */
export const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
export const MAX_TENANT_ID_LENGTH = 64;
export const RESERVED_TENANT_NAMES = new Set(["admin", "system", "health", "statics"]);
export const TENANT_ID_REQUIREMENTS =
  "Tenant IDs must be 1-64 characters, start with a letter or digit, and contain only lowercase letters, digits, hyphens, and underscores.";

export function getTenantIdValidationError(
  value: unknown,
  fieldName = "tenantId",
  options: { allowReserved?: boolean } = {},
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${fieldName} is required and must be a non-empty string`;
  }

  if (value.length > MAX_TENANT_ID_LENGTH) {
    return `${fieldName} must be at most ${MAX_TENANT_ID_LENGTH} characters`;
  }

  if (!TENANT_ID_REGEX.test(value)) {
    return `${fieldName} must start with a letter or digit and contain only lowercase letters, digits, hyphens, and underscores`;
  }

  if (!options.allowReserved && RESERVED_TENANT_NAMES.has(value)) {
    return `${fieldName} "${value}" is reserved and cannot be used`;
  }

  return null;
}

export function isValidTenantId(value: unknown): value is string {
  return getTenantIdValidationError(value) === null;
}

export function validateTenantId(
  value: unknown,
  fieldName = "tenantId",
  options?: { allowReserved?: boolean },
): string {
  const error = getTenantIdValidationError(value, fieldName, options);
  if (error) {
    throw new Error(error);
  }
  return value as string;
}
