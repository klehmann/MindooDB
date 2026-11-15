/**
 * Client API of the invitation / join-request inbox (docs/invitations.md).
 *
 * Admin side: create and end invitations, keep the invitation list, pull the
 * `joinrequests` inbox with an admin key, decrypt and check requests, admit
 * matching ones with the existing `approveJoinRequest`, decide and purge.
 *
 * Device side: read an invitation from the server, verify its key against the
 * link, and post a join request.
 *
 * Nothing here changes who can do what: grants are still signed by an admin on
 * an admin device; the server only relays sealed envelopes.
 */
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { RSAEncryption } from "../crypto/RSAEncryption";
import { decryptPrivateKey } from "../crypto/privateKeyEncryption";
import { generateRsaOaep3072, importRsaOaepPrivateKey } from "../crypto/rsaOaep3072";
import { signingKeysEqual } from "../accesscontrol/DirectoryStateNode";
import { fingerprintPublicKeyPem, normalizePublicKeyPem } from "../userkeys/fingerprint";
import { bytesToBase64, base64ToBytes } from "../utils/base64";
import { decodeJoinRequestUri } from "../uri/joinRequestUri";
import { expandAbbreviatedName } from "../userid/canonicalUsername";
import type { PrivateUserId } from "../userid";
import type {
  ContentAddressedStore,
  EncryptedPrivateKey,
  JoinRequest,
  MindooDB,
  MindooTenant,
} from "../types";
import { DIRECTORY_DB_ID, PUBLIC_INFOS_KEY_ID } from "../types";
import { StoreKind } from "../appendonlystores/types";
import {
  computeJoinRequestHmac,
  decodeJson,
  deviceKeyFingerprint,
  encodeJson,
  hashInvitationNonce,
  invitationKeyFingerprint,
  joinRequestEnvelopeBytes,
  joinRequestWithdrawalBytes,
  joinRequestSummaryBytes,
  joinRequestHash,
  newInvitationId,
  newInvitationNonce,
  newInvitationRowId,
  openAdminSeal,
  sealForAdmins,
  verificationCodeFromHash,
  verifyJoinRequestEnvelope,
  verifyJoinRequestHmac,
  buildInvitationLinkFragment,
  type AdminRecipient,
} from "./crypto";
import {
  DEFAULT_INVITATION_TTL_MS,
  INVITATION_DOC_ID_PREFIX,
  INVITATION_FORM,
  JOIN_REQUESTS_DB_ID,
  JOIN_REQUEST_DOC_ID_PREFIX,
  MAX_JOIN_REQUEST_MESSAGE_CHARS,
  type AdminSealedBlob,
  type InvitationDoc,
  type InvitationKind,
  type InvitationLink,
  type InvitationPublicInfo,
  type InvitationRow,
  type InvitationSealedContent,
  type JoinRequestDoc,
  type JoinRequestInner,
  type JoinRequestStatus,
  type JoinRequestSubmission,
} from "./types";

// ---------------------------------------------------------------------------
// Admin keys
// ---------------------------------------------------------------------------

/**
 * An admin identity (root or delegated), unlocked once. The encrypted signing
 * key and its password are what `approveJoinRequest` and directory writes take;
 * the CryptoKeys open seals and authenticate the inbox sync.
 */
export interface UnlockedInvitationAdmin {
  signingPublicKey: string;
  encryptedSigningKey: EncryptedPrivateKey;
  password: string;
  signingKey: CryptoKey;
  encryptionPublicKey: string;
  encryptionKey: CryptoKey;
  /** Display name for join responses. */
  username?: string;
}

/** Unlock an admin identity (as Haven stores it: a `PrivateUserId` plus its password). */
export async function unlockInvitationAdmin(
  cryptoAdapter: CryptoAdapter,
  identity: PrivateUserId,
  password: string,
): Promise<UnlockedInvitationAdmin> {
  const subtle = cryptoAdapter.getSubtle();
  const signingPkcs8 = await decryptPrivateKey(cryptoAdapter, identity.userSigningKeyPair.privateKey, password, "signing");
  const signingKey = await subtle.importKey("pkcs8", signingPkcs8, { name: "Ed25519" }, false, ["sign"]);
  const encryptionPkcs8 = await decryptPrivateKey(
    cryptoAdapter,
    identity.userEncryptionKeyPair.privateKey,
    password,
    "encryption",
  );
  const encryptionKey = await importRsaOaepPrivateKey(cryptoAdapter, new Uint8Array(encryptionPkcs8));
  return {
    signingPublicKey: identity.userSigningKeyPair.publicKey,
    encryptedSigningKey: identity.userSigningKeyPair.privateKey,
    password,
    signingKey,
    encryptionPublicKey: identity.userEncryptionKeyPair.publicKey,
    encryptionKey,
    username: identity.username,
  };
}

type AdminTenant = MindooTenant & {
  resolveAdminSigningKeyPair(privateKey: EncryptedPrivateKey, password: string): Promise<{ publicKey: string; privateKey: EncryptedPrivateKey }>;
  getAdministrationEncryptionPublicKey(): string;
};

