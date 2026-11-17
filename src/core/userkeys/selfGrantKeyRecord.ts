import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import type { MindooDB, MindooDoc } from "../types";
import { PUBLIC_INFOS_KEY_ID } from "../types";
import { normalizePublicKeyPem } from "./fingerprint";
import { signEd25519, verifyEd25519 } from "./generationSignature";
import { USERKEY_FORM } from "./types";

/**
 * Published self-grant keys (docs/userkeys.md §9.4).
 *
 * To let a person certify their own devices, the admin names the person's
 * device self-grant key in their grant (`setDeviceSelfGrant`). New members
 * bring that key in their join request. People who joined before had no way
 * to hand it over except copying it to the admin by hand.
 *
 * Instead, each of their devices that holds a self-grant key publishes the
 * public half in a personal `userdirectory` document `sgk_…`. When the admin
 * allows device self-grant, the client reads the person's record and puts the
 * key on the grant.
 *
 * Records are written once, in their `doc_create`, and never changed: a
 * device whose key changes deletes its old record and creates a new one. Two
 * replicas of one device therefore never edit the same document concurrently,
 * so there is no merge that could pair one write's signature with another
 * write's key.
 *
 * The record is a claim, so readers verify all of:
 *
 * 1. the `doc_create` entry was signed by the device signing key the payload names,
 * 2. that key is an active device on the person's grant (the caller passes those keys), and
 * 3. the payload carries a signature made with the self-grant private key
 *    (proof of possession), so a device cannot name a key it does not hold.
 *
 * Encrypted with `$publicinfos` like device certificates: the grant that ends
 * up carrying the key is readable for the server as well, so there is nothing
 * to hide here.
 */

export const SELF_GRANT_KEY_DOC_ID_PREFIX = "sgk_";
export const SELF_GRANT_KEY_TYPE = "selfgrantkey";
export const SELF_GRANT_KEY_SCHEMA_VERSION = 1;
const SELF_GRANT_KEY_MESSAGE_TAG = "mindoodb-self-grant-key-v1";

export interface SelfGrantKeyRecordPayload {
  form: typeof USERKEY_FORM;
  type: typeof SELF_GRANT_KEY_TYPE;
  schemaVersion: number;
  /** Signing key (PEM) of the device that publishes the record. */
  deviceSigningPublicKey: string;
  /** Public half (PEM) of the self-grant key this device holds. */
  selfGrantPublicKey: string;
  publishedAt: number;
  /** Base64 Ed25519 signature with the self-grant key over {@link selfGrantKeyRecordMessage}. */
  signature: string;
}

/** A record that passed {@link verifySelfGrantKeyRecord}. */
export interface SelfGrantKeyRecord {
  docId: string;
  deviceSigningPublicKey: string;
  selfGrantPublicKey: string;
  publishedAt: number;
}

export function isSelfGrantKeyRecordDocId(docId: string): boolean {
  return docId.startsWith(SELF_GRANT_KEY_DOC_ID_PREFIX);
}

/** What the proof of possession signs: the tenant, the device and the key. */
export function selfGrantKeyRecordMessage(
  tenantId: string,
  record: Pick<SelfGrantKeyRecordPayload, "deviceSigningPublicKey" | "selfGrantPublicKey">,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      SELF_GRANT_KEY_MESSAGE_TAG,
      tenantId,
      normalizePublicKeyPem(record.deviceSigningPublicKey),
      normalizePublicKeyPem(record.selfGrantPublicKey),
    ]),
  );
}

export function asSelfGrantKeyRecord(data: unknown): SelfGrantKeyRecordPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.form !== USERKEY_FORM || d.type !== SELF_GRANT_KEY_TYPE) return null;
  for (const key of ["deviceSigningPublicKey", "selfGrantPublicKey", "signature"]) {
    if (typeof d[key] !== "string" || !(d[key] as string)) return null;
  }
  if (typeof d.publishedAt !== "number" || !Number.isFinite(d.publishedAt)) return null;
  return d as unknown as SelfGrantKeyRecordPayload;
}

/**
 * Check one record. Returns it when steps 1 and 3 of the module docs hold;
 * step 2 (whose grant the device is on) is up to the caller.
 */
export async function verifySelfGrantKeyRecord(input: {
  db: MindooDB;
  crypto: CryptoAdapter;
  tenantId: string;
  doc: MindooDoc;
}): Promise<SelfGrantKeyRecord | null> {
  if (input.doc.isDeleted()) return null;
  const record = asSelfGrantKeyRecord(input.doc.getData());
  if (!record) return null;
  const docId = input.doc.getId();
  const creator = await resolveCreateSigner(input.db, docId);
  if (!creator || normalizePublicKeyPem(creator) !== normalizePublicKeyPem(record.deviceSigningPublicKey)) {
    return null;
  }
  const ok = await verifyEd25519(
    input.crypto,
    record.selfGrantPublicKey,
    record.signature,
    selfGrantKeyRecordMessage(input.tenantId, record),
  ).catch(() => false);
  if (!ok) return null;
  return {
    docId,
    deviceSigningPublicKey: record.deviceSigningPublicKey,
    selfGrantPublicKey: record.selfGrantPublicKey,
    publishedAt: record.publishedAt,
  };
}

