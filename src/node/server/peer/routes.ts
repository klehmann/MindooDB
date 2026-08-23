/**
 * HTTP surface for clustering, in two strictly separated halves.
 *
 * - {@link createPeerRouter} serves `/system/peer/*`: the server-to-server
 *   protocol. Callers authenticate as a server listed in
 *   `trusted-servers.json` and receive a peer JWT. No route here can
 *   administer anything.
 * - {@link createClusterRouter} serves `/system/cluster/*`: the admin surface
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

import { Router, type Request, type Response, type NextFunction } from "express";
import type { StoreIdBloomSummary } from "../../../core/appendonlystores/types";
import { bloomMightContainId } from "../../../core/appendonlystores/bloom";
import type { SyncEventBus } from "../SyncEventBus";
import type { ClusterManager } from "./ClusterManager";
import type { TrustedServer } from "../types";
import {
  isPeerAttachmentMode,
  isPeerRole,
  isPeerSyncDirection,
  type ClusterJobKind,
  type ClusterJobScope,
} from "./types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Trusted-server name, set by the peer router's auth middleware. */
      peerName?: string;
    }
  }
}

export interface PeerRouterDeps {
  cluster: ClusterManager;
  eventBus: SyncEventBus;
  listTenants(): string[];
  listDatabases(tenantId: string): string[];
}

/** Bound so a malicious or broken peer cannot make us allocate without limit. */
const MAX_BLOOM_BITS = 1 << 22;

export function createPeerRouter(deps: PeerRouterDeps): Router {
  const router = Router();
  const { cluster } = deps;

  const requirePeer = async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const payload = await cluster.auth.validateToken(auth.substring(7));
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired peer token" });
      return;
    }
    req.peerName = payload.sub;
    next();
  };

  router.post("/challenge", async (req: Request, res: Response) => {
    const { publicsignkey } = req.body as { publicsignkey?: string };
    if (typeof publicsignkey !== "string" || publicsignkey.length === 0) {
      res.status(400).json({ error: "publicsignkey is required" });
      return;
    }
    try {
      res.json({ challenge: await cluster.auth.generateChallenge(publicsignkey) });
    } catch {
      // Deliberately the same shape as a signature failure: an unauthenticated
      // caller must not be able to enumerate which servers we trust.
      res.status(401).json({ error: "Unknown peer" });
    }
  });

  router.post("/authenticate", async (req: Request, res: Response) => {
    const { challenge, signature } = req.body as { challenge?: string; signature?: string };
    if (typeof challenge !== "string" || typeof signature !== "string") {
      res.status(400).json({ error: "challenge and signature are required" });
      return;
    }
    const result = await cluster.auth.authenticate(
      challenge,
      new Uint8Array(Buffer.from(signature, "base64")),
    );
    if (!result.success) {
      res.status(401).json({ error: result.error ?? "Authentication failed" });
      return;
    }
    res.json({ success: true, token: result.token });
  });

  /**
   * Tenant intersection.
   *
   * The caller sends a Bloom summary of the tenants it hosts; we answer with
   * the ids on *our* side that the filter might contain. Neither server ever
   * transmits its full tenant list, so a peer learns nothing about tenants it
   * does not already host. False positives are harmless: the caller intersects
   * the answer against its own authoritative list before replicating anything.
   */
  router.post("/tenant-bloom", requirePeer, (req: Request, res: Response) => {
    const { bloom } = req.body as { bloom?: StoreIdBloomSummary };
    if (!bloom || typeof bloom !== "object") {
      res.status(400).json({ error: "bloom summary is required" });
      return;
    }
    if (typeof bloom.bitCount !== "number" || bloom.bitCount <= 0 || bloom.bitCount > MAX_BLOOM_BITS) {
      res.status(400).json({ error: "Invalid bloom summary" });
      return;
    }

    const candidates = deps
      .listTenants()
      .filter((tenantId) => bloomMightContainId(bloom, tenantId));

    // Remember what this peer may see, so the event stream can be filtered to
    // the same set instead of announcing every tenant we host.
    cluster.recordPeerIntersection(req.peerName as string, candidates);
    res.json({ tenantIds: candidates });
  });

  router.get("/databases", requirePeer, (req: Request, res: Response) => {
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : "";
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }
    if (!cluster.peerMaySeeTenant(req.peerName as string, tenantId)) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    res.json({ databases: deps.listDatabases(tenantId) });
  });

  /**
   * Change feed for peers, across every shared tenant.
   *
   * The tenant-scoped client feed cannot serve this: a peer has no per-tenant
   * grant and would need one subscription per tenant and store kind. Events
   * carry metadata only, and only for tenants the last intersection put on both
   * sides.
   */
  router.get("/events", requirePeer, (req: Request, res: Response) => {
    const peerName = req.peerName as string;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    if (!req.httpVersion.startsWith("2")) {
      res.setHeader("Connection", "keep-alive");
    }
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ protocolVersion: "sync-v5" })}\n\n`);

    const unsubscribe = deps.eventBus.subscribe((event) => {
      // Never tell a peer about its own push: it would pull back what it just
      // sent. The peer suppresses echoes too, but doing it here saves the
      // round trip entirely.
      if (event.originPeer === peerName) return;
      if (!cluster.peerMaySeeTenant(peerName, event.tenantId)) return;
      res.write(
        `event: change\ndata: ${JSON.stringify({
          tenantId: event.tenantId,
          dbId: event.dbId,
          storeKind: event.storeKind,
          epoch: event.epoch,
          maxReceiptOrder: event.maxReceiptOrder,
        })}\n\n`,
      );
    });

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 30_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  /**
   * Catch-up trigger from the calling peer.
   *
   * Peer A tells us "I have something for you"; we run our own replicator
   * toward A, which pulls it. Doing it this way rather than having A push
   * directly keeps one replicator per link in charge of cursors and ordering,
   * so the invariants hold no matter which side noticed the change first.
   */
  router.post("/sync", requirePeer, (req: Request, res: Response) => {
    const peerName = req.peerName as string;
    const replicator = cluster.getReplicator(peerName);
    if (!replicator) {
      res.status(409).json({
        error: `No outbound session configured for peer ${peerName} (missing url in trusted-servers.json)`,
      });
      return;
    }
    const { tenantId, dbId } = (req.body ?? {}) as { tenantId?: string; dbId?: string };
    // Fire and forget: the caller only needs to know we accepted the hint, and
    // holding the connection open for a full mirror would time out.
    void replicator.syncNow({ tenantId, dbId }).catch(() => undefined);
    res.status(202).json({ accepted: true });
  });

  return router;
}

export interface ClusterRouterDeps {
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
 * Admin surface. The caller mounts this behind the system-admin JWT
 * middleware, so capability rules in `config.json` decide who may read
 * (`GET /system/cluster/*`) and who may act (`POST`, `PATCH`, `DELETE`) —
 * that is how an auditor role gets status without getting control.
 */
