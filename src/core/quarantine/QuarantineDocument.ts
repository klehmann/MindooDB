/**
 * Quarantine records: how a device remembers a write the server turned away,
 * so it can be found again and offered again.
 *
 * A device that pushes an entry and gets a `"policy"` rejection back is holding
 * something awkward: an entry that was legitimate when it was written, is
 * cryptographically sound, and is refused only because a right was withdrawn in
 * the meantime. It must not be dropped — the right may come back — and it must
 * not block the database's push either. So the push moves on and leaves a
 * record here.
 *
 * This matters most for entries that arrived over peer-to-peer sync: a device
 * can hold, and have already merged, a change it did not write itself and whose
 * author has since lost the right to write it. Without a record, the refusal
 * would be a line in a log that disappears on reload.
 *
 * ## Why `userdirectory`
 *
 * The record deliberately does *not* live in the database it is about. The
 * whole reason it exists is that someone lost their write right there, so
 * writing the record there would earn the same refusal as the entry it
 * documents. `userdirectory` is a database every member can write their own
 * documents in without an administrator approving anything.
 *
 * - **`qtn_` prefix** — makes it a *personal document* (see
 *   {@link PERSONAL_DOC_ID_PREFIXES}), so the write invariant lets its creator
 *   change and delete it, and the admin delete it.
 * - **`default` key, not `$publicinfos`** — the hoster holds the
 *   `$publicinfos` key, and which of a tenant's writes were refused is none of
 *   the hoster's business. `default` keeps it readable for every member, so it
 *   can serve as an audit trail, and opaque to the server.
 *
 * ## One record per author, database, document and class
 *
 * The id is derived rather than random, which makes recording idempotent: a
 * retry that fails the same way updates the record in place instead of adding
 * another. A cascade of refused entries on one document therefore collapses
 * into one record holding a capped list of entry ids.
 *
 * The **author's key fingerprint is part of the derivation**, and that is
 * load-bearing rather than decorative. Without it, two members refused on the
 * same document for the same reason would derive the same id — and since the
 * personal-document invariant only lets the *creator* write a document, the
 * second member's record would be refused by the very invariant that is
 * supposed to protect it. Folding the author in makes id and ownership agree.
 *
 * ## Why records must be verified on read
 *
 * Any tenant member can write a `qtn_` document claiming anything. Since these
 * records say "this person tried to write something they were not allowed to
 * write", an unverified one is a way to put words in someone else's mouth.
 * {@link verifyQuarantineRecord} accepts a record only when:
 *
 * 1. the doc id is derived from the payload's own fields, including the
 *    fingerprint of the `signingPublicKey` it names,
 * 2. the `doc_create` entry was signed by exactly that key, and
 * 3. that key is an active (non-revoked) grant in the tenant.
 *
 * **Known limit — a record is evidence of an honest client, not of an honest
 * one's absence.** Nothing compels a device to write a record, so the absence
 * of one proves nothing. Like the `dev_` records, this is useful for auditing
 * cooperating devices, not for catching a malicious one.
 */

import { DEFAULT_TENANT_KEY_ID } from "../types";
import type { MindooDB, MindooDoc, SigningKeyPair } from "../types";
import type { PutRejectionClass } from "../appendonlystores/types";
import { fingerprintPublicKeyPem } from "../userkeys/fingerprint";

export const QUARANTINE_DOC_ID_PREFIX = "qtn_";
export const QUARANTINE_FORM = "userdirectory";
export const QUARANTINE_TYPE = "quarantine";
export const QUARANTINE_SCHEMA_VERSION = 1;

/**
 * How many entry ids one record carries.
 *
 * A quarantined write usually drags its causal dependents along, so one
 * refusal can mean a long list. The list is for finding the entries again, and
 * a bounded one does that just as well while keeping the record — which syncs
 * to every member of the tenant — from growing without limit.
 */
export const MAX_QUARANTINED_ENTRY_IDS = 200;

