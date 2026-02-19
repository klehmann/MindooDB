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
   * @param store  The cache store to write to
   * @returns The number of entries written
   */
  flushToCache(store: LocalCacheStore): Promise<number>;

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
  private flushInProgress: boolean = false;
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
    if (cacheable.hasDirtyState()) {
      try {
        await cacheable.flushToCache(this.store);
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
   */
  async flush(): Promise<void> {
    if (this.flushInProgress) return;
    this.flushInProgress = true;

    try {
      for (const cacheable of this.cacheables) {
        if (!cacheable.hasDirtyState()) continue;

        try {
          const count = await cacheable.flushToCache(this.store);
          cacheable.clearDirty();
          this.logger.debug(`Flushed ${count} entries for ${cacheable.getCachePrefix()}`);
        } catch (e) {
          this.logger.warn(`Cache flush failed for ${cacheable.getCachePrefix()}: ${e}`);
        }
      }
    } finally {
      this.flushInProgress = false;
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
    await this.flush();
  }
}
