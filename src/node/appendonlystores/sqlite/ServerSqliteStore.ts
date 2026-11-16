/**
 * The server's `"sqlite"` store type, including the one-time move of an
 * existing `"file"` store ({@link BasicOnDiskContentAddressedStore}) into
 * SQLite.
 *
 * Both store types share the directory `<basePath>/<dbId>/<storeKind>/`. A
 * marker file `store-backend.json` records which backend owns it. The move
 * runs on first use of the store, before any call is answered:
 *
 * 1. copy every entry in receipt order, saving a checkpoint after each batch
 *    (`sqlite-migration.json`), so a crash resumes where it stopped;
 * 2. verify ids, metadata (signatures, witness receipts) and a payload sample;
 * 3. only then write the marker, and move the file store's data into
 *    `legacy-file-store/` (kept for a manual rollback; delete it by hand).
 *
 * If copying or verifying fails, the SQLite files are removed and the file
 * store keeps serving; the move is retried on the next start, at most
 * {@link MAX_MIGRATION_ATTEMPTS} times.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "fs";
import { open, rename } from "fs/promises";
import * as path from "path";

import {
  copyStoreResumable,
  verifyStoreCopy,
  type StoreCopyCheckpoint,
} from "../../../core/appendonlystores/migration/StoreMigration";
import type { ContentAddressedStore, OpenStoreOptions, StoreKind } from "../../../core/appendonlystores/types";
import { MindooLogger, getDefaultLogLevel, type Logger } from "../../../core/logging";
import { SqliteContentAddressedStore } from "../../../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { BasicOnDiskContentAddressedStore } from "../BasicOnDiskContentAddressedStore";
import { SQLITE_BLOB_DIR, SQLITE_STORE_FILE, openNodeSqliteStore, type NodeSqliteStoreHandle } from "./NodeSqliteStore";

export const STORE_BACKEND_FILE = "store-backend.json";
export const SQLITE_MIGRATION_STATE_FILE = "sqlite-migration.json";
export const LEGACY_FILE_STORE_DIR = "legacy-file-store";
export const MAX_MIGRATION_ATTEMPTS = 3;

/** What `BasicOnDiskContentAddressedStore` keeps in a store directory. */
const FILE_STORE_PARTS = ["entries", "content", "metadata-index.json", "metadata-segments", "store-epoch.json"];

interface BackendMarker {
  backend: "sqlite";
  migratedFrom?: "file";
  entries?: number;
  migratedAt?: number;
}

