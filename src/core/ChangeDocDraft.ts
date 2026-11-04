/**
 * The writable view `getData()` returns inside a `changeDoc()` callback.
 *
 * `Automerge.change()` needs a synchronous callback, while `changeDoc()`
 * callbacks may be async. So the callback edits a shadow copy of the payload,
 * and every edit is also written to an ordered log that `BaseMindooDB` replays
 * inside `Automerge.change()` once the callback is done:
 *
 * - `a.b.c = v` and `delete a.b.c` at any depth become `set` / `delete`.
 * - `push`, `pop`, `shift`, `unshift`, `splice` (and `list[list.length] = v`,
 *   shrinking `length`) become list `splice` operations, so concurrent inserts
 *   from other devices interleave instead of overwriting each other.
 * - `updateText(path, value)` is replayed as a text splice of the changed
 *   middle part, so it merges with concurrent typing like `textSplice`. A plain
 *   assignment of a string keeps replacing the whole value: apps write ids and
 *   status values as plain strings, and two concurrent replacements must not
 *   be merged into a mix of both.
 *
 * The shadow copy is built lazily: a container is copied (shallowly) the first
 * time the callback reaches it, so a callback pays for what it touches, not for
 * the size of the document.
 *
 * Paths are computed when an edit happens, from the edited node up to the
 * root, so an element proxy kept across a `splice` still edits that element.
 */

import type { MindooFieldType } from "./types";

export type DraftPath = Array<string | number>;

export type DraftOp =
  | { kind: "set"; path: DraftPath; value: unknown }
  | { kind: "text"; path: DraftPath; value: string }
  | { kind: "counter"; path: DraftPath; delta: number }
  | { kind: "delete"; path: DraftPath }
  | { kind: "splice"; path: DraftPath; index: number; deleteCount: number; items: unknown[] };

export interface ChangeDocDraftHooks {
  /** The kind of a CRDT scalar that reads as a plain value, or null for anything else. */
  scalarKind(value: unknown): "counter" | "atomic" | null;
  /** The plain read value of a CRDT scalar. */
  readScalar(value: unknown): unknown;
  /** A CRDT counter holding `value`, for the shadow copy. */
  makeCounter(value: number): unknown;
  /** Whether the text at `path` of the base document carries marks or blocks. */
  isRichTextInBase(path: DraftPath): boolean;
  /** Throws once the callback has completed. */
  assertActive(operation: string): void;
}

type Node = Record<string | number, unknown> | unknown[];

const MAX_DEPTH = 100;
const LIST_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

export class ChangeDocDraft {
  readonly ops: DraftOp[] = [];
  private root: Node | null = null;
  private readonly shadowNodes = new WeakSet<object>();
  private readonly parents = new WeakMap<object, { parent: Node; key: string | number }>();
  private readonly proxies = new WeakMap<object, object>();
  private readonly proxyNodes = new WeakMap<object, Node>();
  /** Where a node copied from the base document sits in the base document. */
  private readonly basePaths = new WeakMap<object, DraftPath>();
  /** Keys of a node that this callback assigned, deleted or replaced the text of. */
  private readonly writtenKeys = new WeakMap<object, Set<string | number>>();
  /** Lists whose elements this callback moved (splice, sort, ...). */
  private readonly reorderedLists = new WeakSet<object>();

  constructor(
    private readonly base: object,
    private readonly hooks: ChangeDocDraftHooks,
  ) {}

  /** The root proxy; the same object for every `getData()` call of one callback. */
  getRoot<T>(): T {
    if (!this.root) {
      this.root = this.shallowCopy(this.base);
      this.basePaths.set(this.root, []);
    }
    return this.proxyFor(this.root) as T;
  }

  /** Sets the text at `path` to `value`, stored as a splice of the changed part. */
  updateText(path: DraftPath, value: string): void {
    this.hooks.assertActive("updateText");
    if (typeof value !== "string") throw new Error("updateText: value must be a string");
    if (path.length === 0) throw new Error("updateText: path must not be empty");
    this.getRoot();
    let node = this.root as Node;
    for (const segment of path.slice(0, -1)) {
      if (!this.isContainer((node as any)[segment])) {
        throw new Error(`updateText: no object or list at '${path.map(String).join(".")}'`);
      }
      node = this.childNode(node, segment);
    }
    const key = path[path.length - 1];
    const current = (node as any)[key];
    if (current !== undefined && current !== null && typeof current !== "string") {
      throw new Error(`updateText: the value at '${path.map(String).join(".")}' is not text`);
    }
    if (Array.isArray(node) && !(typeof key === "number" && key < node.length)) {
      throw new Error("updateText: list text must target an existing element");
    }
    this.ops.push({ kind: "text", path: [...path], value });
    (node as any)[key] = value;
    this.markWritten(node, key);
  }