/** Every admin encryption key that must be able to open invitation seals: the root and active delegated admins. */
export async function listInvitationAdminRecipients(tenant: MindooTenant): Promise<AdminRecipient[]> {
  const recipients: AdminRecipient[] = [
    { encryptionPublicKey: (tenant as AdminTenant).getAdministrationEncryptionPublicKey() },
  ];
  const directory = await tenant.openDirectory();
  if (typeof directory.listAdminKeys === "function") {
    for (const admin of await directory.listAdminKeys()) {
      if (admin.active && admin.encryptionPublicKey) {
        recipients.push({ encryptionPublicKey: admin.encryptionPublicKey });
      }
    }
  }
  return recipients;
}

async function adminWriteOptions(tenant: MindooTenant, admin: UnlockedInvitationAdmin) {
  const pair = await (tenant as AdminTenant).resolveAdminSigningKeyPair(admin.encryptedSigningKey, admin.password);
  return { signingKeyPair: pair as never, signingKeyPassword: admin.password };
}

// ---------------------------------------------------------------------------
// Invitations (admin)
// ---------------------------------------------------------------------------

/** Input row when creating or editing an invitation list. */
export interface InvitationRowInput {
  rowId?: string;
  firstName?: string;
  lastName?: string;
  /** Canonical or abbreviated (`Anna Muster/Schule`) username; stored canonical. */
  username?: string;
  email?: string;
  loginType?: InvitationRow["loginType"];
  loginValue?: string;
  status?: InvitationRow["status"];
}

export interface CreateInvitationOptions {
  kind: InvitationKind;
  /** Server that will receive the requests; must hold this tenant. */
  serverUrl: string;
  rows?: InvitationRowInput[];
  label?: string;
  /** Public tenant name for the joining device (see {@link InvitationDoc.tenantLabel}). */
  tenantLabel?: string;
  /** Absolute expiry (ms); default 30 days from now. */
  expiresAt?: number;
  /** Open links: cap on distinct devices. */
  maxUses?: number;
  /**
   * Ed25519 key of that server (`/.well-known/mindoodb-server-info`). Fetched
   * when omitted. Named in the invitation so members trust the `jr_`
   * documents it signs.
   */
  serverSigningPublicKey?: string;
}

/** An invitation as an admin sees it. */
export interface InvitationView {
  invitationId: string;
  kind: InvitationKind;
  publicKey: string;
  keyFingerprint: string;
  createdAt: number;
  expiresAt: number;
  ended: boolean;
  maxUses?: number;
  serverUrl?: string;
  serverSigningPublicKey?: string;
  tenantLabel?: string;
  /** Present when the admin could open the seal. */
  label?: string;
  rows?: InvitationRow[];
  /** False when no wrap addresses this admin (added after the invitation; another admin must re-seal). */
  readable: boolean;
}

/** Normalize a typed or pasted username to its canonical form (`CN=…/O=…`). */
export function canonicalInvitationUsername(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return expandAbbreviatedName(trimmed);
}

async function rowsFromInput(
  cryptoAdapter: CryptoAdapter,
  kind: InvitationKind,
  inputs: InvitationRowInput[],
  previous: InvitationRow[] = [],
): Promise<InvitationRow[]> {
  const subtle = cryptoAdapter.getSubtle();
  const byId = new Map(previous.map((row) => [row.rowId, row]));
  const rows: InvitationRow[] = [];
  for (const input of inputs) {
    const existing = input.rowId ? byId.get(input.rowId) : undefined;
    const row: InvitationRow = {
      rowId: existing?.rowId ?? input.rowId ?? newInvitationRowId(cryptoAdapter),
      ...(input.firstName?.trim() ? { firstName: input.firstName.trim() } : {}),
      ...(input.lastName?.trim() ? { lastName: input.lastName.trim() } : {}),
      ...(canonicalInvitationUsername(input.username) ? { username: canonicalInvitationUsername(input.username) } : {}),
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      ...(input.loginType ? { loginType: input.loginType } : {}),
      ...(input.loginValue?.trim() ? { loginValue: input.loginValue.trim() } : {}),
      status: input.status ?? existing?.status ?? "new",
      ...(existing?.joinRequestDocId ? { joinRequestDocId: existing.joinRequestDocId } : {}),
      updatedAt: Date.now(),
    };
    if (kind === "personal") {
      row.nonce = existing?.nonce ?? newInvitationNonce(cryptoAdapter);
      row.nonceHash = existing?.nonceHash ?? (await hashInvitationNonce(subtle, row.nonce));
    }
    rows.push(row);
  }
  return rows;
}

