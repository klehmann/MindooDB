/**
 * SQLite-backed content-addressed stores for Node (the server's `"sqlite"`
 * store type): {@link SqliteContentAddressedStore} on `node:sqlite`, with
 * payloads of at least 64 KB kept as files by {@link FsBlobContentStore}.
 *
 * On-disk layout per store directory:
 *
 * ```
 * <dir>/
 *   store.db (+ -wal, -shm)   entries, metadata, small payloads, indexes
 *   blobs/ab/cd/<hash>        large payloads, one immutable file each
 * ```
 *
 * The database runs in WAL mode with `synchronous=FULL`: a push the server
 * acknowledged survives a power loss. For backups, copy `store.db` with the
 * SQLite backup API (`VACUUM INTO`) or replicate it continuously with
 * Litestream; the blobs never change after they are written.
 */

import { mkdirSync } from "fs";
import * as path from "path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { SqliteContentAddressedStore } from "../../../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import {
  createSqlBackend,
  type SqliteExecutor,
  type SqliteValue,
} from "../../../core/appendonlystores/sqlite/SqliteDriver";
import type { OpenStoreOptions, StoreKind } from "../../../core/appendonlystores/types";
import type { Logger } from "../../../core/logging";
import { DEFAULT_BLOB_THRESHOLD_BYTES, FsBlobContentStore } from "./FsBlobContentStore";

/** File name of the SQLite database inside a store directory. */
export const SQLITE_STORE_FILE = "store.db";
/** Directory of the payload files inside a store directory. */
export const SQLITE_BLOB_DIR = "blobs";

type NodeSqliteModule = typeof import("node:sqlite");
let nodeSqlite: NodeSqliteModule | null = null;

/** `node:sqlite`, loaded on first use so other store types do not need it. */
function loadNodeSqlite(): NodeSqliteModule {
  if (!nodeSqlite) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodeSqlite = require("node:sqlite") as NodeSqliteModule;
  }
  return nodeSqlite;
}

function toParams(params: SqliteValue[] = []): Array<string | number | null | Uint8Array> {
  return params;
}

/** {@link SqliteExecutor} over a synchronous `node:sqlite` connection. */
export function createNodeSqliteExecutor(db: DatabaseSyncType): SqliteExecutor {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params) {
      const result = db.prepare(sql).run(...toParams(params));
      return { changes: Number(result.changes) };
    },
    async get(sql, params) {
      return db.prepare(sql).get(...toParams(params)) as Record<string, unknown> | undefined;
    },
    async all(sql, params) {
      return db.prepare(sql).all(...toParams(params)) as Record<string, unknown>[];
    },
  };
}

/** Opens (or creates) the SQLite database of a store directory with the server pragmas. */
export function openNodeSqliteDatabase(dir: string): DatabaseSyncType {
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path.join(dir, SQLITE_STORE_FILE));
  // auto_vacuum only takes effect before the first table is created.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export interface NodeSqliteStoreOptions extends OpenStoreOptions {
  /** Payloads of at least this many bytes are kept as files (default 64 KB). */
  blobThresholdBytes?: number;
}

export interface NodeSqliteStoreHandle {
  store: SqliteContentAddressedStore;
  /** Closes the database connection; the store must not be used afterwards. */
  close(): void;
}

/** A {@link SqliteContentAddressedStore} kept in `dir` (see module docs for the layout). */
export function openNodeSqliteStore(
  dir: string,
  dbId: string,
  storeKind: StoreKind,
  logger?: Logger,
  options: NodeSqliteStoreOptions = {},
): NodeSqliteStoreHandle {
  const db = openNodeSqliteDatabase(dir);
  const backend = createSqlBackend(createNodeSqliteExecutor(db), {
    externalContent: new FsBlobContentStore(
      path.join(dir, SQLITE_BLOB_DIR),
      options.blobThresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES,
    ),
  });
  const store = new SqliteContentAddressedStore(dbId, storeKind, backend, logger, options);
  return {
    store,
    close: () => db.close(),
  };
}
