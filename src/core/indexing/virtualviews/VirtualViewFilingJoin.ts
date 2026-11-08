import type { MindooDB } from "../../types";
import type { MindooFilingStore } from "../../filing/MindooFilingStore";
import type { FilingIndex } from "../../filing/FilingIndex";
import type { MindooDBAppExpression } from "../../expressions/types";

/** Where a view's filing store comes from (`VirtualViewBuilder.withFilingStore`). */
export type FilingStoreSource =
  | MindooFilingStore
  | { db: MindooDB; store: string; decryptionKeyId?: string };

/** Filing changes handed to data providers before their update. */
export type FilingRefChanges = ReadonlySet<string> | "all";

/**
 * Optional data-provider capability: providers that evaluate `folders()` /
 * `inFolder()` receive the physical keys (`"<tenantId>/<dbId>/<docId>"`) of
 * documents whose folder membership changed, so they can re-evaluate them
 * even though the documents themselves did not change.
 */
export interface IFilingAwareDataProvider {
  onFilingChanges(changes: FilingRefChanges): void;
}

export function isFilingAwareDataProvider(provider: unknown): provider is IFilingAwareDataProvider {
  return typeof (provider as IFilingAwareDataProvider)?.onFilingChanges === "function";
}

interface JoinedFilingStore {
  filingStore: MindooFilingStore;
  index: FilingIndex | null;
  position: { generation: string; seq: number } | null;
}

/** Persisted positions of a view's filing join (part of the view cache). */
export type FilingJoinState = Record<string, { generation: string; seq: number } | null>;

/**
 * The filing stores a VirtualView joins (`withFilingStore`), as seen by its
 * data providers: membership lookups for `folders()` / `inFolder()` and the
 * per-update delta of documents whose membership changed.
 *
 * Filing indexes are shared per (database, store); the join only tracks how
 * far THIS view has consumed each index's change log.
 */
export class VirtualViewFilingJoin {
  private readonly stores: Map<string, JoinedFilingStore> = new Map();

  /** Register a filing store under the name expressions use. */
  add(name: string, source: FilingStoreSource): void {
    if (!name) {
      throw new Error("withFilingStore: name must be a non-empty string.");
    }
    if (this.stores.has(name)) {
      throw new Error(`Filing store "${name}" is already registered on this view.`);
    }
    let filingStore: MindooFilingStore;
    if ("getIndex" in source && typeof source.getIndex === "function") {
      filingStore = source;
    } else {
      const spec = source as { db: MindooDB; store: string; decryptionKeyId?: string };
      if (!spec.db?.filing) {
        throw new Error(`withFilingStore("${name}"): the database does not support filing.`);
      }
      filingStore = spec.db.filing(
        spec.store,
        spec.decryptionKeyId !== undefined ? { decryptionKeyId: spec.decryptionKeyId } : undefined,
      );
    }
    this.stores.set(name, { filingStore, index: null, position: null });
  }

  /** Names of the joined filing stores. */
  getNames(): string[] {
    return Array.from(this.stores.keys());
  }

  has(name: string): boolean {
    return this.stores.has(name);
  }

  /** The filing store registered under `name`. */
  getFilingStore(name: string): MindooFilingStore | undefined {
    return this.stores.get(name)?.filingStore;
  }

  /** The filing databases (for live bindings). */
  getDatabases(): MindooDB[] {
    return Array.from(new Set(Array.from(this.stores.values(), (s) => s.filingStore.getDatabase())));
  }

  /**
   * Bring every joined index up to date and return the documents whose
   * membership changed since this view's last refresh (`"all"` when the
   * view has to re-evaluate everything, e.g. on its first update).
   * Advances the view's positions — callers hand the result to their
   * providers, which keep it until processed.
   */
  async refresh(): Promise<FilingRefChanges> {
    let all = false;
    const refs = new Set<string>();
    for (const joined of this.stores.values()) {
      if (!joined.index) {
        joined.index = await joined.filingStore.getIndex();
      }
      await joined.index.update();
      const changes = joined.index.changesSince(joined.position);
      joined.position = { generation: changes.generation, seq: changes.seq };
      if (changes.refs === "all") {
        all = true;
      } else if (!all) {
        for (const ref of changes.refs) {
          refs.add(ref);
        }
      }
    }
    return all ? "all" : refs;
  }

  /** Folder ids of a document (physical key) in the store registered as `name`. */
  foldersOf(name: string, physRef: string): readonly string[] {
    return this.stores.get(name)?.index?.foldersOf(physRef) ?? NO_FOLDERS;
  }

  /** Physical keys of the members of a folder in the store registered as `name`. */
  membersOf(name: string, folderId: string): readonly string[] {
    return this.stores.get(name)?.index?.membersOf(folderId) ?? NO_FOLDERS;
  }

  /** Whether every joined index has been loaded (lookups are meaningful). */
  isReady(): boolean {
    for (const joined of this.stores.values()) {
      if (!joined.index) return false;
    }
    return true;
  }

  /** Register a listener fired whenever a joined index changes. */
  onDidChange(listener: () => void): () => void {
    const unsubscribes: Array<() => void> = [];
    let disposed = false;
    for (const joined of this.stores.values()) {
      void joined.filingStore.getIndex().then((index) => {
        if (!disposed) {
          unsubscribes.push(index.onDidChange(listener));
        }
      }).catch(() => undefined);
    }
    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  exportState(): FilingJoinState {
    const state: FilingJoinState = {};
    for (const [name, joined] of this.stores) {
      state[name] = joined.position;
    }
    return state;
  }

  importState(state: FilingJoinState | undefined): void {
    if (!state) return;
    for (const [name, position] of Object.entries(state)) {
      const joined = this.stores.get(name);
      if (joined && position && typeof position.generation === "string" && typeof position.seq === "number") {
        joined.position = { ...position };
      }
    }
  }
}

const NO_FOLDERS: readonly string[] = Object.freeze([]);

/**
 * The folder a filter is driven by: `inFolder(store, "<literal id>")` as the
 * whole filter or as one operand of a top-level `and`. Only such members
 * can match, so a provider may read the folder's members instead of every
 * document. `null` when the filter is not of that shape.
 */
export function findDrivingFolder(
  filter: MindooDBAppExpression | null | undefined,
): { store: string; folderId: string } | null {
  if (!filter || filter.kind !== "operation") {
    return null;
  }
  const candidates = filter.op === "and" ? filter.args : [filter];
  for (const candidate of candidates) {
    if (
      candidate.kind === "operation" &&
      candidate.op === "inFolder" &&
      candidate.args.length >= 2 &&
      candidate.args[0]?.kind === "literal" &&
      candidate.args[1]?.kind === "literal" &&
      typeof candidate.args[0].value === "string" &&
      typeof candidate.args[1].value === "string" &&
      candidate.args[1].value !== ""
    ) {
      return { store: candidate.args[0].value, folderId: candidate.args[1].value };
    }
  }
  return null;
}
