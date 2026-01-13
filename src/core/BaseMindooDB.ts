import * as Automerge from "@automerge/automerge";
import {
  MindooDB,
  MindooDoc,
  MindooDocPayload,
  MindooDocChange,
  MindooDocChangeHashes,
  MindooTenant,
  ProcessChangesCursor,
  ProcessChangesResult,
} from "./types";
import type { AppendOnlyStore } from "./appendonlystores/types";

/**
 * Internal representation of a document with its Automerge state
 */
interface InternalDoc {
  id: string;
  doc: Automerge.Doc<MindooDocPayload>;
  createdAt: number;
  lastModified: number;
  decryptionKeyId: string;
  isDeleted: boolean;
}

/**
 * BaseMindooDB is a platform-agnostic implementation of MindooDB
 * that works in both browser and server environments.
 * 
 * It receives MindooTenant and AppendOnlyStore in the constructor,
 * allowing platform-specific implementations of those interfaces.
 * 
 * Dependencies:
 * - @automerge/automerge: For CRDT document management
 * - Web Crypto API: Available in both browser (window.crypto) and Node.js (crypto)
 *   - Ed25519 signing/verification (Node.js 15+, Chrome 92+)
 *   - AES-256-GCM encryption (widely supported)
 * 
 * TODO: Verify Automerge 2.x API methods:
 * - Automerge.getChangeHash(change) - verify method name
 * - Automerge.getHeads(doc) - verify method name  
 * - Automerge.load(bytes) - verify method name for snapshots
 * - Automerge.applyChanges(doc, changes) - verify method signature
 */
export class BaseMindooDB implements MindooDB {
  private tenant: MindooTenant;
  private store: AppendOnlyStore;
  
  // Internal index: sorted array of document entries, maintained in order by (lastModified, docId)
  // This allows efficient incremental processing without sorting on each call
  private index: Array<{ docId: string; lastModified: number; isDeleted: boolean }> = [];
  
  // Lookup map for O(1) access to index entries by docId
  private indexLookup: Map<string, number> = new Map(); // Map<docId, arrayIndex>
  
  // Cache of loaded documents: Map<docId, InternalDoc>
  private docCache: Map<string, InternalDoc> = new Map();
  
  // Track which change hashes we've already processed
  private processedChangeHashes: string[] = [];
  
  // Monotonic counter for UUID7 generation (ensures uniqueness within same millisecond)
  private uuid7Counter: number = 0;
  private uuid7LastTimestamp: number = 0;

  constructor(tenant: MindooTenant, store: AppendOnlyStore) {
    this.tenant = tenant;
    this.store = store;
  }

  /**
   * Compare two index entries for sorting.
   * Returns negative if a < b, positive if a > b, 0 if equal.
   * Sorts by lastModified first, then by docId for uniqueness.
   */
  private compareIndexEntries(
    a: { docId: string; lastModified: number },
    b: { docId: string; lastModified: number }
  ): number {
    if (a.lastModified !== b.lastModified) {
      return a.lastModified - b.lastModified;
    }
    return a.docId.localeCompare(b.docId);
  }

  /**
   * Update the index entry for a document.
   * When a document changes, it's removed from its current position and inserted
   * at the correct sorted position to maintain order by (lastModified, docId).
   * 
   * @param docId The document ID
   * @param lastModified The new last modified timestamp
   * @param isDeleted Whether the document is deleted
   */
  private updateIndex(docId: string, lastModified: number, isDeleted: boolean): void {
    // Remove existing entry if present
    const existingIndex = this.indexLookup.get(docId);
    if (existingIndex !== undefined) {
      // Remove from array
      this.index.splice(existingIndex, 1);
      // Update lookup map for all entries after the removed one
      for (let i = existingIndex; i < this.index.length; i++) {
        this.indexLookup.set(this.index[i].docId, i);
      }
      // Remove the entry from lookup
      this.indexLookup.delete(docId);
    }
    
    // Find insertion point using binary search to maintain sorted order
    const newEntry = { docId, lastModified, isDeleted };
    let insertIndex = this.index.length; // Default to end
    
    // Binary search for insertion point
    let left = 0;
    let right = this.index.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cmp = this.compareIndexEntries(newEntry, this.index[mid]);
      if (cmp < 0) {
        right = mid - 1;
        insertIndex = mid;
      } else {
        left = mid + 1;
        insertIndex = mid + 1;
      }
    }
    
    // Insert at the correct position
    this.index.splice(insertIndex, 0, newEntry);
    
