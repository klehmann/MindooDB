/**
 * Keeps track of fire-and-forget work (auto-follow catch-ups, open-time
 * probes, trust/key reconciles) so that shutdown and tests can wait until it
 * has finished instead of guessing a delay.
 *
 * Tracked tasks must handle their own errors; a rejection only removes the
 * task from the set.
 */
export class BackgroundTaskTracker {
  private readonly pending = new Set<Promise<unknown>>();

  run(task: Promise<unknown>): void {
    this.pending.add(task);
    const remove = () => {
      this.pending.delete(task);
    };
    task.then(remove, remove);
  }

  /**
   * Resolve once no tracked task is pending, including tasks started while
   * waiting. Returns whether there was anything to wait for.
   */
  async settle(): Promise<boolean> {
    let waited = false;
    while (this.pending.size > 0) {
      waited = true;
      await Promise.allSettled(Array.from(this.pending));
    }
    return waited;
  }
}