async function fetchServerSigningKey(serverUrl: string): Promise<string> {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/.well-known/mindoodb-server-info`);
  if (!response.ok) throw new Error(`Server info not available (HTTP ${response.status})`);
  const body = (await response.json()) as { signingPublicKey?: string };
  if (typeof body.signingPublicKey !== "string" || !body.signingPublicKey) {
    throw new Error("Server info carries no signing key");
  }
  return body.signingPublicKey;
}

/**
 * Create an invitation in the local `directory` replica. Push the directory to
 * the server afterwards; until then the server answers the link with 404.
 */
export async function createInvitation(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  options: CreateInvitationOptions,
): Promise<InvitationView> {
  const cryptoAdapter = tenant.getCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const invitationId = newInvitationId(cryptoAdapter);
  const { publicKeyPem, privateKeyBytes } = await generateRsaOaep3072(cryptoAdapter);
  const rows = await rowsFromInput(cryptoAdapter, options.kind, options.rows ?? []);
  const content: InvitationSealedContent = {
    v: 1,
    privateKey: bytesToBase64(privateKeyBytes),
    rows,
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  };
  const { blob } = await sealForAdmins(cryptoAdapter, encodeJson(content), await listInvitationAdminRecipients(tenant));
  const now = Date.now();
  const doc: InvitationDoc = {
    form: INVITATION_FORM,
    invitationId,
    kind: options.kind,
    publicKey: publicKeyPem,
    keyFingerprint: await invitationKeyFingerprint(subtle, publicKeyPem),
    createdAt: now,
    expiresAt: options.expiresAt ?? now + DEFAULT_INVITATION_TTL_MS,
    ...(typeof options.maxUses === "number" && options.maxUses > 0 ? { maxUses: Math.floor(options.maxUses) } : {}),
    nonceHashes: rows.map((row) => row.nonceHash).filter((hash): hash is string => !!hash),
    ended: false,
    serverSigningPublicKey: options.serverSigningPublicKey ?? (await fetchServerSigningKey(options.serverUrl)),
    serverUrl: options.serverUrl.replace(/\/$/, ""),
    ...(options.tenantLabel?.trim() ? { tenantLabel: options.tenantLabel.trim().slice(0, 200) } : {}),
    sealed: JSON.stringify(blob),
  };
  const directoryDb = await tenant.openDB(DIRECTORY_DB_ID, { adminOnlyDb: true });
  await directoryDb.createDocument({
    id: `${INVITATION_DOC_ID_PREFIX}${invitationId}`,
    assumeUniqueId: true,
    decryptionKeyId: PUBLIC_INFOS_KEY_ID,
    initialValues: doc as unknown as Record<string, unknown>,
    ...(await adminWriteOptions(tenant, admin)),
  });
  return { ...viewFromDoc(doc), label: content.label, rows, readable: true };
}

function viewFromDoc(doc: InvitationDoc): InvitationView {
  return {
    invitationId: doc.invitationId,
    kind: doc.kind,
    publicKey: doc.publicKey,
    keyFingerprint: doc.keyFingerprint,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    ended: doc.ended === true,
    ...(typeof doc.maxUses === "number" ? { maxUses: doc.maxUses } : {}),
    ...(doc.serverUrl ? { serverUrl: doc.serverUrl } : {}),
    ...(doc.serverSigningPublicKey ? { serverSigningPublicKey: doc.serverSigningPublicKey } : {}),
    ...(doc.tenantLabel ? { tenantLabel: doc.tenantLabel } : {}),
    readable: false,
  };
}

function toPlain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readInvitationDocs(tenant: MindooTenant): Promise<Array<{ db: MindooDB; docId: string; doc: InvitationDoc }>> {
  const directoryDb = await tenant.openDB(DIRECTORY_DB_ID, { adminOnlyDb: true });
  await directoryDb.syncStoreChanges();
  const out: Array<{ db: MindooDB; docId: string; doc: InvitationDoc }> = [];
  for (const docId of await directoryDb.getAllDocumentIds()) {
    if (!docId.startsWith(INVITATION_DOC_ID_PREFIX)) continue;
    try {
      const data = toPlain<InvitationDoc>((await directoryDb.getDocument(docId)).getData());
      if (data.form !== INVITATION_FORM || typeof data.publicKey !== "string") continue;
      out.push({ db: directoryDb, docId, doc: { ...data, nonceHashes: data.nonceHashes ?? [] } });
    } catch {
      // unreadable or deleted
    }
  }
  return out;
}

async function openInvitationSeal(
  tenant: MindooTenant,
  doc: InvitationDoc,
  admin: UnlockedInvitationAdmin,
): Promise<{ content: InvitationSealedContent; aesKey: Uint8Array; blob: AdminSealedBlob } | null> {
  try {
    const blob = JSON.parse(doc.sealed) as AdminSealedBlob;
    const opened = await openAdminSeal(tenant.getCryptoAdapter(), blob, {
      encryptionPublicKey: admin.encryptionPublicKey,
      encryptionPrivateKey: admin.encryptionKey,
    });
    if (!opened) return null;
    return { content: decodeJson<InvitationSealedContent>(opened.plaintext), aesKey: opened.aesKey, blob };
  } catch {
    return null;
  }
}

/** All invitations of the tenant, with the sealed list where this admin can open it. Newest first. */
export async function listInvitations(tenant: MindooTenant, admin?: UnlockedInvitationAdmin): Promise<InvitationView[]> {
  const views: InvitationView[] = [];
  for (const { doc } of await readInvitationDocs(tenant)) {
    const view = viewFromDoc(doc);
    if (admin) {
      const opened = await openInvitationSeal(tenant, doc, admin);
      if (opened) {
        view.readable = true;
        view.rows = opened.content.rows;
        if (opened.content.label) view.label = opened.content.label;
      }
    }
    views.push(view);
  }
  return views.sort((a, b) => b.createdAt - a.createdAt);
}

async function changeInvitation(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  invitationId: string,
  mutate: (state: { doc: InvitationDoc; content: InvitationSealedContent }) => Promise<void> | void,
): Promise<InvitationView> {
  const docId = `${INVITATION_DOC_ID_PREFIX}${invitationId}`;
  const entry = (await readInvitationDocs(tenant)).find((item) => item.docId === docId);
  if (!entry) throw new Error(`Invitation ${invitationId} not found`);
  const opened = await openInvitationSeal(tenant, entry.doc, admin);
  if (!opened) throw new Error("This admin key cannot open the invitation; another admin has to re-seal it first");
  const state = { doc: { ...entry.doc }, content: opened.content };
  await mutate(state);
  const cryptoAdapter = tenant.getCryptoAdapter();
  const { blob } = await sealForAdmins(
    cryptoAdapter,
    encodeJson(state.content),
    await listInvitationAdminRecipients(tenant),
    { aesKey: opened.aesKey, wraps: opened.blob.wraps },
  );
  state.doc.sealed = JSON.stringify(blob);
  state.doc.nonceHashes = state.content.rows.map((row) => row.nonceHash).filter((hash): hash is string => !!hash);
  const mindooDoc = await entry.db.getDocument(docId);
  await entry.db.changeDoc(
    mindooDoc,
    (d) => {
      const data = d.getData() as Record<string, unknown>;
      data.sealed = state.doc.sealed;
      data.nonceHashes = [...state.doc.nonceHashes];
      data.ended = state.doc.ended === true;
      data.expiresAt = state.doc.expiresAt;
      if (typeof state.doc.maxUses === "number") data.maxUses = state.doc.maxUses;
    },
    await adminWriteOptions(tenant, admin),
  );
  return {
    ...viewFromDoc(state.doc),
    rows: state.content.rows,
    ...(state.content.label ? { label: state.content.label } : {}),
    readable: true,
  };
}

/** Replace the invitation list (new rows get a nonce on personal invitations; known rows keep theirs). */
export function setInvitationRows(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  invitationId: string,
  rows: InvitationRowInput[],
  options?: { label?: string },
): Promise<InvitationView> {
  return changeInvitation(tenant, admin, invitationId, async (state) => {
    state.content.rows = await rowsFromInput(tenant.getCryptoAdapter(), state.doc.kind, rows, state.content.rows);
    if (options?.label !== undefined) state.content.label = options.label.trim() || undefined;
  });
}

/** Update the status of single rows (e.g. `sent` after the link went out). */
export function setInvitationRowStatus(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  invitationId: string,
  updates: Array<{ rowId: string; status: InvitationRow["status"]; joinRequestDocId?: string }>,
): Promise<InvitationView> {
  return changeInvitation(tenant, admin, invitationId, (state) => {
    for (const update of updates) {
      const row = state.content.rows.find((candidate) => candidate.rowId === update.rowId);
      if (!row) continue;
      row.status = update.status;
      if (update.joinRequestDocId) row.joinRequestDocId = update.joinRequestDocId;
      row.updatedAt = Date.now();
    }
  });
}

/** Stop accepting requests for an invitation. Requests already received stay. */
export function endInvitation(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  invitationId: string,
): Promise<InvitationView> {
  return changeInvitation(tenant, admin, invitationId, (state) => {
    state.doc.ended = true;
  });
}

/**
 * Add wraps for admins that were added after an invitation was sealed. Run on
 * an admin device that can open the seals (Haven does it when the admin opens
 * the invitation list). Returns the ids of re-sealed invitations.
 */
export async function resealInvitationsForAdmins(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
): Promise<string[]> {
  const cryptoAdapter = tenant.getCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const recipients = await listInvitationAdminRecipients(tenant);
  const fingerprints = await Promise.all(
    recipients.map(async (recipient) => ({
      recipient,
      fp: await fingerprintPublicKeyPem(recipient.encryptionPublicKey, subtle),
    })),
  );
  const resealed: string[] = [];
  for (const { doc } of await readInvitationDocs(tenant)) {
    let blob: AdminSealedBlob;
    try {
      blob = JSON.parse(doc.sealed) as AdminSealedBlob;
    } catch {
      continue;
    }
    if (fingerprints.every(({ fp }) => blob.wraps?.[fp])) continue;
    const opened = await openInvitationSeal(tenant, doc, admin);
    if (!opened) continue;
    await changeInvitation(tenant, admin, doc.invitationId, () => undefined);
    resealed.push(doc.invitationId);
  }
  return resealed;
}

/** The link fragment for one row (personal) or for the whole invitation (open). */
export function invitationLinkFragment(
  tenantId: string,
  invitation: Pick<InvitationView, "invitationId" | "keyFingerprint" | "serverUrl">,
  row?: Pick<InvitationRow, "nonce">,
  serverUrl?: string,
): string {
  const server = serverUrl ?? invitation.serverUrl;
  if (!server) throw new Error("No server URL for this invitation");
  return buildInvitationLinkFragment({
    serverUrl: server,
    tenantId,
    invitationId: invitation.invitationId,
    ...(row?.nonce ? { nonce: row.nonce } : {}),
    keyFingerprint: invitation.keyFingerprint,
  });
}

// ---------------------------------------------------------------------------
// Device side
// ---------------------------------------------------------------------------

/** Error from the server's invitation endpoints, with its machine-readable code. */
export class InvitationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "InvitationRequestError";
  }
}

/**
 * Read an invitation from the server and check its key against the link. A
 * mismatch means the server (or someone in between) handed out another key,
 * which would let it read the request: the caller must stop.
 */
export async function fetchInvitationForLink(
  cryptoAdapter: CryptoAdapter,
  link: InvitationLink,
): Promise<InvitationPublicInfo> {
  const url = `${link.serverUrl}/${encodeURIComponent(link.tenantId)}/invitations/${encodeURIComponent(link.invitationId)}`;
  const response = await fetch(url);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new InvitationRequestError(String(body.error ?? `HTTP ${response.status}`), response.status, body.code as string | undefined);
  }
  const info = body as unknown as InvitationPublicInfo;
  const fingerprint = await invitationKeyFingerprint(cryptoAdapter.getSubtle(), info.publicKey);
  if (fingerprint !== link.keyFingerprint || info.keyFingerprint !== link.keyFingerprint) {
    throw new InvitationRequestError("The invitation key does not match the link", 409, "key_mismatch");
  }
  return info;
}

export interface SubmitJoinRequestOptions {
  link: InvitationLink;
  /** `mdb://join-request/...` of this device (`factory.createJoinRequest(user, { format: "uri" })`). */
  joinRequestUri: string;
  /** This device's Ed25519 signing key (unlocked). */
  deviceSigningKey: CryptoKey;
  message?: string;
  /** Already fetched and verified invitation (saves a round trip). */
  invitation?: InvitationPublicInfo;
}

