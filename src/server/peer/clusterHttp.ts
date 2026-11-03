/**
 * HTTP surface for clustering, in two strictly separated halves, as
 * platform-neutral handlers (hosts mount them; see `node/server/peer/routes.ts`).
 *
 * - {@link PeerHttpHandlers} serve `/system/peer/*`: the server-to-server
 *   protocol. Callers authenticate as a server listed in
 *   `trusted-servers.json` and receive a peer JWT. No route here can
 *   administer anything.
 * - {@link ClusterAdminHandlers} serve `/system/cluster/*`: the admin surface
 *   for humans and consoles. Callers authenticate with a system-admin JWT and
 *   pass the {@link CapabilityMatcher}. No route here can write entries.
 *
 * The split is the point. A peer must be able to replicate without being able
 * to reconfigure the node it replicates with, and an operator must be able to
 * administer without being able to forge data as a server identity.
 *
 * ## Fan-out, not proxy
 *
 * Every read endpoint answers for **this node only**. A console that wants a
 * cluster-wide view calls each node in turn and merges. The alternative — one
 * node proxying admin reads to its peers — would need an admin credential that
 * spans servers, and peers are separately administered by design: they trust
 * each other with encrypted data, not with each other's administration.
 *
 * ## Admin-blindness
 *
 * Nothing here returns a document id, an author key, or entry content. Status,
 * jobs and audit records carry counts, tenant/database ids and classified
 * reasons. A read-only auditor role must not become a metadata oracle over
 * data the server itself cannot decrypt.
 */

import type { StoreIdBloomSummary } from "../../core/appendonlystores/types";
import { bloomMightContainId } from "../../core/appendonlystores/bloom";
import { base64ToBytes } from "../../core/utils/base64";
import type { SyncChangeEvent } from "../SyncEventBus";
import type { TrustedServer } from "../types";
import { jsonResponse, type ServerRequest, type ServerResponse } from "../http/types";
import type { ClusterManager } from "./ClusterManager";
import {
  isPeerAttachmentMode,
  isPeerRole,
  isPeerSyncDirection,
  type ClusterJobKind,
  type ClusterJobScope,
} from "./types";

export interface PeerHttpDeps {
  cluster: ClusterManager;
  listTenants(): string[];
  listDatabases(tenantId: string): string[] | Promise<string[]>;
}

/** Bound so a malicious or broken peer cannot make us allocate without limit. */
const MAX_BLOOM_BITS = 1 << 22;

/**
 * `event: change` frame of the peer feed for `peerName`, or null when the
 * peer must not hear about it: its own push (it would pull back what it just
 * sent — the peer suppresses echoes too, but this saves the round trip), or a
 * tenant outside the peer's last intersection.
 */
export function formatPeerChangeEvent(
  cluster: ClusterManager,
  peerName: string,
  event: SyncChangeEvent,
): string | null {
  if (event.originPeer === peerName) return null;
  if (!cluster.peerMaySeeTenant(peerName, event.tenantId)) return null;
  return `event: change\ndata: ${JSON.stringify({
    tenantId: event.tenantId,
    dbId: event.dbId,
    storeKind: event.storeKind,
    epoch: event.epoch,
    maxReceiptOrder: event.maxReceiptOrder,
  })}\n\n`;
}

export class PeerHttpHandlers {
  constructor(private readonly deps: PeerHttpDeps) {}

