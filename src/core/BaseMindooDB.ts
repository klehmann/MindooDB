// Import platform-appropriate Automerge implementation
// React Native: native Rust (react-native-automerge-generated)
// Browser/Node.js: WASM (@automerge/automerge/slim)
import { Automerge } from "./automerge-adapter";
// Import types from WASM package (types are compatible across implementations)
import type * as AutomergeTypes from "@automerge/automerge/slim";
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
  DocumentHistoryResult,
  AttachmentReference,
  AttachmentConfig,
  SigningKeyPair,
  PerformanceCallback,
} from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";
import type {
  ContentAddressedStore,
  StoreScanCursor,
  StoreScanFilters,
  StoreIdBloomSummary,
} from "./appendonlystores/types";
import { bloomMightContainId } from "./appendonlystores/bloom";
import { 
  generateDocEntryId, 
  computeContentHash, 
  parseDocEntryId,
  generateAttachmentChunkId,
  generateFileUuid7,
} from "./utils/idGeneration";
import { SymmetricKeyNotFoundError } from "./errors";
import { Logger, MindooLogger, getDefaultLogLevel } from "./logging";

/**
 * Default chunk size for attachments: 256KB
 */
const DEFAULT_CHUNK_SIZE_BYTES = 256 * 1024;

/**
 * Internal representation of a document with its Automerge state
 */
interface InternalDoc {
  id: string;
  doc: AutomergeTypes.Doc<MindooDocPayload>;
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
  private tenant: BaseMindooTenant;
  private store: ContentAddressedStore;
  private attachmentStore: ContentAddressedStore | undefined;
  private chunkSizeBytes: number;
  
  // Admin-only mode: only entries signed by the admin key are loaded
  private _isAdminOnlyDb: boolean;
  
  // Internal index: sorted array of document entries, maintained in order by (lastModified, docId)
  // This allows efficient incremental processing without sorting on each call
  private index: Array<{ docId: string; lastModified: number; isDeleted: boolean }> = [];
  
  // Lookup map for O(1) access to index entries by docId
  private indexLookup: Map<string, number> = new Map(); // Map<docId, arrayIndex>
  
  // Cache of loaded documents: Map<docId, InternalDoc>
  private docCache: Map<string, InternalDoc> = new Map();
  
  // Track which entry IDs we've already processed
  private processedEntryIds: string[] = [];
  private processedEntryCursor: StoreScanCursor | null = null;
  
  // Index: automergeHash -> entryId for each document
  // Used for resolving Automerge dependency hashes to entry IDs
  private automergeHashToEntryId: Map<string, Map<string, string>> = new Map(); // Map<docId, Map<automergeHash, entryId>>
  private logger: Logger;
  private performanceCallback?: PerformanceCallback;
  
  // Cache for imported public keys (CryptoKey objects) to avoid re-importing the same key
  // Map<publicKeyPEM, CryptoKey>
  private publicKeyCache: Map<string, CryptoKey> = new Map();

  constructor(
    tenant: BaseMindooTenant, 
    store: ContentAddressedStore, 
    attachmentStore?: ContentAddressedStore,
    attachmentConfig?: AttachmentConfig,
    adminOnlyDb: boolean = false,
    logger?: Logger,
    performanceCallback?: PerformanceCallback
  ) {
    this.tenant = tenant;
    this.store = store;
    this.attachmentStore = attachmentStore;
    this.chunkSizeBytes = attachmentConfig?.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    this._isAdminOnlyDb = adminOnlyDb;
    // Create logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "BaseMindooDB", true);
    this.performanceCallback = performanceCallback;
  }
  
  /**
   * Get the admin public key from the tenant.
   * Only used when adminOnlyDb is true.
   */
  private getAdminPublicKey(): string {
    return this.tenant.getAdministrationPublicKey();
  }
  
  isAdminOnlyDb(): boolean {
    return this._isAdminOnlyDb;
  }

  /**
   * Get or import a CryptoKey for signature verification, with caching.
   * This avoids re-importing the same public key multiple times.
   */
  private async getOrImportPublicKey(publicKey: string): Promise<CryptoKey | null> {
    // Check cache first
    if (this.publicKeyCache.has(publicKey)) {
      return this.publicKeyCache.get(publicKey)!;
    }

    // Validate the public key is trusted
    const directory = await this.tenant.openDirectory();
    const isTrusted = await directory.validatePublicSigningKey(publicKey);
    if (!isTrusted) {
      this.logger.warn(`Public key not trusted: ${publicKey}`);
      return null;
    }

    // Import the key
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const publicKeyBuffer = this.tenant.pemToArrayBuffer(publicKey);
    
    const cryptoKey = await subtle.importKey(
      "spki",
      publicKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["verify"]
    );

    // Cache the imported key
    this.publicKeyCache.set(publicKey, cryptoKey);
    return cryptoKey;
  }