/** Every verified record in this replica, optionally only those of the given devices. */
export async function listSelfGrantKeyRecords(input: {
  db: MindooDB;
  crypto: CryptoAdapter;
  tenantId: string;
  deviceSigningPublicKeys?: string[];
}): Promise<SelfGrantKeyRecord[]> {
  const wanted = input.deviceSigningPublicKeys
    ? new Set(input.deviceSigningPublicKeys.map(normalizePublicKeyPem))
    : null;
  const records: SelfGrantKeyRecord[] = [];
  // `idPrefix` matching is boundary-aware: "sgk" matches `sgk_…` only.
  for (const docId of await input.db.getAllDocumentIds({ idPrefix: "sgk" })) {
    if (!isSelfGrantKeyRecordDocId(docId)) continue;
    const doc = await input.db.getDocument(docId).catch(() => null);
    if (!doc) continue;
    const record = await verifySelfGrantKeyRecord({ db: input.db, crypto: input.crypto, tenantId: input.tenantId, doc });
    if (!record) continue;
    if (wanted && !wanted.has(normalizePublicKeyPem(record.deviceSigningPublicKey))) continue;
    records.push(record);
  }
  return records;
}

/**
 * The newest verified record published by one of `deviceSigningPublicKeys`
 * (the person's active devices), or `null`.
 */
export async function findSelfGrantKeyRecord(input: {
  db: MindooDB;
  crypto: CryptoAdapter;
  tenantId: string;
  deviceSigningPublicKeys: string[];
}): Promise<SelfGrantKeyRecord | null> {
  if (input.deviceSigningPublicKeys.length === 0) return null;
  const records = await listSelfGrantKeyRecords(input);
  return records.reduce<SelfGrantKeyRecord | null>(
    (newest, record) => (!newest || record.publishedAt > newest.publishedAt ? record : newest),
    null,
  );
}

/**
 * Publish this device's key, unless a verified record of it exists already.
 * Records of this device naming another key are deleted first. Costs one
 * create per device and key, ever.
 */
export async function publishSelfGrantKeyRecord(input: {
  db: MindooDB;
  crypto: CryptoAdapter;
  tenantId: string;
  deviceSigningPublicKey: string;
  selfGrant: { privateKey: CryptoKey; publicKeyPem: string };
}): Promise<{ docId: string; wrote: boolean }> {
  const own = await listSelfGrantKeyRecords({
    db: input.db,
    crypto: input.crypto,
    tenantId: input.tenantId,
    deviceSigningPublicKeys: [input.deviceSigningPublicKey],
  });
  const current = own.find(
    (record) => normalizePublicKeyPem(record.selfGrantPublicKey) === normalizePublicKeyPem(input.selfGrant.publicKeyPem),
  );
  if (current) return { docId: current.docId, wrote: false };
  for (const outdated of own) {
    await input.db.deleteDocument(outdated.docId).catch(() => {
      // Gone already; the newest record wins on read anyway.
    });
  }
  const unsigned = {
    deviceSigningPublicKey: input.deviceSigningPublicKey,
    selfGrantPublicKey: input.selfGrant.publicKeyPem,
  };
  const signature = await signEd25519(
    input.crypto,
    input.selfGrant.privateKey,
    selfGrantKeyRecordMessage(input.tenantId, unsigned),
  );
  const payload: SelfGrantKeyRecordPayload = {
    form: USERKEY_FORM,
    type: SELF_GRANT_KEY_TYPE,
    schemaVersion: SELF_GRANT_KEY_SCHEMA_VERSION,
    ...unsigned,
    publishedAt: Date.now(),
    signature,
  };
  const doc = await input.db.createDocument({
    idPrefix: "sgk",
    decryptionKeyId: PUBLIC_INFOS_KEY_ID,
    initialValues: payload as unknown as Record<string, unknown>,
  });
  return { docId: doc.getId(), wrote: true };
}

/** Signing key that wrote the `doc_create` entry, or null when it is not here yet. */
async function resolveCreateSigner(db: MindooDB, docId: string): Promise<string | null> {
  try {
    const page = await db.getDocumentHistoryPage(docId, { limit: 10 });
    const create = page.entries.find((entry) => entry.entryType === "doc_create");
    return create?.changeCreatedByPublicKey ?? null;
  } catch {
    return null;
  }
}
