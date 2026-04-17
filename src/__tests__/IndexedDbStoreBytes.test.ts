/**
 * Verifies IndexedDB payload byte counters for browser-backed stores using a
 * fake IndexedDB implementation under Jest's Node environment.
 */

import "fake-indexeddb/auto";

import {
  IndexedDBContentAddressedStore,
  readContentAddressedStoreBytes,
} from "../browser/appendonlystores/IndexedDBContentAddressedStore";
import {
  IndexedDBLocalCacheStore,
  readLocalCacheStoreBytes,
} from "../browser/cache/IndexedDBLocalCacheStore";
import { StoreKind } from "../core/appendonlystores/types";
import type { StoreEntry, StoreEntryMetadata } from "../core/types";

function createTestEntry(
  docId: string,
  id: string,
  contentHash: string,
  encryptedData: number[],
  dependencyIds: string[] = [],
  createdAt = Date.now()
): StoreEntry {
  const payload = new Uint8Array(encryptedData);
  return {
    entryType: "doc_change",
    id,
    contentHash,
    docId,
    dependencyIds,
    createdAt,
    createdByPublicKey: "test-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: payload.length,
    encryptedSize: payload.length,
    encryptedData: payload,
  };
}

function getMetadataBytes(metadata: StoreEntryMetadata): number {
  return JSON.stringify(metadata).length;
}

function buildMetadata(entry: StoreEntry, receiptOrder: number): StoreEntryMetadata {
  const { encryptedData: _encryptedData, receiptOrder: _ignoredReceiptOrder, ...rest } = entry;
  return {
    ...rest,
    receiptOrder,
  };
}

function buildContentAddressedDbName(prefix: string, storeId: string): string {
  return `mindoodb_${prefix}_${StoreKind.docs}_${storeId}`;
}

function closeStoreConnection(store: object): void {
  const db = Reflect.get(store, "db") as IDBDatabase | null | undefined;
  db?.close();
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not delete IndexedDB database "${name}".`));
    request.onblocked = () =>
      reject(new Error(`Could not delete IndexedDB database "${name}" because it is blocked.`));
  });
}

async function deleteMetaKeys(
  dbName: string,
  storeName: string,
  keys: string[]
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not open IndexedDB database "${dbName}".`));
  });

  try {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const key of keys) {
      store.delete(key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error(`Could not update IndexedDB store "${storeName}".`));
      tx.onabort = () =>
        reject(tx.error ?? new Error(`IndexedDB transaction aborted for "${storeName}".`));
    });
  } finally {
    db.close();
  }
}

async function createLegacyContentAddressedDatabase(
  dbName: string,
  entries: StoreEntry[]
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const upgradeDb = request.result;
      const entriesStore = upgradeDb.createObjectStore("entries", {
        keyPath: "id",
      });
      entriesStore.createIndex("by_docId", "docId", { unique: false });
      entriesStore.createIndex("by_entryType_createdAt", ["entryType", "createdAt"], {
        unique: false,
      });
      entriesStore.createIndex("by_createdAt_id", ["createdAt", "id"], {
        unique: true,
      });
      entriesStore.createIndex("by_contentHash", "contentHash", {
        unique: false,
      });
      upgradeDb.createObjectStore("content", { keyPath: "contentHash" });
      upgradeDb.createObjectStore("bloom_cache", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not create IndexedDB database "${dbName}".`));
  });

  try {
    const tx = db.transaction(["entries", "content"], "readwrite");
    const entriesStore = tx.objectStore("entries");
    const contentStore = tx.objectStore("content");
    const seenHashes = new Set<string>();

    let receiptOrder = 1;
    for (const entry of entries) {
      entriesStore.put(buildMetadata(entry, receiptOrder++));
      if (seenHashes.has(entry.contentHash)) {
        continue;
      }
      seenHashes.add(entry.contentHash);
      contentStore.put({
        contentHash: entry.contentHash,
        data: entry.encryptedData,
        refCount: entries.filter((candidate) => candidate.contentHash === entry.contentHash).length,
      });
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error(`Could not seed IndexedDB database "${dbName}".`));
      tx.onabort = () =>
        reject(tx.error ?? new Error(`IndexedDB transaction aborted for "${dbName}".`));
    });
  } finally {
    db.close();
  }
}

async function createLegacyCacheDatabase(
  dbName: string,
  records: Array<{ type: string; id: string; bytes: number[] }>
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("kv");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not create IndexedDB database "${dbName}".`));
  });

  try {
    const tx = db.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    for (const record of records) {
      store.put(new Uint8Array(record.bytes).buffer, `${record.type}\0${record.id}`);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error(`Could not seed IndexedDB database "${dbName}".`));
      tx.onabort = () =>
        reject(tx.error ?? new Error(`IndexedDB transaction aborted for "${dbName}".`));
    });
  } finally {
    db.close();
  }
}

