/**
 * In-process pub/sub for sync change events (sync-v5, phase 5).
 *
 * The `putEntries` paths publish a small descriptor after each accepted
 * write; SSE subscribers on `GET /sync/:storeKind/events` forward it to
 * connected clients so they can trigger a pull instead of polling.
 *
 * Deliberately minimal: no history, no replay — a client that reconnects
 * simply runs one normal (cheap, cursor-skipped) sync to catch up.
 */

/** Payload published for every accepted `putEntries` write. */
export interface SyncChangeEvent {
  tenantId: string;
  dbId: string;
  /** "docs" | "attachments" */
  storeKind: string;
  /** Store head after the write, when the store supports getStoreHead. */
  epoch?: string;
  maxReceiptOrder?: number;
}

export type SyncChangeListener = (event: SyncChangeEvent) => void;

export class SyncEventBus {
  private listeners = new Set<SyncChangeListener>();

  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: SyncChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: SyncChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (e.g. a socket torn down mid-write) must never
        // affect the publisher or other subscribers.
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
