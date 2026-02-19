# Local Cache Support

MindooDB uses Automerge CRDTs for document state. When a database is opened, every document must be rebuilt from raw changes and snapshots stored in the `ContentAddressedStore`. For databases with hundreds or thousands of documents, this full rebuild is expensive — especially on mobile devices where memory is constrained and the OS may terminate the app at any time.

The local cache system solves this by persisting fully-materialized Automerge documents and Virtual View indexes to a fast local store. On the next startup, the cached state is loaded directly and only new (delta) entries from the store are processed. This turns a cold start into a warm start.

All cached data is encrypted at rest using AES-256-GCM with a key derived from the user's password.

---

## Architecture Overview

The cache system consists of four layers:

```
┌──────────────────────────────────────────────┐
│  Cacheable Consumers                         │
│  (BaseMindooDB, VirtualView)                 │
│  ─ implement ICacheable                      │
│  ─ track dirty state                         │
│  ─ serialize / deserialize their own data    │
├──────────────────────────────────────────────┤
│  CacheManager                                │
│  ─ one per tenant                            │
│  ─ periodic + on-demand flush                │
│  ─ registers / deregisters cacheables        │
├──────────────────────────────────────────────┤
│  EncryptedLocalCacheStore                    │
│  ─ transparent AES-256-GCM encrypt/decrypt   │
│  ─ wraps any LocalCacheStore                 │
├──────────────────────────────────────────────┤
│  LocalCacheStore (platform-specific)         │
│  ─ FileSystemLocalCacheStore  (Node.js)      │
│  ─ IndexedDBLocalCacheStore   (Browser)      │
│  ─ MMKVLocalCacheStore        (React Native) │
└──────────────────────────────────────────────┘
```

### Data flow

1. A consumer (database or view) mutates state and marks itself dirty.
2. The `CacheManager` periodically flushes all dirty consumers, or the application can call `flush()` explicitly.
3. Each consumer serializes its dirty state and writes it through the `EncryptedLocalCacheStore`.
4. The `EncryptedLocalCacheStore` encrypts the value and delegates to the platform-specific `LocalCacheStore`.
5. On startup, consumers attempt to restore from cache before falling back to a full rebuild.

---

## Enabling the Cache

Pass a `LocalCacheStore` when constructing the `BaseMindooTenantFactory`. The factory passes it to every tenant, which wraps it in an `EncryptedLocalCacheStore` and creates a `CacheManager`.

```typescript
import { BaseMindooTenantFactory } from "mindoodb";
import { FileSystemLocalCacheStore } from "mindoodb/node";

const cacheStore = new FileSystemLocalCacheStore("/path/to/cache");

const factory = new BaseMindooTenantFactory(
  storeFactory,
  cryptoAdapter,
  undefined,       // optional logger
  cacheStore,      // enables caching
);
```

If no `LocalCacheStore` is provided, the system operates without caching — all databases are rebuilt from raw store entries on every open. No `CacheManager` is created.

---

## What Gets Cached

### Database documents (`BaseMindooDB`)

Each `BaseMindooDB` instance caches two kinds of data:

**Document entries** (type `"doc"`)

One cache entry per document containing:
- A JSON header with document metadata (`id`, `createdAt`, `lastModified`, `decryptionKeyId`, `isDeleted`)
- The Automerge binary state (`Automerge.save()`)

Binary format: `[4-byte header length (big-endian)] [header JSON] [Automerge binary]`

**Metadata checkpoint** (type `"db-meta"`)

One cache entry per database containing:
- `processedEntryCursor` — the cursor position up to which store entries have been processed
- `index` — the document index array
- `automergeHashToEntryId` — mapping from Automerge change hashes to store entry IDs (for deduplication)
- `processedEntryIds` — for stores that do not support cursor-based scanning

The metadata checkpoint is what enables delta processing: on restore, the database resumes scanning from the saved cursor position instead of replaying every entry from the beginning.

#### Cache key scoping