  /**
   * Verify a signature using a pre-imported CryptoKey.
   * This bypasses the key import step for better performance when keys are cached.
   */
  private async verifySignatureWithKey(
    cryptoKey: CryptoKey,
    payload: Uint8Array,
    signature: Uint8Array
  ): Promise<boolean> {
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    
    const isValid = await subtle.verify(
      {
        name: "Ed25519",
      },
      cryptoKey,
      signature.buffer as ArrayBuffer,
      payload.buffer as ArrayBuffer
    );

    return isValid;
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
   * Optimized to only update lookup map for entries that actually moved.
   * 
   * @param docId The document ID
   * @param lastModified The new last modified timestamp
   * @param isDeleted Whether the document is deleted
   */
  private updateIndex(docId: string, lastModified: number, isDeleted: boolean): void {
    const newEntry = { docId, lastModified, isDeleted };
    const existingIndex = this.indexLookup.get(docId);
    
    // Check if the entry already exists and hasn't changed position
    if (existingIndex !== undefined) {
      const existingEntry = this.index[existingIndex];
      // If position hasn't changed (same lastModified and docId), no update needed
      if (existingEntry.lastModified === lastModified && existingEntry.isDeleted === isDeleted) {
        return; // No change needed
      }
      
      // Remove from current position
      this.index.splice(existingIndex, 1);
      
      // Update lookup map for entries that moved (only those after the removed position)
      // We'll update the full range after insertion to be safe
      const minAffectedIndex = Math.min(existingIndex, this.index.length);
      for (let i = minAffectedIndex; i < this.index.length; i++) {
        this.indexLookup.set(this.index[i].docId, i);
      }
      this.indexLookup.delete(docId);
    }
    
    // Find insertion point using binary search to maintain sorted order
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
    
    // Update lookup map for entries from insertion point onwards
    // Only update entries that actually moved (from insertIndex to end)
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
        this.logger.warn(`Could not resolve automerge hash ${hash} to entry ID for doc ${docId}`);
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
    this.logger.info(`Initializing database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    await this.syncStoreChanges();
  }

  /**
   * Sync changes from the content-addressed store by finding new entries and processing them.
   * This method can be called multiple times to incrementally sync new entries.
   * On first call (when processedEntryIds is empty), it will process all entries.
   */
  async syncStoreChanges(): Promise<void> {
    this.logger.debug(`Syncing store changes for database ${this.store.getId()} in tenant ${this.tenant.getId()}`);
    this.logger.debug(`Already processed ${this.processedEntryIds.length} entry IDs`);
    
    // Find new entries that we haven't processed yet
    const newEntryMetadata = await this.getNewEntryMetadataForSync();
    this.logger.debug(`Found ${newEntryMetadata.length} new entries`);
    
    if (newEntryMetadata.length === 0) {
      this.logger.debug(`No new entries to process`);
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
    // Use incremental cache updates when possible
    // Process documents in parallel with concurrency limit
    this.logger.debug(`Processing ${entriesByDoc.size} documents with new entries`);
    
    // Helper function to process a single document
    const processDocument = async (docId: string, entryMetadataList: StoreEntryMetadata[]): Promise<void> => {
      try {
        this.logger.debug(`===== Processing document ${docId} with ${entryMetadataList.length} new entry(s) in syncStoreChanges =====`);
        
        // Check if document is cached
        const cachedDoc = this.docCache.get(docId);
        
        let updatedDoc: InternalDoc | null = null;
        
        if (cachedDoc) {
          // Document is cached - try incremental update
          this.logger.debug(`Document ${docId} found in cache, attempting incremental update`);
          try {
            updatedDoc = await this.applyNewEntriesToCachedDocument(cachedDoc, entryMetadataList);
            if (updatedDoc) {
              this.logger.debug(`Successfully updated cached document ${docId} incrementally`);
              // Only update index if document actually changed
              this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted);
              this.logger.debug(`Updated index for document ${docId} (lastModified: ${updatedDoc.lastModified}, isDeleted: ${updatedDoc.isDeleted})`);
            } else {
              this.logger.debug(`Document ${docId} unchanged after applying new entries, skipping index update`);
            }
          } catch (error) {
            // If incremental update fails, fall back to full reload
            this.logger.warn(`Incremental update failed for document ${docId}, falling back to full reload:`, error);
            this.docCache.delete(docId);
            updatedDoc = await this.loadDocumentInternal(docId);
            if (updatedDoc) {
              this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted);
            }
          }
        } else {
          // Document not cached - load from scratch
          this.logger.debug(`Document ${docId} not in cache, loading from store`);
          updatedDoc = await this.loadDocumentInternal(docId);
          if (updatedDoc) {
            this.logger.debug(`Successfully loaded document ${docId}, updating index`);
            this.updateIndex(docId, updatedDoc.lastModified, updatedDoc.isDeleted);
            this.logger.debug(`Updated index for document ${docId} (lastModified: ${updatedDoc.lastModified}, isDeleted: ${updatedDoc.isDeleted})`);
          } else {
            this.logger.warn(`Document ${docId} returned null from loadDocumentInternal`);
          }
        }
      } catch (error) {
        // Handle missing symmetric key gracefully - skip documents we can't decrypt
        if (error instanceof SymmetricKeyNotFoundError) {
          this.logger.debug(`Skipping document ${docId} - missing key: ${error.keyId}`);
          // Mark entry IDs as processed so we don't retry them
          this.processedEntryIds.push(...entryMetadataList.map(em => em.id));
          return; // Skip this document
        }
        
        this.logger.error(`===== ERROR processing document ${docId} in syncStoreChanges =====`, error);
        // Re-throw the error so we can see what's happening in the test
        throw error;
      }
    };
    
    // Process documents in parallel with concurrency limit (default: 10)
    const maxConcurrency = 10;
    const documentEntries = Array.from(entriesByDoc.entries());
    
    // Process in batches to limit concurrency
    const results: PromiseSettledResult<void>[] = [];
    for (let i = 0; i < documentEntries.length; i += maxConcurrency) {
      const batch = documentEntries.slice(i, i + maxConcurrency);
      const batchResults = await Promise.allSettled(
        batch.map(([docId, entryMetadataList]) => processDocument(docId, entryMetadataList))
      );
      results.push(...batchResults);
    }
    
    // Check for errors (excluding SymmetricKeyNotFoundError which is handled gracefully)
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const error = result.reason;
        if (!(error instanceof SymmetricKeyNotFoundError)) {
          // Re-throw non-key errors
          throw error;
        }
      }
    }
    
    // Append new entry IDs to our processed list
    this.processedEntryIds.push(...newEntryMetadata.map(em => em.id));
    
    this.logger.debug(`Synced ${newEntryMetadata.length} new entries, index now has ${this.index.length} documents`);
  }

  private supportsCursorScan(store: ContentAddressedStore): boolean {
    return typeof store.scanEntriesSince === "function";
  }

  private async scanAllMetadata(
    store: ContentAddressedStore,
    filters?: StoreScanFilters
  ): Promise<StoreEntryMetadata[]> {
    if (!this.supportsCursorScan(store)) {
      if (filters?.docId) {
        return store.findNewEntriesForDoc([], filters.docId);
      }
      return store.findNewEntries([]);
    }

    const all: StoreEntryMetadata[] = [];
    let cursor: StoreScanCursor | null = null;

    while (true) {
      const page = await store.scanEntriesSince!(cursor, 1000, filters);
      all.push(...page.entries);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    return all;
  }

  private async getNewEntryMetadataForSync(): Promise<StoreEntryMetadata[]> {
    if (!this.supportsCursorScan(this.store)) {
      return this.store.findNewEntries(this.processedEntryIds);
    }

    const allNew: StoreEntryMetadata[] = [];
    let cursor = this.processedEntryCursor;

    while (true) {
      const page = await this.store.scanEntriesSince!(cursor, 1000);
      allNew.push(...page.entries);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    this.processedEntryCursor = cursor;
    return allNew;
  }

  private async syncEntriesFromStore(
    sourceStore: ContentAddressedStore,
    targetStore: ContentAddressedStore
  ): Promise<number> {
    let transferred = 0;
    let targetBloom: StoreIdBloomSummary | null = null;
    if (typeof targetStore.getIdBloomSummary === "function") {
      try {
        targetBloom = await targetStore.getIdBloomSummary();
      } catch (error) {
        this.logger.warn("Failed to get bloom summary from target store, falling back to exact checks", error);
      }
    }

    if (this.supportsCursorScan(sourceStore)) {
      let cursor: StoreScanCursor | null = null;
      while (true) {
        const page = await sourceStore.scanEntriesSince!(cursor, 1000);
        if (page.entries.length > 0) {
          const ids = page.entries.map((m) => m.id);
          let definitelyMissing: string[] = [];
          let maybeExisting: string[] = ids;

          if (targetBloom) {
            definitelyMissing = [];
            maybeExisting = [];
            for (const id of ids) {
              if (bloomMightContainId(targetBloom, id)) {
                maybeExisting.push(id);
              } else {
                definitelyMissing.push(id);
              }
            }
          }

          let missingIds = definitelyMissing;
          if (maybeExisting.length > 0) {
            const existing = await targetStore.hasEntries(maybeExisting);
            const existingSet = new Set(existing);
            const maybeMissing = maybeExisting.filter((id) => !existingSet.has(id));
            missingIds = missingIds.concat(maybeMissing);
          }

          if (missingIds.length > 0) {
            const missingEntries = await sourceStore.getEntries(missingIds);
            await targetStore.putEntries(missingEntries);
            transferred += missingEntries.length;
          }
        }
        cursor = page.nextCursor;
        if (!page.hasMore) {
          break;
        }
      }
      return transferred;
    }

    const targetIds = await targetStore.getAllIds();
    const sourceNewMetadata = await sourceStore.findNewEntries(targetIds);
    if (sourceNewMetadata.length === 0) {
      return 0;
    }
    const sourceEntries = await sourceStore.getEntries(sourceNewMetadata.map((m) => m.id));
    await targetStore.putEntries(sourceEntries);
    return sourceEntries.length;
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
    return this.createDocumentInternal(decryptionKeyId || "default");
  }

  async createDocumentWithSigningKey(
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string,
    decryptionKeyId?: string
  ): Promise<MindooDoc> {
    return this.createDocumentInternal(decryptionKeyId || "default", signingKeyPair, signingKeyPassword);
  }
  
  /**
   * Internal method to create a new document.
   * Handles both regular document creation (signed by current user) and
   * document creation with a custom signing key (e.g., for directory operations).
   */
  private async createDocumentInternal(
    decryptionKeyId: string,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<MindooDoc> {
    const keyId = decryptionKeyId;
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    
    // Admin-only validation: only admin key can modify data in admin-only databases
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomSigningKey 
        ? signingKeyPair!.publicKey 
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
    
    // Generate UUID7 for document ID
    const docId = uuidv7();
    
    this.logger.debug(`Creating document ${docId} with key ${keyId}${useCustomSigningKey ? ' using custom signing key' : ''}`);
    
    // Create initial Automerge document
    const initialDoc = Automerge.init<MindooDocPayload>();
    
    // Create the first change
    const now = Date.now();
    this.logger.debug(`Creating initial Automerge change for document ${docId}`);
    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
    try {
      newDoc = Automerge.change(initialDoc, (doc: MindooDocPayload) => {
        // Store metadata in the document payload
        // We need to modify the document to ensure a change is created
        doc._attachments = [];
      });
      this.logger.debug(`Successfully created Automerge change, document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      this.logger.error(`Error in Automerge.change for document ${docId}:`, error);
      throw error;
    }
    
    // Get the change bytes from the document
    this.logger.debug(`Getting change bytes from document ${docId}`);
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      throw new Error("Failed to get change bytes from Automerge document");
    }
    this.logger.debug(`Got change bytes: ${changeBytes.length} bytes`);
    
    // Decode the change to get hash and dependencies
    this.logger.debug(`Decoding change to get hash and dependencies`);
    let decodedChange: any;
    try {
      decodedChange = Automerge.decodeChange(changeBytes);
      this.logger.debug(`Successfully decoded change, hash: ${decodedChange.hash}, deps: ${decodedChange.deps?.length || 0}`);
    } catch (error) {
      this.logger.error(`Error decoding change for document ${docId}:`, error);
      throw error;
    }
    const automergeHash = decodedChange.hash;
    const automergeDepHashes: string[] = decodedChange.deps || []; // First change has no dependencies
    
    // Encrypt the change payload first
    this.logger.debug(`Encrypting change payload for document ${docId}`);
    const encryptedPayload = await this.tenant.encryptPayload(changeBytes, keyId);
    this.logger.debug(`Encrypted payload: ${changeBytes.length} -> ${encryptedPayload.length} bytes`);
    
    // Compute content hash from encrypted data
    const contentHash = await computeContentHash(encryptedPayload, this.getSubtle());
    this.logger.debug(`Computed content hash: ${contentHash.substring(0, 16)}...`);
    
    // Generate entry ID with blockchain-like chaining
    const entryId = await generateDocEntryId(docId, automergeHash, automergeDepHashes, this.getSubtle());
    this.logger.debug(`Generated entry ID: ${entryId}`);
    
    // Resolve Automerge dependency hashes to entry IDs (empty for first change)
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);
    
    // Sign the encrypted payload - either with custom key or current user's key
    let signature: Uint8Array;
    let createdByPublicKey: string;
    