export interface SubmittedJoinRequest {
  id: string;
  expiresAt: number;
  /** Code to compare with the admin when the link carried no nonce. */
  verificationCode: string;
}

/** Post a join request for an invitation link. */
export async function submitJoinRequest(
  cryptoAdapter: CryptoAdapter,
  options: SubmitJoinRequestOptions,
): Promise<SubmittedJoinRequest> {
  const subtle = cryptoAdapter.getSubtle();
  const { link } = options;
  const invitation = options.invitation ?? (await fetchInvitationForLink(cryptoAdapter, link));
  const request = decodeJoinRequestUri(options.joinRequestUri);
  const hash = await joinRequestHash(subtle, link.tenantId, link.invitationId, request);
  const inner: JoinRequestInner = {
    v: 1,
    tenantId: link.tenantId,
    invitationId: link.invitationId,
    joinRequest: options.joinRequestUri,
    ...(link.nonce ? { hmac: await computeJoinRequestHmac(subtle, link.nonce, hash) } : {}),
    ...(options.message?.trim() ? { message: options.message.trim().slice(0, MAX_JOIN_REQUEST_MESSAGE_CHARS) } : {}),
    createdAt: Date.now(),
  };
  const rsa = new RSAEncryption(cryptoAdapter);
  const sealedRequest = await rsa.encryptToBase64(encodeJson(inner), invitation.publicKey);
  const unsigned: Omit<JoinRequestSubmission, "signature"> = {
    v: 1,
    tenantId: link.tenantId,
    invitationId: link.invitationId,
    ...(link.nonce ? { nonceHash: await hashInvitationNonce(subtle, link.nonce) } : {}),
    deviceSigningPublicKey: request.signingPublicKey,
    createdAt: inner.createdAt,
    sealedRequest,
  };
  const signature = await subtle.sign(
    { name: "Ed25519" },
    options.deviceSigningKey,
    (await joinRequestEnvelopeBytes(subtle, unsigned)).slice() as unknown as BufferSource,
  );
  const submission: JoinRequestSubmission = { ...unsigned, signature: bytesToBase64(new Uint8Array(signature)) };
  const response = await fetch(`${link.serverUrl}/${encodeURIComponent(link.tenantId)}/join-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new InvitationRequestError(String(body.error ?? `HTTP ${response.status}`), response.status, body.code as string | undefined);
  }
  return {
    id: String(body.id),
    expiresAt: Number(body.expiresAt),
    verificationCode: verificationCodeFromHash(hash),
  };
}

/**
 * The verification code of a request, for requests sent without an
 * invitation (code over the join request alone) or with an open link.
 */
export async function joinRequestVerificationCode(
  cryptoAdapter: CryptoAdapter,
  joinRequestUri: string,
  scope?: { tenantId: string; invitationId: string },
): Promise<string> {
  const request = decodeJoinRequestUri(joinRequestUri);
  const hash = await joinRequestHash(cryptoAdapter.getSubtle(), scope?.tenantId ?? "", scope?.invitationId ?? "", request);
  return verificationCodeFromHash(hash);
}

/** Outcome of a sent request as the server reports it. */
export type JoinRequestOutcome = "pending" | "accepted" | "rejected" | "withdrawn" | "expired" | "replaced" | "unknown";

/**
 * Ask the server what became of a request. `accepted` shows up once the
 * server saw the admin's decision; the device learns it is in by discovery
 * either way, so poll that too.
 */
export async function fetchJoinRequestStatus(
  serverUrl: string,
  tenantId: string,
  requestId: string,
): Promise<{ status: JoinRequestOutcome; expiresAt?: number }> {
  const response = await fetch(
    `${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(tenantId)}/join-requests/${encodeURIComponent(requestId)}`,
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new InvitationRequestError(String(body.error ?? `HTTP ${response.status}`), response.status, body.code as string | undefined);
  }
  return {
    status: String(body.status) as JoinRequestOutcome,
    ...(typeof body.expiresAt === "number" ? { expiresAt: body.expiresAt } : {}),
  };
}

/** Take a request back (signed by the device that sent it). The server purges it. */
export async function withdrawJoinRequest(
  cryptoAdapter: CryptoAdapter,
  options: { serverUrl: string; tenantId: string; requestId: string; deviceSigningPublicKey: string; deviceSigningKey: CryptoKey },
): Promise<void> {
  const createdAt = Date.now();
  const tenantId = options.tenantId.toLowerCase();
  const signature = await cryptoAdapter.getSubtle().sign(
    { name: "Ed25519" },
    options.deviceSigningKey,
    joinRequestWithdrawalBytes({ tenantId, docId: options.requestId, createdAt }).slice() as unknown as BufferSource,
  );
  const response = await fetch(
    `${options.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(tenantId)}/join-requests/${encodeURIComponent(options.requestId)}/withdraw`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceSigningPublicKey: options.deviceSigningPublicKey,
        createdAt,
        signature: bytesToBase64(new Uint8Array(signature)),
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new InvitationRequestError(String(body.error ?? `HTTP ${response.status}`), response.status, body.code as string | undefined);
  }
}

/**
 * Number of pending requests in a tenant's inbox, asked with a member
 * device's key (no admin key needed). For a "N new requests" hint.
 */
export async function fetchJoinRequestSummary(
  cryptoAdapter: CryptoAdapter,
  options: { serverUrl: string; tenantId: string; deviceSigningPublicKey: string; deviceSigningKey: CryptoKey },
): Promise<{ pending: number }> {
  const createdAt = Date.now();
  const tenantId = options.tenantId.toLowerCase();
  const signature = await cryptoAdapter.getSubtle().sign(
    { name: "Ed25519" },
    options.deviceSigningKey,
    joinRequestSummaryBytes({ tenantId, createdAt }).slice() as unknown as BufferSource,
  );
  const response = await fetch(`${options.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(tenantId)}/join-requests/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceSigningPublicKey: options.deviceSigningPublicKey,
      createdAt,
      signature: bytesToBase64(new Uint8Array(signature)),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new InvitationRequestError(String(body.error ?? `HTTP ${response.status}`), response.status, body.code as string | undefined);
  }
  return { pending: Number(body.pending) || 0 };
}

