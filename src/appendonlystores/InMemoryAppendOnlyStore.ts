import {
  AppendOnlyStore,
  AppendOnlyStoreFactory,
} from "./types";
import type {
  MindooDocChange,
  MindooDocChangeHashes,
} from "../types";

/**
 * A simple in-memory implementation of AppendOnlyStore for testing purposes.
 * Stores all changes in an array and provides fast lookups via Maps.
 */
export class InMemoryAppendOnlyStore implements AppendOnlyStore {
  private dbId: string;
  private changes: MindooDocChange[] = [];
  private changeHashIndex: Map<string, MindooDocChange> = new Map();
  private docIdIndex: Map<string, MindooDocChange[]> = new Map();

  constructor(dbId: string) {
    this.dbId = dbId;
  }

  getId(): string {
    return this.dbId;
  }

  /**
   * Append a new change to the store. No-op if we already have this
   * change in the store (based on the change ID).
   *
   * @param change The change to append
   * @return A promise that resolves when the change is appended
   */
  async append(change: MindooDocChange): Promise<void> {
    // Check if we already have this change (no-op if exists)
    if (this.changeHashIndex.has(change.changeHash)) {
      console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Change ${change.changeHash} already exists, skipping`);
      return;
    }

    // Add to array
    this.changes.push(change);

    // Update indexes
    this.changeHashIndex.set(change.changeHash, change);

    // Update document index
    if (!this.docIdIndex.has(change.docId)) {
      this.docIdIndex.set(change.docId, []);
    }
    this.docIdIndex.get(change.docId)!.push(change);

    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Appended change ${change.changeHash} for doc ${change.docId}`);
  }

  /**
   * Find changes in the store that are not listed in the given list of change hashes
   *
   * @param haveChangeHashes The list of document IDs and change hashes we already have
   * @return A list of document IDs and change hashes that we don't have yet
   */
  async findNewChanges(haveChangeHashes: MindooDocChangeHashes[]): Promise<MindooDocChangeHashes[]> {
    // Create a Set of change hashes we already have for fast lookup
    const haveHashes = new Set<string>();
    for (const hashInfo of haveChangeHashes) {
      haveHashes.add(hashInfo.changeHash);
    }

    // Find all changes we have that are not in the provided list
    const newChanges: MindooDocChangeHashes[] = [];
    for (const change of this.changes) {
      if (!haveHashes.has(change.changeHash)) {
        // Return only the hash metadata, not the full change
        const { payload, ...hashMetadata } = change;
        newChanges.push(hashMetadata);
      }
    }

    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Found ${newChanges.length} new changes out of ${this.changes.length} total`);
    return newChanges;
  }

  /**
   * Bulk method to get multiple changes given their hash infos
   *
   * @param changeHashes The hashes of the changes to fetch
   * @return A list of changes with payload and signature
   */
  async getChanges(changeHashes: MindooDocChangeHashes[]): Promise<MindooDocChange[]> {
    const result: MindooDocChange[] = [];

    for (const hashInfo of changeHashes) {
      const change = this.changeHashIndex.get(hashInfo.changeHash);
      if (change) {
        result.push(change);
      } else {
        console.warn(`[InMemoryAppendOnlyStore:${this.dbId}] Change ${hashInfo.changeHash} not found`);
      }
    }

    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Retrieved ${result.length} changes out of ${changeHashes.length} requested`);
    return result;
  }

  /**
   * Get all change hashes that are stored in the store
   *
   * @return A list of change hashes
   */
  async getAllChangeHashes(): Promise<MindooDocChangeHashes[]> {
    const result: MindooDocChangeHashes[] = [];

    for (const change of this.changes) {
      // Return only the hash metadata, not the full change
      const { payload, ...hashMetadata } = change;
      result.push(hashMetadata);
    }

    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Returning ${result.length} change hashes`);
    return result;
  }

  /**
   * Get all change hashes for a document
   *
   * @param docId The ID of the document
   * @param fromLastSnapshot Whether to start from the last snapshot (if there is any)
   * @return A list of change hashes
   */
  async getAllChangeHashesForDoc(docId: string, fromLastSnapshot: boolean): Promise<MindooDocChangeHashes[]> {
    const docChanges = this.docIdIndex.get(docId) || [];

    if (docChanges.length === 0) {
      console.log(`[InMemoryAppendOnlyStore:${this.dbId}] No changes found for doc ${docId}`);
      return [];
    }

    // Sort by timestamp to ensure correct order
    const sortedChanges = [...docChanges].sort((a, b) => a.createdAt - b.createdAt);

    // If fromLastSnapshot is true, find the most recent snapshot and start from there
    if (fromLastSnapshot) {
      // Find the most recent snapshot
      const snapshots = sortedChanges.filter(ch => ch.type === "snapshot");
      if (snapshots.length > 0) {
        // Sort snapshots by timestamp (newest first)
        snapshots.sort((a, b) => b.createdAt - a.createdAt);
        const lastSnapshot = snapshots[0];

        // Return only changes after the last snapshot
        const changesAfterSnapshot = sortedChanges.filter(
          ch => ch.createdAt > lastSnapshot.createdAt
        );

        const result: MindooDocChangeHashes[] = changesAfterSnapshot.map(change => {
          const { payload, ...hashMetadata } = change;
          return hashMetadata;
        });

        console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Returning ${result.length} changes for doc ${docId} after snapshot`);
        return result;
      }
    }

    // Return all changes (without payload)
    const result: MindooDocChangeHashes[] = sortedChanges.map(change => {
      const { payload, ...hashMetadata } = change;
      return hashMetadata;
    });

    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Returning ${result.length} changes for doc ${docId}`);
    return result;
  }
}

/**
 * Factory for creating InMemoryAppendOnlyStore instances.
 * Each database gets its own isolated in-memory store.
 */
export class InMemoryAppendOnlyStoreFactory implements AppendOnlyStoreFactory {
  createStore(dbId: string): AppendOnlyStore {
    return new InMemoryAppendOnlyStore(dbId);
  }
}

