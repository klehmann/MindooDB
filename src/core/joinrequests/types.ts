/**
 * Invitation links and the join-request inbox (docs/invitations.md).
 *
 * An admin creates an **invitation** (`invite_<id>` in `directory`). Its public
 * part names a fresh RSA-OAEP key pair; the private half, the list of invited
 * people and their per-link nonces are sealed to the tenant admins. A joining
 * device posts a **join request** to the server, encrypted to the invitation
 * key; the server stores it as `jr_<id>` in the built-in `joinrequests`
 * database. Admins pull that database, decrypt, check the request against the
 * invitation list and approve with the existing `approveJoinRequest`.
 *
 * Security invariants (unchanged by this feature):
 * - key pairs are still created only on the joining device,
 * - only admins sign grants,
 * - the server can read no tenant data and cannot admit anyone: it sees the
 *   public invitation part and the outer request envelope (`$publicinfos`), never
 *   the request itself or the invitation list,
 * - no grant-signing key is ever on the server or in a link.
 */

/** Built-in database holding the received join requests. Admin-only read. */
export const JOIN_REQUESTS_DB_ID = "joinrequests";

/** Document-id prefix of a join request in {@link JOIN_REQUESTS_DB_ID}. */
export const JOIN_REQUEST_DOC_ID_PREFIX = "jr_";

/** Document-id prefix of an invitation in `directory`. */
export const INVITATION_DOC_ID_PREFIX = "invite_";

/** `form` of an invitation document. */
export const INVITATION_FORM = "invitation";

/** `form` of a join-request document. */
export const JOIN_REQUEST_FORM = "joinrequest";

/** A join request expires (and is purged) this long after the server received it. */
export const JOIN_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Upper bound for the JSON body of `POST /:tenantId/join-requests`. */
export const MAX_JOIN_REQUEST_BYTES = 16 * 1024;

/** Upper bound for the optional free-text message inside a request. */
export const MAX_JOIN_REQUEST_MESSAGE_CHARS = 1000;

/** Open (pending) requests a single tenant may hold. */
export const MAX_PENDING_JOIN_REQUESTS_PER_TENANT = 500;

/** Default lifetime of an invitation. */
export const DEFAULT_INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `personal`: one link per invited person, each carrying its own nonce. The
 * request proves knowledge of the nonce (HMAC), so the admin can match it to
 * a row of the invitation list.
 *
 * `open`: one shared link without a nonce. Anyone holding it can ask; the
 * admin compares a verification code with the person out of band.
 */
export type InvitationKind = "personal" | "open";

/** How an invited person signs in later (reserved for stage 2: OIDC / Domino). */
export type InvitationLoginType = "domino" | "email" | "entra";

/** Lifecycle of one row of the invitation list (admin-side bookkeeping). */
export type InvitationRowStatus = "new" | "sent" | "requested" | "admitted" | "rejected";

/** Status of a join request document. Only admins change it. */
export type JoinRequestStatus = "pending" | "accepted" | "rejected" | "withdrawn";

/** One invited person (sealed to the admins; the server never sees it). */
export interface InvitationRow {
  /** Stable row id inside the invitation. */
  rowId: string;
  firstName?: string;
  lastName?: string;
  /** Canonical username (`CN=…/O=…`) the person will be registered as. */
  username?: string;
  email?: string;
  /** Sign-in method for stage 2; `proof` checks will use it. */
  loginType?: InvitationLoginType;
  /** Sign-in value for {@link loginType} (Domino name, mail address, Entra UPN). */
  loginValue?: string;
  status: InvitationRowStatus;
  /** Per-person link secret (base64url, 16 bytes). Only for personal invitations. */
  nonce?: string;
  /** SHA-256 hash of {@link nonce}, as published in the public part. */
  nonceHash?: string;
  /** Join-request doc id that was matched to this row, if any. */
  joinRequestDocId?: string;
  updatedAt?: number;
}

/** Contents sealed to the admins inside an invitation. */
export interface InvitationSealedContent {
  v: 1;
  /** PKCS8 of the invitation's RSA-OAEP private key, base64. */
  privateKey: string;
  rows: InvitationRow[];
  /** Free-text note for the admins ("Kollegium 2027"). */
  label?: string;
}

/** Envelope sealed to every admin encryption key (one AES key, many wraps). */
export interface AdminSealedBlob {
  v: 1;
  /** AES-256-GCM, IV (12 bytes) || ciphertext, base64. */
  ciphertext: string;
  /** RSA-OAEP wraps of the AES key, keyed by admin encryption-key fingerprint. */
  wraps: Record<string, string>;
}

