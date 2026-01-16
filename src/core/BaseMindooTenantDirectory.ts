import { EncryptedPrivateKey, MindooDB, MindooDoc, MindooTenant, MindooTenantDirectory, ProcessChangesCursor, PublicUserId, SigningKeyPair } from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";

export class BaseMindooTenantDirectory implements MindooTenantDirectory {
  private tenant: BaseMindooTenant;
  private directoryDB: MindooDB | null = null;
  
  // Cache for trusted public keys: key -> isActive (true = granted, false = revoked)
  // This cache is updated incrementally as changes are processed
  // Note: No recursion guard needed because directory DB is admin-only,
  // so loading entries doesn't trigger validatePublicSigningKey recursively
  private trustedKeysCache: Map<string, boolean> = new Map();
  private cacheLastCursor: ProcessChangesCursor | null = null;
  // Mapping from grant document ID to public key (needed for revocation lookups)
  private grantDocIdToPublicKey: Map<string, string> = new Map();

  // Cache for settings documents
  private tenantSettingsCache: MindooDoc | null = null;
  private dbSettingsCache: Map<string, MindooDoc> = new Map();
  private settingsCacheLastCursor: ProcessChangesCursor | null = null;

  // Centralized field lists for signing/verification
  private static readonly GRANT_ACCESS_SIGNED_FIELDS: string[] = [
    "form",
    "type",
    "username",
    "userSigningPublicKey",
    "userEncryptionPublicKey",
    "adminSignatureFields",
  ];

  private static readonly REVOKE_ACCESS_SIGNED_FIELDS: string[] = [
    "form",
    "type",
    "username",
    "revokeDocId",
    "adminSignatureFields",
  ];

  private static readonly REQUEST_DOC_HISTORY_PURGE_SIGNED_FIELDS: string[] = [
    "form",
    "type",
    "dbId",
    "docId",
    "reason",
    "requestedAt",
    "adminSignatureFields",
  ];

  constructor(tenant: BaseMindooTenant) {
    this.tenant = tenant;
  }

