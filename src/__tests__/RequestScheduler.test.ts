import {
  RequestScheduler,
  getSharedRequestScheduler,
  resetSharedRequestSchedulers,
} from "../appendonlystores/network/RequestScheduler";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("RequestScheduler", () => {
  afterEach(() => {
    resetSharedRequestSchedulers();
  });

  test("never runs more than maxConcurrent tasks at once", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 3 });
    let inFlight = 0;
    let peak = 0;
    const gate = deferred();

    const runs = Array.from({ length: 10 }, () =>
      scheduler.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight -= 1;
      }),
    );

    await tick();
    expect(peak).toBe(3);
    expect(scheduler.queuedCount).toBe(7);

    gate.resolve();
    await Promise.all(runs);

    expect(peak).toBe(3);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
  });

  test("a queued task takes the slot a finished one releases", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 1 });
    const first = deferred();
    const started: string[] = [];

    const firstRun = scheduler.run(async () => {
      started.push("first");
      await first.promise;
    });
    const secondRun = scheduler.run(async () => {
      started.push("second");
    });

    await tick();
    expect(started).toEqual(["first"]);

    first.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(started).toEqual(["first", "second"]);
  });

  test("a pause holds back tasks that have not started", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 4 });
    scheduler.pauseFor(60);
    expect(scheduler.isPaused).toBe(true);

    const startedAt = Date.now();
    let ranAt = 0;
    await scheduler.run(async () => {
      ranAt = Date.now();
    });

    // Timer resolution is coarse enough that an exact 60ms assert would flake.
    expect(ranAt - startedAt).toBeGreaterThanOrEqual(50);
    expect(scheduler.isPaused).toBe(false);
  });

  test("a pause does not interrupt a task already in flight", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 2 });
    const release = deferred();
    let finished = false;

    const run = scheduler.run(async () => {
      scheduler.pauseFor(10_000);
      await release.promise;
      finished = true;
    });

    await tick();
    release.resolve();
    await run;
    expect(finished).toBe(true);
  });

  test("a pause extends but never shortens an existing one", () => {
    const scheduler = new RequestScheduler();
    scheduler.pauseFor(5_000);
    scheduler.pauseFor(10);
    expect(scheduler.isPaused).toBe(true);
  });

  test("a pause is capped however long Retry-After asks for", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 1, maxPauseMs: 30 });
    scheduler.pauseForRateLimit(600_000);

    const startedAt = Date.now();
    await scheduler.run(async () => undefined);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("transports on one origin share a gate, different origins do not", () => {
    const docs = getSharedRequestScheduler("https://sync.example.com/tenant-a");
    const attachments = getSharedRequestScheduler("https://sync.example.com/tenant-b");
    const elsewhere = getSharedRequestScheduler("https://other.example.com/tenant-a");

    expect(docs).toBe(attachments);
    expect(docs).not.toBe(elsewhere);
  });
});
