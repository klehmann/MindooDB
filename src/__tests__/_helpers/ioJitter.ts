/**
 * Seeded I/O jitter for concurrency tests. In-memory stores resolve almost
 * everything as microtasks, so concurrent operations rarely interleave the
 * way they do against IndexedDB, the filesystem or a REST server. Wrapping
 * an object's async methods / async generators with {@link injectIoJitter}
 * inserts 0..maxYields macrotask yields before each call result (and before
 * each generator item), chosen by a seeded PRNG: interleavings vary with the
 * seed, and a failing seed reproduces the same schedule.
 */

/** mulberry32: small, fast, deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function jitter(random: () => number, maxYields: number): Promise<void> {
  const yields = Math.floor(random() * (maxYields + 1));
  for (let i = 0; i < yields; i++) {
    await macrotask();
  }
}

/**
 * Replace `methods` on `target` (in place) with jittered versions. Methods
 * returning a promise get jitter before resolving; methods returning an async
 * iterable get jitter before every item. Returns a function restoring the
 * originals.
 */
export function injectIoJitter(
  target: object,
  methods: string[],
  options: { seed: number; maxYields?: number },
): () => void {
  const random = seededRandom(options.seed);
  const maxYields = options.maxYields ?? 3;
  const record = target as Record<string, unknown>;
  const originals = new Map<string, unknown>();

  for (const name of methods) {
    const original = record[name];
    if (typeof original !== "function") {
      throw new Error(`injectIoJitter: ${name} is not a method`);
    }
    originals.set(name, Object.prototype.hasOwnProperty.call(target, name) ? original : undefined);
    record[name] = function (this: unknown, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        const source = result as AsyncIterable<unknown>;
        return (async function* () {
          for await (const item of source) {
            await jitter(random, maxYields);
            yield item;
          }
        })();
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).then(async (value) => {
          await jitter(random, maxYields);
          return value;
        });
      }
      return result;
    };
  }

  return () => {
    for (const [name, original] of originals) {
      if (original === undefined) {
        delete record[name];
      } else {
        record[name] = original;
      }
    }
  };
}
