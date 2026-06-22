/**
 * Per-tenant persistent record of executed document-history purges.
 *
 * Server-side purge execution (docs/accesscontrol.md §13) physically deletes a
 * document's history from the tenant's on-disk stores. Because
 * {@link ContentAddressedStore.purgeDocHistory} leaves no tombstone, a stale
 * client that has not yet reconciled could re-push the very entries that were
 * just purged and the server would re-accept them. This registry is the churn
 * guard: it remembers which `purgeRequestDocId`s have already been executed (so
 * we never purge twice) and which `docId`s were purged per database (so the sync
 * push path can reject any re-upload of a purged document).
 *
 * Stored as `<dataDir>/<tenantId>/purged-docs.json`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

interface PurgedDocRegistryData {
  version: 1;
  /** purgeRequestDocIds whose purge has already been executed (idempotency). */
  processedRequestDocIds: string[];
  /** Map of dbId -> list of purged docIds (re-push denylist). */
  purgedDocIds: Record<string, string[]>;
}

export class PurgedDocRegistry {
  private readonly filePath: string;
  private processedRequestDocIds: Set<string>;
  private purgedDocIds: Map<string, Set<string>>;
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.processedRequestDocIds = new Set();
    this.purgedDocIds = new Map();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Partial<PurgedDocRegistryData>;
      if (Array.isArray(data.processedRequestDocIds)) {
        this.processedRequestDocIds = new Set(
          data.processedRequestDocIds.filter((id): id is string => typeof id === "string"),
        );
      }
      if (data.purgedDocIds && typeof data.purgedDocIds === "object") {
        for (const [dbId, ids] of Object.entries(data.purgedDocIds)) {
          if (Array.isArray(ids)) {
            this.purgedDocIds.set(
              dbId,
              new Set(ids.filter((id): id is string => typeof id === "string")),
            );
          }
        }
      }
    } catch {
      // Corrupt or unreadable registry: start from empty rather than crashing
      // the server. A subsequent save will overwrite it.
      this.processedRequestDocIds = new Set();
      this.purgedDocIds = new Map();
    }
  }

  private save(): void {
    const data: PurgedDocRegistryData = {
      version: 1,
      processedRequestDocIds: [...this.processedRequestDocIds],
      purgedDocIds: Object.fromEntries(
        [...this.purgedDocIds.entries()].map(([dbId, ids]) => [dbId, [...ids]]),
      ),
    };
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** True when this purge request was already executed. */
  isRequestProcessed(purgeRequestDocId: string): boolean {
    this.ensureLoaded();
    return this.processedRequestDocIds.has(purgeRequestDocId);
  }

  /** Record that a document was purged from a database (re-push denylist). */
  recordPurgedDoc(dbId: string, docId: string): void {
    this.ensureLoaded();
    let set = this.purgedDocIds.get(dbId);
    if (!set) {
      set = new Set();
      this.purgedDocIds.set(dbId, set);
    }
    set.add(docId);
  }

  /** Mark a purge request as executed and persist the registry to disk. */
  markRequestProcessed(purgeRequestDocId: string): void {
    this.ensureLoaded();
    this.processedRequestDocIds.add(purgeRequestDocId);
    this.save();
  }

  /** The set of purged docIds for a database (live; used by the push reject path). */
  getPurgedDocIds(dbId: string): Set<string> {
    this.ensureLoaded();
    return this.purgedDocIds.get(dbId) ?? new Set();
  }
}
