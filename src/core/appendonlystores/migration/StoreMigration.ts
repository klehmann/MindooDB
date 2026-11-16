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
import type { ContentAddressedStore, ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions, StoreScanCursor } from "../types";
import type { StoreEntryMetadata } from "../../types";

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

// ---------------------------------------------------------------------------
// Resumable copy with verification (switch backends only after success)
// ---------------------------------------------------------------------------

/** Progress of a resumable copy; persist it after every batch to resume after a crash. */
export interface StoreCopyCheckpoint {
  /** Source scan position after the last copied batch (null: start). */
  cursor: StoreScanCursor | null;
  /** Entries copied so far, across resumed runs. */
  copied: number;
}

export interface ResumableCopyOptions {
  /** Entries per batch (default 200). */
  batchSize?: number;
  /** Where a previous, interrupted run stopped. */
  checkpoint?: StoreCopyCheckpoint | null;
  /** Called after every batch was written to the target; persist the checkpoint here. */
  onCheckpoint?(checkpoint: StoreCopyCheckpoint): void | Promise<void>;
}

/**
 * Copies every entry of `source` into `target` in the source's receipt order,
 * so the target assigns its receipt order in the same sequence. Resumable:
 * pass the last checkpoint to continue; entries already in the target are
 * skipped by `putEntries`. Needs `scanEntriesSince` on the source.
 */
export async function copyStoreResumable(
  source: ContentAddressedStore,
  target: ContentAddressedStore,
  options: ResumableCopyOptions = {},
): Promise<StoreCopyCheckpoint> {
  if (!source.scanEntriesSince) {
    throw new Error("copyStoreResumable needs a source store with scanEntriesSince");
  }
  const batchSize = Math.max(1, options.batchSize ?? 200);
  let checkpoint: StoreCopyCheckpoint = options.checkpoint ?? { cursor: null, copied: 0 };
  for (;;) {
    const page = await source.scanEntriesSince(checkpoint.cursor, batchSize);
    if (page.entries.length > 0) {
      const ids = page.entries.map((meta) => meta.id);
      const entries = await source.getEntries(ids);
      if (entries.length !== ids.length) {
        const found = new Set(entries.map((entry) => entry.id));
        const missing = ids.filter((id) => !found.has(id));
        throw new Error(`source store is missing payloads for ${missing.length} entries (e.g. ${missing[0]})`);
      }
      await target.putEntries(entries);
      checkpoint = { cursor: page.nextCursor ?? checkpoint.cursor, copied: checkpoint.copied + entries.length };
      await options.onCheckpoint?.(checkpoint);
    }
    if (!page.hasMore || !page.nextCursor) {
      return checkpoint;
    }
  }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Fields of an entry that must survive a copy unchanged (everything but the receipt order). */
function metadataDifference(a: StoreEntryMetadata, b: StoreEntryMetadata): string | null {
  const scalar: Array<keyof StoreEntryMetadata> = [
    "entryType", "contentHash", "docId", "createdAt", "createdByPublicKey", "decryptionKeyId",
    "originalSize", "encryptedSize", "receivedAt", "receivedByPublicKey", "receiptScheme", "entryVersion",
  ];
  for (const key of scalar) {
    if (a[key] !== b[key]) {
      return String(key);
    }
  }
  if (JSON.stringify(a.dependencyIds ?? []) !== JSON.stringify(b.dependencyIds ?? [])) {
    return "dependencyIds";
  }
  if (!sameBytes(a.signature, b.signature)) return "signature";
  if (!sameBytes(a.metadataSignature, b.metadataSignature)) return "metadataSignature";
  if (!sameBytes(a.receivedDateSignature, b.receivedDateSignature)) return "receivedDateSignature";
  return null;
}

export interface StoreCopyVerification {
  ok: boolean;
  sourceEntries: number;
  targetEntries: number;
  /** Payloads compared byte by byte. */
  payloadsCompared: number;
  /** First problem found, when not ok. */
  problem?: string;
}

/**
 * Checks that `target` holds exactly the entries of `source`: same ids, same
 * metadata (signatures and witness receipts included) and, for a sample of
 * `payloadSample` entries (default 50; Infinity for all), the same payload bytes.
 */
export async function verifyStoreCopy(
  source: ContentAddressedStore,
  target: ContentAddressedStore,
  options: { payloadSample?: number; batchSize?: number } = {},
): Promise<StoreCopyVerification> {
  const sourceIds = (await source.getAllIds()).sort();
  const targetIds = (await target.getAllIds()).sort();
  const result: StoreCopyVerification = {
    ok: false,
    sourceEntries: sourceIds.length,
    targetEntries: targetIds.length,
    payloadsCompared: 0,
  };
  if (sourceIds.length !== targetIds.length) {
    return { ...result, problem: `entry count differs (${sourceIds.length} vs ${targetIds.length})` };
  }
  for (let i = 0; i < sourceIds.length; i++) {
    if (sourceIds[i] !== targetIds[i]) {
      return { ...result, problem: `entry ids differ (e.g. ${sourceIds[i]})` };
    }
  }
  const batchSize = options.batchSize ?? 200;
  const sample = options.payloadSample ?? 50;
  const step = sample >= sourceIds.length ? 1 : Math.max(1, Math.floor(sourceIds.length / Math.max(1, sample)));
  for (let i = 0; i < sourceIds.length; i += batchSize) {
    const ids = sourceIds.slice(i, i + batchSize);
    const [sourceMeta, targetMeta] = await Promise.all([
      Promise.all(ids.map((id) => source.getEntryMetadata(id))),
      Promise.all(ids.map((id) => target.getEntryMetadata(id))),
    ]);
    for (let j = 0; j < ids.length; j++) {
      const a = sourceMeta[j];
      const b = targetMeta[j];
      if (!a || !b) {
        return { ...result, problem: `metadata missing for ${ids[j]}` };
      }
      const difference = metadataDifference(a, b);
      if (difference) {
        return { ...result, problem: `${difference} differs for ${ids[j]}` };
      }
    }
    const sampled = ids.filter((_, j) => (i + j) % step === 0);
    if (sampled.length > 0) {
      const [sourceEntries, targetEntries] = await Promise.all([source.getEntries(sampled), target.getEntries(sampled)]);
      const targetById = new Map(targetEntries.map((entry) => [entry.id, entry]));
      for (const entry of sourceEntries) {
        const copy = targetById.get(entry.id);
        if (!copy || !sameBytes(entry.encryptedData, copy.encryptedData)) {
          return { ...result, problem: `payload differs for ${entry.id}` };
        }
        result.payloadsCompared++;
      }
    }
  }
  return { ...result, ok: true };
}