  /**
   * Helper method to convert base64 string to Uint8Array.
   * This is needed because base64ToUint8Array is protected in BaseMindooTenant.
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async getDirectoryDB(): Promise<MindooDB> {
    if (!this.directoryDB) {
      // Open directory DB with admin-only flag (also enforced at tenant level)
      this.directoryDB = await this.tenant.openDB("directory", { adminOnlyDb: true });
      
      // Defensive check: verify the DB was opened with admin-only mode
      // This is a security invariant that must always hold
      if (!this.directoryDB.isAdminOnlyDb()) {
        throw new Error("Directory database must be opened with adminOnlyDb=true for security");
      }
    }
    return this.directoryDB;
  }

  async registerUser(
    userId: PublicUserId,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenantDirectory] Registering user: ${userId.username}`);

    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;

    // Create SigningKeyPair for the administration key
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };

    // Create doc signer for administration key
    const docSigner = this.tenant.createDocSignerFor(adminSigningKeyPair);

    // Add user to directory database
    console.log(`[BaseMindooTenantDirectory] Creating document for user registration`);
    const directoryDB = await this.getDirectoryDB();
    // Create document with admin signing key so the initial entry is trusted
    const newDoc = await directoryDB.createDocumentWithSigningKey(
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    console.log(`[BaseMindooTenantDirectory] Document created: ${newDoc.getId()}`);
    
    try {
      // Set the document data fields, sign, and store signature all in one changeDocWithSigningKey call
      // Using the admin signing key to sign the entry, so it's always trusted
      await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username = userId.username;
        data.userSigningPublicKey = userId.userSigningPublicKey;
        data.userEncryptionPublicKey = userId.userEncryptionPublicKey;

        data.adminSignatureFields = BaseMindooTenantDirectory.GRANT_ACCESS_SIGNED_FIELDS;

        // Sign the document items and store the signature
        const signature = await docSigner.signItems(
          doc,
          BaseMindooTenantDirectory.GRANT_ACCESS_SIGNED_FIELDS,
          administrationPrivateKeyPassword
        );
        data.adminSignature = baseTenant.uint8ArrayToBase64(signature);
      }, adminSigningKeyPair, administrationPrivateKeyPassword);
    } catch (error) {
      console.error(`[BaseMindooTenantDirectory] ERROR in changeDocWithSigningKey:`, error);
      console.error(`[BaseMindooTenantDirectory] Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
      console.error(`[BaseMindooTenantDirectory] Error message: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`[BaseMindooTenantDirectory] Error stack: ${error.stack}`);
      }
      throw error;
    }
    
    console.log(`[BaseMindooTenantDirectory] Registered user: ${userId.username}`);
  }

  async findGrantAccessDocuments(username: string): Promise<MindooDoc[]> {
    console.log(`[BaseMindooTenantDirectory] Finding grant access documents for username: ${username}`);
    
    // Sync changes to make sure everything is processed
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;
    
    // Get administration public key for signature verification
    const administrationPublicKey = baseTenant.getAdministrationPublicKey();
    
    // Create a docSigner for verification (we only need it for verifyItems, so we use a dummy SigningKeyPair)
    // The private key won't be used for verification
    const dummySigningKeyPair: SigningKeyPair = {
      publicKey: administrationPublicKey,
      privateKey: {
        ciphertext: "",
        iv: "",
        tag: "",
        salt: "",
        iterations: 0,
      },
    };
    const docSigner = this.tenant.createDocSignerFor(dummySigningKeyPair);
    
    const matchingDocs: MindooDoc[] = [];
    const revokedDocIds = new Set<string>();
    
    // Use the generator-based iteration API for cleaner code
    for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
      const data = doc.getData();
      
      // Check if this is a grant access document we're looking for
      if (data.form === "useroperation" && 
          data.type === "grantaccess" && 
          data.username === username) {
        // Verify the signature before including the document
        if (data.adminSignature && typeof data.adminSignature === "string" && data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              console.log(`[BaseMindooTenantDirectory] Found valid grant access document for username: ${username}`);
              matchingDocs.push(doc);
            } else {
              console.warn(`[BaseMindooTenantDirectory] Found grant access document with invalid signature for username: ${username}, skipping`);
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Error verifying grant access document signature:`, error);
            // Skip documents with signature verification errors
          }
        } else {
          console.warn(`[BaseMindooTenantDirectory] Found grant access document without signature for username: ${username}, skipping`);
        }
      }
      
      // Check if this is a revoke access document for the same username
      if (data.form === "useroperation" && 
          data.type === "revokeaccess" && 
          data.username === username &&
          data.revokeDocId &&
          typeof data.revokeDocId === "string") {
        // Verify the signature before processing the revocation
        if (data.adminSignature && typeof data.adminSignature === "string" && data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              console.log(`[BaseMindooTenantDirectory] Found valid revoke access document for username: ${username}, revoking doc ID: ${data.revokeDocId}`);
              revokedDocIds.add(data.revokeDocId);
            } else {
              console.warn(`[BaseMindooTenantDirectory] Found revoke access document with invalid signature for username: ${username}, skipping`);
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Error verifying revoke access document signature:`, error);
            // Skip documents with signature verification errors
          }
        } else {
          console.warn(`[BaseMindooTenantDirectory] Found revoke access document without signature for username: ${username}, skipping`);
        }
      }
    }
    
    // Filter out revoked documents
    const activeDocs = matchingDocs.filter(doc => !revokedDocIds.has(doc.getId()));
    
    if (activeDocs.length === 0) {
      console.log(`[BaseMindooTenantDirectory] No active grant access documents found for username: ${username} (found ${matchingDocs.length} total, ${revokedDocIds.size} revoked)`);
    } else {
      console.log(`[BaseMindooTenantDirectory] Found ${activeDocs.length} active grant access document(s) for username: ${username} (${matchingDocs.length} total, ${revokedDocIds.size} revoked)`);
    }
    
    return activeDocs;
  }

  async revokeUser(
    username: string,
    requestDataWipe: boolean,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenantDirectory] Revoking user: ${username}`);

    // Find all grant access documents for this user
    const grantAccessDocs = await this.findGrantAccessDocuments(username);
    
    // If no grant access documents found, exit early
    if (grantAccessDocs.length === 0) {
      console.log(`[BaseMindooTenantDirectory] No grant access documents found for ${username}, exiting revocation`);
      return;
    }

    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();

    // Create SigningKeyPair for the administration key
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };

    // Create doc signer for administration key
    const docSigner = this.tenant.createDocSignerFor(adminSigningKeyPair);

    // Create revocation documents for each grant access document found
    for (const grantAccessDoc of grantAccessDocs) {
      const revokeDocId = grantAccessDoc.getId();

      // Create document with admin signing key so the initial entry is trusted
      const newDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword
      );
      
      // Set the document data fields, sign, and store signature all in one changeDocWithSigningKey call
      // Using the admin signing key to sign the entry, so it's always trusted
      await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "revokeaccess";
        data.username = username;
        data.revokeDocId = revokeDocId;
        data.requestDataWipe = requestDataWipe;

        data.adminSignatureFields = BaseMindooTenantDirectory.REVOKE_ACCESS_SIGNED_FIELDS;

        // Sign the document items and store the signature
        const signature = await docSigner.signItems(
          doc,
          BaseMindooTenantDirectory.REVOKE_ACCESS_SIGNED_FIELDS,
          administrationPrivateKeyPassword
        );
        data.adminSignature = baseTenant.uint8ArrayToBase64(signature);
      }, adminSigningKeyPair, administrationPrivateKeyPassword);

      console.log(`[BaseMindooTenantDirectory] Created revocation document for grant access doc: ${revokeDocId}`);
    }
    
    console.log(`[BaseMindooTenantDirectory] Revoked user: ${username} (created ${grantAccessDocs.length} revocation document(s))`);
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    console.log(`[BaseMindooTenantDirectory] Validating public signing key`);
    
    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;
    
    // Get administration public key - this is always trusted as the root of trust
    const administrationPublicKey = baseTenant.getAdministrationPublicKey();
    
    // The administration key is always trusted - it's the root of trust for the tenant
    if (publicKey === administrationPublicKey) {
      console.log(`[BaseMindooTenantDirectory] Public key is administration key, trusted`);
      return true;
    }
    
    // Check cache first - if we have a cached result, return it after ensuring we're up to date
    // Sync changes to make sure everything is processed
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update cache with any new changes since last cursor
    await this.updateTrustedKeysCache(directoryDB, administrationPublicKey);
    
    // Now check the cache
    const cachedResult = this.trustedKeysCache.get(publicKey);
    if (cachedResult !== undefined) {
      console.log(`[BaseMindooTenantDirectory] Public key validation result (from cache): ${cachedResult}`);
      return cachedResult;
    }
    
    // Key not found in cache means it was never granted access
    console.log(`[BaseMindooTenantDirectory] Public key not found in cache, returning false`);
    return false;
  }
  
  /**
   * Update the trusted keys cache by processing new changes since the last cursor.
   * This method is called incrementally to keep the cache up to date.
   */
  private async updateTrustedKeysCache(
    directoryDB: MindooDB,
    administrationPublicKey: string
  ): Promise<void> {
    // Create a docSigner for verification (we only need it for verifyItems, so we use a dummy SigningKeyPair)
    // The private key won't be used for verification
    const dummySigningKeyPair: SigningKeyPair = {
      publicKey: administrationPublicKey,
      privateKey: {
        ciphertext: "",
        iv: "",
        tag: "",
        salt: "",
        iterations: 0,
      },
    };
    const docSigner = this.tenant.createDocSignerFor(dummySigningKeyPair);
    
    // Process changes since last cursor
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(this.cacheLastCursor, 100)) {
      const data = doc.getData();
      
      // Check if this is a grant access document
      if (data.form === "useroperation" && 
          data.type === "grantaccess" && 
          data.userSigningPublicKey &&
          typeof data.userSigningPublicKey === "string") {
        // Verify the signature before including the document
        if (data.adminSignature && typeof data.adminSignature === "string" && data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              const userPublicKey = data.userSigningPublicKey;
              console.log(`[BaseMindooTenantDirectory] Cache: adding trusted key from grant access document`);
              // Mark as active (true) unless already revoked
              if (!this.trustedKeysCache.has(userPublicKey) || this.trustedKeysCache.get(userPublicKey) === true) {
                this.trustedKeysCache.set(userPublicKey, true);
              }
              // Store mapping for future revocation lookups (persisted across iterations)
              this.grantDocIdToPublicKey.set(doc.getId(), userPublicKey);
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Cache: error verifying grant access document:`, error);
          }
        }
      }
      
      // Check if this is a revoke access document
      if (data.form === "useroperation" && 
          data.type === "revokeaccess" &&
          data.revokeDocId &&
          typeof data.revokeDocId === "string") {
        // Verify the signature before processing the revocation
        if (data.adminSignature && typeof data.adminSignature === "string" && data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              const revokedDocId = data.revokeDocId;
              // Find the public key for this grant doc ID and mark as revoked
              // Use the persistent mapping that survives across iterations
              const revokedPublicKey = this.grantDocIdToPublicKey.get(revokedDocId);
              if (revokedPublicKey) {
                console.log(`[BaseMindooTenantDirectory] Cache: revoking key for doc ${revokedDocId}`);
                this.trustedKeysCache.set(revokedPublicKey, false);
              } else {
                console.warn(`[BaseMindooTenantDirectory] Cache: revocation for unknown grant doc ${revokedDocId}`);
              }
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Cache: error verifying revoke access document:`, error);
          }
        }
      }
      
      // Update cursor after each document
      this.cacheLastCursor = cursor;
    }
  }

  /**
   * Get a user's public keys from the directory.
   * Used for authentication (signature verification) and encryption (transport encryption).
   * 
   * @param username The username to look up (format: "CN=<username>/O=<tenantId>")
   * @return The user's public keys, or null if user not found or has been revoked
   */
  async getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null> {
    console.log(`[BaseMindooTenantDirectory] Getting public keys for username: ${username}`);
    
    // Find all active (non-revoked) grant access documents for this user
    const activeDocs = await this.findGrantAccessDocuments(username);
    
    if (activeDocs.length === 0) {
      console.log(`[BaseMindooTenantDirectory] No active grant access documents found for username: ${username}`);
      return null;
    }
    
    // Use the last active grant access document (most recent registration)
    // In most cases there should only be one active grant access document per user
    const doc = activeDocs[activeDocs.length - 1];
    const data = doc.getData();
    
    const signingPublicKey = data.userSigningPublicKey;
    const encryptionPublicKey = data.userEncryptionPublicKey;
    
    if (typeof signingPublicKey !== "string" || typeof encryptionPublicKey !== "string") {
      console.error(`[BaseMindooTenantDirectory] Invalid key data in grant access document for username: ${username}`);
      return null;
    }
    
    console.log(`[BaseMindooTenantDirectory] Found public keys for username: ${username}`);
    return {
      signingPublicKey,
      encryptionPublicKey,
    };
  }

  /**
   * Check if a user has been revoked.
   * A user is considered revoked if they have no active (non-revoked) grant access documents.
   * 
   * @param username The username to check (format: "CN=<username>/O=<tenantId>")
   * @return True if the user has been revoked, false if they have active access
   */
  async isUserRevoked(username: string): Promise<boolean> {
    console.log(`[BaseMindooTenantDirectory] Checking if user is revoked: ${username}`);
    
    // Find all active grant access documents for this user
    const activeDocs = await this.findGrantAccessDocuments(username);
    
    // User is revoked if they have no active grant access documents
    const isRevoked = activeDocs.length === 0;
    
    console.log(`[BaseMindooTenantDirectory] User ${username} revoked: ${isRevoked}`);
    return isRevoked;
  }

  async requestDocHistoryPurge(
    dbId: string,
    docId: string,
    reason: string | undefined,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenantDirectory] Requesting purge for document: ${docId} in ${dbId}`);
    
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    
    const docSigner = this.tenant.createDocSignerFor(adminSigningKeyPair);
    
    // Create document with admin signing key so the initial entry is trusted
    const newDoc = await directoryDB.createDocumentWithSigningKey(
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Using the admin signing key to sign the entry, so it's always trusted
    await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
      const data = doc.getData();
      data.form = "useroperation";
      data.type = "requestdochistorypurge";
      data.dbId = dbId;
      data.docId = docId;
      if (reason) {
        data.reason = reason;
      }
      data.requestedAt = Date.now();
      
      data.adminSignatureFields = BaseMindooTenantDirectory.REQUEST_DOC_HISTORY_PURGE_SIGNED_FIELDS;
      
      const signature = await docSigner.signItems(
        doc,
        BaseMindooTenantDirectory.REQUEST_DOC_HISTORY_PURGE_SIGNED_FIELDS,
        administrationPrivateKeyPassword
      );
      data.adminSignature = baseTenant.uint8ArrayToBase64(signature);
    }, adminSigningKeyPair, administrationPrivateKeyPassword);
    
    console.log(`[BaseMindooTenantDirectory] Created purge request for ${docId} in ${dbId}`);
  }

  async getRequestedDocHistoryPurges(): Promise<Array<{
    dbId: string;
    docId: string;
    reason?: string;
    requestedAt: number;
    purgeRequestDocId: string;
  }>> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    const baseTenant = this.tenant as BaseMindooTenant;
    const administrationPublicKey = baseTenant.getAdministrationPublicKey();
    
    const dummySigningKeyPair: SigningKeyPair = {
      publicKey: administrationPublicKey,
      privateKey: {
        ciphertext: "",
        iv: "",
        tag: "",
        salt: "",
        iterations: 0,
      },
    };
    const docSigner = this.tenant.createDocSignerFor(dummySigningKeyPair);
    
    const purgeRequests: Array<{
      dbId: string;
      docId: string;
      reason?: string;
      requestedAt: number;
      purgeRequestDocId: string;
    }> = [];
    
    for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
      const data = doc.getData();
      
      if (data.form === "useroperation" && data.type === "requestdochistorypurge") {
        // Verify signature
        if (data.adminSignature && typeof data.adminSignature === "string" && 
            data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              const dbId = data.dbId;
              const docId = data.docId;
              const reason = data.reason;
              const requestedAt = data.requestedAt;
              
              if (typeof dbId === "string" && typeof docId === "string") {
                purgeRequests.push({
                  dbId: dbId,
                  docId: docId,
                  reason: typeof reason === "string" ? reason : undefined,
                  requestedAt: typeof requestedAt === "number" ? requestedAt : Date.now(),
                  purgeRequestDocId: doc.getId(),
                });
              }
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Error verifying purge request signature:`, error);
          }
        }
      }
    }
    
    return purgeRequests;
  }

  async getTenantSettings(): Promise<MindooDoc | null> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update cache if directory has new changes
    await this.updateSettingsCache(directoryDB);
    
    return this.tenantSettingsCache;
  }

  async getDBSettings(dbId: string): Promise<MindooDoc | null> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update cache if directory has new changes
    await this.updateSettingsCache(directoryDB);
    
    return this.dbSettingsCache.get(dbId) || null;
  }

  async changeTenantSettings(
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    
    // Get cached settings doc or create new one
    let settingsDoc = await this.getTenantSettings();
    
    if (!settingsDoc) {
      // Create new document
      settingsDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword
      );
    }
    
    // Apply changes and ensure form field is correct
    await directoryDB.changeDocWithSigningKey(
      settingsDoc,
      async (d: MindooDoc) => {
        // Call user's change function
        await changeFunc(d);
        
        // Ensure form field is always correct (overwrite if user changed it)
        d.getData().form = "tenantsettings";
      },
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Invalidate cache
    this.tenantSettingsCache = null;
    this.settingsCacheLastCursor = null;
  }

  async changeDBSettings(
    dbId: string,
    changeFunc: (doc: MindooDoc) => void | Promise<void>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    
    // Get cached settings doc for this dbId or create new one
    let settingsDoc = await this.getDBSettings(dbId);
    
    if (!settingsDoc) {
      // Create new document
      settingsDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword
      );
    }
    
    // Apply changes and ensure form and dbid fields are correct
    await directoryDB.changeDocWithSigningKey(
      settingsDoc,
      async (d: MindooDoc) => {
        // Call user's change function
        await changeFunc(d);
        
        // Ensure form and dbid fields are always correct (overwrite if user changed them)
        const data = d.getData();
        data.form = "dbsettings";
        data.dbid = dbId;
      },
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Invalidate cache for this dbId
    this.dbSettingsCache.delete(dbId);
    this.settingsCacheLastCursor = null;
  }

  private async updateSettingsCache(
    directoryDB: MindooDB
  ): Promise<void> {
    // Determine starting cursor (null = process all, otherwise incremental)
    const startCursor = this.settingsCacheLastCursor;
    
    // If processing from the beginning, clear caches first
    if (startCursor === null) {
      this.tenantSettingsCache = null;
      this.dbSettingsCache.clear();
    }
    
    // Process changes (documents are returned in order by lastModified, oldest to newest)
    // Since they're in order, we can just overwrite the cache with each document we see
    // The last one we see will be the latest
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(startCursor, 100)) {
      const data = doc.getData();
      
      // Process tenant settings (no signature verification needed - Automerge handles merging)
      if (data.form === "tenantsettings") {
        // Just overwrite - last one seen will be the latest
        this.tenantSettingsCache = doc;
      }
      
      // Process DB settings (no signature verification needed - Automerge handles merging)
      if (data.form === "dbsettings" && data.dbid && typeof data.dbid === "string") {
        const dbId = data.dbid;
        // Just overwrite - last one seen will be the latest
        this.dbSettingsCache.set(dbId, doc);
      }
      
      this.settingsCacheLastCursor = cursor;
    }
  }
}