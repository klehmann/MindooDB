/**
 * Types for server-to-server (peer) replication and the cluster admin surface.
 *
 * Two auth classes, two route prefixes — the split is load-bearing:
 *
 * - `/system/peer/*` is the **server-to-server protocol**. Callers authenticate
 *   with a server identity listed in `trusted-servers.json`. Only servers speak
 *   it.
 * - `/system/cluster/*` is the **admin surface**. Callers authenticate with a
 *   system-admin JWT and pass the {@link CapabilityMatcher}. Only humans and
 *   UIs speak it.
 *
 * No endpoint accepts both, so a peer can never administer and an admin can
 * never write as a peer.
 */

import { DIRECTORY_DB_ID, USER_DIRECTORY_DB_ID } from "../../../core/types";

/**
 * Which way entries flow to a peer.
 *
 * Mirrors Haven's client-side `SyncDirectionPreference` so operators meet one
 * vocabulary. `pull` is the backup/archive node (never writes to the peer),
 * `push` the DMZ head (never reads back), `disabled` keeps the trust entry for
 * inbound authentication but opens no outbound session.
 */
export type PeerSyncDirection = "bidirectional" | "push" | "pull" | "disabled";

/**
 * Mesh shape.
 *
 * A `spoke` opens sessions only to `hub` peers, never to another spoke, which
 * turns the full mesh into a spanning tree. Because the entry set is a CRDT
 * both converge; the tree just avoids the O(N^2) sessions of a large mesh.
 * `peer` (the default) is fully meshed and is the right answer for two or three
 * nodes — duplicate pushes are acknowledged idempotently by the receiver's
 * duplicate path, so the redundancy is cheap.
 */
export type PeerRole = "peer" | "hub" | "spoke";

/**
 * How eagerly attachment blobs follow their documents.
 *
 * Attachments are usually the bulk of the bytes and live in a separate store,
 * which makes this the biggest bandwidth lever. `lazy` still transfers them but
 * only after every document store is done; `never` skips the attachment store
 * entirely (an edge node that only needs text).
 */
export type PeerAttachmentMode = "eager" | "lazy" | "never";

/** Peer settings resolved against their defaults. */
export interface PeerSettings {
  direction: PeerSyncDirection;
  role: PeerRole;
  attachments: PeerAttachmentMode;
}

export const DEFAULT_PEER_SETTINGS: PeerSettings = {
  direction: "bidirectional",
  role: "peer",
  attachments: "eager",
};

export function isPeerSyncDirection(value: unknown): value is PeerSyncDirection {
  return (
    value === "bidirectional" || value === "push" || value === "pull" || value === "disabled"
  );
}

export function isPeerRole(value: unknown): value is PeerRole {
  return value === "peer" || value === "hub" || value === "spoke";
}

export function isPeerAttachmentMode(value: unknown): value is PeerAttachmentMode {
  return value === "eager" || value === "lazy" || value === "never";
}

/** Fill in defaults for any peer field the operator left unset. */
export function normalizePeerSettings(raw: {
  direction?: unknown;
  role?: unknown;
  attachments?: unknown;
}): PeerSettings {
  return {
    direction: isPeerSyncDirection(raw.direction)
      ? raw.direction
      : DEFAULT_PEER_SETTINGS.direction,
    role: isPeerRole(raw.role) ? raw.role : DEFAULT_PEER_SETTINGS.role,
    attachments: isPeerAttachmentMode(raw.attachments)
      ? raw.attachments
      : DEFAULT_PEER_SETTINGS.attachments,
  };
}

/**
 * Should this node open an outbound session to that peer?
 *
 * Spoke-to-spoke is the only pairing we suppress: both sides would otherwise
 * dial each other even though the hub already carries their traffic.
 */
export function shouldOpenSessionTo(local: PeerRole, remote: PeerRole): boolean {
  return !(local === "spoke" && remote === "spoke");
}

/** May we send local entries to this peer? */
export function directionAllowsPush(direction: PeerSyncDirection): boolean {
  return direction === "bidirectional" || direction === "push";
}

/** May we take the peer's entries? */
export function directionAllowsPull(direction: PeerSyncDirection): boolean {
  return direction === "bidirectional" || direction === "pull";
}

// =========================================================================
// Replication ordering (convergence invariant 1)
// =========================================================================