/** Payload of a `qtn_` document. Encrypted with {@link DEFAULT_TENANT_KEY_ID}. */
export interface QuarantineDocumentPayload {
  form: typeof QUARANTINE_FORM;
  type: typeof QUARANTINE_TYPE;
  schemaVersion: number;
  /**
   * Signing public key (PEM) of the device that recorded this. The whole
   * verification chain hangs off this field.
   */
  signingPublicKey: string;
  /** Database the refused entries belong to. Not `userdirectory` itself. */
  dbid: string;
  /** Document the refused entries belong to. */
  quarantinedDocId: string;
  /** Why the target refused them. */
  rejectionClass: PutRejectionClass;
  /** The target's own wording, kept verbatim for the audit view. */
  reason: string;
  /** Refused entry ids, capped at {@link MAX_QUARANTINED_ENTRY_IDS}. */
  entryIds: string[];
  /** How many refused entries did not fit into {@link entryIds}. */
  omittedEntryCount?: number;
  firstSeenAt: number;
  updatedAt: number;
}

/** A record that passed {@link verifyQuarantineRecord}. */
export interface QuarantineRecordDoc {
  docId: string;
  signingPublicKey: string;
  /** Fingerprint of {@link signingPublicKey}, colon-separated hex. */
  signingKeyFingerprint: string;
  dbid: string;
  quarantinedDocId: string;
  rejectionClass: PutRejectionClass;
  reason: string;
  entryIds: string[];
  omittedEntryCount: number;
  firstSeenAt: number;
  updatedAt: number;
}

/** The directory calls a quarantine record needs to verify a claim. */
export interface QuarantineDirectory {
  /** True when the key belongs to an active, non-revoked grant. */
  validatePublicSigningKey(publicKey: string, opts?: { forceRefresh?: boolean }): Promise<boolean>;
}

/** What identifies one quarantine record. */
export interface QuarantineRecordKey {
  /** Fingerprint of the recording device's signing key, colon-separated hex. */
  signingKeyFingerprint: string;
  dbid: string;
  quarantinedDocId: string;
  rejectionClass: PutRejectionClass;
}

/** Is this a quarantine record id? */
export function isQuarantineDocId(docId: string | undefined | null): boolean {
  return typeof docId === "string" && docId.startsWith(QUARANTINE_DOC_ID_PREFIX);
}

/**
 * Deterministic document id for one (author, database, document, class).
 *
 * Deterministic so that recording the same refusal again updates the record
 * instead of accumulating one per attempt. Hashed rather than concatenated
 * because custom ids must match `^[a-z][a-z0-9_]*$` (`CUSTOM_DOC_ID_REGEX`) and
 * a document id can hold anything.
 */
