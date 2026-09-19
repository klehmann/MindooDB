/**
 * Peer-device records: how one device advertises its Iroh endpoint id to the
 * other members of a tenant.
 *
 * A device publishes one `dev_<fingerprint>` document into `userdirectory`,
 * encrypted with the tenant `default` key. That placement is deliberate:
 *
 * - **`userdirectory`, not `grantaccess`.** Every member already replicates
 *   `userdirectory`, and a device can write its own record there without an
 *   administrator approving anything.
 * - **`default`, not `$publicinfos`.** The hoster holds the `$publicinfos`
 *   key, and who talks to whom over Iroh is none of the hoster's business.
 *   `default` keeps the record readable for every tenant member and opaque to
 *   the server.
 * - **`dev_` prefix.** That makes it a *personal document* (see
 *   {@link PERSONAL_DOC_ID_PREFIXES}), so the write invariant lets its creator
 *   — and only its creator — change and delete it.
 *
 * ## Why records must be verified on read
 *
 * Any tenant member can write a `dev_` document holding any endpoint id they
 * like. The doc id and payload are therefore claims, not facts.
 * {@link verifyPeerDeviceRecord} only accepts a record when all three hold:
 *
 * 1. the doc id is the fingerprint of the `signingPublicKey` in the payload,
 * 2. the `doc_create` entry was signed by exactly that key, and
 * 3. that key is an active (non-revoked) grant in the tenant.
 *
 * Together these mean a record can only be published by the device that owns
 * the signing key it names, so nobody can put their own endpoint id under
 * someone else's device.
 *
 * **Known v1 gap — id squatting.** A member can create `dev_<someone else's
 * fingerprint>` before that device does. The squatted record fails step 2 and
 * is discarded, so it cannot impersonate anyone; but the real device then
 * cannot create its own record under that id and stays invisible to the
 * picker. Detect it by the record being present yet unverifiable.
 */

import { DEFAULT_TENANT_KEY_ID } from "../types";
import type { MindooDB, MindooDoc, SigningKeyPair } from "../types";
import { fingerprintPublicKeyPem } from "../userkeys/fingerprint";

export const PEER_DEVICE_DOC_ID_PREFIX = "dev_";
export const PEER_DEVICE_FORM = "userdirectory";
export const PEER_DEVICE_TYPE = "peerdevice";
export const PEER_DEVICE_SCHEMA_VERSION = 1;

/** Payload of a `dev_` document. Encrypted with {@link DEFAULT_TENANT_KEY_ID}. */
export interface PeerDeviceDocumentPayload {
  form: typeof PEER_DEVICE_FORM;
  type: typeof PEER_DEVICE_TYPE;
  schemaVersion: number;
  /**
   * 64-char lowercase hex Iroh endpoint id of this device. Peers dial this
   * directly; the pkarr address lookup resolves the current relay, so the
   * value stays valid when the device changes networks.
   */
  irohEndpointId: string;
  /**
   * Signing public key (PEM) of the device that owns this record. The whole
   * verification chain hangs off this field.
   */
  signingPublicKey: string;
  /** Human label shown in the peer picker, e.g. "Laptop (office)". */
  label?: string;
  updatedAt: number;
}

/** A record that passed {@link verifyPeerDeviceRecord}. */
export interface PeerDeviceRecord {
  docId: string;
  irohEndpointId: string;
  signingPublicKey: string;
  /** Fingerprint of {@link signingPublicKey}, colon-separated hex. */
  signingKeyFingerprint: string;
  label?: string;
  updatedAt: number;
}

/** The directory calls a peer-device record needs to verify a claim. */
export interface PeerDeviceDirectory {
  /** True when the key belongs to an active, non-revoked grant. */
  validatePublicSigningKey(publicKey: string, opts?: { forceRefresh?: boolean }): Promise<boolean>;
}

/**
 * Deterministic document id for a device, derived from its signing key
 * fingerprint.
 *
 * Deterministic so a device republishing after a reload updates its record
 * instead of accumulating a new one per session. Colons are stripped because
 * custom ids must match `^[a-z][a-z0-9_]*$` (`CUSTOM_DOC_ID_REGEX`).
 */
export function peerDeviceDocumentId(signingKeyFingerprint: string): string {
  return `${PEER_DEVICE_DOC_ID_PREFIX}${signingKeyFingerprint.replace(/:/g, "").toLowerCase()}`;
}

export function isPeerDeviceDocId(docId: string): boolean {
  return docId.startsWith(PEER_DEVICE_DOC_ID_PREFIX);
}

/**
 * Publish (or refresh) this device's record.
 *
 * Idempotent: the id is derived from the device's own signing key, so calling
 * this on every unlock keeps one record per device and updates the endpoint id
 * and label in place.
 *
 * Note this does *not* pass `assumeUniqueId`. The id is deterministic rather
 * than random, so two replicas creating it concurrently must share Automerge
 * ancestry in order to converge instead of forking. That code path also
 * forbids `initialValues`, which is why the payload is written with a
 * follow-up `changeDoc` — the same call that refreshes an existing record.
 */
