/**
 * `Automerge.applyChanges` in slices of bounded size.
 *
 * Automerge 3.5 applies one `applyChanges` call as a single batch, and the
 * batch's working memory grows much faster than the changes it holds. A
 * document whose changes each rewrite about a megabyte of text (16 changes,
 * 16 MB) panics with "capacity overflow" in Node and runs the WebAssembly
 * instance out of memory in WebKit. After that panic the Automerge instance is
 * dead for the rest of the page ("Module terminated"), so every other document
 * fails as well — and since the same document is loaded on every start, the
 * failure comes back after each restart. Applied one megabyte at a time, the
 * same changes load without trouble.
 *
 * Steps are bounded by operations as well (`APPLY_CHANGES_SLICE_OPS`): the
 * working memory of a call follows the operations it applies, while what
 * stays afterwards is small. 12 million characters of text load in 221 MB in
 * steps of 500,000 operations and in 1.1 GB in steps of 2 MB (see
 * documentLoadGuard for the measurements and the cost in time).
 * A change whose operations cannot be counted counts by bytes only.
 *
 * Small batches, the normal case, still go through one call. Automerge keeps
 * changes whose dependencies are still missing in its queue between calls, so
 * the slices need not be in causal order.
 */
import type * as AutomergeTypes from "@automerge/automerge/slim";

import { Automerge } from "./automerge-adapter";
import { APPLY_CHANGES_SLICE_BYTES, APPLY_CHANGES_SLICE_OPS, countChunkOps } from "./documentLoadGuard";

export { APPLY_CHANGES_SLICE_BYTES };

/**
 * Splits `changes` into the slices {@link applyChangesInSlices} applies: at
 * most `maxSliceBytes` change bytes and `maxSliceOps` operations each, a single
 * larger change in a slice of its own.
 */
export function planChangeSlices(
  changes: readonly Uint8Array[],
  maxSliceBytes: number = APPLY_CHANGES_SLICE_BYTES,
  maxSliceOps: number = APPLY_CHANGES_SLICE_OPS,
): Uint8Array[][] {
  const slices: Uint8Array[][] = [];
  let slice: Uint8Array[] = [];
  let sliceBytes = 0;
  let sliceOps = 0;
  for (const change of changes) {
    const ops = countChunkOps(change) ?? 0;
    if (slice.length > 0 && (sliceBytes + change.byteLength > maxSliceBytes || sliceOps + ops > maxSliceOps)) {
      slices.push(slice);
      slice = [];
      sliceBytes = 0;
      sliceOps = 0;
    }
    slice.push(change);
    sliceBytes += change.byteLength;
    sliceOps += ops;
  }
  if (slice.length > 0) slices.push(slice);
  return slices;
}

/**
 * Apply `changes` to `doc` like `Automerge.applyChanges`, but in the slices of
 * {@link planChangeSlices}.
 *
 * @returns The document after all slices, as `applyChanges` returns it.
 */
export function applyChangesInSlices<T>(
  doc: AutomergeTypes.Doc<T>,
  changes: readonly Uint8Array[],
  maxSliceBytes: number = APPLY_CHANGES_SLICE_BYTES,
  maxSliceOps: number = APPLY_CHANGES_SLICE_OPS,
): AutomergeTypes.Doc<T> {
  let current = doc;
  for (const slice of planChangeSlices(changes, maxSliceBytes, maxSliceOps)) {
    [current] = Automerge.applyChanges<T>(current, slice);
  }
  return current;
}