    // Update lookup map for all entries from insertion point onwards
    for (let i = insertIndex; i < this.index.length; i++) {
      this.indexLookup.set(this.index[i].docId, i);
    }
  }

  /**
   * Initialize the database instance.
   */
  async initialize(): Promise<void> {
    console.log(`[BaseMindooDB] Initializing database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    await this.syncStoreChanges();
  }

  /**
   * Sync changes from the append-only store by finding new changes and processing them.
   * This method can be called multiple times to incrementally sync new changes.
   * On first call (when processedChangeHashes is empty), it will process all changes.
   */
  async syncStoreChanges(): Promise<void> {
    console.log(`[BaseMindooDB] Syncing store changes for database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    console.log(`[BaseMindooDB] Already processed ${this.processedChangeHashes.length} change hashes`);
    
    // Find new changes that we haven't processed yet
    const newChangeHashes = await this.store.findNewChanges(this.processedChangeHashes);
    console.log(`[BaseMindooDB] Found ${newChangeHashes.length} new change hashes`);
    
    if (newChangeHashes.length === 0) {
      console.log(`[BaseMindooDB] No new changes to process`);
      return;
    }
    
    // Group new changes by document ID
    const changesByDoc = new Map<string, MindooDocChangeHashes[]>();
    for (const changeHash of newChangeHashes) {
      if (!changesByDoc.has(changeHash.docId)) {
        changesByDoc.set(changeHash.docId, []);
      }
      changesByDoc.get(changeHash.docId)!.push(changeHash);
    }
    
    // Process each document with new changes
    // Reload documents to apply all changes (including new ones)
    console.log(`[BaseMindooDB] Processing ${changesByDoc.size} documents with new changes`);
    for (const [docId, changeHashes] of changesByDoc) {
      try {
        console.log(`[BaseMindooDB] ===== Processing document ${docId} with ${changeHashes.length} new change(s) in syncStoreChanges =====`);
        // Clear cache for this document so it gets reloaded with all changes
        this.docCache.delete(docId);
        console.log(`[BaseMindooDB] Cleared cache for document ${docId}`);
        
        // Reload document (this will load all changes including new ones)
        console.log(`[BaseMindooDB] About to call loadDocumentInternal for document ${docId}`);
        const doc = await this.loadDocumentInternal(docId);
        console.log(`[BaseMindooDB] loadDocumentInternal returned for document ${docId}, result: ${doc ? 'success' : 'null'}`);
        if (doc) {
          console.log(`[BaseMindooDB] Successfully reloaded document ${docId}, updating index`);
          this.updateIndex(docId, doc.lastModified, doc.isDeleted);
          console.log(`[BaseMindooDB] Updated index for document ${docId} (lastModified: ${doc.lastModified}, isDeleted: ${doc.isDeleted})`);
        } else {
          console.warn(`[BaseMindooDB] Document ${docId} returned null from loadDocumentInternal`);
        }
      } catch (error) {
        console.error(`[BaseMindooDB] ===== ERROR processing document ${docId} in syncStoreChanges =====`);
        console.error(`[BaseMindooDB] Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
        console.error(`[BaseMindooDB] Error message: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
          console.error(`[BaseMindooDB] Error stack: ${error.stack}`);
        }
        // Re-throw the error so we can see what's happening in the test
        console.error(`[BaseMindooDB] Re-throwing error for document ${docId}`);
        throw error;
      }
    }
    
    // Append new change hashes to our processed list
    this.processedChangeHashes.push(...newChangeHashes.map(ch => ch.changeHash));
    
    console.log(`[BaseMindooDB] Synced ${newChangeHashes.length} new changes, index now has ${this.index.length} documents`);
  }

  getStore(): AppendOnlyStore {
    return this.store;
  }

  getTenant(): MindooTenant {
    return this.tenant;
  }

  async createDocument(): Promise<MindooDoc> {
    return this.createEncryptedDocument("default");
  }

  async createEncryptedDocument(decryptionKeyId?: string): Promise<MindooDoc> {
    const keyId = decryptionKeyId || "default";
    
    // Generate UUID7 for document ID
    const docId = this.generateUUID7();
    
    console.log(`[BaseMindooDB] Creating document ${docId} with key ${keyId}`);
    
    // Create initial Automerge document
    const initialDoc = Automerge.init<MindooDocPayload>();
    
    // Get current user for signing
    const currentUser = await this.tenant.getCurrentUserId();
    
    // Create the first change
    const now = Date.now();
    console.log(`[BaseMindooDB] Creating initial Automerge change for document ${docId}`);
    let newDoc: Automerge.Doc<MindooDocPayload>;
    try {
      newDoc = Automerge.change(initialDoc, (doc: MindooDocPayload) => {
        // Store metadata in the document payload
        // We need to modify the document to ensure a change is created
        doc._attachments = [];
      });
      console.log(`[BaseMindooDB] Successfully created Automerge change, document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      console.error(`[BaseMindooDB] Error in Automerge.change for document ${docId}:`, error);
      throw error;
    }
    
    // Get the change bytes from the document
    console.log(`[BaseMindooDB] Getting change bytes from document ${docId}`);
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    console.log(`[BaseMindooDB] Got change bytes: ${changeBytes.length} bytes`);
    
    // Decode the change to get hash and dependencies
    console.log(`[BaseMindooDB] Decoding change to get hash and dependencies`);
    let decodedChange: any;
    try {
      decodedChange = Automerge.decodeChange(changeBytes);
      console.log(`[BaseMindooDB] Successfully decoded change, hash: ${decodedChange.hash}, deps: ${decodedChange.deps?.length || 0}`);
    } catch (error) {
      console.error(`[BaseMindooDB] Error decoding change for document ${docId}:`, error);
      throw error;
    }
    const changeHash = decodedChange.hash;
    const depsHashes: string[] = decodedChange.deps || []; // First change has no dependencies
    
    // Encrypt the change payload first
    console.log(`[BaseMindooDB] Encrypting change payload for document ${docId}`);
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, keyId);
    console.log(`[BaseMindooDB] Encrypted payload: ${changeBytes.length} -> ${encryptedPayload.length} bytes`);
    
    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for E2E encryption: anyone can verify signatures without needing decryption keys
    console.log(`[BaseMindooDB] Signing encrypted payload for document ${docId}`);
    const signature = await this.tenant.signPayload(encryptedPayload);
    console.log(`[BaseMindooDB] Signed payload, signature length: ${signature.length} bytes`);

    // Create change metadata
    const changeMetadata: MindooDocChangeHashes = {
      type: "create",
      docId,
      changeHash,
      depsHashes,
      createdAt: now,
      createdByPublicKey: currentUser.userSigningPublicKey,
      decryptionKeyId: keyId,
      signature,
    };
    
    // Create full change object
    const fullChange: MindooDocChange = {
      ...changeMetadata,
      payload: encryptedPayload,
    };
    
    // Append to store
    await this.store.append(fullChange);
    
    // Create internal document representation
    const internalDoc: InternalDoc = {
      id: docId,
      doc: newDoc,
      createdAt: now,
      lastModified: now,
      decryptionKeyId: keyId,
      isDeleted: false,
    };
    
    // Update cache and index
    this.docCache.set(docId, internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, false);
    
    console.log(`[BaseMindooDB] Document ${docId} created successfully`);
    console.log(`[BaseMindooDB] Document ${docId} cached and indexed (lastModified: ${internalDoc.lastModified})`);
    
    return this.wrapDocument(internalDoc);
  }

  async getDocument(docId: string): Promise<MindooDoc> {
    const internalDoc = await this.loadDocumentInternal(docId);
    
    if (!internalDoc) {
      throw new Error(`Document ${docId} not found`);
    }
    
    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }
    
    return this.wrapDocument(internalDoc);
  }

  async getDocumentAtTimestamp(docId: string, timestamp: number): Promise<MindooDoc | null> {
    console.log(`[BaseMindooDB] Getting document ${docId} at timestamp ${timestamp}`);
    
    // Get all change hashes for this document
    const allChangeHashes = await this.store.findNewChangesForDoc([], docId);
    
    // Filter changes up to the timestamp
    const relevantChanges = allChangeHashes
      .filter(ch => ch.createdAt <= timestamp)
      .sort((a, b) => a.createdAt - b.createdAt);
    
    if (relevantChanges.length === 0) {
      return null; // Document didn't exist at that time
    }
    
    // Load changes
    const changes = await this.store.getChanges(relevantChanges);
    
    // Apply changes in order
    let doc = Automerge.init<MindooDocPayload>();
    for (const changeData of changes) {
      // Verify signature against the encrypted payload (no decryption needed)
      // We sign the encrypted payload, so anyone can verify signatures without decryption keys
      const isValid = await this.tenant.verifySignature(
        changeData.payload,
        changeData.signature,
        changeData.createdByPublicKey
      );
      if (!isValid) {
        console.warn(`[BaseMindooDB] Invalid signature for change ${changeData.changeHash}, skipping`);
        continue;
      }
      
      // Decrypt payload (only after signature verification passes)
      const decryptedPayload = await this.tenant.decryptPayload(
        changeData.payload,
        changeData.decryptionKeyId
      );
      
      // Apply change using loadIncremental - this is the recommended way for binary change data
      doc = Automerge.loadIncremental(doc, decryptedPayload);
    }
    
    // Check if document was deleted at this timestamp
    // Look for a "delete" type entry in the relevant changes
    const hasDeleteEntry = relevantChanges.some(ch => ch.type === "delete" && ch.createdAt <= timestamp);
    
    if (hasDeleteEntry) {
      return null; // Document was deleted at this time
    }
    
    // Find the first change to get createdAt and decryptionKeyId
    const firstChange = relevantChanges.length > 0 ? relevantChanges[0] : null;
    const createdAt = firstChange ? firstChange.createdAt : timestamp;
    const decryptionKeyId = firstChange ? firstChange.decryptionKeyId : "default";
    
    const internalDoc: InternalDoc = {
      id: docId,
      doc,
      createdAt,
      lastModified: timestamp,
      decryptionKeyId,
      isDeleted: false,
    };
    
    return this.wrapDocument(internalDoc);
  }

  async getAllDocumentIds(): Promise<string[]> {
    // Return all non-deleted document IDs from index
    const docIds: string[] = [];
    for (const entry of this.index) {
      if (!entry.isDeleted) {
        docIds.push(entry.docId);
      }
    }
    return docIds;
  }

  async deleteDocument(docId: string): Promise<void> {
    console.log(`[BaseMindooDB] Deleting document ${docId}`);
    
    // Get current document
    const internalDoc = await this.loadDocumentInternal(docId);
    if (!internalDoc || internalDoc.isDeleted) {
      throw new Error(`Document ${docId} not found or already deleted`);
    }
    
    // Get current user for signing
    const currentUser = await this.tenant.getCurrentUserId();
    
    // Create deletion change
    // Note: We don't need to set _deleted in the Automerge document
    // Deletion is tracked via the "delete" type entry in the append-only store
    const newDoc = Automerge.change(internalDoc.doc, (doc: MindooDocPayload) => {
      // No changes needed - deletion is tracked by the "delete" type entry
    });
    
    // Get the change bytes from the document
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    
    // Decode the change to get hash and dependencies
    const decodedChange = Automerge.decodeChange(changeBytes);
    const changeHash = decodedChange.hash;
    const depsHashes = decodedChange.deps || []; // Dependencies from the decoded change
    
    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);
    
    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for E2E encryption: anyone can verify signatures without needing decryption keys
    const signature = await this.tenant.signPayload(encryptedPayload);
    
    // Create change metadata with type "delete" to mark this as a deletion entry in the append-only store
    const changeMetadata: MindooDocChangeHashes = {
      type: "delete",
      docId,
      changeHash,
      depsHashes,
      createdAt: Date.now(),
      createdByPublicKey: currentUser.userSigningPublicKey,
      decryptionKeyId: internalDoc.decryptionKeyId,
      signature,
    };
    
    // Create full change object
    const fullChange: MindooDocChange = {
      ...changeMetadata,
      payload: encryptedPayload,
    };
    
    // Append to store
    await this.store.append(fullChange);
    
    // Update cache and index
    internalDoc.isDeleted = true;
    internalDoc.lastModified = Date.now();
    this.docCache.set(docId, internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, true);
    
    console.log(`[BaseMindooDB] Document ${docId} deleted successfully`);
  }

  async changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>
  ): Promise<void> {
    const docId = doc.getId();
    console.log(`[BaseMindooDB] ===== changeDoc called for document ${docId} =====`);
    
    // Get internal document from cache or load it
    let internalDoc = this.docCache.get(docId);
    if (!internalDoc) {
      console.log(`[BaseMindooDB] Document ${docId} not in cache, loading from store`);
      const loadedDoc = await this.loadDocumentInternal(docId);
      if (!loadedDoc) {
        throw new Error(`Document ${docId} not found`);
      }
      internalDoc = loadedDoc;
      console.log(`[BaseMindooDB] Successfully loaded document ${docId} from store for changeDoc`);
    } else {
      console.log(`[BaseMindooDB] Document ${docId} found in cache`);
    }
    
    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }
    
    // Get current user for signing
    const currentUser = await this.tenant.getCurrentUserId();
    
    // Apply the change function
    const now = Date.now();
    console.log(`[BaseMindooDB] Applying change function to document ${docId}`);
    console.log(`[BaseMindooDB] Document state before change: heads=${JSON.stringify(Automerge.getHeads(internalDoc.doc))}`);
    
    // For async callbacks, we need to handle document modifications carefully.
    // Automerge.change() requires synchronous modifications, so we'll:
    // 1. Execute the async callback to do any async work (like signing)
    // 2. Apply document modifications synchronously within Automerge.change()
    // 
    // We use a two-phase approach: the callback can do async work and collect
    // what needs to be changed, then we apply those changes in Automerge.change()
    const pendingChanges = new Map<string, unknown>();
    const pendingDeletions = new Set<string>();
    
    // Create a document wrapper that collects changes
    const collectingDoc: MindooDoc = {
      getDatabase: () => this,
      getId: () => docId,
      getCreatedAt: () => internalDoc.createdAt,
      getLastModified: () => internalDoc.lastModified,
      isDeleted: () => false,
      getData: () => {
        // Return a proxy that collects property assignments and deletions
        const currentData = internalDoc.doc as unknown as MindooDocPayload;
        return new Proxy(currentData, {
          set: (target, prop, value) => {
            if (typeof prop === 'string') {
              // If this property was marked for deletion, remove it from deletions
              pendingDeletions.delete(prop);
              // Track the change
              pendingChanges.set(prop, value);
              // Also set on the target for immediate access
              (target as any)[prop] = value;
            }
            return true;
          },
          deleteProperty: (target, prop) => {
            if (typeof prop === 'string') {
              // Mark for deletion
              pendingDeletions.add(prop);
              // Remove from pending changes if it was there
              pendingChanges.delete(prop);
              // Also delete from the target for immediate access
              delete (target as any)[prop];
            }
            return true;
          },
          get: (target, prop) => {
            // If marked for deletion, return undefined
            if (typeof prop === 'string' && pendingDeletions.has(prop)) {
              return undefined;
            }
            // Check pending changes first, then target
            if (typeof prop === 'string' && pendingChanges.has(prop)) {
              return pendingChanges.get(prop);
            }
            return (target as any)[prop];
          },
          has: (target, prop) => {
            // If marked for deletion, it doesn't exist
            if (typeof prop === 'string' && pendingDeletions.has(prop)) {
              return false;
            }
            // Check pending changes first, then target
            if (typeof prop === 'string' && pendingChanges.has(prop)) {
              return true;
            }
            return prop in target;
          }
        }) as MindooDocPayload;
      }
    };
    
    // Execute the async callback (this may do async operations like signing)
    await changeFunc(collectingDoc);
    
    // Now apply the collected changes synchronously in Automerge.change()
    let newDoc: Automerge.Doc<MindooDocPayload>;
    try {
      newDoc = Automerge.change(internalDoc.doc, (automergeDoc: MindooDocPayload) => {
        // Apply all pending changes (sets/updates)
        for (const [key, value] of pendingChanges) {
          (automergeDoc as any)[key] = value;
        }
        
        // Apply all pending deletions
        for (const key of pendingDeletions) {
          delete (automergeDoc as any)[key];
        }
        
        // Update lastModified timestamp
        automergeDoc._lastModified = now;
      });
      console.log(`[BaseMindooDB] Successfully applied change function, new document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      console.error(`[BaseMindooDB] Error in Automerge.change for document ${docId}:`, error);
      throw error;
    }
    
    // Get the change bytes from the document
    console.log(`[BaseMindooDB] Getting change bytes from document ${docId}`);
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      //TODO decide if we just exit here or throw an error
      throw new Error("Failed to get change bytes from Automerge document");
    }
    console.log(`[BaseMindooDB] Got change bytes: ${changeBytes.length} bytes`);
    
    // Decode the change to get hash and dependencies
    const decodedChange = Automerge.decodeChange(changeBytes);
    const changeHash = decodedChange.hash;
    const depsHashes = decodedChange.deps || []; // Dependencies from the decoded change
    
    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);
    
    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for E2E encryption: anyone can verify signatures without needing decryption keys
    const signature = await this.tenant.signPayload(encryptedPayload);
    
    // Create change metadata
    const changeMetadata: MindooDocChangeHashes = {
      type: "change",
      docId,
      changeHash,
      depsHashes,
      createdAt: Date.now(),
      createdByPublicKey: currentUser.userSigningPublicKey,
      decryptionKeyId: internalDoc.decryptionKeyId,
      signature,
    };
    
    // Create full change object
    const fullChange: MindooDocChange = {
      ...changeMetadata,
      payload: encryptedPayload,
    };
    
    // Append to store
    await this.store.append(fullChange);
    
    // Update cache and index
    internalDoc.doc = newDoc;
    internalDoc.lastModified = Date.now();
    this.docCache.set(docId, internalDoc);
    this.updateIndex(docId, internalDoc.lastModified, internalDoc.isDeleted);
    
    console.log(`[BaseMindooDB] Document ${docId} changed successfully`);
  }

  async processChangesSince(
    cursor: ProcessChangesCursor | null,
    limit: number,
    callback: (change: MindooDoc, currentCursor: ProcessChangesCursor) => boolean | void
  ): Promise<ProcessChangesCursor> {
    // Default to initial cursor if null is provided
    const actualCursor: ProcessChangesCursor = cursor ?? { lastModified: 0, docId: "" };
    console.log(`[BaseMindooDB] Processing changes since cursor ${JSON.stringify(actualCursor)} (limit: ${limit})`);
    
    // Find starting position using binary search
    // We want to find the first entry that is greater than the cursor
    let startIndex = 0;
    if (this.index.length > 0) {
      let left = 0;
      let right = this.index.length - 1;
      
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const entry = this.index[mid];
        const cmp = this.compareIndexEntries(
          { docId: actualCursor.docId, lastModified: actualCursor.lastModified },
          entry
        );
        
        if (cmp < 0) {
          right = mid - 1;
          startIndex = mid;
        } else {
          left = mid + 1;
          startIndex = mid + 1;
        }
      }
      
      // If we found an exact match, start from the next entry
      if (startIndex < this.index.length) {
        const entry = this.index[startIndex];
        if (entry.lastModified === actualCursor.lastModified && entry.docId === actualCursor.docId) {
          startIndex++;
        }
      }
    }
    
    // Process documents in order from the starting position
    let processedCount = 0;
    let lastCursor: ProcessChangesCursor = actualCursor;
    
    for (let i = startIndex; i < this.index.length && processedCount < limit; i++) {
      const entry = this.index[i];
      
      // Skip deleted documents (they're still in index for tracking, but shouldn't be processed)
      if (entry.isDeleted) {
        continue;
      }
      
      try {
        console.log(`[BaseMindooDB] Processing document ${entry.docId} from index (lastModified: ${entry.lastModified})`);
        const doc = await this.getDocument(entry.docId);
        console.log(`[BaseMindooDB] Successfully loaded document ${entry.docId}`);
        
        // Create cursor for current document
        const currentCursor: ProcessChangesCursor = {
          lastModified: entry.lastModified,
          docId: entry.docId,
        };
        
        const shouldContinue = callback(doc, currentCursor);
        
        // Update cursor to the last successfully processed document
        lastCursor = currentCursor;
        processedCount++;
        
        // Stop if callback returns false
        if (shouldContinue === false) {
          console.log(`[BaseMindooDB] Callback requested to stop processing`);
          break;
        }
      } catch (error) {
        console.error(`[BaseMindooDB] Error processing document ${entry.docId}:`, error);
        // Stop processing on error
        throw error;
      }
    }
    
    console.log(`[BaseMindooDB] Processed ${processedCount} changes, last cursor: ${JSON.stringify(lastCursor)}`);
    return lastCursor;
  }

  async *iterateChangesSince(
    cursor: ProcessChangesCursor | null,
    pageSize: number = 100
  ): AsyncGenerator<ProcessChangesResult, void, unknown> {
    console.log(`[BaseMindooDB] Starting iteration from cursor ${JSON.stringify(cursor)} (pageSize: ${pageSize})`);
    
    let currentCursor: ProcessChangesCursor | null = cursor;
    
    while (true) {
      // Collect documents from this page
      const pageResults: ProcessChangesResult[] = [];
      let documentsProcessed = 0;
      
      // Process one page of changes
      const returnedCursor = await this.processChangesSince(
        currentCursor,
        pageSize,
        (doc: MindooDoc, docCursor: ProcessChangesCursor) => {
          documentsProcessed++;
          pageResults.push({ doc, cursor: docCursor });
          // Always continue processing the page
          return true;
        }
      );
      
      // Yield all documents from this page
      for (const result of pageResults) {
        yield result;
      }
      
      // If we processed fewer documents than the page size, we've reached the end
      if (documentsProcessed < pageSize) {
        console.log(`[BaseMindooDB] Reached end of documents, processed ${documentsProcessed} in last page`);
        break;
      }
      
      // If the cursor didn't advance, we've reached the end
      if (currentCursor !== null && 
          returnedCursor.lastModified === currentCursor.lastModified && 
          returnedCursor.docId === currentCursor.docId) {
        console.log(`[BaseMindooDB] Cursor did not advance, reached end of documents`);
        break;
      }
      
      // Continue with the next page using the returned cursor
      currentCursor = returnedCursor;
    }
    
    console.log(`[BaseMindooDB] Iteration completed`);
  }

  /**
   * Internal method to load a document from the append-only store
   */
  private async loadDocumentInternal(docId: string): Promise<InternalDoc | null> {
    // Check cache first
    if (this.docCache.has(docId)) {
      console.log(`[BaseMindooDB] Document ${docId} found in cache, returning cached version`);
      return this.docCache.get(docId)!;
    }
    
    console.log(`[BaseMindooDB] ===== Starting to load document ${docId} from store =====`);
    
    // Get all change hashes for this document
    // TODO: Implement loading from last snapshot if available
    console.log(`[BaseMindooDB] Getting all change hashes for document ${docId}`);
    const allChangeHashes = await this.store.findNewChangesForDoc([], docId);
    console.log(`[BaseMindooDB] Found ${allChangeHashes.length} total change hashes for document ${docId}`);
    
    if (allChangeHashes.length === 0) {
      console.log(`[BaseMindooDB] No change hashes found for document ${docId}, returning null`);
      return null;
    }
    
    // Log all change types
    const changeTypes = allChangeHashes.map(ch => `${ch.type}@${ch.createdAt}`).join(', ');
    console.log(`[BaseMindooDB] Change types for ${docId}: ${changeTypes}`);
    
    // Find the most recent snapshot (if any)
    const snapshots = allChangeHashes.filter(ch => ch.type === "snapshot");
    console.log(`[BaseMindooDB] Found ${snapshots.length} snapshot(s) for document ${docId}`);
    let startFromSnapshot = false;
    let snapshotHash: MindooDocChangeHashes | null = null;
    
    if (snapshots.length > 0) {
      // Use the most recent snapshot
      snapshots.sort((a, b) => b.createdAt - a.createdAt);
      snapshotHash = snapshots[0];
      startFromSnapshot = true;
      console.log(`[BaseMindooDB] Will start from snapshot ${snapshotHash.changeHash} created at ${snapshotHash.createdAt}`);
    } else {
      console.log(`[BaseMindooDB] No snapshot found, will start from scratch`);
    }
    
    // Get all changes (excluding snapshot entries - we'll handle delete separately)
    // Include "create", "change", and "delete" types as they all contain Automerge changes to apply
    const changesToLoad = startFromSnapshot
      ? allChangeHashes.filter(ch => (ch.type === "create" || ch.type === "change" || ch.type === "delete") && ch.createdAt > snapshotHash!.createdAt)
      : allChangeHashes.filter(ch => ch.type === "create" || ch.type === "change" || ch.type === "delete");
    console.log(`[BaseMindooDB] Will load ${changesToLoad.length} changes for document ${docId} (after snapshot filter)`);
    
    // Load the snapshot first if we have one
    let doc: Automerge.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotHash) {
      console.log(`[BaseMindooDB] Loading snapshot for document ${docId}`);
      const snapshotChanges = await this.store.getChanges([snapshotHash]);
      console.log(`[BaseMindooDB] Retrieved ${snapshotChanges.length} snapshot change(s) from store`);
      if (snapshotChanges.length > 0) {
        const snapshotData = snapshotChanges[0];
        
        // Verify signature against the encrypted snapshot (no decryption needed)
        // We sign the encrypted payload, so anyone can verify signatures without decryption keys
        const isValid = await this.tenant.verifySignature(
          snapshotData.payload,
          snapshotData.signature,
          snapshotData.createdByPublicKey
        );
        if (!isValid) {
          console.warn(`[BaseMindooDB] Invalid signature for snapshot ${snapshotData.changeHash}, falling back to loading from scratch`);
          // Fall back to loading from scratch
          startFromSnapshot = false;
        } else {
          console.log(`[BaseMindooDB] Snapshot signature valid, decrypting snapshot`);
          // Decrypt snapshot (only after signature verification passes)
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.payload,
            snapshotData.decryptionKeyId
          );
          console.log(`[BaseMindooDB] Decrypted snapshot (${snapshotData.payload.length} -> ${decryptedSnapshot.length} bytes)`);
          
          // Load snapshot using Automerge.load()
          // This deserializes a full document snapshot from binary data
          // According to Automerge docs: load() is equivalent to init() followed by loadIncremental()
          console.log(`[BaseMindooDB] Loading snapshot into Automerge document`);
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);
          console.log(`[BaseMindooDB] Successfully loaded snapshot, document heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
        }
      }
    }
    
    // If we don't have a snapshot, start from scratch
    if (!doc) {
      console.log(`[BaseMindooDB] Initializing new Automerge document for ${docId}`);
      doc = Automerge.init<MindooDocPayload>();
      console.log(`[BaseMindooDB] Initialized empty document, heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
    }
    
    // Sort changes by timestamp
    changesToLoad.sort((a, b) => a.createdAt - b.createdAt);
    console.log(`[BaseMindooDB] Sorted ${changesToLoad.length} changes by timestamp for document ${docId}`);
    
    // Load and apply all changes
    console.log(`[BaseMindooDB] Fetching ${changesToLoad.length} changes from store for document ${docId}`);
    const changes = await this.store.getChanges(changesToLoad);
    console.log(`[BaseMindooDB] Retrieved ${changes.length} changes from store for document ${docId}`);
    console.log(`[BaseMindooDB] Loading document ${docId}: found ${changes.length} changes to apply (${startFromSnapshot ? 'starting from snapshot' : 'starting from scratch'})`);
    
    // Log current document state before applying changes
    console.log(`[BaseMindooDB] Document state before applying changes: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
    
    // Verify signatures, decrypt, and apply changes one at a time
    // This ensures dependencies are handled correctly by Automerge
    for (let i = 0; i < changes.length; i++) {
      const changeData = changes[i];
      console.log(`[BaseMindooDB] ===== Processing change ${i + 1}/${changes.length} for document ${docId} =====`);
      console.log(`[BaseMindooDB] Change hash: ${changeData.changeHash}`);
      console.log(`[BaseMindooDB] Change type: ${changeData.type}`);
      console.log(`[BaseMindooDB] Change createdAt: ${changeData.createdAt}`);
      console.log(`[BaseMindooDB] Change dependencies: ${JSON.stringify(changeData.depsHashes || [])}`);
      console.log(`[BaseMindooDB] Change payload size: ${changeData.payload.length} bytes`);
      // Verify signature against the encrypted payload (no decryption needed)
      // We sign the encrypted payload, so anyone can verify signatures without decryption keys
      console.log(`[BaseMindooDB] Verifying signature for change ${changeData.changeHash}`);
      const isValid = await this.tenant.verifySignature(
        changeData.payload,
        changeData.signature,
        changeData.createdByPublicKey
      );
      if (!isValid) {
        console.warn(`[BaseMindooDB] Invalid signature for change ${changeData.changeHash}, skipping`);
        continue;
      }
      console.log(`[BaseMindooDB] Signature valid for change ${changeData.changeHash}`);
      
      // Decrypt payload (only after signature verification passes)
      console.log(`[BaseMindooDB] Decrypting payload for change ${changeData.changeHash} with key ${changeData.decryptionKeyId}`);
      const decryptedPayload = await this.tenant.decryptPayload(
        changeData.payload,
        changeData.decryptionKeyId
      );
      console.log(`[BaseMindooDB] Decrypted payload: ${changeData.payload.length} -> ${decryptedPayload.length} bytes`);
      
      // Apply change using applyChanges with raw change bytes
      // applyChanges expects an array of Uint8Array (raw change bytes)
      try {
        console.log(`[BaseMindooDB] Document state before applying change ${i + 1}: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
        console.log(`[BaseMindooDB] Calling Automerge.applyChanges for change ${i + 1}/${changes.length} on document ${docId}`);
        console.log(`[BaseMindooDB] Decrypted payload length: ${decryptedPayload.length} bytes`);
        const currentDoc: Automerge.Doc<MindooDocPayload> = doc!;
        const result = Automerge.applyChanges<MindooDocPayload>(currentDoc, [decryptedPayload]);
        doc = result[0] as Automerge.Doc<MindooDocPayload>;
        console.log(`[BaseMindooDB] Successfully applied change ${i + 1}/${changes.length}`);
        console.log(`[BaseMindooDB] Document state after applying change ${i + 1}: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
      } catch (error) {
        console.error(`[BaseMindooDB] Error applying change ${changeData.changeHash} to document ${docId}:`, error);
        console.error(`[BaseMindooDB] Change index: ${i + 1}/${changes.length}`);
        console.error(`[BaseMindooDB] Change dependencies:`, changeData.depsHashes);
        console.error(`[BaseMindooDB] Change type:`, changeData.type);
        console.error(`[BaseMindooDB] Change createdAt:`, changeData.createdAt);
        console.error(`[BaseMindooDB] Document state before change:`, {
          hasDoc: !!doc,
          docHeads: doc ? Automerge.getHeads(doc) : null,
        });
        // Log previous change for debugging dependency issues
        if (i > 0) {
          const prevChange = changes[i - 1];
          console.error(`[BaseMindooDB] Previous change:`, {
            hash: prevChange.changeHash,
            deps: prevChange.depsHashes,
            type: prevChange.type,
          });
        }
        throw error;
      }
    }
    
    // Extract metadata from document (doc is guaranteed to be defined at this point)
    console.log(`[BaseMindooDB] All changes applied successfully for document ${docId}`);
    console.log(`[BaseMindooDB] Final document heads: ${JSON.stringify(Automerge.getHeads(doc!))}`);
    const payload = doc! as unknown as MindooDocPayload;
    
    // Check if document was deleted by looking for a "delete" type entry
    const hasDeleteEntry = allChangeHashes.some(ch => ch.type === "delete");
    const isDeleted = hasDeleteEntry;
    console.log(`[BaseMindooDB] Document ${docId} isDeleted: ${isDeleted}`);
    
    const decryptionKeyId = (payload._decryptionKeyId as string) || "default";
    // Get lastModified from payload, or use the timestamp of the last change
    const lastChange = changes.length > 0 ? changes[changes.length - 1] : null;
    const lastModified = (payload._lastModified as number) || 
                         (lastChange ? lastChange.createdAt : Date.now());
    // Get createdAt from the first change
    const firstChange = allChangeHashes.length > 0 ? allChangeHashes[0] : null;
    const createdAt = firstChange ? firstChange.createdAt : lastModified;
    
    console.log(`[BaseMindooDB] Document ${docId} metadata: createdAt=${createdAt}, lastModified=${lastModified}, decryptionKeyId=${decryptionKeyId}`);
    
    const internalDoc: InternalDoc = {
      id: docId,
      doc: doc!, // doc is guaranteed to be defined at this point
      createdAt,
      lastModified,
      decryptionKeyId,
      isDeleted,
    };
    
    // Update cache
    this.docCache.set(docId, internalDoc);
    console.log(`[BaseMindooDB] ===== Successfully loaded document ${docId} and cached it =====`);
    
    return internalDoc;
  }


  /**
   * Wrap an internal document in the MindooDoc interface
   */
  private wrapDocument(internalDoc: InternalDoc): MindooDoc {
    return {
      getDatabase: () => this,
      getId: () => internalDoc.id,
      getCreatedAt: () => internalDoc.createdAt,
      getLastModified: () => internalDoc.lastModified,
      isDeleted: () => internalDoc.isDeleted,
      getData: () => internalDoc.doc as unknown as MindooDocPayload,
    };
  }

  /**
   * Generate a UUID7 identifier with monotonic counter for same-millisecond collisions
   * 
   * Platform-agnostic implementation that works in both browser and Node.js.
   * Uses crypto.getRandomValues() when available, falls back to Math.random() otherwise.
   * 
   * UUID7 format: timestamp (48 bits) + random (74 bits) = 122 bits total
   * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
   * Where 7 indicates version 7, and y is one of 8, 9, A, or B
   * 
   * Note: Uses millisecond precision (Date.now()). For higher precision, consider
   * using a proper UUID7 library that supports microsecond timestamps.
   */
  private generateUUID7(): string {
    // Get millisecond timestamp (48 bits can represent ~8,925 years from Unix epoch)
    const timestampMs = Date.now();
    
    // Handle monotonic counter for same-millisecond collisions
    // This ensures uniqueness even when generating multiple UUIDs in the same millisecond
    if (timestampMs === this.uuid7LastTimestamp) {
      // Same millisecond - increment counter
      this.uuid7Counter++;
      // Counter is 12 bits max (0-4095), if it overflows, we wait for next millisecond
      if (this.uuid7Counter >= 4096) {
        // Wait until next millisecond (extremely rare - would require 4096+ UUIDs in 1ms)
        while (Date.now() === timestampMs) {
          // Busy wait - should be extremely rare
        }
        this.uuid7Counter = 0;
        this.uuid7LastTimestamp = Date.now();
      }
    } else {
      // New millisecond - reset counter
      this.uuid7Counter = 0;
      this.uuid7LastTimestamp = timestampMs;
    }
    
    // Generate random bytes (10 bytes = 80 bits, we'll use 62 bits for random field)
    const randomBytes = new Uint8Array(10);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(randomBytes);
    } else {
      // Fallback for environments without crypto.getRandomValues
      // WARNING: Math.random() is not cryptographically secure and may have collisions
      // For production use, ensure crypto.getRandomValues is available
      for (let i = 0; i < randomBytes.length; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    
    // Incorporate monotonic counter into the random field (first 12 bits)
    // This ensures uniqueness within the same millisecond while maintaining time-ordering
    // Counter is 12 bits (0-4095), stored in first 1.5 bytes of random field
    const counterHigh = (this.uuid7Counter >> 8) & 0xFF;
    const counterLow = this.uuid7Counter & 0xFF;
    randomBytes[0] = counterHigh;
    randomBytes[1] = (counterLow << 4) | (randomBytes[1] & 0x0F); // Preserve lower 4 bits for variant
    
    // Build UUID7 format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
    // Timestamp (48 bits = 12 hex digits) - milliseconds since Unix epoch
    const timestampHex = timestampMs.toString(16).padStart(12, "0");
    
    // Version 7 indicator (4 bits = 1 hex digit, value 7)
    const version = "7";
    
    // Variant (2 bits = 1 hex digit, value 8, 9, A, or B)
    const variant = (8 + (randomBytes[1] & 0x3)).toString(16).toUpperCase();
    
    // Random data (62 bits = 15 hex digits)
    // First 12 bits are the counter, remaining 50 bits are random
    const randomHex = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 15);
    
    // Construct UUID7: timestamp (12) + version (1) + random (3) + variant (1) + random (12)
    const uuid7 = [
      timestampHex.substring(0, 8),
      timestampHex.substring(8, 12),
      version + randomHex.substring(0, 3),
      variant + randomHex.substring(3, 6),
      randomHex.substring(6, 18),
    ].join("-");
    
    return uuid7;
  }

  /**
   * Pull changes from a remote append-only store.
   * 
   * This method:
   * 1. Finds changes in the remote store that we don't have locally
   * 2. Retrieves those changes from the remote store
   * 3. Appends them to our local store
   * 4. Syncs the local store to process the new changes
   *
   * @param remoteStore The remote append-only store to pull changes from
   * @return A promise that resolves when the pull is complete
   */
  async pullChangesFrom(remoteStore: AppendOnlyStore): Promise<void> {
    if (this.store.getId() !== remoteStore.getId()) {
      throw new Error(`[BaseMindooDB] Cannot pull changes from the incompatible store ${this.store.getId()}`);
    }

    console.log(`[BaseMindooDB] Pulling changes from remote store ${remoteStore.getId()}`);
    
    // Get all change hashes we already have in our local store
    const localChangeHashes = await this.store.getAllChangeHashes();
    console.log(`[BaseMindooDB] Local store has ${localChangeHashes.length} change hashes`);
    
    // Find changes in the remote store that we don't have
    const newChangeHashes = await remoteStore.findNewChanges(localChangeHashes);
    console.log(`[BaseMindooDB] Found ${newChangeHashes.length} new changes in remote store`);
    
    if (newChangeHashes.length === 0) {
      console.log(`[BaseMindooDB] No new changes to pull`);
      return;
    }
    
    // Get the full changes from the remote store
    const newChanges = await remoteStore.getChanges(newChangeHashes);
    console.log(`[BaseMindooDB] Retrieved ${newChanges.length} changes from remote store`);
    
    // Append each change to our local store
    // The append method handles deduplication (no-op if change already exists)
    for (const change of newChanges) {
      await this.store.append(change);
    }
    
    console.log(`[BaseMindooDB] Appended ${newChanges.length} changes to local store`);
    
    // Sync the local store to process the new changes
    // This will update the index, cache, and processedChangeHashes
    await this.syncStoreChanges();
    
    console.log(`[BaseMindooDB] Pull complete, synced ${newChanges.length} changes`);
  }

  /**
   * Push changes to a remote append-only store.
   * 
   * This method:
   * 1. Finds changes in our local store that the remote doesn't have
   * 2. Retrieves those changes from our local store
   * 3. Appends them to the remote store
   *
   * @param remoteStore The remote append-only store to push changes to
   * @return A promise that resolves when the push is complete
   */
  async pushChangesTo(remoteStore: AppendOnlyStore): Promise<void> {
    if (this.store.getId() !== remoteStore.getId()) {
      throw new Error(`[BaseMindooDB] Cannot push changes to the incompatible store ${this.store.getId()}`);
    }

    console.log(`[BaseMindooDB] Pushing changes to remote store ${remoteStore.getId()}`);
    
    // Get all change hashes the remote store already has
    const remoteChangeHashes = await remoteStore.getAllChangeHashes();
    console.log(`[BaseMindooDB] Remote store has ${remoteChangeHashes.length} change hashes`);
    
    // Find changes in our local store that the remote doesn't have
    const newChangeHashes = await this.store.findNewChanges(remoteChangeHashes);
    console.log(`[BaseMindooDB] Found ${newChangeHashes.length} new changes to push`);
    
    if (newChangeHashes.length === 0) {
      console.log(`[BaseMindooDB] No new changes to push`);
      return;
    }
    
    // Get the full changes from our local store
    const newChanges = await this.store.getChanges(newChangeHashes);
    console.log(`[BaseMindooDB] Retrieved ${newChanges.length} changes from local store`);
    
    // Append each change to the remote store
    // The append method handles deduplication (no-op if change already exists)
    for (const change of newChanges) {
      await remoteStore.append(change);
    }
    
    console.log(`[BaseMindooDB] Pushed ${newChanges.length} changes to remote store`);
  }
}

