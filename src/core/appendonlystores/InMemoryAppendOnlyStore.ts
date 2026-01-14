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
  async findNewChanges(haveChangeHashes: string[]): Promise<MindooDocChangeHashes[]> {
    // Create a Set of change hashes we already have for fast lookup
    const haveHashesAsSet = new Set<string>();
    for (const hash of haveChangeHashes) {
      haveHashesAsSet.add(hash);
    }

    // Find all changes we have that are not in the provided list
    const newChanges: MindooDocChangeHashes[] = [];
    for (const change of this.changes) {
      if (!haveHashesAsSet.has(change.changeHash)) {
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

  async findNewChangesForDoc(haveChangeHashes: string[], docId: string): Promise<MindooDocChangeHashes[]> {
    // Create a Set of change hashes we already have for fast lookup
    const haveHashesAsSet = new Set<string>();
    for (const hash of haveChangeHashes) {
      haveHashesAsSet.add(hash);
    }

    // Get changes for this specific document
    const docChanges = this.docIdIndex.get(docId) || [];

    // Find all changes for this doc that are not in the provided list
    const newChanges: MindooDocChangeHashes[] = [];
    for (const change of docChanges) {
      if (!haveHashesAsSet.has(change.changeHash)) {
        // Return only the hash metadata, not the full change
        const { payload, ...hashMetadata } = change;
        newChanges.push(hashMetadata);
      }
    }

    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Found ${newChanges.length} new changes for doc ${docId} out of ${docChanges.length} total`);
    return newChanges;
  }

  /**
   * Get all change hashes in the store.
   * Used for synchronization to identify which changes we have.
   *
   * @return A list of all change hashes in the store
   */
  async getAllChangeHashes(): Promise<string[]> {
    const hashes = this.changes.map(change => change.changeHash);
    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Returning ${hashes.length} change hashes`);
    return hashes;
  }

  /**
   * Purge all change history for a specific document from the store.
   * This breaks append-only semantics but is required for GDPR compliance.
   * 
   * After purging, all changes for the specified document will be removed
   * from the store. This operation cannot be undone.
   * 
   * @param docId The document ID whose change history should be purged
   * @return A promise that resolves when the purge is complete
   */
  async purgeDocHistory(docId: string): Promise<void> {
    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Purging change history for document: ${docId}`);
    
    // Get all changes for this document
    const docChanges = this.docIdIndex.get(docId);
    
    if (!docChanges || docChanges.length === 0) {
      console.log(`[InMemoryAppendOnlyStore:${this.dbId}] No changes found for document ${docId}, nothing to purge`);
      return;
    }
    
    // Remove each change from all indexes
    for (const change of docChanges) {
      // Remove from changeHashIndex
      this.changeHashIndex.delete(change.changeHash);
      
      // Remove from changes array
      const index = this.changes.indexOf(change);
      if (index !== -1) {
        this.changes.splice(index, 1);
      }
    }
    
    // Remove document from docIdIndex
    this.docIdIndex.delete(docId);
    
    console.log(`[InMemoryAppendOnlyStore:${this.dbId}] Purged ${docChanges.length} changes for document ${docId}`);
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
