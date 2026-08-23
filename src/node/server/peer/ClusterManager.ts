/**
 * Owns everything cluster-shaped on one node: the peer session authenticator,
 * one {@link PeerReplicator} per trusted server that has a `url`, the job
 * registry behind the mutating admin actions, and the audit log.
 *
 * `MindooDBServer` holds exactly one of these and routes both `/system/peer/*`
 * (server-to-server protocol) and `/system/cluster/*` (admin surface) into it.
 * Keeping the two prefixes on one object is fine — they never share an auth
 * class, and the read model both need is the same in-memory replication state.
 */

import { StoreKind, type ContentAddressedStore } from "../../../core/types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../../core/logging";
import type { CryptoAdapter } from "../../../core/crypto/CryptoAdapter";
import type { TrustedServer } from "../types";
import type { SyncEventBus } from "../SyncEventBus";
import { PeerAuthService } from "./PeerAuthService";
import { PeerReplicator, rollUpHealth, type PeerSyncScope } from "./PeerReplicator";
import { ClusterJobRunner } from "./ClusterJobRunner";
import { ClusterAuditLog } from "./ClusterAuditLog";
import {
  type ClusterJob,
  type ClusterJobKind,
  type ClusterJobResult,
  type ClusterJobScope,
  type ClusterStatusResponse,
  type ClusterTenantStatusResponse,
  type ClusterTopologyResponse,
  type PeerRole,
} from "./types";

/** Result of dispatching an admin action; `accepted` discriminates the union. */
export type ClusterActionOutcome =
  | { accepted: true; job: ClusterJob }
  | { accepted: false; error: string };

export interface ClusterManagerDeps {
  cryptoAdapter: CryptoAdapter;
  dataDir: string;
  eventBus: SyncEventBus;
  /** Trusted servers, re-read on every call so peer CRUD takes effect at once. */
  listTrustedServers(): TrustedServer[];
  /** This node's own name from `server.identity.json`, or null without identity. */
  localServerName(): string | null;
  /** This node's Ed25519 public key (PEM), how peers look it up. */
  localSigningPublicKey(): string | null;
  getSigningKey(): Promise<CryptoKey | undefined>;
  getEncryptionKey(): Promise<CryptoKey | undefined>;
  listTenants(): string[];
  listDatabases(tenantId: string): string[];
  getLocalStore(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<ContentAddressedStore>;
  /** This node's mesh role; `peer` unless config says hub or spoke. */
  localRole?: PeerRole;
  logger?: Logger;
}

export class ClusterManager {
  readonly auth: PeerAuthService;
  readonly jobs = new ClusterJobRunner();
  readonly audit: ClusterAuditLog;

  private readonly replicators = new Map<string, PeerReplicator>();
  private readonly logger: Logger;
  private started = false;
  /**
   * Tenants each peer is allowed to hear about, from the last Bloom handshake
   * that peer performed against us.
   *
   * Inbound state, distinct from a replicator's own outbound intersection: this
   * is what *they* asked about, and it exists so the peer event stream can be
   * filtered. Without it the feed would announce every tenant we host, which
   * would hand a peer the tenant list the Bloom exchange is designed to keep
   * from it.
   */
  private readonly peerIntersections = new Map<string, Set<string>>();

  constructor(private readonly deps: ClusterManagerDeps) {
    this.logger =
      deps.logger?.createChild("Cluster") ??
      new MindooLogger(getDefaultLogLevel(), "Cluster", true);
    this.auth = new PeerAuthService(deps.cryptoAdapter, () => deps.listTrustedServers());
    this.audit = new ClusterAuditLog(deps.dataDir);
  }

  private get localRole(): PeerRole {
    return this.deps.localRole ?? "peer";
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Bring the replicator set in line with `trusted-servers.json`.
   *
   * Called at startup and after any peer CRUD. Existing replicators are updated
   * in place rather than recreated so their scan cursors and echo-suppression
   * state survive an edit to, say, the attachment mode.
   */
  syncReplicators(): void {
    const configured = new Map(
      this.deps
        .listTrustedServers()
        .filter((peer) => typeof peer.url === "string" && peer.url.length > 0)
        .map((peer) => [peer.name, peer] as const),
    );

    for (const [name, replicator] of this.replicators) {
      if (!configured.has(name)) {
        void replicator.stop();
        this.replicators.delete(name);
      }
    }

    for (const [name, peer] of configured) {
      const existing = this.replicators.get(name);
      if (existing) {
        existing.updatePeer(peer);
        continue;
      }
      const replicator = new PeerReplicator(peer, {
        cryptoAdapter: this.deps.cryptoAdapter,
        localServerName: this.deps.localServerName() ?? "",
        localSigningPublicKey: this.deps.localSigningPublicKey() ?? "",
        localRole: this.localRole,
        getSigningKey: () => this.deps.getSigningKey(),
        getEncryptionKey: () => this.deps.getEncryptionKey(),
        listTenants: () => this.deps.listTenants(),
        listDatabases: (tenantId) => this.deps.listDatabases(tenantId),
        getLocalStore: (tenantId, dbId, storeKind) =>
          this.deps.getLocalStore(tenantId, dbId, storeKind),
        eventBus: this.deps.eventBus,
        logger: this.logger,
      });
      this.replicators.set(name, replicator);
      if (this.started) replicator.start();
    }
  }

  start(): void {
    if (this.started) return;
    if (!this.deps.localServerName()) {
      this.logger.info("No server identity; peer replication stays off");
      return;
    }
    this.started = true;
    this.syncReplicators();
    for (const replicator of this.replicators.values()) {
      replicator.start();
    }
    this.logger.info(`Peer replication started for ${this.replicators.size} peer(s)`);
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.replicators.values()].map((peer) => peer.stop()));
    this.replicators.clear();
  }

