import { generateRandomUuid } from "../utils/idGeneration";

/**
 * What a client signs when it answers a login challenge, and what a server
 * accepts back.
 *
 * Every login in MindooDB is challenge/response with an Ed25519 key: a user's
 * device key against a tenant server (sync, Iroh), the system admin key, a
 * server's key against a peer server, and device discovery. Those keys sign
 * other things too — store entries (`EntrySignature.ts`), app seals
 * (`DomainStatement.ts`), witness receipts — so the bytes a challenge makes
 * the key sign must never be one of those.
 *
 * Until v2 the client signed the challenge string as it came. The side that
 * issues the challenge is the side the client is logging in to — a server, or
 * on Iroh a peer device — so whoever ran it could send any string and get a
 * signature over its UTF-8 bytes. The entry layout is expressible as UTF-8,
 * which made that a way to obtain a valid author signature over a forged entry.
 *
 * ## The two challenge forms
 *
 * - **v2** (`mindoodb-auth-challenge/v2:<uuid>`): issued by current servers.
 *   The client signs `utf8("mindoodb-auth/v2") || 0x00 || utf8(challenge)`,
 *   a domain no other signer in MindooDB uses.
 * - **legacy** (a bare UUID): issued by servers that predate v2. The client
 *   signs the UUID's bytes as before. A UUID starts with a hex digit, so it
 *   cannot be an entry layout (version byte `0x01`) or a domain statement
 *   (`mindoodb-…`).
 *
 * A client refuses to sign anything else. That alone closes the attack against
 * a hostile server or peer, whatever version it runs.
 *
 * ## Transition
 *
 * Clients that predate v2 sign whatever string they get, so they answer a v2
 * challenge with a raw signature over it. Servers accept that as long as
 * the legacy policy allows it (the default) — it is still safe, because the
 * server chose the bytes. A server reports each such login
 * ({@link LegacyChallengeSignaturePolicy}); switch it off once none remain.
 */

/** Prefix of a v2 challenge. Not a signing domain: the client adds its own. */
export const AUTH_CHALLENGE_V2_PREFIX = "mindoodb-auth-challenge/v2:";

/** Domain a v2 challenge response is signed under. */
export const AUTH_CHALLENGE_SIGNING_DOMAIN = "mindoodb-auth/v2";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const textEncoder = new TextEncoder();

/** A fresh v2 challenge, for a server to hand out. */
export function issueAuthChallenge(): string {
  return `${AUTH_CHALLENGE_V2_PREFIX}${generateRandomUuid()}`;
}

/** Which form `challenge` is in, or null when a client must not sign it. */
export function authChallengeForm(challenge: unknown): "v2" | "legacy" | null {
  if (typeof challenge !== "string") {
    return null;
  }
  if (challenge.startsWith(AUTH_CHALLENGE_V2_PREFIX)) {
    return UUID_PATTERN.test(challenge.slice(AUTH_CHALLENGE_V2_PREFIX.length)) ? "v2" : null;
  }
  return UUID_PATTERN.test(challenge) ? "legacy" : null;
}

function domainBytes(challenge: string): Uint8Array<ArrayBuffer> {
  const prefix = textEncoder.encode(AUTH_CHALLENGE_SIGNING_DOMAIN);
  const body = textEncoder.encode(challenge);
  const out = new Uint8Array(prefix.byteLength + 1 + body.byteLength);
  out.set(prefix, 0);
  out[prefix.byteLength] = 0x00;
  out.set(body, prefix.byteLength + 1);
  return out;
}

/**
 * The bytes a client signs to answer `challenge`. Throws for anything that is
 * neither a v2 challenge nor a bare UUID — the server or peer sending it is
 * either broken or trying to get a signature over bytes of its choosing.
 */
export function authChallengeSigningBytes(challenge: string): Uint8Array<ArrayBuffer> {
  const form = authChallengeForm(challenge);
  if (form === "v2") {
    return domainBytes(challenge);
  }
  if (form === "legacy") {
    return textEncoder.encode(challenge);
  }
  throw new Error(
    "Refusing to sign a login challenge in an unknown format. "
      + "The server or peer is not a MindooDB server, or is misbehaving.",
  );
}

/**
 * The byte strings a server accepts a signature over, for a challenge it
 * issued itself: the v2 domain form, plus the raw string from clients that
 * predate v2 while `acceptLegacySignatures` is on. A legacy (bare UUID)
 * challenge only ever had the raw form.
 */
export function authChallengeVerificationInputs(
  challenge: string,
  options: { acceptLegacySignatures?: boolean } = {},
): Uint8Array<ArrayBuffer>[] {
  const raw = textEncoder.encode(challenge);
  if (authChallengeForm(challenge) !== "v2") {
    return [raw];
  }
  return options.acceptLegacySignatures === false ? [domainBytes(challenge)] : [domainBytes(challenge), raw];
}

/** Which login a challenge response belongs to, for {@link LegacyChallengeSignaturePolicy.onLegacySignature}. */
export type AuthChallengeUse = "sync" | "device-discovery" | "system-admin" | "peer";

/**
 * A server process's stance on raw (pre-v2) signatures over v2 challenges.
 * One policy per process: the tenant login, device discovery, the system
 * admin login and the peer login all follow it.
 */
export interface LegacyChallengeSignaturePolicy {
  /** Accept a raw signature over a v2 challenge. Default true (transition). */
  accept: boolean;
  /**
   * Called for every raw signature that was accepted, so an operator can see
   * which clients still need an update before switching `accept` off.
   */
  onLegacySignature?: (use: AuthChallengeUse | undefined) => void;
}

let legacyPolicy: LegacyChallengeSignaturePolicy = { accept: true };

/** Set this process's policy (a server host calls it once at startup). */
export function setLegacyChallengeSignaturePolicy(policy: LegacyChallengeSignaturePolicy): void {
  legacyPolicy = { ...policy };
}

export function getLegacyChallengeSignaturePolicy(): LegacyChallengeSignaturePolicy {
  return legacyPolicy;
}

/**
 * Verify a challenge response against an imported Ed25519 public key, trying
 * each form {@link authChallengeVerificationInputs} allows.
 *
 * `acceptLegacySignatures` overrides the process policy
 * ({@link setLegacyChallengeSignaturePolicy}) when given. A raw signature over
 * a v2 challenge that passes is reported to the policy's `onLegacySignature`.
 */
export async function verifyAuthChallengeSignature(
  subtle: SubtleCrypto,
  publicKey: CryptoKey,
  challenge: string,
  signature: Uint8Array,
  options: { acceptLegacySignatures?: boolean; use?: AuthChallengeUse } = {},
): Promise<boolean> {
  const signatureBytes = signature.buffer.slice(
    signature.byteOffset,
    signature.byteOffset + signature.byteLength,
  ) as ArrayBuffer;
  const acceptLegacySignatures = options.acceptLegacySignatures ?? legacyPolicy.accept;
  const inputs = authChallengeVerificationInputs(challenge, { acceptLegacySignatures });
  for (let index = 0; index < inputs.length; index += 1) {
    if (await subtle.verify({ name: "Ed25519" }, publicKey, signatureBytes, inputs[index])) {
      // For a v2 challenge the second input is the raw form of older clients.
      if (index > 0) {
        legacyPolicy.onLegacySignature?.(options.use);
      }
      return true;
    }
  }
  return false;
}
