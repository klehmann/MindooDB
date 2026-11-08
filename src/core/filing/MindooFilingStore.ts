import type { MindooDB, MindooDoc } from "../types";
import { MindooValue } from "../values";
import { generateRandomUuid } from "../utils/idGeneration";
import {
  FILING_FOLDER_FIELD_PREFIX as F,
  FILING_FOLDER_TYPE,
  FILING_SIDECAR_TYPE,
  FilingIndex,
  readFolderFields,
  type FilingFolder,
} from "./FilingIndex";
import {
  formatFilingRef,
  physicalFilingRefKey,
  parsePhysicalFilingRefKey,
  resolveFilingRef,
  type FilingRefBase,
  type FilingRefInput,
  type FilingTarget,
} from "./refs";

/** Options of {@link MindooDB.filing}. */
export interface FilingStoreOptions {
  /**
   * Symmetric key the store's sidecar and folder documents are encrypted
   * with, and from which their deterministic ids are derived. Defaults to
   * `"default"` (the tenant key). All replicas must use the same key id.
   */
  decryptionKeyId?: string;
}

/** A filed document, as listed by {@link MindooFilingStore.contents}. */
export interface FilingEntry {
  /** Reference relative to the filing database (the form stored in the sidecar). */
  ref: string;
  /** Physical identity of the filed document. */
  target: FilingTarget;
  /** When it was filed into the folder (epoch ms). */
  filedAt: number;
}

/** Input of {@link MindooFilingStore.createFolder}. */
export interface CreateFolderInput {
  /** Display name. */
  name: string;
  /**
   * Stable folder id. Omit to generate one (`fld_<random>`); pass a fixed id
   * for system folders that every replica creates (e.g. `"inbox"`) — they
   * converge on the same definition document.
   */
  folderId?: string;
  parentId?: string | null;
  role?: string | null;
  design?: string | null;
}

/** Changes of {@link MindooFilingStore.updateFolder}. */
export interface UpdateFolderInput {
  name?: string;
  parentId?: string | null;
  role?: string | null;
  design?: string | null;
}

/** Folder ids are category values: no backslash (category path separator), no control characters. */
const FOLDER_ID_REGEX = /^[^\\\u0000-\u001f]{1,200}$/;

function assertFolderId(folderId: unknown): asserts folderId is string {
  if (typeof folderId !== "string" || !FOLDER_ID_REGEX.test(folderId)) {
    throw new Error(
      `Invalid folder id ${JSON.stringify(folderId)}: 1-200 characters, no backslash and no control characters.`,
    );
  }
}

function toFolderIdList(folderIds: string | string[]): string[] {
  const list = Array.isArray(folderIds) ? folderIds : [folderIds];
  for (const folderId of list) {
    assertFolderId(folderId);
  }
  return list;
}

/**
 * A filing store ("Ablage-Satz"): named set of folders in a database, with
 * the documents filed into them. Obtain it via `db.filing(store)`.
 *
 * Filing never changes the filed document. Each filed document gets one
 * small sidecar document in the filing database holding its folders as
 * fields `f:<folderId> = filedAt` (see {@link FILING_FOLDER_FIELD_PREFIX});
 * moving a document between folders is one small
 * change of that sidecar. Hence filing only needs write access to the
 * filing database — read access to the target suffices — and works across
 * databases and tenants (see the reference format in `refs.ts`). The
 * sidecar's id is a keyed hash of store + target (deterministic, so
 * concurrent first filings on two replicas converge on one document, and
 * opaque to anyone without the database key).
 *
 * Folder definitions are documents of the same store (`$folder`). Folder
 * membership of sidecars whose folder was deleted is ignored.
 */
export class MindooFilingStore {
  private readonly db: MindooDB;
  private readonly store: string;
  private readonly decryptionKeyId: string;
  private readonly base: FilingRefBase;
  private idPrefix: string | null = null;
  private index: FilingIndex | null = null;
  private initPromise: Promise<FilingIndex> | null = null;
  private readonly onIndexCreated?: (index: FilingIndex) => void;

  /** @internal Use `db.filing(store)`. */
  constructor(
    db: MindooDB,
    store: string,
    options?: FilingStoreOptions,
    onIndexCreated?: (index: FilingIndex) => void,
  ) {
    if (typeof store !== "string" || !store) {
      throw new Error("db.filing(store): store must be a non-empty string.");
    }
    this.db = db;
    this.store = store;
    this.decryptionKeyId = options?.decryptionKeyId ?? "default";
    this.base = { tenantId: db.getTenant().getId(), dbId: db.getStore().getId() };
    this.onIndexCreated = onIndexCreated;
  }