/**
 * The invitation as stored in `directory` (`$publicinfos`-encrypted, so the
 * server can read the public fields and check requests against them).
 */
export interface InvitationDoc {
  form: typeof INVITATION_FORM;
  invitationId: string;
  kind: InvitationKind;
  /** RSA-OAEP public key (PEM) requests are encrypted to. */
  publicKey: string;
  /** {@link invitationKeyFingerprint} of {@link publicKey}; part of the link. */
  keyFingerprint: string;
  createdAt: number;
  expiresAt: number;
  /** Maximum number of distinct devices that may post a request (open links). */
  maxUses?: number;
  /** SHA-256 hashes of the per-person nonces (personal invitations). */
  nonceHashes: string[];
  /** Set by an admin to stop accepting requests before {@link expiresAt}. */
  ended: boolean;
  /**
   * Ed25519 signing key (PEM) of the server that stores requests for this
   * invitation. Clients trust `jr_` documents signed by it (besides trusted
   * witnesses), so no root-only witness setup is needed to use invitations.
   */
  serverSigningPublicKey?: string;
  /** Server URL the link points to (informational). */
  serverUrl?: string;
  /**
   * Tenant name shown on the joining device ("Invitation to …"). Public on
   * purpose — the server and the invited people see it — so the admin chooses
   * it; the tenant's own label stays encrypted under `default`.
   */
  tenantLabel?: string;
  /** JSON of {@link AdminSealedBlob}. */
  sealed: string;
}

/** Public part of an invitation as served by `GET /:tenantId/invitations/:id`. */
export interface InvitationPublicInfo {
  tenantId: string;
  invitationId: string;
  kind: InvitationKind;
  publicKey: string;
  keyFingerprint: string;
  expiresAt: number;
  ended: boolean;
  maxUses?: number;
  /** Human-readable tenant label, when the server can tell (field-encrypted labels stay hidden). */
  tenantLabel?: string;
}

/** What a joining device sends (`POST /:tenantId/join-requests`). */
export interface JoinRequestSubmission {
  v: 1;
  tenantId: string;
  invitationId: string;
  /** Hash of the link nonce; personal invitations only. */
  nonceHash?: string;
  /** Ed25519 PEM of the joining device; must equal the inner request's key. */
  deviceSigningPublicKey: string;
  /** Client clock (ms); the server allows a small skew. */
  createdAt: number;
  /** {@link JoinRequestInner} encrypted to the invitation key (`RSAEncryption.encryptToBase64`). */
  sealedRequest: string;
  /** Ed25519 signature (base64) by the device key over the envelope statement. */
  signature: string;
}

/**
 * The request itself, only readable with the invitation's private key.
 */
export interface JoinRequestInner {
  v: 1;
  tenantId: string;
  invitationId: string;
  /** `mdb://join-request/...` as produced by `createJoinRequest`. */
  joinRequest: string;
  /** HMAC-SHA256(nonce, request hash), base64; personal invitations only. */
  hmac?: string;
  /** Optional note to the admins. */
  message?: string;
  /**
   * Reserved for stage 2: an OIDC id token or Domino proof that the requester
   * owns {@link InvitationRow.loginValue}. Not evaluated yet.
   */
  proof?: { type: InvitationLoginType; value: string };
  createdAt: number;
}

/** A `jr_` document as stored in {@link JOIN_REQUESTS_DB_ID} (`$publicinfos`). */
export interface JoinRequestDoc {
  form: typeof JOIN_REQUEST_FORM;
  invitationId: string;
  nonceHash?: string;
  status: JoinRequestStatus;
  receivedAt: number;
  expiresAt: number;
  /** Fingerprint of {@link deviceSigningPublicKey} (`fingerprintPublicKeyPem`). */
  deviceKeyFingerprint: string;
  deviceSigningPublicKey: string;
  /** Envelope as received, so the admin can re-verify the device signature. */
  createdAt: number;
  sealedRequest: string;
  signature: string;
  /** Set by an admin with the status change. */
  decidedAt?: number;
}

/** Parsed contents of an invitation link fragment. */
export interface InvitationLink {
  serverUrl: string;
  tenantId: string;
  invitationId: string;
  /** Absent for open (shared) links. */
  nonce?: string;
  keyFingerprint: string;
}
