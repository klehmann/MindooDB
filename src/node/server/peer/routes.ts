/**
 * Express mounting of the cluster HTTP surface. The handlers, and the
 * reasoning behind the split into `/system/peer/*` (server-to-server) and
 * `/system/cluster/*` (administration), live in `server/peer/clusterHttp.ts`.
 */

import { Router, type Request, type Response } from "express";
import type { SyncEventBus } from "../../../server/SyncEventBus";
import type { ClusterManager } from "../../../server/peer/ClusterManager";
import {
  ClusterAdminHandlers,
  formatPeerChangeEvent,
  PeerHttpHandlers,
  type ClusterAdminDeps,
} from "../../../server/peer/clusterHttp";
import { formatSyncHeartbeat, formatSyncHelloEvent, SYNC_EVENT_HEARTBEAT_MS } from "../../../server/http/MindooDBServerCore";
import { guard, route } from "../expressAdapter";

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
  listDatabases(tenantId: string): string[] | Promise<string[]>;
}

export function createPeerRouter(deps: PeerRouterDeps): Router {
  const router = Router();
  const handlers = new PeerHttpHandlers(deps);
  const requirePeer = guard((req) => handlers.peerGuard(req));

  router.post("/challenge", route((req) => handlers.challenge(req)));
  router.post("/authenticate", route((req) => handlers.authenticate(req)));
  router.post("/tenant-bloom", requirePeer, route((req) => handlers.tenantBloom(req)));
  router.get("/databases", requirePeer, route((req) => handlers.databases(req)));

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
    res.write(formatSyncHelloEvent());

    const unsubscribe = deps.eventBus.subscribe((event) => {
      const frame = formatPeerChangeEvent(deps.cluster, peerName, event);
      if (frame) res.write(frame);
    });

    const heartbeat = setInterval(() => {
      res.write(formatSyncHeartbeat(Date.now()));
    }, SYNC_EVENT_HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  router.post("/sync", requirePeer, route((req) => handlers.sync(req)));

  return router;
}

export type ClusterRouterDeps = ClusterAdminDeps;

/**
 * Admin surface. The caller mounts this behind the system-admin JWT
 * middleware, so capability rules in `config.json` decide who may read and
 * who may act.
 */
export function createClusterRouter(deps: ClusterRouterDeps): Router {
  const router = Router();
  const handlers = new ClusterAdminHandlers(deps);

  router.get("/topology", route(() => handlers.topology()));
  router.get("/status", route(() => handlers.status()));
  router.get("/status/tenants/:tenantId", route((req) => handlers.tenantStatus(req)));
  router.get("/jobs", route((req) => handlers.jobs(req)));
  router.get("/jobs/:jobId", route((req) => handlers.job(req)));
  router.get("/audit", route((req) => handlers.audit(req)));
  router.post("/actions/:action", route((req) => handlers.action(req)));
  router.get("/peers", route(() => handlers.peers()));
  router.post("/peers/:name", route((req) => handlers.createPeer(req)));
  router.patch("/peers/:name", route((req) => handlers.updatePeer(req)));
  router.delete("/peers/:name", route((req) => handlers.deletePeer(req)));

  return router;
}
