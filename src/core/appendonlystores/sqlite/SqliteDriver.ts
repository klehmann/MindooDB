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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY NOT NULL,
  doc_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  receipt_order INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_doc ON entries(doc_id);
CREATE INDEX IF NOT EXISTS idx_entries_scan ON entries(receipt_order, id);
CREATE INDEX IF NOT EXISTS idx_entries_type_created ON entries(entry_type, created_at);
CREATE TABLE IF NOT EXISTS content (
  content_hash TEXT PRIMARY KEY NOT NULL,
  bytes BLOB NOT NULL,
  ref_count INTEGER NOT NULL
);
`;

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  throw new Error("Expected BLOB column to be binary");
}

export function createSqlBackend(executor: SqliteExecutor): SqliteStoreBackend {
  return {
    async init() {
      await executor.exec(SCHEMA);
    },

    async getMeta(key) {
      const row = await executor.get("SELECT value FROM store_meta WHERE key = ?", [key]);
      return row ? String(row.value) : null;
    },

    async setMeta(key, value) {
      await executor.run(
        "INSERT INTO store_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
      );
    },

    async hasEntry(id) {
      const row = await executor.get("SELECT 1 AS present FROM entries WHERE id = ?", [id]);
      return Boolean(row);
    },

    async insertEntry(metaJson, data, contentHash, docId, entryType, createdAt, receiptOrder, id) {
      const existing = await this.hasEntry(id);
      if (existing) {
        return false;
      }
      await executor.run(
        "INSERT INTO entries(id, doc_id, entry_type, created_at, content_hash, receipt_order, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?)",
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
        "UPDATE entries SET metadata_json = ?, receipt_order = ? WHERE id = ?",
        [metaJson, receiptOrder, id],
      );
    },

    async getEntryRow(id) {
      const row = await executor.get(
        "SELECT e.metadata_json AS metadata_json, c.bytes AS bytes FROM entries e JOIN content c ON c.content_hash = e.content_hash WHERE e.id = ?",
        [id],
      );
      if (!row) {
        return null;
      }
      return { metaJson: String(row.metadata_json), data: asBytes(row.bytes) };
    },

    async getMetadataJson(id) {
      const row = await executor.get("SELECT metadata_json FROM entries WHERE id = ?", [id]);
      return row ? String(row.metadata_json) : null;
    },

    async getAllMetadataJson() {
      const rows = await executor.all("SELECT metadata_json FROM entries");
      return rows.map((row) => String(row.metadata_json));
    },

    async getMetadataJsonByDoc(docId) {
      const rows = await executor.all("SELECT metadata_json FROM entries WHERE doc_id = ?", [docId]);
      return rows.map((row) => String(row.metadata_json));
    },

    async getAllIds() {
      const rows = await executor.all("SELECT id FROM entries");
      return rows.map((row) => String(row.id));
    },

    async scanMetadataJson(cursorReceiptOrder, cursorId, limit) {
      if (cursorReceiptOrder === null || cursorId === null) {
        const rows = await executor.all(
          "SELECT metadata_json FROM entries ORDER BY receipt_order ASC, id ASC LIMIT ?",
          [limit],
        );
        return rows.map((row) => String(row.metadata_json));
      }
      const rows = await executor.all(
        "SELECT metadata_json FROM entries WHERE receipt_order > ? OR (receipt_order = ? AND id > ?) ORDER BY receipt_order ASC, id ASC LIMIT ?",
        [cursorReceiptOrder, cursorReceiptOrder, cursorId, limit],
      );
      return rows.map((row) => String(row.metadata_json));
    },

    async deleteEntries(ids) {
      let deleted = 0;
      for (const id of ids) {
        const row = await executor.get("SELECT content_hash FROM entries WHERE id = ?", [id]);
        if (!row) {
          continue;
        }
        const hash = String(row.content_hash);
        await executor.run("DELETE FROM entries WHERE id = ?", [id]);
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
      const row = await executor.get("SELECT bytes, ref_count FROM content WHERE content_hash = ?", [hash]);
      if (!row) {
        return null;
      }
      return { data: asBytes(row.bytes), refCount: Number(row.ref_count) };
    },

    async putContent(hash, data, refCount) {
      await executor.run(
        "INSERT INTO content(content_hash, bytes, ref_count) VALUES(?, ?, ?)",
        [hash, data, refCount],
      );
    },

    async updateContentRef(hash, refCount) {
      await executor.run("UPDATE content SET ref_count = ? WHERE content_hash = ?", [refCount, hash]);
    },

    async deleteContent(hash) {
      await executor.run("DELETE FROM content WHERE content_hash = ?", [hash]);
    },

    async countEntries() {
      const row = await executor.get("SELECT COUNT(*) AS n FROM entries");
      return Number(row?.n ?? 0);
    },

    async countContent() {
      const row = await executor.get("SELECT COUNT(*) AS n FROM content");
      return Number(row?.n ?? 0);
    },

    async countDocs() {
      const row = await executor.get("SELECT COUNT(DISTINCT doc_id) AS n FROM entries");
      return Number(row?.n ?? 0);
    },

    async clearAll() {
      await executor.exec("DELETE FROM entries; DELETE FROM content; DELETE FROM store_meta;");
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

  return {
    async init() {
      /* no-op */
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
