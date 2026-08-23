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

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { join } from "path";
import type { ClusterJobKind, ClusterJobScope } from "./types";

/** Rotate once the active file passes this size. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

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

export class ClusterAuditLog {
  private readonly dir: string;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    this.dir = join(dataDir, "cluster");
    this.file = join(this.dir, "audit.jsonl");
  }

  append(record: ClusterAuditRecord): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
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
   * `before` is an ISO timestamp from a previous page's `nextCursor`. Only the
   * active file is read: rotated files stay on disk for offline forensics but
   * are not served, which keeps the endpoint's cost bounded no matter how long
   * the node has been running.
   */
  read(options: { limit?: number; before?: string } = {}): ClusterAuditPage {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    if (!existsSync(this.file)) return { records: [], nextCursor: null };

    let lines: string[];
    try {
      lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
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

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < this.maxBytes) return;
    renameSync(this.file, `${this.file}.${Date.now()}`);
  }
}
