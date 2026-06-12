import { DEFAULT_TENANT_KEY_ID } from "../types";

/**
 * Minimal decryptor surface needed to decrypt an `_encrypted` field. This is a
 * subset of `MindooTenant` so callers can pass a tenant directly without this
 * module depending on the full tenant type.
 */
export interface EncryptedFieldDecryptor {
  decryptPayload(encryptedPayload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array>;
}

/** Suffix of the companion field naming the key id of an `_encrypted` field. */
const KEY_FIELD_SUFFIX = "_key";

/**
 * Resolves the symmetric key id for an `_encrypted` field following the
 * `<field>_encrypted` / `<field>_encrypted_key` naming convention.
 *
 * Resolution order: explicit `override` -> the field's `<field>_key` companion
 * field on the document -> the tenant default key (`"default"`).
 */
export function getEncryptedFieldKeyId(
  data: Record<string, unknown>,
  encryptedFieldName: string,
  override?: string | null,
): string {
  if (typeof override === "string" && override.trim()) {
    return override;
  }
  const companion = data[`${encryptedFieldName}${KEY_FIELD_SUFFIX}`];
  if (typeof companion === "string" && companion.trim()) {
    return companion;
  }
  return DEFAULT_TENANT_KEY_ID;
}

/** Decodes a base64 string into bytes. */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decrypts a base64 `_encrypted` field to its UTF-8 plaintext.
 *
 * The key id is resolved with {@link getEncryptedFieldKeyId} unless
 * `keyIdOverride` is provided. Returns `null` when the field is missing/blank
 * or decryption fails (for example the named key is not present in the
 * decryptor's key bag), so callers can treat unreadable fields as absent rather
 * than throwing.
 */
export async function decryptEncryptedField(
  decryptor: EncryptedFieldDecryptor,
  data: Record<string, unknown>,
  encryptedFieldName: string,
  keyIdOverride?: string | null,
): Promise<string | null> {
  const ciphertext = data[encryptedFieldName];
  if (typeof ciphertext !== "string" || !ciphertext) {
    return null;
  }
  const keyId = getEncryptedFieldKeyId(data, encryptedFieldName, keyIdOverride);
  try {
    const encrypted = base64ToUint8Array(ciphertext);
    const decrypted = await decryptor.decryptPayload(encrypted, keyId);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