export async function publishPeerDeviceRecord(input: {
  db: MindooDB;
  /** Signing public key (PEM) of this device — must match the signing identity writing the document. */
  signingPublicKey: string;
  irohEndpointId: string;
  label?: string;
  subtle: SubtleCrypto;
  signingKeyPair?: SigningKeyPair;
  signingKeyPassword?: string;
}): Promise<MindooDoc> {
  const fingerprint = await fingerprintPublicKeyPem(input.signingPublicKey, input.subtle);
  const docId = peerDeviceDocumentId(fingerprint);
  const doc =
    (await input.db.getDocument(docId).catch(() => null)) ??
    (await input.db.createDocument({
      id: docId,
      decryptionKeyId: DEFAULT_TENANT_KEY_ID,
      signingKeyPair: input.signingKeyPair,
      signingKeyPassword: input.signingKeyPassword,
    }));

  const label = input.label ?? "";
  const current = doc.getData() as unknown as Partial<PeerDeviceDocumentPayload>;
  const unchanged =
    current.type === PEER_DEVICE_TYPE &&
    current.schemaVersion === PEER_DEVICE_SCHEMA_VERSION &&
    current.irohEndpointId === input.irohEndpointId &&
    current.signingPublicKey === input.signingPublicKey &&
    (current.label ?? "") === label;

  // Callers republish on every unlock and after every `userdirectory` sync.
  // Rewriting `updatedAt` unconditionally would append an entry each time,
  // and since that entry syncs and triggers the next refresh, the two halves
  // would keep feeding each other. Only a real change is worth a write.
  if (unchanged) {
    return doc;
  }

  await input.db.changeDoc(doc, (editable) => {
    const data = editable.getData() as unknown as Record<string, unknown>;
    data.form = PEER_DEVICE_FORM;
    data.type = PEER_DEVICE_TYPE;
    data.schemaVersion = PEER_DEVICE_SCHEMA_VERSION;
    data.irohEndpointId = input.irohEndpointId;
    data.signingPublicKey = input.signingPublicKey;
    data.label = label;
    data.updatedAt = Date.now();
  });
  return doc;
}

/** Withdraw this device's record, e.g. when signing out of the tenant. */
export async function removePeerDeviceRecord(input: {
  db: MindooDB;
  signingPublicKey: string;
  subtle: SubtleCrypto;
}): Promise<void> {
  const fingerprint = await fingerprintPublicKeyPem(input.signingPublicKey, input.subtle);
  const docId = peerDeviceDocumentId(fingerprint);
  await input.db.deleteDocument(docId).catch(() => {
    // Already gone, or never published from this device.
  });
}

/**
 * Check one record's claim. Returns the verified record, or `null` when any
 * step of the chain described in the module docs fails.
 */
export async function verifyPeerDeviceRecord(input: {
  db: MindooDB;
  directory: PeerDeviceDirectory;
  doc: MindooDoc;
  subtle: SubtleCrypto;
}): Promise<PeerDeviceRecord | null> {
  const docId = input.doc.getId();
  const data = input.doc.getData() as unknown as Partial<PeerDeviceDocumentPayload>;
  const signingPublicKey = typeof data.signingPublicKey === "string" ? data.signingPublicKey : "";
  const irohEndpointId =
    typeof data.irohEndpointId === "string" ? data.irohEndpointId.trim().toLowerCase() : "";
  if (data.type !== PEER_DEVICE_TYPE || !signingPublicKey || !/^[0-9a-f]{64}$/.test(irohEndpointId)) {
    return null;
  }

  // 1. The id must be the fingerprint of the key the payload names, so a
  //    record cannot sit under a device id it does not belong to.
  const fingerprint = await fingerprintPublicKeyPem(signingPublicKey, input.subtle);
  if (peerDeviceDocumentId(fingerprint) !== docId) {
    return null;
  }

  // 2. That key must be the one that actually created the document. Without
  //    this, any member could publish a record naming someone else's key.
  const creatorKey = await resolveCreateSigner(input.db, docId);
  if (!creatorKey || normalizePem(creatorKey) !== normalizePem(signingPublicKey)) {
    return null;
  }

  // 3. And it must still be a live grant, so revoked devices drop out.
  if (!(await input.directory.validatePublicSigningKey(signingPublicKey).catch(() => false))) {
    return null;
  }

  return {
    docId,
    irohEndpointId,
    signingPublicKey,
    signingKeyFingerprint: fingerprint,
    label: typeof data.label === "string" && data.label ? data.label : undefined,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

/**
 * Every verified peer-device record in this `userdirectory` replica.
 *
 * Requires the tenant `default` key to be unlocked; records that cannot be
 * decrypted are simply absent. Unverifiable records are skipped silently —
 * they are the expected shape of an attack, not an error to surface.
 */
export async function listPeerDeviceRecords(input: {
  db: MindooDB;
  directory: PeerDeviceDirectory;
  subtle: SubtleCrypto;
  /** Endpoint id of the local device, excluded from the result. */
  excludeEndpointId?: string;
}): Promise<PeerDeviceRecord[]> {
  // `idPrefix` matching is boundary-aware: "dev" matches `dev_…`, not `device…`.
  const docIds = await input.db.getAllDocumentIds({ idPrefix: "dev" });
  const records: PeerDeviceRecord[] = [];
  for (const docId of docIds) {
    if (!isPeerDeviceDocId(docId)) {
      continue;
    }
    const doc = await input.db.getDocument(docId).catch(() => null);
    if (!doc) {
      continue;
    }
    const record = await verifyPeerDeviceRecord({
      db: input.db,
      directory: input.directory,
      doc,
      subtle: input.subtle,
    });
    if (record && record.irohEndpointId !== input.excludeEndpointId) {
      records.push(record);
    }
  }
  return records;
}

/** Signing key that wrote the `doc_create` entry, or null when it is not here yet. */
async function resolveCreateSigner(db: MindooDB, docId: string): Promise<string | null> {
  try {
    // History is ordered causally, so `doc_create` is on the first page.
    const page = await db.getDocumentHistoryPage(docId, { limit: 10 });
    const create = page.entries.find((entry) => entry.entryType === "doc_create");
    return create?.changeCreatedByPublicKey ?? null;
  } catch {
    return null;
  }
}

/** PEM formatting varies by transport; compare the key material, not the wrapping. */
function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, "");
}
