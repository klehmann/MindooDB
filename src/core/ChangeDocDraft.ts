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

export type DraftPath = Array<string | number>;

export type DraftOp =
  | { kind: "set"; path: DraftPath; value: unknown }
  | { kind: "text"; path: DraftPath; value: string }
  | { kind: "counter"; path: DraftPath; delta: number }
  | { kind: "delete"; path: DraftPath }
  | { kind: "splice"; path: DraftPath; index: number; deleteCount: number; items: unknown[] };

export interface ChangeDocDraftHooks {
  /** True for CRDT scalars that read as plain values (counters, immutable strings). */
  isScalarObject(value: unknown): boolean;
  /** The plain read value of a CRDT scalar. */
  readScalar(value: unknown): unknown;
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

  constructor(
    private readonly base: object,
    private readonly hooks: ChangeDocDraftHooks,
  ) {}

  /** The root proxy; the same object for every `getData()` call of one callback. */
  getRoot<T>(): T {
    if (!this.root) {
      this.root = this.shallowCopy(this.base);
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
    if (typeof current === "number") (node as any)[key] = current + delta;
    else if (current === undefined || current === null) (node as any)[key] = delta;
  }

  // ---- reading -------------------------------------------------------------

  private isContainer(value: unknown): value is object {
    return (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !(value instanceof Uint8Array) &&
      !this.hooks.isScalarObject(value)
    );
  }

  private shallowCopy(base: object): Node {
    const read = (value: unknown) => (this.hooks.isScalarObject(value) ? this.hooks.readScalar(value) : value);
    const copy: Node = Array.isArray(base)
      ? Array.from(base as unknown[], read)
      : Object.fromEntries(Object.keys(base).map((key) => [key, read((base as Record<string, unknown>)[key])]));
    this.shadowNodes.add(copy);
    return copy;
  }

  /** The shadow node held at `node[key]`, copying it from the base on first access. */
  private childNode(node: Node, key: string | number): Node {
    const value = (node as any)[key];
    if (this.shadowNodes.has(value)) return value;
    const copy = this.shallowCopy(value);
    (node as any)[key] = copy;
    this.parents.set(copy, { parent: node, key });
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
    return value;
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

  /** A plain deep copy of a value the callback assigns; proxies of this draft are unwrapped. */
  private cloneIn(value: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) throw new Error("Document value is nested too deeply");
    if (value === null || typeof value !== "object") return value;
    const node = this.proxyNodes.get(value as object);
    if (node) value = node;
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Uint8Array) return value.slice();
    if (this.hooks.isScalarObject(value)) {
      // Leaves read from the base document copy as plain values; CRDT objects
      // the caller created on purpose are kept for hydration.
      return this.shadowNodes.has(value as object) ? this.hooks.readScalar(value) : value;
    }
    if (Array.isArray(value)) return Array.from(value, (entry) => this.cloneIn(entry, depth + 1));
    if (!this.isContainer(value)) return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = this.cloneIn(entry, depth + 1);
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
    return removed.map((entry) => (this.isContainer(entry) ? this.cloneIn(entry) : entry));
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
          const read = (entry: unknown) => (this.isContainer(entry) ? this.proxyFor(entry as Node) : entry);
          list.sort(compare ? (a, b) => compare(read(a), read(b)) : undefined);
        } else {
          (Array.prototype as any)[method].apply(list, args);
        }
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
