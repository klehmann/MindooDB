import { CacheManager, ICacheable } from "../core/cache/CacheManager";
import { InMemoryLocalCacheStore, LocalCacheStore } from "../core/cache/LocalCacheStore";

/** Cacheable whose flush can be held open, recording what each flush persisted. */
class GatedCacheable implements ICacheable {
  version = 0;
  persistedVersion = -1;
  flushes: Array<{ force: boolean }> = [];
  private flushedVersion = -1;
  private hold: Promise<void> | null = null;
  private onFlushStarted: (() => void) | null = null;

  getCachePrefix(): string {
    return "gated";
  }

  hasDirtyState(): boolean {
    return this.version !== this.flushedVersion;
  }

  clearDirty(): void {
    // Dirty state is version-based: nothing to clear beyond what the flush recorded.
  }

  holdNextFlush(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    this.hold = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (this.onFlushStarted = resolve));
    return { started, release };
  }

  async flushToCache(_store: LocalCacheStore, options?: { force?: boolean }): Promise<number> {
    const snapshot = this.version;
    this.flushes.push({ force: options?.force === true });
    this.flushedVersion = snapshot;
    this.onFlushStarted?.();
    this.onFlushStarted = null;
    const hold = this.hold;
    this.hold = null;
    if (hold) await hold;
    this.persistedVersion = snapshot;
    return 1;
  }
}

describe("CacheManager flush", () => {
  it("dispose during a running flush still persists the state changed since that flush started", async () => {
    const manager = new CacheManager(new InMemoryLocalCacheStore(), { flushIntervalMs: 60000 });
    const cacheable = new GatedCacheable();
    manager.register(cacheable);

    cacheable.version = 1;
    const held = cacheable.holdNextFlush();
    const timerLikeFlush = manager.flush();
    await held.started;

    cacheable.version = 2;
    const disposed = manager.dispose();
    held.release();
    await Promise.all([timerLikeFlush, disposed]);

    expect(cacheable.persistedVersion).toBe(2);
    expect(cacheable.flushes).toEqual([{ force: false }, { force: true }]);
  });

  it("coalesces flushes requested during a run into one follow-up", async () => {
    const manager = new CacheManager(new InMemoryLocalCacheStore(), { flushIntervalMs: 60000 });
    const cacheable = new GatedCacheable();
    manager.register(cacheable);

    cacheable.version = 1;
    const held = cacheable.holdNextFlush();
    const first = manager.flush();
    await held.started;
    cacheable.version = 2;
    const followUps = [manager.flush(), manager.flush(), manager.flush()];
    held.release();
    await Promise.all([first, ...followUps]);

    expect(cacheable.flushes).toHaveLength(2);
    expect(cacheable.persistedVersion).toBe(2);
    await manager.dispose();
  });
});
