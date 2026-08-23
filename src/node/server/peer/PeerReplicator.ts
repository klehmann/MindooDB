/**
 * Server-to-server replication with one trusted peer.
 *
 * One replicator instance per entry in `trusted-servers.json` that carries a
 * `url`. It owns everything about that link: the peer session, the set of
 * tenants both sides hold, the mirror loop over every database, the live push
 * out of {@link SyncEventBus}, and the SSE subscription that pulls the other
 * direction.
 *
 * ## What it replicates
 *
 * Everything both servers already have in common, and nothing else. The tenant
 * set is intersected via a Bloom summary (see {@link refreshIntersection}), so
 * a server never learns which tenants it does *not* host on the other side. For
 * each shared tenant it mirrors **all** databases — the union of the local and
 * remote database lists — in both stores (`docs` and `attachments`).
 *
 * ## Convergence invariants
 *
 * 1. **Directory first.** Databases are ordered by
 *    {@link orderDatabasesForReplication}: `directory`, then `userdirectory`,
 *    then the rest. An application entry signed by a key the peer does not
 *    trust yet is rejected per entry, so the grants have to land first.
 * 2. **Cursor holds on rejection.** Unlike a client, a peer must not skip past
 *    a rejected entry — that is permanent divergence between two servers that
 *    are supposed to be identical. The peer path passes
 *    `rejectionPolicy: "hold"`, which clamps the cursor so the next run
 *    re-offers the entry once the missing trust has replicated.
 * 3. **Receipts are preserved, not re-stamped.** Enforced on the receiving side
 *    in `ServerNetworkContentAddressedStore`; this side just transports.
 */

import { HttpTransport } from "../../../appendonlystores/network/HttpTransport";
import { ClientNetworkContentAddressedStore } from "../../../appendonlystores/network/ClientNetworkContentAddressedStore";
import { StoreKind, type ContentAddressedStore } from "../../../core/types";
import { NetworkError } from "../../../core/appendonlystores/network/types";
import type { CryptoAdapter } from "../../../core/crypto/CryptoAdapter";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../../core/logging";
import { createIdBloomSummary } from "../../../core/appendonlystores/bloom";
import {
  syncEntriesBetweenStores,
  syncScanCursorKey,
  type SyncScanCursorRecord,
  type SyncScanCursorStore,
} from "../../../core/appendonlystores/syncStores";
import type { TrustedServer } from "../types";
import type { SyncEventBus, SyncChangeEvent } from "../SyncEventBus";
import {
  classifyPeerError,
  directionAllowsPull,
  directionAllowsPush,
  normalizePeerSettings,
  orderDatabasesForReplication,
  redactEntryIds,
  shouldOpenSessionTo,
  type ClusterErrorClass,
  type ClusterHealth,
  type ClusterHealthReason,
  type ClusterPeerStatus,
  type ClusterSessionState,
  type ClusterTenantStatus,
  type ClusterTopologyPeer,
  type PeerAttachmentMode,
  type PeerRole,
  type PeerSyncDirection,
} from "./types";