Each database's cache entries are scoped by a prefix constructed from the tenant ID and a store identity:

```
<tenantId>/<cacheIdentity>
```

The `cacheIdentity` comes from the `ContentAddressedStore.getCacheIdentity()` method. Each store type produces a distinct identity so that the same database ID opened against different backends produces different cache entries:

| Store type | Identity format | Example |
|---|---|---|
| `BasicOnDiskContentAddressedStore` | `disk:<storeRoot>` | `disk:/data/stores/mydb` |
| `IndexedDBContentAddressedStore` | `idb:<dbName>` | `idb:mindoodb-mydb` |
| `ClientNetworkContentAddressedStore` | `net:<serverUrl>/<dbId>` | `net:https://sync.example.com/mydb` |

#### Dirty tracking

Documents are marked dirty when they are created, modified, deleted, or loaded from a sync operation. The metadata checkpoint is marked dirty after every `syncStoreChanges()` call. On flush, only dirty documents are serialized — unchanged documents are skipped.

#### Startup sequence

When `BaseMindooDB.initialize()` is called:

1. If a `CacheManager` is present, attempt to restore from cache.
2. If the cache restore succeeds, process only delta entries (new entries since the cached cursor).
3. If the cache is missing or invalid, fall back to a full rebuild from raw store entries.

### Virtual View indexes (`VirtualView`)

Each `VirtualView` caches a single snapshot (type `"vv"`) containing the full pre-built tree structure:

- `version` — the cache format version (currently `2`)
- `categoryIdCounter` — the internal counter for category IDs
- `categorizationStyle` — the style used when the tree was built (documents-before-categories or categories-before-documents)
- `docOrderDescending` — per-column sort direction flags for document ordering
- `tree` — the complete tree structure serialized as a recursive node hierarchy, where each node stores its sort key, column values, counts (child, descendant, document, category), total values, sibling index, indent levels, and children
- `providerStates` — serialized state of each data provider (e.g. the `MindooDBVirtualViewDataProvider` saves its cursor and known document IDs)

By caching the fully-built tree rather than a flat entry list, restoration is O(n) — each node is reconstructed directly with its sort key, comparator, counts, and children. No re-sorting, no category re-creation, and no count recalculation is needed.

#### Cache key scoping

Virtual View cache entries are keyed by:

```
<viewCacheId>/<viewCacheVersion>
```

The `viewCacheId` is set by the application (e.g. `"contacts-by-department"`). The `viewCacheVersion` acts as an invalidation mechanism — if the application changes the view definition (columns, sorting), it bumps the version string and the old cache is automatically ignored.

#### Dirty tracking

The view is marked dirty after `applyChanges()` produces any index changes. On flush, the entire view snapshot is serialized and written.

#### Startup sequence

Cache restoration happens automatically when `setCacheManager` is called:

```typescript
const view = new VirtualView(columns);
const restoredFromCache = await view.setCacheManager(cacheManager, "contacts-by-dept", "v1");

if (!restoredFromCache) {
  // No cache available — populate the view from scratch
  await view.update();
}
```

`setCacheManager` registers the view with the `CacheManager` and immediately attempts a cache restore. It returns `true` if the tree was successfully restored, or `false` if the cache was missing, corrupt, or the version didn't match. Incremental changes can be applied on top of the restored state via `applyChanges()`.

---

## Encryption

All cache values pass through the `EncryptedLocalCacheStore` before reaching the platform store. Cache keys (type + id) are **not** encrypted — only the values are.

**Key derivation:**

The encryption key is derived from the user's password using PBKDF2:

- Algorithm: PBKDF2 with SHA-256
- Salt: `"mindoodb-cache-encryption:v1"` (deterministic, so the same password always produces the same key)
- Iterations: configurable, defaults to 600,000
- Output: AES-256 key

**Encryption scheme:**

- Algorithm: AES-256-GCM
- IV: 12 random bytes, unique per write
- Tag length: 128 bits
- Storage format: `[12-byte IV] [ciphertext + authentication tag]`

