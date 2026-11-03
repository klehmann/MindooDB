/**
 * Platform-agnostic SQLite access used by {@link SqliteContentAddressedStore}.
 *
 * Expo/RN wraps `expo-sqlite` or `op-sqlite`. Node tests wrap `node:sqlite` or
 * the in-process memory driver. The browser bundle must not import this module.
 */
export type SqliteValue = string | number | null | Uint8Array;

export interface SqliteExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqliteValue[]): Promise<{ changes: number }>;
  get(sql: string, params?: SqliteValue[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, params?: SqliteValue[]): Promise<Record<string, unknown>[]>;
}

export interface SqliteStoreBackend {
  init(): Promise<void>;
  /**
   * Runs `work` in one transaction, so a batch of writes costs one commit
   * instead of one per row. Transactions of a backend run one at a time.
   */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** Ids of `ids` present in the store. */
  hasEntries(ids: string[]): Promise<string[]>;
  /** Metadata JSON and bytes for every id present, in one round of queries. */
  getEntryRows(ids: string[]): Promise<Array<{ id: string; metaJson: string; data: Uint8Array }>>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  hasEntry(id: string): Promise<boolean>;
  insertEntry(metaJson: string, data: Uint8Array, contentHash: string, docId: string, entryType: string, createdAt: number, receiptOrder: number, id: string): Promise<boolean>;
  updateEntryMeta(id: string, metaJson: string, receiptOrder: number): Promise<void>;
  getEntryRow(id: string): Promise<{ metaJson: string; data: Uint8Array } | null>;
  getMetadataJson(id: string): Promise<string | null>;
  getAllMetadataJson(): Promise<string[]>;
  getMetadataJsonByDoc(docId: string): Promise<string[]>;
  getAllIds(): Promise<string[]>;
  scanMetadataJson(cursorReceiptOrder: number | null, cursorId: string | null, limit: number): Promise<string[]>;
  deleteEntries(ids: string[]): Promise<number>;
  getContent(hash: string): Promise<{ data: Uint8Array; refCount: number } | null>;
  putContent(hash: string, data: Uint8Array, refCount: number): Promise<void>;
  updateContentRef(hash: string, refCount: number): Promise<void>;
  deleteContent(hash: string): Promise<void>;
  countEntries(): Promise<number>;
  countContent(): Promise<number>;
  countDocs(): Promise<number>;
  clearAll(): Promise<void>;
}

