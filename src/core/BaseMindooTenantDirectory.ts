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
  // Mapping from grant document ID to public key (needed for revocation lookups)
  private grantDocIdToPublicKey: Map<string, string> = new Map();

  // Cache for settings documents
  private tenantSettingsCache: MindooDoc | null = null;
  private dbSettingsCache: Map<string, MindooDoc> = new Map();

  // Cache for groups: key -> merged group data (key: lowercase groupName)
  // We store merged data separately to avoid mutating MindooDoc objects
  private groupsCache: Map<string, { docId: string; members: string[] }> = new Map();

  // Unified cache cursor for all document types
  private unifiedCacheLastCursor: ProcessChangesCursor | null = null;

  constructor(tenant: BaseMindooTenant) {
    this.tenant = tenant;
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
      // Set the document data fields - changeDocWithSigningKey handles signing at entry level
      await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username = userId.username;
        data.userSigningPublicKey = userId.userSigningPublicKey;
        data.userEncryptionPublicKey = userId.userEncryptionPublicKey;
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
    
    // Update unified cache to ensure we have latest data
    await this.updateUnifiedCache();
    
    const matchingDocs: MindooDoc[] = [];
    const revokedDocIds = new Set<string>();
    
    // Use the generator-based iteration API for cleaner code
    // No signature verification needed - DB already enforces admin-only
    for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
      const data = doc.getData();
      
      // Check if this is a grant access document we're looking for
      if (data.form === "useroperation" && 
          data.type === "grantaccess" && 
          data.username === username) {
        console.log(`[BaseMindooTenantDirectory] Found grant access document for username: ${username}`);
              matchingDocs.push(doc);
      }
      
      // Check if this is a revoke access document for the same username
      if (data.form === "useroperation" && 
          data.type === "revokeaccess" && 
          data.username === username &&
          data.revokeDocId &&
          typeof data.revokeDocId === "string") {
        console.log(`[BaseMindooTenantDirectory] Found revoke access document for username: ${username}, revoking doc ID: ${data.revokeDocId}`);
              revokedDocIds.add(data.revokeDocId);
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

    // Create revocation documents for each grant access document found
    for (const grantAccessDoc of grantAccessDocs) {
      const revokeDocId = grantAccessDoc.getId();

      // Create document with admin signing key so the initial entry is trusted
      const newDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword
      );
      
      // Set the document data fields - changeDocWithSigningKey handles signing at entry level
      await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "revokeaccess";
        data.username = username;
        data.revokeDocId = revokeDocId;
        data.requestDataWipe = requestDataWipe;
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
    
    // Update unified cache with any new changes since last cursor
    await this.updateUnifiedCache();
    
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
   * Update all caches (trusted keys, groups, settings) by processing new changes since the last cursor.
   * This unified method processes all document types in a single loop for efficiency.
   * No signature verification is needed since the DB already enforces admin-only access.
   */
  private async updateUnifiedCache(): Promise<void> {
    const directoryDB = await this.getDirectoryDB();
    // Determine starting cursor (null = process all, otherwise incremental)
    const startCursor = this.unifiedCacheLastCursor;
    
    // If processing from the beginning, clear all caches first
    if (startCursor === null) {
      this.trustedKeysCache.clear();
      this.grantDocIdToPublicKey.clear();
      this.tenantSettingsCache = null;
      this.dbSettingsCache.clear();
      this.groupsCache.clear();
    }
    
    // Track group documents by name for merging (handles offline sync scenarios)
    const groupDocsByName: Map<string, MindooDoc[]> = new Map();
    
    // Process changes (documents are returned in order by lastModified, oldest to newest)
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(startCursor, 100)) {
      const data = doc.getData();
      
      // Process user operation documents (grant/revoke access)
      if (data.form === "useroperation") {
      // Check if this is a grant access document
        if (data.type === "grantaccess" && 
          data.userSigningPublicKey &&
          typeof data.userSigningPublicKey === "string") {
              const userPublicKey = data.userSigningPublicKey;
              console.log(`[BaseMindooTenantDirectory] Cache: adding trusted key from grant access document`);
              // Mark as active (true) unless already revoked
              if (!this.trustedKeysCache.has(userPublicKey) || this.trustedKeysCache.get(userPublicKey) === true) {
                this.trustedKeysCache.set(userPublicKey, true);
              }
              // Store mapping for future revocation lookups (persisted across iterations)
              this.grantDocIdToPublicKey.set(doc.getId(), userPublicKey);
      }
      
      // Check if this is a revoke access document
        if (data.type === "revokeaccess" &&
          data.revokeDocId &&
          typeof data.revokeDocId === "string") {
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
      }
      
      // Process group documents
      if (data.form === "group" && 
          data.type === "group" &&
          data.groupName &&
          typeof data.groupName === "string") {
        const normalizedGroupName = this.normalizeGroupName(data.groupName);
        if (!groupDocsByName.has(normalizedGroupName)) {
          groupDocsByName.set(normalizedGroupName, []);
        }
        groupDocsByName.get(normalizedGroupName)!.push(doc);
      }
      
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
      
      // Update cursor after each document
      this.unifiedCacheLastCursor = cursor;
    }
    
    // Merge group documents with the same name
    for (const [normalizedGroupName, docs] of groupDocsByName.entries()) {
      // Collect all members from all documents with this group name
      const allMembers = new Set<string>();
      let latestDoc: MindooDoc | null = null;
      let isDeleted = false;
      
      for (const doc of docs) {
        const data = doc.getData();
        // Track the latest document (by iteration order, which is by lastModified)
        latestDoc = doc;
        // Check if document is deleted (via isDeleted() or _deleted flag in data)
        if (doc.isDeleted() || data._deleted === true) {
          isDeleted = true;
        }
        if (data.members && Array.isArray(data.members)) {
          for (const member of data.members) {
            if (typeof member === "string") {
              allMembers.add(member);
            }
          }
        }
      }
      
      // If latest version is deleted, remove from cache
      if (isDeleted) {
        this.groupsCache.delete(normalizedGroupName);
        continue;
      }
      
      // Store merged group data in cache (without mutating the MindooDoc)
      if (latestDoc) {
        this.groupsCache.set(normalizedGroupName, {
          docId: latestDoc.getId(),
          members: Array.from(allMembers),
        });
      }
    }
  }
  
  /**
   * Normalize group name to lowercase for case-insensitive comparison.
   */
  private normalizeGroupName(name: string): string {
    return name.toLowerCase();
  }

  /**
   * Generate username variants with wildcards for hierarchical matching.
   * For example: "CN=john/OU=team1/O=example.com" becomes an array containing:
   * - The original username
   * - Wildcard variants like "*\/OU=team1/O=example.com", "*\/O=example.com", and "*"
   */
  private generateUsernameVariants(username: string): string[] {
    const variants: string[] = [username]; // Start with original username
    
    // Parse the username format: CN=<name>/OU=<ou>/O=<org> (may have multiple OU components)
    // Split by '/' to get components
    const parts = username.split('/');
    
    // Generate variants by replacing prefixes with a single wildcard
    // For "CN=john/OU=team1/O=example.com":
    // - */OU=team1/O=example.com (skip CN)
    // - */O=example.com (skip CN and OU)
    for (let i = 1; i < parts.length; i++) {
      const suffixParts = parts.slice(i);
      variants.push('*/' + suffixParts.join('/'));
    }
    
    // Always add the final wildcard
    variants.push('*');
    
    return variants;
  }

  /**
   * Recursively resolve all groups that contain the given username (directly or via nested groups).
   * This resolves upwards: if user is in group A, and group A is in group B, then user is also in group B.
   * Stops on cycles with a console warning.
   */
  private async resolveGroupsForUser(username: string): Promise<string[]> {
    const resultGroups = new Set<string>();
    
    // Sync changes and update cache
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    
    // Generate username variants for matching
    const usernameVariants = this.generateUsernameVariants(username);
    const usernameVariantsLower = new Set(usernameVariants.map(v => v.toLowerCase()));
    
    // First pass: find all groups that directly contain the user or username variants
    const directGroups = new Set<string>();
    for (const [groupName, groupData] of this.groupsCache.entries()) {
      for (const member of groupData.members) {
        const memberLower = member.toLowerCase();
        if (usernameVariantsLower.has(memberLower)) {
          directGroups.add(groupName);
          resultGroups.add(groupName);
          break;
        }
      }
    }
    
    // Second pass: find parent groups (groups that contain the user's groups)
    // Keep iterating until no new groups are found
    let groupsToCheck = new Set(directGroups);
    const visitedGroups = new Set<string>(); // Track visited groups for cycle detection
    
    while (groupsToCheck.size > 0) {
      const nextGroups = new Set<string>();
      
      for (const childGroup of groupsToCheck) {
        // Skip if already checked (cycle detection)
        if (visitedGroups.has(childGroup)) {
          console.warn(`[BaseMindooTenantDirectory] Cycle detected in group resolution: ${childGroup} already visited, stopping recursion`);
          continue;
        }
        visitedGroups.add(childGroup);
        
        // Find all groups that contain this child group as a member
        for (const [parentGroupName, parentGroupData] of this.groupsCache.entries()) {
          if (resultGroups.has(parentGroupName)) {
            continue; // Already found this group
          }
          
          for (const member of parentGroupData.members) {
            if (member.toLowerCase() === childGroup) {
              resultGroups.add(parentGroupName);
              nextGroups.add(parentGroupName);
              break;
            }
          }
        }
      }
      
      groupsToCheck = nextGroups;
    }
    
    return Array.from(resultGroups);
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
    
    // Create document with admin signing key so the initial entry is trusted
    const newDoc = await directoryDB.createDocumentWithSigningKey(
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Set the document data fields - changeDocWithSigningKey handles signing at entry level
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
    
    const purgeRequests: Array<{
      dbId: string;
      docId: string;
      reason?: string;
      requestedAt: number;
      purgeRequestDocId: string;
    }> = [];
    
    // No signature verification needed - DB already enforces admin-only
    for await (const { doc } of directoryDB.iterateChangesSince(null, 100)) {
      const data = doc.getData();
      
      if (data.form === "useroperation" && data.type === "requestdochistorypurge") {
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
    }
    
    return purgeRequests;
  }

  async getTenantSettings(): Promise<MindooDoc | null> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update unified cache if directory has new changes
    await this.updateUnifiedCache();
    
    return this.tenantSettingsCache;
  }

  async getDBSettings(dbId: string): Promise<MindooDoc | null> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update unified cache if directory has new changes
    await this.updateUnifiedCache();
    
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
    this.unifiedCacheLastCursor = null;
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
    this.unifiedCacheLastCursor = null;
  }

  async getGroups(): Promise<string[]> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update unified cache to ensure we have latest data
    await this.updateUnifiedCache();
    
    // Return array of group names (keys from groupsCache)
    return Array.from(this.groupsCache.keys());
  }

  async getGroupMembers(groupName: string): Promise<string[]> {
    const normalizedGroupName = this.normalizeGroupName(groupName);
    
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update unified cache to ensure we have latest data
    await this.updateUnifiedCache();
    
    // Look up group in cache
    const groupData = this.groupsCache.get(normalizedGroupName);
    if (!groupData) {
      return [];
    }
    
    // Return a copy to prevent external modification of internal cache state
    return [...groupData.members];
  }

  async addUsersToGroup(
    groupName: string,
    username: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    const normalizedGroupName = this.normalizeGroupName(groupName);
    
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    
    // Get the actual document from the database (using cached docId if available)
    const cachedGroup = this.groupsCache.get(normalizedGroupName);
    let groupDoc: MindooDoc;
    
    if (cachedGroup) {
      // Load the actual document from the database
      groupDoc = await directoryDB.getDocument(cachedGroup.docId);
    } else {
      // Create new document
      groupDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword
      );
    }
    
    // Apply changes and ensure form, type, and groupName fields are correct
    await directoryDB.changeDocWithSigningKey(
      groupDoc,
      async (d: MindooDoc) => {
        const data = d.getData();
        
        // Initialize members array if it doesn't exist
        if (!data.members || !Array.isArray(data.members)) {
          data.members = [];
        }
        
        // Add users to members array (avoid duplicates)
        const existingMembers = Array.isArray(data.members) 
          ? data.members.filter((m): m is string => typeof m === "string")
          : [];
        const membersSet = new Set(existingMembers);
        for (const user of username) {
          membersSet.add(user);
        }
        data.members = Array.from(membersSet);
        
        // Ensure form, type, and groupName fields are always correct
        data.form = "group";
        data.type = "group";
        data.groupName = normalizedGroupName;
      },
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Invalidate cache for this group
    this.groupsCache.delete(normalizedGroupName);
    this.unifiedCacheLastCursor = null;
  }

  async removeUsersFromGroup(
    groupName: string,
    username: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    const normalizedGroupName = this.normalizeGroupName(groupName);
    
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    
    // Sync and update cache to get latest group
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    
    // Get group from cache
    const cachedGroup = this.groupsCache.get(normalizedGroupName);
    if (!cachedGroup) {
      // Group doesn't exist, nothing to do
      return;
    }
    
    // Load the actual document from the database
    const groupDoc = await directoryDB.getDocument(cachedGroup.docId);
    
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    
    // Remove users from members array
    await directoryDB.changeDocWithSigningKey(
      groupDoc,
      async (d: MindooDoc) => {
        const data = d.getData();
        
        if (!data.members || !Array.isArray(data.members)) {
          return;
        }
        
        // Filter out users to remove
        const usersToRemove = new Set(username);
        const membersArray = data.members as unknown[];
        data.members = membersArray.filter((m: unknown) => {
          if (typeof m !== "string") {
            return true; // Keep non-string members
          }
          return !usersToRemove.has(m);
        });
        
        // Ensure form, type, and groupName fields are always correct
        data.form = "group";
        data.type = "group";
        data.groupName = normalizedGroupName;
      },
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Invalidate cache for this group
    this.groupsCache.delete(normalizedGroupName);
    this.unifiedCacheLastCursor = null;
  }

  async deleteGroup(
    groupName: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    const normalizedGroupName = this.normalizeGroupName(groupName);
    
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    
    // Sync and update cache to get latest group
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    
    // Get group from cache
    const cachedGroup = this.groupsCache.get(normalizedGroupName);
    if (!cachedGroup) {
      // Group doesn't exist, nothing to do
      return;
    }
    
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    
    // Delete the document using the proper API
    await directoryDB.deleteDocumentWithSigningKey(
      cachedGroup.docId,
      adminSigningKeyPair,
      administrationPrivateKeyPassword
    );
    
    // Remove from cache
    this.groupsCache.delete(normalizedGroupName);
    this.unifiedCacheLastCursor = null;
  }

  async getUserNamesList(username: string): Promise<string[]> {
    // Generate username variants (wildcards)
    const usernameVariants = this.generateUsernameVariants(username);
    const result = new Set<string>(usernameVariants);
    
    // Find all groups containing the username (directly or via nested groups)
    const groups = await this.resolveGroupsForUser(username);
    
    // Add all groups to result
    for (const group of groups) {
      result.add(group);
    }
    
    return Array.from(result);
  }
}