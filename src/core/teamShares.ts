/**
 * Deposit keys of a team mailbox (docs/accesscontrol.md §6.11, "Team
 * databases"). The team's key documents live in `tmail_<id>` and `tcal_<id>`,
 * which depositors cannot read; so a member publishes the public halves of
 * their deposit keys in `userdirectory`, `$publicinfos`-encrypted like the
 * personal `pbox_` record, and the mail gateway (and colleagues sending
 * internal mail) seal deliveries to them.
 *
 * Any member of the team's group may publish a record; records of anyone else
 * are ignored. Records are written once and replaced by newer ones
 * (`revision`); among the valid ones the highest revision wins.
 */
import type { PersonalShareDepositKey } from "./personalShares";

/** Id prefix of team deposit-key records in `userdirectory`. */
export const TEAM_SHARES_DOC_ID_PREFIX = "tbox_";

/** `form` of a team deposit-key record. */
export const TEAM_SHARES_FORM = "teamshares";

export interface TeamSharesRecord {
  form: typeof TEAM_SHARES_FORM;
  /** The team mailbox id (`tmail_<id>`, `tcal_<id>`). */
  mailboxId: string;
  /** Increases with every new record; the highest wins. */
  revision: number;
  /** Current deposit key per team database prefix (`tmail_`, `tcal_`). */
  depositKeys: Record<string, PersonalShareDepositKey>;
  /** When it was written (ms, client clock; informational). */
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

/** The record in a `doc_create`'s data, or null when it is not one. */
export function parseTeamShares(data: Record<string, unknown> | null | undefined): TeamSharesRecord | null {
  if (!data || text(data.form) !== TEAM_SHARES_FORM) return null;
  const mailboxId = text(data.mailboxId);
  const revision = Number(data.revision);
  if (!mailboxId || !Number.isFinite(revision)) return null;
  const depositKeys: Record<string, PersonalShareDepositKey> = {};
  if (isObject(data.depositKeys)) {
    for (const [prefix, value] of Object.entries(data.depositKeys)) {
      if (prefix !== "tmail_" && prefix !== "tcal_") continue;
      if (!isObject(value)) continue;
      const publicKey = text(value.publicKey);
      const fingerprint = text(value.fingerprint);
      if (publicKey && fingerprint) depositKeys[prefix] = { publicKey, fingerprint };
    }
  }
  return { form: TEAM_SHARES_FORM, mailboxId, revision, depositKeys, writtenAt: Number(data.writtenAt) || 0 };
}

/** The winning record among several: highest revision, then later trusted time, then smaller id. */
export function newestTeamShares<T extends { record: TeamSharesRecord; trustedTime: number; docId: string }>(
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