If decryption fails (wrong password, data corruption), the entry is treated as missing and the consumer falls back to a full rebuild. This ensures that a password change gracefully invalidates the cache without requiring an explicit wipe.

---

## Platform-Specific Store Implementations

### Node.js — `FileSystemLocalCacheStore`

**Import:** `import { FileSystemLocalCacheStore } from "mindoodb/node"`

Stores each cache entry as a file on disk:

```
<basePath>/<type>/<percent-encoded-id>.bin
```

Writes use an atomic temp-file + `rename` pattern for crash safety. If the process terminates mid-write, the incomplete temp file is left behind and the previous version of the entry remains intact.

```typescript
const store = new FileSystemLocalCacheStore("/path/to/cache");
```

### Browser — `IndexedDBLocalCacheStore`

**Import:** `import { IndexedDBLocalCacheStore } from "mindoodb/browser"`

Uses a single IndexedDB database with one object store. Keys are stored as `<type>\0<id>` strings, which enables efficient prefix-based listing using `IDBKeyRange`.

```typescript
const store = new IndexedDBLocalCacheStore("mindoodb-cache");
```

### React Native — `MMKVLocalCacheStore`

**Import:** `import { MMKVLocalCacheStore } from "mindoodb/reactnative"`

Accepts an MMKV instance (from `react-native-mmkv`) for fast synchronous binary storage. Falls back to AsyncStorage if MMKV is not available — values are base64-encoded in that case since AsyncStorage only supports strings.

Keys are prefixed with a configurable namespace (default: `"mindoodb-cache:"`).

```typescript
import { MMKV } from "react-native-mmkv";

const mmkv = new MMKV({ id: "mindoodb-cache" });
const store = new MMKVLocalCacheStore(mmkv);
```

Or with AsyncStorage fallback:

```typescript
import AsyncStorage from "@react-native-async-storage/async-storage";

const store = new MMKVLocalCacheStore(null, AsyncStorage);
```

### In-Memory — `InMemoryLocalCacheStore`

**Import:** `import { InMemoryLocalCacheStore } from "mindoodb"`

A trivial `Map`-based implementation for tests and development. Data does not survive process restarts.

### Custom implementations

The `LocalCacheStore` interface is open — applications can provide their own implementation for any storage backend:

```typescript
interface LocalCacheStore {
  get(type: string, id: string): Promise<Uint8Array | null>;
  put(type: string, id: string, value: Uint8Array): Promise<void>;
  delete(type: string, id: string): Promise<void>;
  list(type: string): Promise<string[]>;
  clear(): Promise<void>;
}
```

---

## CacheManager Lifecycle

The `CacheManager` is created per tenant and manages all cacheable consumers within that tenant.

**Periodic flushing:** After any consumer is marked dirty, the `CacheManager` schedules a flush after a configurable interval (default: 5 seconds). This batches multiple rapid changes into a single write pass.

**On-demand flushing:** Call `cacheManager.flush()` to immediately persist all dirty state — useful before the application goes to the background on mobile.

**Deregistration:** When a database or view is closed, it is deregistered from the `CacheManager`. Any pending dirty state is flushed before removal.

**Disposal:** Call `cacheManager.dispose()` to flush all pending state and stop the periodic timer. This is called when the tenant is closed.

---

## Cache Invalidation

The cache is automatically invalidated in these scenarios:

| Scenario | Behavior |
|---|---|
| User password changes | Decryption fails, cache entries return `null`, full rebuild occurs |
| Cache format version changes | Version check fails, cache is ignored |
| Virtual View definition changes | Application bumps `viewCacheVersion`, old cache is skipped |
| Store backend changes | Different `cacheIdentity` produces different cache keys |
| Explicit wipe | Call `store.clear()` to remove all cache data |

The cache is always treated as a performance optimization, never as a source of truth. If any cache entry is missing or corrupt, the system falls back to rebuilding from the `ContentAddressedStore`, which remains the authoritative data source.