export function createClusterRouter(deps: ClusterRouterDeps): Router {
  const router = Router();
  const { cluster } = deps;

  const actor = (req: Request): string => req.systemAdmin?.username ?? "unknown";

  router.get("/topology", (_req: Request, res: Response) => {
    res.json(cluster.topology());
  });

  router.get("/status", (_req: Request, res: Response) => {
    res.json(cluster.status());
  });

  router.get("/status/tenants/:tenantId", (req: Request, res: Response) => {
    res.json(cluster.tenantStatus(req.params.tenantId.toLowerCase()));
  });

  router.get("/jobs", (req: Request, res: Response) => {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    res.json({ jobs: cluster.jobs.list(Number.isFinite(limit) ? limit : 50) });
  });

  router.get("/jobs/:jobId", (req: Request, res: Response) => {
    const job = cluster.jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  });

  router.get("/audit", (req: Request, res: Response) => {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    res.json(cluster.audit.read({ limit: Number.isFinite(limit) ? limit : 50, before }));
  });

  router.post("/actions/:action", (req: Request, res: Response) => {
    const kind = ACTION_KINDS[req.params.action];
    if (!kind) {
      res.status(404).json({ error: `Unknown action: ${req.params.action}` });
      return;
    }
    const body = (req.body ?? {}) as ClusterJobScope;
    const scope: ClusterJobScope = {
      peer: typeof body.peer === "string" ? body.peer : undefined,
      tenantId: typeof body.tenantId === "string" ? body.tenantId.toLowerCase() : undefined,
      dbId: typeof body.dbId === "string" ? body.dbId : undefined,
    };

    const outcome = cluster.runAction(kind, scope, actor(req));
    if (!outcome.accepted) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    // 202: the job is queued, not finished. Poll GET /jobs/:jobId.
    res.status(202).json({ jobId: outcome.job.id, job: outcome.job });
  });

  router.get("/peers", (_req: Request, res: Response) => {
    res.json({ peers: cluster.topology().peers });
  });

  router.post("/peers/:name", (req: Request, res: Response) => {
    upsertPeer(req, res, deps, "peer-create");
  });

  router.patch("/peers/:name", (req: Request, res: Response) => {
    upsertPeer(req, res, deps, "peer-update");
  });

  router.delete("/peers/:name", (req: Request, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    if (!deps.removeTrustedServer(name)) {
      res.status(404).json({ error: "Peer not found" });
      return;
    }
    cluster.syncReplicators();
    cluster.auditPeerChange("peer-delete", name, actor(req));
    res.json({ success: true });
  });

  return router;
}

function upsertPeer(
  req: Request,
  res: Response,
  deps: ClusterRouterDeps,
  action: "peer-create" | "peer-update",
): void {
  const name = decodeURIComponent(req.params.name);
  const existing = deps.listTrustedServers().find((peer) => peer.name === name);

  if (action === "peer-create" && existing) {
    res.status(409).json({ error: "Peer already exists" });
    return;
  }
  if (action === "peer-update" && !existing) {
    res.status(404).json({ error: "Peer not found" });
    return;
  }

  const body = req.body as Partial<TrustedServer>;
  const signingPublicKey = body.signingPublicKey ?? existing?.signingPublicKey;
  const encryptionPublicKey = body.encryptionPublicKey ?? existing?.encryptionPublicKey;
  if (!signingPublicKey || !encryptionPublicKey) {
    res.status(400).json({ error: "signingPublicKey and encryptionPublicKey are required" });
    return;
  }
  for (const [field, guard] of [
    ["direction", isPeerSyncDirection],
    ["role", isPeerRole],
    ["attachments", isPeerAttachmentMode],
  ] as const) {
    const value = body[field];
    if (value !== undefined && !guard(value)) {
      res.status(400).json({ error: `Invalid ${field}: ${String(value)}` });
      return;
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

  deps.saveTrustedServer(peer);
  deps.cluster.syncReplicators();
  deps.cluster.auditPeerChange(action, name, req.systemAdmin?.username ?? "unknown");
  res.status(action === "peer-create" ? 201 : 200).json({ success: true, peer });
}