  /**
   * Adds `delta` to the counter at `path`. Logged in call order with the other
   * edits; reads in the rest of the callback see the new value.
   */
  incrementCounter(path: DraftPath, delta: number): void {
    this.hooks.assertActive("incrementCounter");
    this.ops.push({ kind: "counter", path: [...path], delta });
    this.getRoot();
    let node = this.root as Node;
    for (const segment of path.slice(0, -1)) {
      if (!this.isContainer((node as any)[segment])) return;
      node = this.childNode(node, segment);
    }
    const key = path[path.length - 1];
    const current = (node as any)[key];
    if (this.hooks.scalarKind(current) === "counter") {
      (node as any)[key] = this.hooks.makeCounter((this.hooks.readScalar(current) as number) + delta);
    } else if (this.isTypedValue(current, "counter")) {
      (node as any)[key] = { ...(current as object), value: (current as { value: number }).value + delta };
    } else if (current === undefined || current === null) {
      (node as any)[key] = this.hooks.makeCounter(delta);
    }
  }

  /**
   * The type of the value at `path` as this callback sees it, including its
   * own edits so far; undefined when nothing is there.
   */
  getFieldType(path: DraftPath): MindooFieldType | undefined {
    this.getRoot();
    if (path.length === 0) return "map";
    let node = this.root as Node;
    for (const segment of path.slice(0, -1)) {
      if (!this.isContainer((node as any)[segment]) || this.isTypedValue((node as any)[segment])) return undefined;
      node = this.childNode(node, segment);
    }
    const key = path[path.length - 1];
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    const value = (node as any)[key];
    if (typeof value === "string") {
      const basePath = this.basePaths.get(node);
      const unchanged =
        basePath !== undefined &&
        !this.writtenKeys.get(node)?.has(key) &&
        !(Array.isArray(node) && this.reorderedLists.has(node));
      return unchanged && this.hooks.isRichTextInBase([...basePath, key]) ? "richText" : "text";
    }
    return fieldTypeOf(value, this.hooks);
  }

  private markWritten(node: Node, key: string | number): void {
    let keys = this.writtenKeys.get(node);
    if (!keys) this.writtenKeys.set(node, (keys = new Set()));
    keys.add(key);
  }

