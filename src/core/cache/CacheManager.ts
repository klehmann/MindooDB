import { LocalCacheStore } from "./LocalCacheStore";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * Interface that cacheable consumers (BaseMindooDB, VirtualView) implement
 * so the CacheManager can flush their dirty state.
 */
export interface ICacheable {
  /**
   * A unique key identifying this cacheable in the cache store.
   * For BaseMindooDB: tenantId + "/" + store.getCacheIdentity()
   * For VirtualView: viewId + "/" + version
   */
  getCachePrefix(): string;

  /**
   * Export the current dirty state to the cache store.
   * Called by CacheManager during flush.
   *
   * @param store   The cache store to write to
   * @param options `force: true` on shutdown/deregister paths — implementations
   *                must persist immediately and may not defer (e.g. a
   *                VirtualView's minimum flush interval is bypassed)
   * @returns The number of entries written
   */
  flushToCache(store: LocalCacheStore, options?: { force?: boolean }): Promise<number>;

  /**
   * Clear the dirty tracking state after a successful flush.
   */
  clearDirty(): void;

  /**
   * Whether this cacheable has any dirty state to flush.
   */
  hasDirtyState(): boolean;
}

export interface CacheManagerOptions {
  /** Flush interval in milliseconds. Default: 5000 (5s) */
  flushIntervalMs?: number;
}

/**
 * Coordinates periodic cache persistence for all registered cacheables
 * (databases, virtual views) within a tenant.
 *
 * Tracks dirty state and flushes periodically or on demand.
 */
export class CacheManager {
  private store: LocalCacheStore;
  private cacheables: Set<ICacheable> = new Set();
  private flushIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Single-flight flush with one shared follow-up: a flush requested while
  // another runs (e.g. dispose during a timer flush) must still persist the
  // state changed since that run started, not return early.
  private flushRun: Promise<void> | null = null;
  private flushQueued: Promise<void> | null = null;
  private queuedFlushForce: boolean = false;
  private disposed: boolean = false;
  private logger: Logger;

  constructor(store: LocalCacheStore, options?: CacheManagerOptions, logger?: Logger) {
    this.store = store;
    this.flushIntervalMs = options?.flushIntervalMs ?? 5000;
    this.logger = logger || new MindooLogger(getDefaultLogLevel(), "CacheManager", true);
  }

  getStore(): LocalCacheStore {
    return this.store;
  }

  /**
   * Register a cacheable consumer. It will be included in periodic flushes.
   */
  register(cacheable: ICacheable): void {
    this.cacheables.add(cacheable);
  }

  /**
   * Deregister a cacheable consumer (e.g. on db.close()).
   * Triggers an immediate flush for this cacheable before removal.
   */
  async deregister(cacheable: ICacheable): Promise<void> {
    if (!cacheable.hasDirtyState()) {
      // Remove synchronously: purge paths discard the dirty state first and
      // rely on a running flush no longer reaching this cacheable.
      this.cacheables.delete(cacheable);
      return;
    }
    // Never flush one cacheable from two places at once.
    await this.flushRun?.catch(() => undefined);
    if (cacheable.hasDirtyState()) {
      try {
        await cacheable.flushToCache(this.store, { force: true });
        cacheable.clearDirty();
      } catch (e) {
        this.logger.warn(`Failed to flush cache for ${cacheable.getCachePrefix()} on deregister: ${e}`);
      }
    }
    this.cacheables.delete(cacheable);
  }

  /**
   * Notify the CacheManager that something changed.
   * Schedules a flush if one is not already pending.
   */
  markDirty(): void {
    if (this.disposed) return;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Immediately flush all dirty cacheables.
   *
   * @param options `force: true` bypasses per-cacheable flush deferral
   *   (used on dispose so shutdown never skips pending state)
   */
  flush(options?: { force?: boolean }): Promise<void> {
    if (!this.flushRun) {
      const run = this.runFlush(options).finally(() => {
        if (this.flushRun === run) {
          this.flushRun = null;
        }
      });
      this.flushRun = run;
      return run;
    }
    if (options?.force) {
      this.queuedFlushForce = true;
    }
    if (!this.flushQueued) {
      this.flushQueued = this.flushRun.then(() => {
        this.flushQueued = null;
        const force = this.queuedFlushForce;
        this.queuedFlushForce = false;
        return this.flush(force ? { force } : undefined);
      });
    }
    return this.flushQueued;
  }

  private async runFlush(options?: { force?: boolean }): Promise<void> {
    for (const cacheable of this.cacheables) {
      if (!cacheable.hasDirtyState()) continue;

      try {
        const count = await cacheable.flushToCache(this.store, options);
        cacheable.clearDirty();
        this.logger.debug(`Flushed ${count} entries for ${cacheable.getCachePrefix()}`);
      } catch (e) {
        this.logger.warn(`Cache flush failed for ${cacheable.getCachePrefix()}: ${e}`);
      }
    }
  }

  /**
   * Flush all pending state and stop the periodic timer.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush({ force: true });
  }
}
