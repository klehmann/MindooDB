import * as path from "path";
import * as os from "os";
import { mkdtemp, rm } from "fs/promises";

import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { EncryptedLocalCacheStore } from "../core/cache/EncryptedLocalCacheStore";
import { CacheManager, ICacheable } from "../core/cache/CacheManager";
import { FileSystemLocalCacheStore } from "../node/cache/FileSystemLocalCacheStore";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import type { LocalCacheStore } from "../core/cache/LocalCacheStore";

// ---------------------------------------------------------------------------
// InMemoryLocalCacheStore
// ---------------------------------------------------------------------------

describe("InMemoryLocalCacheStore", () => {
  let store: InMemoryLocalCacheStore;

  beforeEach(() => {
    store = new InMemoryLocalCacheStore();
  });

  it("should return null for missing keys", async () => {
    expect(await store.get("doc", "missing")).toBeNull();
  });

  it("should put and get values", async () => {
    const data = new Uint8Array([1, 2, 3]);
    await store.put("doc", "id1", data);
    const result = await store.get("doc", "id1");
    expect(result).toEqual(data);
  });

  it("should overwrite existing values", async () => {
    await store.put("doc", "id1", new Uint8Array([1]));
    await store.put("doc", "id1", new Uint8Array([2]));
    expect(await store.get("doc", "id1")).toEqual(new Uint8Array([2]));
  });

  it("should isolate types", async () => {
    await store.put("doc", "id1", new Uint8Array([1]));
    await store.put("vv", "id1", new Uint8Array([2]));
    expect(await store.get("doc", "id1")).toEqual(new Uint8Array([1]));
    expect(await store.get("vv", "id1")).toEqual(new Uint8Array([2]));
  });

  it("should delete values", async () => {
    await store.put("doc", "id1", new Uint8Array([1]));
    await store.delete("doc", "id1");
    expect(await store.get("doc", "id1")).toBeNull();
  });

  it("should list ids by type", async () => {
    await store.put("doc", "a", new Uint8Array([1]));
    await store.put("doc", "b", new Uint8Array([2]));
    await store.put("vv", "c", new Uint8Array([3]));

    const docIds = await store.list("doc");
    expect(docIds.sort()).toEqual(["a", "b"]);
    expect(await store.list("vv")).toEqual(["c"]);
    expect(await store.list("other")).toEqual([]);
  });

  it("should clear all data", async () => {
    await store.put("doc", "a", new Uint8Array([1]));
    await store.put("vv", "b", new Uint8Array([2]));
    await store.clear();
    expect(await store.get("doc", "a")).toBeNull();
    expect(await store.get("vv", "b")).toBeNull();
    expect(await store.list("doc")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FileSystemLocalCacheStore
// ---------------------------------------------------------------------------

describe("FileSystemLocalCacheStore", () => {
  let tmpDir: string;
  let store: FileSystemLocalCacheStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mindoodb-cache-test-"));
    store = new FileSystemLocalCacheStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should return null for missing keys", async () => {
    expect(await store.get("doc", "missing")).toBeNull();
  });

  it("should put and get values", async () => {
    const data = new Uint8Array([10, 20, 30]);
    await store.put("doc", "id1", data);
    const result = await store.get("doc", "id1");
    expect(result).toEqual(data);
  });

  it("should handle ids with slashes", async () => {
    const data = new Uint8Array([42]);
    await store.put("doc", "tenant/store/doc123", data);
    const result = await store.get("doc", "tenant/store/doc123");
    expect(result).toEqual(data);

    const ids = await store.list("doc");
    expect(ids).toEqual(["tenant/store/doc123"]);
  });

  it("should delete values", async () => {
    await store.put("doc", "id1", new Uint8Array([1]));
    await store.delete("doc", "id1");
    expect(await store.get("doc", "id1")).toBeNull();
  });

  it("should list ids by type", async () => {
    await store.put("doc", "a", new Uint8Array([1]));
    await store.put("doc", "b", new Uint8Array([2]));
    await store.put("vv", "c", new Uint8Array([3]));

    const docIds = await store.list("doc");
    expect(docIds.sort()).toEqual(["a", "b"]);
  });

  it("should return empty list for missing type directory", async () => {
    expect(await store.list("nonexistent")).toEqual([]);
  });

  it("should clear all data", async () => {
    await store.put("doc", "a", new Uint8Array([1]));
    await store.put("vv", "b", new Uint8Array([2]));
    await store.clear();
    expect(await store.get("doc", "a")).toBeNull();
    expect(await store.list("doc")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EncryptedLocalCacheStore
// ---------------------------------------------------------------------------

describe("EncryptedLocalCacheStore", () => {
  const crypto = new NodeCryptoAdapter();
  const password = "test-password-123";

  it("should encrypt and decrypt round-trip", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store = new EncryptedLocalCacheStore(inner, password, crypto);

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await store.put("doc", "id1", data);

    const result = await store.get("doc", "id1");
    expect(result).toEqual(data);
  });

  it("should store encrypted data in inner store (not plaintext)", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store = new EncryptedLocalCacheStore(inner, password, crypto);

    const data = new TextEncoder().encode("hello world");
    await store.put("doc", "id1", data);

    const rawStored = await inner.get("doc", "id1");
    expect(rawStored).not.toBeNull();
    expect(rawStored).not.toEqual(data);
    expect(rawStored!.length).toBeGreaterThan(data.length);
  });

  it("should return null when decryption fails (wrong password)", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store1 = new EncryptedLocalCacheStore(inner, "password1", crypto);
    const store2 = new EncryptedLocalCacheStore(inner, "password2", crypto);

    await store1.put("doc", "id1", new Uint8Array([1, 2, 3]));
    const result = await store2.get("doc", "id1");
    expect(result).toBeNull();
  });

  it("should return null for missing keys", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store = new EncryptedLocalCacheStore(inner, password, crypto);
    expect(await store.get("doc", "missing")).toBeNull();
  });

  it("should pass delete through", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store = new EncryptedLocalCacheStore(inner, password, crypto);

    await store.put("doc", "id1", new Uint8Array([1]));
    await store.delete("doc", "id1");
    expect(await store.get("doc", "id1")).toBeNull();
  });

  it("should pass list through", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store = new EncryptedLocalCacheStore(inner, password, crypto);

    await store.put("doc", "a", new Uint8Array([1]));
    await store.put("doc", "b", new Uint8Array([2]));

    const ids = await store.list("doc");
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("should handle large data", async () => {
    const inner = new InMemoryLocalCacheStore();
    const store = new EncryptedLocalCacheStore(inner, password, crypto);

    const largeData = new Uint8Array(100_000);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256;
    }

    await store.put("doc", "large", largeData);
    const result = await store.get("doc", "large");
    expect(result).toEqual(largeData);
  });
});

// ---------------------------------------------------------------------------
// CacheManager
// ---------------------------------------------------------------------------

describe("CacheManager", () => {
  it("should register and deregister cacheables", async () => {
    const store = new InMemoryLocalCacheStore();
    const manager = new CacheManager(store, { flushIntervalMs: 100 });

    let flushed = false;
    const cacheable: ICacheable = {
      getCachePrefix: () => "test",
      hasDirtyState: () => true,
      clearDirty: () => { flushed = true; },
      flushToCache: async () => 1,
    };

    manager.register(cacheable);
    await manager.flush();
    expect(flushed).toBe(true);
  });

  it("should only flush dirty cacheables", async () => {
    const store = new InMemoryLocalCacheStore();
    const manager = new CacheManager(store, { flushIntervalMs: 100 });

    let flushCount = 0;
    const clean: ICacheable = {
      getCachePrefix: () => "clean",
      hasDirtyState: () => false,
      clearDirty: () => {},
      flushToCache: async () => { flushCount++; return 0; },
    };

    manager.register(clean);
    await manager.flush();
    expect(flushCount).toBe(0);
  });

  it("should flush on deregister if dirty", async () => {
    const store = new InMemoryLocalCacheStore();
    const manager = new CacheManager(store, { flushIntervalMs: 60000 });

    let flushed = false;
    const cacheable: ICacheable = {
      getCachePrefix: () => "test",
      hasDirtyState: () => true,
      clearDirty: () => {},
      flushToCache: async () => { flushed = true; return 1; },
    };

    manager.register(cacheable);
    await manager.deregister(cacheable);
    expect(flushed).toBe(true);
  });

  it("should schedule flush on markDirty", async () => {
    const store = new InMemoryLocalCacheStore();
    const manager = new CacheManager(store, { flushIntervalMs: 50 });

    let flushed = false;
    const cacheable: ICacheable = {
      getCachePrefix: () => "test",
      hasDirtyState: () => true,
      clearDirty: () => { flushed = true; },
      flushToCache: async () => 1,
    };

    manager.register(cacheable);
    manager.markDirty();

    // Wait for the scheduled flush
    await new Promise(r => setTimeout(r, 150));
    expect(flushed).toBe(true);

    await manager.dispose();
  });

  it("should flush all on dispose", async () => {
    const store = new InMemoryLocalCacheStore();
    const manager = new CacheManager(store, { flushIntervalMs: 60000 });

    let flushed = false;
    const cacheable: ICacheable = {
      getCachePrefix: () => "test",
      hasDirtyState: () => true,
      clearDirty: () => { flushed = true; },
      flushToCache: async () => 1,
    };

    manager.register(cacheable);
    await manager.dispose();
    expect(flushed).toBe(true);
  });

  it("should handle flush errors gracefully", async () => {
    const store = new InMemoryLocalCacheStore();
    const manager = new CacheManager(store, { flushIntervalMs: 100 });

    const cacheable: ICacheable = {
      getCachePrefix: () => "failing",
      hasDirtyState: () => true,
      clearDirty: () => {},
      flushToCache: async () => { throw new Error("disk full"); },
    };

    manager.register(cacheable);
    // Should not throw
    await manager.flush();
    await manager.dispose();
  });
});