  get autoSyncEnabled(): boolean {
    return this.started;
  }

  getReplicator(name: string): PeerReplicator | null {
    return this.replicators.get(name) ?? null;
  }

  /** Record what a peer's Bloom handshake matched; see {@link peerIntersections}. */
  recordPeerIntersection(peerName: string, tenantIds: string[]): void {
    this.peerIntersections.set(peerName, new Set(tenantIds));
  }

  /**
   * May this peer be told that something changed in this tenant?
   *
   * Closed by default: a peer that has not run the Bloom handshake in this
   * process gets nothing, rather than everything.
   */
  peerMaySeeTenant(peerName: string, tenantId: string): boolean {
    return this.peerIntersections.get(peerName)?.has(tenantId) ?? false;
  }

  // ------------------------------------------------------------ read model

  topology(): ClusterTopologyResponse {
    return {
      server: { name: this.deps.localServerName(), role: this.localRole },
      peers: [...this.replicators.values()].map((peer) => peer.topologyEntry()),
    };
  }

  status(): ClusterStatusResponse {
    const peers = [...this.replicators.values()].map((peer) => peer.snapshot());
    // Node health is the worst peer's health: one stalled link is enough to
    // mean this node is not fully converged with the mesh.
    const { health, reasons } = rollUpHealth(
      [],
      peers.flatMap((peer) => peer.reasons),
    );
    return {
      server: this.deps.localServerName(),
      health: peers.length === 0 ? "ok" : health,
      reasons: peers.length === 0 ? [] : reasons,
      autoSyncEnabled: this.started,
      generatedAt: new Date().toISOString(),
      peers,
    };
  }

  tenantStatus(tenantId: string): ClusterTenantStatusResponse {
    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      peers: [...this.replicators.values()].map((peer) => ({
        name: peer.name,
        tenant: peer.tenantSnapshot(tenantId),
      })),
    };
  }

  // --------------------------------------------------------------- actions

  /**
   * Dispatch an action as a job across the peers the scope selects.
   *
   * Records the request in the audit log first, with the job id, so an action
   * that is issued is on record even if the node dies mid-run.
   */
  runAction(
    kind: ClusterJobKind,
    scope: ClusterJobScope,
    requestedBy: string,
  ): ClusterActionOutcome {
    const targets = this.targetsFor(scope);
    if (targets.length === 0) {
      this.audit.append({
        at: new Date().toISOString(),
        actor: requestedBy,
        action: kind,
        scope,
        jobId: null,
        outcome: "rejected",
        detail: scope.peer ? "unknown peer" : "no peers configured",
      });
      return {
        accepted: false,
        error: scope.peer ? `Unknown peer: ${scope.peer}` : "No peers configured",
      };
    }

    const job = this.jobs.start(kind, scope, requestedBy, async (ctx) => {
      const result: ClusterJobResult = {
        transferredEntries: 0,
        transferredBytes: 0,
        rejectedEntries: 0,
        tenantsProcessed: 0,
        databasesProcessed: 0,
      };
      let completed = 0;
      const peerScope: PeerSyncScope = { tenantId: scope.tenantId, dbId: scope.dbId };

      for (const replicator of targets) {
        switch (kind) {
          case "sync":
          case "retry-rejected": {
            const run =
              kind === "sync"
                ? await replicator.syncNow(peerScope)
                : await replicator.retryRejected(peerScope);
            result.transferredEntries += run.pushed + run.pulled;
            result.rejectedEntries += run.rejected;
            result.tenantsProcessed += run.tenants;
            result.databasesProcessed += run.databases;
            if (run.errors.length > 0) {
              throw new Error(run.errors.join("; "));
            }
            break;
          }
          case "refresh-intersection": {
            const shared = await replicator.refreshIntersection();
            result.tenantsProcessed += shared.length;
            break;
          }
          case "pause":
            replicator.pause();
            break;
          case "resume":
            replicator.resume();
            break;
        }
        completed += 1;
        ctx.progress(completed, targets.length);
      }
      return result;
    });

    this.audit.append({
      at: new Date().toISOString(),
      actor: requestedBy,
      action: kind,
      scope,
      jobId: job.id,
      outcome: "accepted",
    });
    return { accepted: true, job };
  }

  private targetsFor(scope: ClusterJobScope): PeerReplicator[] {
    if (!scope.peer) return [...this.replicators.values()];
    const replicator = this.replicators.get(scope.peer);
    return replicator ? [replicator] : [];
  }

  /** Record a peer CRUD change; the caller has already persisted it. */
  auditPeerChange(
    action: "peer-create" | "peer-update" | "peer-delete",
    peerName: string,
    actor: string,
  ): void {
    this.audit.append({
      at: new Date().toISOString(),
      actor,
      action,
      scope: { peer: peerName },
      jobId: null,
      outcome: "accepted",
    });
  }

  /**
   * Mirrors of one tenant, for `GET /.well-known/mindoodb-cluster`.
   *
   * Only peers that actually hold the requested tenant are listed — a client
   * asking about tenant A must not learn that this server also replicates
   * tenants B and C to some other node.
   */
  mirrorsForTenant(tenantId: string): Array<{ name: string; url: string; role: PeerRole }> {
    const mirrors: Array<{ name: string; url: string; role: PeerRole }> = [];
    for (const replicator of this.replicators.values()) {
      // No snapshot for this tenant means the Bloom intersection did not put it
      // on both sides, so the peer is not a mirror a client could fail over to.
      if (!replicator.tenantSnapshot(tenantId)) continue;
      const entry = replicator.topologyEntry();
      if (!entry.url) continue;
      mirrors.push({ name: entry.name, url: entry.url, role: entry.role });
    }
    return mirrors;
  }
}
