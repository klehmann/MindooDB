/**
 * Tenant setup document helpers.
 *
 * The singleton directory document `tenantsetup` is encrypted under
 * `$publicinfos` so it syncs to every member (and to the sync server). The
 * human-readable tenant label itself is field-encrypted under the tenant
 * `default` key (`label_encrypted` / `label_encrypted_key`) so the server
 * cannot read the display name — same pattern as `user_details_encrypted`
 * on grant documents.
 */

import {
  DEFAULT_TENANT_KEY_ID,
  MindooDB,
  MindooTenant,
  PUBLIC_INFOS_KEY_ID,
  TENANT_SETUP_DOC_ID,
  SigningKeyPair,
} from "./types";
import { decryptEncryptedField } from "./crypto/encryptedFields";

export { TENANT_SETUP_DOC_ID };

export interface TenantSetupData {
  /**
   * @deprecated Legacy plaintext label. New writes use `label_encrypted`.
   * Still read for older tenants until the next admin write migrates them.
   */
  label?: string;
  /** Base64 AES-GCM ciphertext of the UTF-8 label under `default`. */
  label_encrypted?: string;
  /** Key id used for `label_encrypted`; always `"default"`. */
  label_encrypted_key?: string;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Read the tenant label from the directory database's `tenantsetup` document.
 * Requires the tenant `default` key to decrypt `label_encrypted`. Returns
 * `undefined` when the document is missing, the key is absent, or there is no
 * label. Legacy plaintext `label` is still accepted for older tenants.
 */
export async function readTenantSetupLabel(
  directoryDb: MindooDB,
  tenant: MindooTenant,
): Promise<string | undefined> {
  try {
    const doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
    const data = doc.getData() as TenantSetupData & Record<string, unknown>;

    const decrypted = await decryptEncryptedField(tenant, data, "label_encrypted");
    if (typeof decrypted === "string") {
      const trimmed = decrypted.trim();
      if (trimmed.length > 0) return trimmed;
    }

    // Legacy: plaintext label written before field encryption.
    if (typeof data.label === "string") {
      const trimmed = data.label.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    // Document missing or unreadable.
  }
  return undefined;
}

/**
 * Create or update the `tenantsetup` document with the given label.
 * Must be signed with the tenant admin signing key. Stores the label as
 * `label_encrypted` under the tenant `default` key and clears any legacy
 * plaintext `label` field.
 */
export async function writeTenantSetupLabel(
  directoryDb: MindooDB,
  label: string,
  adminSigningKeyPair: SigningKeyPair,
  adminSigningKeyPassword: string,
  tenant: MindooTenant,
): Promise<void> {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("Tenant label must be a non-empty string");
  }

  const encrypted = await tenant.encryptPayload(
    new TextEncoder().encode(trimmed),
    DEFAULT_TENANT_KEY_ID,
  );
  const labelEncrypted = uint8ArrayToBase64(encrypted);

  let doc;
  try {
    doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
  } catch {
    doc = await directoryDb.createDocument({
      id: TENANT_SETUP_DOC_ID,
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: adminSigningKeyPassword,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
    });
  }

  await directoryDb.changeDoc(
    doc,
    (d) => {
      const data = d.getData() as TenantSetupData;
      data.label_encrypted = labelEncrypted;
      data.label_encrypted_key = DEFAULT_TENANT_KEY_ID;
      delete data.label;
    },
    {
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: adminSigningKeyPassword,
    },
  );
}
