import type { MindooDB, ProcessChangesCursor } from "../types";
import type { CacheManager, ICacheable } from "../cache/CacheManager";
import type { LocalCacheStore } from "../cache/LocalCacheStore";
import { generateRandomUuid } from "../utils/idGeneration";
import { formatFilingRef, physicalFilingRefKey, resolveFilingRef, type FilingRefBase } from "./refs";

/** Document type of a filing sidecar (one per filed document and store). */
export const FILING_SIDECAR_TYPE = "$filing";
/** Document type of a folder definition. */
export const FILING_FOLDER_TYPE = "$folder";
/**
 * Field-name prefix of folder memberships in a sidecar: `"f:<folderId>": filedAt`.
 *
 * Memberships are top-level fields rather than a nested `folders` map on
 * purpose: when two replicas file the same document for the first time
 * concurrently, each would create its own nested map object, and Automerge
 * keeps only one of two concurrently assigned objects — the other replica's
 * folders would be lost. Top-level keys of the (seeded, shared) document
 * root merge key by key.
 */
export const FILING_FOLDER_FIELD_PREFIX = "f:";

/** A folder of a filing store. */
export interface FilingFolder {
  /** Stable folder id (the value `folders()` yields and categories use). */
  folderId: string;
  /** Display name. */
  name: string;
  /** Parent folder id for folder hierarchies, `null` for top-level folders. */
  parentId: string | null;
  /** Optional system role (e.g. `"inbox"`, `"sent"`), `null` for user folders. */
  role: string | null;
  /** Optional view design name the folder is shown with, `null` for the default. */
  design: string | null;
}

/** Changed filed documents reported by {@link FilingIndex.changesSince}. */
export interface FilingIndexChanges {
  /** Index generation the `seq` belongs to (changes when the index is rebuilt). */
  generation: string;
  /** Sequence number to pass to the next {@link FilingIndex.changesSince} call. */
  seq: number;
  /**
   * Physical keys (`"<tenantId>/<dbId>/<docId>"`) of documents whose
   * effective folder set changed since the given position, or `"all"` when
   * the position is too old (or from another generation) for a delta —
   * consumers then re-evaluate everything.
   */
  refs: ReadonlySet<string> | "all";
}

interface SidecarState {
  /** Physical key of the filed document. */
  ref: string;
  /** Folder id -> filed-at (epoch ms). */
  folders: Record<string, number>;
}

interface PersistedFilingIndex {
  v: 1;
  generation: string;
  seq: number;
  cursor: ProcessChangesCursor | null;
  sidecars: Array<[string, string, Record<string, number>]>;
  folders: Array<[string, FilingFolder & { deleted: boolean }]>;
  folderIdByDocId: Array<[string, string]>;
  logStartSeq: number;
  log: Array<[number, string[]]>;
  lostSeqRanges?: Array<[number, number]>;
  /** Journal chain continuing this snapshot (see flushToCache). */
  journalWriter?: string;
  journalBase?: number;
}

/** One journal segment: what changed since the previous flush (latest states). */
interface FilingJournalSegment {
  generation: string;
  seq: number;
  cursor: ProcessChangesCursor | null;
  logStartSeq: number;
  lostSeqRanges: Array<[number, number]>;
  /** [sidecarId, ref, folders] or [sidecarId, null] for a removed sidecar. */
  sidecars: Array<[string, string, Record<string, number>] | [string, null]>;
  folders: Array<[string, FilingFolder & { deleted: boolean }]>;
  folderIdByDocId: Array<[string, string]>;
  log: Array<[number, string[]]>;
}

/** Keep at most this many changed refs in the change log (older consumers get "all"). */
const MAX_LOG_REFS = 20000;

/**
 * Membership index of one filing store in one database: which documents
 * are filed in which folders, plus the store's folder definitions.
 *
 * It is maintained incrementally from the filing database's changefeed —
 * restricted by id prefix to the store's own documents, so a shared team
 * database with lots of other documents costs nothing extra — and shared by
 * every view that joins the store (one index per database + store, like the
 * summary buffer). Views ask {@link changesSince} which filed documents
 * changed membership since their last update and re-evaluate exactly those.
 *
 * A document may have more than one sidecar (e.g. after a key rotation
 * changed the deterministic sidecar id); its folders are the union.
 */
export class FilingIndex implements ICacheable {
  private readonly db: MindooDB;
  private readonly store: string;
  private readonly idPrefix: string;
  private readonly base: FilingRefBase;