function schema(prefix: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${prefix}store_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${prefix}entries (
  id TEXT PRIMARY KEY NOT NULL,
  doc_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  receipt_order INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${prefix}idx_entries_doc ON ${prefix}entries(doc_id);
CREATE INDEX IF NOT EXISTS ${prefix}idx_entries_scan ON ${prefix}entries(receipt_order, id);
CREATE INDEX IF NOT EXISTS ${prefix}idx_entries_type_created ON ${prefix}entries(entry_type, created_at);
CREATE TABLE IF NOT EXISTS ${prefix}content (
  content_hash TEXT PRIMARY KEY NOT NULL,
  bytes BLOB NOT NULL,
  ref_count INTEGER NOT NULL
);
`;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  // Node's Buffer, and any other typed-array view over a BLOB.
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Expected BLOB column to be binary");
}

/** Max bound parameters per `IN (...)` list (SQLite's limit is 32766; stay well below). */
const IN_LIST_CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

/** Serializes async work: each call starts after the previous one settled. */
function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

export interface SqlBackendOptions {
  /**
   * Prefix for the store's tables and indexes, so several stores can share
   * one SQLite database (e.g. every store of a Cloudflare Durable Object).
   */
  tablePrefix?: string;
  /**
   * Whether {@link SqliteStoreBackend.transaction} issues BEGIN/COMMIT.
   * Turn off for engines that manage transactions themselves and reject
   * these statements, such as Durable Object SQLite, which commits all
   * writes of one event-loop turn atomically. Batches still run one at a time.
   */
  explicitTransactions?: boolean;
  /**
   * Keep payloads of at least {@link ExternalContentStore.thresholdBytes}
   * outside SQLite, for engines that cap BLOB or row size (Durable Object
   * SQLite: 2 MB). The content row stays, with an empty BLOB, and an extra
   * table records which hashes live outside.
   */
  externalContent?: ExternalContentStore;
}

/** Where a backend keeps payloads too large for its SQLite (e.g. Cloudflare R2). */
export interface ExternalContentStore {
  thresholdBytes: number;
  put(contentHash: string, bytes: Uint8Array): Promise<void>;
  get(contentHash: string): Promise<Uint8Array | null>;
  delete(contentHash: string): Promise<void>;
  /** Remove every payload of this store (`clearAll`). */
  clear?(): Promise<void>;
}

export function createSqlBackend(executor: SqliteExecutor, options: SqlBackendOptions = {}): SqliteStoreBackend {
  const prefix = options.tablePrefix ?? "";
  if (!/^[A-Za-z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid SQLite table prefix: ${prefix}`);
  }
  const explicitTransactions = options.explicitTransactions !== false;
  const external = options.externalContent;
  const enqueue = createQueue();

  /** The payload of a content row, fetched from the external store when it lives there. */
  async function resolveBytes(hash: string, stored: unknown): Promise<Uint8Array> {
    const bytes = asBytes(stored);
    if (!external || bytes.byteLength > 0) {
      return bytes;
    }
    const marked = await executor.get(
      `SELECT 1 AS present FROM ${prefix}content_external WHERE content_hash = ?`,
      [hash],
    );
    if (!marked) {
      return bytes;
    }
    const loaded = await external.get(hash);
    if (!loaded) {
      throw new Error(`External content ${hash} is missing`);
    }
    return loaded;
  }

  return {
    async init() {
      await executor.exec(schema(prefix));
      if (external) {
        await executor.exec(
          `CREATE TABLE IF NOT EXISTS ${prefix}content_external (content_hash TEXT PRIMARY KEY NOT NULL);`,
        );
      }
    },

    transaction(work) {
      if (!explicitTransactions) {
        return enqueue(work);
      }
      return enqueue(async () => {
        await executor.exec("BEGIN IMMEDIATE");
        try {
          const result = await work();
          await executor.exec("COMMIT");
          return result;
        } catch (error) {
          await executor.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    },

    async hasEntries(ids) {
      const present: string[] = [];
      for (const slice of chunks(ids, IN_LIST_CHUNK)) {
        const rows = await executor.all(`SELECT id FROM ${prefix}entries WHERE id IN (${placeholders(slice.length)})`, slice);
        for (const row of rows) {
          present.push(String(row.id));
        }
      }
      return present;
    },

    async getEntryRows(ids) {
      const result: Array<{ id: string; metaJson: string; data: Uint8Array }> = [];
      for (const slice of chunks(ids, IN_LIST_CHUNK)) {
        const rows = await executor.all(
          `SELECT e.id AS id, e.metadata_json AS metadata_json, e.content_hash AS content_hash, c.bytes AS bytes FROM ${prefix}entries e JOIN ${prefix}content c ON c.content_hash = e.content_hash WHERE e.id IN (${placeholders(slice.length)})`,
          slice,
        );
        for (const row of rows) {
          result.push({
            id: String(row.id),
            metaJson: String(row.metadata_json),
            data: await resolveBytes(String(row.content_hash), row.bytes),
          });
        }
      }
      return result;
    },

    async getMeta(key) {
      const row = await executor.get(`SELECT value FROM ${prefix}store_meta WHERE key = ?`, [key]);
      return row ? String(row.value) : null;
    },

    async setMeta(key, value) {
      await executor.run(
        `INSERT INTO ${prefix}store_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },

    async hasEntry(id) {
      const row = await executor.get(`SELECT 1 AS present FROM ${prefix}entries WHERE id = ?`, [id]);
      return Boolean(row);
    },

    async insertEntry(metaJson, data, contentHash, docId, entryType, createdAt, receiptOrder, id) {
      const existing = await this.hasEntry(id);
      if (existing) {
        return false;
      }
      await executor.run(
        `INSERT INTO ${prefix}entries(id, doc_id, entry_type, created_at, content_hash, receipt_order, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [id, docId, entryType, createdAt, contentHash, receiptOrder, metaJson],
      );
      const content = await this.getContent(contentHash);
      if (content) {
        await this.updateContentRef(contentHash, content.refCount + 1);
      } else {
        await this.putContent(contentHash, data, 1);
      }
      return true;
    },

    async updateEntryMeta(id, metaJson, receiptOrder) {
      await executor.run(
        `UPDATE ${prefix}entries SET metadata_json = ?, receipt_order = ? WHERE id = ?`,
        [metaJson, receiptOrder, id],
      );
    },

    async getEntryRow(id) {
      const row = await executor.get(
        `SELECT e.metadata_json AS metadata_json, e.content_hash AS content_hash, c.bytes AS bytes FROM ${prefix}entries e JOIN ${prefix}content c ON c.content_hash = e.content_hash WHERE e.id = ?`,
        [id],
      );
      if (!row) {
        return null;
      }
      return { metaJson: String(row.metadata_json), data: await resolveBytes(String(row.content_hash), row.bytes) };
    },

    async getMetadataJson(id) {
      const row = await executor.get(`SELECT metadata_json FROM ${prefix}entries WHERE id = ?`, [id]);
      return row ? String(row.metadata_json) : null;
    },

    async getAllMetadataJson() {
      const rows = await executor.all(`SELECT metadata_json FROM ${prefix}entries`);
      return rows.map((row) => String(row.metadata_json));
    },

    async getMetadataJsonByDoc(docId) {
      const rows = await executor.all(`SELECT metadata_json FROM ${prefix}entries WHERE doc_id = ?`, [docId]);
      return rows.map((row) => String(row.metadata_json));
    },

    async getAllIds() {
      const rows = await executor.all(`SELECT id FROM ${prefix}entries`);
      return rows.map((row) => String(row.id));
    },

    async scanMetadataJson(cursorReceiptOrder, cursorId, limit) {
      if (cursorReceiptOrder === null || cursorId === null) {
        const rows = await executor.all(
          `SELECT metadata_json FROM ${prefix}entries ORDER BY receipt_order ASC, id ASC LIMIT ?`,
          [limit],
        );
        return rows.map((row) => String(row.metadata_json));
      }
      const rows = await executor.all(
        `SELECT metadata_json FROM ${prefix}entries WHERE receipt_order > ? OR (receipt_order = ? AND id > ?) ORDER BY receipt_order ASC, id ASC LIMIT ?`,
        [cursorReceiptOrder, cursorReceiptOrder, cursorId, limit],
      );
      return rows.map((row) => String(row.metadata_json));
    },

    async deleteEntries(ids) {
      let deleted = 0;
      for (const id of ids) {
        const row = await executor.get(`SELECT content_hash FROM ${prefix}entries WHERE id = ?`, [id]);
        if (!row) {
          continue;
        }
        const hash = String(row.content_hash);
        await executor.run(`DELETE FROM ${prefix}entries WHERE id = ?`, [id]);
        deleted += 1;
        const content = await this.getContent(hash);
        if (content) {
          if (content.refCount <= 1) {
            await this.deleteContent(hash);
          } else {
            await this.updateContentRef(hash, content.refCount - 1);
          }
        }
      }
      return deleted;
    },

    async getContent(hash) {
      const row = await executor.get(`SELECT bytes, ref_count FROM ${prefix}content WHERE content_hash = ?`, [hash]);
      if (!row) {
        return null;
      }
      return { data: await resolveBytes(hash, row.bytes), refCount: Number(row.ref_count) };
    },

    async putContent(hash, data, refCount) {
      if (external && data.byteLength >= external.thresholdBytes) {
        // Payload first: a crash in between leaves an unreferenced object
        // behind, never a row without its payload.
        await external.put(hash, data);
        // X'' rather than a bound empty buffer: some drivers bind that as NULL.
        await executor.run(
          `INSERT INTO ${prefix}content(content_hash, bytes, ref_count) VALUES(?, X'', ?)`,
          [hash, refCount],
        );
        await executor.run(
          `INSERT OR IGNORE INTO ${prefix}content_external(content_hash) VALUES(?)`,
          [hash],
        );
        return;
      }
      await executor.run(
        `INSERT INTO ${prefix}content(content_hash, bytes, ref_count) VALUES(?, ?, ?)`,
        [hash, data, refCount],
      );
    },

    async updateContentRef(hash, refCount) {
      await executor.run(`UPDATE ${prefix}content SET ref_count = ? WHERE content_hash = ?`, [refCount, hash]);
    },

    async deleteContent(hash) {
      await executor.run(`DELETE FROM ${prefix}content WHERE content_hash = ?`, [hash]);
      if (external) {
        const { changes } = await executor.run(
          `DELETE FROM ${prefix}content_external WHERE content_hash = ?`,
          [hash],
        );
        if (changes > 0) {
          await external.delete(hash);
        }
      }
    },

    async countEntries() {
      const row = await executor.get(`SELECT COUNT(*) AS n FROM ${prefix}entries`);
      return Number(row?.n ?? 0);
    },

    async countContent() {
      const row = await executor.get(`SELECT COUNT(*) AS n FROM ${prefix}content`);
      return Number(row?.n ?? 0);
    },

    async countDocs() {
      const row = await executor.get(`SELECT COUNT(DISTINCT doc_id) AS n FROM ${prefix}entries`);
      return Number(row?.n ?? 0);
    },

    async clearAll() {
      await executor.exec(`DELETE FROM ${prefix}entries; DELETE FROM ${prefix}content; DELETE FROM ${prefix}store_meta;`);
      if (external) {
        await executor.exec(`DELETE FROM ${prefix}content_external;`);
        await external.clear?.();
      }
    },
  };
}

/**
 * In-process backend used by unit tests. Speaks the same table contract as
 * {@link createSqlBackend} without requiring a native SQLite binding.
 */
export function createMemorySqliteBackend(): SqliteStoreBackend {
  const meta = new Map<string, string>();
  const entries = new Map<string, {
    id: string;
    docId: string;
    entryType: string;
    createdAt: number;
    contentHash: string;
    receiptOrder: number;
    metadataJson: string;
  }>();
  const content = new Map<string, { data: Uint8Array; refCount: number }>();

  const enqueue = createQueue();
  return {
    async init() {
      /* no-op */
    },
    transaction(work) {
      return enqueue(work);
    },
    async hasEntries(ids) {
      return ids.filter((id) => entries.has(id));
    },
    async getEntryRows(ids) {
      const result: Array<{ id: string; metaJson: string; data: Uint8Array }> = [];
      for (const id of ids) {
        const row = entries.get(id);
        const blob = row ? content.get(row.contentHash) : undefined;
        if (row && blob) {
          result.push({ id, metaJson: row.metadataJson, data: blob.data });
        }
      }
      return result;
    },
    async getMeta(key) {
      return meta.get(key) ?? null;
    },
    async setMeta(key, value) {
      meta.set(key, value);
    },
    async hasEntry(id) {
      return entries.has(id);
    },
    async insertEntry(metaJson, data, contentHash, docId, entryType, createdAt, receiptOrder, id) {
      if (entries.has(id)) {
        return false;
      }
      entries.set(id, { id, docId, entryType, createdAt, contentHash, receiptOrder, metadataJson: metaJson });
      const existing = content.get(contentHash);
      if (existing) {
        existing.refCount += 1;
      } else {
        content.set(contentHash, { data, refCount: 1 });
      }
      return true;
    },
    async updateEntryMeta(id, metaJson, receiptOrder) {
      const row = entries.get(id);
      if (row) {
        row.metadataJson = metaJson;
        row.receiptOrder = receiptOrder;
      }
    },
    async getEntryRow(id) {
      const row = entries.get(id);
      if (!row) {
        return null;
      }
      const blob = content.get(row.contentHash);
      if (!blob) {
        return null;
      }
      return { metaJson: row.metadataJson, data: blob.data };
    },
    async getMetadataJson(id) {
      return entries.get(id)?.metadataJson ?? null;
    },
    async getAllMetadataJson() {
      return Array.from(entries.values()).map((row) => row.metadataJson);
    },
    async getMetadataJsonByDoc(docId) {
      return Array.from(entries.values()).filter((row) => row.docId === docId).map((row) => row.metadataJson);
    },
    async getAllIds() {
      return Array.from(entries.keys());
    },
    async scanMetadataJson(cursorReceiptOrder, cursorId, limit) {
      const sorted = Array.from(entries.values()).sort((a, b) =>
        a.receiptOrder === b.receiptOrder ? a.id.localeCompare(b.id) : a.receiptOrder - b.receiptOrder,
      );
      const start = sorted.findIndex((row) => {
        if (cursorReceiptOrder === null || cursorId === null) {
          return true;
        }
        return row.receiptOrder > cursorReceiptOrder || (row.receiptOrder === cursorReceiptOrder && row.id > cursorId);
      });
      if (start < 0) {
        return [];
      }
      return sorted.slice(start, start + limit).map((row) => row.metadataJson);
    },
    async deleteEntries(ids) {
      let deleted = 0;
      for (const id of ids) {
        const row = entries.get(id);
        if (!row) {
          continue;
        }
        entries.delete(id);
        deleted += 1;
        const blob = content.get(row.contentHash);
        if (blob) {
          if (blob.refCount <= 1) {
            content.delete(row.contentHash);
          } else {
            blob.refCount -= 1;
          }
        }
      }
      return deleted;
    },
    async getContent(hash) {
      return content.get(hash) ?? null;
    },
    async putContent(hash, data, refCount) {
      content.set(hash, { data, refCount });
    },
    async updateContentRef(hash, refCount) {
      const blob = content.get(hash);
      if (blob) {
        blob.refCount = refCount;
      }
    },
    async deleteContent(hash) {
      content.delete(hash);
    },
    async countEntries() {
      return entries.size;
    },
    async countContent() {
      return content.size;
    },
    async countDocs() {
      return new Set(Array.from(entries.values()).map((row) => row.docId)).size;
    },
    async clearAll() {
      meta.clear();
      entries.clear();
      content.clear();
    },
  };
}
