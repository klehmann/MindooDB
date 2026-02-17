/**
 * Factory for creating IndexedDB-backed ContentAddressedStore instances.
 *
 * Each database gets its own isolated IndexedDB database, named
 * `mindoodb_<basePath>_<dbId>`. The `basePath` acts as a namespace
 * (typically encoding the tenant identity) to isolate stores across
 * multiple tenants on the same domain.
 *
 * @module IndexedDBContentAddressedStoreFactory
 */

import type {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
} from "../../core/appendonlystores/types";
import type { Logger } from "../../core/logging";
import { IndexedDBContentAddressedStore } from "./IndexedDBContentAddressedStore";

export class IndexedDBContentAddressedStoreFactory
  implements ContentAddressedStoreFactory
{
  private readonly defaultBasePath: string;
  private readonly logger?: Logger;

  /**
   * @param defaultBasePath Default IDB namespace prefix used when
   *   `options.basePath` is not provided to `createStore()`.
   *   Typically encodes the tenant identity (e.g. `"tenant-abc"`).
   * @param logger Optional logger instance shared across created stores.
   */
  constructor(defaultBasePath: string = "default", logger?: Logger) {
    this.defaultBasePath = defaultBasePath;
    this.logger = logger;
  }

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    const mergedOptions: OpenStoreOptions = {
      ...options,
      basePath: (options?.basePath as string) || this.defaultBasePath,
    };

    const store = new IndexedDBContentAddressedStore(
      dbId,
      this.logger,
      mergedOptions
    );

    if (mergedOptions.clearLocalDataOnStartup) {
      void store.clearAllLocalData();
    }

    return {
      docStore: store,
    };
  }
}
