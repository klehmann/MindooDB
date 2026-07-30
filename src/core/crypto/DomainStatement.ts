/**
 * Domain-separated statement signing.
 *
 * A user's Ed25519 identity key already signs two things with fixed layouts:
 * store-entry metadata (`crypto/EntrySignature.ts`) and authentication
 * challenges. Letting an application hand arbitrary bytes to that same key
 * would make the signer a confused deputy — an app could ask for a "statement"
 * that happens to be a valid entry-signing payload and obtain a signature the
 * user never meant to give.
 *
 * The fix is a mandatory prefix: what gets signed is
 *
 *     utf8(domain) || 0x00 || statementBytes
 *
 * and `domain` must come from {@link SIGNING_DOMAINS}. Because every allowed
 * domain starts with an ASCII letter while the entry layout starts with its
 * version byte `0x01`, and challenges are random tokens that never begin with
 * `"mindoodb-"`, the three input spaces cannot overlap. The `0x00` separator
 * stops one domain from being a prefix of another.
 */

/**
 * Every purpose an app may request a signature for. Deliberately a closed list:
 * adding a domain is a security decision, not a caller's choice.
 */
export const SIGNING_DOMAINS = Object.freeze({
  /** Approval / counter-signature seal statement (TeamSketchbook and friends). */
  SEAL_V1: "mindoodb-seal/v1",
} as const);

export type SigningDomain = (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS];

const ALLOWED_DOMAINS: ReadonlySet<string> = new Set(Object.values(SIGNING_DOMAINS));

/** Statements are user-reviewable documents, not bulk data. */
export const MAX_DOMAIN_STATEMENT_BYTES = 256 * 1024;

export class InvalidSigningDomainError extends Error {
  constructor(domain: string) {
    super(
      `"${domain}" is not an allowed signing domain (expected one of: ${Array.from(ALLOWED_DOMAINS).join(", ")})`,
    );
    this.name = "InvalidSigningDomainError";
  }
}

export function isAllowedSigningDomain(domain: string): domain is SigningDomain {
  return ALLOWED_DOMAINS.has(domain);
}

export function assertAllowedSigningDomain(domain: string): asserts domain is SigningDomain {
  if (!isAllowedSigningDomain(domain)) {
    throw new InvalidSigningDomainError(domain);
  }
}

/**
 * Build the bytes actually covered by a domain-separated signature.
 *
 * Verifiers must reconstruct these from the domain and the statement rather
 * than trusting a transmitted blob, otherwise the separation buys nothing.
 */
export function buildDomainStatementBytes(domain: string, statement: Uint8Array): Uint8Array {
  assertAllowedSigningDomain(domain);
  if (statement.byteLength > MAX_DOMAIN_STATEMENT_BYTES) {
    throw new Error(
      `Statement too large (${statement.byteLength} bytes, max ${MAX_DOMAIN_STATEMENT_BYTES})`,
    );
  }
  const prefix = new TextEncoder().encode(domain);
  const out = new Uint8Array(prefix.byteLength + 1 + statement.byteLength);
  out.set(prefix, 0);
  out[prefix.byteLength] = 0x00;
  out.set(statement, prefix.byteLength + 1);
  return out;
}