  private generation: string = generateRandomUuid();
  private seq: number = 0;
  private cursor: ProcessChangesCursor | null = null;
  private sidecars: Map<string, SidecarState> = new Map();
  private sidecarsByRef: Map<string, Set<string>> = new Map();
  private membersByFolder: Map<string, Set<string>> = new Map();
  private folders: Map<string, FilingFolder & { deleted: boolean }> = new Map();
  private folderIdByDocId: Map<string, string> = new Map();
  /** First seq the change log still covers completely. */
  private logStartSeq: number = 0;
  private log: Array<[number, string[]]> = [];
  private logRefCount: number = 0;
  /** Seq ranges a crashed previous run may have handed out (see DocumentSummaryStore). */
  private lostSeqRanges: Array<[number, number]> = [];

  private updatePromise: Promise<void> | null = null;
  private updatePending: boolean = false;
  private listeners: Set<() => void> = new Set();

  // cache support
  private cacheManager: CacheManager | null = null;
  private cachePrefix: string | null = null;
  private dirty: boolean = false;
  // Journal (see flushToCache): changes since the last flush, as latest states.
  private pendingSidecars: Map<string, SidecarState | null> = new Map();
  private pendingFolders: Set<string> = new Set();
  private pendingFolderDocIds: Map<string, string> = new Map();
  private pendingLog: Array<[number, string[]]> = [];
  /** Whether this instance wrote the current snapshot (else the next flush writes one). */
  private ownSnapshot: boolean = false;
  private journalEntriesSinceSnapshot: number = 0;
  private nextJournalSegment: number = 0;
  private readonly journalWriterId: string = generateRandomUuid().replace(/-/g, "").slice(0, 12);
  private restored: boolean = false;
  private restorePromise: Promise<void> | null = null;

  constructor(db: MindooDB, store: string, idPrefix: string) {
    this.db = db;
    this.store = store;
    this.idPrefix = idPrefix;
    this.base = { tenantId: db.getTenant().getId(), dbId: db.getStore().getId() };
  }

  /** Name of the filing store this index covers. */
  getStoreName(): string {
    return this.store;
  }

  /** The filing database. */
  getDatabase(): MindooDB {
    return this.db;
  }

  /** Physical identity of the filing database. */
  getBase(): FilingRefBase {
    return { ...this.base };
  }

  /**
   * Register a listener fired after an update changed the index (membership
   * or folder definitions).
   *
   * @returns An unsubscribe function.
   */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Bring the index up to date with the filing database. Concurrent calls
   * share the running catch-up; a call arriving mid-run triggers exactly one
   * follow-up run, so the returned promise always covers changes made
   * before the call.
   */
  async update(): Promise<void> {
    if (this.updatePromise) {
      // The running loop re-checks the flag before finishing, so the
      // running promise also covers this call's changes.
      this.updatePending = true;
      return this.updatePromise;
    }
    this.updatePromise = (async () => {
      try {
        await this.ensureRestored();
        do {
          this.updatePending = false;
          await this.runUpdate();
        } while (this.updatePending);
      } finally {
        this.updatePromise = null;
      }
    })();
    return this.updatePromise;
  }

