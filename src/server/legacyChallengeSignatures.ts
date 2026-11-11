/**
 * A server host's switch for raw (pre-v2) login-challenge signatures, see
 * `core/crypto/AuthChallenge.ts`.
 *
 * `MINDOODB_ACCEPT_LEGACY_CHALLENGE_SIGNATURES` — unset, `1` or `true`: clients
 * that predate the v2 signing domain may still log in (transition default).
 * `0` or `false`: they are refused. While they are accepted, each such login is
 * logged, at most once an hour per kind of login, together with the count
 * since the last line — so an operator can watch the log go quiet and then
 * switch the setting off.
 */
import {
  setLegacyChallengeSignaturePolicy,
  type AuthChallengeUse,
} from "../core/crypto/AuthChallenge";

const LOG_INTERVAL_MS = 60 * 60 * 1000;

/** Per kind of login; module-wide so configuring again does not restart the hour. */
const pending = new Map<string, { count: number; lastLoggedAt: number }>();

/** Whether the setting's raw value keeps legacy signatures accepted. */
export function acceptsLegacyChallengeSignatures(rawValue: string | undefined): boolean {
  const value = rawValue?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

/**
 * Apply the setting to this process and start reporting legacy logins.
 * Returns whether legacy signatures are accepted.
 */
export function configureLegacyChallengeSignatures(
  rawValue: string | undefined,
  options: { log?: (message: string) => void; now?: () => number } = {},
): boolean {
  const log = options.log ?? ((message: string) => console.warn(message));
  const now = options.now ?? (() => Date.now());
  const accept = acceptsLegacyChallengeSignatures(rawValue);

  setLegacyChallengeSignaturePolicy({
    accept,
    onLegacySignature: (use: AuthChallengeUse | undefined) => {
      const kind = use ?? "unknown";
      const entry = pending.get(kind) ?? { count: 0, lastLoggedAt: Number.NEGATIVE_INFINITY };
      entry.count += 1;
      if (now() - entry.lastLoggedAt >= LOG_INTERVAL_MS) {
        log(
          `[auth] ${entry.count} ${kind} login(s) answered the challenge with a legacy (pre-v2) signature. `
            + "These clients need an update before MINDOODB_ACCEPT_LEGACY_CHALLENGE_SIGNATURES=0.",
        );
        entry.count = 0;
        entry.lastLoggedAt = now();
      }
      pending.set(kind, entry);
    },
  });
  return accept;
}
