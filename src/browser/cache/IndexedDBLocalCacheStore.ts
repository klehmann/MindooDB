import type { LocalCacheStore } from "../../core/cache/LocalCacheStore";

const STORE_NAME = "kv";

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
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });

    return this.openPromise;
  }

  private toKey(type: string, id: string): string {
    return `${type}\0${id}`;
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(value.slice().buffer, this.toKey(type, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(type: string, id: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(this.toKey(type, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
