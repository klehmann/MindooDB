import * as Automerge from "@automerge/automerge";
import {
  MindooDB,
  MindooDoc,
  MindooDocPayload,
  MindooDocChange,
  MindooDocChangeHashes,
  MindooTenant,
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
  
  // Internal index: Map<docId, { lastModified: number, isDeleted: boolean }>
  private index: Map<string, { lastModified: number; isDeleted: boolean }> = new Map();
  
  // Cache of loaded documents: Map<docId, InternalDoc>
  private docCache: Map<string, InternalDoc> = new Map();
  
  // Track which change hashes we've already processed
  private processedChangeHashes: MindooDocChangeHashes[] = [];
  
  // Monotonic counter for UUID7 generation (ensures uniqueness within same millisecond)
  private uuid7Counter: number = 0;
  private uuid7LastTimestamp: number = 0;

  constructor(tenant: MindooTenant, store: AppendOnlyStore) {
    this.tenant = tenant;
    this.store = store;
  }

  /**
   * Initialize the database by rebuilding the index from the append-only store.
   * This should be called after construction to load existing documents.
   * 
   * @deprecated Use syncStoreChanges() instead. This method is kept for backward compatibility.
   */
  async initialize(): Promise<void> {
    console.log(`[BaseMindooDB] Initializing database ${this.id}`);
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
    for (const [docId, changeHashes] of changesByDoc) {
      try {
        // Clear cache for this document so it gets reloaded with all changes
        this.docCache.delete(docId);
        
        // Reload document (this will load all changes including new ones)
        const doc = await this.loadDocumentInternal(docId);
        if (doc) {
          this.index.set(docId, {
            lastModified: doc.lastModified,
            isDeleted: doc.isDeleted,
          });
        }
      } catch (error) {
        console.error(`[BaseMindooDB] Error processing document ${docId}:`, error);
        // Continue with other documents even if one fails
      }
    }
    
    // Append new change hashes to our processed list
    this.processedChangeHashes.push(...newChangeHashes);
    
    console.log(`[BaseMindooDB] Synced ${newChangeHashes.length} new changes, index now has ${this.index.size} documents`);
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
    const newDoc = Automerge.change(initialDoc, (doc: MindooDocPayload) => {
      // Store metadata in the document payload
      /*
      doc._docId = docId;
      doc._decryptionKeyId = keyId;
      doc._createdAt = now;
      doc._lastModified = now;
      doc._deleted = false;
      */
    });
    
    // Get the change bytes from the document
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    
    // Decode the change to get hash and dependencies
    const decodedChange = Automerge.decodeChange(changeBytes);
    const changeHash = decodedChange.hash;
    const depsHashes: string[] = decodedChange.deps || []; // First change has no dependencies
    
    // Encrypt the change payload first
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, keyId);
    
    // Sign the encrypted payload (this allows signature verification without decryption)
    // This is important for zero-trust: anyone can verify signatures without needing decryption keys
    const signature = await this.tenant.signPayload(encryptedPayload);

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
    this.index.set(docId, {
      lastModified: internalDoc.lastModified,
      isDeleted: false,
    });
    
    console.log(`[BaseMindooDB] Document ${docId} created successfully`);
    
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
    const allChangeHashes = await this.store.getAllChangeHashesForDoc(docId, false);
    
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
      const isValid = await this.verifySignature(
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
      
      // Apply change
      // Note: applyChanges may return an array or single doc depending on Automerge version
      const result = Automerge.applyChanges(doc, [decryptedPayload]);
      doc = Array.isArray(result) ? result[0] : result;
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
    for (const [docId, info] of this.index) {
      if (!info.isDeleted) {
        docIds.push(docId);
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
    // This is important for zero-trust: anyone can verify signatures without needing decryption keys
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
    this.index.set(docId, {
      lastModified: internalDoc.lastModified,
      isDeleted: true,
    });
    
    console.log(`[BaseMindooDB] Document ${docId} deleted successfully`);
  }

  async changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void
  ): Promise<void> {
    const docId = doc.getId();
    console.log(`[BaseMindooDB] Changing document ${docId}`);
    
    // Get internal document from cache or load it
    let internalDoc = this.docCache.get(docId);
    if (!internalDoc) {
      const loadedDoc = await this.loadDocumentInternal(docId);
      if (!loadedDoc) {
        throw new Error(`Document ${docId} not found`);
      }
      internalDoc = loadedDoc;
    }
    
    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }
    
    // Get current user for signing
    const currentUser = await this.tenant.getCurrentUserId();
    
    // Apply the change function
    const now = Date.now();
    const newDoc = Automerge.change(internalDoc.doc, (automergeDoc: MindooDocPayload) => {
      // Wrap the Automerge doc in a MindooDoc interface for the change function
      const wrappedDoc = this.wrapDocument({
        id: docId,
        doc: automergeDoc as Automerge.Doc<MindooDocPayload>,
        createdAt: internalDoc.createdAt,
        lastModified: internalDoc.lastModified,
        decryptionKeyId: internalDoc.decryptionKeyId,
        isDeleted: false,
      });
      
      changeFunc(wrappedDoc);
      
      // Update lastModified timestamp
      automergeDoc._lastModified = now;
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
    // This is important for zero-trust: anyone can verify signatures without needing decryption keys
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
    this.index.set(docId, {
      lastModified: internalDoc.lastModified,
      isDeleted: internalDoc.isDeleted,
    });
    
    console.log(`[BaseMindooDB] Document ${docId} changed successfully`);
  }

  async processChangesSince(
    timestamp: number,
    limit: number,
    callback: (change: MindooDoc) => void
  ): Promise<number> {
    console.log(`[BaseMindooDB] Processing changes since ${timestamp} (limit: ${limit})`);
    
    // Get all documents from index that changed after timestamp
    const changedDocs: Array<{ docId: string; lastModified: number }> = [];
    for (const [docId, info] of this.index) {
      if (info.lastModified > timestamp && !info.isDeleted) {
        changedDocs.push({ docId, lastModified: info.lastModified });
      }
    }
    
    // Sort by lastModified (oldest first)
    changedDocs.sort((a, b) => a.lastModified - b.lastModified);
    
    // Process up to limit documents
    let lastTimestamp = timestamp;
    const toProcess = changedDocs.slice(0, limit);
    
    for (const { docId, lastModified } of toProcess) {
      try {
        const doc = await this.getDocument(docId);
        callback(doc);
        lastTimestamp = Math.max(lastTimestamp, lastModified);
      } catch (error) {
        console.error(`[BaseMindooDB] Error processing document ${docId}:`, error);
        // Continue with other documents
      }
    }
    
    console.log(`[BaseMindooDB] Processed ${toProcess.length} changes, last timestamp: ${lastTimestamp}`);
    return lastTimestamp;
  }

  /**
   * Internal method to load a document from the append-only store
   */
  private async loadDocumentInternal(docId: string): Promise<InternalDoc | null> {
    // Check cache first
    if (this.docCache.has(docId)) {
      return this.docCache.get(docId)!;
    }
    
    console.log(`[BaseMindooDB] Loading document ${docId} from store`);
    
    // Get all change hashes for this document (from last snapshot if available)
    const allChangeHashes = await this.store.getAllChangeHashesForDoc(docId, true);
    
    if (allChangeHashes.length === 0) {
      return null;
    }
    
    // Find the most recent snapshot (if any)
    const snapshots = allChangeHashes.filter(ch => ch.type === "snapshot");
    let startFromSnapshot = false;
    let snapshotHash: MindooDocChangeHashes | null = null;
    
    if (snapshots.length > 0) {
      // Use the most recent snapshot
      snapshots.sort((a, b) => b.createdAt - a.createdAt);
      snapshotHash = snapshots[0];
      startFromSnapshot = true;
    }
    
    // Get all changes (excluding snapshot and delete entries - we'll handle delete separately)
    // Include both "change" and "delete" types as they both contain Automerge changes to apply
    const changesToLoad = startFromSnapshot
      ? allChangeHashes.filter(ch => (ch.type === "change" || ch.type === "delete") && ch.createdAt > snapshotHash!.createdAt)
      : allChangeHashes.filter(ch => ch.type === "change" || ch.type === "delete");
    
    // Load the snapshot first if we have one
    let doc: Automerge.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotHash) {
      const snapshotChanges = await this.store.getChanges([snapshotHash]);
      if (snapshotChanges.length > 0) {
        const snapshotData = snapshotChanges[0];
        
        // Verify signature against the encrypted snapshot (no decryption needed)
        // We sign the encrypted payload, so anyone can verify signatures without decryption keys
        const isValid = await this.verifySignature(
          snapshotData.payload,
          snapshotData.signature,
          snapshotData.createdByPublicKey
        );
        if (!isValid) {
          console.warn(`[BaseMindooDB] Invalid signature for snapshot ${snapshotData.changeHash}`);
          // Fall back to loading from scratch
          startFromSnapshot = false;
        } else {
          // Decrypt snapshot (only after signature verification passes)
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.payload,
            snapshotData.decryptionKeyId
          );
          
          // Load snapshot using Automerge.load()
          // This deserializes a full document snapshot from binary data
          // According to Automerge docs: load() is equivalent to init() followed by loadIncremental()
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);
        }
      }
    }
    
    // If we don't have a snapshot, start from scratch
    if (!doc) {
      doc = Automerge.init<MindooDocPayload>();
    }
    
    // Sort changes by timestamp
    changesToLoad.sort((a, b) => a.createdAt - b.createdAt);
    
    // Load and apply all changes
    const changes = await this.store.getChanges(changesToLoad);
    
    for (const changeData of changes) {
      // Verify signature against the encrypted payload (no decryption needed)
      // We sign the encrypted payload, so anyone can verify signatures without decryption keys
      const isValid = await this.verifySignature(
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
      
      // Apply change
      // Note: applyChanges may return an array or single doc depending on Automerge version
      const result = Automerge.applyChanges(doc!, [decryptedPayload]);
      doc = Array.isArray(result) ? result[0] : result;
    }
    
    // Extract metadata from document (doc is guaranteed to be defined at this point)
    const payload = doc! as unknown as MindooDocPayload;
    
    // Check if document was deleted by looking for a "delete" type entry
    const hasDeleteEntry = allChangeHashes.some(ch => ch.type === "delete");
    const isDeleted = hasDeleteEntry;
    
    const decryptionKeyId = (payload._decryptionKeyId as string) || "default";
    // Get lastModified from payload, or use the timestamp of the last change
    const lastChange = changes.length > 0 ? changes[changes.length - 1] : null;
    const lastModified = (payload._lastModified as number) || 
                         (lastChange ? lastChange.createdAt : Date.now());
    // Get createdAt from the first change
    const firstChange = allChangeHashes.length > 0 ? allChangeHashes[0] : null;
    const createdAt = firstChange ? firstChange.createdAt : lastModified;
    
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
    
    return internalDoc;
  }

  /**
   * Verify the signature of a change
   * 
   * @param payload The payload that was signed (the Automerge change bytes)
   * @param signature The signature to verify (Ed25519 signature)
   * @param publicKey The public key to verify against (Ed25519, PEM format)
   * @return True if the signature is valid, false otherwise
   */
  private async verifySignature(
    payload: Uint8Array,
    signature: Uint8Array,
    publicKey: string
  ): Promise<boolean> {
    // First, validate that the public key belongs to a trusted user
    const isTrusted = await this.tenant.validatePublicSigningKey(publicKey);
    if (!isTrusted) {
      console.warn(`[BaseMindooDB] Public key not trusted: ${publicKey}`);
      return false;
    }
    
    // TODO: Implement Ed25519 signature verification using Web Crypto API
    // For now, we trust the key validation
    // In a full implementation, we would:
    // 1. Import the public key from PEM format
    // 2. Verify the signature against the payload using Ed25519
    // 3. Return the verification result
    // This requires platform-specific crypto implementations using Web Crypto API
    // Example (pseudo-code):
    //   const key = await crypto.subtle.importKey(...);
    //   const isValid = await crypto.subtle.verify('Ed25519', key, signature, payload);
    //   return isValid;
    
    // For now, we only verify that the key is trusted
    // Full cryptographic verification should be implemented in platform-specific code
    return true;
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