/** What a replicator needs from the surrounding server to do its job. */
export interface PeerReplicatorHost {
  cryptoAdapter: CryptoAdapter;
  /** This server's name, as the peer knows it in its own trusted-servers list. */
  localServerName: string;
  /** This server's Ed25519 public key (PEM) — how the peer looks us up. */
  localSigningPublicKey: string;
  /** This node's own mesh role, which decides whether spoke-to-spoke is suppressed. */
  localRole: PeerRole;
  /** Ed25519 signing key, for the peer challenge. */
  getSigningKey(): Promise<CryptoKey | undefined>;
  /** RSA private key, to unwrap entries the peer sends us. */
  getEncryptionKey(): Promise<CryptoKey | undefined>;
  /** Tenant ids hosted locally. */
  listTenants(): string[];
  /** Database ids held locally for a tenant. */
  listDatabases(tenantId: string): string[];
  /** Local store for a (tenant, db, kind) triple, created on demand. */
  getLocalStore(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<ContentAddressedStore>;
  eventBus: SyncEventBus;
  logger?: Logger;
}

export interface PeerSyncScope {
  tenantId?: string;
  dbId?: string;
}

export interface PeerSyncRunResult {
  peer: string;
  tenants: number;
  databases: number;
  pushed: number;
  pulled: number;
  rejected: number;
  /** Pairs whose cursor is clamped waiting for trust to replicate (invariant 2). */
  held: number;
  errors: string[];
}

/** Token lifetime is an hour on the server; refresh well before that. */
const PEER_TOKEN_REFRESH_MS = 45 * 60 * 1000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const IDLE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** Live pushes are coalesced over this window so a burst becomes one run. */
const PUSH_COALESCE_MS = 250;

interface TenantRuntime {
  tenantId: string;
  databases: string[];
  lastSyncAt: string | null;
  /** Entries still owed in either direction, from the last head comparison. */
  lag: number;
  /** Store pairs whose cursor is clamped, waiting for trust to replicate. */
  retryQueueDepth: number;
  rejectedEntries: number;
  errorClass: ClusterErrorClass | null;
  /** Peer receipt order covered by our own pushes — used for echo suppression. */
  suppressUpToPeerOrder: number;
}

export class PeerReplicator {
  private peer: TrustedServer;
  private readonly host: PeerReplicatorHost;
  private readonly logger: Logger;

  private direction: PeerSyncDirection;
  private role: PeerRole;
  private attachments: PeerAttachmentMode;

  private running = false;
  private paused = false;
  private sessionState: ClusterSessionState = "disabled";
  private eventsConnected = false;
  private token: string | null = null;
  private tokenIssuedAt = 0;
  private tokenPromise: Promise<string> | null = null;

  private intersection: string[] = [];
  private intersectionAt: string | null = null;
  private tenants = new Map<string, TenantRuntime>();
  private transferredEntries = 0;
  private transferredBytes = 0;

  private syncInFlight: Promise<PeerSyncRunResult> | null = null;
  private pendingScopes = new Set<string>();
  private pushTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private sseAbort: AbortController | null = null;
  private unsubscribeBus: (() => void) | null = null;

  private lastError: string | null = null;
  private lastErrorClass: ClusterErrorClass | null = null;
  private lastErrorAt: string | null = null;
  private lastSyncAt: string | null = null;

  /**
   * Scan cursors, per (source, target) store pair.
   *
   * In-process only, deliberately: a restarted server pays one metadata scan
   * per pair and then re-establishes the fast path from the store head. Cheap
   * enough, and it avoids a second on-disk format to keep consistent with the
   * stores it describes.
   */
  private readonly cursors = new Map<string, SyncScanCursorRecord>();

  constructor(peer: TrustedServer, host: PeerReplicatorHost) {
    this.peer = peer;
    this.host = host;
    const settings = normalizePeerSettings(peer);
    this.direction = settings.direction;
    this.role = settings.role;
    this.attachments = settings.attachments;
    this.logger =
      host.logger?.createChild(`Peer:${peer.name}`) ??
      new MindooLogger(getDefaultLogLevel(), `Peer:${peer.name}`, true);
  }

  get name(): string {
    return this.peer.name;
  }

  get url(): string | undefined {
    return this.peer.url;
  }

  /** Replace the peer config in place (peer CRUD) without dropping cursors. */
  updatePeer(peer: TrustedServer): void {
    this.peer = peer;
    const settings = normalizePeerSettings(peer);
    this.direction = settings.direction;
    this.role = settings.role;
    this.attachments = settings.attachments;
    // Identity or endpoint may have changed; force a fresh session.
    this.token = null;
    this.tokenIssuedAt = 0;
  }

  /** Roles and endpoint, for `GET /system/cluster/topology`. */
  topologyEntry(): ClusterTopologyPeer {
    return {
      name: this.peer.name,
      url: this.peer.url ?? null,
      direction: this.direction,
      role: this.role,
      attachments: this.attachments,
      sessionActive: this.running && !this.paused && this.sessionState === "connected",
    };
  }