  /** Peer JWT check; sets `req.peerName`. */
  async peerGuard(req: ServerRequest): Promise<ServerResponse | null> {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return jsonResponse(401, { error: "Missing or invalid Authorization header" });
    }
    const payload = await this.deps.cluster.auth.validateToken(auth.substring(7));
    if (!payload) {
      return jsonResponse(401, { error: "Invalid or expired peer token" });
    }
    req.peerName = payload.sub;
    return null;
  }

  async challenge(req: ServerRequest): Promise<ServerResponse> {
    const { publicsignkey } = (req.body ?? {}) as { publicsignkey?: string };
    if (typeof publicsignkey !== "string" || publicsignkey.length === 0) {
      return jsonResponse(400, { error: "publicsignkey is required" });
    }
    try {
      return jsonResponse(200, { challenge: await this.deps.cluster.auth.generateChallenge(publicsignkey) });
    } catch {
      // Deliberately the same shape as a signature failure: an unauthenticated
      // caller must not be able to enumerate which servers we trust.
      return jsonResponse(401, { error: "Unknown peer" });
    }
  }

  async authenticate(req: ServerRequest): Promise<ServerResponse> {
    const { challenge, signature } = (req.body ?? {}) as { challenge?: string; signature?: string };
    if (typeof challenge !== "string" || typeof signature !== "string") {
      return jsonResponse(400, { error: "challenge and signature are required" });
    }
    const result = await this.deps.cluster.auth.authenticate(challenge, base64ToBytes(signature));
    if (!result.success) {
      return jsonResponse(401, { error: result.error ?? "Authentication failed" });
    }
    return jsonResponse(200, { success: true, token: result.token });
  }

  /**
   * Tenant intersection.
   *
   * The caller sends a Bloom summary of the tenants it hosts; we answer with
   * the ids on *our* side that the filter might contain. Neither server ever
   * transmits its full tenant list, so a peer learns nothing about tenants it
   * does not already host. False positives are harmless: the caller intersects
   * the answer against its own authoritative list before replicating anything.
   */
  tenantBloom(req: ServerRequest): ServerResponse {
    const { bloom } = (req.body ?? {}) as { bloom?: StoreIdBloomSummary };
    if (!bloom || typeof bloom !== "object") {
      return jsonResponse(400, { error: "bloom summary is required" });
    }
    if (typeof bloom.bitCount !== "number" || bloom.bitCount <= 0 || bloom.bitCount > MAX_BLOOM_BITS) {
      return jsonResponse(400, { error: "Invalid bloom summary" });
    }

    const candidates = this.deps
      .listTenants()
      .filter((tenantId) => bloomMightContainId(bloom, tenantId));

    // Remember what this peer may see, so the event stream can be filtered to
    // the same set instead of announcing every tenant we host.
    this.deps.cluster.recordPeerIntersection(req.peerName as string, candidates);
    return jsonResponse(200, { tenantIds: candidates });
  }

  async databases(req: ServerRequest): Promise<ServerResponse> {
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : "";
    if (!tenantId) {
      return jsonResponse(400, { error: "tenantId is required" });
    }
    if (!this.deps.cluster.peerMaySeeTenant(req.peerName as string, tenantId)) {
      return jsonResponse(404, { error: "Tenant not found" });
    }
    return jsonResponse(200, { databases: await this.deps.listDatabases(tenantId) });
  }

  /**
   * Catch-up trigger from the calling peer.
   *
   * Peer A tells us "I have something for you"; we run our own replicator
   * toward A, which pulls it. Doing it this way rather than having A push
   * directly keeps one replicator per link in charge of cursors and ordering,
   * so the invariants hold no matter which side noticed the change first.
   *
   * `run` receives the replication; fire-and-forget on Node, a host that must
   * keep work alive after the response hands it to its scheduler.
   */
  sync(req: ServerRequest, run: (task: Promise<unknown>) => void = (task) => void task): ServerResponse {
    const peerName = req.peerName as string;
    const replicator = this.deps.cluster.getReplicator(peerName);
    if (!replicator) {
      return jsonResponse(409, {
        error: `No outbound session configured for peer ${peerName} (missing url in trusted-servers.json)`,
      });
    }
    const { tenantId, dbId } = (req.body ?? {}) as { tenantId?: string; dbId?: string };
    // Fire and forget: the caller only needs to know we accepted the hint, and
    // holding the connection open for a full mirror would time out.
    run(replicator.syncNow({ tenantId, dbId }).catch(() => undefined));
    return jsonResponse(202, { accepted: true });
  }
}

export interface ClusterAdminDeps {
  cluster: ClusterManager;
  /** Read `trusted-servers.json`; used by peer CRUD. */
  listTrustedServers(): TrustedServer[];
  /** Persist a peer entry (add or replace by name). */
  saveTrustedServer(peer: TrustedServer): void;
  /** Remove a peer entry by name; false when it did not exist. */
  removeTrustedServer(name: string): boolean;
}

const ACTION_KINDS: Record<string, ClusterJobKind> = {
  sync: "sync",
  "retry-rejected": "retry-rejected",
  "refresh-intersection": "refresh-intersection",
  pause: "pause",
  resume: "resume",
};

/**
 * Admin surface. The host runs these behind the system-admin JWT guard, so
 * capability rules in `config.json` decide who may read
 * (`GET /system/cluster/*`) and who may act (`POST`, `PATCH`, `DELETE`) —
 * that is how an auditor role gets status without getting control.
 *
 * Route parameters arrive as the host's router decoded them.
 */
export class ClusterAdminHandlers {
  constructor(private readonly deps: ClusterAdminDeps) {}

  private actor(req: ServerRequest): string {
    return req.systemAdmin?.username ?? "unknown";
  }

