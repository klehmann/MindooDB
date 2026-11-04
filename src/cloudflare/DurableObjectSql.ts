/**
 * MindooDB stores and server state on a Durable Object's SQLite database.
 *
 * Durable Object SQL is synchronous and commits every write of one event-loop
 * turn atomically; it rejects BEGIN/COMMIT. The store backend therefore runs
 * without explicit transactions (batches are still serialized), and since the
 * executor never awaits real I/O, a whole `putEntries` batch lands in one
 * implicit transaction.
 */

import {
  createSqlBackend,
  type ExternalContentStore,
  type SqliteExecutor,
  type SqliteStoreBackend,
  type SqliteValue,
} from "../core/appendonlystores/sqlite/SqliteDriver";
import { SqliteContentAddressedStore } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import type { StoreKind } from "../core/appendonlystores/types";
import type { ServerDataStore } from "../server/ServerDataStore";
import type { R2Bucket, SqlStorage } from "./types";

/**
 * Durable Object SQLite limits a BLOB, and a row, to 2 MB. Entries above this
 * are refused with a clear error instead of a storage exception mid-batch —
 * unless an R2 bucket takes them (see {@link r2ContentStore}).
 */
export const MAX_DURABLE_OBJECT_ENTRY_BYTES = 2 * 1024 * 1024 - 64 * 1024;

function toBinding(value: SqliteValue): unknown {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_DURABLE_OBJECT_ENTRY_BYTES) {
      throw new Error(
        `Entry of ${value.byteLength} bytes exceeds the ${MAX_DURABLE_OBJECT_ENTRY_BYTES}-byte limit of this server`,
      );
    }
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

/** {@link SqliteExecutor} over `ctx.storage.sql`. */
export function createDurableObjectSqlExecutor(sql: SqlStorage): SqliteExecutor {
  return {
    async exec(statement) {
      sql.exec(statement);
    },
    async run(statement, params = []) {
      const cursor = sql.exec(statement, ...params.map(toBinding));
      cursor.toArray();
      return { changes: cursor.rowsWritten };
    },
    async get(statement, params = []) {
      const rows = sql.exec(statement, ...params.map(toBinding)).toArray();
      return rows[0] as Record<string, unknown> | undefined;
    },
    async all(statement, params = []) {
      return sql.exec(statement, ...params.map(toBinding)).toArray() as Record<string, unknown>[];
    },
  };
}

/** Payloads from this size on go to R2; well below the row limit, rare in practice. */
export const R2_CONTENT_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Payloads of one store in R2, under `<keyPrefix><contentHash>`. The key
 * prefix names the tenant, database and store, so stores never share
 * objects and a database's objects can be removed by prefix.
 */
