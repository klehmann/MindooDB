/**
 * Tenant setup document helpers.
 *
 * The singleton directory document `tenantsetup` stores the human-readable
 * tenant label under `$publicinfos` so every member can read it after a
 * directory sync.
 */

import {
  MindooDB,
  PUBLIC_INFOS_KEY_ID,
  TENANT_SETUP_DOC_ID,
  SigningKeyPair,
} from "./types";

export { TENANT_SETUP_DOC_ID };

export interface TenantSetupData {
  /** Human-readable tenant label (display name). */
  label?: string;
}

/**
 * Read the tenant label from the directory database's `tenantsetup` document.
 * Returns `undefined` when the document is missing or has no label.
 */
export async function readTenantSetupLabel(directoryDb: MindooDB): Promise<string | undefined> {
  try {
    const doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
    const data = doc.getData() as TenantSetupData;
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
 * Must be signed with the tenant admin signing key.
 */
export async function writeTenantSetupLabel(
  directoryDb: MindooDB,
  label: string,
  adminSigningKeyPair: SigningKeyPair,
  adminSigningKeyPassword: string,
): Promise<void> {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("Tenant label must be a non-empty string");
  }

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
      data.label = trimmed;
    },
    {
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: adminSigningKeyPassword,
    },
  );
}
