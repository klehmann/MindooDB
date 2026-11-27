/**
 * Estimates what loading a document will cost Automerge, before it is loaded.
 *
 * Automerge keeps one operation per stored op in memory: one per character of
 * collaborative text, one per atomic string, number or key. A megabyte of text
 * is a million operations even though it compresses to under a megabyte on
 * disk, while a megabyte of atomic string is one. The memory a load needs
 * therefore follows the number of operations, not the stored bytes.
 * Measured with Automerge 3.5 (bench/automerge-memory):
 *
 * - `Automerge.load` of a snapshot: about 130 bytes of wasm memory per op
 * - changes applied on top (`applyChanges`, `loadIncremental`): about 500
 *   bytes per op while they are applied
 *
 * A wasm instance has 4 GB. A load that crosses it panics, and every later
 * call on the instance, for every document of the process, throws
 * "Module terminated". Wasm memory never shrinks either, so one large load
 * stays allocated until the page or process restarts.
 *
 * The op counts come from the binary headers without loading anything: the
 * rows of the `action` column of a change or a document chunk (format:
 * https://automerge.org/automerge-binary-format-spec/). Parsing takes well
 * under a millisecond even for documents of millions of ops. A chunk this
 * parser cannot read (compressed data where no synchronous inflate is
 * available, an unknown layout) yields `null`, and the guard then lets the
 * load go ahead as before.
 *
 * @module documentLoadGuard
 */

/** Wasm bytes per operation loaded from a snapshot (`Automerge.load`). */
export const SNAPSHOT_BYTES_PER_OP = 130;
/** Wasm bytes per operation applied as changes (`applyChanges`, `loadIncremental`). */
export const CHANGE_BYTES_PER_OP = 500;

const MAGIC = [0x85, 0x6f, 0x4a, 0x83];
const CHUNK_DOCUMENT = 0;
const CHUNK_CHANGE = 1;
const CHUNK_COMPRESSED_CHANGE = 2;
/** Column id 4 ("action"), column type 2 (unsigned integer, RLE). */
const ACTION_COLUMN_ID = 4;
const ACTION_COLUMN_TYPE = 2;

/**
 * Error thrown instead of loading a document whose estimated Automerge memory
 * exceeds the budget set with {@link setDocumentLoadBudget}. The document is
 * intact; it is only too large to load in this process.
 */
export class DocumentTooLargeError extends Error {
  public readonly docId: string;
  public readonly estimatedBytes: number;
  public readonly budgetBytes: number;
  public readonly ops: number;

  constructor(docId: string, estimate: DocumentLoadEstimate, budgetBytes: number) {
    super(
      `Document ${docId} is too large to load here: about ${Math.round(estimate.bytes / 1048576)} MB ` +
        `of Automerge memory for ${estimate.ops} operations, budget ${Math.round(budgetBytes / 1048576)} MB`,
    );
    this.name = "DocumentTooLargeError";
    this.docId = docId;
    this.estimatedBytes = estimate.bytes;
    this.budgetBytes = budgetBytes;
    this.ops = estimate.ops;
  }
}

/** Whether `error` is a {@link DocumentTooLargeError}, also across bundles. */
export function isDocumentTooLargeError(error: unknown): error is DocumentTooLargeError {
  return error instanceof DocumentTooLargeError || (error as { name?: unknown } | null)?.name === "DocumentTooLargeError";
}

export interface DocumentLoadEstimate {
  /** Operations in the snapshot and the changes together. */
  ops: number;
  /** Estimated peak wasm memory of the load, in bytes. */
  bytes: number;
}

let budgetBytes: number | null = null;

/**
 * Sets the largest estimated Automerge memory one document load may need, in
 * bytes, for this process. Loads above it throw {@link DocumentTooLargeError}
 * instead of risking the wasm instance. `null` (the default) turns the guard
 * off. Hosts pick it per platform: a desktop browser or Node can spend far
 * more than an iOS web view, whose content process is ended well before 4 GB.
 */
export function setDocumentLoadBudget(bytes: number | null): void {
  if (bytes !== null && (!Number.isFinite(bytes) || bytes <= 0)) {
    throw new Error("Document load budget must be a positive number of bytes or null");
  }
  budgetBytes = bytes;
}

export function getDocumentLoadBudget(): number | null {
  return budgetBytes;
}

/**
 * Estimates the load of a snapshot plus changes. Returns `null` when a chunk
 * cannot be read (the guard then does not block).
 */
export function estimateDocumentLoad(
  snapshot: Uint8Array | null,
  changes: readonly Uint8Array[],
): DocumentLoadEstimate | null {
  let snapshotOps = 0;
  if (snapshot) {
    const ops = countChunkOps(snapshot);
    if (ops === null) return null;
    snapshotOps = ops;
  }
  let changeOps = 0;
  for (const change of changes) {
    const ops = countChunkOps(change);
    if (ops === null) return null;
    changeOps += ops;
  }
  return {
    ops: snapshotOps + changeOps,
    bytes: snapshotOps * SNAPSHOT_BYTES_PER_OP + changeOps * CHANGE_BYTES_PER_OP,
  };
}

