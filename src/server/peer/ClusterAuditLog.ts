/**
 * Append-only audit log for cluster administration.
 *
 * Every mutating `/system/cluster/*` call is recorded here before it runs, so
 * "who told this node to pause replication with the archive peer, and when"
 * survives a restart, a job eviction, and the console session that issued it.
 * The job registry is in-memory and transient by design; this is the durable
 * half.
 *
 * ## Per node, deliberately
 *
 * Each server writes its own log. There is no cluster-wide log, because there
 * is no cluster-wide admin: a peer is a separately administered server that
 * happens to trust this one for *data*, not for *administration*. A console
 * that wants the whole picture polls each node and merges — the same fan-out
 * model the status endpoints use.
 *
 * ## What is not in here
 *
 * No document ids, no author keys, no entry contents. An audit reader is
 * authorized to see that an action happened, not to learn which documents
 * moved: that would turn a read-only auditor role into a metadata oracle over
 * data the server itself cannot decrypt. Scope stops at the tenant/database
 * level and results are counts.
 */

import type { ClusterJobKind, ClusterJobScope } from "./types";

export interface ClusterAuditRecord {
  at: string;
  /** System-admin principal from the JWT (`sub`), never a device key. */
  actor: string;
  action: ClusterJobKind | "peer-create" | "peer-update" | "peer-delete";
  scope: ClusterJobScope;
  /** Job this action was dispatched as, when it runs asynchronously. */
  jobId: string | null;
  outcome: "accepted" | "rejected";
  /** Why a request was rejected. Absent for accepted ones. */
  detail?: string;
}

export interface ClusterAuditPage {
  records: ClusterAuditRecord[];
  /** Pass as `before` to fetch the next (older) page; null at the end. */
  nextCursor: string | null;
}

/**
 * Where the log lines live. On Node an append-only JSONL file with rotation
 * (`node/server/peer/FileClusterAuditStorage.ts`); other hosts use their own
 * storage. Lines are JSON records, oldest first.
 */
export interface ClusterAuditStorage {
  appendLine(line: string): void;
  /** The lines that are served (the active file on Node), oldest first. */
  readLines(): string[];
}

export class ClusterAuditLog {
  constructor(private readonly storage: ClusterAuditStorage) {}

  append(record: ClusterAuditRecord): void {
    try {
      this.storage.appendLine(JSON.stringify(record));
    } catch (error) {
      // A failing audit write must not fail the administrative action itself —
      // an operator locked out of pausing a runaway peer because a disk is full
      // is the worse outcome. It is loud in the log instead.
      console.error("[ClusterAuditLog] Could not append audit record:", error);
    }
  }

  /**
   * Read a page, newest first.
   *
   * `before` is an ISO timestamp from a previous page's `nextCursor`. Only what
   * the storage serves is read (on Node the active file: rotated files stay on
   * disk for offline forensics but are not served, which keeps the endpoint's
   * cost bounded no matter how long the node has been running).
   */
  read(options: { limit?: number; before?: string } = {}): ClusterAuditPage {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

    let lines: string[];
    try {
      lines = this.storage.readLines().filter(Boolean);
    } catch (error) {
      console.error("[ClusterAuditLog] Could not read audit log:", error);
      return { records: [], nextCursor: null };
    }

    const records: ClusterAuditRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      let record: ClusterAuditRecord;
      try {
        record = JSON.parse(lines[i]) as ClusterAuditRecord;
      } catch {
        continue;
      }
      if (options.before && record.at >= options.before) continue;
      records.push(record);
    }

    const last = records[records.length - 1];
    const exhausted = records.length < limit;
    return { records, nextCursor: exhausted || !last ? null : last.at };
  }
}