describe("IndexedDB browser store byte counters", () => {
  afterEach(async () => {
    const factory = indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string | null }>>;
    };
    if (!factory.databases) {
      return;
    }

    const databases = await factory.databases();
    for (const database of databases) {
      if (database.name) {
        await deleteDatabase(database.name);
      }
    }
  });

  it("tracks content-addressed bytes with deduplicated content payloads", async () => {
    const prefix = "casbytesdedup";
    const storeId = "dedup";
    const dbName = buildContentAddressedDbName(prefix, storeId);
    const store = new IndexedDBContentAddressedStore(
      storeId,
      StoreKind.docs,
      undefined,
      { basePath: prefix }
    );

    const first = createTestEntry("doc-1", "entry-1", "hash-shared", [1, 2, 3], [], 100);
    const second = createTestEntry("doc-2", "entry-2", "hash-shared", [1, 2, 3], [], 200);
    const third = createTestEntry("doc-3", "entry-3", "hash-unique", [4, 5], [], 300);

    await store.putEntries([first, second, third]);

    const totals = await store.getStoredBytes();
    const helperTotals = await readContentAddressedStoreBytes(dbName);
    const expectedMetadataBytes =
      getMetadataBytes(buildMetadata(first, 1)) +
      getMetadataBytes(buildMetadata(second, 2)) +
      getMetadataBytes(buildMetadata(third, 3));

    expect(totals).toEqual({
      contentBytes: first.encryptedData.byteLength + third.encryptedData.byteLength,
      metadataBytes: expectedMetadataBytes,
      totalBytes: first.encryptedData.byteLength + third.encryptedData.byteLength + expectedMetadataBytes,
    });
    expect(helperTotals).toEqual({
      contentBytes: first.encryptedData.byteLength + third.encryptedData.byteLength,
      metadataBytes: expectedMetadataBytes,
    });
  });

  it("shrinks content-addressed bytes after purging document history", async () => {
    const prefix = "casbytespurge";
    const storeId = "purge";
    const store = new IndexedDBContentAddressedStore(
      storeId,
      StoreKind.docs,
      undefined,
      { basePath: prefix }
    );

    const first = createTestEntry("doc-1", "entry-1", "hash-unique", [1, 2, 3, 4], [], 100);
    const second = createTestEntry("doc-1", "entry-2", "hash-shared", [5, 6, 7], [], 200);
    const third = createTestEntry("doc-2", "entry-3", "hash-shared", [5, 6, 7], [], 300);

    await store.putEntries([first, second, third]);
    await store.purgeDocHistory("doc-1");

    const totals = await store.getStoredBytes();
    const remainingMetadataBytes = getMetadataBytes(buildMetadata(third, 3));

    expect(totals).toEqual({
      contentBytes: third.encryptedData.byteLength,
      metadataBytes: remainingMetadataBytes,
      totalBytes: third.encryptedData.byteLength + remainingMetadataBytes,
    });
  });

  it("backfills missing content-addressed counters while the reader helper stays read-only", async () => {
    const prefix = "casbytesbackfill";
    const storeId = "backfill";
    const dbName = buildContentAddressedDbName(prefix, storeId);
    const store = new IndexedDBContentAddressedStore(
      storeId,
      StoreKind.docs,
      undefined,
      { basePath: prefix }
    );

    const first = createTestEntry("doc-1", "entry-1", "hash-a", [1, 2, 3, 4], [], 100);
    const second = createTestEntry("doc-2", "entry-2", "hash-b", [5, 6], [], 200);

    await store.putEntries([first, second]);
    closeStoreConnection(store);
    await deleteMetaKeys(dbName, "store_meta", [
      "total_content_bytes",
      "total_metadata_bytes",
    ]);
    const expectedMetadataBytes =
      getMetadataBytes(buildMetadata(first, 1)) +
      getMetadataBytes(buildMetadata(second, 2));

    expect(await readContentAddressedStoreBytes(dbName)).toEqual({
      contentBytes: first.encryptedData.byteLength + second.encryptedData.byteLength,
      metadataBytes: expectedMetadataBytes,
    });

    const reopenedStore = new IndexedDBContentAddressedStore(
      storeId,
      StoreKind.docs,
      undefined,
      { basePath: prefix }
    );
    const totals = await reopenedStore.getStoredBytes();

    expect(totals).toEqual({
      contentBytes: first.encryptedData.byteLength + second.encryptedData.byteLength,
      metadataBytes: expectedMetadataBytes,
      totalBytes: first.encryptedData.byteLength + second.encryptedData.byteLength + expectedMetadataBytes,
    });
    expect(await readContentAddressedStoreBytes(dbName)).toEqual({
      contentBytes: first.encryptedData.byteLength + second.encryptedData.byteLength,
      metadataBytes: expectedMetadataBytes,
    });
    closeStoreConnection(reopenedStore);
  });

  it("reads legacy content-addressed databases even when store_meta does not exist", async () => {
    const dbName = buildContentAddressedDbName("legacycas", "legacy");
    const first = createTestEntry("doc-1", "entry-1", "hash-a", [1, 2, 3], [], 100);
    const second = createTestEntry("doc-2", "entry-2", "hash-b", [4, 5, 6, 7], [], 200);

    await createLegacyContentAddressedDatabase(dbName, [first, second]);

    expect(await readContentAddressedStoreBytes(dbName)).toEqual({
      contentBytes: first.encryptedData.byteLength + second.encryptedData.byteLength,
      metadataBytes:
        getMetadataBytes(buildMetadata(first, 1)) +
        getMetadataBytes(buildMetadata(second, 2)),
    });
  });

  it("tracks cache bytes across put overwrite delete and clear", async () => {
    const dbName = "cache-bytes-basic";
    const store = new IndexedDBLocalCacheStore(dbName);

    await store.put("doc", "entry-1", new Uint8Array([1, 2, 3]));
    expect(await store.getStoredBytes()).toBe(3);

    await store.put("doc", "entry-1", new Uint8Array([1, 2, 3, 4, 5]));
    expect(await store.getStoredBytes()).toBe(5);

    await store.put("doc", "entry-2", new Uint8Array([9, 9]));
    expect(await store.getStoredBytes()).toBe(7);
    expect(await readLocalCacheStoreBytes(dbName)).toBe(7);

    await store.delete("doc", "entry-1");
    expect(await store.getStoredBytes()).toBe(2);

    await store.clear();
    expect(await store.getStoredBytes()).toBe(0);
    expect(await readLocalCacheStoreBytes(dbName)).toBe(0);
  });

  it("backfills missing cache counters while the reader helper stays read-only", async () => {
    const dbName = "cache-bytes-backfill";
    const store = new IndexedDBLocalCacheStore(dbName);

    await store.put("doc", "entry-1", new Uint8Array([1, 2, 3]));
    await store.put("doc", "entry-2", new Uint8Array([4, 5]));
    closeStoreConnection(store);
    await deleteMetaKeys(dbName, "size_meta", ["totalBytes"]);

    expect(await readLocalCacheStoreBytes(dbName)).toBe(5);

    const reopenedStore = new IndexedDBLocalCacheStore(dbName);
    expect(await reopenedStore.getStoredBytes()).toBe(5);
    expect(await readLocalCacheStoreBytes(dbName)).toBe(5);
    closeStoreConnection(reopenedStore);
  });

  it("reads legacy cache databases even when size_meta does not exist", async () => {
    const dbName = "cache-bytes-legacy";
    await createLegacyCacheDatabase(dbName, [
      { type: "doc", id: "entry-1", bytes: [1, 2, 3] },
      { type: "doc", id: "entry-2", bytes: [4, 5] },
    ]);

    expect(await readLocalCacheStoreBytes(dbName)).toBe(5);
  });
});