/**
 * Throws {@link DocumentTooLargeError} when a budget is set and the estimate
 * of loading `snapshot` plus `changes` exceeds it.
 */
export function assertDocumentLoadWithinBudget(
  docId: string,
  snapshot: Uint8Array | null,
  changes: readonly Uint8Array[],
): void {
  if (budgetBytes === null) return;
  const estimate = estimateDocumentLoad(snapshot, changes);
  if (estimate && estimate.bytes > budgetBytes) {
    throw new DocumentTooLargeError(docId, estimate, budgetBytes);
  }
}

/**
 * Number of operations in an Automerge change or document chunk, or `null`
 * when the chunk cannot be read without inflating it.
 */
export function countChunkOps(bytes: Uint8Array): number | null {
  try {
    if (bytes.length < 9) return null;
    for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;
    let offset = 8; // magic + checksum
    const type = bytes[offset++];
    const [length, bodyStart] = readUleb(bytes, offset);
    if (type === CHUNK_COMPRESSED_CHANGE) return null;
    const body = bytes.subarray(bodyStart, bodyStart + length);
    if (type === CHUNK_CHANGE) return countChangeOps(body);
    if (type === CHUNK_DOCUMENT) return countDocumentOps(body);
    return null;
  } catch {
    return null;
  }
}

function countChangeOps(body: Uint8Array): number | null {
  let p = 0;
  let n: number;
  [n, p] = readUleb(body, p); // dependencies
  p += 32 * n;
  let actorLength: number;
  [actorLength, p] = readUleb(body, p);
  p += actorLength;
  [, p] = readUleb(body, p); // seq
  [, p] = readUleb(body, p); // start op
  [, p] = readSleb(body, p); // time
  let messageLength: number;
  [messageLength, p] = readUleb(body, p);
  p += messageLength;
  [n, p] = readUleb(body, p); // other actors
  for (let i = 0; i < n; i++) {
    let otherLength: number;
    [otherLength, p] = readUleb(body, p);
    p += otherLength;
  }
  let columns: ColumnSpec[];
  [columns, p] = readColumns(body, p);
  return countActionRows(body, columns, p);
}

function countDocumentOps(body: Uint8Array): number | null {
  let p = 0;
  let n: number;
  [n, p] = readUleb(body, p); // actors
  for (let i = 0; i < n; i++) {
    let actorLength: number;
    [actorLength, p] = readUleb(body, p);
    p += actorLength;
  }
  [n, p] = readUleb(body, p); // heads
  p += 32 * n;
  let changeColumns: ColumnSpec[];
  let opColumns: ColumnSpec[];
  [changeColumns, p] = readColumns(body, p);
  [opColumns, p] = readColumns(body, p);
  const opDataStart = p + changeColumns.reduce((sum, column) => sum + column.length, 0);
  return countActionRows(body, opColumns, opDataStart);
}

interface ColumnSpec {
  spec: number;
  length: number;
}

function readColumns(body: Uint8Array, offset: number): [ColumnSpec[], number] {
  let p = offset;
  let count: number;
  [count, p] = readUleb(body, p);
  const columns: ColumnSpec[] = [];
  for (let i = 0; i < count; i++) {
    let spec: number;
    let length: number;
    [spec, p] = readUleb(body, p);
    [length, p] = readUleb(body, p);
    columns.push({ spec, length });
  }
  return [columns, p];
}

/** Rows of the RLE-encoded action column: one per operation. */
function countActionRows(body: Uint8Array, columns: ColumnSpec[], dataStart: number): number | null {
  let p = dataStart;
  for (const column of columns) {
    if (column.spec >> 4 === ACTION_COLUMN_ID && (column.spec & 7) === ACTION_COLUMN_TYPE) {
      if ((column.spec >> 3) & 1) return null; // deflated
      return countRleRows(body.subarray(p, p + column.length));
    }
    p += column.length;
  }
  return 0; // no action column: no operations
}

function countRleRows(data: Uint8Array): number {
  let p = 0;
  let rows = 0;
  while (p < data.length) {
    let count: number;
    [count, p] = readSleb(data, p);
    if (count > 0) {
      [, p] = readUleb(data, p); // the repeated value
      rows += count;
    } else if (count < 0) {
      for (let i = 0; i < -count; i++) [, p] = readUleb(data, p);
      rows += -count;
    } else {
      let nulls: number;
      [nulls, p] = readUleb(data, p);
      rows += nulls;
    }
  }
  return rows;
}

function readUleb(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = offset;
  for (;;) {
    if (p >= bytes.length) throw new Error("truncated LEB128");
    const byte = bytes[p++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [result, p];
    if (shift > 63) throw new Error("LEB128 too long");
  }
}

function readSleb(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = offset;
  for (;;) {
    if (p >= bytes.length) throw new Error("truncated LEB128");
    const byte = bytes[p++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) result -= 2 ** shift;
      return [result, p];
    }
    if (shift > 63) throw new Error("LEB128 too long");
  }
}