// ---------------------------------------------------------------------------
// Inbox (admin)
// ---------------------------------------------------------------------------

/** Result of checking one request against its invitation. */
export type JoinRequestMatch =
  /** Personal link: HMAC proves the link, the row is known. */
  | "match"
  /** Open link: nothing to prove; compare the verification code. */
  | "unverified"
  /** Something does not add up; never admit automatically. */
  | "invalid";

export interface JoinRequestInboxItem {
  docId: string;
  status: JoinRequestStatus;
  receivedAt: number;
  expiresAt: number;
  invitationId: string;
  invitationLabel?: string;
  kind?: InvitationKind;
  deviceKeyFingerprint: string;
  match: JoinRequestMatch;
  problems: string[];
  verificationCode?: string;
  row?: InvitationRow;
  joinRequestUri?: string;
  request?: JoinRequest;
  message?: string;
  /** Username the request would be registered under (row first, then the request). */
  username?: string;
}

/**
 * Pull (and push decisions of) the `joinrequests` database with the admin key,
 * then forget local copies of requests the server already purged.
 */
export async function syncJoinRequestInbox(
  tenant: MindooTenant,
  serverUrl: string,
  admin: UnlockedInvitationAdmin,
): Promise<void> {
  const remote = await tenant.connectToServer(serverUrl, JOIN_REQUESTS_DB_ID, StoreKind.docs, {
    authAs: {
      signingPublicKey: admin.signingPublicKey,
      signingKey: admin.signingKey,
      encryptionKey: admin.encryptionKey,
    },
  });
  const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
  await db.pushChangesTo(remote);
  await db.pullChangesFrom(remote);
  await forgetServerPurgedRequests(tenant, db, remote);
}

