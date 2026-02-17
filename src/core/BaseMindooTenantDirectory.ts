import { EncryptedPrivateKey, MindooDB, MindooDoc, MindooTenant, MindooTenantDirectory, ProcessChangesCursor, PublicUserId, SigningKeyPair, PUBLIC_INFOS_KEY_ID } from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";
import { RSAEncryption } from "./crypto/RSAEncryption";
import { Logger, MindooLogger, getDefaultLogLevel } from "./logging";

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
  // members_hashes are used for lookups, members_encrypted only admin can decrypt
  private groupsCache: Map<string, { docId: string; members_hashes: string[] }> = new Map();

  // Unified cache cursor for all document types
  private unifiedCacheLastCursor: ProcessChangesCursor | null = null;
  private logger: Logger;

  constructor(tenant: BaseMindooTenant, logger?: Logger) {
    this.tenant = tenant;
    // Create logger if not provided (for backward compatibility)
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "BaseMindooTenantDirectory", true);
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
    this.logger.info(`Registering user: ${userId.username}`);

    // Check if user with same username (case-insensitive) already exists
    const existingDocs = await this.findGrantAccessDocuments(userId.username);
    if (existingDocs.length > 0) {
      // Check if the keys match the existing registration
      const existingDoc = existingDocs[existingDocs.length - 1]; // Use most recent
      const existingData = existingDoc.getData();
      
      const keysMatch = 
        existingData.userSigningPublicKey === userId.userSigningPublicKey &&
        existingData.userEncryptionPublicKey === userId.userEncryptionPublicKey;
      
      if (keysMatch) {
        // Same user with same keys - skip re-registration
        this.logger.debug(`User ${userId.username} already registered with same keys, skipping`);
        return;
      } else {
        // Different keys for same username - this is an error
        throw new Error(
          `Cannot register user "${userId.username}": a user with the same username (case-insensitive) ` +
          `is already registered with different keys`
        );
      }
    }

    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;

    // Create SigningKeyPair for the administration key
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };

    // Compute username hash and encrypted username before creating the document
    // (since the callback to changeDocWithSigningKey cannot be async for automerge reasons)
    const usernameHash = await this.hashUsername(userId.username);
    const usernameEncrypted = await this.encryptForAdmin(userId.username);

    // Add user to directory database
    this.logger.debug(`Creating document for user registration`);
    const directoryDB = await this.getDirectoryDB();
    // Create document with admin signing key so the initial entry is trusted
    // Use PUBLIC_INFOS_KEY_ID so servers can validate users without full tenant access
    const newDoc = await directoryDB.createDocumentWithSigningKey(
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
      PUBLIC_INFOS_KEY_ID
    );
    this.logger.debug(`Document created: ${newDoc.getId()}`);
    
    try {
      // Set the document data fields - changeDocWithSigningKey handles signing at entry level
      await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username_hash = usernameHash;
        data.username_encrypted = usernameEncrypted;
        data.userSigningPublicKey = userId.userSigningPublicKey;
        data.userEncryptionPublicKey = userId.userEncryptionPublicKey;
      }, adminSigningKeyPair, administrationPrivateKeyPassword);
    } catch (error) {
      this.logger.error(`ERROR in changeDocWithSigningKey:`, error);
      throw error;
    }
    
    this.logger.info(`Registered user: ${userId.username}`);
  }

  async findGrantAccessDocuments(username: string): Promise<MindooDoc[]> {
    this.logger.debug(`Finding grant access documents for username: ${username}`);
    
    // Sync changes to make sure everything is processed
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    
    // Update unified cache to ensure we have latest data
    await this.updateUnifiedCache();
    
    // Compute the hash to search for
    const targetHash = await this.hashUsername(username);
    
    const matchingDocs: MindooDoc[] = [];
    const revokedDocIds = new Set<string>();
    
    // Use the generator-based iteration API for cleaner code
    // No signature verification needed - DB already enforces admin-only
    for await (const { doc } of directoryDB.iterateChangesSince(null)) {
      const data = doc.getData();
      
      // Check if this is a grant access document we're looking for (by username_hash)
      if (data.form === "useroperation" && 
          data.type === "grantaccess" && 
          data.username_hash === targetHash) {
        this.logger.debug(`Found grant access document for username hash: ${targetHash}`);
              matchingDocs.push(doc);
      }
      
      // Check if this is a revoke access document for the same username (by username_hash)
      if (data.form === "useroperation" && 
          data.type === "revokeaccess" && 
          data.username_hash === targetHash &&
          data.revokeDocId &&
          typeof data.revokeDocId === "string") {
        this.logger.debug(`Found revoke access document for username hash: ${targetHash}, revoking doc ID: ${data.revokeDocId}`);
              revokedDocIds.add(data.revokeDocId);
      }
    }
    
    // Filter out revoked documents
    const activeDocs = matchingDocs.filter(doc => !revokedDocIds.has(doc.getId()));
    
    if (activeDocs.length === 0) {
      this.logger.debug(`No active grant access documents found for username: ${username} (found ${matchingDocs.length} total, ${revokedDocIds.size} revoked)`);
    } else {
      this.logger.debug(`Found ${activeDocs.length} active grant access document(s) for username: ${username} (${matchingDocs.length} total, ${revokedDocIds.size} revoked)`);
    }
    
    return activeDocs;
  }

  async revokeUser(
    username: string,
    requestDataWipe: boolean,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    this.logger.info(`Revoking user: ${username}`);

    // Find all grant access documents for this user
    const grantAccessDocs = await this.findGrantAccessDocuments(username);
    
    // If no grant access documents found, exit early
    if (grantAccessDocs.length === 0) {
      this.logger.debug(`No grant access documents found for ${username}, exiting revocation`);
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

    // Compute username hash and encrypted username before creating documents
    const usernameHash = await this.hashUsername(username);
    const usernameEncrypted = await this.encryptForAdmin(username);

    // Create revocation documents for each grant access document found
    for (const grantAccessDoc of grantAccessDocs) {
      const revokeDocId = grantAccessDoc.getId();

      // Create document with admin signing key so the initial entry is trusted
      // Use PUBLIC_INFOS_KEY_ID so servers can validate users without full tenant access
      const newDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword,
        PUBLIC_INFOS_KEY_ID
      );
      
      // Set the document data fields - changeDocWithSigningKey handles signing at entry level
      await directoryDB.changeDocWithSigningKey(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "revokeaccess";
        data.username_hash = usernameHash;
        data.username_encrypted = usernameEncrypted;
        data.revokeDocId = revokeDocId;
        data.requestDataWipe = requestDataWipe;
      }, adminSigningKeyPair, administrationPrivateKeyPassword);

      this.logger.debug(`Created revocation document for grant access doc: ${revokeDocId}`);
    }
    
    this.logger.info(`Revoked user: ${username} (created ${grantAccessDocs.length} revocation document(s))`);
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    this.logger.debug(`Validating public signing key`);
    
    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;
    
    // Get administration public key - this is always trusted as the root of trust
    const administrationPublicKey = baseTenant.getAdministrationPublicKey();
    
    // The administration key is always trusted - it's the root of trust for the tenant
    if (publicKey === administrationPublicKey) {
      this.logger.debug(`Public key is administration key, trusted`);
      return true;
    }

    // Check additional trusted keys (e.g. server-to-server sync identities)
    // These are configured out-of-band and checked before the directory DB
    const additionalTrustedKeys = baseTenant.getAdditionalTrustedKeys();
    if (additionalTrustedKeys) {
      const additionalResult = additionalTrustedKeys.get(publicKey);
      if (additionalResult !== undefined) {
        this.logger.debug(`Public key validation result (from additionalTrustedKeys): ${additionalResult}`);
        return additionalResult;
      }
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
      this.logger.debug(`Public key validation result (from cache): ${cachedResult}`);
      return cachedResult;
    }
    
    // Key not found in cache means it was never granted access
    this.logger.debug(`Public key not found in cache, returning false`);
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
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(startCursor)) {
      const data = doc.getData();
      
      // Process user operation documents (grant/revoke access)
      if (data.form === "useroperation") {
      // Check if this is a grant access document
        if (data.type === "grantaccess" && 
          data.userSigningPublicKey &&
          typeof data.userSigningPublicKey === "string") {
              const userPublicKey = data.userSigningPublicKey;
              this.logger.debug(`Cache: adding trusted key from grant access document`);
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
                this.logger.debug(`Cache: revoking key for doc ${revokedDocId}`);
                this.trustedKeysCache.set(revokedPublicKey, false);
              } else {
                this.logger.warn(`Cache: revocation for unknown grant doc ${revokedDocId}`);
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
      // Collect all member hashes from all documents with this group name
      const allMembersHashes = new Set<string>();
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
        // Use members_hashes for the cache (privacy-preserving lookups)
        if (data.members_hashes && Array.isArray(data.members_hashes)) {
          for (const memberHash of data.members_hashes) {
            if (typeof memberHash === "string") {
              allMembersHashes.add(memberHash);
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
          members_hashes: Array.from(allMembersHashes),
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
    
    // Generate username variants for matching and compute their hashes
    const usernameVariants = this.generateUsernameVariants(username);
    // Hash all variants for comparison with members_hashes
    const variantHashes = new Set(
      await Promise.all(usernameVariants.map(v => this.hashUsername(v)))
    );
    
    // First pass: find all groups that directly contain the user or username variants (by hash)
    const directGroups = new Set<string>();
    for (const [groupName, groupData] of this.groupsCache.entries()) {
      for (const memberHash of groupData.members_hashes) {
        if (variantHashes.has(memberHash)) {
          directGroups.add(groupName);
          resultGroups.add(groupName);
          break;
        }
      }
    }
    
    // Second pass: find parent groups (groups that contain the user's groups)
    // Groups can be nested - a group name can be a member of another group
    // Keep iterating until no new groups are found
    let groupsToCheck = new Set(directGroups);
    const visitedGroups = new Set<string>(); // Track visited groups for cycle detection
    
    while (groupsToCheck.size > 0) {
      const nextGroups = new Set<string>();
      
      for (const childGroup of groupsToCheck) {
        // Skip if already checked (cycle detection)
        if (visitedGroups.has(childGroup)) {
          this.logger.warn(`Cycle detected in group resolution: ${childGroup} already visited, stopping recursion`);
          continue;
        }
        visitedGroups.add(childGroup);
        
        // Hash the child group name for comparison
        const childGroupHash = await this.hashUsername(childGroup);
        
        // Find all groups that contain this child group as a member (by hash)
        for (const [parentGroupName, parentGroupData] of this.groupsCache.entries()) {
          if (resultGroups.has(parentGroupName)) {
            continue; // Already found this group
          }
          
          if (parentGroupData.members_hashes.includes(childGroupHash)) {
            resultGroups.add(parentGroupName);
            nextGroups.add(parentGroupName);
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
    this.logger.debug(`Getting public keys for username: ${username}`);
    
    // Find all active (non-revoked) grant access documents for this user
    const activeDocs = await this.findGrantAccessDocuments(username);
    
    if (activeDocs.length === 0) {
      this.logger.debug(`No active grant access documents found for username: ${username}`);
      return null;
    }
    
    // Use the last active grant access document (most recent registration)
    // In most cases there should only be one active grant access document per user
    const doc = activeDocs[activeDocs.length - 1];
    const data = doc.getData();
    
    const signingPublicKey = data.userSigningPublicKey;
    const encryptionPublicKey = data.userEncryptionPublicKey;
    
    if (typeof signingPublicKey !== "string" || typeof encryptionPublicKey !== "string") {
      this.logger.error(`Invalid key data in grant access document for username: ${username}`);
      return null;
    }
    
    this.logger.debug(`Found public keys for username: ${username}`);
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
    this.logger.debug(`Checking if user is revoked: ${username}`);
    
    // Find all active grant access documents for this user
    const activeDocs = await this.findGrantAccessDocuments(username);
    
    // User is revoked if they have no active grant access documents
    const isRevoked = activeDocs.length === 0;
    
    this.logger.debug(`User ${username} revoked: ${isRevoked}`);
    return isRevoked;
  }

  async requestDocHistoryPurge(
    dbId: string,
    docId: string,
    reason: string | undefined,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    this.logger.info(`Requesting purge for document: ${docId} in ${dbId}`);
    
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
    
    this.logger.info(`Created purge request for ${docId} in ${dbId}`);
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
    for await (const { doc } of directoryDB.iterateChangesSince(null)) {
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
    
    // Return member hashes (actual usernames are encrypted and only admin can decrypt)
    // This allows checking membership via hash comparison
    return [...groupData.members_hashes];
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
    
    // Compute hashes and encrypted values for all new usernames
    const newMembersHashes = await Promise.all(username.map(u => this.hashUsername(u)));
    const newMembersEncrypted = await Promise.all(username.map(u => this.encryptForAdmin(u)));
    
    // Get the actual document from the database (using cached docId if available)
    const cachedGroup = this.groupsCache.get(normalizedGroupName);
    let groupDoc: MindooDoc;
    
    if (cachedGroup) {
      // Load the actual document from the database
      groupDoc = await directoryDB.getDocument(cachedGroup.docId);
    } else {
      // Create new document with PUBLIC_INFOS_KEY_ID for server access
      groupDoc = await directoryDB.createDocumentWithSigningKey(
        adminSigningKeyPair,
        administrationPrivateKeyPassword,
        PUBLIC_INFOS_KEY_ID
      );
    }
    
    // Apply changes and ensure form, type, and groupName fields are correct
    await directoryDB.changeDocWithSigningKey(
      groupDoc,
      async (d: MindooDoc) => {
        const data = d.getData();
        
        // Get existing arrays (copy them to avoid mutating in place)
        const existingHashes: string[] = Array.isArray(data.members_hashes)
          ? data.members_hashes.filter((h): h is string => typeof h === "string")
          : [];
        const existingEncrypted: string[] = Array.isArray(data.members_encrypted)
          ? data.members_encrypted.filter((e): e is string => typeof e === "string")
          : [];
        
        // Build new arrays with existing + new members (avoiding duplicates by hash)
        const existingHashesSet = new Set(existingHashes);
        const updatedHashes = [...existingHashes];
        const updatedEncrypted = [...existingEncrypted];
        
        for (let i = 0; i < newMembersHashes.length; i++) {
          if (!existingHashesSet.has(newMembersHashes[i])) {
            updatedHashes.push(newMembersHashes[i]);
            updatedEncrypted.push(newMembersEncrypted[i]);
            existingHashesSet.add(newMembersHashes[i]);
          }
        }
        
        // Assign the complete arrays (this triggers the proxy's set handler)
        data.members_hashes = updatedHashes;
        data.members_encrypted = updatedEncrypted;
        
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
    
    // Compute hashes of usernames to remove
    const hashesToRemove = new Set(await Promise.all(username.map(u => this.hashUsername(u))));
    
    // Remove users from members arrays
    await directoryDB.changeDocWithSigningKey(
      groupDoc,
      async (d: MindooDoc) => {
        const data = d.getData();
        
        if (!data.members_hashes || !Array.isArray(data.members_hashes) ||
            !data.members_encrypted || !Array.isArray(data.members_encrypted)) {
          return;
        }
        
        // Filter out members whose hashes match the ones to remove
        // Keep arrays in sync by filtering indices
        const indicesToKeep: number[] = [];
        const hashesArray = data.members_hashes as string[];
        for (let i = 0; i < hashesArray.length; i++) {
          if (!hashesToRemove.has(hashesArray[i])) {
            indicesToKeep.push(i);
          }
        }
        
        const encryptedArray = data.members_encrypted as string[];
        data.members_hashes = indicesToKeep.map(i => hashesArray[i]);
        data.members_encrypted = indicesToKeep.map(i => encryptedArray[i]);
        
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

  /**
   * Compute SHA-256 hash of lowercase username for lookups.
   * This enables searching for users without exposing the actual username.
   * 
   * @param username The username to hash
   * @return The hex-encoded SHA-256 hash of the lowercase username
   */
  private async hashUsername(username: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(username.toLowerCase());
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const hashBuffer = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Encrypt plaintext with admin's RSA public encryption key.
   * Only the admin with the corresponding private key can decrypt.
   * 
   * @param plaintext The text to encrypt
   * @return The base64-encoded encrypted data
   */
  private async encryptForAdmin(plaintext: string): Promise<string> {
    const adminEncKey = this.tenant.getAdministrationEncryptionPublicKey();
    const rsaEnc = new RSAEncryption(this.tenant.getCryptoAdapter());
    const encoder = new TextEncoder();
    const encrypted = await rsaEnc.encrypt(encoder.encode(plaintext), adminEncKey);
    return this.uint8ArrayToBase64(encrypted);
  }

  /**
   * Convert a Uint8Array to a base64 string.
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}