/**
 * Order the databases of one tenant for replication.
 *
 * `directory` first, then `userdirectory`, then everything else alphabetically.
 * This is not cosmetic. A peer validates every pushed entry against its own
 * directory (`validatePublicSigningKey`), and an unknown author key is a
 * **per-entry rejection**, not a batch failure. Push an application database
 * before the peer has the author's grant and those entries are refused; with
 * the client's cursor semantics they would then be skipped forever, leaving the
 * two servers silently divergent.
 *
 * The same ordering also shrinks the transient window in which a purged
 * document or a revoked `decryptionKeyId` makes the peer answer `ACCESS_DENIED`
 * for a whole batch: both denylists are derived from the directory (purge
 * requests live there and are executed by `executePendingPurges` after every
 * directory push), so they converge as soon as the directory has arrived.
 */
export function orderDatabasesForReplication(dbIds: Iterable<string>): string[] {
  const rest: string[] = [];
  let hasDirectory = false;
  let hasUserDirectory = false;

  for (const dbId of dbIds) {
    if (dbId === DIRECTORY_DB_ID) {
      hasDirectory = true;
    } else if (dbId === USER_DIRECTORY_DB_ID) {
      hasUserDirectory = true;
    } else {
      rest.push(dbId);
    }
  }

  rest.sort((left, right) => left.localeCompare(right));
  const ordered: string[] = [];
  if (hasDirectory) ordered.push(DIRECTORY_DB_ID);
  if (hasUserDirectory) ordered.push(USER_DIRECTORY_DB_ID);
  return ordered.concat(rest);
}

/** True for the two system databases that must replicate before app data. */
export function isTrustBearingDatabase(dbId: string): boolean {
  return dbId === DIRECTORY_DB_ID || dbId === USER_DIRECTORY_DB_ID;
}

// =========================================================================
// Cluster status (read model for the admin surface)
// =========================================================================

/** Live state of the outbound session to one peer. */
export type ClusterSessionState =
  | "connected"
  | "connecting"
  | "backoff"
  | "disabled"
  | "paused"
  | "unreachable";

/**
 * Health rollup, computed on the server so every console agrees on the
 * thresholds instead of inventing its own.
 */
export type ClusterHealth = "ok" | "degraded" | "stalled" | "down";

/**
 * Why a peer is not `ok`. Typed so a UI can colour-code and explain without
 * parsing prose.
 *
 * `entries-awaiting-directory-trust` is the one that matters most: it means the
 * peer rejected entries because it does not yet trust their author, the cursor
 * was held, and a retry is pending. Left unattended it is the visible precursor
 * of two servers drifting apart.
 */
export type ClusterHealthReason =
  | "entries-awaiting-directory-trust"
  | "access-denied-backoff"
  | "events-disconnected"
  | "intersection-stale"
  | "lag-above-threshold"
  | "peer-auth-failed"
  | "peer-unreachable"
  | "no-url-configured"
  | "session-disabled"
  | "session-paused";

/** Typed error class beside the free-text `lastError`. */
export type ClusterErrorClass =
  | "auth"
  | "network"
  | "access-denied"
  | "protocol"
  | "internal";

/**
 * Bucket a replication failure so the console can react without parsing the
 * message.
 *
 * The distinction that matters operationally is `access-denied` versus the
 * rest: it is the peer *deliberately* refusing a batch (a purged document, a
 * revoked key) and it resolves itself once the directory has replicated, so it
 * warrants a backoff and not an alert. Everything else is either a
 * misconfiguration (`auth`) or a genuine outage (`network`).
 */
/**
 * Strip document and entry identifiers out of a message before it reaches the
 * cluster status read-model.
 *
 * Rejection messages name the offending entry, and an entry id starts with the
 * document id. The cluster console is a system-admin surface, and a system
 * admin is not supposed to learn which documents a tenant holds — that is the
 * same admin-blindness the encryption enforces, and it would be odd to hand it
 * back through an error string. The classified reason plus the counts are what
 * an operator can act on anyway.
 */
export function redactEntryIds(message: string): string {
  return message.replace(/[0-9a-f]{16,}/gi, "<redacted>");
}