async function forgetServerPurgedRequests(tenant: MindooTenant, db: MindooDB, remote: ContentAddressedStore): Promise<void> {
  const local = (tenant as unknown as { getDocStoreForDb(dbId: string): ContentAddressedStore }).getDocStoreForDb(JOIN_REQUESTS_DB_ID);
  const localIds = await local.getAllIds();
  if (localIds.length === 0) return;
  const remoteIds = new Set(await remote.hasEntries(localIds));
  const goneDocs = new Set<string>();
  for (const id of localIds) {
    if (remoteIds.has(id)) continue;
    const meta = await local.getEntryMetadata(id);
    if (meta?.entryType === "doc_create" && meta.docId) goneDocs.add(meta.docId);
  }
  for (const docId of goneDocs) {
    await db.purgeDocumentHistory(docId);
  }
}

/** Decrypt and check every request in the local inbox replica. */
export async function listJoinRequests(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  options?: { includeDecided?: boolean },
): Promise<JoinRequestInboxItem[]> {
  const cryptoAdapter = tenant.getCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const now = Date.now();
  const invitations = new Map<string, { doc: InvitationDoc; content?: InvitationSealedContent; key?: CryptoKey }>();
  for (const { doc } of await readInvitationDocs(tenant)) {
    const opened = await openInvitationSeal(tenant, doc, admin);
    invitations.set(doc.invitationId, {
      doc,
      content: opened?.content,
      key: opened ? await importRsaOaepPrivateKey(cryptoAdapter, base64ToBytes(opened.content.privateKey)) : undefined,
    });
  }

  const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
  await db.syncStoreChanges();
  const rsa = new RSAEncryption(cryptoAdapter);
  const items: JoinRequestInboxItem[] = [];
  for (const docId of await db.getAllDocumentIds()) {
    if (!docId.startsWith(JOIN_REQUEST_DOC_ID_PREFIX)) continue;
    let data: JoinRequestDoc;
    try {
      data = toPlain<JoinRequestDoc>((await db.getDocument(docId)).getData());
    } catch {
      continue;
    }
    if (!options?.includeDecided && (data.status !== "pending" || data.expiresAt <= now)) continue;
    const item: JoinRequestInboxItem = {
      docId,
      status: data.status,
      receivedAt: data.receivedAt,
      expiresAt: data.expiresAt,
      invitationId: data.invitationId,
      deviceKeyFingerprint: data.deviceKeyFingerprint,
      match: "invalid",
      problems: [],
    };
    items.push(item);
    const invitation = invitations.get(data.invitationId);
    if (!invitation) {
      item.problems.push("unknown_invitation");
      continue;
    }
    item.kind = invitation.doc.kind;
    if (invitation.content?.label) item.invitationLabel = invitation.content.label;
    if (!invitation.key || !invitation.content) {
      item.problems.push("invitation_not_readable");
      continue;
    }
    if (!(await verifyJoinRequestEnvelope(subtle, { v: 1, tenantId: tenant.getId(), ...data } as JoinRequestSubmission))) {
      item.problems.push("bad_device_signature");
    }
    let inner: JoinRequestInner;
    try {
      inner = decodeJson<JoinRequestInner>(await rsa.decryptFromBase64(data.sealedRequest, invitation.key));
    } catch {
      item.problems.push("cannot_decrypt");
      continue;
    }
    let request: JoinRequest;
    try {
      request = decodeJoinRequestUri(inner.joinRequest);
    } catch {
      item.problems.push("bad_join_request");
      continue;
    }
    item.joinRequestUri = inner.joinRequest;
    item.request = request;
    if (inner.message) item.message = inner.message.slice(0, MAX_JOIN_REQUEST_MESSAGE_CHARS);
    if (inner.tenantId !== tenant.getId() || inner.invitationId !== data.invitationId) {
      item.problems.push("wrong_scope");
    }
    if (!signingKeysEqual(normalizePublicKeyPem(request.signingPublicKey), normalizePublicKeyPem(data.deviceSigningPublicKey))) {
      item.problems.push("device_key_mismatch");
    }
    if ((await deviceKeyFingerprint(subtle, request.signingPublicKey)) !== data.deviceKeyFingerprint) {
      item.problems.push("device_fingerprint_mismatch");
    }
    const hash = await joinRequestHash(subtle, tenant.getId(), data.invitationId, request);
    item.verificationCode = verificationCodeFromHash(hash);
    if (invitation.doc.kind === "personal") {
      const row = invitation.content.rows.find((candidate) => candidate.nonceHash && candidate.nonceHash === data.nonceHash);
      if (!row || !row.nonce) {
        item.problems.push("unknown_link");
      } else if (!inner.hmac || !(await verifyJoinRequestHmac(subtle, row.nonce, hash, inner.hmac))) {
        item.problems.push("bad_link_proof");
      } else {
        item.row = row;
      }
    }
    item.username = item.row?.username ?? request.username;
    item.match = item.problems.length > 0 ? "invalid" : invitation.doc.kind === "personal" ? "match" : "unverified";
  }
  return items.sort((a, b) => a.receivedAt - b.receivedAt);
}

