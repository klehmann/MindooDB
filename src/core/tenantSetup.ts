/**
 * Tenant setup document helpers.
 *
 * The singleton directory document `tenantsetup` is encrypted under
 * `$publicinfos` so it syncs to every member (and to the sync server). The
 * human-readable tenant label itself is field-encrypted under the tenant
 * `default` key (`label_encrypted` / `label_encrypted_key`) so the server
 * cannot read the display name — same pattern as `user_details_encrypted`
 * on grant documents.
 *
 * The document also records the tenant's administrators. An admin holds no
 * `grantaccess` document of its own, so without this list a member can only
 * name the administration key by its fingerprint. Each entry carries the
 * admin's name field-encrypted under `default` plus its device key pairs in
 * the very same `userKeyPairs` shape a grant uses (docs/accesscontrol.md
 * §6.5), so the same helpers read and write both, and additional admins or
 * admin devices can be appended later.
 */

import {
  DEFAULT_TENANT_KEY_ID,
  GrantKeyPair,
  MindooDB,
  MindooTenant,
  PUBLIC_INFOS_KEY_ID,
  TENANT_SETUP_DOC_ID,
  SigningKeyPair,
} from "./types";
import { decryptEncryptedField } from "./crypto/encryptedFields";
import { extractKeyPairs, mergeKeyPairs } from "./accesscontrol/grantKeys";
import { signingKeysEqual } from "./accesscontrol/DirectoryStateNode";
import { usernamesEqual } from "./userid/canonicalUsername";
import { semanticNow } from "./utils/timeSource";

export { TENANT_SETUP_DOC_ID };

/**
 * One administrator as stored on the `tenantsetup` document. The name is
 * field-encrypted under `default`; the device keys use the canonical
 * `userKeyPairs` list of a grant document so both can be parsed by
 * {@link extractKeyPairs}.
 */
export interface TenantAdministratorData {
  /** Base64 AES-GCM ciphertext of the canonical username under `default`. */
  username_encrypted?: string;
  /** Key id used for `username_encrypted`; always `"default"`. */
  username_encrypted_key?: string;
  /** This admin's device key pairs, same shape as a grant's `userKeyPairs`. */
  userKeyPairs?: unknown;
  /** Trusted time (ms since Unix epoch) at which the entry was first written. */
  addedAt?: number;
}

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
  /** The tenant's administrators, oldest first. */
  administrators?: TenantAdministratorData[];
}

/** An administrator entry with its name decrypted, as read by callers. */
export interface TenantAdministrator {
  /**
   * Canonical username. Absent when the reader has no `default` key (e.g. a
   * device that joined but has not imported the tenant key yet).
   */
  username?: string;
  /** The admin's device key pairs (§6.5), active ones first. */
  keyPairs: GrantKeyPair[];
  addedAt?: number;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Field-encrypt a string under the tenant `default` key. */
async function encryptUnderDefaultKey(tenant: MindooTenant, value: string): Promise<string> {
  const encrypted = await tenant.encryptPayload(
    new TextEncoder().encode(value),
    DEFAULT_TENANT_KEY_ID,
  );
  return uint8ArrayToBase64(encrypted);
}

/**
 * Apply a mutation to the `tenantsetup` document, creating it (under
 * `$publicinfos`) when it does not exist yet. Must be signed with the tenant
 * admin signing key.
 */
async function changeTenantSetup(
  directoryDb: MindooDB,
  adminSigningKeyPair: SigningKeyPair,
  adminSigningKeyPassword: string,
  mutate: (data: TenantSetupData) => void,
): Promise<void> {
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
      mutate(d.getData() as TenantSetupData);
    },
    {
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: adminSigningKeyPassword,
    },
  );
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

  const labelEncrypted = await encryptUnderDefaultKey(tenant, trimmed);

  await changeTenantSetup(directoryDb, adminSigningKeyPair, adminSigningKeyPassword, (data) => {
    data.label_encrypted = labelEncrypted;
    data.label_encrypted_key = DEFAULT_TENANT_KEY_ID;
    delete data.label;
  });
}

/** Normalize a stored administrator entry into a plain, writable object. */
function normalizeAdministratorEntry(entry: unknown): TenantAdministratorData | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const pairs = extractKeyPairs(record);
  if (pairs.length === 0) return null;
  const normalized: TenantAdministratorData = { userKeyPairs: pairs.map(toStoredKeyPair) };
  if (typeof record.username_encrypted === "string" && record.username_encrypted) {
    normalized.username_encrypted = record.username_encrypted;
    normalized.username_encrypted_key =
      typeof record.username_encrypted_key === "string" && record.username_encrypted_key
        ? record.username_encrypted_key
        : DEFAULT_TENANT_KEY_ID;
  }
  if (typeof record.addedAt === "number") normalized.addedAt = record.addedAt;
  return normalized;
}

/** A {@link GrantKeyPair} reduced to the fields stored on the document. */
function toStoredKeyPair(pair: GrantKeyPair): Record<string, unknown> {
  const stored: Record<string, unknown> = {
    signingPublicKey: pair.signingPublicKey,
    encryptionPublicKey: pair.encryptionPublicKey,
  };
  if (pair.label) stored.label = pair.label;
  if (typeof pair.addedAt === "number") stored.addedAt = pair.addedAt;
  return stored;
}

