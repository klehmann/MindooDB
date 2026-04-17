import type { LocalCacheStore } from "../../core/cache/LocalCacheStore";

const STORE_NAME = "kv";
const SIZE_META_STORE = "size_meta";
const TOTAL_BYTES_KEY = "totalBytes";
const IDB_VERSION = 2;

interface SizeMetaRecord {
  key: string;
  value: number;
}

function getPayloadBytes(value: ArrayBuffer | Uint8Array): number {
  return value.byteLength;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

async function readStoredBytesValue(store: IDBObjectStore): Promise<number | null> {
  const record = (await requestToPromise(
    store.get(TOTAL_BYTES_KEY)
  )) as SizeMetaRecord | undefined;
  return typeof record?.value === "number" ? record.value : null;
}

async function writeStoredBytesValue(
  store: IDBObjectStore,
  value: number
): Promise<void> {
  await requestToPromise(
    store.put({ key: TOTAL_BYTES_KEY, value } satisfies SizeMetaRecord)
  );
}

async function computeCacheStoredBytes(store: IDBObjectStore): Promise<number> {
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      totalBytes += getPayloadBytes(cursor.value as ArrayBuffer);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });

  return totalBytes;
}

/**
 * Browser IndexedDB-backed {@link LocalCacheStore}.
 *
 * Uses a single IndexedDB database with one object store.
 * Keys are stored as `<type>\0<id>` strings for efficient prefix scanning.
 */