async function setStatusLocal(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  docId: string,
  status: JoinRequestStatus,
): Promise<void> {
  const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
  const doc = await db.getDocument(docId);
  await db.changeDoc(
    doc,
    (d) => {
      const data = d.getData() as Record<string, unknown>;
      data.status = status;
      data.decidedAt = Date.now();
    },
    await adminWriteOptions(tenant, admin),
  );
}

/**
 * Set a request's status (`rejected`, `withdrawn`, …). Sync the inbox
 * afterwards: the server purges decided requests once it sees the change,
 * and the next sync forgets the local copy.
 */
export async function setJoinRequestStatus(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  docId: string,
  status: JoinRequestStatus,
): Promise<void> {
  await setStatusLocal(tenant, admin, docId, status);
}

export interface AdmitJoinRequestsOptions {
  /** Server URL put into the join response (the joining device discovers it there anyway). */
  serverUrl?: string;
  /** Document keys to share; default `$publicinfos` + `default` (see `approveJoinRequest`). */
  sharedDocKeyIds?: string[];
  allowDeviceSelfGrant?: boolean;
  /** Username per request doc id, for requests without a list row or name. */
  usernames?: Record<string, string>;
}

export interface AdmitResult {
  docId: string;
  ok: boolean;
  username?: string;
  error?: string;
}

