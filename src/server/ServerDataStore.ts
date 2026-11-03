/**
 * Where the server keeps its own small state: the server identity, trusted
 * servers, the server key bag, tenant configs and per-tenant registries.
 *
 * Keys are `/`-separated relative paths, and on Node they are exactly the
 * file paths below the data directory (`server.identity.json`,
 * `trusted-servers.json`, `server.keybag`, `<tenantId>/config.json`,
 * `<tenantId>/purged-docs.json`), so existing servers keep reading their data.
 * Other hosts map the same keys onto their own storage, e.g. a Durable
 * Object's SQLite.
 *
 * The interface is synchronous on purpose: the server code that reads this
 * state (tenant lookup, purge denylist) is synchronous today, and both hosts
 * have synchronous storage (Node `fs`, Durable Object SQLite).
 *
 * Entry payloads never go through here; they live in the content-addressed
 * stores (see {@link ServerStoreProvider}).
 */

import type { ContentAddressedStore } from "../core/types";
import type { StoreKind } from "../core/appendonlystores/types";
import type { TenantConfig } from "./types";

export interface ServerDataStore {
  /** True when `key` holds a value or has children (a "directory"). */
  exists(key: string): boolean;
  readText(key: string): string | null;
  writeText(key: string, value: string): void;
  readBytes(key: string): Uint8Array | null;
  writeBytes(key: string, value: Uint8Array): void;
  /** Names of the direct children of `prefix` ("" for the root) that have children themselves. */
  listDirectories(prefix: string): string[];
  /** Remove `prefix` and everything below it. */
  deleteTree(prefix: string): void;
}

/** Stores of one tenant, as the tenant manager uses them. */
export interface TenantStoreFactory {
  getStore(dbId: string, storeKind: StoreKind): ContentAddressedStore;
}

/**
 * How a host provides the content-addressed stores of a tenant. On Node these
 * are the on-disk stores below `<dataDir>/<tenantId>/stores`.
 */
export interface ServerStoreProvider {
  /** Called whenever a tenant is (re)loaded; the result is cached with the tenant. */
  createTenantStores(tenantId: string, config: TenantConfig): TenantStoreFactory;
  /** Database ids this server holds for a tenant. */
  listDatabases(tenantId: string): string[];
  /**
   * Drop all stores of a removed tenant. Optional: on Node the stores live
   * inside the tenant directory and go away with {@link ServerDataStore.deleteTree}.
   */
  removeTenantStores?(tenantId: string): void | Promise<void>;
}

function normalizeKey(key: string): string {
  return key.split("/").filter((part) => part.length > 0).join("/");
}

/**
 * Volatile {@link ServerDataStore}: tests, and hosts that seed their state at
 * startup.
 */
export class MemoryServerDataStore implements ServerDataStore {
  private readonly values = new Map<string, string | Uint8Array>();

  exists(key: string): boolean {
    const normalized = normalizeKey(key);
    if (normalized === "") return true;
    if (this.values.has(normalized)) return true;
    const prefix = `${normalized}/`;
    for (const existing of this.values.keys()) {
      if (existing.startsWith(prefix)) return true;
    }
    return false;
  }

  readText(key: string): string | null {
    const value = this.values.get(normalizeKey(key));
    if (value === undefined) return null;
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }

  writeText(key: string, value: string): void {
    this.values.set(normalizeKey(key), value);
  }

  readBytes(key: string): Uint8Array | null {
    const value = this.values.get(normalizeKey(key));
    if (value === undefined) return null;
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  }

  writeBytes(key: string, value: Uint8Array): void {
    this.values.set(normalizeKey(key), value.slice());
  }

  listDirectories(prefix: string): string[] {
    const normalized = normalizeKey(prefix);
    const base = normalized === "" ? "" : `${normalized}/`;
    const names = new Set<string>();
    for (const key of this.values.keys()) {
      if (!key.startsWith(base)) continue;
      const rest = key.substring(base.length);
      const slash = rest.indexOf("/");
      if (slash > 0) names.add(rest.substring(0, slash));
    }
    return [...names];
  }

  deleteTree(prefix: string): void {
    const normalized = normalizeKey(prefix);
    for (const key of [...this.values.keys()]) {
      if (normalized === "" || key === normalized || key.startsWith(`${normalized}/`)) {
        this.values.delete(key);
      }
    }
  }
}