  topology(): ServerResponse {
    return jsonResponse(200, this.deps.cluster.topology());
  }

  status(): ServerResponse {
    return jsonResponse(200, this.deps.cluster.status());
  }

  tenantStatus(req: ServerRequest): ServerResponse {
    return jsonResponse(200, this.deps.cluster.tenantStatus((req.params.tenantId ?? "").toLowerCase()));
  }

  jobs(req: ServerRequest): ServerResponse {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    return jsonResponse(200, { jobs: this.deps.cluster.jobs.list(Number.isFinite(limit) ? limit : 50) });
  }

  job(req: ServerRequest): ServerResponse {
    const job = this.deps.cluster.jobs.get(req.params.jobId ?? "");
    if (!job) {
      return jsonResponse(404, { error: "Job not found" });
    }
    return jsonResponse(200, job);
  }

  audit(req: ServerRequest): ServerResponse {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    return jsonResponse(
      200,
      this.deps.cluster.audit.read({ limit: Number.isFinite(limit) ? limit : 50, before }),
    );
  }

  action(req: ServerRequest): ServerResponse {
    const kind = ACTION_KINDS[req.params.action ?? ""];
    if (!kind) {
      return jsonResponse(404, { error: `Unknown action: ${req.params.action}` });
    }
    const body = (req.body ?? {}) as ClusterJobScope;
    const scope: ClusterJobScope = {
      peer: typeof body.peer === "string" ? body.peer : undefined,
      tenantId: typeof body.tenantId === "string" ? body.tenantId.toLowerCase() : undefined,
      dbId: typeof body.dbId === "string" ? body.dbId : undefined,
    };

    const outcome = this.deps.cluster.runAction(kind, scope, this.actor(req));
    if (!outcome.accepted) {
      return jsonResponse(400, { error: outcome.error });
    }
    // 202: the job is queued, not finished. Poll GET /jobs/:jobId.
    return jsonResponse(202, { jobId: outcome.job.id, job: outcome.job });
  }

  peers(): ServerResponse {
    return jsonResponse(200, { peers: this.deps.cluster.topology().peers });
  }

  createPeer(req: ServerRequest): ServerResponse {
    return this.upsertPeer(req, "peer-create");
  }

  updatePeer(req: ServerRequest): ServerResponse {
    return this.upsertPeer(req, "peer-update");
  }

  deletePeer(req: ServerRequest): ServerResponse {
    const name = decodeURIComponent(req.params.name ?? "");
    if (!this.deps.removeTrustedServer(name)) {
      return jsonResponse(404, { error: "Peer not found" });
    }
    this.deps.cluster.syncReplicators();
    this.deps.cluster.auditPeerChange("peer-delete", name, this.actor(req));
    return jsonResponse(200, { success: true });
  }

  private upsertPeer(req: ServerRequest, action: "peer-create" | "peer-update"): ServerResponse {
    const name = decodeURIComponent(req.params.name ?? "");
    const existing = this.deps.listTrustedServers().find((peer) => peer.name === name);

    if (action === "peer-create" && existing) {
      return jsonResponse(409, { error: "Peer already exists" });
    }
    if (action === "peer-update" && !existing) {
      return jsonResponse(404, { error: "Peer not found" });
    }

    const body = (req.body ?? {}) as Partial<TrustedServer>;
    const signingPublicKey = body.signingPublicKey ?? existing?.signingPublicKey;
    const encryptionPublicKey = body.encryptionPublicKey ?? existing?.encryptionPublicKey;
    if (!signingPublicKey || !encryptionPublicKey) {
      return jsonResponse(400, { error: "signingPublicKey and encryptionPublicKey are required" });
    }
    for (const [field, guard] of [
      ["direction", isPeerSyncDirection],
      ["role", isPeerRole],
      ["attachments", isPeerAttachmentMode],
    ] as const) {
      const value = body[field];
      if (value !== undefined && !guard(value)) {
        return jsonResponse(400, { error: `Invalid ${field}: ${String(value)}` });
      }
    }

    const peer: TrustedServer = {
      ...existing,
      name,
      signingPublicKey,
      encryptionPublicKey,
      url: body.url ?? existing?.url,
      direction: body.direction ?? existing?.direction,
      role: body.role ?? existing?.role,
      attachments: body.attachments ?? existing?.attachments,
    };

    this.deps.saveTrustedServer(peer);
    this.deps.cluster.syncReplicators();
    this.deps.cluster.auditPeerChange(action, name, this.actor(req));
    return jsonResponse(action === "peer-create" ? 201 : 200, { success: true, peer });
  }
}
