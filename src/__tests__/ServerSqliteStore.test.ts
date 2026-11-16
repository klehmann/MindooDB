import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";
import { openNodeSqliteStore } from "../node/appendonlystores/sqlite/NodeSqliteStore";
import {
  LEGACY_FILE_STORE_DIR,
  MAX_MIGRATION_ATTEMPTS,
  SQLITE_MIGRATION_STATE_FILE,
  STORE_BACKEND_FILE,
  openServerSqliteStore,
  storeDirectory,
} from "../node/appendonlystores/sqlite/ServerSqliteStore";
import { copyStoreResumable } from "../core/appendonlystores/migration/StoreMigration";
import { StoreFactory } from "../node/server/StoreFactory";
import { defaultStoreTypeFromEnv } from "../node/server/TenantManager";
import { StoreKind, type ContentAddressedStore, type StoreEntry } from "../core/types";
import type { StoreScanCursor } from "../core/appendonlystores/types";
import type { Logger } from "../core/logging";

const quietLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  createChild() { return quietLogger; },
} as unknown as Logger;

function hex(n: number): string {
  return n.toString(16).padStart(8, "0");
}

function makeEntry(i: number, size = 32, witnessed = true): StoreEntry {
  const encryptedData = new Uint8Array(size).map((_, j) => (i * 31 + j) % 251);
  return {
    entryType: "doc_change",
    id: `doc${i % 7}_d_${i}_${hex(i)}`,
    contentHash: `c0ffee${hex(i)}`,
    docId: `doc${i % 7}`,
    dependencyIds: i > 0 ? [`doc${(i - 1) % 7}_d_${i - 1}_${hex(i - 1)}`] : [],
    createdAt: 1_700_000_000_000 + i,
    createdByPublicKey: "author-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, i % 256]),
    metadataSignature: new Uint8Array([4, 5, 6]),
    originalSize: size,
    encryptedSize: size,
    ...(witnessed
      ? {
          receivedAt: 1_700_000_100_000 + i,
          receivedByPublicKey: "witness-key",
          receivedDateSignature: new Uint8Array([200, 150, i % 256]),
        }
      : {}),
    encryptedData,
  };
}

/** Entries 0..count-1; every tenth is a 100 KB payload (goes to a blob file). */
function makeEntries(count: number): StoreEntry[] {
  return Array.from({ length: count }, (_, i) => makeEntry(i, i % 10 === 0 ? 100 * 1024 : 40, i % 3 !== 0));
}

async function fillFileStore(basePath: string, dbId: string, entries: StoreEntry[]): Promise<void> {
  const store = new BasicOnDiskContentAddressedStore(dbId, StoreKind.docs, quietLogger, { basePath });
  for (let i = 0; i < entries.length; i += 25) {
    await store.putEntries(entries.slice(i, i + 25));
  }
}

async function expectSameEntries(store: ContentAddressedStore, entries: StoreEntry[]): Promise<void> {
  expect((await store.getAllIds()).sort()).toEqual(entries.map((e) => e.id).sort());
  const loaded = await store.getEntries(entries.map((e) => e.id));
  const byId = new Map(loaded.map((e) => [e.id, e]));
  for (const original of entries) {
    const copy = byId.get(original.id)!;
    expect(copy).toBeTruthy();
    expect(Buffer.from(copy.encryptedData).equals(Buffer.from(original.encryptedData))).toBe(true);
    expect(Array.from(copy.signature)).toEqual(Array.from(original.signature));
    expect(copy.receivedAt).toBe(original.receivedAt);
    expect(copy.receivedDateSignature ? Array.from(copy.receivedDateSignature) : undefined).toEqual(
      original.receivedDateSignature ? Array.from(original.receivedDateSignature) : undefined,
    );
  }
}

