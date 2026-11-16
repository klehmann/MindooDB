/**
 * Server side of the invitation / join-request inbox (docs/invitations.md).
 *
 * The server only ever sees the public part of an invitation and the outer
 * envelope of a request; the request itself is encrypted to the invitation key,
 * whose private half is sealed to the admins. It checks what it can check
 * without reading tenant data — the invitation exists and is open, the link
 * nonce is known and unused, size, rate and quota — and stores the envelope as
 * a `jr_` document in the built-in `joinrequests` database, signed with its own
 * identity key. Admitting someone stays an admin act (`approveJoinRequest`).
 *
 * Bookkeeping that must survive a purge (used nonces, distinct devices per
 * invitation) lives in `<tenant>/join-requests.json` in the server data store.
 */
import type { MindooDB, MindooTenant } from "../core/types";
import { PUBLIC_INFOS_KEY_ID, DIRECTORY_DB_ID } from "../core/types";
import { signingKeysEqual } from "../core/accesscontrol/DirectoryStateNode";
import {
  deviceKeyFingerprint,
  isValidInvitationId,
  newJoinRequestDocId,
  verifyJoinRequestEnvelope,
  verifyJoinRequestWithdrawal,
  joinRequestSummaryBytes,
  verifyEd25519,
} from "../core/joinrequests/crypto";
import {
  INVITATION_DOC_ID_PREFIX,
  JOIN_REQUESTS_DB_ID,
  JOIN_REQUEST_FORM,
  JOIN_REQUEST_TTL_MS,
  MAX_JOIN_REQUEST_BYTES,
  MAX_PENDING_JOIN_REQUESTS_PER_TENANT,
  type InvitationDoc,
  type InvitationPublicInfo,
  type JoinRequestDoc,
  type JoinRequestSubmission,
} from "../core/joinrequests/types";
import type { CryptoAdapter } from "../core/crypto/CryptoAdapter";
import type { ServerDataStore } from "./ServerDataStore";

/** HTTP-mappable failure of a join-request operation. */
export class JoinRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "JoinRequestError";
  }
}

/** What the service needs from the tenant manager (kept narrow for tests). */
export interface JoinRequestTenantAccess {
  tenantExists(tenantId: string): boolean;
  /** The server's own tenant instance (opened with the server identity and `$publicinfos`). */
  getServerTenant(tenantId: string): Promise<MindooTenant | undefined>;
  getServerSigningPublicKey(): string | null;
  /** Whether `signingKey` belongs to a member (active grant) or admin of the tenant. */
  isTenantMemberKey(tenantId: string, signingKey: string): Promise<boolean>;
  recordPurgedDocument(tenantId: string, dbId: string, docId: string): void;
  dataStore: ServerDataStore;
  tenantDataKey(tenantId: string, name: string): string;
  cryptoAdapter: CryptoAdapter;
}

export interface JoinRequestServiceOptions {
  /** Requests per client IP and hour (all tenants). Default 5. */
  maxRequestsPerIpPerHour?: number;
  /** Pending requests per tenant. Default {@link MAX_PENDING_JOIN_REQUESTS_PER_TENANT}. */
  maxPendingPerTenant?: number;
  /** Pending requests this server holds over all tenants. Default 10 000. */
  maxPendingServerWide?: number;
  /** Allowed skew between the client's `createdAt` and the server clock. Default 15 min. */
  maxClockSkewMs?: number;
  now?: () => number;
}

interface RegistryData {
  v: 1;
  /** nonceHash -> device key fingerprint that used it. */
  usedNonces: Record<string, string>;
  /** invitationId -> distinct device fingerprints that posted a request. */
  devices: Record<string, string[]>;
  /** Pending jr_ docs: docId -> { device fingerprint, invitationId, expiresAt }. */
  pending: Record<string, { device: string; invitationId: string; expiresAt: number }>;
  /** Outcome of purged requests, so the device can learn it (kept 30 days). */
  decisions: Record<string, { status: JoinRequestOutcome; at: number }>;
}

/** What a device can learn about its request. */
export type JoinRequestOutcome = "pending" | "accepted" | "rejected" | "withdrawn" | "expired" | "replaced" | "unknown";

const DECISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

export class JoinRequestService {
  private readonly registries = new Map<string, RegistryData>();
  private readonly ipHits = new Map<string, number[]>();
  private readonly lastStatusSweep = new Map<string, number>();
  /** Serializes writes per tenant (registry + doc create). */
  private readonly tenantLocks = new Map<string, Promise<unknown>>();
  private readonly options: Required<Omit<JoinRequestServiceOptions, "now">> & { now: () => number };

  constructor(
    private readonly access: JoinRequestTenantAccess,
    options: JoinRequestServiceOptions = {},
  ) {
    this.options = {
      maxRequestsPerIpPerHour: options.maxRequestsPerIpPerHour ?? 5,
      maxPendingPerTenant: options.maxPendingPerTenant ?? MAX_PENDING_JOIN_REQUESTS_PER_TENANT,
      maxPendingServerWide: options.maxPendingServerWide ?? 10_000,
      maxClockSkewMs: options.maxClockSkewMs ?? 15 * 60 * 1000,
      now: options.now ?? (() => Date.now()),
    };
  }

  // ---------------------------------------------------------------------------
  // Public invitation info
  // ---------------------------------------------------------------------------

  async getInvitation(tenantId: string, invitationId: string): Promise<InvitationPublicInfo> {
    const tenant = await this.requireTenant(tenantId);
    const invitation = await this.readInvitation(tenant, invitationId);
    if (!invitation) throw new JoinRequestError(404, "Invitation not found", "invitation_not_found");
    return {
      tenantId: tenantId.toLowerCase(),
      invitationId: invitation.invitationId,
      kind: invitation.kind,
      publicKey: invitation.publicKey,
      keyFingerprint: invitation.keyFingerprint,
      expiresAt: invitation.expiresAt,
      ended: invitation.ended === true,
      ...(typeof invitation.maxUses === "number" ? { maxUses: invitation.maxUses } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async submit(
    tenantId: string,
    body: unknown,
    clientIp: string,
  ): Promise<{ id: string; expiresAt: number; replaced: string[] }> {
    const normalizedTenantId = tenantId.toLowerCase();
    const submission = this.parseSubmission(body, normalizedTenantId);
    this.takeIpBudget(clientIp);
    const tenant = await this.requireTenant(normalizedTenantId);
    return this.withTenantLock(normalizedTenantId, () => this.submitLocked(normalizedTenantId, tenant, submission));
  }

  private async submitLocked(
    tenantId: string,
    tenant: MindooTenant,
    submission: JoinRequestSubmission,
  ): Promise<{ id: string; expiresAt: number; replaced: string[] }> {
    const now = this.options.now();
    const subtle = this.access.cryptoAdapter.getSubtle();

    if (Math.abs(now - submission.createdAt) > this.options.maxClockSkewMs) {
      throw new JoinRequestError(400, "Request time is too far from the server clock", "clock_skew");
    }
    if (!(await verifyJoinRequestEnvelope(subtle, submission))) {
      throw new JoinRequestError(400, "Invalid device signature", "bad_signature");
    }

    const invitation = await this.readInvitation(tenant, submission.invitationId);
    if (!invitation) throw new JoinRequestError(404, "Invitation not found", "invitation_not_found");
    if (invitation.ended) throw new JoinRequestError(410, "This invitation has been ended", "invitation_ended");
    if (invitation.expiresAt <= now) throw new JoinRequestError(410, "This invitation has expired", "invitation_expired");
    const serverKey = this.access.getServerSigningPublicKey();
    if (!serverKey) throw new JoinRequestError(503, "Server identity not initialized", "no_server_identity");
    if (invitation.serverSigningPublicKey && !signingKeysEqual(invitation.serverSigningPublicKey, serverKey)) {
      throw new JoinRequestError(409, "This invitation belongs to another server", "wrong_server");
    }

    const registry = this.registry(tenantId);
    this.expireRegistry(registry, now);
    const device = await deviceKeyFingerprint(subtle, submission.deviceSigningPublicKey);

    if (invitation.kind === "personal") {
      if (!submission.nonceHash || !invitation.nonceHashes.includes(submission.nonceHash)) {
        throw new JoinRequestError(403, "This invitation link is not valid", "unknown_nonce");
      }
      const usedBy = registry.usedNonces[submission.nonceHash];
      if (usedBy && usedBy !== device) {
        throw new JoinRequestError(409, "This invitation link was already used", "nonce_used");
      }
    } else if (submission.nonceHash) {
      throw new JoinRequestError(400, "A shared invitation link carries no nonce", "unexpected_nonce");
    }

    const devices = registry.devices[invitation.invitationId] ?? [];
    if (
      typeof invitation.maxUses === "number" &&
      !devices.includes(device) &&
      devices.length >= invitation.maxUses
    ) {
      throw new JoinRequestError(409, "This invitation has been used up", "invitation_used_up");
    }

    // A newer request from the same device for the same invitation replaces the old one.
    const replaced = Object.entries(registry.pending)
      .filter(([, entry]) => entry.device === device && entry.invitationId === invitation.invitationId)
      .map(([docId]) => docId);
    const pendingAfter = Object.keys(registry.pending).length - replaced.length;
    if (pendingAfter >= this.options.maxPendingPerTenant) {
      throw new JoinRequestError(429, "Too many open join requests for this tenant", "tenant_quota");
    }
    if (this.serverWidePending() - replaced.length >= this.options.maxPendingServerWide) {
      throw new JoinRequestError(429, "Too many open join requests on this server", "server_quota");
    }

    const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
    const docId = newJoinRequestDocId(this.access.cryptoAdapter);
    const expiresAt = now + JOIN_REQUEST_TTL_MS;
    const doc: JoinRequestDoc = {
      form: JOIN_REQUEST_FORM,
      invitationId: invitation.invitationId,
      ...(submission.nonceHash ? { nonceHash: submission.nonceHash } : {}),
      status: "pending",
      receivedAt: now,
      expiresAt,
      deviceKeyFingerprint: device,
      deviceSigningPublicKey: submission.deviceSigningPublicKey,
      createdAt: submission.createdAt,
      sealedRequest: submission.sealedRequest,
      signature: submission.signature,
    };
    await db.createDocument({
      id: docId,
      assumeUniqueId: true,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: doc as unknown as Record<string, unknown>,
      bypassAccessControlPrecheck: true,
    });

    for (const oldId of replaced) {
      await this.purge(tenantId, db, oldId);
      delete registry.pending[oldId];
      registry.decisions[oldId] = { status: "replaced", at: now };
    }
    registry.pending[docId] = { device, invitationId: invitation.invitationId, expiresAt };
    if (submission.nonceHash) registry.usedNonces[submission.nonceHash] = device;
    if (!devices.includes(device)) registry.devices[invitation.invitationId] = [...devices, device];
    this.saveRegistry(tenantId, registry);
    return { id: docId, expiresAt, replaced };
  }

  // ---------------------------------------------------------------------------
  // Status and withdraw (joining device)
  // ---------------------------------------------------------------------------

  /**
   * Outcome of a request by its id. The id is 128 random bits only the device
   * (and the admins) know, and the answer carries no tenant data.
   */
  async status(tenantId: string, docId: string): Promise<{ id: string; status: JoinRequestOutcome; expiresAt?: number }> {
    const normalizedTenantId = tenantId.toLowerCase();
    if (!/^jr_[a-z2-7]{16,64}$/.test(docId)) throw new JoinRequestError(400, "Invalid request id", "bad_request");
    if (!this.access.tenantExists(normalizedTenantId)) {
      throw new JoinRequestError(404, "Tenant not found on server", "tenant_not_found");
    }
    // Decisions become visible once the server has looked at the inbox.
    const now = this.options.now();
    if (now - (this.lastStatusSweep.get(normalizedTenantId) ?? 0) > 30_000) {
      this.lastStatusSweep.set(normalizedTenantId, now);
      await this.sweep(normalizedTenantId).catch(() => undefined);
    }
    const registry = this.registry(normalizedTenantId);
    const pending = registry.pending[docId];
    if (pending) return { id: docId, status: "pending", expiresAt: pending.expiresAt };
    return { id: docId, status: registry.decisions[docId]?.status ?? "unknown" };
  }

  /**
   * The device takes its request back: the server purges it. Signed by the
   * device key that sent it, over `["withdraw", tenantId, id, createdAt]`.
   */
  async withdraw(tenantId: string, docId: string, body: unknown): Promise<{ id: string; status: "withdrawn" }> {
    const normalizedTenantId = tenantId.toLowerCase();
    const b = (body ?? {}) as Record<string, unknown>;
    const deviceSigningPublicKey = typeof b.deviceSigningPublicKey === "string" ? b.deviceSigningPublicKey : "";
    const signature = typeof b.signature === "string" ? b.signature : "";
    const createdAt = typeof b.createdAt === "number" ? b.createdAt : NaN;
    if (!deviceSigningPublicKey || deviceSigningPublicKey.length > 1024 || !signature || signature.length > 256 || !Number.isFinite(createdAt)) {
      throw new JoinRequestError(400, "Invalid withdraw request", "bad_request");
    }
    if (Math.abs(this.options.now() - createdAt) > this.options.maxClockSkewMs) {
      throw new JoinRequestError(400, "Request time is too far from the server clock", "clock_skew");
    }
    const subtle = this.access.cryptoAdapter.getSubtle();
    if (!(await verifyJoinRequestWithdrawal(subtle, { tenantId: normalizedTenantId, docId, createdAt, deviceSigningPublicKey, signature }))) {
      throw new JoinRequestError(400, "Invalid device signature", "bad_signature");
    }
    const tenant = await this.requireTenant(normalizedTenantId);
    return this.withTenantLock(normalizedTenantId, async () => {
      const registry = this.registry(normalizedTenantId);
      const pending = registry.pending[docId];
      if (!pending) throw new JoinRequestError(404, "No open request with this id", "not_found");
      if (pending.device !== (await deviceKeyFingerprint(subtle, deviceSigningPublicKey))) {
        throw new JoinRequestError(403, "This request belongs to another device", "wrong_device");
      }
      const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
      await this.purge(normalizedTenantId, db, docId);
      delete registry.pending[docId];
      registry.decisions[docId] = { status: "withdrawn", at: this.options.now() };
      this.saveRegistry(normalizedTenantId, registry);
      return { id: docId, status: "withdrawn" as const };
    });
  }

  /**
   * Number of pending requests, for the "N new requests" hint on a member
   * device that has not unlocked an admin key. Signed by a granted device;
   * reveals a count, nothing else.
   */
  async summary(tenantId: string, body: unknown): Promise<{ pending: number }> {
    const normalizedTenantId = tenantId.toLowerCase();
    const b = (body ?? {}) as Record<string, unknown>;
    const deviceSigningPublicKey = typeof b.deviceSigningPublicKey === "string" ? b.deviceSigningPublicKey : "";
    const signature = typeof b.signature === "string" ? b.signature : "";
    const createdAt = typeof b.createdAt === "number" ? b.createdAt : NaN;
    if (!deviceSigningPublicKey || deviceSigningPublicKey.length > 1024 || !signature || signature.length > 256 || !Number.isFinite(createdAt)) {
      throw new JoinRequestError(400, "Invalid summary request", "bad_request");
    }
    if (Math.abs(this.options.now() - createdAt) > this.options.maxClockSkewMs) {
      throw new JoinRequestError(400, "Request time is too far from the server clock", "clock_skew");
    }
    const subtle = this.access.cryptoAdapter.getSubtle();
    const bytes = joinRequestSummaryBytes({ tenantId: normalizedTenantId, createdAt });
    if (!(await verifyEd25519(subtle, deviceSigningPublicKey, signature, bytes))) {
      throw new JoinRequestError(400, "Invalid device signature", "bad_signature");
    }
    if (!this.access.tenantExists(normalizedTenantId)) {
      throw new JoinRequestError(404, "Tenant not found on server", "tenant_not_found");
    }
    if (!(await this.access.isTenantMemberKey(normalizedTenantId, deviceSigningPublicKey))) {
      throw new JoinRequestError(403, "Not a member of this tenant", "not_member");
    }
    const registry = this.registry(normalizedTenantId);
    this.expireRegistry(registry, this.options.now());
    return { pending: Object.keys(registry.pending).length };
  }

  // ---------------------------------------------------------------------------
  // Sweep
  // ---------------------------------------------------------------------------

  /**
   * Purge expired requests and requests an admin decided (status other than
   * `pending`). Runs after admin pushes and on a timer. Returns the purged ids.
   */
  async sweep(tenantId: string): Promise<string[]> {
    const normalizedTenantId = tenantId.toLowerCase();
    if (!this.access.tenantExists(normalizedTenantId)) return [];
    const tenant = await this.access.getServerTenant(normalizedTenantId);
    if (!tenant) return [];
    return this.withTenantLock(normalizedTenantId, async () => {
      const now = this.options.now();
      const db = await tenant.openDB(JOIN_REQUESTS_DB_ID);
      await db.syncStoreChanges();
      const registry = this.registry(normalizedTenantId);
      const purged: string[] = [];
      for (const docId of await db.getAllDocumentIds()) {
        let data: Partial<JoinRequestDoc> | null = null;
        try {
          data = (await db.getDocument(docId)).getData() as Partial<JoinRequestDoc>;
        } catch {
          data = null;
        }
        const expired = typeof data?.expiresAt === "number" && data.expiresAt <= now;
        const decided = data?.status !== undefined && data.status !== "pending";
        if (data && !expired && !decided) continue;
        await this.purge(normalizedTenantId, db, docId);
        delete registry.pending[docId];
        const status = data?.status;
        registry.decisions[docId] = {
          status:
            status === "accepted" || status === "rejected" || status === "withdrawn"
              ? status
              : expired
                ? "expired"
                : "unknown",
          at: now,
        };
        purged.push(docId);
      }
      for (const docId of await db.getDeletedDocumentIds().catch(() => [] as string[])) {
        await this.purge(normalizedTenantId, db, docId);
        delete registry.pending[docId];
        purged.push(docId);
      }
      this.expireRegistry(registry, now);
      this.saveRegistry(normalizedTenantId, registry);
      return purged;
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async purge(tenantId: string, db: MindooDB, docId: string): Promise<void> {
    await db.purgeDocumentHistory(docId);
    // Re-uploads of this document by an admin replica that still holds it are refused.
    this.access.recordPurgedDocument(tenantId, JOIN_REQUESTS_DB_ID, docId);
  }

  private async requireTenant(tenantId: string): Promise<MindooTenant> {
    if (!this.access.tenantExists(tenantId)) {
      throw new JoinRequestError(404, "Tenant not found on server", "tenant_not_found");
    }
    const tenant = await this.access.getServerTenant(tenantId);
    if (!tenant) {
      throw new JoinRequestError(
        503,
        "This server cannot read the tenant directory (no $publicinfos key or server identity)",
        "no_directory",
      );
    }
    return tenant;
  }

  private async readInvitation(tenant: MindooTenant, invitationId: string): Promise<InvitationDoc | null> {
    if (!isValidInvitationId(invitationId)) return null;
    const directory = await tenant.openDB(DIRECTORY_DB_ID, { adminOnlyDb: true });
    await directory.syncStoreChanges();
    try {
      const doc = await directory.getDocument(`${INVITATION_DOC_ID_PREFIX}${invitationId}`);
      const data = doc.getData() as Partial<InvitationDoc>;
      if (data.invitationId !== invitationId || typeof data.publicKey !== "string") return null;
      return {
        ...(data as InvitationDoc),
        nonceHashes: Array.isArray(data.nonceHashes) ? data.nonceHashes.map(String) : [],
      };
    } catch {
      return null;
    }
  }

  private parseSubmission(body: unknown, tenantId: string): JoinRequestSubmission {
    const size = JSON.stringify(body ?? null).length;
    if (size > MAX_JOIN_REQUEST_BYTES) {
      throw new JoinRequestError(413, `Join request too large (max ${MAX_JOIN_REQUEST_BYTES} bytes)`, "too_large");
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const str = (key: string, max: number): string => {
      const value = b[key];
      if (typeof value !== "string" || !value || value.length > max) {
        throw new JoinRequestError(400, `Invalid or missing "${key}"`, "bad_request");
      }
      return value;
    };
    if (b.v !== 1) throw new JoinRequestError(400, "Unsupported join request version", "bad_request");
    const submission: JoinRequestSubmission = {
      v: 1,
      tenantId: str("tenantId", 128).toLowerCase(),
      invitationId: str("invitationId", 64),
      deviceSigningPublicKey: str("deviceSigningPublicKey", 1024),
      createdAt: typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : NaN,
      sealedRequest: str("sealedRequest", MAX_JOIN_REQUEST_BYTES),
      signature: str("signature", 256),
    };
    if (b.nonceHash !== undefined) submission.nonceHash = str("nonceHash", 128);
    if (!Number.isFinite(submission.createdAt)) {
      throw new JoinRequestError(400, 'Invalid or missing "createdAt"', "bad_request");
    }
    if (submission.tenantId !== tenantId) {
      throw new JoinRequestError(400, "Tenant id does not match the URL", "bad_request");
    }
    if (!isValidInvitationId(submission.invitationId)) {
      throw new JoinRequestError(400, "Invalid invitation id", "bad_request");
    }
    return submission;
  }

  private takeIpBudget(ip: string): void {
    const now = this.options.now();
    const hits = (this.ipHits.get(ip) ?? []).filter((time) => time > now - HOUR_MS);
    if (hits.length >= this.options.maxRequestsPerIpPerHour) {
      this.ipHits.set(ip, hits);
      throw new JoinRequestError(429, "Too many join requests, please try again later", "rate_limited");
    }
    hits.push(now);
    this.ipHits.set(ip, hits);
    if (this.ipHits.size > 10_000) {
      for (const [key, times] of this.ipHits) {
        if (!times.some((time) => time > now - HOUR_MS)) this.ipHits.delete(key);
      }
    }
  }

  private serverWidePending(): number {
    let total = 0;
    for (const registry of this.registries.values()) total += Object.keys(registry.pending).length;
    return total;
  }

  private registry(tenantId: string): RegistryData {
    let registry = this.registries.get(tenantId);
    if (registry) return registry;
    registry = { v: 1, usedNonces: {}, devices: {}, pending: {}, decisions: {} };
    try {
      const raw = this.access.dataStore.readText(this.access.tenantDataKey(tenantId, "join-requests.json"));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<RegistryData>;
        registry = {
          v: 1,
          usedNonces: parsed.usedNonces && typeof parsed.usedNonces === "object" ? parsed.usedNonces : {},
          devices: parsed.devices && typeof parsed.devices === "object" ? parsed.devices : {},
          pending: parsed.pending && typeof parsed.pending === "object" ? parsed.pending : {},
          decisions: parsed.decisions && typeof parsed.decisions === "object" ? parsed.decisions : {},
        };
      }
    } catch (error) {
      console.warn(`[JoinRequestService] could not read registry of ${tenantId}: ${error}`);
    }
    this.registries.set(tenantId, registry);
    return registry;
  }

  private expireRegistry(registry: RegistryData, now: number): void {
    for (const [docId, entry] of Object.entries(registry.pending)) {
      if (entry.expiresAt <= now) {
        delete registry.pending[docId];
        registry.decisions[docId] = { status: "expired", at: now };
      }
    }
    for (const [docId, decision] of Object.entries(registry.decisions)) {
      if (decision.at < now - DECISION_RETENTION_MS) delete registry.decisions[docId];
    }
  }

  private saveRegistry(tenantId: string, registry: RegistryData): void {
    this.access.dataStore.writeText(
      this.access.tenantDataKey(tenantId, "join-requests.json"),
      JSON.stringify(registry),
    );
  }

  private async withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tenantLocks.get(tenantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.tenantLocks.set(tenantId, run);
    try {
      return await run;
    } finally {
      if (this.tenantLocks.get(tenantId) === run) this.tenantLocks.delete(tenantId);
    }
  }
}
