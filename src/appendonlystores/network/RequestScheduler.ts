/**
 * Shared client-side gate for requests to one MindooDB server.
 *
 * A host that opens several databases at once — Teacher's Desk reads six —
 * creates one {@link HttpTransport} per database and store kind. Each of them
 * batches well on its own, but they know nothing about each other, so a cold
 * open fires a dozen independent bursts at the same server and collects 429s
 * that no single transport could have predicted.
 *
 * The gate is deliberately a concurrency bound rather than a delay. Capping
 * in-flight requests costs almost nothing in wall-clock time, because the
 * server works through them serially anyway; it only converts a spike into a
 * queue. A fixed inter-request delay would slow down the common case where
 * there is no contention at all.
 *
 * The second job is turning one 429 into a shared pause. Without it, the other
 * transports keep firing into a server that has already said stop, each
 * collecting its own rejection and its own backoff.
 */

/** Requests in flight per server before further ones queue. */
const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;

/**
 * Upper bound on a pause, however long `Retry-After` asks for. A hostile or
 * misconfigured server should not be able to park a client indefinitely.
 */
const DEFAULT_MAX_PAUSE_MS = 30_000;

/** Pause length when a 429 arrives without a usable `Retry-After`. */
const DEFAULT_FALLBACK_PAUSE_MS = 1_000;

export interface RequestSchedulerOptions {
  /** Requests in flight before further ones queue. Default: 6. */
  maxConcurrent?: number;
  /** Cap on any single pause, regardless of `Retry-After`. Default: 30s. */
  maxPauseMs?: number;
}

export class RequestScheduler {
  private readonly maxConcurrent: number;
  private readonly maxPauseMs: number;
  private active = 0;
  /** FIFO of slot handovers; a waiter owns a slot the moment it is resolved. */
  private readonly waiters: Array<() => void> = [];
  private pausedUntil = 0;

  constructor(options?: RequestSchedulerOptions) {
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_REQUESTS);
    this.maxPauseMs = Math.max(0, options?.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS);
  }

  /** Requests currently in flight. */
  get activeCount(): number {
    return this.active;
  }

  /** Requests waiting for a slot. */
  get queuedCount(): number {
    return this.waiters.length;
  }

  /** Whether the gate is currently holding everything back after a 429. */
  get isPaused(): boolean {
    return this.pausedUntil > Date.now();
  }

  /**
   * Run `task` once a slot is free and any pause has elapsed. Requests already
   * in flight are never cancelled — a pause holds back what has not started.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.waitOutPause();
    await this.acquireSlot();
    try {
      // A pause may have begun while this request sat in the queue.
      await this.waitOutPause();
      return await task();
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Hold back requests that have not started yet, typically for the duration a
   * 429 response asked for. Extends an existing pause but never shortens it.
   */
  pauseFor(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return;
    }
    const until = Date.now() + Math.min(delayMs, this.maxPauseMs);
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
    }
  }

  /** Pause using a server's `Retry-After`, falling back when it gave none. */
  pauseForRateLimit(retryAfterMs?: number): void {
    this.pauseFor(
      retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : DEFAULT_FALLBACK_PAUSE_MS,
    );
  }

  private async waitOutPause(): Promise<void> {
    for (;;) {
      const remaining = this.pausedUntil - Date.now();
      if (remaining <= 0) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  }

  private async acquireSlot(): Promise<void> {
    // Queue behind existing waiters even when a slot is free, so the gate stays
    // first-come-first-served instead of starving whoever waited longest.
    if (this.waiters.length === 0 && this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot over directly; `active` stays as it is.
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

const sharedSchedulers = new Map<string, RequestScheduler>();

/**
 * The gate for a server, shared by every transport pointing at it. Keyed by
 * origin rather than by base URL so that different tenants and databases on
 * one host queue together — the server and the network path are what is
 * actually contended, not the URL prefix.
 */
export function getSharedRequestScheduler(
  baseUrl: string,
  options?: RequestSchedulerOptions,
): RequestScheduler {
  const key = schedulerKeyForUrl(baseUrl);
  let scheduler = sharedSchedulers.get(key);
  if (!scheduler) {
    scheduler = new RequestScheduler(options);
    sharedSchedulers.set(key, scheduler);
  }
  return scheduler;
}

function schedulerKeyForUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/** Test seam: drop shared gates so one test's pause cannot leak into another. */
export function resetSharedRequestSchedulers(): void {
  sharedSchedulers.clear();
}
