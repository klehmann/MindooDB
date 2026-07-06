import type { VirtualView } from "./VirtualView";

/**
 * Progress snapshot passed to {@link VirtualViewUpdateOptions.onProgress}.
 */
export interface VirtualViewUpdateProgress {
  /** Documents processed so far in this update run. */
  processed: number;
  /**
   * Total number of changefeed entries pending at the start of the run
   * (best effort; new changes arriving mid-run are not counted).
   */
  total: number;
  /** Origin of the data provider reporting progress. */
  origin: string;
}

/**
 * Options controlling an incremental view update run.
 *
 * Batching makes long update runs observable and interruptible: after every
 * `applyBatchSize` processed documents the accumulated changes are applied to
 * the view (so the view and the provider cursor stay consistent), progress is
 * reported, and the run can be cancelled. An interrupted run resumes from the
 * saved cursor on the next `update()` call — no work is repeated.
 */
export interface VirtualViewUpdateOptions {
  /**
   * Apply accumulated changes to the view (and report progress) after this
   * many processed documents. Default: 100. Use `Infinity` to apply all
   * changes atomically at the end of the run (progress is then only
   * reported once, and the run cannot be interrupted mid-way).
   */
  applyBatchSize?: number;
  /**
   * Called at every batch boundary (and once at the end of the run).
   * Return `false` to stop the update after the current batch; the cursor
   * points at the last applied document, so the next update resumes there.
   */
  onProgress?: (progress: VirtualViewUpdateProgress) => boolean | void;
  /**
   * Optional abort signal, checked at every batch boundary. Aborting behaves
   * like `onProgress` returning `false`: the current batch is applied, then
   * the run stops cleanly.
   */
  signal?: AbortSignal;
}

/**
 * Interface for classes that provide data to a VirtualView.
 * Data providers fetch documents from a source (like MindooDB) and
 * generate VirtualViewDataChange objects to update the view.
 */
export interface IVirtualViewDataProvider {
  /**
   * Returns a unique identifier for this data provider.
   * Used as the "origin" in view entries to track which provider
   * each document came from.
   * 
   * @returns The origin identifier
   */
  getOrigin(): string;

  /**
   * Called when this data provider is added to a VirtualView.
   * Use this to store a reference to the view and perform initialization.
   * 
   * @param view The VirtualView this provider is attached to
   */
  init(view: VirtualView): void;

  /**
   * Fetches the latest data and sends updates to the VirtualView.
   * This should be idempotent and handle incremental updates efficiently.
   * 
   * @param options Optional batching/progress/cancellation options.
   *   Providers that do not support batching may ignore them.
   * @returns A promise that resolves when the update is complete
   */
  update(options?: VirtualViewUpdateOptions): Promise<void>;
}
