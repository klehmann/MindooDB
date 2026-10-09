import { SingleFlight } from "../core/utils/singleFlight";

describe("SingleFlight", () => {
  function controllableTask() {
    let starts = 0;
    let running = 0;
    let maxRunning = 0;
    const releases: Array<(fail?: boolean) => void> = [];
    const task = () => {
      starts++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<number>((resolve, reject) => {
        const run = starts;
        releases.push((fail) => {
          running--;
          if (fail) reject(new Error(`run ${run} failed`));
          else resolve(run);
        });
      });
    };
    return {
      task,
      starts: () => starts,
      maxRunning: () => maxRunning,
      release: (index: number, fail?: boolean) => releases[index](fail),
    };
  }

  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("runs one task at a time and gives all mid-run callers one shared follow-up", async () => {
    const t = controllableTask();
    const flight = new SingleFlight(t.task);

    const first = flight.run();
    const late = [flight.run(), flight.run(), flight.run()];
    expect(t.starts()).toBe(1);

    t.release(0);
    expect(await first).toBe(1);
    await tick();
    expect(t.starts()).toBe(2);
    t.release(1);

    expect(await Promise.all(late)).toEqual([2, 2, 2]);
    expect(t.maxRunning()).toBe(1);
    expect(flight.isBusy()).toBe(false);
  });

  it("still runs the follow-up when the in-flight run fails", async () => {
    const t = controllableTask();
    const flight = new SingleFlight(t.task);

    const first = flight.run();
    const late = flight.run();
    t.release(0, true);
    await expect(first).rejects.toThrow("run 1 failed");
    await tick();
    t.release(1);
    expect(await late).toBe(2);
  });
});
