import type { VirtualView } from "./VirtualView";

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
   * @returns A promise that resolves when the update is complete
   */
  update(): Promise<void>;
}
