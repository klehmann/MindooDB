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
 * Small batches, the normal case, still go through one call. Automerge keeps
 * changes whose dependencies are still missing in its queue between calls, so
 * the slices need not be in causal order.
 */
import type * as AutomergeTypes from "@automerge/automerge/slim";

import { Automerge } from "./automerge-adapter";

/** Upper bound for the change bytes handed to one `applyChanges` call. */
export const APPLY_CHANGES_SLICE_BYTES = 2 * 1024 * 1024;

/**
 * Apply `changes` to `doc` like `Automerge.applyChanges`, but in slices of at
 * most `maxSliceBytes` (a single larger change gets a slice of its own).
 *
 * @returns The document after all slices, as `applyChanges` returns it.
 */
export function applyChangesInSlices<T>(
  doc: AutomergeTypes.Doc<T>,
  changes: readonly Uint8Array[],
  maxSliceBytes: number = APPLY_CHANGES_SLICE_BYTES,
): AutomergeTypes.Doc<T> {
  let current = doc;
  let slice: Uint8Array[] = [];
  let sliceBytes = 0;
  const flush = () => {
    if (slice.length === 0) return;
    [current] = Automerge.applyChanges<T>(current, slice);
    slice = [];
    sliceBytes = 0;
  };
  for (const change of changes) {
    if (slice.length > 0 && sliceBytes + change.byteLength > maxSliceBytes) {
      flush();
    }
    slice.push(change);
    sliceBytes += change.byteLength;
  }
  flush();
  return current;
}
