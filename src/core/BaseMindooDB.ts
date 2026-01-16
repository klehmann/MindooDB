import * as Automerge from "@automerge/automerge";
import { v7 as uuidv7 } from "uuid";
import {
  MindooDB,
  MindooDoc,
  MindooDocPayload,
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
  MindooTenant,
  ProcessChangesCursor,
  ProcessChangesResult,
} from "./types";
import type { ContentAddressedStore } from "./appendonlystores/types";
import { generateDocEntryId, computeContentHash, parseDocEntryId } from "./utils/idGeneration";

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
 * It receives MindooTenant and ContentAddressedStore in the constructor,
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
  private store: ContentAddressedStore;
  private attachmentStore: ContentAddressedStore | undefined;
  
  // Internal index: sorted array of document entries, maintained in order by (lastModified, docId)
  // This allows efficient incremental processing without sorting on each call
  private index: Array<{ docId: string; lastModified: number; isDeleted: boolean }> = [];
  
  // Lookup map for O(1) access to index entries by docId
  private indexLookup: Map<string, number> = new Map(); // Map<docId, arrayIndex>
  
  // Cache of loaded documents: Map<docId, InternalDoc>
  private docCache: Map<string, InternalDoc> = new Map();
  
  // Track which entry IDs we've already processed
  private processedEntryIds: string[] = [];
  
  // Index: automergeHash -> entryId for each document
  // Used for resolving Automerge dependency hashes to entry IDs
  private automergeHashToEntryId: Map<string, Map<string, string>> = new Map(); // Map<docId, Map<automergeHash, entryId>>

  constructor(tenant: MindooTenant, store: ContentAddressedStore, attachmentStore?: ContentAddressedStore) {
    this.tenant = tenant;
    this.store = store;
    this.attachmentStore = attachmentStore;
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
   * Register an automerge hash -> entry ID mapping for a document.
   * This is used to resolve Automerge dependency hashes to entry IDs.
   */
  private registerAutomergeHashMapping(docId: string, automergeHash: string, entryId: string): void {
    if (!this.automergeHashToEntryId.has(docId)) {
      this.automergeHashToEntryId.set(docId, new Map());
    }
    this.automergeHashToEntryId.get(docId)!.set(automergeHash, entryId);
  }

  /**
   * Get the entry ID for an automerge hash within a document.
   * Returns null if not found.
   */
  private getEntryIdForAutomergeHash(docId: string, automergeHash: string): string | null {
    const docIndex = this.automergeHashToEntryId.get(docId);
    if (docIndex) {
      return docIndex.get(automergeHash) || null;
    }
    return null;
  }

  /**
   * Resolve Automerge dependency hashes to entry IDs for a document.
   * Returns the entry IDs for the given automerge hashes.
   */
  private resolveAutomergeDepsToEntryIds(docId: string, automergeHashes: string[]): string[] {
    const entryIds: string[] = [];
    for (const hash of automergeHashes) {
      const entryId = this.getEntryIdForAutomergeHash(docId, hash);
      if (entryId) {
        entryIds.push(entryId);
      } else {
        console.warn(`[BaseMindooDB] Could not resolve automerge hash ${hash} to entry ID for doc ${docId}`);
      }
    }
    return entryIds;
  }

  /**
   * Get the SubtleCrypto instance from the tenant's crypto adapter.
   */
  private getSubtle(): SubtleCrypto {
    return this.tenant.getCryptoAdapter().getSubtle();
  }

  /**
   * Initialize the database instance.
   */
  async initialize(): Promise<void> {
    console.log(`[BaseMindooDB] Initializing database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    await this.syncStoreChanges();
  }

  /**
   * Sync changes from the content-addressed store by finding new entries and processing them.
   * This method can be called multiple times to incrementally sync new entries.
   * On first call (when processedEntryIds is empty), it will process all entries.
   */
  async syncStoreChanges(): Promise<void> {
    console.log(`[BaseMindooDB] Syncing store changes for database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    console.log(`[BaseMindooDB] Already processed ${this.processedEntryIds.length} entry IDs`);
    
    // Find new entries that we haven't processed yet
    const newEntryMetadata = await this.store.findNewEntries(this.processedEntryIds);
    console.log(`[BaseMindooDB] Found ${newEntryMetadata.length} new entries`);
    
    if (newEntryMetadata.length === 0) {
      console.log(`[BaseMindooDB] No new entries to process`);
      return;
    }
    
    // Group new entries by document ID
    const entriesByDoc = new Map<string, StoreEntryMetadata[]>();
    for (const entryMeta of newEntryMetadata) {
      if (!entriesByDoc.has(entryMeta.docId)) {
        entriesByDoc.set(entryMeta.docId, []);
      }
      entriesByDoc.get(entryMeta.docId)!.push(entryMeta);
    }
    
    // Process each document with new entries
    // Reload documents to apply all changes (including new ones)
    console.log(`[BaseMindooDB] Processing ${entriesByDoc.size} documents with new entries`);
    for (const [docId, entryMetadataList] of entriesByDoc) {
      try {
        console.log(`[BaseMindooDB] ===== Processing document ${docId} with ${entryMetadataList.length} new entry(s) in syncStoreChanges =====`);
        // Clear cache for this document so it gets reloaded with all entries
        this.docCache.delete(docId);
        console.log(`[BaseMindooDB] Cleared cache for document ${docId}`);
        
        // Reload document (this will load all entries including new ones)
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
    
    // Append new entry IDs to our processed list
    this.processedEntryIds.push(...newEntryMetadata.map(em => em.id));
    
    console.log(`[BaseMindooDB] Synced ${newEntryMetadata.length} new entries, index now has ${this.index.length} documents`);
  }

  getStore(): ContentAddressedStore {
    return this.store;
  }

  getAttachmentStore(): ContentAddressedStore | undefined {
    return this.attachmentStore;
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
    const docId = uuidv7();
    
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
    const automergeHash = decodedChange.hash;
    const automergeDepHashes: string[] = decodedChange.deps || []; // First change has no dependencies
    
    // Encrypt the change payload first
    console.log(`[BaseMindooDB] Encrypting change payload for document ${docId}`);
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, keyId);
    console.log(`[BaseMindooDB] Encrypted payload: ${changeBytes.length} -> ${encryptedPayload.length} bytes`);
    
    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());
    console.log(`[BaseMindooDB] Computed content hash: ${contentHash.substring(0, 16)}...`);
    
    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    console.log(`[BaseMindooDB] Generated entry ID: ${entryId}`);
    
    // Resolve Automerge dependency hashes to entry IDs (empty for first change)
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);
    
    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for E2E encryption: anyone can verify signatures without needing decryption keys
    console.log(`[BaseMindooDB] Signing encrypted payload for document ${docId}`);
    const signature = await this.tenant.signPayload(encryptedPayload);
    console.log(`[BaseMindooDB] Signed payload, signature length: ${signature.length} bytes`);

    // Create entry metadata
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_create",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: now,
      createdByPublicKey: currentUser.userSigningPublicKey,
      decryptionKeyId: keyId,
      signature,
      originalSize: changeBytes.length,
      encryptedSize: encryptedPayload.length,
    };
    
    // Create full entry object
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };
    
    // Store entry
    await this.store.putEntries([fullEntry]);
    
    // Register automerge hash -> entry ID mapping
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);
    
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
    
    // Get all entry metadata for this document
    const allEntryMetadata = await this.store.findNewEntriesForDoc([], docId);
    
    // Filter entries up to the timestamp
    const relevantEntries = allEntryMetadata
      .filter(em => em.createdAt <= timestamp)
      .sort((a, b) => a.createdAt - b.createdAt);
    
    if (relevantEntries.length === 0) {
      return null; // Document didn't exist at that time
    }
    
    // Load entries
    const entries = await this.store.getEntries(relevantEntries.map(em => em.id));
    
    // Apply changes in order
    let doc = Automerge.init<MindooDocPayload>();
    for (const entryData of entries) {
      // Verify signature against the encrypted payload (no decryption needed)
      // We sign the encrypted payload, so anyone can verify signatures without decryption keys
      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey
      );
      if (!isValid) {
        console.warn(`[BaseMindooDB] Invalid signature for entry ${entryData.id}, skipping`);
        continue;
      }
      
      // Decrypt payload (only after signature verification passes)
      const decryptedPayload = await this.tenant.decryptPayload(
        entryData.encryptedData,
        entryData.decryptionKeyId
      );

      // Apply change using loadIncremental - this is the recommended way for binary change data
      doc = Automerge.loadIncremental(doc, decryptedPayload);
      
      // Register the automerge hash -> entry ID mapping for future dependency resolution
      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
    }

    // Check if document was deleted at this timestamp
    // Look for a "doc_delete" type entry in the relevant entries
    const hasDeleteEntry = relevantEntries.some(em => em.entryType === "doc_delete" && em.createdAt <= timestamp);
    
    if (hasDeleteEntry) {
      return null; // Document was deleted at this time
    }
    
    // Find the first entry to get createdAt and decryptionKeyId
    const firstEntry = relevantEntries.length > 0 ? relevantEntries[0] : null;
    const createdAt = firstEntry ? firstEntry.createdAt : timestamp;
    const decryptionKeyId = firstEntry ? firstEntry.decryptionKeyId : "default";
    
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
    const automergeHash = decodedChange.hash;
    const automergeDepHashes = decodedChange.deps || []; // Dependencies from the decoded change

    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);

    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());

    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());

    // Resolve Automerge dependency hashes to entry IDs
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);

    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for E2E encryption: anyone can verify signatures without needing decryption keys
    const signature = await this.tenant.signPayload(encryptedPayload);

    // Create entry metadata with type "doc_delete" to mark this as a deletion entry in the store
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_delete",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: Date.now(),
      createdByPublicKey: currentUser.userSigningPublicKey,
      decryptionKeyId: internalDoc.decryptionKeyId,
      signature,
      originalSize: changeBytes.length,
      encryptedSize: encryptedPayload.length,
    };

    // Create full entry object
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };

    // Store entry
    await this.store.putEntries([fullEntry]);

    // Register automerge hash -> entry ID mapping
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);

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
    const automergeHash = decodedChange.hash;
    const automergeDepHashes = decodedChange.deps || []; // Dependencies from the decoded change

    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, internalDoc.decryptionKeyId);

    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());

    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    console.log(`[BaseMindooDB] Generated entry ID for change: ${entryId}`);

    // Resolve Automerge dependency hashes to entry IDs
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);

    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for E2E encryption: anyone can verify signatures without needing decryption keys
    const signature = await this.tenant.signPayload(encryptedPayload);

    // Create entry metadata
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_change",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: Date.now(),
      createdByPublicKey: currentUser.userSigningPublicKey,
      decryptionKeyId: internalDoc.decryptionKeyId,
      signature,
      originalSize: changeBytes.length,
      encryptedSize: encryptedPayload.length,
    };

    // Create full entry object
    const fullEntry: StoreEntry = {
      ...entryMetadata,
      encryptedData: encryptedPayload,
    };

    // Store entry
    await this.store.putEntries([fullEntry]);

    // Register automerge hash -> entry ID mapping
    this.registerAutomergeHashMapping(docId, automergeHash, entryId);

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
   * Internal method to load a document from the content-addressed store
   */
  private async loadDocumentInternal(docId: string): Promise<InternalDoc | null> {
    // Check cache first
    if (this.docCache.has(docId)) {
      console.log(`[BaseMindooDB] Document ${docId} found in cache, returning cached version`);
      return this.docCache.get(docId)!;
    }
    
    console.log(`[BaseMindooDB] ===== Starting to load document ${docId} from store =====`);
    
    // Get all entry metadata for this document
    // TODO: Implement loading from last snapshot if available
    console.log(`[BaseMindooDB] Getting all entry hashes for document ${docId}`);
    const allEntryMetadata = await this.store.findNewEntriesForDoc([], docId);
    console.log(`[BaseMindooDB] Found ${allEntryMetadata.length} total entry hashes for document ${docId}`);
    
    if (allEntryMetadata.length === 0) {
      console.log(`[BaseMindooDB] No entry hashes found for document ${docId}, returning null`);
      return null;
    }
    
    // Log all entry types
    const entryTypes = allEntryMetadata.map(em => `${em.entryType}@${em.createdAt}`).join(', ');
    console.log(`[BaseMindooDB] Entry types for ${docId}: ${entryTypes}`);
    
    // Find the most recent snapshot (if any)
    const snapshots = allEntryMetadata.filter(em => em.entryType === "doc_snapshot");
    console.log(`[BaseMindooDB] Found ${snapshots.length} snapshot(s) for document ${docId}`);
    let startFromSnapshot = false;
    let snapshotMeta: StoreEntryMetadata | null = null;
    
    if (snapshots.length > 0) {
      // Use the most recent snapshot
      snapshots.sort((a, b) => b.createdAt - a.createdAt);
      snapshotMeta = snapshots[0];
      startFromSnapshot = true;
      console.log(`[BaseMindooDB] Will start from snapshot ${snapshotMeta.id} created at ${snapshotMeta.createdAt}`);
    } else {
      console.log(`[BaseMindooDB] No snapshot found, will start from scratch`);
    }
    
    // Get all entries (excluding snapshot entries - we'll handle delete separately)
    // Include "doc_create", "doc_change", and "doc_delete" types as they all contain Automerge changes to apply
    const entriesToLoad = startFromSnapshot
      ? allEntryMetadata.filter(em => (em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete") && em.createdAt > snapshotMeta!.createdAt)
      : allEntryMetadata.filter(em => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete");
    console.log(`[BaseMindooDB] Will load ${entriesToLoad.length} entries for document ${docId} (after snapshot filter)`);
    
    // Load the snapshot first if we have one
    let doc: Automerge.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotMeta) {
      console.log(`[BaseMindooDB] Loading snapshot for document ${docId}`);
      const snapshotEntries = await this.store.getEntries([snapshotMeta.id]);
      console.log(`[BaseMindooDB] Retrieved ${snapshotEntries.length} snapshot entry(s) from store`);
      if (snapshotEntries.length > 0) {
        const snapshotData = snapshotEntries[0];
        
        // Verify signature against the encrypted snapshot (no decryption needed)
        // We sign the encrypted payload, so anyone can verify signatures without decryption keys
        const isValid = await this.tenant.verifySignature(
          snapshotData.encryptedData,
          snapshotData.signature,
          snapshotData.createdByPublicKey
        );
        if (!isValid) {
          console.warn(`[BaseMindooDB] Invalid signature for snapshot ${snapshotData.id}, falling back to loading from scratch`);
          // Fall back to loading from scratch
          startFromSnapshot = false;
        } else {
          console.log(`[BaseMindooDB] Snapshot signature valid, decrypting snapshot`);
          // Decrypt snapshot (only after signature verification passes)
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.encryptedData,
            snapshotData.decryptionKeyId
          );
          console.log(`[BaseMindooDB] Decrypted snapshot (${snapshotData.encryptedData.length} -> ${decryptedSnapshot.length} bytes)`);
          
          // Load snapshot using Automerge.load()
          // This deserializes a full document snapshot from binary data
          // According to Automerge docs: load() is equivalent to init() followed by loadIncremental()
          console.log(`[BaseMindooDB] Loading snapshot into Automerge document`);
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);
          console.log(`[BaseMindooDB] Successfully loaded snapshot, document heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
          
          // Register the snapshot's automerge hash -> entry ID mapping
          const parsed = parseDocEntryId(snapshotData.id);
          if (parsed) {
            this.registerAutomergeHashMapping(docId, parsed.automergeHash, snapshotData.id);
          }
        }
      }
    }

    // If we don't have a snapshot, start from scratch
    if (!doc) {
      console.log(`[BaseMindooDB] Initializing new Automerge document for ${docId}`);
      doc = Automerge.init<MindooDocPayload>();
      console.log(`[BaseMindooDB] Initialized empty document, heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
    }
    
    // Sort entries by timestamp
    entriesToLoad.sort((a, b) => a.createdAt - b.createdAt);
    console.log(`[BaseMindooDB] Sorted ${entriesToLoad.length} entries by timestamp for document ${docId}`);
    
    // Load and apply all entries
    console.log(`[BaseMindooDB] Fetching ${entriesToLoad.length} entries from store for document ${docId}`);
    const entries = await this.store.getEntries(entriesToLoad.map(em => em.id));
    console.log(`[BaseMindooDB] Retrieved ${entries.length} entries from store for document ${docId}`);
    console.log(`[BaseMindooDB] Loading document ${docId}: found ${entries.length} entries to apply (${startFromSnapshot ? 'starting from snapshot' : 'starting from scratch'})`);
    
    // Log current document state before applying entries
    console.log(`[BaseMindooDB] Document state before applying entries: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
    
    // Verify signatures, decrypt, and apply entries one at a time
    // This ensures dependencies are handled correctly by Automerge
    for (let i = 0; i < entries.length; i++) {
      const entryData = entries[i];
      console.log(`[BaseMindooDB] ===== Processing entry ${i + 1}/${entries.length} for document ${docId} =====`);
      console.log(`[BaseMindooDB] Entry id: ${entryData.id}`);
      console.log(`[BaseMindooDB] Entry type: ${entryData.entryType}`);
      console.log(`[BaseMindooDB] Entry createdAt: ${entryData.createdAt}`);
      console.log(`[BaseMindooDB] Entry dependencies: ${JSON.stringify(entryData.dependencyIds || [])}`);
      console.log(`[BaseMindooDB] Entry payload size: ${entryData.encryptedData.length} bytes`);
      // Verify signature against the encrypted payload (no decryption needed)
      // We sign the encrypted payload, so anyone can verify signatures without decryption keys
      console.log(`[BaseMindooDB] Verifying signature for entry ${entryData.id}`);
      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey
      );
      if (!isValid) {
        console.warn(`[BaseMindooDB] Invalid signature for entry ${entryData.id}, skipping`);
        continue;
      }
      console.log(`[BaseMindooDB] Signature valid for entry ${entryData.id}`);
      
      // Decrypt payload (only after signature verification passes)
      console.log(`[BaseMindooDB] Decrypting payload for entry ${entryData.id} with key ${entryData.decryptionKeyId}`);
      const decryptedPayload = await this.tenant.decryptPayload(
        entryData.encryptedData,
        entryData.decryptionKeyId
      );
      console.log(`[BaseMindooDB] Decrypted payload: ${entryData.encryptedData.length} -> ${decryptedPayload.length} bytes`);
      
      // Apply change using applyChanges with raw change bytes
      // applyChanges expects an array of Uint8Array (raw change bytes)
      try {
        console.log(`[BaseMindooDB] Document state before applying entry ${i + 1}: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
        console.log(`[BaseMindooDB] Calling Automerge.applyChanges for entry ${i + 1}/${entries.length} on document ${docId}`);
        console.log(`[BaseMindooDB] Decrypted payload length: ${decryptedPayload.length} bytes`);
        const currentDoc: Automerge.Doc<MindooDocPayload> = doc!;
        const result = Automerge.applyChanges<MindooDocPayload>(currentDoc, [decryptedPayload]);
        doc = result[0] as Automerge.Doc<MindooDocPayload>;
        console.log(`[BaseMindooDB] Successfully applied entry ${i + 1}/${entries.length}`);
        console.log(`[BaseMindooDB] Document state after applying entry ${i + 1}: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
        
        // Register the automerge hash -> entry ID mapping for future dependency resolution
        const parsed = parseDocEntryId(entryData.id);
        if (parsed) {
          this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
        }
      } catch (error) {
        console.error(`[BaseMindooDB] Error applying entry ${entryData.id} to document ${docId}:`, error);
        console.error(`[BaseMindooDB] Entry index: ${i + 1}/${entries.length}`);
        console.error(`[BaseMindooDB] Entry dependencies:`, entryData.dependencyIds);
        console.error(`[BaseMindooDB] Entry type:`, entryData.entryType);
        console.error(`[BaseMindooDB] Entry createdAt:`, entryData.createdAt);
        console.error(`[BaseMindooDB] Document state before entry:`, {
          hasDoc: !!doc,
          docHeads: doc ? Automerge.getHeads(doc) : null,
        });
        // Log previous entry for debugging dependency issues
        if (i > 0) {
          const prevEntry = entries[i - 1];
          console.error(`[BaseMindooDB] Previous entry:`, {
            id: prevEntry.id,
            deps: prevEntry.dependencyIds,
            type: prevEntry.entryType,
          });
        }
        throw error;
      }
    }
    
    // Extract metadata from document (doc is guaranteed to be defined at this point)
    console.log(`[BaseMindooDB] All entries applied successfully for document ${docId}`);
    console.log(`[BaseMindooDB] Final document heads: ${JSON.stringify(Automerge.getHeads(doc!))}`);
    const payload = doc! as unknown as MindooDocPayload;
    
    // Check if document was deleted by looking for a "doc_delete" type entry
    const hasDeleteEntry = allEntryMetadata.some(em => em.entryType === "doc_delete");
    const isDeleted = hasDeleteEntry;
    console.log(`[BaseMindooDB] Document ${docId} isDeleted: ${isDeleted}`);
    
    const decryptionKeyId = (payload._decryptionKeyId as string) || "default";
    // Get lastModified from payload, or use the timestamp of the last entry
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastModified = (payload._lastModified as number) || 
                         (lastEntry ? lastEntry.createdAt : Date.now());
    // Get createdAt from the first entry
    const firstEntry = allEntryMetadata.length > 0 ? allEntryMetadata[0] : null;
    const createdAt = firstEntry ? firstEntry.createdAt : lastModified;
    
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
   * Pull changes from a remote content-addressed store.
   * 
   * This method:
   * 1. Finds entries in the remote store that we don't have locally
   * 2. Retrieves those entries from the remote store
   * 3. Stores them in our local store
   * 4. Syncs the local store to process the new entries
   *
   * @param remoteStore The remote store to pull entries from
   * @return A promise that resolves when the pull is complete
   */
  async pullChangesFrom(remoteStore: ContentAddressedStore): Promise<void> {
    if (this.store.getId() !== remoteStore.getId()) {
      throw new Error(`[BaseMindooDB] Cannot pull entries from the incompatible store ${this.store.getId()}`);
    }

    console.log(`[BaseMindooDB] Pulling entries from remote store ${remoteStore.getId()}`);
    
    // Get all entry IDs we already have in our local store
    const localEntryIds = await this.store.getAllIds();
    console.log(`[BaseMindooDB] Local store has ${localEntryIds.length} entry IDs`);
    
    // Find entries in the remote store that we don't have
    const newEntryMetadata = await remoteStore.findNewEntries(localEntryIds);
    console.log(`[BaseMindooDB] Found ${newEntryMetadata.length} new entries in remote store`);
    
    if (newEntryMetadata.length === 0) {
      console.log(`[BaseMindooDB] No new entries to pull`);
      return;
    }
    
    // Get the full entries from the remote store
    const newEntries = await remoteStore.getEntries(newEntryMetadata.map(em => em.id));
    console.log(`[BaseMindooDB] Retrieved ${newEntries.length} entries from remote store`);
    
    // Store all entries in our local store
    // The putEntries method handles deduplication (no-op if entry already exists)
    await this.store.putEntries(newEntries);
    
    console.log(`[BaseMindooDB] Stored ${newEntries.length} entries in local store`);
    
    // Sync the local store to process the new entries
    // This will update the index, cache, and processedEntryIds
    await this.syncStoreChanges();
    
    console.log(`[BaseMindooDB] Pull complete, synced ${newEntries.length} entries`);
  }

  /**
   * Push changes to a remote content-addressed store.
   * 
   * This method:
   * 1. Finds entries in our local store that the remote doesn't have
   * 2. Retrieves those entries from our local store
   * 3. Stores them in the remote store
   *
   * @param remoteStore The remote store to push entries to
   * @return A promise that resolves when the push is complete
   */
  async pushChangesTo(remoteStore: ContentAddressedStore): Promise<void> {
    if (this.store.getId() !== remoteStore.getId()) {
      throw new Error(`[BaseMindooDB] Cannot push entries to the incompatible store ${this.store.getId()}`);
    }

    console.log(`[BaseMindooDB] Pushing entries to remote store ${remoteStore.getId()}`);
    
    // Get all entry IDs the remote store already has
    const remoteEntryIds = await remoteStore.getAllIds();
    console.log(`[BaseMindooDB] Remote store has ${remoteEntryIds.length} entry IDs`);
    
    // Find entries in our local store that the remote doesn't have
    const newEntryMetadata = await this.store.findNewEntries(remoteEntryIds);
    console.log(`[BaseMindooDB] Found ${newEntryMetadata.length} new entries to push`);
    
    if (newEntryMetadata.length === 0) {
      console.log(`[BaseMindooDB] No new entries to push`);
      return;
    }
    
    // Get the full entries from our local store
    const newEntries = await this.store.getEntries(newEntryMetadata.map(em => em.id));
    console.log(`[BaseMindooDB] Retrieved ${newEntries.length} entries from local store`);
    
    // Store all entries in the remote store
    // The putEntries method handles deduplication (no-op if entry already exists)
    await remoteStore.putEntries(newEntries);
    
    console.log(`[BaseMindooDB] Pushed ${newEntries.length} entries to remote store`);
  }
}

