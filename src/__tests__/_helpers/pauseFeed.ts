/**
 * Make the next matching `iterateChangesSince(cursor)` call on `db` take its
 * snapshot of the feed immediately, then pause after the first item until
 * released. Gives tests a deterministic point inside a running catch-up pass
 * at which to interleave other operations.
 *
 * @param since `null` only matches a call from the start of the feed (e.g. a
 *   backfill), `"any"` matches the next call regardless of its cursor.
 */
export function pauseNextFeedRead(
  db: unknown,
  since: "any" | null,
): { paused: Promise<void>; release: () => void } {
  const target = db as { iterateChangesSince(cursor: unknown): AsyncIterable<unknown> };
  const original = target.iterateChangesSince;
  let signalPaused!: () => void;
  const paused = new Promise<void>((resolve) => (signalPaused = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  target.iterateChangesSince = function (this: unknown, cursor: unknown) {
    if (since === null && cursor !== null) {
      return original.call(this, cursor);
    }
    target.iterateChangesSince = original;
    const source = original.call(this, cursor);
    return (async function* () {
      const snapshot: unknown[] = [];
      for await (const item of source) snapshot.push(item);
      for (let i = 0; i < snapshot.length; i++) {
        yield snapshot[i];
        if (i === 0) {
          signalPaused();
          await released;
        }
      }
    })();
  };
  return { paused, release };
}
