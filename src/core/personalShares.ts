/**
 * Delegation of personal databases (docs/accesscontrol.md §6.11, "Delegation").
 *
 * A person publishes one record in `userdirectory`, `$publicinfos`-encrypted so
 * the sync server and services such as the mail gateway can read it:
 *
 * - **who may sync** their mailbox, calendar and contacts, and with which right
 *   (the server enforces this), and who may send on their behalf through their
 *   outbox;
 * - **the deposit keys** (userkeys/depositKeys.ts) depositors seal deliveries
 *   to, per personal database.
 *
 * The record says who may sync, not who can decrypt: that is the members of the
 * group documents in those databases. Clients set both together.
 *
 * Records are written once and replaced by newer ones (`revision`), like
 * device certificates: the server reads them from the `doc_create` alone.
 * Only records created by the person whose grant they name count, so nobody
 * can publish delegations for someone else. Ids are generated (`pbox_…`), so
 * nobody can block a person by taking "their" id first.
 */

/** Id prefix of delegation records in `userdirectory`. */
export const PERSONAL_SHARES_DOC_ID_PREFIX = "pbox_";

/** `form` of a delegation record. */
export const PERSONAL_SHARES_FORM = "personalshares";

/**
 * Rights a delegate can hold, per personal database prefix:
 * - `"read"`: pull only (mailbox, calendar, contacts);
 * - `"edit"`: pull and push (mailbox, calendar, contacts);
 * - `"send"`: in the outbox (`mmailout_`), create sending jobs (`mout_…`) that
 *   the mail gateway sends on the owner's behalf; pull to see their status.
 */
export type PersonalShareRight = "read" | "edit" | "send";

/** Which rights make sense for which personal database. */
export const DELEGABLE_PERSONAL_DATABASES: Readonly<Record<string, readonly PersonalShareRight[]>> = {
  mmail_: ["read", "edit"],
  mcal_: ["read", "edit"],
  mcon_: ["read", "edit"],
  mmailout_: ["send"],
};

/** Document ids a delegate with `"send"` may create in an outbox. */
export const SEND_ON_BEHALF_DOC_ID_PREFIXES: readonly string[] = ["mout_"];

export interface PersonalShareDelegate {
  /** Grant (`grantaccess` document id) of the delegate. */
  grant: string;
  /** Right per personal database prefix, e.g. `{ "mmail_": "edit", "mmailout_": "send" }`. */
  rights: Record<string, PersonalShareRight>;
}

export interface PersonalShareDepositKey {
  /** SPKI PEM of the deposit key depositors seal to. */
  publicKey: string;
  /** Its fingerprint (as recipient wraps carry it). */
  fingerprint: string;
}

export interface PersonalSharesRecord {
  form: typeof PERSONAL_SHARES_FORM;
  /** Grant (`grantaccess` document id) of the owner: the `<grantDocId>` of their personal databases. */
  grant: string;
  /** Increases with every new record; the highest wins. */
  revision: number;
  /** Current deposit key per personal database prefix (e.g. `mmail_`, `mcal_`). */
  depositKeys: Record<string, PersonalShareDepositKey>;
  delegates: PersonalShareDelegate[];
  /** When the owner wrote it (ms, client clock; informational). */
  writtenAt: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isObject(value) && "val" in value) return String(value.val);
  return null;
}

/** Throws when `record` is not a well-formed delegation record (used before writing). */
export function validatePersonalShares(record: Omit<PersonalSharesRecord, "form" | "writtenAt" | "revision">): void {
  if (!record.grant || typeof record.grant !== "string") throw new Error("personal shares: grant is required");
  const seen = new Set<string>();
  for (const delegate of record.delegates) {
    if (!delegate.grant || typeof delegate.grant !== "string") throw new Error("personal shares: delegate grant is required");
    if (delegate.grant === record.grant) throw new Error("personal shares: the owner cannot be their own delegate");
    if (seen.has(delegate.grant)) throw new Error(`personal shares: delegate ${delegate.grant} is listed twice`);
    seen.add(delegate.grant);
    for (const [prefix, right] of Object.entries(delegate.rights ?? {})) {
      const allowed = DELEGABLE_PERSONAL_DATABASES[prefix];
      if (!allowed) throw new Error(`personal shares: "${prefix}" cannot be delegated`);
      if (!allowed.includes(right)) throw new Error(`personal shares: "${right}" is not a right for "${prefix}"`);
    }
  }
  for (const [prefix, key] of Object.entries(record.depositKeys ?? {})) {
    if (!/^[a-z][a-z0-9]*_$/.test(prefix)) throw new Error(`personal shares: "${prefix}" is not a personal database prefix`);
    if (!key?.publicKey || !key?.fingerprint) throw new Error(`personal shares: deposit key for "${prefix}" is incomplete`);
  }
}

/**
 * The record in a `doc_create`'s data, or null when it is not one. Lenient on
 * unknown rights (they are dropped), strict on structure.
 */
export function parsePersonalShares(data: Record<string, unknown> | null | undefined): PersonalSharesRecord | null {
  if (!data || text(data.form) !== PERSONAL_SHARES_FORM) return null;
  const grant = text(data.grant);
  const revision = Number(data.revision);
  if (!grant || !Number.isFinite(revision)) return null;
  const depositKeys: Record<string, PersonalShareDepositKey> = {};
  if (isObject(data.depositKeys)) {
    for (const [prefix, value] of Object.entries(data.depositKeys)) {
      if (!isObject(value)) continue;
      const publicKey = text(value.publicKey);
      const fingerprint = text(value.fingerprint);
      if (publicKey && fingerprint) depositKeys[prefix] = { publicKey, fingerprint };
    }
  }
  const delegates: PersonalShareDelegate[] = [];
  if (Array.isArray(data.delegates)) {
    for (const value of data.delegates) {
      if (!isObject(value)) continue;
      const delegateGrant = text(value.grant);
      if (!delegateGrant || delegateGrant === grant) continue;
      const rights: Record<string, PersonalShareRight> = {};
      if (isObject(value.rights)) {
        for (const [prefix, right] of Object.entries(value.rights)) {
          const r = text(right) as PersonalShareRight | null;
          if (r && DELEGABLE_PERSONAL_DATABASES[prefix]?.includes(r)) rights[prefix] = r;
        }
      }
      delegates.push({ grant: delegateGrant, rights });
    }
  }
  return {
    form: PERSONAL_SHARES_FORM,
    grant,
    revision,
    depositKeys,
    delegates,
    writtenAt: Number(data.writtenAt) || 0,
  };
}

/** The winning record among several of one owner: highest revision, then later trusted time, then smaller id. */
export function newestPersonalShares<T extends { record: PersonalSharesRecord; trustedTime: number; docId: string }>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (
      !best ||
      candidate.record.revision > best.record.revision ||
      (candidate.record.revision === best.record.revision &&
        (candidate.trustedTime > best.trustedTime ||
          (candidate.trustedTime === best.trustedTime && candidate.docId < best.docId)))
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The right `delegateGrant` holds on `prefix` in `record`, or null. */
export function delegatedRight(
  record: PersonalSharesRecord | null | undefined,
  delegateGrants: readonly string[],
  prefix: string,
): PersonalShareRight | null {
  if (!record) return null;
  const order: PersonalShareRight[] = ["edit", "send", "read"];
  let best: PersonalShareRight | null = null;
  for (const delegate of record.delegates) {
    if (!delegateGrants.includes(delegate.grant)) continue;
    const right = delegate.rights[prefix];
    if (right && (best === null || order.indexOf(right) < order.indexOf(best))) best = right;
  }
  return best;
}