interface MigrationState {
  attempts: number;
  checkpoint: StoreCopyCheckpoint | null;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonDurably(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  try {
    const dir = await open(path.dirname(file), "r");
    await dir.sync().finally(() => dir.close());
  } catch {
    // Directory fsync is not supported everywhere; the rename stays atomic.
  }
}

/** Synchronous {@link writeJsonDurably}, for the marker of a new store. */
function writeJsonDurablySync(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** Store directory of `dbId`/`storeKind` below `basePath`, shared by the file and sqlite types. */
export function storeDirectory(basePath: string, dbId: string, storeKind: StoreKind): string {
  return path.join(basePath, dbId, storeKind);
}

/** Whether `dir` already belongs to the sqlite backend (its marker is written). */
export function isSqliteStoreDirectory(dir: string): boolean {
  return readJson<BackendMarker>(path.join(dir, STORE_BACKEND_FILE))?.backend === "sqlite";
}

function hasFileStoreData(dir: string): boolean {
  return existsSync(path.join(dir, "entries"));
}

function removeSqliteFiles(dir: string): void {
  for (const name of [SQLITE_STORE_FILE, `${SQLITE_STORE_FILE}-wal`, `${SQLITE_STORE_FILE}-shm`, SQLITE_BLOB_DIR]) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function moveFileStoreToLegacy(dir: string): void {
  const legacy = path.join(dir, LEGACY_FILE_STORE_DIR);
  mkdirSync(legacy, { recursive: true });
  for (const part of FILE_STORE_PARTS) {
    const from = path.join(dir, part);
    if (existsSync(from)) {
      renameSync(from, path.join(legacy, part));
    }
  }
}

export interface ServerSqliteStoreOptions extends OpenStoreOptions {
  basePath: string;
  blobThresholdBytes?: number;
  /** Entries per copy batch while moving a file store (default 200). */
  migrationBatchSize?: number;
  /** Payloads compared byte by byte after the move (default 200). */
  migrationPayloadSample?: number;
}

/**
 * Moves the file store in `dir` into SQLite. Resolves with the store that
 * should serve: the SQLite store after a verified move, else the file store.
 */
async function migrateFileStore(
  dir: string,
  dbId: string,
  storeKind: StoreKind,
  logger: Logger,
  options: ServerSqliteStoreOptions,
): Promise<ContentAddressedStore> {
  const statePath = path.join(dir, SQLITE_MIGRATION_STATE_FILE);
  const state: MigrationState = readJson<MigrationState>(statePath) ?? { attempts: 0, checkpoint: null };
  const source = new BasicOnDiskContentAddressedStore(dbId, storeKind, logger, { basePath: options.basePath });
  if (state.attempts >= MAX_MIGRATION_ATTEMPTS) {
    logger.error(
      `Moving ${dbId}/${storeKind} to sqlite failed ${state.attempts} times; serving the file store. ` +
        `Delete ${statePath} to try again.`,
    );
    return source;
  }
  state.attempts += 1;
  await writeJsonDurably(statePath, state);

  let target: NodeSqliteStoreHandle | null = null;
  const startedAt = Date.now();
  try {
    if (!state.checkpoint) {
      // A fresh attempt: drop whatever an earlier failed attempt left behind.
      removeSqliteFiles(dir);
    }
    target = openNodeSqliteStore(dir, dbId, storeKind, logger, { blobThresholdBytes: options.blobThresholdBytes });
    if (state.checkpoint) {
      logger.info(`Resuming move of ${dbId}/${storeKind} to sqlite after ${state.checkpoint.copied} entries`);
    }
    const done = await copyStoreResumable(source, target.store, {
      batchSize: options.migrationBatchSize,
      checkpoint: state.checkpoint,
      onCheckpoint: (checkpoint) => writeJsonDurably(statePath, { ...state, checkpoint }),
    });
    const verification = await verifyStoreCopy(source, target.store, {
      payloadSample: options.migrationPayloadSample ?? 200,
    });
    if (!verification.ok) {
      throw new Error(`verification failed: ${verification.problem}`);
    }
    const marker: BackendMarker = {
      backend: "sqlite",
      migratedFrom: "file",
      entries: verification.targetEntries,
      migratedAt: Date.now(),
    };
    // The switch: from here on the directory belongs to sqlite.
    await writeJsonDurably(path.join(dir, STORE_BACKEND_FILE), marker);
    rmSync(statePath, { force: true });
    moveFileStoreToLegacy(dir);
    logger.info(
      `Moved ${dbId}/${storeKind} to sqlite: ${verification.targetEntries} entries ` +
        `(${done.copied} copied in this run, ${verification.payloadsCompared} payloads verified) ` +
        `in ${Date.now() - startedAt} ms; old files in ${LEGACY_FILE_STORE_DIR}/`,
    );
    return target.store;
  } catch (error) {
    logger.error(
      `Moving ${dbId}/${storeKind} to sqlite failed (attempt ${state.attempts}/${MAX_MIGRATION_ATTEMPTS}); ` +
        `serving the file store: ${String(error)}`,
    );
    target?.close();
    removeSqliteFiles(dir);
    await writeJsonDurably(statePath, { attempts: state.attempts, checkpoint: null });
    return source;
  }
}

/**
 * A store that answers every call from `resolve()`'s result, waiting for it
 * first. Lets a synchronous factory hand out a store whose backend is only
 * known after an asynchronous migration. Optional methods are offered as the
 * SQLite store offers them.
 */
function deferredStore(
  dbId: string,
  storeKind: StoreKind,
  resolve: () => Promise<ContentAddressedStore>,
): ContentAddressedStore {
  let active: ContentAddressedStore | null = null;
  let pending: Promise<ContentAddressedStore> | null = null;
  const ready = () => {
    if (!pending) {
      pending = resolve().then((store) => (active = store));
    }
    return pending;
  };
  const shape = Object.create(SqliteContentAddressedStore.prototype) as ContentAddressedStore;
  const syncAnswers: Record<string, () => unknown> = {
    getId: () => dbId,
    getStoreKind: () => storeKind,
    getCacheIdentity: () => `sqlite:${dbId}:${storeKind}`,
    getIndexBuildStatus: () => ({ phase: "building", indexingEnabled: true, progress01: 0 }),
  };
  return new Proxy(shape, {
    get(_shape, property) {
      if (active) {
        const value = Reflect.get(active, property);
        return typeof value === "function" ? value.bind(active) : value;
      }
      if (typeof property === "string" && syncAnswers[property]) {
        return syncAnswers[property];
      }
      const value = Reflect.get(shape, property);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return async (...args: unknown[]) => {
        const store = await ready();
        const method = Reflect.get(store, property) as ((...a: unknown[]) => unknown) | undefined;
        if (typeof method !== "function") {
          throw new Error(`${property} is not supported by the active store of ${dbId}/${storeKind}`);
        }
        return method.apply(store, args);
      };
    },
  });
}

/**
 * Opens the sqlite store of `dbId`/`storeKind` below `options.basePath`,
 * moving an existing file store into it first (see module docs).
 */
export function openServerSqliteStore(
  dbId: string,
  storeKind: StoreKind,
  options: ServerSqliteStoreOptions,
  logger?: Logger,
): ContentAddressedStore {
  const log = logger ?? new MindooLogger(getDefaultLogLevel(), `ServerSqliteStore:${dbId}:${storeKind}`, true);
  const dir = storeDirectory(options.basePath, dbId, storeKind);
  const openOptions = { ...options, blobThresholdBytes: options.blobThresholdBytes };

  if (isSqliteStoreDirectory(dir) || !hasFileStoreData(dir)) {
    const handle = openNodeSqliteStore(dir, dbId, storeKind, log, openOptions);
    if (!isSqliteStoreDirectory(dir)) {
      // A new store: claim the directory right away (nothing to move).
      writeJsonDurablySync(path.join(dir, STORE_BACKEND_FILE), { backend: "sqlite" } satisfies BackendMarker);
    }
    return handle.store;
  }

  // A file store lives here: move it on first use.
  return deferredStore(dbId, storeKind, () => migrateFileStore(dir, dbId, storeKind, log, options));
}
