import { RevisionCursor } from "../types";
import type { LocalCacheStore } from "../cache/LocalCacheStore";
import type { ICacheable } from "../cache/CacheManager";
import { DirectoryStateChainBuilder, DirectoryStateNode } from "./DirectoryStateNode";

/** LocalCacheStore `type` namespace for the persisted time-travel chain. */
export const DIR_TT_CACHE_TYPE = "dir-tt";

/** Bump when {@link PersistedTimeTravelState} layout changes (forces rebuild). */
export const DIR_TT_CACHE_VERSION = 2;

/**
 * A directory document revision the chain is built from, keyed by its store
 * entry id. This is the raw projection *input* (not the projected delta), so the
 * chain can be rebuilt deterministically in trusted-time order by re-running the
 * projection — which is what makes out-of-order arrivals and re-stamps correct:
 * a re-emitted revision simply replaces the prior record for the same entry id,
 * and the whole chain is replayed in sorted order.
 */
export interface StoredDirectoryRevision {
  /** Store entry id of the change (the upsert key). */
  entryId: string;
  /** Document the revision belongs to. */
  docId: string;
  /** The document's merged data as of this revision's trusted-time frontier. */
  data: Record<string, unknown>;
  /** Whether the document was deleted as of this revision. */
  deleted: boolean;
  /** Trusted time of this revision (orders the chain). */
  trustedTime: number;
  /** True when the trusted time came from a witness `receivedAt`. */
  witnessed: boolean;
}

/** On-disk envelope for the directory time-travel chain. */
interface PersistedTimeTravelState {
  version: number;
  /** Resume position in the revision feed (witnessed stable-prefix watermark). */
  cursor: RevisionCursor | null;
  /** Entry ids of folded revisions that are still un-witnessed. */
  unwitnessedIds: string[];
  /** The revisions the chain is built from, keyed by entry id (replayed sorted). */
  revisions: StoredDirectoryRevision[];
  /**
   * The directory DB's latest `changeSeq` as of the last build, persisted so the
   * cold-start fast-path gate can short-circuit across a restart when the
   * directory has not advanced. Without it the in-memory `lastTimeTravelChangeSeq`
   * starts `null` and forces a redundant feed rebuild after every restart.
   */
  lastChangeSeq: number | null;
}

/**
 * Projection callback: apply a single stored revision onto the chain builder.
 * Supplied by the directory (which owns group-name normalization and the
 * document-classification rules) so this index stays decoupled from projection.
 */
export type ProjectRevisionFn = (
  builder: DirectoryStateChainBuilder,
  revision: StoredDirectoryRevision,
) => void;

/**
 * Owns the access-control time-travel directory-state chain (docs/accesscontrol.md
 * §8): the {@link DirectoryStateChainBuilder}, its resume cursor in the
 * revision-grain changefeed, and the bookkeeping needed to keep it current and
 * persist it.
 *
 * Revisions are accumulated keyed by store entry id ({@link upsertRevision}) and
 * the chain is (re)built by replaying them through the projection in
 * `(trustedTime, entryId)` order ({@link rebuild}). Keying by entry id makes
 * out-of-order arrivals and witness re-stamps correct without any special-casing
 * in the chain builder: a later, earlier-trusted-time revision (or a re-stamped
 * one) just replaces the prior record and the chain is replayed in sorted order,
 * so every node — head and intermediate — reflects the correct trusted-time
 * frontier. Replaying is pure in-memory (no decryption / Automerge), so it is
 * cheap relative to the (incremental) feed that produces the revisions.
 */
export class DirectoryTimeTravelIndex implements ICacheable {
  /** The copy-on-write chain. Rebuilt from {@link revisions} via the projection. */
  readonly builder = new DirectoryStateChainBuilder();

  /** Revisions the chain is built from, keyed by store entry id. */
  private revisions = new Map<string, StoredDirectoryRevision>();

  /** Resume position in the revision feed; `null` means "scan from genesis". */
  cursor: RevisionCursor | null = null;

  /**
   * The directory DB's latest `changeSeq` observed at the last build. Persisted
   * and restored so the directory's fast-path gate (see
   * `BaseMindooTenantDirectory.ensureTimeTravelCurrent`) can short-circuit on a
   * cold start when nothing has changed since the chain was flushed.
   */
  lastChangeSeq: number | null = null;

  /**
   * Entry ids of folded revisions that are still un-witnessed (their trusted
   * time is the provisional `now`). Exposed via {@link hasUnwitnessed} so the
   * directory knows the head overlay may still move when the entries are
   * witnessed.
   */
  private unwitnessedIds = new Set<string>();