export async function quarantineDocumentId(
  key: QuarantineRecordKey,
  subtle: SubtleCrypto,
): Promise<string> {
  const material = [
    key.signingKeyFingerprint.replace(/:/g, "").toLowerCase(),
    key.dbid,
    key.quarantinedDocId,
    key.rejectionClass,
  ].join("\u0000");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${QUARANTINE_DOC_ID_PREFIX}${hex.slice(0, 40)}`;
}

/** Thrown when a caller tries to record a quarantine about a quarantine record. */
export class QuarantineRecursionError extends Error {
  constructor(docId: string) {
    super(
      `Refusing to record a quarantine for ${docId}: quarantine records are not themselves quarantined`,
    );
    this.name = "QuarantineRecursionError";
  }
}

/**
 * Record (or extend) the quarantine for one document's refused entries.
 *
 * Idempotent in the sense that matters: calling it again with entry ids the
 * record already holds writes nothing at all. That is not an optimisation. A
 * write here appends an entry, which syncs, which can trigger the next push,
 * which would record again — so a record that rewrote itself on every attempt
 * would feed a loop the user pays for in bandwidth and history size.
 *
 * @throws QuarantineRecursionError when asked to record a `qtn_` document,
 *   which would let one refusal generate an unbounded chain of records.
 */
export async function recordPushQuarantine(input: {
  /** The tenant's `userdirectory`, not the database the entries belong to. */
  db: MindooDB;
  /** Signing public key (PEM) of this device — must match the identity writing the document. */
  signingPublicKey: string;
  dbid: string;
  quarantinedDocId: string;
  rejectionClass: PutRejectionClass;
  reason: string;
  entryIds: readonly string[];
  subtle: SubtleCrypto;
  signingKeyPair?: SigningKeyPair;
  signingKeyPassword?: string;
  now?: number;
}): Promise<MindooDoc> {
  if (isQuarantineDocId(input.quarantinedDocId)) {
    throw new QuarantineRecursionError(input.quarantinedDocId);
  }

  const fingerprint = await fingerprintPublicKeyPem(input.signingPublicKey, input.subtle);
  const docId = await quarantineDocumentId(
    {
      signingKeyFingerprint: fingerprint,
      dbid: input.dbid,
      quarantinedDocId: input.quarantinedDocId,
      rejectionClass: input.rejectionClass,
    },
    input.subtle,
  );

  const doc =
    (await input.db.getDocument(docId).catch(() => null)) ??
    // Not `assumeUniqueId`: the id is derived rather than random, so two
    // replicas creating it concurrently must share Automerge ancestry to
    // converge instead of forking. That path also forbids `initialValues`,
    // which is why the payload goes in through `changeDoc` below — the same
    // call that extends an existing record.
    (await input.db.createDocument({
      id: docId,
      decryptionKeyId: DEFAULT_TENANT_KEY_ID,
      signingKeyPair: input.signingKeyPair,
      signingKeyPassword: input.signingKeyPassword,
    }));

  const current = doc.getData() as unknown as Partial<QuarantineDocumentPayload>;
  const known = new Set(Array.isArray(current.entryIds) ? current.entryIds : []);
  const added = input.entryIds.filter((id) => !known.has(id));
  const alreadyDescribed =
    current.type === QUARANTINE_TYPE &&
    current.schemaVersion === QUARANTINE_SCHEMA_VERSION &&
    current.signingPublicKey === input.signingPublicKey &&
    current.dbid === input.dbid &&
    current.quarantinedDocId === input.quarantinedDocId &&
    current.rejectionClass === input.rejectionClass &&
    current.reason === input.reason;

  if (alreadyDescribed && added.length === 0) {
    return doc;
  }

  const merged = [...known, ...added];
  const kept = merged.slice(0, MAX_QUARANTINED_ENTRY_IDS);
  const omitted = (current.omittedEntryCount ?? 0) + (merged.length - kept.length);
  const now = input.now ?? Date.now();

  await input.db.changeDoc(doc, (editable) => {
    const data = editable.getData() as unknown as Record<string, unknown>;
    data.form = QUARANTINE_FORM;
    data.type = QUARANTINE_TYPE;
    data.schemaVersion = QUARANTINE_SCHEMA_VERSION;
    data.signingPublicKey = input.signingPublicKey;
    data.dbid = input.dbid;
    data.quarantinedDocId = input.quarantinedDocId;
    data.rejectionClass = input.rejectionClass;
    data.reason = input.reason;
    data.entryIds = kept;
    if (omitted > 0) {
      data.omittedEntryCount = omitted;
    }
    data.firstSeenAt = typeof current.firstSeenAt === "number" ? current.firstSeenAt : now;
    data.updatedAt = now;
  });
  return doc;
}

/**
 * Withdraw a record, because the entries were finally accepted or the user gave
 * up on them.
 */
export async function clearQuarantineRecord(input: {
  db: MindooDB;
  key: QuarantineRecordKey;
  subtle: SubtleCrypto;
}): Promise<void> {
  const docId = await quarantineDocumentId(input.key, input.subtle);
  await input.db.deleteDocument(docId).catch(() => {
    // Already gone, or never recorded from this device.
  });
}

/**
 * Check one record's claim. Returns the verified record, or `null` when any step
 * of the chain described in the module docs fails.
 */
export async function verifyQuarantineRecord(input: {
  db: MindooDB;
  directory: QuarantineDirectory;
  doc: MindooDoc;
  subtle: SubtleCrypto;
}): Promise<QuarantineRecordDoc | null> {
  const docId = input.doc.getId();
  const data = input.doc.getData() as unknown as Partial<QuarantineDocumentPayload>;
  const signingPublicKey = typeof data.signingPublicKey === "string" ? data.signingPublicKey : "";
  const dbid = typeof data.dbid === "string" ? data.dbid : "";
  const quarantinedDocId =
    typeof data.quarantinedDocId === "string" ? data.quarantinedDocId : "";
  const rejectionClass = data.rejectionClass;
  if (
    data.type !== QUARANTINE_TYPE ||
    !signingPublicKey ||
    !dbid ||
    !quarantinedDocId ||
    typeof rejectionClass !== "string"
  ) {
    return null;
  }

  // 1. The id must be derived from the payload's own fields, so a record cannot
  //    sit under an id describing a different author, database or document than
  //    the one it names.
  const fingerprint = await fingerprintPublicKeyPem(signingPublicKey, input.subtle);
  const expectedId = await quarantineDocumentId(
    {
      signingKeyFingerprint: fingerprint,
      dbid,
      quarantinedDocId,
      rejectionClass: rejectionClass as PutRejectionClass,
    },
    input.subtle,
  );
  if (expectedId !== docId) {
    return null;
  }

  // 2. That key must be the one that actually created the document. Without
  //    this, any member could record a refusal in someone else's name.
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
    signingPublicKey,
    signingKeyFingerprint: fingerprint,
    dbid,
    quarantinedDocId,
    rejectionClass: rejectionClass as PutRejectionClass,
    reason: typeof data.reason === "string" ? data.reason : "",
    entryIds: Array.isArray(data.entryIds)
      ? data.entryIds.filter((id): id is string => typeof id === "string")
      : [],
    omittedEntryCount:
      typeof data.omittedEntryCount === "number" ? data.omittedEntryCount : 0,
    firstSeenAt: typeof data.firstSeenAt === "number" ? data.firstSeenAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

/**
 * Every verified quarantine record in this `userdirectory` replica.
 *
 * Requires the tenant `default` key to be unlocked; records that cannot be
 * decrypted are simply absent. Unverifiable records are skipped silently —
 * they are the expected shape of an attack, not an error to surface.
 */
export async function listQuarantineRecords(input: {
  db: MindooDB;
  directory: QuarantineDirectory;
  subtle: SubtleCrypto;
  /** Restrict to one database, e.g. for the sync view of a single database. */
  dbid?: string;
  /** Restrict to records this device wrote itself. */
  signingKeyFingerprint?: string;
}): Promise<QuarantineRecordDoc[]> {
  // `idPrefix` matching is boundary-aware: "qtn" matches `qtn_…`, not `qtnx…`.
  const docIds = await input.db.getAllDocumentIds({ idPrefix: "qtn" });
  const records: QuarantineRecordDoc[] = [];
  for (const docId of docIds) {
    if (!isQuarantineDocId(docId)) {
      continue;
    }
    const doc = await input.db.getDocument(docId).catch(() => null);
    if (!doc) {
      continue;
    }
    const record = await verifyQuarantineRecord({
      db: input.db,
      directory: input.directory,
      doc,
      subtle: input.subtle,
    });
    if (!record) {
      continue;
    }
    if (input.dbid !== undefined && record.dbid !== input.dbid) {
      continue;
    }
    if (
      input.signingKeyFingerprint !== undefined &&
      record.signingKeyFingerprint !== input.signingKeyFingerprint
    ) {
      continue;
    }
    records.push(record);
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