function administratorEntries(data: TenantSetupData): TenantAdministratorData[] {
  if (!Array.isArray(data.administrators)) return [];
  return data.administrators
    .map(normalizeAdministratorEntry)
    .filter((entry): entry is TenantAdministratorData => entry !== null);
}

/**
 * The tenant's administrators from the `tenantsetup` document, oldest first.
 * Names need the tenant `default` key; entries whose name cannot be decrypted
 * are still returned (with their key pairs) so callers can at least match a
 * signing key. Returns an empty list for tenants created before this field.
 */
export async function readTenantSetupAdministrators(
  directoryDb: MindooDB,
  tenant: MindooTenant,
): Promise<TenantAdministrator[]> {
  let entries: TenantAdministratorData[] = [];
  try {
    const doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
    entries = administratorEntries(doc.getData() as TenantSetupData);
  } catch {
    return [];
  }

  const administrators: TenantAdministrator[] = [];
  for (const entry of entries) {
    const decrypted = await decryptEncryptedField(
      tenant,
      entry as unknown as Record<string, unknown>,
      "username_encrypted",
    );
    const username = typeof decrypted === "string" ? decrypted.trim() : "";
    administrators.push({
      ...(username ? { username } : {}),
      keyPairs: extractKeyPairs(entry as unknown as Record<string, unknown>),
      ...(typeof entry.addedAt === "number" ? { addedAt: entry.addedAt } : {}),
    });
  }
  return administrators;
}

/**
 * Record an administrator on the `tenantsetup` document: its name
 * field-encrypted under `default` plus its device key pairs. Must be signed
 * with the tenant admin signing key.
 *
 * An entry for the same admin — matched by name, or by sharing a signing key
 * when the name is unreadable — is updated in place and has its key pairs
 * merged, so passing only a new pair enrolls another device of an admin that is
 * already listed. Otherwise a new entry is appended. Idempotent when called
 * again with the same name and keys.
 */
export async function writeTenantSetupAdministrator(
  directoryDb: MindooDB,
  administrator: { username: string; keyPairs: GrantKeyPair[] },
  adminSigningKeyPair: SigningKeyPair,
  adminSigningKeyPassword: string,
  tenant: MindooTenant,
): Promise<void> {
  const username = administrator.username.trim();
  if (!username) {
    throw new Error("Administrator username must be a non-empty string");
  }
  const incoming = administrator.keyPairs.filter(
    (pair) => pair.signingPublicKey.trim().length > 0,
  );
  if (incoming.length === 0) {
    throw new Error("Administrator must have at least one signing key");
  }

  const usernameEncrypted = await encryptUnderDefaultKey(tenant, username);
  const now = semanticNow();
  // Names are only comparable after decryption, which cannot happen inside the
  // synchronous document mutation below.
  const existingIndex = (await readTenantSetupAdministrators(directoryDb, tenant)).findIndex(
    (entry) =>
      entry.username
        ? usernamesEqual(entry.username, username)
        : entry.keyPairs.some((pair) =>
            incoming.some((candidate) =>
              signingKeysEqual(pair.signingPublicKey, candidate.signingPublicKey),
            ),
          ),
  );

  await changeTenantSetup(directoryDb, adminSigningKeyPair, adminSigningKeyPassword, (data) => {
    const entries = administratorEntries(data);
    const target: TenantAdministratorData =
      existingIndex >= 0 ? entries[existingIndex] ?? { addedAt: now } : { addedAt: now };
    const merged = mergeKeyPairs(
      extractKeyPairs(target as unknown as Record<string, unknown>),
      incoming.map((pair) => ({ ...pair, addedAt: pair.addedAt ?? now })),
    );

    const next: TenantAdministratorData = {
      username_encrypted: usernameEncrypted,
      username_encrypted_key: DEFAULT_TENANT_KEY_ID,
      userKeyPairs: merged.map(toStoredKeyPair),
      addedAt: typeof target.addedAt === "number" ? target.addedAt : now,
    };

    if (existingIndex >= 0 && existingIndex < entries.length) {
      entries[existingIndex] = next;
    } else {
      entries.push(next);
    }
    data.administrators = entries;
  });
}

/**
 * Record an administrator only when it is missing from `tenantsetup`, and
 * report whether a write happened. Tenants created before the
 * `administrators` field have no entry at all, and a grant is a natural moment
 * to heal that: the admin proves its identity and its keys there anyway. The
 * check keeps repeated grants from appending a no-op revision to the
 * append-only store.
 */
export async function ensureTenantSetupAdministrator(
  directoryDb: MindooDB,
  administrator: { username: string; keyPairs: GrantKeyPair[] },
  adminSigningKeyPair: SigningKeyPair,
  adminSigningKeyPassword: string,
  tenant: MindooTenant,
): Promise<boolean> {
  const username = administrator.username.trim();
  if (!username) {
    throw new Error("Administrator username must be a non-empty string");
  }

  const recorded = await readTenantSetupAdministrators(directoryDb, tenant);
  const isComplete = recorded.some(
    (entry) =>
      entry.username !== undefined &&
      usernamesEqual(entry.username, username) &&
      administrator.keyPairs.every((candidate) =>
        entry.keyPairs.some((pair) =>
          signingKeysEqual(pair.signingPublicKey, candidate.signingPublicKey),
        ),
      ),
  );
  if (isComplete) return false;

  await writeTenantSetupAdministrator(
    directoryDb,
    administrator,
    adminSigningKeyPair,
    adminSigningKeyPassword,
    tenant,
  );
  return true;
}
