/**
 * Coalesces concurrent runs of one async task.
 *
 * At most one run is in flight. A caller arriving while a run is in flight
 * gets a single follow-up run that starts after it (so the caller observes
 * every change that preceded its call); all such callers share that follow-up.
 * N concurrent callers therefore cause at most two sequential runs.
 *
 * The task must not call {@link SingleFlight.run} on the same instance
 * (directly or indirectly), or it waits for itself.
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;
  private queued: Promise<T> | null = null;

  constructor(private readonly task: () => Promise<T>) {}

  run(): Promise<T> {
    if (!this.inFlight) {
      const current = this.task().finally(() => {
        if (this.inFlight === current) {
          this.inFlight = null;
        }
      });
      this.inFlight = current;
      return current;
    }
    if (!this.queued) {
      this.queued = this.inFlight
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.run();
        });
    }
    return this.queued;
  }

  /** True while a run is in flight or queued. */
  isBusy(): boolean {
    return this.inFlight !== null || this.queued !== null;
  }
}