  /** Name of this filing store. */
  getName(): string {
    return this.store;
  }

  /** The filing database. */
  getDatabase(): MindooDB {
    return this.db;
  }

  /** Key id the store's documents are encrypted with. */
  getDecryptionKeyId(): string {
    return this.decryptionKeyId;
  }

  private async hash(kind: string, data: string): Promise<string> {
    const tenant = this.db.getTenant();
    if (!tenant.computeKeyedHash) {
      throw new Error("Filing needs a tenant implementation with computeKeyedHash().");
    }
    return tenant.computeKeyedHash(this.decryptionKeyId, `filing/${kind}`, data);
  }

  /**
   * The membership index of this store (created and brought up to date
   * lazily). Shared by every view joining the store.
   */
  async getIndex(): Promise<FilingIndex> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const storeTag = (await this.hash("store", this.store)).slice(0, 16);
        this.idPrefix = `fil_${storeTag}`;
        this.index = new FilingIndex(this.db, this.store, this.idPrefix);
        this.onIndexCreated?.(this.index);
        return this.index;
      })();
      this.initPromise.catch(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  /** The index, brought up to date with the filing database. */
  private async currentIndex(): Promise<FilingIndex> {
    const index = await this.getIndex();
    await index.update();
    return index;
  }

  /** Resolve a reference to the physical identity of the filed document. */
  resolveRef(ref: FilingRefInput): FilingTarget {
    return resolveFilingRef(ref, this.base);
  }

  /** The reference string stored for `ref` (relative to the filing database). */
  formatRef(ref: FilingRefInput): string {
    return formatFilingRef(this.resolveRef(ref), this.base);
  }

  private async sidecarIdFor(physRef: string): Promise<string> {
    await this.getIndex();
    return `${this.idPrefix}_r${(await this.hash("sidecar", `${this.store}\n${physRef}`)).slice(0, 32)}`;
  }

  private async folderDocIdFor(folderId: string): Promise<string> {
    await this.getIndex();
    return `${this.idPrefix}_f${(await this.hash("folder", `${this.store}\n${folderId}`)).slice(0, 32)}`;
  }

  /** Every sidecar of a document: the deterministic one plus any the index knows. */
  private async sidecarIdsFor(index: FilingIndex, physRef: string): Promise<string[]> {
    const ids = new Set(index.sidecarIdsOf(physRef));
    ids.add(await this.sidecarIdFor(physRef));
    return Array.from(ids);
  }

  private async openSidecar(sidecarId: string, target: FilingTarget): Promise<MindooDoc> {
    // Idempotent create: returns the existing sidecar (reviving a deleted one).
    const doc = await this.db.createDocument({ id: sidecarId, decryptionKeyId: this.decryptionKeyId });
    const data = doc.getData() as Record<string, unknown>;
    if (data.type !== FILING_SIDECAR_TYPE || data.store !== this.store || typeof data.ref !== "string") {
      await this.db.changeDoc(doc, (d) => {
        const values = d.getData() as Record<string, unknown>;
        values.type = MindooValue.atomic(FILING_SIDECAR_TYPE);
        values.store = MindooValue.atomic(this.store);
        values.ref = MindooValue.atomic(formatFilingRef(target, this.base));
      });
    }
    return doc;
  }

  private async tryGetDocument(docId: string): Promise<MindooDoc | null> {
    try {
      const doc = await this.db.getDocument(docId);
      return doc.isDeleted() ? null : doc;
    } catch {
      return null;
    }
  }

  /**
   * File a document into one or more folders. Already-present folders keep
   * their original filed-at time.
   */
  async add(ref: FilingRefInput, folderIds: string | string[]): Promise<void> {
    const ids = toFolderIdList(folderIds);
    const target = this.resolveRef(ref);
    const physRef = physicalFilingRefKey(target);
    const sidecarId = await this.sidecarIdFor(physRef);
    const doc = await this.openSidecar(sidecarId, target);
    const now = Date.now();
    const current = doc.getData() as Record<string, unknown>;
    const missing = ids.filter((folderId) => !Object.prototype.hasOwnProperty.call(current, F + folderId));
    if (missing.length === 0) {
      return;
    }
    await this.db.changeDoc(doc, (d) => {
      const values = d.getData() as Record<string, unknown>;
      for (const folderId of missing) {
        if (!Object.prototype.hasOwnProperty.call(values, F + folderId)) {
          values[F + folderId] = now;
        }
      }
    });
  }

  /**
   * Remove a document from one or more folders; without `folderIds` from
   * every folder of this store. The sidecar stays (with an empty map) so a
   * later re-filing changes the same document.
   */
  async remove(ref: FilingRefInput, folderIds?: string | string[]): Promise<void> {
    const ids = folderIds === undefined ? null : toFolderIdList(folderIds);
    const target = this.resolveRef(ref);
    const index = await this.currentIndex();
    await this.removeFromSidecars(index, physicalFilingRefKey(target), ids);
  }

  private async removeFromSidecars(index: FilingIndex, physRef: string, ids: string[] | null): Promise<void> {
    for (const sidecarId of await this.sidecarIdsFor(index, physRef)) {
      const doc = await this.tryGetDocument(sidecarId);
      if (!doc) continue;
      const present = Object.keys(readFolderFields(doc.getData() as Record<string, unknown>));
      const toRemove = ids === null ? present : ids.filter((folderId) => present.includes(folderId));
      if (toRemove.length === 0) continue;
      await this.db.changeDoc(doc, (d) => {
        const values = d.getData() as Record<string, unknown>;
        for (const folderId of toRemove) {
          delete values[F + folderId];
        }
      });
    }
  }

  /**
   * Move a document from one folder to another — one change of one small
   * sidecar. Without `from` the document leaves every other folder of this
   * store (a "move to" in the single-folder sense).
   */
  async move(ref: FilingRefInput, options: { from?: string | string[]; to: string | string[] }): Promise<void> {
    const toIds = toFolderIdList(options.to);
    const fromIds = options.from === undefined ? null : toFolderIdList(options.from);
    const target = this.resolveRef(ref);
    const physRef = physicalFilingRefKey(target);
    const index = await this.currentIndex();
    const primaryId = await this.sidecarIdFor(physRef);
    const now = Date.now();

    // Primary sidecar: remove + add in ONE change, so a concurrent reader
    // never sees the document in neither (or both) folders.
    const primary = await this.openSidecar(primaryId, target);
    await this.db.changeDoc(primary, (d) => {
      const values = d.getData() as Record<string, unknown>;
      const present = Object.keys(readFolderFields(values));
      const removeIds = fromIds ?? present;
      for (const folderId of removeIds) {
        if (!toIds.includes(folderId) && present.includes(folderId)) {
          delete values[F + folderId];
        }
      }
      for (const folderId of toIds) {
        if (!present.includes(folderId)) {
          values[F + folderId] = now;
        }
      }
    });
    // Secondary sidecars (rare): just drop the moved-from folders.
    const secondary = index.sidecarIdsOf(physRef).filter((id) => id !== primaryId);
    for (const sidecarId of secondary) {
      const doc = await this.tryGetDocument(sidecarId);
      if (!doc) continue;
      const present = Object.keys(readFolderFields(doc.getData() as Record<string, unknown>));
      const removeIds = (fromIds ?? present).filter(
        (folderId) => !toIds.includes(folderId) && present.includes(folderId),
      );
      if (removeIds.length === 0) continue;
      await this.db.changeDoc(doc, (d) => {
        const values = d.getData() as Record<string, unknown>;
        for (const folderId of removeIds) {
          delete values[F + folderId];
        }
      });
    }
  }

  /** Folder ids a document is filed in (deleted folders left out), sorted. */
  async foldersOf(ref: FilingRefInput): Promise<string[]> {
    const index = await this.currentIndex();
    return [...index.foldersOf(physicalFilingRefKey(this.resolveRef(ref)))];
  }

  /**
   * The documents filed in a folder, read from the index — no view needed.
   * Sorted by filed-at time (oldest first).
   */
  async *contents(folderId: string): AsyncGenerator<FilingEntry, void, unknown> {
    assertFolderId(folderId);
    const index = await this.currentIndex();
    const entries = index.membersOf(folderId).map((physRef) => {
      const target = parsePhysicalFilingRefKey(physRef);
      return {
        ref: formatFilingRef(target, this.base),
        target,
        filedAt: index.filedAt(physRef, folderId) ?? 0,
      };
    });
    entries.sort((a, b) => a.filedAt - b.filedAt || a.ref.localeCompare(b.ref));
    for (const entry of entries) {
      yield entry;
    }
  }

  /** Number of documents in a folder. */
  async count(folderId: string): Promise<number> {
    assertFolderId(folderId);
    return (await this.currentIndex()).membersOf(folderId).length;
  }

  // ---------------------------------------------------------------------------
  // Folder definitions
  // ---------------------------------------------------------------------------

  /** Create a folder (or revive a deleted one with the same `folderId`). */
  async createFolder(input: CreateFolderInput): Promise<FilingFolder> {
    if (typeof input?.name !== "string" || !input.name.trim()) {
      throw new Error("createFolder: name must be a non-empty string.");
    }
    const folderId = input.folderId ?? `fld_${generateRandomUuid().replace(/-/g, "").slice(0, 24)}`;
    assertFolderId(folderId);
    if (input.parentId) assertFolderId(input.parentId);
    const doc = await this.db.createDocument({
      id: await this.folderDocIdFor(folderId),
      decryptionKeyId: this.decryptionKeyId,
    });
    await this.db.changeDoc(doc, (d) => {
      const values = d.getData() as Record<string, unknown>;
      values.type = MindooValue.atomic(FILING_FOLDER_TYPE);
      values.store = MindooValue.atomic(this.store);
      values.folderId = MindooValue.atomic(folderId);
      values.name = MindooValue.atomic(input.name);
      setOptionalAtomic(values, "parentId", input.parentId);
      setOptionalAtomic(values, "role", input.role);
      setOptionalAtomic(values, "design", input.design);
      values.deleted = false;
    });
    return {
      folderId,
      name: input.name,
      parentId: input.parentId ?? null,
      role: input.role ?? null,
      design: input.design ?? null,
    };
  }

  /** Change a folder's name, parent, role or design. */
  async updateFolder(folderId: string, changes: UpdateFolderInput): Promise<void> {
    assertFolderId(folderId);
    const doc = await this.tryGetDocument(await this.folderDocIdFor(folderId));
    if (!doc || (doc.getData() as Record<string, unknown>).type !== FILING_FOLDER_TYPE) {
      throw new Error(`Folder "${folderId}" does not exist in filing store "${this.store}".`);
    }
    if (changes.name !== undefined && (typeof changes.name !== "string" || !changes.name.trim())) {
      throw new Error("updateFolder: name must be a non-empty string.");
    }
    if (changes.parentId) assertFolderId(changes.parentId);
    await this.db.changeDoc(doc, (d) => {
      const values = d.getData() as Record<string, unknown>;
      if (changes.name !== undefined) values.name = MindooValue.atomic(changes.name);
      if (changes.parentId !== undefined) setOptionalAtomic(values, "parentId", changes.parentId);
      if (changes.role !== undefined) setOptionalAtomic(values, "role", changes.role);
      if (changes.design !== undefined) setOptionalAtomic(values, "design", changes.design);
    });
  }

  /** Rename a folder. Views categorize by folder id, so no filed row changes. */
  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.updateFolder(folderId, { name });
  }

  /**
   * Delete a folder. The definition is marked deleted (so membership keys a
   * concurrent replica still adds stay hidden) and — unless
   * `keepFiling: true` — the folder is removed from every sidecar the
   * local index knows.
   */
  async deleteFolder(folderId: string, options?: { keepFiling?: boolean }): Promise<void> {
    assertFolderId(folderId);
    const doc = await this.tryGetDocument(await this.folderDocIdFor(folderId));
    if (doc) {
      await this.db.changeDoc(doc, (d) => {
        (d.getData() as Record<string, unknown>).deleted = true;
      });
    }
    if (options?.keepFiling) {
      return;
    }
    const index = await this.currentIndex();
    // membersOf() hides deleted folders; read the raw members of the sidecars.
    for (const physRef of index.allSidecarRefsInFolder(folderId)) {
      await this.removeFromSidecars(index, physRef, [folderId]);
    }
  }

  /** A folder definition, or `null` when unknown or deleted. */
  async getFolder(folderId: string): Promise<FilingFolder | null> {
    const folder = (await this.currentIndex()).getFolder(folderId);
    if (!folder || folder.deleted) {
      return null;
    }
    const { deleted: _deleted, ...rest } = folder;
    return rest;
  }

  /** All (not deleted) folders of this store. */
  async listFolders(): Promise<FilingFolder[]> {
    return (await this.currentIndex()).listFolders();
  }
}

function setOptionalAtomic(values: Record<string, unknown>, key: string, value: string | null | undefined): void {
  if (value === undefined) {
    return;
  }
  if (value === null || value === "") {
    delete values[key];
  } else {
    values[key] = MindooValue.atomic(value);
  }
}
