import { createSqlBackend, type SqliteExecutor, type SqliteStoreBackend, type SqliteValue } from "./SqliteDriver";

export interface ExpoSqliteLike {
  execAsync(sql: string): Promise<unknown>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  getFirstAsync(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | null>;
  getAllAsync(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
}

export function createExpoSqliteExecutor(db: ExpoSqliteLike): SqliteExecutor {
  return {
    async exec(sql) {
      await db.execAsync(sql);
    },
    async run(sql, params = []) {
      const result = await db.runAsync(sql, ...params);
      return { changes: result.changes };
    },
    async get(sql, params = []) {
      return (await db.getFirstAsync(sql, ...params)) ?? undefined;
    },
    async all(sql, params = []) {
      return db.getAllAsync(sql, ...params);
    },
  };
}

export function createExpoSqliteBackend(db: ExpoSqliteLike): SqliteStoreBackend {
  return createSqlBackend(createExpoSqliteExecutor(db));
}

export type { SqliteValue };
