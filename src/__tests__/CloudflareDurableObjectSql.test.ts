/**
 * The Durable Object storage adapters, run against `node:sqlite` shaped like
 * `ctx.storage.sql` (synchronous `exec(query, ...bindings)` with ArrayBuffer
 * blobs, no BEGIN/COMMIT needed).
 */

import { DatabaseSync } from "node:sqlite";

import {
  createDurableObjectStore,
  DurableObjectServerDataStore,
  R2_CONTENT_THRESHOLD_BYTES,
  r2ContentStore,
} from "../cloudflare/DurableObjectSql";
import { clientAddressKey, matchRoute } from "../cloudflare/http";
import type { SqlStorage, SqlStorageCursor } from "../cloudflare/types";
import { StoreKind } from "../core/appendonlystores/types";
import type { StoreEntry } from "../core/types";

/** `ctx.storage.sql` on an in-memory node:sqlite database. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(query)) {
        throw new Error("Durable Object SQL rejects transaction statements");
      }
      const params = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      let rows: T[] = [];
      let rowsWritten = 0;
      if (params.length === 0 && query.trim().replace(/;\s*$/, "").includes(";")) {
        db.exec(query);
      } else {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|WITH)/i.test(query)) {
          rows = (statement.all(...(params as never[])) as Record<string, unknown>[]).map((row) => {
            const copy: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row)) {
              copy[key] = value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
            }
            return copy as T;
          });
        } else {
          rowsWritten = Number(statement.run(...(params as never[])).changes);
        }
      }
      return Object.assign(rows[Symbol.iterator] ? rows : [], {
        toArray: () => rows,
        rowsWritten,
      }) as unknown as SqlStorageCursor<T>;
    },
  };
}

function entry(id: string, docId: string, bytes: number[]): StoreEntry {
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId,
    dependencyIds: [],
    createdAt: 1,
    createdByPublicKey: "key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3]),
    originalSize: bytes.length,
    encryptedSize: bytes.length,
    encryptedData: new Uint8Array(bytes),
  } as StoreEntry;
}

describe("Durable Object SQL adapters", () => {
  test("several stores share one database through table prefixes", async () => {
    const sql = sqlStorage();
    const notes = createDurableObjectStore(sql, "notes", StoreKind.docs, "d_");
    const replica = createDurableObjectStore(sql, "directory", StoreKind.docs, "rd_");

    await notes.putEntries([entry("n1", "doc-a", [1, 2]), entry("n2", "doc-a", [3])]);
    await replica.putEntries([entry("r1", "grant", [9])]);

    expect((await notes.getAllIds()).sort()).toEqual(["n1", "n2"]);
    expect(await replica.getAllIds()).toEqual(["r1"]);
    const [loaded] = await notes.getEntries(["n2"]);
    expect(Array.from(loaded.encryptedData)).toEqual([3]);

    // A store reopened on the same database sees the persisted entries.
    const reopened = createDurableObjectStore(sql, "notes", StoreKind.docs, "d_");
    expect((await reopened.getAllIds()).sort()).toEqual(["n1", "n2"]);
    const scan = await reopened.scanEntriesSince!(null, 10);
    expect(scan.entries.map((e) => e.id).sort()).toEqual(["n1", "n2"]);
  });

  test("large payloads go to the external store and come back", async () => {
    const sql = sqlStorage();
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
        objects.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
    };
    const store = createDurableObjectStore(sql, "notes", StoreKind.docs, "d_", r2ContentStore(bucket, "acme/notes/d_"));

    const big = Array.from({ length: R2_CONTENT_THRESHOLD_BYTES + 10 }, (_, i) => i % 251);
    await store.putEntries([entry("big", "doc-a", big), entry("small", "doc-a", [1, 2, 3])]);
    expect([...objects.keys()]).toEqual(["acme/notes/d_hash-big"]);

    const [loadedBig, loadedSmall] = await store.getEntries(["big", "small"]);
    expect(loadedBig.encryptedData.byteLength).toBe(big.length);
    expect(loadedBig.encryptedData[1000]).toBe(1000 % 251);
    expect(Array.from(loadedSmall.encryptedData)).toEqual([1, 2, 3]);

    await store.deleteEntriesById!(["big"]);
    expect(objects.size).toBe(0);
    expect(await store.getAllIds()).toEqual(["small"]);
  });

  test("server data store keeps keys, values and directories", () => {
    const store = new DurableObjectServerDataStore(sqlStorage());
    store.writeText("server.identity.json", "{}");
    store.writeText("acme/config.json", '{"a":1}');
    store.writeText("acme/purged-docs.json", "{}");
    store.writeBytes("server.keybag", new Uint8Array([7, 8]));
    store.writeText("config-backups/config.2026-01-01T00-00-00.000Z.json", "{}");

    expect(store.readText("acme/config.json")).toBe('{"a":1}');
    expect(Array.from(store.readBytes("server.keybag")!)).toEqual([7, 8]);
    expect(store.exists("acme")).toBe(true);
    expect(store.exists("acm")).toBe(false);
    expect(store.listDirectories("").sort()).toEqual(["acme", "config-backups"]);
    expect(store.listFiles("config-backups")).toEqual(["config.2026-01-01T00-00-00.000Z.json"]);

    store.deleteTree("acme");
    expect(store.exists("acme")).toBe(false);
    expect(store.readText("server.identity.json")).toBe("{}");
  });
});

describe("Worker routing helpers", () => {
  test("routes match the Node server's paths", () => {
    expect(matchRoute("GET", "/health")).toEqual({ kind: "health" });
    expect(matchRoute("POST", "/Acme/auth/challenge")).toEqual({
      kind: "tenantAuth",
      tenantId: "Acme",
      phase: "challenge",
    });
    expect(matchRoute("POST", "/acme/sync/docs/putEntriesBinary/")).toEqual({
      kind: "sync",
      tenantId: "acme",
      storeKind: StoreKind.docs,
      name: "putEntriesBinary",
    });
    expect(matchRoute("GET", "/acme/sync/attachments/getAllIds")).toMatchObject({
      kind: "sync",
      storeKind: StoreKind.attachments,
      name: "getAllIds",
    });
    // Wrong method on a sync route: no route under an existing tenant.
    expect(matchRoute("GET", "/acme/sync/docs/putEntries")).toEqual({ kind: "tenantNotFound", tenantId: "acme" });
    expect(matchRoute("GET", "/system/peer/events")).toEqual({ kind: "peer", path: "/system/peer/events" });
    expect(matchRoute("GET", "/system/cluster/status")).toEqual({ kind: "system", path: "/system/cluster/status" });
    expect(matchRoute("POST", "/device/challenge")).toMatchObject({ kind: "unsupported" });
    expect(matchRoute("DELETE", "/system/tenants/acme")).toEqual({ kind: "system", path: "/system/tenants/acme" });
  });

  test("IPv6 clients share a /56 rate-limit bucket", () => {
    expect(clientAddressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientAddressKey("2001:db8:abcd:12ff::1")).toBe("2001:0db8:abcd:1200::/56");
    expect(clientAddressKey("2001:db8:abcd:1234:5:6:7:8")).toBe("2001:0db8:abcd:1200::/56");
    expect(clientAddressKey(null)).toBe("unknown");
  });
});