export class IndexedDBLocalCacheStore implements LocalCacheStore {
  private readonly dbName: string;
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName: string = "mindoodb-cache") {
    this.dbName = dbName;
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(SIZE_META_STORE)) {
          db.createObjectStore(SIZE_META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
          this.openPromise = null;
        };
        void this.backfillStoredBytesIfNeeded(this.db)
          .then(() => resolve(this.db!))
          .catch((error) => {
            this.db?.close();
            this.db = null;
            this.openPromise = null;
            reject(error);
          });
      };
      request.onerror = () => {
        this.openPromise = null;
        reject(request.error);
      };
    });

    return this.openPromise;
  }

  private toKey(type: string, id: string): string {
    return `${type}\0${id}`;
  }

  /**
   * Returns the approximate payload bytes stored in this IndexedDB cache.
   *
   * The total reflects the raw `ArrayBuffer.byteLength` of cached values and
   * excludes IndexedDB structural overhead.
   */
  async getStoredBytes(): Promise<number> {
    const db = await this.getDb();
    const tx = db.transaction(SIZE_META_STORE, "readonly");
    const sizeMetaStore = tx.objectStore(SIZE_META_STORE);
    return (await readStoredBytesValue(sizeMetaStore)) ?? 0;
  }

  async get(type: string, id: string): Promise<Uint8Array | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(this.toKey(type, id));
      request.onsuccess = () => {
        const result = request.result;
        if (result === undefined) {
          resolve(null);
        } else {
          resolve(new Uint8Array(result));
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async put(type: string, id: string, value: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction([STORE_NAME, SIZE_META_STORE], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const sizeMetaStore = tx.objectStore(SIZE_META_STORE);
    const key = this.toKey(type, id);
    const existingValue = (await requestToPromise(
      store.get(key)
    )) as ArrayBuffer | undefined;
    const totalBytes = (await readStoredBytesValue(sizeMetaStore)) ?? 0;
    const nextValue = value.slice().buffer;
    const nextTotalBytes =
      totalBytes - getPayloadBytes(existingValue ?? new ArrayBuffer(0)) + nextValue.byteLength;
    store.put(nextValue, key);
    await writeStoredBytesValue(sizeMetaStore, Math.max(0, nextTotalBytes));
    await transactionToPromise(tx);
  }

  async delete(type: string, id: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction([STORE_NAME, SIZE_META_STORE], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const sizeMetaStore = tx.objectStore(SIZE_META_STORE);
    const key = this.toKey(type, id);
    const existingValue = (await requestToPromise(
      store.get(key)
    )) as ArrayBuffer | undefined;
    const totalBytes = (await readStoredBytesValue(sizeMetaStore)) ?? 0;
    store.delete(key);
    await writeStoredBytesValue(
      sizeMetaStore,
      Math.max(0, totalBytes - getPayloadBytes(existingValue ?? new ArrayBuffer(0)))
    );
    await transactionToPromise(tx);
  }

  async list(type: string): Promise<string[]> {
    const db = await this.getDb();
    const prefix = `${type}\0`;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const range = IDBKeyRange.bound(prefix, prefix + "\uffff", false, false);
      const request = store.getAllKeys(range);
      request.onsuccess = () => {
        const keys = request.result as string[];
        resolve(keys.map(k => k.slice(prefix.length)));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction([STORE_NAME, SIZE_META_STORE], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const sizeMetaStore = tx.objectStore(SIZE_META_STORE);
    store.clear();
    await writeStoredBytesValue(sizeMetaStore, 0);
    await transactionToPromise(tx);
  }

  /**
   * Backfills the cache byte counter after upgrading an existing database.
   * Values are summed from the raw `ArrayBuffer.byteLength` of the `kv` store
   * and then persisted before callers observe the opened database.
   */
  private async backfillStoredBytesIfNeeded(db: IDBDatabase): Promise<void> {
    const readTx = db.transaction(SIZE_META_STORE, "readonly");
    const existingValue = await readStoredBytesValue(
      readTx.objectStore(SIZE_META_STORE)
    );
    if (existingValue !== null) {
      return;
    }

    const writeTx = db.transaction([STORE_NAME, SIZE_META_STORE], "readwrite");
    const store = writeTx.objectStore(STORE_NAME);
    const sizeMetaStore = writeTx.objectStore(SIZE_META_STORE);
    const totalBytes = await computeCacheStoredBytes(store);

    await writeStoredBytesValue(sizeMetaStore, totalBytes);
    await transactionToPromise(writeTx);
  }
}

/**
 * Reads the cache byte counter from an existing IndexedDB database without
 * constructing the higher-level cache abstraction or triggering a backfill.
 *
 * For older browser databases that predate the size counter, the helper falls
 * back to a read-only scan of the `kv` store instead of writing migration
 * metadata. The function returns `null` only when the database does not exist.
 */
export async function readLocalCacheStoreBytes(
  idbName: string
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let createdDuringProbe = false;
    const request = indexedDB.open(idbName);

    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        createdDuringProbe = true;
        request.transaction?.abort();
      }
    };

    request.onsuccess = async () => {
      const db = request.result;
      try {
        let totalBytes: number | null = null;
        if (db.objectStoreNames.contains(SIZE_META_STORE)) {
          const tx = db.transaction(SIZE_META_STORE, "readonly");
          totalBytes = await readStoredBytesValue(tx.objectStore(SIZE_META_STORE));
        }

        if (totalBytes === null) {
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.close();
            resolve(null);
            return;
          }

          const scanTx = db.transaction(STORE_NAME, "readonly");
          totalBytes = await computeCacheStoredBytes(scanTx.objectStore(STORE_NAME));
          await transactionToPromise(scanTx);
        }

        db.close();
        resolve(totalBytes);
      } catch (error) {
        db.close();
        reject(error);
      }
    };

    request.onerror = async () => {
      if (createdDuringProbe || request.error?.name === "AbortError") {
        try {
          await new Promise<void>((cleanupResolve) => {
            const cleanupRequest = indexedDB.deleteDatabase(idbName);
            cleanupRequest.onsuccess = () => cleanupResolve();
            cleanupRequest.onerror = () => cleanupResolve();
            cleanupRequest.onblocked = () => cleanupResolve();
          });
        } finally {
          resolve(null);
        }
        return;
      }

      reject(
        request.error ??
          new Error(`Could not open IndexedDB database "${idbName}".`)
      );
    };
  });
}
