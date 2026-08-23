/**
 * Job registry for the mutating cluster actions.
 *
 * Every `POST /system/cluster/actions/*` returns a `jobId` immediately instead
 * of holding the connection open. A full mirror of a large tenant can run for
 * minutes; a console that waits for the response would either time out at some
 * proxy or force the operator to stare at a spinner with no idea what is
 * happening. With a job the UI gets an id in milliseconds and then polls
 * `GET /system/cluster/jobs/:id` for typed progress.
 *
 * Jobs live in memory. They describe an action in flight, not a durable
 * promise: after a restart nothing is running, so there is nothing to report,
 * and the audit log (not this registry) is what preserves the record that the
 * action happened.
 */

import { randomUUID } from "crypto";
import {
  classifyPeerError,
  type ClusterJob,
  type ClusterJobKind,
  type ClusterJobResult,
  type ClusterJobScope,
} from "./types";

/** How many finished jobs to keep for polling before evicting the oldest. */
const DEFAULT_HISTORY_LIMIT = 200;

export interface ClusterJobContext {
  /** Report coarse progress; never pass document identity through here. */
  progress(completed: number, total: number): void;
}

export type ClusterJobWork = (ctx: ClusterJobContext) => Promise<ClusterJobResult>;

export class ClusterJobRunner {
  private readonly jobs = new Map<string, ClusterJob>();
  private readonly order: string[] = [];

  constructor(private readonly historyLimit: number = DEFAULT_HISTORY_LIMIT) {}

  /**
   * Register a job and start it. Returns as soon as the job is queued, so the
   * caller can answer `202 Accepted` with the id.
   */
  start(
    kind: ClusterJobKind,
    scope: ClusterJobScope,
    requestedBy: string,
    work: ClusterJobWork,
  ): ClusterJob {
    const job: ClusterJob = {
      id: randomUUID(),
      kind,
      scope,
      state: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: { total: 0, completed: 0 },
      result: null,
      error: null,
      errorClass: null,
      requestedBy,
    };

    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.evictOverLimit();

    void this.run(job, work);
    return job;
  }

  private async run(job: ClusterJob, work: ClusterJobWork): Promise<void> {
    job.state = "running";
    job.startedAt = new Date().toISOString();
    try {
      job.result = await work({
        progress: (completed, total) => {
          job.progress = { completed, total };
        },
      });
      job.state = "succeeded";
    } catch (error) {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.errorClass = classifyPeerError(error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  get(id: string): ClusterJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** Newest first, which is the order a console wants to render. */
  list(limit = 50): ClusterJob[] {
    const ids = this.order.slice(-limit).reverse();
    return ids
      .map((id) => this.jobs.get(id))
      .filter((job): job is ClusterJob => job !== undefined);
  }

  /**
   * Wait for a job to settle. Only for tests — the HTTP surface always polls,
   * because that is the contract the console is built against.
   */
  async waitFor(id: string, timeoutMs = 30_000): Promise<ClusterJob | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this.jobs.get(id);
      if (!job) return null;
      if (job.state === "succeeded" || job.state === "failed") return job;
      if (Date.now() > deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private evictOverLimit(): void {
    let index = 0;
    while (this.order.length > this.historyLimit && index < this.order.length) {
      const id = this.order[index];
      const job = this.jobs.get(id);
      // Never drop a job that is still going: its id is in a caller's hands and
      // they are polling for it. Skip past it and evict the next finished one,
      // which keeps `order` oldest-to-newest.
      if (job && (job.state === "queued" || job.state === "running")) {
        index += 1;
        continue;
      }
      this.order.splice(index, 1);
      this.jobs.delete(id);
    }
  }
}