  private dirty = false;

  constructor(private readonly cachePrefix: string) {}

  /** The head node ("now"). */
  getHead(): DirectoryStateNode {
    return this.builder.getHead();
  }

  /** The node covering trusted time `T`. */
  getStateAt(T: number): DirectoryStateNode {
    return this.builder.getStateAt(T);
  }

  /** Reset to an empty chain (full rebuild from genesis). */
  reset(): void {
    this.builder.reset();
    this.revisions.clear();
    this.cursor = null;
    this.lastChangeSeq = null;
    this.unwitnessedIds.clear();
    this.dirty = true;
  }

  /**
   * Record the directory DB's latest `changeSeq` as of this build so it can be
   * persisted alongside the chain and consulted by the cold-start gate.
   */
  recordChangeSeq(changeSeq: number | null): void {
    if (this.lastChangeSeq !== changeSeq) {
      this.lastChangeSeq = changeSeq;
      this.dirty = true;
    }
  }

  /**
   * True while any folded revision is still un-witnessed: its provisional
   * trusted time (`now`) may move when the entry is later witnessed, so consumers
   * should not treat the head as final for those entries.
   */
  hasUnwitnessed(): boolean {
    return this.unwitnessedIds.size > 0;
  }

  /**
   * Insert or replace a revision (keyed by entry id) and advance the resume
   * cursor. Replacing an existing entry id is how out-of-order arrivals and
   * witness re-stamps are absorbed; the chain is rebuilt separately via
   * {@link rebuild}. Returns true if the stored set changed.
   */
  upsertRevision(revision: StoredDirectoryRevision, cursor: RevisionCursor | null): boolean {
    this.cursor = cursor;
    if (revision.witnessed) {
      this.unwitnessedIds.delete(revision.entryId);
    } else {
      this.unwitnessedIds.add(revision.entryId);
    }
    const prev = this.revisions.get(revision.entryId);
    const changed =
      !prev ||
      prev.trustedTime !== revision.trustedTime ||
      prev.deleted !== revision.deleted ||
      prev.witnessed !== revision.witnessed ||
      prev.docId !== revision.docId ||
      JSON.stringify(prev.data) !== JSON.stringify(revision.data);
    this.revisions.set(revision.entryId, revision);
    this.dirty = true;
    return changed;
  }

  /**
   * Rebuild the chain by replaying every stored revision through `project` in
   * `(trustedTime, entryId)` order. Pure in-memory: no decryption, no Automerge.
   */
  rebuild(project: ProjectRevisionFn): void {
    const sorted = [...this.revisions.values()].sort((a, b) =>
      a.trustedTime !== b.trustedTime
        ? a.trustedTime - b.trustedTime
        : a.entryId.localeCompare(b.entryId),
    );
    this.builder.reset();
    for (const revision of sorted) {
      project(this.builder, revision);
    }
    this.dirty = true;
  }

  // ---- ICacheable -------------------------------------------------------

  getCachePrefix(): string {
    return this.cachePrefix;
  }

  hasDirtyState(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  async flushToCache(store: LocalCacheStore): Promise<number> {
    const state: PersistedTimeTravelState = {
      version: DIR_TT_CACHE_VERSION,
      cursor: this.cursor,
      unwitnessedIds: [...this.unwitnessedIds],
      revisions: [...this.revisions.values()],
      lastChangeSeq: this.lastChangeSeq,
    };
    await store.put(DIR_TT_CACHE_TYPE, this.cachePrefix, new TextEncoder().encode(JSON.stringify(state)));
    return 1;
  }

  /**
   * Restore the persisted revisions and cursor. Returns false (leaving the index
   * empty) on a cache miss or version mismatch, so the caller does a full
   * rebuild. The caller must invoke {@link rebuild} afterwards to materialize the
   * chain (this index does not own the projection).
   */
  async restoreFromCache(store: LocalCacheStore): Promise<boolean> {
    const bytes = await store.get(DIR_TT_CACHE_TYPE, this.cachePrefix);
    if (!bytes) return false;
    let state: PersistedTimeTravelState;
    try {
      state = JSON.parse(new TextDecoder().decode(bytes)) as PersistedTimeTravelState;
    } catch {
      return false;
    }
    if (state.version !== DIR_TT_CACHE_VERSION) return false;

    this.revisions = new Map((state.revisions ?? []).map((r) => [r.entryId, r]));
    this.cursor = state.cursor ?? null;
    this.lastChangeSeq = state.lastChangeSeq ?? null;
    this.unwitnessedIds = new Set(state.unwitnessedIds ?? []);
    this.dirty = false;
    return true;
  }
}