async function scanIds(store: ContentAddressedStore): Promise<string[]> {
  const ids: string[] = [];
  let cursor: StoreScanCursor | null = null;
  for (;;) {
    const page = await store.scanEntriesSince!(cursor, 50);
    ids.push(...page.entries.map((e) => e.id));
    if (!page.hasMore || !page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
}

describe("server sqlite store", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = mkdtempSync(join(tmpdir(), "mindoodb-server-sqlite-"));
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it("keeps large payloads as blob files and small ones inline, across reopen", async () => {
    const dir = join(basePath, "db1", "docs");
    const entries = makeEntries(30);
    const first = openNodeSqliteStore(dir, "db1", StoreKind.docs, quietLogger);
    await first.store.putEntries(entries);
    first.close();

    const blobFiles = (readdirSync(join(dir, "blobs"), { recursive: true }) as string[]).filter((name) =>
      /c0ffee[0-9a-f]{8}$/.test(String(name)),
    );
    expect(blobFiles).toHaveLength(3); // entries 0, 10, 20 are 100 KB

    const reopened = openNodeSqliteStore(dir, "db1", StoreKind.docs, quietLogger);
    await expectSameEntries(reopened.store, entries);
    reopened.close();
  });

  it("starts a new database directly on sqlite and claims its directory", async () => {
    const store = openServerSqliteStore("fresh", StoreKind.docs, { basePath }, quietLogger);
    await store.putEntries(makeEntries(5));
    expect(await store.getAllIds()).toHaveLength(5);
    const dir = storeDirectory(basePath, "fresh", StoreKind.docs);
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(readFileSync(join(dir, STORE_BACKEND_FILE), "utf-8")).backend).toBe("sqlite");
    expect(existsSync(join(dir, "entries"))).toBe(false);
  });

  it("moves an existing file store into sqlite on first use and keeps receipt order", async () => {
    const entries = makeEntries(120);
    await fillFileStore(basePath, "moved", entries);
    const fileOrder = await scanIds(new BasicOnDiskContentAddressedStore("moved", StoreKind.docs, quietLogger, { basePath }));

    const store = openServerSqliteStore("moved", StoreKind.docs, { basePath, migrationBatchSize: 17 }, quietLogger);
    await expectSameEntries(store, entries);
    expect(await scanIds(store)).toEqual(fileOrder);
    expect(store.getCacheIdentity!()).toBe("sqlite:moved:docs");

    const dir = storeDirectory(basePath, "moved", StoreKind.docs);
    const marker = JSON.parse(readFileSync(join(dir, STORE_BACKEND_FILE), "utf-8"));
    expect(marker).toMatchObject({ backend: "sqlite", migratedFrom: "file", entries: 120 });
    expect(existsSync(join(dir, SQLITE_MIGRATION_STATE_FILE))).toBe(false);
    expect(existsSync(join(dir, "entries"))).toBe(false);
    expect(existsSync(join(dir, LEGACY_FILE_STORE_DIR, "entries"))).toBe(true);

    // Next start opens sqlite directly and new writes land there.
    const again = openServerSqliteStore("moved", StoreKind.docs, { basePath }, quietLogger);
    await again.putEntries([makeEntry(500)]);
    expect(await again.getAllIds()).toHaveLength(121);
  });

  it("resumes an interrupted move from its checkpoint", async () => {
    const entries = makeEntries(90);
    await fillFileStore(basePath, "resume", entries);
    const dir = storeDirectory(basePath, "resume", StoreKind.docs);

    // A first run that dies after two batches (as a killed process would).
    const source = new BasicOnDiskContentAddressedStore("resume", StoreKind.docs, quietLogger, { basePath });
    const partial = openNodeSqliteStore(dir, "resume", StoreKind.docs, quietLogger);
    let batches = 0;
    await expect(
      copyStoreResumable(source, partial.store, {
        batchSize: 20,
        onCheckpoint: (checkpoint) => {
          writeFileSync(join(dir, SQLITE_MIGRATION_STATE_FILE), JSON.stringify({ attempts: 1, checkpoint }));
          if (++batches === 2) throw new Error("killed");
        },
      }),
    ).rejects.toThrow("killed");
    expect(await partial.store.getAllIds()).toHaveLength(40);
    partial.close();

    const store = openServerSqliteStore("resume", StoreKind.docs, { basePath, migrationBatchSize: 20 }, quietLogger);
    await expectSameEntries(store, entries);
    expect(JSON.parse(readFileSync(join(dir, STORE_BACKEND_FILE), "utf-8")).entries).toBe(90);
  });

  it("keeps serving the file store when the move fails, and gives up after the attempt limit", async () => {
    const entries = makeEntries(30);
    await fillFileStore(basePath, "broken", entries);
    const dir = storeDirectory(basePath, "broken", StoreKind.docs);
    // A payload file is missing: the copy cannot be complete.
    rmSync(join(dir, "content", `${entries[5].contentHash}.bin`));

    for (let attempt = 1; attempt <= MAX_MIGRATION_ATTEMPTS + 1; attempt++) {
      const store = openServerSqliteStore("broken", StoreKind.docs, { basePath }, quietLogger);
      expect(await store.getAllIds()).toHaveLength(30); // served by the file store
      expect(store.getCacheIdentity!()).not.toMatch(/^sqlite:/);
      expect(existsSync(join(dir, STORE_BACKEND_FILE))).toBe(false);
      expect(existsSync(join(dir, "store.db"))).toBe(false);
      const state = JSON.parse(readFileSync(join(dir, SQLITE_MIGRATION_STATE_FILE), "utf-8"));
      expect(state.attempts).toBe(Math.min(attempt, MAX_MIGRATION_ATTEMPTS));
    }
    expect(existsSync(join(dir, "entries"))).toBe(true);
  });

  it("StoreFactory serves sqlite for a moved store even when configured as file", async () => {
    const dataDir = basePath;
    const sqliteFactory = new StoreFactory("t1", { defaultStoreType: "sqlite" } as never, dataDir);
    const store = sqliteFactory.getStore("db", StoreKind.docs);
    await store.putEntries(makeEntries(3));
    await new Promise((r) => setTimeout(r, 20));

    const fileFactory = new StoreFactory("t1", { defaultStoreType: "file" } as never, dataDir);
    const reopened = fileFactory.getStore("db", StoreKind.docs);
    expect(reopened.getCacheIdentity!()).toBe("sqlite:db:docs");
    expect(await reopened.getAllIds()).toHaveLength(3);
  });
});

describe("MINDOODB_DEFAULT_STORE_TYPE", () => {
  it("defaults new tenants to file and accepts sqlite, case-insensitively", () => {
    expect(defaultStoreTypeFromEnv({})).toBe("file");
    expect(defaultStoreTypeFromEnv({ MINDOODB_DEFAULT_STORE_TYPE: " SQLite " })).toBe("sqlite");
  });

  it("rejects unknown values instead of silently using file", () => {
    expect(() => defaultStoreTypeFromEnv({ MINDOODB_DEFAULT_STORE_TYPE: "postgres" })).toThrow(/must be one of/);
  });
});
