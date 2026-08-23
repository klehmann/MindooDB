import { expandAbbreviatedName, parseCanonicalName } from "../../core/userid/canonicalUsername";

/**
 * Hint shown wherever a setup name is rejected, so the operator reads the same
 * rule in the shell script, the CLI error, and the interactive prompt.
 */
export const CANONICAL_NAME_HINT =
  'must name a common name and an organization, e.g. "server1/acme" or "cn=server1/o=acme"';

/**
 * Turns what an operator typed during setup into the canonical name everything
 * else compares against, or returns null when it cannot become one.
 *
 * Names entered at setup time are later matched as strings: the system admin is
 * looked up in `config.json` by a case-folded comparison, while clients send the
 * canonical form of their stored identity, so `sysadmin/acme` on this side and
 * `cn=sysadmin/o=acme` on theirs never meet. `expandAbbreviatedName` accepts
 * every shape people actually type - abbreviated, canonical, and mixed like
 * `sysadmin/o=acme` - and never prefixes a segment twice.
 *
 * The organization is required because it is not decoration: `canonicalizeUsername`
 * refuses a name without one, so an identity created here without it works until
 * the first encryption path resolves it and then fails far from this prompt.
 */
export function toCanonicalSetupName(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const expanded = expandAbbreviatedName(trimmed);
  const parts = parseCanonicalName(expanded);
  if (!parts.cn || !parts.o) {
    return null;
  }
  return expanded;
}