  private isTypedValue(value: unknown, kind?: string): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const tag = (value as Record<string, unknown>).$mindoo;
    return typeof tag === "string" && (kind === undefined || tag === kind);
  }

  // ---- reading -------------------------------------------------------------

  private isContainer(value: unknown): value is object {
    return (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !(value instanceof Uint8Array) &&
      this.hooks.scalarKind(value) === null
    );
  }

  /** Copies one level of a base node; CRDT scalars stay as they are so their type is known. */
  private shallowCopy(base: object): Node {
    const copy: Node = Array.isArray(base)
      ? Array.from(base as unknown[])
      : Object.fromEntries(Object.keys(base).map((key) => [key, (base as Record<string, unknown>)[key]]));
    this.shadowNodes.add(copy);
    return copy;
  }

  private readValue(value: unknown): unknown {
    return this.hooks.scalarKind(value) !== null ? this.hooks.readScalar(value) : value;
  }

  /** The shadow node held at `node[key]`, copying it from the base on first access. */
  private childNode(node: Node, key: string | number): Node {
    const value = (node as any)[key];
    if (this.shadowNodes.has(value)) return value;
    const copy = this.shallowCopy(value);
    (node as any)[key] = copy;
    this.parents.set(copy, { parent: node, key });
    // Map keys stay put; list indices only while the list keeps its order.
    const parentBase = this.basePaths.get(node);
    if (parentBase && !(Array.isArray(node) && this.reorderedLists.has(node))) {
      this.basePaths.set(copy, [...parentBase, key]);
    }
    return copy;
  }

  private proxyFor(node: Node): object {
    const cached = this.proxies.get(node);
    if (cached) return cached;
    const proxy = new Proxy(node, {
      get: (target, prop, receiver) => this.get(target, prop, receiver),
      set: (target, prop, value) => {
        this.set(target, prop, value);
        return true;
      },
      deleteProperty: (target, prop) => {
        this.deleteProperty(target, prop);
        return true;
      },
      defineProperty: (target, prop, descriptor) => {
        if (!("value" in descriptor)) {
          throw new Error("changeDoc: only plain values can be assigned to document fields");
        }
        this.set(target, prop, descriptor.value);
        return true;
      },
    });
    this.proxies.set(node, proxy);
    this.proxyNodes.set(proxy, node);
    return proxy;
  }

  private get(node: Node, prop: string | symbol, receiver: unknown): unknown {
    if (typeof prop === "symbol") return Reflect.get(node, prop, receiver);
    if (Array.isArray(node) && LIST_METHODS.has(prop)) {
      return (...args: unknown[]) => this.listMethod(node, prop, args);
    }
    if (!Object.prototype.hasOwnProperty.call(node, prop)) {
      return Reflect.get(node, prop, receiver);
    }
    const key = Array.isArray(node) ? Number(prop) : prop;
    const value = (node as any)[prop];
    if (this.isContainer(value)) return this.proxyFor(this.childNode(node, key));
    return this.readValue(value);
  }

  // ---- writing -------------------------------------------------------------

  private pathOf(node: Node): DraftPath {
    const path: DraftPath = [];
    let current: Node = node;
    while (current !== this.root) {
      const link = this.parents.get(current);
      if (!link) {
        throw new Error("changeDoc: this object is no longer part of the document");
      }
      if (Array.isArray(link.parent)) {
        const index = link.parent.indexOf(current);
        if (index < 0) throw new Error("changeDoc: this list element is no longer part of the document");
        path.unshift(index);
      } else {
        if ((link.parent as any)[link.key] !== current) {
          throw new Error("changeDoc: this object is no longer part of the document");
        }
        path.unshift(link.key);
      }
      current = link.parent;
    }
    return path;
  }

  /**
   * A plain deep copy of a value the callback assigns; proxies of this draft
   * are unwrapped. CRDT scalars copied out of the document become the plain
   * values a read returns (like assigning what `getData()` gave you); CRDT
   * objects the caller created on purpose are kept for hydration.
   */
  private cloneIn(value: unknown, depth = 0, fromDraft = false): unknown {
    if (depth > MAX_DEPTH) throw new Error("Document value is nested too deeply");
    if (value === null || typeof value !== "object") return value;
    const node = this.proxyNodes.get(value as object);
    if (node) value = node;
    if (node || this.shadowNodes.has(value as object)) fromDraft = true;
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Uint8Array) return value.slice();
    if (this.hooks.scalarKind(value) !== null) return fromDraft ? this.hooks.readScalar(value) : value;
    if (Array.isArray(value)) return Array.from(value, (entry) => this.cloneIn(entry, depth + 1, fromDraft));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = this.cloneIn(entry, depth + 1, fromDraft);
    }
    return result;
  }

  /** Places a cloned value into the shadow tree, making its containers shadow nodes. */
  private adopt(parent: Node, key: string | number, value: unknown): unknown {
    if (!this.isContainer(value)) return value;
    const node = value as Node;
    this.shadowNodes.add(node);
    this.parents.set(node, { parent, key });
    const entries: Array<[string | number, unknown]> = Array.isArray(node)
      ? node.map((entry, index) => [index, entry])
      : Object.entries(node);
    for (const [childKey, child] of entries) this.adopt(node, childKey, child);
    return node;
  }

  private set(node: Node, prop: string | symbol, value: unknown): void {
    this.hooks.assertActive("set property");
    if (typeof prop === "symbol") return;
    if (Array.isArray(node)) {
      this.setListProperty(node, prop, value);
      return;
    }
    const path = [...this.pathOf(node), prop];
    const clone = this.cloneIn(value);
    this.ops.push({ kind: "set", path, value: clone });
    (node as any)[prop] = this.adopt(node, prop, this.cloneIn(clone));
    this.markWritten(node, prop);
  }

  private setListProperty(list: unknown[], prop: string, value: unknown): void {
    if (prop === "length") {
      const length = Number(value);
      if (!Number.isInteger(length) || length > list.length || length < 0) {
        throw new Error("changeDoc: a list can only be shortened through its length");
      }
      if (length < list.length) this.splice(list, length, list.length - length, []);
      return;
    }
    const index = Number(prop);
    if (!Number.isInteger(index) || index < 0 || String(index) !== prop) {
      throw new Error(`changeDoc: lists cannot hold the named property '${prop}'`);
    }
    if (index === list.length) {
      this.splice(list, index, 0, [value]);
      return;
    }
    if (index > list.length) {
      throw new Error(`changeDoc: cannot assign list index ${index} past the end (length ${list.length})`);
    }
    const path = [...this.pathOf(list), index];
    const clone = this.cloneIn(value);
    this.ops.push({ kind: "set", path, value: clone });
    list[index] = this.adopt(list, index, this.cloneIn(clone));
    this.markWritten(list, index);
  }

  private deleteProperty(node: Node, prop: string | symbol): void {
    this.hooks.assertActive("delete property");
    if (typeof prop === "symbol") return;
    if (Array.isArray(node)) {
      throw new Error("changeDoc: use splice() to remove list elements");
    }
    if (!Object.prototype.hasOwnProperty.call(node, prop)) return;
    const path = [...this.pathOf(node), prop];
    this.ops.push({ kind: "delete", path });
    delete (node as any)[prop];
    this.markWritten(node, prop);
  }

  private splice(list: unknown[], index: number, deleteCount: number, items: unknown[]): unknown[] {
    this.hooks.assertActive("splice list");
    const clones = items.map((item) => this.cloneIn(item));
    const path = this.pathOf(list);
    if (deleteCount > 0 || clones.length > 0) {
      this.ops.push({ kind: "splice", path, index, deleteCount, items: clones });
    }
    const placed = clones.map((clone) => this.cloneIn(clone));
    const removed = list.splice(index, deleteCount, ...placed);
    placed.forEach((item, offset) => this.adopt(list, index + offset, item));
    this.reorderedLists.add(list);
    return removed.map((entry) => this.cloneIn(entry, 0, true));
  }

  private listMethod(list: unknown[], method: string, args: unknown[]): unknown {
    const relative = (value: unknown, fallback: number) => {
      if (value === undefined) return fallback;
      const n = Math.trunc(Number(value)) || 0;
      return n < 0 ? Math.max(list.length + n, 0) : Math.min(n, list.length);
    };
    switch (method) {
      case "push":
        this.splice(list, list.length, 0, args);
        return list.length;
      case "unshift":
        this.splice(list, 0, 0, args);
        return list.length;
      case "pop":
        return list.length === 0 ? undefined : this.splice(list, list.length - 1, 1, [])[0];
      case "shift":
        return list.length === 0 ? undefined : this.splice(list, 0, 1, [])[0];
      case "splice": {
        const start = relative(args[0], 0);
        const deleteCount =
          args.length < 2
            ? list.length - start
            : Math.max(0, Math.min(Math.trunc(Number(args[1])) || 0, list.length - start));
        return this.splice(list, start, args.length === 0 ? 0 : deleteCount, args.slice(2));
      }
      default: {
        // sort, reverse, fill, copyWithin: reorder or overwrite in place, then
        // record every slot that now holds something else.
        this.hooks.assertActive(method);
        list.forEach((entry, index) => {
          if (this.isContainer(entry)) this.childNode(list, index);
        });
        const before = list.slice();
        if (method === "fill") {
          const value = this.cloneIn(args[0]);
          const start = relative(args[1], 0);
          const end = relative(args[2], list.length);
          for (let index = start; index < end; index++) list[index] = this.cloneIn(value);
        } else if (method === "sort") {
          const compare = args[0] as ((a: unknown, b: unknown) => number) | undefined;
          const read = (entry: unknown) => (this.isContainer(entry) ? this.proxyFor(entry as Node) : this.readValue(entry));
          list.sort(compare ? (a, b) => compare(read(a), read(b)) : undefined);
        } else {
          (Array.prototype as any)[method].apply(list, args);
        }
        this.reorderedLists.add(list);
        const path = this.pathOf(list);
        const seen = new Set<unknown>();
        list.forEach((entry, index) => {
          // copyWithin can leave one node in two slots; each slot gets its own.
          if (this.isContainer(entry) && seen.has(entry)) entry = list[index] = this.cloneIn(entry);
          seen.add(entry);
          if (entry === before[index]) return;
          this.ops.push({ kind: "set", path: [...path, index], value: this.cloneIn(entry) });
          this.adopt(list, index, entry);
        });
        return this.proxyFor(list);
      }
    }
  }
}

/**
 * The type of a non-string value: a plain one, a CRDT scalar, or a `MindooValue`
 * tag that this callback assigned and that is not hydrated yet.
 */
export function fieldTypeOf(
  value: unknown,
  hooks: Pick<ChangeDocDraftHooks, "scalarKind">,
): MindooFieldType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return "text";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "timestamp";
  if (value instanceof Uint8Array) return "bytes";
  const kind = hooks.scalarKind(value);
  if (kind) return kind;
  if (Array.isArray(value)) return "list";
  const tag = (value as Record<string, unknown>).$mindoo;
  if (tag === "atomic" || tag === "counter" || tag === "timestamp") return tag;
  return "map";
}

/**
 * The single splice that turns `before` into `after`: the common start and
 * end stay, the middle is replaced. Indices are UTF-16 code units, as in
 * `Automerge.splice`; a surrogate pair is never cut in half.
 */
export function diffTextSplice(
  before: string,
  after: string,
): { index: number; deleteCount: number; insert: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end++;
  }
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--;
  return {
    index: start,
    deleteCount: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