  private async runUpdate(): Promise<void> {
    const changedRefs = new Set<string>();
    let foldersChanged = false;
    for await (const { doc, cursor } of this.db.iterateChangesSince(this.cursor, { idPrefix: this.idPrefix })) {
      const docId = doc.getId();
      if (doc.isDeleted()) {
        if (this.sidecars.has(docId)) {
          this.applySidecar(docId, null, changedRefs);
        } else {
          const folderId = this.folderIdByDocId.get(docId);
          if (folderId !== undefined) {
            foldersChanged = this.applyFolder(folderId, null, changedRefs) || foldersChanged;
          }
        }
      } else {
        const data = doc.getData() as Record<string, unknown>;
        if (data.store === this.store && data.type === FILING_SIDECAR_TYPE && typeof data.ref === "string") {
          let physRef: string | null = null;
          try {
            physRef = physicalFilingRefKey(resolveFilingRef(data.ref, this.base));
          } catch {
            physRef = null;
          }
          this.applySidecar(
            docId,
            physRef === null ? null : { ref: physRef, folders: readFolderFields(data) },
            changedRefs,
          );
        } else if (
          data.store === this.store &&
          data.type === FILING_FOLDER_TYPE &&
          typeof data.folderId === "string" &&
          data.folderId
        ) {
          this.folderIdByDocId.set(docId, data.folderId);
          this.pendingFolderDocIds.set(docId, data.folderId);
          foldersChanged = this.applyFolder(data.folderId, {
            folderId: data.folderId,
            name: typeof data.name === "string" ? data.name : data.folderId,
            parentId: typeof data.parentId === "string" && data.parentId ? data.parentId : null,
            role: typeof data.role === "string" && data.role ? data.role : null,
            design: typeof data.design === "string" && data.design ? data.design : null,
            deleted: data.deleted === true,
          }, changedRefs) || foldersChanged;
        }
      }
      this.cursor = cursor;
      this.dirty = true;
    }
    if (changedRefs.size > 0) {
      this.appendLog(Array.from(changedRefs));
    }
    if (this.dirty) {
      this.cacheManager?.markDirty();
    }
    if (changedRefs.size > 0 || foldersChanged) {
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // listeners must not break the index
        }
      }
    }
  }

  private applySidecar(sidecarId: string, next: SidecarState | null, changedRefs: Set<string>): void {
    const previous = this.sidecars.get(sidecarId);
    const affectedRefs = new Set<string>();
    if (previous) affectedRefs.add(previous.ref);
    if (next) affectedRefs.add(next.ref);
    const before = new Map<string, string>();
    for (const ref of affectedRefs) {
      before.set(ref, this.foldersOf(ref).join("\u0000"));
    }

    if (previous) {
      this.sidecarsByRef.get(previous.ref)?.delete(sidecarId);
      if (this.sidecarsByRef.get(previous.ref)?.size === 0) {
        this.sidecarsByRef.delete(previous.ref);
      }
      this.sidecars.delete(sidecarId);
      for (const folderId of Object.keys(previous.folders)) {
        this.refreshMembership(folderId, previous.ref);
      }
    }
    if (next) {
      this.sidecars.set(sidecarId, next);
      let ids = this.sidecarsByRef.get(next.ref);
      if (!ids) {
        ids = new Set();
        this.sidecarsByRef.set(next.ref, ids);
      }
      ids.add(sidecarId);
      for (const folderId of Object.keys(next.folders)) {
        this.refreshMembership(folderId, next.ref);
      }
    }

    for (const ref of affectedRefs) {
      if (before.get(ref) !== this.foldersOf(ref).join("\u0000")) {
        changedRefs.add(ref);
      }
    }
    this.pendingSidecars.set(sidecarId, next);
  }

  /** Recompute whether `ref` is a raw member of `folderId` (any sidecar has the key). */
  private refreshMembership(folderId: string, ref: string): void {
    let isMember = false;
    for (const sidecarId of this.sidecarsByRef.get(ref) ?? []) {
      if (Object.prototype.hasOwnProperty.call(this.sidecars.get(sidecarId)?.folders ?? {}, folderId)) {
        isMember = true;
        break;
      }
    }
    let members = this.membersByFolder.get(folderId);
    if (isMember) {
      if (!members) {
        members = new Set();
        this.membersByFolder.set(folderId, members);
      }
      members.add(ref);
    } else if (members) {
      members.delete(ref);
      if (members.size === 0) {
        this.membersByFolder.delete(folderId);
      }
    }
  }

  /** @returns whether the folder definitions changed. */
  private applyFolder(
    folderId: string,
    next: (FilingFolder & { deleted: boolean }) | null,
    changedRefs: Set<string>,
  ): boolean {
    const previous = this.folders.get(folderId);
    const wasHidden = previous?.deleted === true;
    const isHidden = next === null ? wasHidden || previous !== undefined : next.deleted;
    if (next === null) {
      // The definition document itself was (hard) deleted: keep the folder
      // hidden, orphaned sidecar keys must not resurface.
      if (previous) {
        this.folders.set(folderId, { ...previous, deleted: true });
      }
    } else {
      this.folders.set(folderId, next);
    }
    if (wasHidden !== isHidden) {
      for (const ref of this.membersByFolder.get(folderId) ?? []) {
        changedRefs.add(ref);
      }
    }
    if (this.folders.has(folderId)) {
      this.pendingFolders.add(folderId);
    }
    return JSON.stringify(previous ?? null) !== JSON.stringify(this.folders.get(folderId) ?? null);
  }

  private appendLog(refs: string[]): void {
    this.seq++;
    this.log.push([this.seq, refs]);
    this.pendingLog.push([this.seq, refs]);
    this.logRefCount += refs.length;
    while (this.logRefCount > MAX_LOG_REFS && this.log.length > 1) {
      const [droppedSeq, droppedRefs] = this.log.shift()!;
      this.logRefCount -= droppedRefs.length;
      this.logStartSeq = droppedSeq;
    }
  }

  /**
   * Documents whose effective folders changed after position
   * (`generation`, `seq`). Pass `null` for "never synced" (yields `"all"`).
   */
  changesSince(position: { generation: string; seq: number } | null): FilingIndexChanges {
    const current = { generation: this.generation, seq: this.seq };
    if (
      !position ||
      position.generation !== this.generation ||
      position.seq < this.logStartSeq ||
      position.seq > this.seq ||
      this.lostSeqRanges.some(([start, end]) => position.seq > start && position.seq <= end)
    ) {
      return { ...current, refs: "all" };
    }
    const refs = new Set<string>();
    for (const [seq, entryRefs] of this.log) {
      if (seq > position.seq) {
        for (const ref of entryRefs) {
          refs.add(ref);
        }
      }
    }
    return { ...current, refs };
  }

  /** Current position of the index (for {@link changesSince}). */
  getPosition(): { generation: string; seq: number } {
    return { generation: this.generation, seq: this.seq };
  }

  /**
   * Effective folder ids of a filed document (physical key), sorted.
   * Folders whose definition was deleted are left out.
   */
  foldersOf(physRef: string): string[] {
    const sidecarIds = this.sidecarsByRef.get(physRef);
    if (!sidecarIds) {
      return EMPTY;
    }
    const result = new Set<string>();
    for (const sidecarId of sidecarIds) {
      for (const folderId of Object.keys(this.sidecars.get(sidecarId)?.folders ?? {})) {
        if (this.folders.get(folderId)?.deleted !== true) {
          result.add(folderId);
        }
      }
    }
    return result.size === 0 ? EMPTY : Array.from(result).sort();
  }

  /** When the document was filed into `folderId` (earliest of its sidecars), or `null`. */
  filedAt(physRef: string, folderId: string): number | null {
    let result: number | null = null;
    for (const sidecarId of this.sidecarsByRef.get(physRef) ?? []) {
      const at = this.sidecars.get(sidecarId)?.folders[folderId];
      if (typeof at === "number" && (result === null || at < result)) {
        result = at;
      }
    }
    return result;
  }

  /** Physical keys of the documents in a folder (empty for deleted folders). */
  membersOf(folderId: string): string[] {
    if (this.folders.get(folderId)?.deleted === true) {
      return EMPTY;
    }
    return Array.from(this.membersByFolder.get(folderId) ?? []);
  }

  /** Physical keys of every document whose sidecars list `folderId`, also when the folder is deleted. */
  allSidecarRefsInFolder(folderId: string): string[] {
    return Array.from(this.membersByFolder.get(folderId) ?? []);
  }

  /** Physical keys of every document filed in any (visible) folder. */
  allFiledRefs(): string[] {
    const result: string[] = [];
    for (const ref of this.sidecarsByRef.keys()) {
      if (this.foldersOf(ref).length > 0) {
        result.push(ref);
      }
    }
    return result;
  }

  /** Sidecar document ids of a filed document. */
  sidecarIdsOf(physRef: string): string[] {
    return Array.from(this.sidecarsByRef.get(physRef) ?? []);
  }

  /** Stored (relative) reference string of a physical key, as written into sidecars. */
  formatRef(physRef: string): string {
    return formatFilingRef(resolveFilingRef(`mdbref://${physRef}`, this.base), this.base);
  }

  /** A folder definition (also for deleted folders, see `deleted`), or `undefined`. */
  getFolder(folderId: string): (FilingFolder & { deleted: boolean }) | undefined {
    const folder = this.folders.get(folderId);
    return folder ? { ...folder } : undefined;
  }

  /** All visible (not deleted) folder definitions. */
  listFolders(): FilingFolder[] {
    const result: FilingFolder[] = [];
    for (const folder of this.folders.values()) {
      if (!folder.deleted) {
        const { deleted: _deleted, ...rest } = folder;
        result.push(rest);
      }
    }
    return result;
  }

  /** Number of documents with at least one visible folder. */
  getFiledCount(): number {
    return this.allFiledRefs().length;
  }

  // ---------------------------------------------------------------------------
  // Cache persistence
  // ---------------------------------------------------------------------------

  /**
   * Attach cache persistence (recommended prefix: `<dbCachePrefix>/filing/<store tag>`).
   * The persisted state is restored lazily on the first {@link update}.
   */
  attachCache(cacheManager: CacheManager, cachePrefix: string): void {
    this.cacheManager = cacheManager;
    this.cachePrefix = cachePrefix;
    cacheManager.register(this);
  }

  getCachePrefix(): string {
    return this.cachePrefix ?? `filing/${this.idPrefix}`;
  }

  hasDirtyState(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  /** Drop dirty markers without flushing (the records are about to be deleted). */
  discardDirtyState(): void {
    this.dirty = false;
  }

  /**
   * Persist the index as snapshot + journal: normally only what changed
   * since the last flush is appended as a small segment (`filingj`); the
   * full snapshot (`filing`) is written when this instance has none yet
   * (also right after a restore), when the journal outgrows 10 % of the
   * index (min. 200 changes), and on forced flushes (close). Each instance
   * writes its own segment chain; the snapshot names the chain that
   * continues it, so several instances on one key never interleave. A failed
   * write keeps the pending changes for the next flush.
   */
  async flushToCache(store: LocalCacheStore, options?: { force?: boolean }): Promise<number> {
    const pendingCount = this.pendingSidecars.size + this.pendingFolders.size;
    const wantSnapshot =
      options?.force === true ||
      !this.ownSnapshot ||
      this.journalEntriesSinceSnapshot + pendingCount > Math.max(200, this.sidecars.size * 0.1);
    const scalars = {
      generation: this.generation,
      seq: this.seq,
      cursor: this.cursor,
      logStartSeq: this.logStartSeq,
      lostSeqRanges: this.lostSeqRanges,
    };
    if (wantSnapshot) {
      const journalBase = this.nextJournalSegment;
      const payload: PersistedFilingIndex = {
        v: 1,
        ...scalars,
        sidecars: Array.from(this.sidecars, ([id, state]) => [id, state.ref, state.folders]),
        folders: Array.from(this.folders),
        folderIdByDocId: Array.from(this.folderIdByDocId),
        log: this.log,
        journalWriter: this.journalWriterId,
        journalBase,
      };
      await store.put("filing", this.getCachePrefix(), new TextEncoder().encode(JSON.stringify(payload)));
      this.clearPending();
      this.ownSnapshot = true;
      this.journalEntriesSinceSnapshot = 0;
      try {
        const prefix = `${this.getCachePrefix()}/`;
        for (const id of await store.list("filingj")) {
          if (id.startsWith(prefix)) await store.delete("filingj", id);
        }
      } catch {
        // Stale segments are ignored on restore (other chain or before the base).
      }
      return 1;
    }
    const segment: FilingJournalSegment = {
      ...scalars,
      sidecars: Array.from(this.pendingSidecars, ([id, state]) =>
        state ? ([id, state.ref, state.folders] as [string, string, Record<string, number>]) : ([id, null] as [string, null]),
      ),
      folders: Array.from(this.pendingFolders, (folderId) => [folderId, this.folders.get(folderId)!] as [string, FilingFolder & { deleted: boolean }]),
      folderIdByDocId: Array.from(this.pendingFolderDocIds),
      log: this.pendingLog,
    };
    const segmentNo = this.nextJournalSegment;
    await store.put(
      "filingj",
      `${this.getCachePrefix()}/${this.journalWriterId}/${String(segmentNo).padStart(10, "0")}`,
      new TextEncoder().encode(JSON.stringify(segment)),
    );
    this.nextJournalSegment = segmentNo + 1;
    this.journalEntriesSinceSnapshot += pendingCount;
    this.clearPending();
    return 1;
  }

  private clearPending(): void {
    this.pendingSidecars = new Map();
    this.pendingFolders = new Set();
    this.pendingFolderDocIds = new Map();
    this.pendingLog = [];
  }

  private async ensureRestored(): Promise<void> {
    if (this.restored || !this.cacheManager) {
      this.restored = true;
      return;
    }
    if (!this.restorePromise) {
      this.restorePromise = this.restoreFromCache().finally(() => {
        this.restored = true;
      });
    }
    return this.restorePromise;
  }

  private async restoreFromCache(): Promise<void> {
    const store = this.cacheManager?.getStore();
    if (!store) {
      return;
    }
    let payload: PersistedFilingIndex;
    try {
      const bytes = await store.get("filing", this.getCachePrefix());
      if (!bytes) {
        return;
      }
      payload = JSON.parse(new TextDecoder().decode(bytes)) as PersistedFilingIndex;
      if (payload.v !== 1) {
        return;
      }
    } catch {
      return;
    }
    this.generation = payload.generation;
    this.seq = payload.seq;
    this.cursor = payload.cursor ?? null;
    this.folders = new Map(payload.folders);
    this.folderIdByDocId = new Map(payload.folderIdByDocId);
    this.logStartSeq = payload.logStartSeq;
    this.log = payload.log ?? [];
    this.lostSeqRanges = payload.lostSeqRanges ?? [];
    const ignore = new Set<string>();
    for (const [id, ref, folders] of payload.sidecars) {
      this.applySidecar(id, { ref, folders }, ignore);
    }

    // Replay the journal chain that continues this snapshot (in order; a
    // missing or unreadable segment ends the replay — the changefeed catches
    // up from the last good cursor).
    if (typeof payload.journalWriter === "string") {
      try {
        const prefix = `${this.getCachePrefix()}/${payload.journalWriter}/`;
        const numbers = (await store.list("filingj"))
          .filter((id) => id.startsWith(prefix))
          .map((id) => Number(id.slice(prefix.length)))
          .filter((n) => Number.isInteger(n) && n >= (payload.journalBase ?? 0))
          .sort((a, b) => a - b);
        let expected = payload.journalBase ?? 0;
        for (const n of numbers) {
          if (n !== expected) break;
          const bytes = await store.get("filingj", `${prefix}${String(n).padStart(10, "0")}`);
          if (!bytes) break;
          const segment = JSON.parse(new TextDecoder().decode(bytes)) as FilingJournalSegment;
          for (const entry of segment.sidecars) {
            this.applySidecar(entry[0], entry[1] === null ? null : { ref: entry[1], folders: entry[2]! }, ignore);
          }
          for (const [folderId, folder] of segment.folders) this.folders.set(folderId, folder);
          for (const [docId, folderId] of segment.folderIdByDocId) this.folderIdByDocId.set(docId, folderId);
          this.log.push(...segment.log);
          this.generation = segment.generation;
          this.seq = segment.seq;
          this.cursor = segment.cursor ?? null;
          this.logStartSeq = segment.logStartSeq;
          this.lostSeqRanges = segment.lostSeqRanges ?? this.lostSeqRanges;
          expected = n + 1;
        }
      } catch {
        // Keep what was replayed.
      }
    }
    this.log = this.log.filter(([seq]) => seq > this.logStartSeq);
    this.logRefCount = this.log.reduce((sum, [, refs]) => sum + refs.length, 0);
    while (this.logRefCount > MAX_LOG_REFS && this.log.length > 1) {
      const [droppedSeq, droppedRefs] = this.log.shift()!;
      this.logRefCount -= droppedRefs.length;
      this.logStartSeq = droppedSeq;
    }
    this.clearPending();

    // A previous run may have handed out seqs after this persisted state
    // (and views may have consumed them): jump past them.
    const jump = 2 ** 30;
    this.lostSeqRanges = [...this.lostSeqRanges, [this.seq, this.seq + jump]];
    if (this.lostSeqRanges.length > 20) {
      const dropped = this.lostSeqRanges.splice(0, this.lostSeqRanges.length - 20);
      this.logStartSeq = Math.max(this.logStartSeq, dropped[dropped.length - 1][1]);
    }
    this.seq += jump;
    // This instance continues with its own chain: its first flush writes a
    // snapshot.
    this.ownSnapshot = false;
    this.dirty = true;
  }
}

const EMPTY: string[] = [];
Object.freeze(EMPTY);

/** Read the `f:<folderId> -> filedAt` membership fields of a sidecar. */
export function readFolderFields(data: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, at] of Object.entries(data)) {
    if (!key.startsWith(FILING_FOLDER_FIELD_PREFIX) || key.length === FILING_FOLDER_FIELD_PREFIX.length) {
      continue;
    }
    const folderId = key.slice(FILING_FOLDER_FIELD_PREFIX.length);
    if (typeof at === "number" && Number.isFinite(at)) {
      result[folderId] = at;
    } else if (at instanceof Date) {
      result[folderId] = at.getTime();
    } else if (at !== null && at !== undefined) {
      result[folderId] = 0;
    }
  }
  return result;
}