/**
 * Admit requests: grant each with `approveJoinRequest` under the list row's
 * name, mark the request `accepted` and the row `admitted`. The joining
 * device finds the grant by discovery once the directory reaches the server,
 * so push `directory` and sync the inbox afterwards. Items with problems are
 * refused here, whatever the caller passes.
 */
export async function admitJoinRequests(
  tenant: MindooTenant,
  admin: UnlockedInvitationAdmin,
  items: JoinRequestInboxItem[],
  options: AdmitJoinRequestsOptions = {},
): Promise<AdmitResult[]> {
  const results: AdmitResult[] = [];
  const rowUpdates = new Map<string, Array<{ rowId: string; status: InvitationRow["status"]; joinRequestDocId: string }>>();
  for (const item of items) {
    if (item.match === "invalid" || !item.joinRequestUri) {
      results.push({ docId: item.docId, ok: false, error: item.problems.join(", ") || "invalid" });
      continue;
    }
    const username = canonicalInvitationUsername(options.usernames?.[item.docId] ?? item.username);
    if (!username) {
      results.push({ docId: item.docId, ok: false, error: "missing_username" });
      continue;
    }
    try {
      await tenant.approveJoinRequest(item.joinRequestUri, {
        adminSigningKey: admin.encryptedSigningKey,
        adminPassword: admin.password,
        username,
        ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
        ...(admin.username ? { adminUsername: admin.username } : {}),
        ...(options.sharedDocKeyIds ? { sharedDocKeyIds: options.sharedDocKeyIds } : {}),
        ...(options.allowDeviceSelfGrant ? { allowDeviceSelfGrant: true } : {}),
      });
      await setStatusLocal(tenant, admin, item.docId, "accepted");
      if (item.row) {
        const list = rowUpdates.get(item.invitationId) ?? [];
        list.push({ rowId: item.row.rowId, status: "admitted", joinRequestDocId: item.docId });
        rowUpdates.set(item.invitationId, list);
      }
      results.push({ docId: item.docId, ok: true, username });
    } catch (error) {
      results.push({ docId: item.docId, ok: false, username, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [invitationId, updates] of rowUpdates) {
    await setInvitationRowStatus(tenant, admin, invitationId, updates);
  }
  return results;
}

/**
 * Purge local copies of decided or expired requests (the server purges its
 * copy on its own). Returns the purged ids.
 */
export async function purgeDecidedJoinRequests(tenant: MindooTenant): Promise<string[]> {
  const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
  await db.syncStoreChanges();
  const now = Date.now();
  const purged: string[] = [];
  for (const docId of await db.getAllDocumentIds()) {
    try {
      const data = toPlain<JoinRequestDoc>((await db.getDocument(docId)).getData());
      if (data.status === "pending" && data.expiresAt > now) continue;
    } catch {
      // unreadable: purge
    }
    await db.purgeDocumentHistory(docId);
    purged.push(docId);
  }
  return purged;
}
