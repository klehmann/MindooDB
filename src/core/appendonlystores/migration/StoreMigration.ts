/**
 * Moving a store's data to a new storage backend, e.g. when Haven's native
 * app switches from the WebView's IndexedDB to SQLite in the host app.
 *
 * {@link MigratingContentAddressedStoreFactory} hands out the target stores;
 * the first call on a store copies all entries from the matching source store
 * if the target is still empty. Copying is idempotent (putEntries skips ids
 * already stored), so an interrupted copy resumes on the next start. The
 * source keeps its data.
 */
import type { ContentAddressedStore, ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions } from "../types";

/** Methods answered without waiting for the copy (they are synchronous). */
const SYNC_METHODS = new Set(["getId", "getStoreKind", "getIndexBuildStatus", "getCacheIdentity"]);

export interface StoreMigrationOptions {
  /** Entries per copy batch (default 100: up to ~25 MB with 256 KB attachment chunks). */
  batchSize?: number;
  /** Called after a store was copied (not when there was nothing to copy). */
  onMigrated?(info: { dbId: string; kind: string; entries: number }): void;
}

/** Copies every entry of `source` into `target` unless `target` already has entries. Returns the count copied. */
export async function migrateStoreEntries(
  source: ContentAddressedStore,
  target: ContentAddressedStore,
  batchSize = 100,
): Promise<number> {
  const targetHasData = target.getStoreHead
    ? (await target.getStoreHead()).maxReceiptOrder > 0
    : (await target.getAllIds()).length > 0;
  if (targetHasData) {
    return 0;
  }
  const ids = await source.getAllIds();
  let copied = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const entries = await source.getEntries(ids.slice(i, i + batchSize));
    if (entries.length > 0) {
      await target.putEntries(entries);
      copied += entries.length;
    }
  }
  return copied;
}

/** `target`, but every async call first waits until `source` was copied into it. */
export function withStoreMigration(
  target: ContentAddressedStore,
  source: ContentAddressedStore,
  options: StoreMigrationOptions = {},
): ContentAddressedStore {
  let ready: Promise<void> | null = null;
  const migrate = () => {
    if (!ready) {
      ready = migrateStoreEntries(source, target, options.batchSize).then((entries) => {
        if (entries > 0) {
          options.onMigrated?.({ dbId: target.getId(), kind: target.getStoreKind(), entries });
        }
      });
    }
    return ready;
  };
  return new Proxy(target, {
    get(store, property, receiver) {
      const value = Reflect.get(store, property, receiver);
      if (typeof value !== "function" || typeof property !== "string" || SYNC_METHODS.has(property)) {
        return typeof value === "function" ? value.bind(store) : value;
      }
      return async (...args: unknown[]) => {
        await migrate();
        return (value as (...a: unknown[]) => unknown).apply(store, args);
      };
    },
  });
}

/** Target stores that first take over the source's data (see {@link withStoreMigration}). */
export class MigratingContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  constructor(
    private readonly target: ContentAddressedStoreFactory,
    private readonly source: ContentAddressedStoreFactory,
    private readonly options: StoreMigrationOptions = {},
  ) {}

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    const target = this.target.createStore(dbId, options);
    const source = this.source.createStore(dbId, options);
    return {
      docStore: withStoreMigration(target.docStore, source.docStore, this.options),
      attachmentStore: withStoreMigration(target.attachmentStore, source.attachmentStore, this.options),
    };
  }
}