    if (useCustomSigningKey) {
      this.logger.debug(`Signing encrypted payload for document ${docId} with provided key`);
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair!, signingKeyPassword!);
      createdByPublicKey = signingKeyPair!.publicKey;
    } else {
      this.logger.debug(`Signing encrypted payload for document ${docId}`);
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }
    this.logger.debug(`Signed payload, signature length: ${signature.length} bytes`);

    // Create entry metadata
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_create",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: now,
      createdByPublicKey,
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
    
    this.logger.info(`Document ${docId} created successfully`);
    this.logger.debug(`Document ${docId} cached and indexed (lastModified: ${internalDoc.lastModified})`);
    
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
    this.logger.debug(`Getting document ${docId} at timestamp ${timestamp}`);
    
    // Get all entry metadata for this document
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    
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
      // Admin-only mode: only accept entries signed by the admin key
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        continue;
      }
      
      // Verify signature against the encrypted payload (no decryption needed)
      // We sign the encrypted payload, so anyone can verify signatures without decryption keys
      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey
      );
      if (!isValid) {
        this.logger.warn(`Invalid signature for entry ${entryData.id}, skipping`);
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
    const deleteEntry = relevantEntries.find(em => em.entryType === "doc_delete" && em.createdAt <= timestamp);
    const isDeleted = deleteEntry !== undefined;
    
    // Find the first entry to get createdAt and decryptionKeyId
    const firstEntry = relevantEntries.length > 0 ? relevantEntries[0] : null;
    const createdAt = firstEntry ? firstEntry.createdAt : timestamp;
    const decryptionKeyId = firstEntry ? firstEntry.decryptionKeyId : "default";
    
    // Use delete entry timestamp as lastModified if deleted, otherwise use the requested timestamp
    const lastModified = isDeleted && deleteEntry ? deleteEntry.createdAt : timestamp;
    
    const internalDoc: InternalDoc = {
      id: docId,
      doc,
      createdAt,
      lastModified,
      decryptionKeyId,
      isDeleted,
    };
    
    return this.wrapDocument(internalDoc);
  }

  async *iterateDocumentHistory(docId: string): AsyncGenerator<DocumentHistoryResult, void, unknown> {
    this.logger.debug(`Iterating document history for ${docId}`);
    
    // Get all entry metadata for this document
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    
    // Filter to only doc_create, doc_change, and doc_delete entries (exclude snapshots)
    const relevantEntries = allEntryMetadata
      .filter(em => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete")
      .sort((a, b) => a.createdAt - b.createdAt);
    
    if (relevantEntries.length === 0) {
      return; // Document has no history
    }
    
    // Load all entries
    const entries = await this.store.getEntries(relevantEntries.map(em => em.id));
    
    // Build a map for quick lookup
    const entryMap = new Map(entries.map(e => [e.id, e]));
    
    // Apply changes in order
    let currentDoc: AutomergeTypes.Doc<MindooDocPayload> | null = null;
    let createdAt: number | null = null;
    let decryptionKeyId: string = "default";
    
    for (const entryMetadata of relevantEntries) {
      const entryData = entryMap.get(entryMetadata.id);
      if (!entryData) {
        this.logger.warn(`Entry ${entryMetadata.id} not found in store, skipping`);
        continue;
      }
      
      // Admin-only mode: only accept entries signed by the admin key
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        continue;
      }
      
      // Verify signature
      const isValid = await this.tenant.verifySignature(
        entryData.encryptedData,
        entryData.signature,
        entryData.createdByPublicKey
      );
      if (!isValid) {
        this.logger.warn(`Invalid signature for entry ${entryData.id}, skipping`);
        continue;
      }
      
      // Decrypt payload
      const decryptedPayload = await this.tenant.decryptPayload(
        entryData.encryptedData,
        entryData.decryptionKeyId
      );
      
      // Initialize document if this is the first entry (doc_create)
      const isFirstEntry = currentDoc === null;
      if (isFirstEntry) {
        if (entryMetadata.entryType !== "doc_create") {
          this.logger.warn(`First entry is not doc_create, skipping`);
          continue;
        }
        currentDoc = Automerge.init<MindooDocPayload>();
        createdAt = entryMetadata.createdAt;
        decryptionKeyId = entryMetadata.decryptionKeyId;
      }
      
      // Check document heads before applying change (for non-first entries)
      const headsBefore = isFirstEntry ? null : (currentDoc ? Automerge.getHeads(currentDoc) : null);
      
      // Apply change using loadIncremental
      if (currentDoc === null) {
        throw new Error("currentDoc should not be null at this point");
      }
      currentDoc = Automerge.loadIncremental(currentDoc, decryptedPayload);
      
      // Check if document actually changed by comparing heads
      // For first entry (doc_create), always yield since it's the initial creation
      // For delete entries, always yield
      // For other entries, only yield if heads changed
      let shouldYield = false;
      if (isFirstEntry || entryMetadata.entryType === "doc_delete") {
        shouldYield = true;
      } else {
        const headsAfter = Automerge.getHeads(currentDoc);
        const headsChanged = headsBefore !== null && JSON.stringify(headsBefore) !== JSON.stringify(headsAfter);
        shouldYield = headsChanged;
      }
      
      // Register automerge hash mapping
      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
      
      // Only yield if document actually changed (or if this is create/delete entry)
      if (shouldYield) {
        // Clone the document to ensure independence
        const clonedDoc = Automerge.clone(currentDoc);
        
        // Create internal doc representation
        const internalDoc: InternalDoc = {
          id: docId,
          doc: clonedDoc,
          createdAt: createdAt!,
          lastModified: entryMetadata.createdAt,
          decryptionKeyId,
          isDeleted: entryMetadata.entryType === "doc_delete",
        };
        
        // Wrap and yield (including delete entries)
        const wrappedDoc = this.wrapDocument(internalDoc);
        
        yield {
          doc: wrappedDoc,
          changeCreatedAt: entryMetadata.createdAt,
          changeCreatedByPublicKey: entryMetadata.createdByPublicKey,
        };
      }
      
      // Stop after delete entry (document is deleted, no more changes)
      if (entryMetadata.entryType === "doc_delete") {
        break;
      }
    }
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

  async getAllDocumentIdsAtTimestamp(timestamp: number): Promise<string[]> {
    // findEntries() uses an exclusive upper bound (createdAt < creationDateUntil).
    // Query up to timestamp + 1 so entries created exactly at `timestamp` are included
    // for the strict checks below (createTime < timestamp, deleteTime > timestamp).
    const upperBoundExclusive =
      timestamp === Number.MAX_SAFE_INTEGER ? timestamp : timestamp + 1;

    // Efficiently query for doc_create and doc_delete entries before the timestamp
    const [creates, deletes] = await Promise.all([
      this.store.findEntries("doc_create", null, upperBoundExclusive),
      this.store.findEntries("doc_delete", null, upperBoundExclusive)
    ]);
    
    // Build sets of docIds for efficient lookup
    const createdDocIds = new Set<string>();
    const deletedDocIds = new Set<string>();
    
    // Track earliest create time for each doc
    const createTimes = new Map<string, number>();
    for (const entry of creates) {
      const existingTime = createTimes.get(entry.docId);
      if (!existingTime || entry.createdAt < existingTime) {
        createTimes.set(entry.docId, entry.createdAt);
        createdDocIds.add(entry.docId);
      }
    }
    
    // Track earliest delete time for each doc
    const deleteTimes = new Map<string, number>();
    for (const entry of deletes) {
      const existingTime = deleteTimes.get(entry.docId);
      if (!existingTime || entry.createdAt < existingTime) {
        deleteTimes.set(entry.docId, entry.createdAt);
        deletedDocIds.add(entry.docId);
      }
    }
    
    // Find documents that existed at the timestamp
    const docIds: string[] = [];
    
    for (const docId of createdDocIds) {
      const createTime = createTimes.get(docId)!;
      const deleteTime = deleteTimes.get(docId);
      
      // Document exists at timestamp if:
      // 1. It was created at or before the timestamp
      // 2. Either it was never deleted, or it was deleted after the timestamp
      if (createTime <= timestamp) {
        if (!deleteTime || deleteTime > timestamp) {
          docIds.push(docId);
        }
      }
    }
    
    return docIds;
  }

  async deleteDocument(docId: string): Promise<void> {
    return this.deleteDocInternal(docId);
  }

  async deleteDocumentWithSigningKey(
    docId: string,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void> {
    return this.deleteDocInternal(docId, signingKeyPair, signingKeyPassword);
  }

  /**
   * Internal method to delete a document.
   * Handles both regular deletion (signed by current user) and
   * deletion with a custom signing key (e.g., for directory operations).
   */
  private async deleteDocInternal(
    docId: string,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<void> {
    const useCustomSigningKey = signingKeyPair !== undefined && signingKeyPassword !== undefined;
    this.logger.debug(`Deleting document ${docId}${useCustomSigningKey ? ' using custom signing key' : ''}`);
    
    // Admin-only validation: only admin key can modify data in admin-only databases
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomSigningKey 
        ? signingKeyPair!.publicKey 
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
    
    // Get current document
    const internalDoc = await this.loadDocumentInternal(docId);
    if (!internalDoc || internalDoc.isDeleted) {
      throw new Error(`Document ${docId} not found or already deleted`);
    }
    
    // Create deletion change by clearing all fields from the document
    // This ensures Automerge produces actual change bytes
    // The deletion is also tracked via the "doc_delete" type entry in the append-only store
    const newDoc = Automerge.change(internalDoc.doc, (doc: MindooDocPayload) => {
      // Remove all fields from the document
      for (const key of Object.keys(doc)) {
        delete (doc as Record<string, unknown>)[key];
      }
      // Mark as deleted for clarity
      (doc as Record<string, unknown>)._deleted = true;
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

    // Sign the encrypted payload - either with custom key or current user's key
    let signature: Uint8Array;
    let createdByPublicKey: string;
    
    if (useCustomSigningKey) {
      this.logger.debug(`Signing deletion for document ${docId} with provided key`);
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair!, signingKeyPassword!);
      createdByPublicKey = signingKeyPair!.publicKey;
    } else {
      this.logger.debug(`Signing deletion for document ${docId} with current user's key`);
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }

    // Create entry metadata with type "doc_delete" to mark this as a deletion entry in the store
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_delete",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: Date.now(),
      createdByPublicKey,
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
    
    this.logger.info(`Document ${docId} deleted successfully`);
  }

  async changeDoc(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>
  ): Promise<void> {
    return this.changeDocInternal(doc, changeFunc);
  }

  async changeDocWithSigningKey(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair: SigningKeyPair,
    signingKeyPassword: string
  ): Promise<void> {
    return this.changeDocInternal(doc, changeFunc, signingKeyPair, signingKeyPassword);
  }

  private async changeDocInternal(
    doc: MindooDoc,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    signingKeyPair?: SigningKeyPair,
    signingKeyPassword?: string
  ): Promise<void> {
    const docId = doc.getId();
    const useCustomKey = signingKeyPair && signingKeyPassword;
    this.logger.debug(`===== ${useCustomKey ? 'changeDocWithSigningKey' : 'changeDoc'} called for document ${docId} =====`);
    
    // Admin-only validation: only admin key can modify data in admin-only databases
    if (this._isAdminOnlyDb) {
      const adminPublicKey = this.getAdminPublicKey();
      const signerPublicKey = useCustomKey 
        ? signingKeyPair!.publicKey 
        : (await this.tenant.getCurrentUserId()).userSigningPublicKey;
      if (signerPublicKey !== adminPublicKey) {
        throw new Error("Admin-only database: only the admin key can modify data");
      }
    }
    
    // Get internal document from cache or load it
    let internalDoc = this.docCache.get(docId);
    if (!internalDoc) {
      this.logger.debug(`Document ${docId} not in cache, loading from store`);
      const loadedDoc = await this.loadDocumentInternal(docId);
      if (!loadedDoc) {
        throw new Error(`Document ${docId} not found`);
      }
      internalDoc = loadedDoc;
      this.logger.debug(`Successfully loaded document ${docId} from store for ${useCustomKey ? 'changeDocWithSigningKey' : 'changeDoc'}`);
    } else {
      this.logger.debug(`Document ${docId} found in cache`);
    }
    
    if (internalDoc.isDeleted) {
      throw new Error(`Document ${docId} has been deleted`);
    }
    
    // Apply the change function
    const now = Date.now();
    this.logger.debug(`Applying change function to document ${docId}`);
    this.logger.debug(`Document state before change: heads=${JSON.stringify(Automerge.getHeads(internalDoc.doc))}`);
    
    // For async callbacks, we need to handle document modifications carefully.
    // Automerge.change() requires synchronous modifications, so we'll:
    // 1. Execute the async callback to do any async work (like signing)
    // 2. Apply document modifications synchronously within Automerge.change()
    // 
    // We use a two-phase approach: the callback can do async work and collect
    // what needs to be changed, then we apply those changes in Automerge.change()
    const pendingChanges = new Map<string, unknown>();
    const pendingDeletions = new Set<string>();
    
    // Track pending attachment operations
    const pendingAttachmentAdditions: AttachmentReference[] = [];
    const pendingAttachmentRemovals = new Set<string>();
    // Map of attachmentId -> {lastChunkId, sizeIncrease} for appends
    const pendingAttachmentAppends = new Map<string, { lastChunkId: string; sizeIncrease: number }>();
    
    // Reference to db for closures
    const db = this;
    
    // Guard flag to prevent operations after callback completes
    // This ensures changes can only be made during the callback execution
    let isCallbackActive = true;
    
    const throwIfCallbackInactive = (methodName: string) => {
      if (!isCallbackActive) {
        throw new Error(`${methodName}() cannot be called after changeDoc() callback has completed. Document changes can only be made within the callback.`);
      }
    };
    
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
            throwIfCallbackInactive('set property');
            if (typeof prop === 'string') {
              // If this property was marked for deletion, remove it from deletions
              pendingDeletions.delete(prop);
              // Track the change
              pendingChanges.set(prop, value);
              // NOTE: Don't set on target immediately - Automerge requires changes
              // to be made inside Automerge.change(). Pending changes are applied later.
            }
            return true;
          },
          deleteProperty: (target, prop) => {
            throwIfCallbackInactive('delete property');
            if (typeof prop === 'string') {
              // Mark for deletion
              pendingDeletions.add(prop);
              // Remove from pending changes if it was there
              pendingChanges.delete(prop);
              // NOTE: Don't delete from target immediately - Automerge requires changes
              // to be made inside Automerge.change(). Pending deletions are applied later.
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
      },
      
      // ========== Attachment Write Methods (work in changeDoc context) ==========
      
      addAttachment: async (
        fileData: Uint8Array,
        fileName: string,
        mimeType: string,
        keyId?: string
      ): Promise<AttachmentReference> => {
        throwIfCallbackInactive('addAttachment');
        const decryptionKeyId = keyId || internalDoc.decryptionKeyId;
        const ref = await db.addAttachmentInternal(
          docId,
          fileData,
          fileName,
          mimeType,
          decryptionKeyId,
          now
        );
        pendingAttachmentAdditions.push(ref);
        return ref;
      },
      
      addAttachmentStream: async (
        dataStream: AsyncIterable<Uint8Array>,
        fileName: string,
        mimeType: string,
        keyId?: string
      ): Promise<AttachmentReference> => {
        throwIfCallbackInactive('addAttachmentStream');
        const decryptionKeyId = keyId || internalDoc.decryptionKeyId;
        const ref = await db.addAttachmentStreamInternal(
          docId,
          dataStream,
          fileName,
          mimeType,
          decryptionKeyId,
          now
        );
        pendingAttachmentAdditions.push(ref);
        return ref;
      },
      
      removeAttachment: async (attachmentId: string): Promise<void> => {
        throwIfCallbackInactive('removeAttachment');
        // Check if attachment exists (either in current doc or pending additions)
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        const existingAttachments = (payload._attachments as AttachmentReference[]) || [];
        const existsInDoc = existingAttachments.some(a => a.attachmentId === attachmentId);
        const existsInPending = pendingAttachmentAdditions.some(a => a.attachmentId === attachmentId);
        
        if (!existsInDoc && !existsInPending) {
          throw new Error(`Attachment ${attachmentId} not found in document ${docId}`);
        }
        
        // If it was added in this same changeDoc call, just remove from pending
        const pendingIndex = pendingAttachmentAdditions.findIndex(a => a.attachmentId === attachmentId);
        if (pendingIndex >= 0) {
          pendingAttachmentAdditions.splice(pendingIndex, 1);
        } else {
          // Mark for removal from existing attachments
          pendingAttachmentRemovals.add(attachmentId);
        }
      },
      
      appendToAttachment: async (attachmentId: string, data: Uint8Array): Promise<void> => {
        throwIfCallbackInactive('appendToAttachment');
        // Find the attachment reference
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        const existingAttachments = (payload._attachments as AttachmentReference[]) || [];
        let ref = existingAttachments.find(a => a.attachmentId === attachmentId);
        
        // Also check pending additions
        if (!ref) {
          ref = pendingAttachmentAdditions.find(a => a.attachmentId === attachmentId);
        }
        
        if (!ref) {
          throw new Error(`Attachment ${attachmentId} not found in document ${docId}`);
        }
        
        // Determine the previous lastChunkId (might have been updated by previous append in this changeDoc)
        let prevLastChunkId = ref.lastChunkId;
        const prevAppend = pendingAttachmentAppends.get(attachmentId);
        if (prevAppend) {
          prevLastChunkId = prevAppend.lastChunkId;
        }
        
        // Append the data by creating new chunks
        const { lastChunkId, sizeIncrease } = await db.appendToAttachmentInternal(
          docId,
          attachmentId,
          ref.decryptionKeyId,
          prevLastChunkId,
          data,
          now
        );
        
        // Track the append
        const existingAppend = pendingAttachmentAppends.get(attachmentId);
        if (existingAppend) {
          existingAppend.lastChunkId = lastChunkId;
          existingAppend.sizeIncrease += sizeIncrease;
        } else {
          pendingAttachmentAppends.set(attachmentId, { lastChunkId, sizeIncrease });
        }
      },
      
      // ========== Attachment Read Methods (also work in changeDoc context) ==========
      
      getAttachments: (): AttachmentReference[] => {
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        const existing = (payload._attachments as AttachmentReference[]) || [];
        // Filter out removals and add pending additions
        const filtered = existing.filter(a => !pendingAttachmentRemovals.has(a.attachmentId));
        return [...filtered, ...pendingAttachmentAdditions];
      },
      
      getAttachment: async (attachmentId: string): Promise<Uint8Array> => {
        return db.getAttachmentInternal(docId, attachmentId);
      },
      
      getAttachmentRange: async (
        attachmentId: string,
        startByte: number,
        endByte: number
      ): Promise<Uint8Array> => {
        return db.getAttachmentRangeInternal(docId, attachmentId, startByte, endByte);
      },
      
      streamAttachment: (
        attachmentId: string,
        startOffset: number = 0
      ): AsyncGenerator<Uint8Array, void, unknown> => {
        return db.streamAttachmentInternal(docId, attachmentId, startOffset);
      },
    };
    
    // Execute the async callback (this may do async operations like signing)
    await changeFunc(collectingDoc);
    
    // Deactivate the callback guard - no more changes can be made via collectingDoc
    isCallbackActive = false;
    
    // Now apply the collected changes synchronously in Automerge.change()
    let newDoc: AutomergeTypes.Doc<MindooDocPayload>;
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
        
        // Apply pending attachment changes
        if (pendingAttachmentAdditions.length > 0 || pendingAttachmentRemovals.size > 0 || pendingAttachmentAppends.size > 0) {
          // Initialize _attachments array if needed
          if (!automergeDoc._attachments) {
            automergeDoc._attachments = [];
          }
          const attachments = automergeDoc._attachments as AttachmentReference[];
          
          // Remove attachments marked for removal
          for (const attachmentId of pendingAttachmentRemovals) {
            const index = attachments.findIndex(a => a.attachmentId === attachmentId);
            if (index >= 0) {
              attachments.splice(index, 1);
            }
          }
          
          // Apply appends (update lastChunkId and size)
          for (const [attachmentId, { lastChunkId, sizeIncrease }] of pendingAttachmentAppends) {
            const attachment = attachments.find(a => a.attachmentId === attachmentId);
            if (attachment) {
              attachment.lastChunkId = lastChunkId;
              attachment.size += sizeIncrease;
            }
          }
          
          // Add new attachments
          for (const ref of pendingAttachmentAdditions) {
            attachments.push(ref);
          }
        }
        
        // Update lastModified timestamp
        automergeDoc._lastModified = now;
      });
      this.logger.debug(`Successfully applied change function, new document heads: ${JSON.stringify(Automerge.getHeads(newDoc))}`);
    } catch (error) {
      this.logger.error(`Error in Automerge.change for document ${docId}:`, error);
      throw error;
    }
    
    // Get the change bytes from the document
    this.logger.debug(`Getting change bytes from document ${docId}`);
    const changeBytes = Automerge.getLastLocalChange(newDoc);
    if (!changeBytes) {
      //TODO decide if we just exit here or throw an error
      throw new Error("Failed to get change bytes from Automerge document");
    }
    this.logger.debug(`Got change bytes: ${changeBytes.length} bytes`);
    
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
    this.logger.debug(`Generated entry ID for change: ${entryId}`);

    // Resolve Automerge dependency hashes to entry IDs
    const dependencyIds = this.resolveAutomergeDepsToEntryIds(docId, automergeDepHashes);

    // Sign the encrypted payload - use custom key if provided, otherwise current user's key
    let signature: Uint8Array;
    let createdByPublicKey: string;

    if (useCustomKey) {
      signature = await this.tenant.signPayloadWithKey(encryptedPayload, signingKeyPair, signingKeyPassword);
      createdByPublicKey = signingKeyPair.publicKey;
    } else {
      const currentUser = await this.tenant.getCurrentUserId();
      signature = await this.tenant.signPayload(encryptedPayload);
      createdByPublicKey = currentUser.userSigningPublicKey;
    }

    // Create entry metadata
    const entryMetadata: StoreEntryMetadata = {
      entryType: "doc_change",
      id: entryId,
      contentHash,
      docId,
      dependencyIds,
      createdAt: Date.now(),
      createdByPublicKey,
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
    
    this.logger.info(`Document ${docId} ${useCustomKey ? 'changed with custom signing key' : 'changed'} successfully`);
  }

  async *iterateChangesSince(
    cursor: ProcessChangesCursor | null
  ): AsyncGenerator<ProcessChangesResult, void, unknown> {
    // Default to initial cursor if null is provided
    const actualCursor: ProcessChangesCursor = cursor ?? { lastModified: 0, docId: "" };
    this.logger.debug(`Starting iteration from cursor ${JSON.stringify(actualCursor)}`);
    
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
    
    // Pre-check which documents are in cache to optimize iteration
    const uncachedDocIds: string[] = [];
    for (let i = startIndex; i < this.index.length; i++) {
      const entry = this.index[i];
      if (!this.docCache.has(entry.docId)) {
        uncachedDocIds.push(entry.docId);
      }
    }
    
    // Prefetch uncached documents in batches (if any)
    if (uncachedDocIds.length > 0) {
      this.logger.debug(`Prefetching ${uncachedDocIds.length} uncached documents for iteration`);
      const prefetchBatchSize = 10;
      for (let i = 0; i < uncachedDocIds.length; i += prefetchBatchSize) {
        const batch = uncachedDocIds.slice(i, i + prefetchBatchSize);
        await Promise.all(
          batch.map(docId => this.loadDocumentInternal(docId).catch(err => {
            this.logger.warn(`Failed to prefetch document ${docId}:`, err);
            return null;
          }))
        );
      }
    }
    
    // Iterate through the index and yield documents one at a time
    // Documents should now be in cache from prefetching
    for (let i = startIndex; i < this.index.length; i++) {
      const entry = this.index[i];
      
      try {
        this.logger.debug(`Yielding document ${entry.docId} from index (lastModified: ${entry.lastModified}, isDeleted: ${entry.isDeleted})`);
        
        // Check cache first (should be there after prefetching)
        let internalDoc: InternalDoc | null = this.docCache.get(entry.docId) || null;
        
        if (!internalDoc) {
          // Fallback to loading if not in cache (shouldn't happen after prefetching)
          this.logger.debug(`Document ${entry.docId} not in cache, loading from store`);
          internalDoc = await this.loadDocumentInternal(entry.docId);
        }
        
        if (!internalDoc) {
          this.logger.warn(`Document ${entry.docId} not found, skipping`);
          continue;
        }
        
        // Wrap the document (works for both deleted and non-deleted documents)
        const doc = this.wrapDocument(internalDoc);
        this.logger.debug(`Successfully loaded document ${entry.docId} (isDeleted: ${doc.isDeleted()})`);
        
        // Create cursor for current document
        const currentCursor: ProcessChangesCursor = {
          lastModified: entry.lastModified,
          docId: entry.docId,
        };
        
        // Yield immediately - this allows the caller to break early after each document
        // Deleted documents are included so external indexes can handle deletions
        yield { doc, cursor: currentCursor };
      } catch (error) {
        this.logger.error(`Error processing document ${entry.docId}:`, error);
        // Stop processing on error
        throw error;
      }
    }
    
    this.logger.debug(`Iteration completed`);
  }

  /**
   * Incrementally update a cached document with new entries.
   * Returns the updated document, or null if document wasn't actually changed.
   */
  private async applyNewEntriesToCachedDocument(
    cachedDoc: InternalDoc,
    newEntryMetadata: StoreEntryMetadata[]
  ): Promise<InternalDoc | null> {
    const docId = cachedDoc.id;
    
    if (newEntryMetadata.length === 0) {
      this.logger.debug(`No new entries for cached document ${docId}`);
      return null; // No changes
    }
    
    this.logger.debug(`Applying ${newEntryMetadata.length} new entries to cached document ${docId}`);
    
    // Get current document heads to check if it changes
    const headsBefore = Automerge.getHeads(cachedDoc.doc);
    
    // Filter entries to only include change entries (exclude snapshots)
    const entriesToApply = newEntryMetadata.filter(
      em => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete"
    );
    
    if (entriesToApply.length === 0) {
      this.logger.debug(`No change entries to apply for document ${docId}`);
      return null; // No changes
    }
    
    // Sort entries by timestamp
    entriesToApply.sort((a, b) => a.createdAt - b.createdAt);
    
    // Load entries from store
    const entries = await this.store.getEntries(entriesToApply.map(em => em.id));
    
    // Filter entries for admin-only mode first
    const validEntries = entries.filter(entryData => {
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        return false;
      }
      return true;
    });
    
    if (validEntries.length === 0) {
      this.logger.debug(`No valid entries to process for cached document ${docId}`);
      return null;
    }
    
    // Batch signature verification with key caching
    // Group entries by public key to import each key only once
    const entriesByPublicKey = new Map<string, StoreEntry[]>();
    for (const entryData of validEntries) {
      if (!entriesByPublicKey.has(entryData.createdByPublicKey)) {
        entriesByPublicKey.set(entryData.createdByPublicKey, []);
      }
      entriesByPublicKey.get(entryData.createdByPublicKey)!.push(entryData);
    }

    // Import all unique public keys in parallel (with caching)
    const keyImportResults = await Promise.all(
      Array.from(entriesByPublicKey.keys()).map(async (publicKey) => {
        const cryptoKey = await this.getOrImportPublicKey(publicKey);
        return { publicKey, cryptoKey };
      })
    );

    // Create a map of public key -> CryptoKey for quick lookup
    const keyMap = new Map<string, CryptoKey>();
    for (const { publicKey, cryptoKey } of keyImportResults) {
      if (cryptoKey) {
        keyMap.set(publicKey, cryptoKey);
      }
    }

    // Verify all signatures in parallel using cached keys
    const signatureVerificationResults = await Promise.all(
      validEntries.map(async (entryData) => {
        const cryptoKey = keyMap.get(entryData.createdByPublicKey);
        if (!cryptoKey) {
          // Key was not trusted or failed to import
          return { entryData, isValid: false };
        }
        
        const isValid = await this.verifySignatureWithKey(
          cryptoKey,
          entryData.encryptedData,
          entryData.signature
        );
        return { entryData, isValid };
      })
    );
    
    // Filter out entries with invalid signatures
    const verifiedEntries = signatureVerificationResults
      .filter(({ isValid }) => isValid)
      .map(({ entryData }) => entryData);
    
    if (verifiedEntries.length === 0) {
      this.logger.debug(`No entries with valid signatures for cached document ${docId}`);
      return null;
    }
    
    // Parallel decryption - decrypt all entries concurrently
    const decryptionResults = await Promise.all(
      verifiedEntries.map(async (entryData) => {
        const decryptedPayload = await this.tenant.decryptPayload(
          entryData.encryptedData,
          entryData.decryptionKeyId
        );
        return { entryData, decryptedPayload };
      })
    );
    
    // Collect change bytes and register automerge hash mappings
    const changeBytes: Uint8Array[] = [];
    for (const { entryData, decryptedPayload } of decryptionResults) {
      changeBytes.push(decryptedPayload);
      
      // Register automerge hash -> entry ID mapping
      const parsed = parseDocEntryId(entryData.id);
      if (parsed) {
        this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
      }
    }
    
    if (changeBytes.length === 0) {
      this.logger.debug(`No valid change bytes to apply for document ${docId}`);
      return null; // No changes
    }
    
    // Clone the cached document to avoid "outdated document" error
    // This happens when the document has been wrapped and returned to the user
    // Automerge marks documents as outdated when they're accessed, preventing direct mutation
    const clonedDoc = Automerge.clone(cachedDoc.doc);
    
    // Apply all changes at once (Automerge handles dependency ordering)
    const result = Automerge.applyChanges<MindooDocPayload>(clonedDoc, changeBytes);
    const updatedDoc = result[0] as AutomergeTypes.Doc<MindooDocPayload>;
    
    // Check if document actually changed
    const headsAfter = Automerge.getHeads(updatedDoc);
    const headsChanged = JSON.stringify(headsBefore) !== JSON.stringify(headsAfter);
    
    if (!headsChanged) {
      this.logger.debug(`Document ${docId} heads unchanged after applying new entries`);
      return null; // Document didn't actually change
    }
    
    this.logger.debug(`Document ${docId} changed: heads before=${JSON.stringify(headsBefore)}, after=${JSON.stringify(headsAfter)}`);
    
    // Update metadata
    const payload = updatedDoc as unknown as MindooDocPayload;
    const lastEntry = entries[entries.length - 1];
    const lastModified = (payload._lastModified as number) || 
                         (lastEntry ? lastEntry.createdAt : cachedDoc.lastModified);
    
    // Check if document was deleted
    const hasDeleteEntry = newEntryMetadata.some(em => em.entryType === "doc_delete");
    const isDeleted = hasDeleteEntry || cachedDoc.isDeleted;
    
    const updatedInternalDoc: InternalDoc = {
      id: docId,
      doc: updatedDoc,
      createdAt: cachedDoc.createdAt,
      lastModified,
      decryptionKeyId: cachedDoc.decryptionKeyId,
      isDeleted,
    };
    
    // Update cache
    this.docCache.set(docId, updatedInternalDoc);
    
    return updatedInternalDoc;
  }

  /**
   * Internal method to load a document from the content-addressed store
   */
  private async loadDocumentInternal(docId: string): Promise<InternalDoc | null> {
    // Check cache first
    if (this.docCache.has(docId)) {
      this.logger.debug(`Document ${docId} found in cache, returning cached version`);
      return this.docCache.get(docId)!;
    }
    
    this.logger.debug(`===== Starting to load document ${docId} from store =====`);
    
    // Get all entry metadata for this document
    // TODO: Implement loading from last snapshot if available
    this.logger.debug(`Getting all entry hashes for document ${docId}`);
    const allEntryMetadata = await this.scanAllMetadata(this.store, { docId });
    this.logger.debug(`Found ${allEntryMetadata.length} total entry hashes for document ${docId}`);
    
    if (allEntryMetadata.length === 0) {
      this.logger.debug(`No entry hashes found for document ${docId}, returning null`);
      return null;
    }
    
    // Log all entry types
    const entryTypes = allEntryMetadata.map(em => `${em.entryType}@${em.createdAt}`).join(', ');
    this.logger.debug(`Entry types for ${docId}: ${entryTypes}`);
    
    // Find the most recent snapshot (if any)
    const snapshots = allEntryMetadata.filter(em => em.entryType === "doc_snapshot");
    this.logger.debug(`Found ${snapshots.length} snapshot(s) for document ${docId}`);
    let startFromSnapshot = false;
    let snapshotMeta: StoreEntryMetadata | null = null;
    
    if (snapshots.length > 0) {
      // Use the most recent snapshot
      snapshots.sort((a, b) => b.createdAt - a.createdAt);
      snapshotMeta = snapshots[0];
      startFromSnapshot = true;
      this.logger.debug(`Will start from snapshot ${snapshotMeta.id} created at ${snapshotMeta.createdAt}`);
    } else {
      this.logger.debug(`No snapshot found, will start from scratch`);
    }
    
    // Get all entries (excluding snapshot entries - we'll handle delete separately)
    // Include "doc_create", "doc_change", and "doc_delete" types as they all contain Automerge changes to apply
    const entriesToLoad = startFromSnapshot
      ? allEntryMetadata.filter(em => (em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete") && em.createdAt > snapshotMeta!.createdAt)
      : allEntryMetadata.filter(em => em.entryType === "doc_create" || em.entryType === "doc_change" || em.entryType === "doc_delete");
    this.logger.debug(`Will load ${entriesToLoad.length} entries for document ${docId} (after snapshot filter)`);
    
    // Load the snapshot first if we have one
    let doc: AutomergeTypes.Doc<MindooDocPayload> | undefined = undefined;
    if (startFromSnapshot && snapshotMeta) {
      this.logger.debug(`Loading snapshot for document ${docId}`);
      const snapshotEntries = await this.store.getEntries([snapshotMeta.id]);
      this.logger.debug(`Retrieved ${snapshotEntries.length} snapshot entry(s) from store`);
      if (snapshotEntries.length > 0) {
        const snapshotData = snapshotEntries[0];
        
        // Admin-only mode: only accept snapshots signed by admin
        let isValid = false;
        if (this._isAdminOnlyDb && snapshotData.createdByPublicKey !== this.getAdminPublicKey()) {
          this.logger.warn(`Admin-only DB: skipping snapshot ${snapshotData.id} not signed by admin key`);
        } else {
          // Verify signature against the encrypted snapshot (no decryption needed)
          // We sign the encrypted payload, so anyone can verify signatures without decryption keys
          isValid = await this.tenant.verifySignature(
            snapshotData.encryptedData,
            snapshotData.signature,
            snapshotData.createdByPublicKey
          );
        }
        if (!isValid) {
          this.logger.warn(`Invalid signature for snapshot ${snapshotData.id}, falling back to loading from scratch`);
          // Fall back to loading from scratch
          startFromSnapshot = false;
        } else {
          this.logger.debug(`Snapshot signature valid, decrypting snapshot`);
          // Decrypt snapshot (only after signature verification passes)
          const decryptedSnapshot = await this.tenant.decryptPayload(
            snapshotData.encryptedData,
            snapshotData.decryptionKeyId
          );
          this.logger.debug(`Decrypted snapshot (${snapshotData.encryptedData.length} -> ${decryptedSnapshot.length} bytes)`);
          
          // Load snapshot using Automerge.load()
          // This deserializes a full document snapshot from binary data
          // According to Automerge docs: load() is equivalent to init() followed by loadIncremental()
          this.logger.debug(`Loading snapshot into Automerge document`);
          doc = Automerge.load<MindooDocPayload>(decryptedSnapshot);
          this.logger.debug(`Successfully loaded snapshot, document heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
          
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
      this.logger.debug(`Initializing new Automerge document for ${docId}`);
      doc = Automerge.init<MindooDocPayload>();
      this.logger.debug(`Initialized empty document, heads: ${JSON.stringify(Automerge.getHeads(doc))}`);
    }
    
    // Sort entries by timestamp
    entriesToLoad.sort((a, b) => a.createdAt - b.createdAt);
    this.logger.debug(`Sorted ${entriesToLoad.length} entries by timestamp for document ${docId}`);
    
    // Load and apply all entries
    this.logger.debug(`Fetching ${entriesToLoad.length} entries from store for document ${docId}`);
    const entries = await this.store.getEntries(entriesToLoad.map(em => em.id));
    this.logger.debug(`Retrieved ${entries.length} entries from store for document ${docId}`);
    this.logger.debug(`Loading document ${docId}: found ${entries.length} entries to apply (${startFromSnapshot ? 'starting from snapshot' : 'starting from scratch'})`);
    
    // Log current document state before applying entries
    this.logger.debug(`Document state before applying entries: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
    
    // Filter entries for admin-only mode first
    const validEntries = entries.filter(entryData => {
      if (this._isAdminOnlyDb && entryData.createdByPublicKey !== this.getAdminPublicKey()) {
        this.logger.warn(`Admin-only DB: skipping entry ${entryData.id} not signed by admin key`);
        return false;
      }
      return true;
    });
    
    if (validEntries.length === 0) {
      this.logger.debug(`No valid entries to process for document ${docId}`);
    } else {
      // Batch signature verification with key caching
      // Group entries by public key to import each key only once
      this.logger.debug(`Verifying ${validEntries.length} signatures in parallel with key caching`);
      const entriesByPublicKey = new Map<string, StoreEntry[]>();
      for (const entryData of validEntries) {
        if (!entriesByPublicKey.has(entryData.createdByPublicKey)) {
          entriesByPublicKey.set(entryData.createdByPublicKey, []);
        }
        entriesByPublicKey.get(entryData.createdByPublicKey)!.push(entryData);
      }

      // Import all unique public keys in parallel (with caching)
      const keyImportResults = await Promise.all(
        Array.from(entriesByPublicKey.keys()).map(async (publicKey) => {
          const cryptoKey = await this.getOrImportPublicKey(publicKey);
          return { publicKey, cryptoKey };
        })
      );

      // Create a map of public key -> CryptoKey for quick lookup
      const keyMap = new Map<string, CryptoKey>();
      for (const { publicKey, cryptoKey } of keyImportResults) {
        if (cryptoKey) {
          keyMap.set(publicKey, cryptoKey);
        }
      }

      // Verify all signatures in parallel using cached keys
      const signatureVerificationResults = await Promise.all(
        validEntries.map(async (entryData) => {
          const cryptoKey = keyMap.get(entryData.createdByPublicKey);
          if (!cryptoKey) {
            // Key was not trusted or failed to import
            return { entryData, isValid: false };
          }
          
          const isValid = await this.verifySignatureWithKey(
            cryptoKey,
            entryData.encryptedData,
            entryData.signature
          );
          return { entryData, isValid };
        })
      );
      
      // Filter out entries with invalid signatures
      const verifiedEntries = signatureVerificationResults
        .filter(({ isValid }) => {
          if (!isValid) {
            this.logger.warn(`Invalid signature for entry, skipping`);
          }
          return isValid;
        })
        .map(({ entryData }) => entryData);
      
      if (verifiedEntries.length === 0) {
        this.logger.debug(`No entries with valid signatures for document ${docId}`);
      } else {
        // Parallel decryption - decrypt all entries concurrently
        // Automerge handles dependency buffering internally, so we can decrypt all in parallel
        this.logger.debug(`Decrypting ${verifiedEntries.length} entries in parallel`);
        const decryptionResults = await Promise.all(
          verifiedEntries.map(async (entryData) => {
            const decryptedPayload = await this.tenant.decryptPayload(
              entryData.encryptedData,
              entryData.decryptionKeyId
            );
            return { entryData, decryptedPayload };
          })
        );
        
        // Collect change bytes and register automerge hash mappings
        const changeBytes: Uint8Array[] = [];
        for (const { entryData, decryptedPayload } of decryptionResults) {
          changeBytes.push(decryptedPayload);
          
          // Register the automerge hash -> entry ID mapping for future dependency resolution
          const parsed = parseDocEntryId(entryData.id);
          if (parsed) {
            this.registerAutomergeHashMapping(docId, parsed.automergeHash, entryData.id);
          }
        }
        
        // Batch apply all changes at once - Automerge handles dependency ordering
        if (changeBytes.length > 0) {
          this.logger.debug(`Applying ${changeBytes.length} changes to document ${docId} using batch applyChanges`);
          try {
            const result = Automerge.applyChanges<MindooDocPayload>(doc!, changeBytes);
            doc = result[0] as AutomergeTypes.Doc<MindooDocPayload>;
            this.logger.debug(`Successfully applied ${changeBytes.length} changes to document ${docId}`);
            this.logger.debug(`Document state after applying changes: heads=${JSON.stringify(Automerge.getHeads(doc!))}`);
          } catch (error) {
            this.logger.error(`Error applying changes to document ${docId}:`, error);
            this.logger.error(`Number of changes: ${changeBytes.length}`);
            throw error;
          }
        }
      }
    }
    
    // Extract metadata from document (doc is guaranteed to be defined at this point)
    this.logger.debug(`All entries applied successfully for document ${docId}`);
    this.logger.debug(`Final document heads: ${JSON.stringify(Automerge.getHeads(doc!))}`);
    const payload = doc! as unknown as MindooDocPayload;
    
    // Check if document was deleted by looking for a "doc_delete" type entry
    const hasDeleteEntry = allEntryMetadata.some(em => em.entryType === "doc_delete");
    const isDeleted = hasDeleteEntry;
    this.logger.debug(`Document ${docId} isDeleted: ${isDeleted}`);
    
    const decryptionKeyId = (payload._decryptionKeyId as string) || "default";
    // Get lastModified from payload, or use the timestamp of the last entry
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastModified = (payload._lastModified as number) || 
                         (lastEntry ? lastEntry.createdAt : Date.now());
    // Get createdAt from the first entry
    const firstEntry = allEntryMetadata.length > 0 ? allEntryMetadata[0] : null;
    const createdAt = firstEntry ? firstEntry.createdAt : lastModified;
    
    this.logger.debug(`Document ${docId} metadata: createdAt=${createdAt}, lastModified=${lastModified}, decryptionKeyId=${decryptionKeyId}`);
    
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
    this.logger.debug(`===== Successfully loaded document ${docId} and cached it =====`);
    
    return internalDoc;
  }


  /**
   * Convert an Automerge document to a plain JS object, converting Text objects to strings.
   * If using native Automerge (react-native-automerge-generated), this uses the native
   * materialize() method which properly converts Text objects to strings.
   * Falls back to direct access if native backend is not available.
   */
  private convertAutomergeToJS(doc: AutomergeTypes.Doc<MindooDocPayload>): MindooDocPayload {
    // Check if this document has a native Automerge handle attached
    // The native implementation attaches metadata with Symbol.for('_am_meta')
    const STATE = Symbol.for('_am_meta');
    const meta = (doc as any)[STATE];

    if (meta && meta.handle && typeof meta.handle.materialize === 'function') {
      // Use native materialize() which properly converts Text objects to strings
      try {
        const materialized = meta.handle.materialize('/');
        return materialized as MindooDocPayload;
      } catch (error) {
        console.error('[MindooDB] Failed to materialize document:', error);
        // Fall through to direct access
      }
    }

    // Fallback: direct access (for WASM or if native fails)
    const result: Record<string, any> = {};
    const keys = Object.keys(doc);

    for (const key of keys) {
      const value = (doc as any)[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
        result[key] = this.convertAutomergeToJS(value as AutomergeTypes.Doc<MindooDocPayload>);
      } else if (Array.isArray(value)) {
        result[key] = value.map(item => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item) && !(item instanceof Uint8Array)) {
            return this.convertAutomergeToJS(item as AutomergeTypes.Doc<MindooDocPayload>);
          }
          return item;
        });
      } else {
        result[key] = value;
      }
    }

    return result as MindooDocPayload;
  }

  /**
   * Wrap an internal document in the MindooDoc interface.
   * This is the read-only wrapper - write methods throw errors.
   */
  private wrapDocument(internalDoc: InternalDoc): MindooDoc {
    const db = this;
    const docId = internalDoc.id;

    // Create a read-only proxy that throws on any modification attempts
    const createReadOnlyProxy = (target: MindooDocPayload): MindooDocPayload => {
      return new Proxy(target, {
        set: (_target, prop) => {
          throw new Error(`Cannot modify property '${String(prop)}' on read-only document. Use changeDoc() to modify documents.`);
        },
        deleteProperty: (_target, prop) => {
          throw new Error(`Cannot delete property '${String(prop)}' on read-only document. Use changeDoc() to modify documents.`);
        },
        get: (target, prop) => {
          const value = (target as Record<string | symbol, unknown>)[prop];
          // Recursively wrap nested objects (but not arrays or special types)
          if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
            return createReadOnlyProxy(value as MindooDocPayload);
          }
          return value;
        },
      }) as MindooDocPayload;
    };

    return {
      getDatabase: () => db,
      getId: () => docId,
      getCreatedAt: () => internalDoc.createdAt,
      getLastModified: () => internalDoc.lastModified,
      isDeleted: () => internalDoc.isDeleted,
      getData: () => {
        // Convert Automerge document to plain JS object, converting Text objects to strings
        const jsDoc = this.convertAutomergeToJS(internalDoc.doc);
        return createReadOnlyProxy(jsDoc);
      },
      
      // ========== Attachment Write Methods ==========
      // These throw errors in the read-only wrapper
      
      addAttachment: async () => {
        throw new Error("addAttachment() can only be called within changeDoc() callback");
      },
      
      addAttachmentStream: async () => {
        throw new Error("addAttachmentStream() can only be called within changeDoc() callback");
      },
      
      removeAttachment: async () => {
        throw new Error("removeAttachment() can only be called within changeDoc() callback");
      },
      
      appendToAttachment: async () => {
        throw new Error("appendToAttachment() can only be called within changeDoc() callback");
      },
      
      // ========== Attachment Read Methods ==========
      // These work in the read-only wrapper
      
      getAttachments: (): AttachmentReference[] => {
        const payload = internalDoc.doc as unknown as MindooDocPayload;
        return (payload._attachments as AttachmentReference[]) || [];
      },
      
      getAttachment: async (attachmentId: string): Promise<Uint8Array> => {
        return db.getAttachmentInternal(docId, attachmentId);
      },
      
      getAttachmentRange: async (
        attachmentId: string,
        startByte: number,
        endByte: number
      ): Promise<Uint8Array> => {
        return db.getAttachmentRangeInternal(docId, attachmentId, startByte, endByte);
      },
      
      streamAttachment: (
        attachmentId: string,
        startOffset: number = 0
      ): AsyncGenerator<Uint8Array, void, unknown> => {
        return db.streamAttachmentInternal(docId, attachmentId, startOffset);
      },
    };
  }

  /**
   * Get an attachment reference by ID from a document's _attachments array.
   */
  private getAttachmentRefInternal(docId: string, attachmentId: string): AttachmentReference {
    const internalDoc = this.docCache.get(docId);
    if (!internalDoc) {
      throw new Error(`Document ${docId} not found in cache`);
    }
    const payload = internalDoc.doc as unknown as MindooDocPayload;
    const attachments = (payload._attachments as AttachmentReference[]) || [];
    const ref = attachments.find(a => a.attachmentId === attachmentId);
    if (!ref) {
      throw new Error(`Attachment ${attachmentId} not found in document ${docId}`);
    }
    return ref;
  }

  /**
   * Internal method to fetch and concatenate all chunks for an attachment.
   */
  private async getAttachmentInternal(
    docId: string, 
    attachmentId: string
  ): Promise<Uint8Array> {
    this.logger.debug(`Getting attachment ${attachmentId} from document ${docId}`);
    
    const ref = this.getAttachmentRefInternal(docId, attachmentId);
    const store = this.getEffectiveAttachmentStore();
    
    // Resolve dependency chain to get all chunk IDs in order (oldest first)
    const chunkIds = await store.resolveDependencies(ref.lastChunkId, { includeStart: true });
    this.logger.debug(`Resolved ${chunkIds.length} chunks for attachment ${attachmentId}`);
    
    // Fetch all chunks
    const chunks = await store.getEntries(chunkIds);
    
    // Verify signatures, decrypt, and collect plaintext chunks
    const plaintextChunks: Uint8Array[] = [];
    let totalSize = 0;
    
    for (const chunk of chunks) {
      // Admin-only mode: only accept chunks signed by the admin key
      if (this._isAdminOnlyDb && chunk.createdByPublicKey !== this.getAdminPublicKey()) {
        throw new Error(`Admin-only DB: chunk ${chunk.id} not signed by admin key`);
      }
      
      // Verify signature
      const isValid = await this.tenant.verifySignature(
        chunk.encryptedData,
        chunk.signature,
        chunk.createdByPublicKey
      );
      if (!isValid) {
        throw new Error(`Invalid signature for chunk ${chunk.id}`);
      }
      
      // Decrypt
      const plaintext = await this.tenant.decryptAttachmentPayload(
        chunk.encryptedData,
        chunk.decryptionKeyId
      );
      plaintextChunks.push(plaintext);
      totalSize += plaintext.length;
    }
    
    // Concatenate all chunks into final result
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of plaintextChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    this.logger.debug(`Retrieved attachment ${attachmentId}: ${result.length} bytes`);
    return result;
  }

  /**
   * Internal method to get a byte range from an attachment.
   */
  private async getAttachmentRangeInternal(
    docId: string,
    attachmentId: string,
    startByte: number,
    endByte: number
  ): Promise<Uint8Array> {
    this.logger.debug(`Getting attachment ${attachmentId} range [${startByte}, ${endByte}) from document ${docId}`);
    
    if (startByte < 0 || endByte <= startByte) {
      throw new Error(`Invalid byte range: [${startByte}, ${endByte})`);
    }
    
    const ref = this.getAttachmentRefInternal(docId, attachmentId);
    
    if (endByte > ref.size) {
      throw new Error(`End byte ${endByte} exceeds attachment size ${ref.size}`);
    }
    
    const store = this.getEffectiveAttachmentStore();
    const chunkSize = this.chunkSizeBytes;
    
    // Calculate which chunks we need
    const startChunkIndex = Math.floor(startByte / chunkSize);
    const endChunkIndex = Math.floor((endByte - 1) / chunkSize);
    
    // Resolve dependency chain to get all chunk IDs
    const allChunkIds = await store.resolveDependencies(ref.lastChunkId, { includeStart: true });
    
    // Get only the chunks we need
    const neededChunkIds = allChunkIds.slice(startChunkIndex, endChunkIndex + 1);
    const chunks = await store.getEntries(neededChunkIds);
    
    // Decrypt needed chunks
    const plaintextChunks: Uint8Array[] = [];
    for (const chunk of chunks) {
      // Admin-only mode: only accept chunks signed by the admin key
      if (this._isAdminOnlyDb && chunk.createdByPublicKey !== this.getAdminPublicKey()) {
        throw new Error(`Admin-only DB: chunk ${chunk.id} not signed by admin key`);
      }
      
      // Verify signature
      const isValid = await this.tenant.verifySignature(
        chunk.encryptedData,
        chunk.signature,
        chunk.createdByPublicKey
      );
      if (!isValid) {
        throw new Error(`Invalid signature for chunk ${chunk.id}`);
      }
      
      // Decrypt
      const plaintext = await this.tenant.decryptAttachmentPayload(
        chunk.encryptedData,
        chunk.decryptionKeyId
      );
      plaintextChunks.push(plaintext);
    }
    
    // Calculate offsets within the fetched chunks
    const offsetInFirstChunk = startByte - (startChunkIndex * chunkSize);
    const totalNeededBytes = endByte - startByte;
    
    // Extract the requested range
    const result = new Uint8Array(totalNeededBytes);
    let resultOffset = 0;
    let bytesRemaining = totalNeededBytes;
    
    for (let i = 0; i < plaintextChunks.length && bytesRemaining > 0; i++) {
      const chunk = plaintextChunks[i];
      const chunkStart = i === 0 ? offsetInFirstChunk : 0;
      const bytesToCopy = Math.min(chunk.length - chunkStart, bytesRemaining);
      result.set(chunk.slice(chunkStart, chunkStart + bytesToCopy), resultOffset);
      resultOffset += bytesToCopy;
      bytesRemaining -= bytesToCopy;
    }
    
    this.logger.debug(`Retrieved attachment ${attachmentId} range: ${result.length} bytes`);
    return result;
  }

  /**
   * Internal async generator to stream attachment data.
   */
  private async *streamAttachmentInternal(
    docId: string,
    attachmentId: string,
    startOffset: number
  ): AsyncGenerator<Uint8Array, void, unknown> {
    this.logger.debug(`Streaming attachment ${attachmentId} from offset ${startOffset}`);
    
    const ref = this.getAttachmentRefInternal(docId, attachmentId);
    const store = this.getEffectiveAttachmentStore();
    const chunkSize = this.chunkSizeBytes;
    
    // Calculate starting chunk
    const startChunkIndex = Math.floor(startOffset / chunkSize);
    const offsetInStartChunk = startOffset % chunkSize;
    
    // Resolve dependency chain to get all chunk IDs
    const allChunkIds = await store.resolveDependencies(ref.lastChunkId, { includeStart: true });
    
    // Stream chunks starting from startChunkIndex
    for (let i = startChunkIndex; i < allChunkIds.length; i++) {
      const [chunk] = await store.getEntries([allChunkIds[i]]);
      
      // Admin-only mode: only accept chunks signed by the admin key
      if (this._isAdminOnlyDb && chunk.createdByPublicKey !== this.getAdminPublicKey()) {
        throw new Error(`Admin-only DB: chunk ${chunk.id} not signed by admin key`);
      }
      
      // Verify signature
      const isValid = await this.tenant.verifySignature(
        chunk.encryptedData,
        chunk.signature,
        chunk.createdByPublicKey
      );
      if (!isValid) {
        throw new Error(`Invalid signature for chunk ${chunk.id}`);
      }
      
      // Decrypt
      const plaintext = await this.tenant.decryptAttachmentPayload(
        chunk.encryptedData,
        chunk.decryptionKeyId
      );
      
      // For first chunk, skip bytes before startOffset
      if (i === startChunkIndex && offsetInStartChunk > 0) {
        yield plaintext.slice(offsetInStartChunk);
      } else {
        yield plaintext;
      }
    }
    
    this.logger.debug(`Finished streaming attachment ${attachmentId}`);
  }

  /**
   * Get the effective attachment store (attachment store if configured, otherwise doc store).
   */
  private getEffectiveAttachmentStore(): ContentAddressedStore {
    return this.attachmentStore || this.store;
  }

  /**
   * Internal method to add an attachment by chunking the file and storing chunks.
   */
  private async addAttachmentInternal(
    docId: string,
    fileData: Uint8Array,
    fileName: string,
    mimeType: string,
    decryptionKeyId: string,
    createdAt: number
  ): Promise<AttachmentReference> {
    this.logger.debug(`Adding attachment to document ${docId}: ${fileName} (${fileData.length} bytes)`);
    
    const store = this.getEffectiveAttachmentStore();
    const currentUser = await this.tenant.getCurrentUserId();
    const attachmentId = generateFileUuid7();
    
    // Chunk the file
    const chunks: StoreEntry[] = [];
    let prevChunkId: string | null = null;
    let lastChunkId: string = "";
    
    for (let offset = 0; offset < fileData.length; offset += this.chunkSizeBytes) {
      const chunkData = fileData.slice(offset, Math.min(offset + this.chunkSizeBytes, fileData.length));
      
      // Encrypt chunk
      const encryptedData = await this.tenant.encryptAttachmentPayload(chunkData, decryptionKeyId);
      
      // Compute content hash
      const contentHash = await computeContentHash(encryptedData, this.getSubtle());
      
      // Generate chunk ID
      const chunkId = generateAttachmentChunkId(docId, attachmentId);
      lastChunkId = chunkId;
      
      // Sign the encrypted chunk
      const signature = await this.tenant.signPayload(encryptedData);
      
      // Create chunk entry
      const chunkEntry: StoreEntry = {
        entryType: "attachment_chunk",
        id: chunkId,
        contentHash,
        docId,
        dependencyIds: prevChunkId ? [prevChunkId] : [],
        createdAt,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };
      
      chunks.push(chunkEntry);
      prevChunkId = chunkId;
    }
    
    // Store all chunks
    await store.putEntries(chunks);
    this.logger.debug(`Stored ${chunks.length} chunks for attachment ${attachmentId}`);
    
    // Create attachment reference
    const ref: AttachmentReference = {
      attachmentId,
      fileName,
      mimeType,
      size: fileData.length,
      lastChunkId,
      decryptionKeyId,
      createdAt,
      createdBy: currentUser.userSigningPublicKey,
    };
    
    return ref;
  }

  /**
   * Internal method to add an attachment from a streaming data source.
   * Memory efficient - processes data chunk by chunk without loading entire file into memory.
   */
  private async addAttachmentStreamInternal(
    docId: string,
    dataStream: AsyncIterable<Uint8Array>,
    fileName: string,
    mimeType: string,
    decryptionKeyId: string,
    createdAt: number
  ): Promise<AttachmentReference> {
    this.logger.debug(`Adding streaming attachment to document ${docId}: ${fileName}`);
    
    const store = this.getEffectiveAttachmentStore();
    const currentUser = await this.tenant.getCurrentUserId();
    const attachmentId = generateFileUuid7();
    
    // Buffer to accumulate incoming data until we have a full chunk
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let totalSize = 0;
    let prevChunkId: string | null = null;
    let lastChunkId: string = "";
    let chunkCount = 0;
    
    // Helper to concatenate Uint8Arrays
    const concatArrays = (a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> => {
      const result = new Uint8Array(a.length + b.length);
      result.set(a, 0);
      result.set(b, a.length);
      return result;
    };
    
    // Helper to store a chunk
    const storeChunk = async (chunkData: Uint8Array): Promise<string> => {
      // Encrypt chunk
      const encryptedData = await this.tenant.encryptAttachmentPayload(chunkData, decryptionKeyId);
      
      // Compute content hash
      const contentHash = await computeContentHash(encryptedData, this.getSubtle());
      
      // Generate chunk ID
      const chunkId = generateAttachmentChunkId(docId, attachmentId);
      
      // Sign the encrypted chunk
      const signature = await this.tenant.signPayload(encryptedData);
      
      // Create chunk entry
      const chunkEntry: StoreEntry = {
        entryType: "attachment_chunk",
        id: chunkId,
        contentHash,
        docId,
        dependencyIds: prevChunkId ? [prevChunkId] : [],
        createdAt,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };
      
      // Store immediately (streaming - don't buffer chunks in memory)
      await store.putEntries([chunkEntry]);
      chunkCount++;
      
      return chunkId;
    };
    
    // Process incoming data stream
    for await (const chunk of dataStream) {
      // Add incoming data to buffer
      buffer = concatArrays(buffer, chunk);
      
      // Process complete chunks
      while (buffer.length >= this.chunkSizeBytes) {
        const chunkData = buffer.slice(0, this.chunkSizeBytes);
        buffer = buffer.slice(this.chunkSizeBytes);
        
        lastChunkId = await storeChunk(chunkData);
        prevChunkId = lastChunkId;
        totalSize += chunkData.length;
      }
    }
    
    // Store remaining data as final chunk (if any)
    if (buffer.length > 0) {
      lastChunkId = await storeChunk(buffer);
      totalSize += buffer.length;
    }
    
    this.logger.debug(`Stored ${chunkCount} chunks for streaming attachment ${attachmentId} (${totalSize} bytes)`);
    
    // Create attachment reference
    const ref: AttachmentReference = {
      attachmentId,
      fileName,
      mimeType,
      size: totalSize,
      lastChunkId,
      decryptionKeyId,
      createdAt,
      createdBy: currentUser.userSigningPublicKey,
    };
    
    return ref;
  }

  /**
   * Internal method to append data to an existing attachment.
   */
  private async appendToAttachmentInternal(
    docId: string,
    attachmentId: string,
    decryptionKeyId: string,
    prevLastChunkId: string,
    data: Uint8Array,
    createdAt: number
  ): Promise<{ lastChunkId: string; sizeIncrease: number }> {
    this.logger.debug(`Appending ${data.length} bytes to attachment ${attachmentId}`);
    
    const store = this.getEffectiveAttachmentStore();
    const currentUser = await this.tenant.getCurrentUserId();
    
    // Chunk the data
    const chunks: StoreEntry[] = [];
    let prevChunkId = prevLastChunkId;
    let lastChunkId = prevLastChunkId;
    
    for (let offset = 0; offset < data.length; offset += this.chunkSizeBytes) {
      const chunkData = data.slice(offset, Math.min(offset + this.chunkSizeBytes, data.length));
      
      // Encrypt chunk
      const encryptedData = await this.tenant.encryptAttachmentPayload(chunkData, decryptionKeyId);
      
      // Compute content hash
      const contentHash = await computeContentHash(encryptedData, this.getSubtle());
      
      // Generate chunk ID
      const chunkId = generateAttachmentChunkId(docId, attachmentId);
      lastChunkId = chunkId;
      
      // Sign the encrypted chunk
      const signature = await this.tenant.signPayload(encryptedData);
      
      // Create chunk entry with dependency on previous chunk
      const chunkEntry: StoreEntry = {
        entryType: "attachment_chunk",
        id: chunkId,
        contentHash,
        docId,
        dependencyIds: [prevChunkId],
        createdAt,
        createdByPublicKey: currentUser.userSigningPublicKey,
        decryptionKeyId,
        signature,
        originalSize: chunkData.length,
        encryptedSize: encryptedData.length,
        encryptedData,
      };
      
      chunks.push(chunkEntry);
      prevChunkId = chunkId;
    }
    
    // Store all chunks
    await store.putEntries(chunks);
    this.logger.debug(`Appended ${chunks.length} chunks to attachment ${attachmentId}`);
    
    return {
      lastChunkId,
      sizeIncrease: data.length,
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

    this.logger.info(`Pulling entries from remote store ${remoteStore.getId()}`);
    
    const transferred = await this.syncEntriesFromStore(remoteStore, this.store);
    this.logger.debug(`Transferred ${transferred} entries from remote store`);

    if (transferred === 0) {
      this.logger.debug(`No new entries to pull`);
      return;
    }
    
    // Sync the local store to process the new entries
    // This will update the index, cache, and processedEntryIds
    await this.syncStoreChanges();
    
    this.logger.info(`Pull complete, synced ${transferred} entries`);
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

    this.logger.info(`Pushing entries to remote store ${remoteStore.getId()}`);
    
    const transferred = await this.syncEntriesFromStore(this.store, remoteStore);
    this.logger.debug(`Transferred ${transferred} entries to remote store`);

    if (transferred === 0) {
      this.logger.debug(`No new entries to push`);
      return;
    }

    this.logger.info(`Pushed ${transferred} entries to remote store`);
  }
}