export function r2ContentStore(bucket: R2Bucket, keyPrefix: string): ExternalContentStore {
  return {
    thresholdBytes: R2_CONTENT_THRESHOLD_BYTES,
    async put(contentHash, bytes) {
      await bucket.put(`${keyPrefix}${contentHash}`, bytes);
    },
    async get(contentHash) {
      const object = await bucket.get(`${keyPrefix}${contentHash}`);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async delete(contentHash) {
      await bucket.delete(`${keyPrefix}${contentHash}`);
    },
    async clear() {
      await deleteR2Prefix(bucket, keyPrefix);
    },
  };
}

/** Remove every object under `prefix`. */
export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Durable Object SQLite refuses statements with more bound parameters than this. */
export const DURABLE_OBJECT_MAX_BOUND_PARAMETERS = 100;

export function createDurableObjectStoreBackend(
  sql: SqlStorage,
  tablePrefix: string,
  externalContent?: ExternalContentStore,
): SqliteStoreBackend {
  return createSqlBackend(createDurableObjectSqlExecutor(sql), {
    tablePrefix,
    explicitTransactions: false,
    externalContent,
    maxBoundParameters: DURABLE_OBJECT_MAX_BOUND_PARAMETERS,
  });
}

/** A content-addressed store whose tables carry `tablePrefix` in the object's database. */
export function createDurableObjectStore(
  sql: SqlStorage,
  dbId: string,
  storeKind: StoreKind,
  tablePrefix: string,
  externalContent?: ExternalContentStore,
): SqliteContentAddressedStore {
  return new SqliteContentAddressedStore(
    dbId,
    storeKind,
    createDurableObjectStoreBackend(sql, tablePrefix, externalContent),
  );
}

/**
 * {@link ServerDataStore} on a key/value table. "Directories" are derived from
 * the `/`-separated keys, as on the file system.
 */
export class DurableObjectServerDataStore implements ServerDataStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mindoo_server_kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL)",
    );
  }

  private static normalize(key: string): string {
    return key.split("/").filter((part) => part.length > 0).join("/");
  }

  exists(key: string): boolean {
    const normalized = DurableObjectServerDataStore.normalize(key);
    if (normalized === "") return true;
    const row = this.sql
      .exec(
        "SELECT 1 AS present FROM mindoo_server_kv WHERE key = ? OR substr(key, 1, ?) = ? LIMIT 1",
        normalized,
        normalized.length + 1,
        `${normalized}/`,
      )
      .toArray();
    return row.length > 0;
  }

  readBytes(key: string): Uint8Array | null {
    const rows = this.sql
      .exec<{ value: ArrayBuffer }>(
        "SELECT value FROM mindoo_server_kv WHERE key = ?",
        DurableObjectServerDataStore.normalize(key),
      )
      .toArray();
    return rows.length > 0 ? new Uint8Array(rows[0].value) : null;
  }

  readText(key: string): string | null {
    const bytes = this.readBytes(key);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  writeBytes(key: string, value: Uint8Array): void {
    if (value.byteLength > MAX_DURABLE_OBJECT_ENTRY_BYTES) {
      throw new Error(
        `Server state "${key}" is ${value.byteLength} bytes; Durable Object storage holds at most 2 MB per value`,
      );
    }
    this.sql.exec(
      "INSERT INTO mindoo_server_kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      DurableObjectServerDataStore.normalize(key),
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }

  writeText(key: string, value: string): void {
    this.writeBytes(key, new TextEncoder().encode(value));
  }

  listDirectories(prefix: string): string[] {
    const normalized = DurableObjectServerDataStore.normalize(prefix);
    const base = normalized === "" ? "" : `${normalized}/`;
    const rows = this.sql
      .exec<{ key: string }>(
        "SELECT key FROM mindoo_server_kv WHERE substr(key, 1, ?) = ?",
        base.length,
        base,
      )
      .toArray();
    const names = new Set<string>();
    for (const { key } of rows) {
      const rest = key.substring(base.length);
      const slash = rest.indexOf("/");
      if (slash > 0) names.add(rest.substring(0, slash));
    }
    return [...names];
  }

  /** Names of the values directly below `prefix` (not the directories). */
  listFiles(prefix: string): string[] {
    const normalized = DurableObjectServerDataStore.normalize(prefix);
    const base = normalized === "" ? "" : `${normalized}/`;
    return this.sql
      .exec<{ key: string }>(
        "SELECT key FROM mindoo_server_kv WHERE substr(key, 1, ?) = ?",
        base.length,
        base,
      )
      .toArray()
      .map(({ key }) => key.substring(base.length))
      .filter((rest) => rest.length > 0 && !rest.includes("/"));
  }

  deleteTree(prefix: string): void {
    const normalized = DurableObjectServerDataStore.normalize(prefix);
    if (normalized === "") {
      this.sql.exec("DELETE FROM mindoo_server_kv");
      return;
    }
    this.sql.exec(
      "DELETE FROM mindoo_server_kv WHERE key = ? OR substr(key, 1, ?) = ?",
      normalized,
      normalized.length + 1,
      `${normalized}/`,
    );
  }
}