export function classifyPeerError(error: unknown): ClusterErrorClass {
  const type = (error as { type?: string } | null)?.type;
  switch (type) {
    case "ACCESS_DENIED":
    // Every 403 reaches the client as USER_REVOKED, whatever the server meant
    // by it. For a peer that is unambiguous: it holds no user identity, so a
    // 403 can only mean the target refuses these particular entries — a purged
    // document, a revoked decryption key. That is a backoff, not a
    // misconfigured trust relationship.
    case "USER_REVOKED":
      return "access-denied";
    case "INVALID_TOKEN":
    case "INVALID_SIGNATURE":
    case "CHALLENGE_EXPIRED":
      return "auth";
    case "NETWORK_ERROR":
    case "RATE_LIMITED":
      return "network";
    case "PAYLOAD_TOO_LARGE":
    case "SERVER_ERROR":
      return "protocol";
    default:
      break;
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("access_denied") || message.includes("access denied")) {
    return "access-denied";
  }
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("authentication") ||
    message.includes("token")
  ) {
    return "auth";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("socket") ||
    message.includes("network")
  ) {
    return "network";
  }
  return "internal";
}

/** Per-tenant slice of a peer's replication state. */
export interface ClusterTenantStatus {
  tenantId: string;
  /** Databases mirrored with this peer, in replication order. */
  databases: string[];
  lastSyncAt: string | null;
  /** Entries the peer still owes us or we owe the peer, by head comparison. */
  lag: number;
  /** Entries rejected and queued for retry (see `entries-awaiting-directory-trust`). */
  retryQueueDepth: number;
  rejectedEntries: number;
  health: ClusterHealth;
  reasons: ClusterHealthReason[];
}

/** One peer as this node sees it. */
export interface ClusterPeerStatus {
  name: string;
  url: string | null;
  direction: PeerSyncDirection;
  role: PeerRole;
  attachments: PeerAttachmentMode;
  state: ClusterSessionState;
  health: ClusterHealth;
  reasons: ClusterHealthReason[];
  /** Tenants both sides hold, from the last Bloom intersection. */
  sharedTenants: number;
  lastIntersectionAt: string | null;
  lastSyncAt: string | null;
  eventsConnected: boolean;
  lag: number;
  retryQueueDepth: number;
  rejectedEntries: number;
  transferredEntries: number;
  transferredBytes: number;
  lastError: string | null;
  lastErrorClass: ClusterErrorClass | null;
  lastErrorAt: string | null;
}

/** Summary answer of `GET /system/cluster/status`. */
export interface ClusterStatusResponse {
  server: string | null;
  health: ClusterHealth;
  reasons: ClusterHealthReason[];
  autoSyncEnabled: boolean;
  generatedAt: string;
  peers: ClusterPeerStatus[];
}

/** Drill-down answer of `GET /system/cluster/status/tenants/:tenantId`. */
export interface ClusterTenantStatusResponse {
  tenantId: string;
  generatedAt: string;
  peers: Array<{ name: string; tenant: ClusterTenantStatus | null }>;
}

/** One entry of `GET /system/cluster/topology`. */
export interface ClusterTopologyPeer {
  name: string;
  url: string | null;
  direction: PeerSyncDirection;
  role: PeerRole;
  attachments: PeerAttachmentMode;
  sessionActive: boolean;
}

export interface ClusterTopologyResponse {
  /**
   * This node's own identity and role. The console starts here and then polls
   * every peer directly — no node answers on behalf of another (fan-out).
   */
  server: { name: string | null; role: PeerRole };
  peers: ClusterTopologyPeer[];
}

// =========================================================================
// Jobs
// =========================================================================

export type ClusterJobState = "queued" | "running" | "succeeded" | "failed";

export type ClusterJobKind =
  | "sync"
  | "retry-rejected"
  | "refresh-intersection"
  | "pause"
  | "resume";

export interface ClusterJobScope {
  peer?: string;
  tenantId?: string;
  dbId?: string;
}

export interface ClusterJob {
  id: string;
  kind: ClusterJobKind;
  scope: ClusterJobScope;
  state: ClusterJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Coarse progress counters; never carries document identity. */
  progress: { total: number; completed: number };
  result: ClusterJobResult | null;
  error: string | null;
  errorClass: ClusterErrorClass | null;
  /** System-admin principal that requested the job. */
  requestedBy: string;
}

export interface ClusterJobResult {
  transferredEntries: number;
  transferredBytes: number;
  /** Count only — the entry ids would leak document identity to the console. */
  rejectedEntries: number;
  tenantsProcessed: number;
  databasesProcessed: number;
}
