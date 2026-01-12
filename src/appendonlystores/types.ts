import type { MindooDocChange, MindooDocChangeHashes } from "../types";

/**
 * AppendOnlyStoreFactory creates AppendOnlyStore instances for a given database ID.
 * This allows different implementations to provide different storage backends
 * (e.g., in-memory, file-based, database-backed) while maintaining a consistent interface.
 */
export interface AppendOnlyStoreFactory {
  /**
   * Create a new AppendOnlyStore for the given database ID.
   * 
   * @param dbId The ID of the database (e.g., "directory" for the tenant directory database)
   * @return A new AppendOnlyStore instance for this database
   */
  createStore(dbId: string): AppendOnlyStore;
}

/**
 * An AppendOnlyStore is a store that is used to store signed and optionally encrypted
 * binary automerge changes to the documents in a MindooDB.
 * 
 * The AppendOnlyStore is responsible for storing the changes and providing
 * methods to get changes by their hashes, find new changes and get all change hashes.
 * 
 * The append only structure makes synchronization of changes easy between peers (client-client,
 * client-server, server-server).
 */
export interface AppendOnlyStore {
  /**
   * Get the ID of the store
   *
   * @return The ID of the store
   */
  getId(): string;

  /**
   * Append a new change to the store. No-op if we already have this
   * change in the store (based on the change ID).
   *
   * @param change The change to append
   * @return A promise that resolves when the change is appended
   */
  append(change: MindooDocChange): Promise<void>;

  /**
   * Find changes in the store that are not listed in the given list of change hashes
   *
   * @param haveChangeHashes The list of document IDs and change hashes we already have
   * @return A list of document IDs and change hashes that we don't have yet
   */
  findNewChanges(haveChangeHashes: string[]): Promise<MindooDocChangeHashes[]>;

  /**
   * Find changes in the store for a document that are not listed in the given list of change hashes
   *
   * @param haveChangeHashes The list of change hashes we already have
   * @param docId The ID of the document
   * @return A list of change hashes
   */
  findNewChangesForDoc(haveChangeHashes: string[], docId: string): Promise<MindooDocChangeHashes[]>;

  /**
   * Bulk method to get multiple changes given their hash infos
   *
   * @param changeHashes The hashes of the changes to fetch
   * @return A list of changes with payload and signature
   */
  getChanges(changeHashes: MindooDocChangeHashes[]): Promise<MindooDocChange[]>;

  /**
   * Get all change hashes in the store.
   * Used for synchronization to identify which changes we have.
   *
   * @return A list of all change hashes in the store
   */
  getAllChangeHashes(): Promise<string[]>;
}