  start(): void {
    if (this.running) return;
    if (!this.peer.url) {
      this.logger.debug(`No url configured, replication disabled`);
      return;
    }
    if (this.direction === "disabled") {
      this.sessionState = "disabled";
      return;
    }
    if (!shouldOpenSessionTo(this.host.localRole, this.role)) {
      // Spoke to spoke: the hub already carries this traffic. The trust entry
      // stays so the peer can still authenticate inbound.
      this.sessionState = "disabled";
      return;
    }
    this.running = true;
    this.sessionState = "connecting";

    this.unsubscribeBus = this.host.eventBus.subscribe((event) => {
      this.onLocalChange(event);
    });

    this.idleTimer = setInterval(() => {
      void this.syncNow().catch(() => {
        // Errors are already recorded on the status snapshot.
      });
    }, IDLE_SYNC_INTERVAL_MS);
    this.idleTimer.unref?.();

    void this.bootstrap();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pushTimer = null;
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.eventsConnected = false;
    this.sessionState = "disabled";
    try {
      await this.syncInFlight;
    } catch {
      // A sync failing during shutdown is not interesting.
    }
  }

  pause(): void {
    this.paused = true;
    this.sessionState = "paused";
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.eventsConnected = false;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.sessionState = "connecting";
    this.reconnectAttempt = 0;
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (!this.running || this.paused) return;
    try {
      await this.refreshIntersection();
      await this.syncNow();
      this.startEventStream();
      this.reconnectAttempt = 0;
    } catch (error) {
      this.recordError(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.paused || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectAttempt += 1;
    this.sessionState = "backoff";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.bootstrap();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ---------------------------------------------------------------- session

  private async ensureToken(): Promise<string> {
    const fresh = this.token && Date.now() - this.tokenIssuedAt < PEER_TOKEN_REFRESH_MS;
    if (fresh) return this.token as string;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = this.authenticate().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async authenticate(): Promise<string> {
    const signingKey = await this.host.getSigningKey();
    if (!signingKey) {
      throw new Error("Server identity is locked; cannot authenticate with peer");
    }
    this.sessionState = "connecting";

    // The peer looks us up by signing key, not by name: the key is the identity
    // in `trusted-servers.json`, the name is only a label.
    const challengeResponse = await this.peerFetch("/system/peer/challenge", {
      method: "POST",
      body: { publicsignkey: this.host.localSigningPublicKey },
      authenticated: false,
    });
    const challenge = (challengeResponse as { challenge?: string }).challenge;
    if (!challenge) {
      throw new Error("Peer did not return a challenge");
    }

    const subtle = this.host.cryptoAdapter.getSubtle();
    const signature = await subtle.sign(
      { name: "Ed25519" },
      signingKey,
      new TextEncoder().encode(challenge),
    );

    const authResponse = (await this.peerFetch("/system/peer/authenticate", {
      method: "POST",
      body: {
        challenge,
        signature: Buffer.from(new Uint8Array(signature)).toString("base64"),
      },
      authenticated: false,
    })) as { success?: boolean; token?: string; error?: string };

    if (!authResponse.success || !authResponse.token) {
      throw new Error(authResponse.error || "Peer authentication failed");
    }
    this.token = authResponse.token;
    this.tokenIssuedAt = Date.now();
    this.sessionState = "connected";
    return this.token;
  }

  private async peerFetch(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      authenticated?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const base = this.peer.url;
    if (!base) throw new Error(`Peer ${this.peer.name} has no url`);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init.authenticated !== false) {
      headers.Authorization = `Bearer ${await this.ensureToken()}`;
    }

    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        // Force a re-handshake on the next call: the peer may have rotated its
        // trusted-servers entry or restarted with a new challenge store.
        this.token = null;
      }
      throw new Error(`Peer ${this.peer.name} ${path} failed (${response.status}): ${text}`);
    }
    return response.json();
  }

  // ----------------------------------------------------------- intersection

  /**
   * Recompute the set of tenants both servers host.
   *
   * We send a Bloom summary of our tenant ids; the peer answers with the ids on
   * *its* side that the filter might contain. Those are candidates only — a
   * Bloom filter has false positives — so the result is intersected against the
   * authoritative local list before anything is replicated. That second step is
   * what makes the false-positive rate a performance question rather than a
   * correctness one.
   */
  async refreshIntersection(): Promise<string[]> {
    const localTenants = this.host.listTenants();
    const localSet = new Set(localTenants);
    const summary = createIdBloomSummary(localTenants);

    const response = (await this.peerFetch("/system/peer/tenant-bloom", {
      method: "POST",
      body: { bloom: summary },
    })) as { tenantIds?: string[] };

    const candidates = Array.isArray(response.tenantIds) ? response.tenantIds : [];
    const shared = candidates.filter((tenantId) => localSet.has(tenantId)).sort();

    this.intersection = shared;
    this.intersectionAt = new Date().toISOString();

    for (const tenantId of this.tenants.keys()) {
      if (!shared.includes(tenantId)) this.tenants.delete(tenantId);
    }
    for (const tenantId of shared) {
      if (!this.tenants.has(tenantId)) {
        this.tenants.set(tenantId, {
          tenantId,
          databases: [],
          lastSyncAt: null,
          lag: 0,
          retryQueueDepth: 0,
          rejectedEntries: 0,
          errorClass: null,
          suppressUpToPeerOrder: 0,
        });
      }
    }
    return shared;
  }

  // ------------------------------------------------------------------- sync

  /**
   * Run one full replication pass, optionally narrowed to a tenant or database.
   *
   * Concurrent calls collapse onto the in-flight run: the caller that arrives
   * second gets the same promise rather than a second parallel mirror of the
   * same stores.
   */
  async syncNow(scope?: PeerSyncScope): Promise<PeerSyncRunResult> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.runSync(scope).finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  /**
   * Re-offer entries the peer rejected.
   *
   * Under the hold policy the cursor is already clamped, so a plain sync run is
   * the retry — this exists as a named admin action so the UI has something to
   * call that says what it does.
   */
  async retryRejected(scope?: PeerSyncScope): Promise<PeerSyncRunResult> {
    return this.syncNow(scope);
  }

  private async runSync(scope?: PeerSyncScope): Promise<PeerSyncRunResult> {
    const result: PeerSyncRunResult = {
      peer: this.peer.name,
      tenants: 0,
      databases: 0,
      pushed: 0,
      pulled: 0,
      rejected: 0,
      held: 0,
      errors: [],
    };

    if (this.paused || this.direction === "disabled" || !this.peer.url) {
      return result;
    }
    if (this.intersection.length === 0) {
      await this.refreshIntersection().catch((error) => {
        this.recordError(error);
        result.errors.push(errorMessage(error));
      });
    }

    const tenantIds = scope?.tenantId
      ? this.intersection.filter((id) => id === scope.tenantId)
      : this.intersection;

    for (const tenantId of tenantIds) {
      const runtime = this.tenants.get(tenantId);
      if (!runtime) continue;
      runtime.rejectedEntries = 0;
      runtime.retryQueueDepth = 0;
      runtime.errorClass = null;

      try {
        const databases = await this.databasesFor(tenantId, scope?.dbId);
        // Only a full-tenant run knows the complete list; a scoped run must not
        // shrink what the status endpoint reports.
        if (!scope?.dbId) runtime.databases = databases;
        result.tenants += 1;

        for (const [dbId, storeKind] of this.mirrorPlan(databases)) {
          if (storeKind === StoreKind.docs) result.databases += 1;
          const pair = await this.syncStorePair(tenantId, dbId, storeKind);
          result.pushed += pair.pushed;
          result.pulled += pair.pulled;
          result.rejected += pair.rejected;
          runtime.rejectedEntries += pair.rejected;
          this.transferredEntries += pair.pushed + pair.pulled;
          this.transferredBytes += pair.bytes;
          if (pair.held) {
            runtime.retryQueueDepth += 1;
            result.held += 1;
          }
          if (pair.deniedReason) {
            // Visible in the status read-model as a backoff rather than an
            // outage, so an operator can tell "waiting on a purge that has not
            // replicated yet" from "this peer is unreachable".
            runtime.errorClass = "access-denied";
            this.lastError = pair.deniedReason;
            this.lastErrorClass = "access-denied";
            this.lastErrorAt = new Date().toISOString();
          }
        }
        runtime.lastSyncAt = new Date().toISOString();
      } catch (error) {
        const message = errorMessage(error);
        runtime.errorClass = classifyPeerError(error);
        result.errors.push(`${tenantId}: ${message}`);
        this.recordError(error);
      }
    }

    this.lastSyncAt = new Date().toISOString();
    // A held pair is not a clean run: the backoff has to stay visible until the
    // entries actually land, or the status flips to healthy while the mirror is
    // still incomplete.
    if (result.errors.length === 0 && result.held === 0) {
      this.lastError = null;
      this.lastErrorClass = null;
      this.lastErrorAt = null;
      this.sessionState = "connected";
    }
    return result;
  }

  /**
   * The (database, store) pairs to mirror for one tenant, in order.
   *
   * `eager` interleaves — each database's documents are immediately followed by
   * its attachments, so a database is complete before the next one starts.
   * `lazy` runs every document store first and only then the attachment stores:
   * a run that is interrupted (or a link that is slow) has then spent its
   * bandwidth on the text, which is what makes documents readable, rather than
   * on blobs that can be fetched later. `never` skips attachments entirely.
   *
   * Database order comes from {@link orderDatabasesForReplication} either way —
   * invariant 1 outranks the attachment policy.
   */
  private *mirrorPlan(databases: string[]): Generator<[string, StoreKind]> {
    if (this.attachments === "eager") {
      for (const dbId of databases) {
        yield [dbId, StoreKind.docs];
        yield [dbId, StoreKind.attachments];
      }
      return;
    }
    for (const dbId of databases) {
      yield [dbId, StoreKind.docs];
    }
    if (this.attachments === "never") return;
    for (const dbId of databases) {
      yield [dbId, StoreKind.attachments];
    }
  }

  /**
   * Databases to mirror for a tenant: the union of both sides, in invariant
   * order (invariant 1).
   *
   * Union rather than intersection, because a database that exists only on the
   * peer is exactly the thing a fresh mirror needs to pull.
   */
  private async databasesFor(tenantId: string, onlyDbId?: string): Promise<string[]> {
    const local = this.host.listDatabases(tenantId);
    let remote: string[] = [];
    try {
      const response = (await this.peerFetch(
        `/system/peer/databases?tenantId=${encodeURIComponent(tenantId)}`,
      )) as { databases?: string[] };
      remote = Array.isArray(response.databases) ? response.databases : [];
    } catch (error) {
      this.logger.debug(`Could not list peer databases for ${tenantId}: ${errorMessage(error)}`);
    }
    const union = orderDatabasesForReplication(new Set([...local, ...remote]));
    return onlyDbId ? union.filter((dbId) => dbId === onlyDbId) : union;
  }

  private async syncStorePair(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<{
    pushed: number;
    pulled: number;
    bytes: number;
    rejected: number;
    held: boolean;
    deniedReason?: string;
  }> {
    const localStore = await this.host.getLocalStore(tenantId, dbId, storeKind);
    const remoteStore = await this.createRemoteStore(tenantId, dbId, storeKind);

    let pushed = 0;
    let pulled = 0;
    let bytes = 0;
    let rejected = 0;
    let held = false;
    let deniedReason: string | undefined;

    // Both directions use `rejectionPolicy: "hold"` (invariant 2). A client may
    // skip a poisoned entry forever; two servers that are meant to be identical
    // may not, so the cursor stays clamped until the entry is accepted.
    //
    // A denial can also arrive for the batch as a whole rather than per entry —
    // a purged document or a revoked decryption key makes the target refuse
    // everything in the request. That is the same condition seen from further
    // away: hold this pair, leave the cursor where it is, and carry on with the
    // tenant's other databases. Treating it as a tenant-level failure would let
    // one purged document stop the whole mirror.
    if (directionAllowsPull(this.direction)) {
      const result = await this.transfer(remoteStore, localStore);
      pulled = result.transferred;
      bytes += result.bytes;
      rejected += result.rejected;
      held ||= result.held;
      deniedReason ??= result.deniedReason;
    }

    if (directionAllowsPush(this.direction)) {
      const result = await this.transfer(localStore, remoteStore);
      pushed = result.transferred;
      bytes += result.bytes;
      rejected += result.rejected;
      held ||= result.held;
      deniedReason ??= result.deniedReason;

      if (pushed > 0) {
        // Remember how far the peer's log advanced because of us, so its SSE
        // notification for these very entries is recognised as our own echo.
        const runtime = this.tenants.get(tenantId);
        const head = await remoteStore.getStoreHead?.().catch(() => null);
        if (runtime && head?.maxReceiptOrder !== undefined) {
          runtime.suppressUpToPeerOrder = Math.max(
            runtime.suppressUpToPeerOrder,
            head.maxReceiptOrder,
          );
        }
      }
    }

    return { pushed, pulled, bytes, rejected, held, deniedReason };
  }

  /**
   * One leg of a store pair, with a batch-wide denial folded into `held`.
   *
   * See {@link syncStorePair}: a denial means "not now", so the cursor must
   * stay put and the pair is retried on the next run. Any other failure is a
   * real error and propagates to the tenant loop.
   */
  private async transfer(
    source: ContentAddressedStore,
    target: ContentAddressedStore,
  ): Promise<{
    transferred: number;
    bytes: number;
    rejected: number;
    held: boolean;
    deniedReason?: string;
  }> {
    try {
      const result = await syncEntriesBetweenStores(source, target, undefined, {
        logger: this.logger,
        cursors: this.cursorStore(),
        rejectionPolicy: "hold",
      });
      return {
        transferred: result.transferred,
        bytes: result.transferredBytes ?? 0,
        rejected: result.rejected?.length ?? 0,
        held: result.cursorHeldForRetry === true,
      };
    } catch (error) {
      if (classifyPeerError(error) !== "access-denied") throw error;
      this.logger.warn(`Peer refused a batch, holding for retry: ${errorMessage(error)}`);
      return {
        transferred: 0,
        bytes: 0,
        rejected: 0,
        held: true,
        deniedReason: redactEntryIds(errorMessage(error)),
      };
    }
  }

  private async createRemoteStore(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<ContentAddressedStore> {
    const encryptionKey = await this.host.getEncryptionKey();
    if (!encryptionKey) {
      throw new Error("Server identity is locked; cannot decrypt peer entries");
    }
    const signingKey = await this.host.getSigningKey();
    if (!signingKey) {
      throw new Error("Server identity is locked; cannot sign for peer");
    }

    // The tenant segment belongs in the base url, not just in the config: the
    // transport builds `${baseUrl}/sync/${storeKind}/...` and the server routes
    // sync under `/:tenantId/sync/*`. Passing the bare server url — as the old
    // per-tenant ServerSync did — makes every request land on `/sync/...`,
    // where Express reads "sync" as the tenant id and answers 404.
    const transport = new HttpTransport({
      baseUrl: `${(this.peer.url as string).replace(/\/$/, "")}/${encodeURIComponent(tenantId)}`,
      tenantId,
      dbId,
      storeKind,
    });

    const store = new ClientNetworkContentAddressedStore(
      dbId,
      storeKind,
      transport,
      this.host.cryptoAdapter,
      this.host.localServerName,
      signingKey,
      encryptionKey,
      this.logger,
    );
    // The tenant handshake would fail: a peer holds no per-tenant grant. It
    // carries the cluster-level peer token instead.
    store.setExternalTokenProvider(() => this.ensureToken());
    return store;
  }

  private cursorStore(): SyncScanCursorStore {
    return {
      get: (key) => this.cursors.get(key) ?? null,
      save: (key, record) => {
        this.cursors.set(key, record);
      },
      delete: (key) => {
        this.cursors.delete(key);
      },
    };
  }

  // ------------------------------------------------------------- live push

  private onLocalChange(event: SyncChangeEvent): void {
    if (!this.running || this.paused) return;
    if (!directionAllowsPush(this.direction)) return;
    // Do not bounce a peer's own write straight back at it. Other peers still
    // receive it, which is how a spoke's write reaches the mesh via its hub.
    if (event.originPeer === this.peer.name) return;
    if (!this.intersection.includes(event.tenantId)) return;
    if (this.attachments === "never" && event.storeKind === StoreKind.attachments) return;

    this.pendingScopes.add(`${event.tenantId}\u0000${event.dbId}`);
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const scopes = [...this.pendingScopes];
      this.pendingScopes.clear();
      void this.flushScopes(scopes);
    }, PUSH_COALESCE_MS);
    this.pushTimer.unref?.();
  }

  /**
   * Round-robin over the pending (tenant, db) scopes.
   *
   * Sequential on purpose: a hub with many spokes should not open a hundred
   * parallel sessions to one peer, and one busy tenant must not starve the
   * others — each pending scope gets its turn in the order it was queued.
   */
  private async flushScopes(scopes: string[]): Promise<void> {
    for (const scope of scopes) {
      const [tenantId, dbId] = scope.split("\u0000");
      try {
        await this.syncNow({ tenantId, dbId });
      } catch (error) {
        this.recordError(error);
      }
    }
  }

  // -------------------------------------------------------------- SSE pull

  private startEventStream(): void {
    if (!this.running || this.paused) return;
    if (!directionAllowsPull(this.direction)) return;
    if (this.sseAbort) return;

    const controller = new AbortController();
    this.sseAbort = controller;
    void this.consumeEventStream(controller).catch((error) => {
      if (!controller.signal.aborted) {
        this.recordError(error);
        this.scheduleReconnect();
      }
    });
  }

  private async consumeEventStream(controller: AbortController): Promise<void> {
    const base = this.peer.url as string;
    const token = await this.ensureToken();
    const response = await fetch(`${base.replace(/\/$/, "")}/system/peer/events`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Peer event stream failed (${response.status})`);
    }
    this.sessionState = "connected";
    this.eventsConnected = true;
    this.reconnectAttempt = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        this.handleEventFrame(frame);
        separator = buffer.indexOf("\n\n");
      }
    }

    if (this.sseAbort === controller) {
      this.sseAbort = null;
      this.eventsConnected = false;
      // The peer closed the stream. Catch up once (entries may have landed
      // while we were disconnected) and then re-subscribe.
      if (this.running && !this.paused) {
        void this.syncNow().catch(() => undefined);
        this.scheduleReconnect();
      }
    }
  }

  private handleEventFrame(frame: string): void {
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) return;

    let event: SyncChangeEvent;
    try {
      event = JSON.parse(dataLine.slice(5).trim()) as SyncChangeEvent;
    } catch {
      return;
    }
    if (!event.tenantId || !event.dbId) return;
    if (!this.intersection.includes(event.tenantId)) return;
    if (this.attachments === "never" && event.storeKind === StoreKind.attachments) return;

    // Echo suppression: this notification describes entries we ourselves just
    // pushed, so pulling them back would be a round trip for nothing.
    const runtime = this.tenants.get(event.tenantId);
    if (
      runtime &&
      event.maxReceiptOrder !== undefined &&
      event.maxReceiptOrder <= runtime.suppressUpToPeerOrder
    ) {
      return;
    }

    this.pendingScopes.add(`${event.tenantId}\u0000${event.dbId}`);
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const scopes = [...this.pendingScopes];
      this.pendingScopes.clear();
      void this.flushScopes(scopes);
    }, PUSH_COALESCE_MS);
    this.pushTimer.unref?.();
  }

  // ------------------------------------------------------------- reporting

  private recordError(error: unknown): void {
    this.lastError = redactEntryIds(errorMessage(error));
    this.lastErrorClass = classifyPeerError(error);
    this.lastErrorAt = new Date().toISOString();
    if (this.lastErrorClass === "network") {
      this.sessionState = "unreachable";
    } else if (this.sessionState !== "paused" && this.sessionState !== "disabled") {
      this.sessionState = "backoff";
    }
    this.logger.warn(`Replication error: ${this.lastError}`);
  }

  /**
   * Status snapshot for `GET /system/cluster/status`.
   *
   * Read straight from in-memory replication state — no store scans — so the
   * admin UI can poll it without competing with replication for I/O. Contains
   * counts and classified reasons only: never a docId, never an author key.
   */
  snapshot(): ClusterPeerStatus {
    const tenants = [...this.tenants.values()].map((runtime) => this.tenantStatus(runtime));
    const { health, reasons } = rollUpHealth(tenants, this.peerLevelReasons());

    return {
      name: this.peer.name,
      url: this.peer.url ?? null,
      direction: this.direction,
      role: this.role,
      attachments: this.attachments,
      state: this.sessionState,
      health,
      reasons,
      sharedTenants: this.intersection.length,
      lastIntersectionAt: this.intersectionAt,
      lastSyncAt: this.lastSyncAt,
      eventsConnected: this.eventsConnected,
      lag: tenants.reduce((sum, tenant) => sum + tenant.lag, 0),
      retryQueueDepth: tenants.reduce((sum, tenant) => sum + tenant.retryQueueDepth, 0),
      rejectedEntries: tenants.reduce((sum, tenant) => sum + tenant.rejectedEntries, 0),
      transferredEntries: this.transferredEntries,
      transferredBytes: this.transferredBytes,
      lastError: this.lastError,
      lastErrorClass: this.lastErrorClass,
      lastErrorAt: this.lastErrorAt,
    };
  }

  tenantSnapshot(tenantId: string): ClusterTenantStatus | null {
    const runtime = this.tenants.get(tenantId);
    return runtime ? this.tenantStatus(runtime) : null;
  }

  private tenantStatus(runtime: TenantRuntime): ClusterTenantStatus {
    const reasons: ClusterHealthReason[] = [];
    if (runtime.retryQueueDepth > 0) reasons.push("entries-awaiting-directory-trust");
    if (runtime.errorClass === "access-denied") reasons.push("access-denied-backoff");
    const { health } = rollUpHealth([], reasons);

    return {
      tenantId: runtime.tenantId,
      databases: runtime.databases,
      lastSyncAt: runtime.lastSyncAt,
      lag: runtime.lag,
      retryQueueDepth: runtime.retryQueueDepth,
      rejectedEntries: runtime.rejectedEntries,
      health,
      reasons,
    };
  }

  /** Reasons that come from the link itself rather than from any one tenant. */
  private peerLevelReasons(): ClusterHealthReason[] {
    const reasons: ClusterHealthReason[] = [];
    if (!this.peer.url) reasons.push("no-url-configured");
    if (this.direction === "disabled") reasons.push("session-disabled");
    if (this.paused) reasons.push("session-paused");
    if (this.sessionState === "unreachable") reasons.push("peer-unreachable");
    if (this.lastErrorClass === "auth") reasons.push("peer-auth-failed");
    if (
      this.running &&
      !this.paused &&
      !this.eventsConnected &&
      directionAllowsPull(this.direction)
    ) {
      reasons.push("events-disconnected");
    }
    if (this.intersectionAt === null && this.running) reasons.push("intersection-stale");
    return reasons;
  }
}

/**
 * Collapse reasons into one health verdict, shared by the per-tenant, per-peer
 * and per-node rollups so all three agree on the thresholds.
 *
 * `stalled` outranks `degraded` deliberately. A clamped cursor is the visible
 * precursor of divergence: the link looks healthy, entries keep flowing, and
 * yet one database is quietly stuck behind an entry the peer will not accept
 * until the directory catches up. That is the state an operator most needs to
 * see, so a transient error elsewhere must not mask it.
 */
export function rollUpHealth(
  tenants: ClusterTenantStatus[],
  extraReasons: ClusterHealthReason[] = [],
): { health: ClusterHealth; reasons: ClusterHealthReason[] } {
  const reasons = new Set<ClusterHealthReason>(extraReasons);
  for (const tenant of tenants) {
    for (const reason of tenant.reasons) reasons.add(reason);
  }

  let health: ClusterHealth = "ok";
  if (reasons.has("session-disabled") || reasons.has("session-paused")) {
    // Deliberately off is not unhealthy; it is just not running.
    health = "ok";
  } else if (
    reasons.has("peer-unreachable") ||
    reasons.has("peer-auth-failed") ||
    reasons.has("no-url-configured")
  ) {
    health = "down";
  } else if (reasons.has("entries-awaiting-directory-trust")) {
    health = "stalled";
  } else if (reasons.size > 0) {
    health = "degraded";
  }
  return { health, reasons: [...reasons] };
}

function errorMessage(error: unknown): string {
  if (error instanceof NetworkError) return `${error.type}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
