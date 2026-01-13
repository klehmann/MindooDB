import type { VirtualViewNavigator } from "../virtualviews/VirtualViewNavigator";
import type { VirtualViewEntryData } from "./VirtualViewEntryData";

/**
 * Interface for checking if a user has access to view a specific entry.
 * Implement this interface to provide custom access control logic.
 */
export interface IViewEntryAccessCheck {
  /**
   * Check if the user has read access to the provided entry.
   * 
   * @param nav The navigator (provides context about the view and navigation state)
   * @param entry The entry to check access for
   * @returns true if the user can see the entry, false otherwise
   */
  isVisible(nav: VirtualViewNavigator, entry: VirtualViewEntryData): boolean;
}

/**
 * Default access check implementation that allows all entries.
 * Use this as a base class or directly when no access control is needed.
 */
export class AllowAllAccessCheck implements IViewEntryAccessCheck {
  isVisible(nav: VirtualViewNavigator, entry: VirtualViewEntryData): boolean {
    return true;
  }
}

/**
 * Callback-based access check implementation.
 * Allows providing a simple function for access control without implementing the full interface.
 */
export class CallbackAccessCheck implements IViewEntryAccessCheck {
  private readonly callback: (nav: VirtualViewNavigator, entry: VirtualViewEntryData) => boolean;

  constructor(callback: (nav: VirtualViewNavigator, entry: VirtualViewEntryData) => boolean) {
    this.callback = callback;
  }

  isVisible(nav: VirtualViewNavigator, entry: VirtualViewEntryData): boolean {
    return this.callback(nav, entry);
  }
}
