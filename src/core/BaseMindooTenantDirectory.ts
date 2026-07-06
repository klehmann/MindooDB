import {
  DEFAULT_TENANT_KEY_ID,
  type DirectoryUserDetails,
  type DirectoryUserLookup,
  type GrantKeyPair,
  type GrantKeyPairInfo,
  EncryptedPrivateKey,
  MindooDB,
  MindooDoc,
  MindooTenant,
  MindooTenantDirectory,
  ProcessChangesCursor,
  PublicUserId,
  SigningKeyPair,
  PUBLIC_INFOS_KEY_ID,
} from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";
import { Logger, MindooLogger, getDefaultLogLevel } from "./logging";
import {
  extractSigningPublicKeys,
  extractEncryptionPublicKeys,
  extractWipeRequestedSigningKeys,
  extractKeyPairs,
  extractActiveKeyPairs,
  extractRevokedKeyPairs,
  applyKeyPairFields,
  mergeKeyPairs,
} from "./accesscontrol/grantKeys";
import { aclTrustedWitnessDocId } from "./accesscontrol/types";
import { KeyBagReconciler } from "./accesscontrol/keyBagReconciler";
import {
  DirectoryStateNode,
} from "./accesscontrol/DirectoryStateNode";
import { DirectoryTimeTravelIndex, ProjectRevisionFn } from "./accesscontrol/DirectoryTimeTravelIndex";
import { projectDirectoryRevision } from "./accesscontrol/directoryProjection";
import {
  ACCESS_CONTROL_FORM,
  ACL_DEFAULT_POLICY_DOC_ID,
  AclRuleDoc,
  DefaultAccessPolicyDoc,
  DeviceWrappedVersions,
  KeyDistributionPushRecipient,
  KeyDistributionRequest,
  KeyDistributionView,
  KeyVersionRef,
  ACL_KEY_DISTRIBUTION_PREFIX,
  KEY_DISTRIBUTION_TYPE,
  PROTECTED_DISTRIBUTION_KEY_IDS,
  PSEUDO_TOKEN_ADMIN,
  PSEUDO_TOKEN_AUTHOR,
  PSEUDO_TOKEN_EVERYONE,
  RuleTargets,
  RuleType,
  WithFieldClause,
  aclRuleDocId,
  aclDbPolicyDocId,
  aclKeyDistributionDocId,
  effectivePolicy,
  validateAccessPolicy,
  validateAclRule,
  validateKeyDistribution,
  ACL_APP_DISTRIBUTION_PREFIX,
  APP_DISTRIBUTION_TYPE,
  AppDistributionRequest,
  AppDistributionView,
  AppDistributionReconcilePlan,
  aclAppDistributionDocId,
  validateAppDistribution,
  ACL_SYNC_SETUP_POLICY_PREFIX,
  SYNC_SETUP_POLICY_TYPE,
  SyncSetupPolicyMode,
  SyncSetupPolicyRequest,
  SyncSetupPolicyView,
  SyncSetupPolicyReconcilePlan,
  aclSyncSetupPolicyDocId,
  validateSyncSetupPolicy,
  ACL_DOC_HISTORY_PURGE_PREFIX,
  DOC_HISTORY_PURGE_TYPE,
  DocHistoryPurgeRequest,
  DocHistoryPurgeView,
  aclDocHistoryPurgeDocId,
  validateDocHistoryPurge,
} from "./accesscontrol/types";
import { IdentitySet, evaluateAccess } from "./accesscontrol/evaluate";
import { AccessDecision } from "./accesscontrol/types";
import { RSAEncryption } from "./crypto/RSAEncryption";
import { decryptEncryptedField } from "./crypto/encryptedFields";

const DIRECTORY_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// How long the resolved storage-format floor (`requireMetadataSignatureSince`)
// is reused before re-reading the directory head. Short, because it is consulted
// on the entry-verification hot path; the cutoff itself changes very rarely.
const METADATA_SIGNATURE_CUTOFF_TTL_MS = 30 * 1000;

/** De-duplicated union of two string lists, preserving first-seen order. */
function unionStrings(existing: string[], added: string[]): string[] {
  return Array.from(new Set([...existing, ...added]));
}

export class BaseMindooTenantDirectory implements MindooTenantDirectory, KeyBagReconciler {
  private tenant: BaseMindooTenant;
  private directoryDB: MindooDB | null = null;
  
  // Cache for trusted public keys: key -> isActive (true = granted, false = revoked)
  // This cache is updated incrementally as changes are processed
  // Note: No recursion guard needed because directory DB is admin-only,
  // so loading entries doesn't trigger validatePublicSigningKey recursively
  private trustedKeysCache: Map<string, boolean> = new Map();
  // Mapping from grant document ID to the signing public keys it currently
  // grants. Revocation is expressed by removing keys from a grant document
  // (docs/accesscontrol.md §6.5), so the set of trusted keys is recomputed as
  // the union of all grant documents' current key arrays after each cache pass.
  private grantDocIdToSigningKeys: Map<string, string[]> = new Map();
  // Best-effort reverse lookup cache for public signing key -> user details.
  // Entries remain available even after revocation so historical UIs can still show identity labels.
  private userLookupCache: Map<string, DirectoryUserLookup> = new Map();
  // Remote-wipe directive index (docs/accesscontrol.md §6.5): signing public key
  // targeted for wipe -> id of the admin-signed grant document carrying the
  // directive. Self-contained key values survive key removal, so this stays
  // populated even after the user is revoked by key-array removal.
  private wipeKeyToGrantDocId: Map<string, string> = new Map();

  // Cache for settings documents
  private tenantSettingsCache: MindooDoc | null = null;
  private dbSettingsCache: Map<string, MindooDoc> = new Map();

  // Cache for groups: key -> merged group data (key: lowercase groupName)
  // We store merged data separately to avoid mutating MindooDoc objects.
  private groupsCache: Map<string, { docId: string; members_hashes: string[]; members_encrypted: string[] }> = new Map();

  // Cache for key-distribution documents (acl_keydistribution_<keyId>), keyed by
  // keyId. Folded incrementally in updateUnifiedCache (singleton per keyId,
  // last-seen-wins; a deleted doc removes its entry). Powers the revoked-key
  // resolver (server pull/push blacklist) and the KeyBag reconcile without
  // re-scanning directory docs each call (docs/accesscontrol.md §13).
  private keyDistributionCache: Map<
    string,
    {
      keyVersions: KeyVersionRef[];
      pullfrom_users_hashes: string[];
      pushto_users_hashes: string[];
      pushto_users_keys: Record<string, DeviceWrappedVersions>;
    }
  > = new Map();

  // Cache for app-distribution documents (acl_appdistribution_<appId>), keyed by
  // appId. Folded incrementally in updateUnifiedCache (singleton per appId,
  // last-seen-wins; a deleted doc removes its entry). Holds only the
  // server-readable recipient hash lists so the per-user reconcile can compute
  // membership (have / notHave) without re-scanning directory docs; the
  // encrypted payload (version / appData) is read from the doc when needed
  // (docs/accesscontrol.md §13).
  private appDistributionCache: Map<
    string,
    {
      pushto_users_hashes: string[];
      pushto_groups_hashes: string[];
      pullfrom_users_hashes: string[];
      pullfrom_groups_hashes: string[];
    }
  > = new Map();

  // Incremental cache of sync-setup-policy recipient hash lists + enforcement
  // mode, maintained by updateUnifiedCache (mirrors appDistributionCache). The
  // encrypted database id list is read from the doc when the per-user reconcile
  // runs (getSyncSetupForCurrentUser → listSyncSetupPolicies).
  private syncSetupPolicyCache: Map<
    string,
    {
      mode: SyncSetupPolicyMode;
      pushto_users_hashes: string[];
      pushto_groups_hashes: string[];
      pullfrom_users_hashes: string[];
      pullfrom_groups_hashes: string[];
    }
  > = new Map();

  // Time-travel access-control state (docs/accesscontrol.md §8). Built from the
  // revision-grain changefeed (`iterateChangeRevisionsSince`) so every directory
  // revision becomes its own chain node, stamped by trusted time. Persisted to
  // disk as a compact delta log via the tenant CacheManager. Decoupled from the
  // legacy doc-grain caches above, which remain the source of truth for the
  // existing "now" public methods.
  private timeTravel: DirectoryTimeTravelIndex | null = null;
  // Last in-memory changefeed cursor the time-travel chain was built against,
  // used to skip the (potentially expensive) feed rebuild when the directory
  // has not changed since the previous build.
  private lastTimeTravelChangeSeq: number | null = null;

  // Unified cache cursor for all document types
  private unifiedCacheLastCursor: ProcessChangesCursor | null = null;
  private lastDirectorySyncTimestamp = 0;
  // Cached storage-format floor (`requireMetadataSignatureSince`) with re-entrancy
  // guard; see getRequireMetadataSignatureSince.
  private metadataSignatureCutoffCache: number | undefined = undefined;
  private metadataSignatureCutoffCachedAt = 0;
  private resolvingMetadataSignatureCutoff = false;
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

      // SDK-driven key-distribution reconcile on directory bring-up
      // (docs/accesscontrol.md §13). Fire-and-forget and single-flight so it
      // never blocks the first directory access. This is the cold-start /
      // backup-restore safety net: KeyBag.load() is silent (no onChanges, no
      // cursor bump), so a restored older bag that still holds revoked keys
      // would otherwise go un-reconciled until the next network sync. Runs only
      // once per directory object (the creation branch); the driver's own
      // getDirectoryDB calls reuse the now-set instance and do not re-trigger.
      void this.tenant.reconcileKeyDistributionsForCurrentUserSafe();
    }
    return this.directoryDB;
  }

  async registerUser(
    userId: PublicUserId,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
    userDetails?: DirectoryUserDetails,
    label?: string,
  ): Promise<void> {
    this.logger.info(`Registering user: ${userId.username}`);

    // Check if user with same username (case-insensitive) already has ACTIVE
    // access. A grant whose keys were removed (revocation, §6.5) is ignored
    // here so the user can be re-registered after being revoked.
    const existingDocs = await this.findGrantAccessDocuments(userId.username);
    const activeDocs = existingDocs.filter(
      (doc) => extractSigningPublicKeys(doc.getData()).length > 0,
    );
    if (activeDocs.length > 0) {
      // Check if the keys match the existing active registration
      const existingDoc = activeDocs[activeDocs.length - 1]; // Use most recent
      const existingData = existingDoc.getData();
      
      const keysMatch = 
        extractSigningPublicKeys(existingData).includes(userId.userSigningPublicKey) &&
        extractEncryptionPublicKeys(existingData).includes(userId.userEncryptionPublicKey);
      
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

    // Compute username hash (salted v2 for new documents) and encrypted user
    // details before creating the document.
    const usernameHash = await this.hashUsernameForWrite(userId.username);
    const userDetailsEncrypted = await this.encryptUserDetailsForTenant(
      this.buildUserDetailsPayload(userId.username, userDetails),
    );
    // Precompute the identity-hash bundle from the cleartext name (the only
    // place it exists) so the server can match wildcard/group read rules in
    // hash space without the cleartext (docs/accesscontrol.md §6.5). The bundle
    // is the v1+v2 hashes of every DN-hierarchy variant: e.g. for
    // "CN=Karsten Lehmann/OU=CEO/OU=Management/O=Mindoo" the variants are the
    // exact name plus the wildcards
    //   "*/OU=CEO/OU=Management/O=Mindoo",
    //   "*/OU=Management/O=Mindoo",
    //   "*/O=Mindoo", and
    //   "*"
    // so a read rule like "*/O=Mindoo" matches this user purely in hash space.
    const identityHashes = await this.computeIdentityHashes(userId.username);

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
      // Set the document data fields with the admin key at entry level
      await directoryDB.changeDoc(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username_hash = usernameHash;
        data.username_hash_v = BaseMindooTenantDirectory.USERNAME_HASH_VERSION;
        data.user_details_encrypted = userDetailsEncrypted;
        // Follow the `_encrypted` / `_encrypted_key` convention so view formulas
        // (v.decryptJson) can resolve the key id without hardcoding "default".
        data.user_details_encrypted_key = DEFAULT_TENANT_KEY_ID;
        // $publicinfos-readable identity-hash bundle (§6.5): the grant doc is
        // encrypted under PUBLIC_INFOS_KEY_ID, so these plain fields are
        // server-readable without the default tenant key.
        data.identity_hashes = identityHashes;
        data.identity_hashes_v = BaseMindooTenantDirectory.IDENTITY_VARIANTS_VERSION;
        // New grants write the canonical `userKeyPairs` form (§6.5), pairing
        // the device's signing+encryption keys with an optional label, while
        // applyKeyPairFields mirrors the legacy array/scalar fields so older
        // clients keep working. The admin can later add more devices or relabel.
        const trimmedLabel = typeof label === "string" ? label.trim() : "";
        const initialPair: GrantKeyPair = {
          signingPublicKey: userId.userSigningPublicKey,
          encryptionPublicKey: userId.userEncryptionPublicKey,
        };
        if (trimmedLabel.length > 0) initialPair.label = trimmedLabel;
        applyKeyPairFields(data, [initialPair]);
      }, {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.error(`ERROR in changeDoc:`, error);
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
    
    // Compute the candidate hashes to search for. We match against BOTH the
    // legacy (v1, unsalted) and salted (v2) forms so that documents written
    // under either scheme are found (docs/accesscontrol.md §6.5).
    const targetHashes = new Set(await this.usernameHashCandidates(username));
    // Callers may pass an already-hashed `username_hash` rather than a cleartext
    // name — e.g. when validateToken resolves the principal from a device key via
    // getUserBySigningPublicKey, whose `username` is the hash when the cleartext
    // is not recoverable on this server. Match it directly too so a key-resolved
    // identity round-trips: a cleartext name never collides with a 64-char hex
    // hash, so this is safe (docs/accesscontrol.md §6.5).
    targetHashes.add(username);
    const matchesTarget = (value: unknown): boolean =>
      typeof value === "string" && targetHashes.has(value);
    
    const matchingDocs: MindooDoc[] = [];

    // Use the generator-based iteration API for cleaner code.
    // No signature verification needed - DB already enforces admin-only.
    // Revocation no longer uses a separate document: it removes keys from the
    // grant document in place (docs/accesscontrol.md §6.5). A fully-revoked user
    // therefore still has a grant document here, but with empty key arrays.
    // Callers that need "active access" should inspect the key arrays (see
    // {@link isUserRevoked} / {@link getUserPublicKeys}).
    for await (const { doc } of directoryDB.iterateChangesSince(null)) {
      const data = doc.getData();

      if (data.form === "useroperation" &&
          data.type === "grantaccess" &&
          matchesTarget(data.username_hash)) {
        this.logger.debug(`Found grant access document for username: ${username}`);
        matchingDocs.push(doc);
      }
    }

    this.logger.debug(`Found ${matchingDocs.length} grant access document(s) for username: ${username}`);
    return matchingDocs;
  }

  /**
   * Revoke a user's access by removing their keys from the grant document
   * (docs/accesscontrol.md §6.5). This replaces the legacy `revokeaccess`
   * document model entirely: revocation is now an in-place edit of the grant
   * document's `userSigningPublicKeys` / `userEncryptionPublicKeys` arrays.
   *
   * By default (no `options.signingKeys`) the user is fully revoked: every
   * signing AND encryption key is removed, so the grant document remains but
   * carries no keys. To revoke a single device/key, pass the specific
   * `signingKeys` (and optionally matching `encryptionKeys`) to remove.
   *
   * When `options.requestDataWipe` is true, the removed signing keys are also
   * flagged for a remote device wipe (§6.5) before removal, so the targeted
   * devices delete their local tenant on next sync. The wipe directive is
   * stored self-contained on the grant document and survives key removal.
   *
   * BREAKING CHANGE: the previous signature took a positional `requestDataWipe`
   * boolean; it now takes an options object so specific keys can be targeted.
   *
   * @param username The user to revoke (format: "CN=<username>/O=<tenantId>").
   * @param options.signingKeys Specific signing keys to remove; omit/empty to
   *   remove all of the user's keys (full revocation).
   * @param options.encryptionKeys Specific encryption keys to remove. Ignored
   *   for a full revocation (all encryption keys are removed in that case).
   * @param options.requestDataWipe Also request a remote wipe of the removed
   *   signing keys' devices.
   */
  async revokeUser(
    username: string,
    options: {
      signingKeys?: string[];
      encryptionKeys?: string[];
      requestDataWipe?: boolean;
    },
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    this.logger.info(`Revoking user: ${username}`);

    const grantAccessDocs = await this.findGrantAccessDocuments(username);
    if (grantAccessDocs.length === 0) {
      this.logger.debug(`No grant access documents found for ${username}, exiting revocation`);
      return;
    }

    const fullRevoke = !options.signingKeys || options.signingKeys.length === 0;

    // Determine which signing/encryption keys to strip from the grant. A full
    // revocation removes every key currently present across the user's grant
    // documents; a targeted revocation removes only the supplied keys.
    let signingToRemove: string[];
    let encryptionToRemove: string[];
    if (fullRevoke) {
      const allSigning = new Set<string>();
      const allEncryption = new Set<string>();
      for (const grant of grantAccessDocs) {
        const data = grant.getData();
        for (const key of extractSigningPublicKeys(data)) allSigning.add(key);
        for (const key of extractEncryptionPublicKeys(data)) allEncryption.add(key);
      }
      signingToRemove = Array.from(allSigning);
      encryptionToRemove = Array.from(allEncryption);
    } else {
      signingToRemove = options.signingKeys ?? [];
      encryptionToRemove = options.encryptionKeys ?? [];
    }

    // Flag the removed devices for remote wipe BEFORE removing the keys, so the
    // self-contained wipe directive is recorded on the grant document (§6.5).
    if (options.requestDataWipe && signingToRemove.length > 0) {
      await this.requestDeviceWipe(
        username,
        signingToRemove,
        administrationPrivateKey,
        administrationPrivateKeyPassword,
      );
    }

    await this.removeUserKeys(
      username,
      signingToRemove,
      encryptionToRemove,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
    );

    // removeUserKeys already refreshes the unified cache; refresh once more to
    // be explicit so subsequent validatePublicSigningKey calls observe the
    // revocation without waiting for the next sync interval.
    await this.updateUnifiedCache();

    this.logger.info(
      fullRevoke
        ? `Revoked user: ${username} (removed all keys from ${grantAccessDocs.length} grant document(s))`
        : `Revoked ${signingToRemove.length} signing key(s) for user: ${username}`,
    );
  }

  async validatePublicSigningKey(
    publicKey: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<boolean> {
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
    
    // Refresh directory state at most once per interval — unless the caller
    // forces a refresh (audit #4): the server push path must observe a freshly
    // pushed revocation immediately rather than lagging by up to
    // DIRECTORY_SYNC_INTERVAL_MS, which would let a just-revoked key keep
    // pushing entries.
    const now = Date.now();
    let didSync = false;
    if (
      opts?.forceRefresh ||
      now - this.lastDirectorySyncTimestamp >= DIRECTORY_SYNC_INTERVAL_MS
    ) {
      const directoryDB = await this.getDirectoryDB();
      await directoryDB.syncStoreChanges();
      await this.updateUnifiedCache();
      this.lastDirectorySyncTimestamp = now;
      didSync = true;
    }

    let cachedResult = this.trustedKeysCache.get(publicKey);
    if (cachedResult === undefined && !didSync) {
      // Cache miss and not synced yet - sync once and re-check immediately.
      const directoryDB = await this.getDirectoryDB();
      await directoryDB.syncStoreChanges();
      await this.updateUnifiedCache();
      this.lastDirectorySyncTimestamp = Date.now();
      cachedResult = this.trustedKeysCache.get(publicKey);
    }

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
      this.grantDocIdToSigningKeys.clear();
      this.userLookupCache.clear();
      this.wipeKeyToGrantDocId.clear();
      this.tenantSettingsCache = null;
      this.dbSettingsCache.clear();
      this.groupsCache.clear();
      this.keyDistributionCache.clear();
    }
    
    // Track group documents by name for merging (handles offline sync scenarios)
    const groupDocsByName: Map<string, MindooDoc[]> = new Map();
    
    // Process changes (documents are returned in order by lastModified, oldest to newest)
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(startCursor)) {
      const data = doc.getData();
      
      // Process user operation documents (grant/revoke access)
      if (data.form === "useroperation") {
      // Check if this is a grant access document. A grant may carry MULTIPLE
      // signing keys (key rollover / multiple devices, §6.5); honor all of
      // them, with a legacy scalar fallback handled by extractSigningPublicKeys.
        const grantedSigningKeys =
          data.type === "grantaccess" ? extractSigningPublicKeys(data) : [];
        // Index any remote-wipe directive on this grant (§6.5) regardless of how
        // many signing keys remain: the wipe values are self-contained and must
        // survive full key-array revocation so a revoked device can still be told
        // to wipe. Maps each wipe-targeted signing key to this grant doc's id.
        if (data.type === "grantaccess") {
          for (const wipeKey of extractWipeRequestedSigningKeys(data)) {
            this.wipeKeyToGrantDocId.set(wipeKey, doc.getId());
          }
        }
        if (data.type === "grantaccess") {
              // Record this grant document's CURRENT signing keys. Because grant
              // documents are Automerge-merged in place, removing keys (the only
              // revocation mechanism, §6.5) is reflected by a smaller array here.
              // The authoritative trustedKeysCache is rebuilt from the union of
              // all grant documents once the change loop completes, so a key
              // dropped from this document is no longer trusted unless another
              // grant still lists it.
              this.grantDocIdToSigningKeys.set(doc.getId(), grantedSigningKeys);

              if (grantedSigningKeys.length > 0) {
                const userLookup = await this.buildUserLookup(data);
                if (userLookup) {
                  // Keep identity labels available even after the keys are later
                  // revoked, so historical UIs can still resolve old authors.
                  for (const userPublicKey of grantedSigningKeys) {
                    this.userLookupCache.set(userPublicKey, userLookup);
                  }
                }
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

      // Process key-distribution documents (acl_keydistribution_<keyId>); a
      // singleton per keyId. Cache head state here so the revoked-key resolver
      // and the KeyBag reconcile read it without re-scanning directory docs
      // (docs/accesscontrol.md §13). A deleted distribution drops its entry.
      if (data.type === KEY_DISTRIBUTION_TYPE && typeof data.keyId === "string") {
        const keyId = data.keyId;
        if (doc.isDeleted()) {
          this.keyDistributionCache.delete(keyId);
        } else {
          this.keyDistributionCache.set(keyId, {
            keyVersions: Array.isArray(data.keyVersions)
              ? (data.keyVersions as unknown[])
                  .filter(
                    (v): v is KeyVersionRef =>
                      !!v && typeof (v as KeyVersionRef).fingerprint === "string",
                  )
                  .map((v) => ({ createdAt: Number(v.createdAt) || 0, fingerprint: v.fingerprint }))
              : [],
            pullfrom_users_hashes: Array.isArray(data.pullfrom_users_hashes)
              ? (data.pullfrom_users_hashes as unknown[]).filter(
                  (h): h is string => typeof h === "string",
                )
              : [],
            pushto_users_hashes: Array.isArray(data.pushto_users_hashes)
              ? (data.pushto_users_hashes as unknown[]).filter(
                  (h): h is string => typeof h === "string",
                )
              : [],
            pushto_users_keys:
              data.pushto_users_keys && typeof data.pushto_users_keys === "object"
                ? (data.pushto_users_keys as Record<string, DeviceWrappedVersions>)
                : {},
          });
        }
      }

      // Process app-distribution documents (acl_appdistribution_<appId>); a
      // singleton per appId. Cache the recipient hash lists so the per-user
      // reconcile reads membership without re-scanning directory docs
      // (docs/accesscontrol.md §13). A deleted distribution drops its entry.
      if (data.type === APP_DISTRIBUTION_TYPE && typeof data.appId === "string") {
        const appId = data.appId;
        if (doc.isDeleted()) {
          this.appDistributionCache.delete(appId);
        } else {
          const stringArray = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((h): h is string => typeof h === "string") : [];
          this.appDistributionCache.set(appId, {
            pushto_users_hashes: stringArray(data.pushto_users_hashes),
            pushto_groups_hashes: stringArray(data.pushto_groups_hashes),
            pullfrom_users_hashes: stringArray(data.pullfrom_users_hashes),
            pullfrom_groups_hashes: stringArray(data.pullfrom_groups_hashes),
          });
        }
      }

      // Process sync-setup-policy documents (acl_syncsetuppolicy_<policyId>); one
      // doc per policy. Cache the recipient hash lists + enforcement mode so the
      // per-user reconcile reads membership without re-scanning directory docs.
      // A deleted policy drops its entry.
      if (data.type === SYNC_SETUP_POLICY_TYPE && typeof data.policyId === "string") {
        const policyId = data.policyId;
        if (doc.isDeleted()) {
          this.syncSetupPolicyCache.delete(policyId);
        } else {
          const stringArray = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((h): h is string => typeof h === "string") : [];
          this.syncSetupPolicyCache.set(policyId, {
            mode: data.mode === "permanent" ? "permanent" : "initial",
            pushto_users_hashes: stringArray(data.pushto_users_hashes),
            pushto_groups_hashes: stringArray(data.pushto_groups_hashes),
            pullfrom_users_hashes: stringArray(data.pullfrom_users_hashes),
            pullfrom_groups_hashes: stringArray(data.pullfrom_groups_hashes),
          });
        }
      }

      // Update cursor after each document
      this.unifiedCacheLastCursor = cursor;
    }

    // Rebuild the trusted signing-key set as the union of every grant
    // document's current keys (docs/accesscontrol.md §6.5). Revocation removes
    // keys from a grant, so a key absent from this union is no longer trusted;
    // validatePublicSigningKey treats "not present" as untrusted. This is
    // recomputed on every pass (full or incremental) because the per-grant map
    // is the source of truth and persists across incremental updates.
    this.trustedKeysCache.clear();
    for (const signingKeys of this.grantDocIdToSigningKeys.values()) {
      for (const key of signingKeys) {
        this.trustedKeysCache.set(key, true);
      }
    }

    // Merge group documents with the same name
    for (const [normalizedGroupName, docs] of groupDocsByName.entries()) {
      // Collect all member hashes and encrypted values from all documents with this group name
      const allMembersHashes = new Set<string>();
      const allMembersEncrypted = new Set<string>();
      let latestDoc: MindooDoc | null = null;
      let isDeleted = false;
      
      for (const doc of docs) {
        const data = doc.getData();
        // Track the latest document (by iteration order, which is by lastModified)
        latestDoc = doc;
        // Check if document is deleted via lifecycle metadata.
        if (doc.isDeleted()) {
          isDeleted = true;
        }
        // Use members_hashes for membership lookups.
        if (data.members_hashes && Array.isArray(data.members_hashes)) {
          for (const memberHash of data.members_hashes) {
            if (typeof memberHash === "string") {
              allMembersHashes.add(memberHash);
            }
          }
        }
        if (data.members_encrypted && Array.isArray(data.members_encrypted)) {
          for (const encryptedMember of data.members_encrypted) {
            if (typeof encryptedMember === "string") {
              allMembersEncrypted.add(encryptedMember);
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
          members_encrypted: Array.from(allMembersEncrypted),
        });
      }
    }

  }

  /**
   * The head time-travel directory-state node ("now"), after ensuring the chain
   * is current. Powers access-control evaluation (§7) and audit queries.
   */
  async getDirectoryStateHead(): Promise<DirectoryStateNode> {
    const index = await this.ensureTimeTravelCurrent();
    return index.getHead();
  }

  /**
   * The time-travel directory-state node covering trusted time `T` (§8) — used
   * by the evaluation algorithm and `wasAllowedAt` to judge an entry against the
   * directory as it was at the entry's trusted time.
   */
  async getDirectoryStateAt(T: number): Promise<DirectoryStateNode> {
    const index = await this.ensureTimeTravelCurrent();
    return index.getStateAt(T);
  }

  /**
   * Lazily create the time-travel index (restoring its persisted delta log and
   * registering it with the tenant CacheManager on first use), then bring the
   * directory-state chain up to date from the revision-grain changefeed
   * (docs/accesscontrol.md §8).
   *
   * The (potentially expensive) feed rebuild is skipped when the directory's
   * changefeed cursor has not advanced since the previous build and no
   * un-witnessed revisions are pending a possible trusted-time re-stamp.
   */
  private async ensureTimeTravelCurrent(): Promise<DirectoryTimeTravelIndex> {
    const directoryDB = await this.getDirectoryDB();

    // Projection used to (re)build the chain from stored revisions in
    // trusted-time order. Captures this directory's group-name normalization.
    const project: ProjectRevisionFn = (builder, revision) =>
      projectDirectoryRevision(builder, {
        docId: revision.docId,
        data: revision.data,
        deleted: revision.deleted,
        trustedTime: revision.trustedTime,
        normalizeGroupName: (name) => this.normalizeGroupName(name),
      });

    if (!this.timeTravel) {
      const index = new DirectoryTimeTravelIndex(`${this.tenant.getId()}/directory`);
      const cacheManager = this.tenant.getCacheManager();
      if (cacheManager) {
        // Warm start: restore the persisted revisions (no decryption / Automerge)
        // and replay them into the chain, then extend via the changefeed below.
        await index.restoreFromCache(cacheManager.getStore());
        index.rebuild(project);
        cacheManager.register(index);
      }
      // Seed the in-memory gate cursor from the restored chain so a cold start
      // can short-circuit when the directory has not advanced since the chain
      // was flushed (otherwise the first call after every restart redundantly
      // rebuilds the feed). `null` keeps the legacy behavior (force a build).
      this.lastTimeTravelChangeSeq = index.lastChangeSeq;
      this.timeTravel = index;
    }
    const index = this.timeTravel;

    // Gate the (potentially expensive) feed rebuild on the in-memory changefeed
    // cursor. We deliberately do NOT call syncStoreChanges() here: like the
    // legacy updateUnifiedCache read path, this method must not trigger network
    // pulls or re-entrant directory syncing when invoked from server-side entry
    // validation. The revision feed reads the directory store directly, so it
    // already observes every persisted entry; the cursor is only used to decide
    // when a rebuild is worthwhile.
    const latest = directoryDB.getLatestChangeCursor?.() ?? null;
    const latestSeq = latest?.changeSeq ?? null;

    // Fast path: the directory has not advanced since the last build. The
    // un-witnessed head overlay is refreshed when `changeSeq` next advances
    // (notably when a re-stamped entry is re-discovered with a `receivedAt`), so
    // we do not need to re-run the feed on every call just to refresh the
    // provisional `now` of un-witnessed entries.
    if (this.lastTimeTravelChangeSeq !== null && latestSeq === this.lastTimeTravelChangeSeq) {
      return index;
    }

    // Incrementally advance the feed from the persisted cursor; the feed parks
    // the cursor before the earliest un-witnessed entry so those revisions are
    // re-discovered (and re-stamped/superseded as needed) on this resume.
    let changed = false;
    for await (const rev of directoryDB.iterateChangeRevisionsSince(index.cursor)) {
      const revChanged = index.upsertRevision(
        {
          entryId: rev.entryId,
          docId: rev.docId,
          data: rev.doc.getData(),
          deleted: rev.doc.isDeleted(),
          trustedTime: rev.trustedTime,
          witnessed: rev.witnessed,
        },
        rev.cursor,
      );
      changed = changed || revChanged;
    }

    // Replay all revisions into the chain in trusted-time order. This absorbs
    // out-of-order arrivals and supersessions (a re-emitted revision replaced its
    // prior record above) without any special-casing in the chain builder.
    if (changed) {
      index.rebuild(project);
    }

    this.lastTimeTravelChangeSeq = latestSeq;
    // Persist the observed changeSeq with the chain so the gate survives restart.
    index.recordChangeSeq(latestSeq);
    if (index.hasDirtyState()) {
      this.tenant.getCacheManager()?.markDirty();
    }
    return index;
  }

  /**
   * The set of witness public keys trusted at trusted time `T`
   * (docs/accesscontrol.md §6.4), used by the client to validate witness
   * receipts on incoming entries during materialization (§5.4).
   */
  async getTrustedWitnessKeysAt(T: number): Promise<Set<string>> {
    const node = await this.getDirectoryStateAt(T);
    return new Set(node.trustedWitnessKeys.keys());
  }

  /**
   * Resolve the acting user's identity set for access-control evaluation
   * (docs/accesscontrol.md §7 step 3): username hash (v1 + v2), every group hash
   * (including nested groups), the user's resolved usernames/groups for
   * placeholder expansion, and the applicable pseudo-tokens (`$everyone` always;
   * `$admin`/`$author` when the caller indicates they apply).
   *
   * @param username The acting user's canonical username.
   * @param opts.isAdmin Whether the acting signing key is the tenant admin key.
   * @param opts.isAuthor Whether the acting user authored the target document
   *   (the caller resolves this by mapping the document's creator key and the
   *   change signer key to the same grant; see §6.3 `$author`).
   */
  async buildIdentitySet(
    username: string,
    opts: { isAdmin?: boolean; isAuthor?: boolean } = {},
  ): Promise<IdentitySet> {
    await this.updateUnifiedCache();
    const usernames = await this.getUserNamesList(username);
    const groups = await this.resolveGroupsForUser(username);

    const hashes = new Set<string>();
    for (const h of await this.usernameHashCandidates(username)) {
      hashes.add(h);
    }
    // Group membership: rules target group-name hashes, so the identity set
    // must include the hash of every group the user belongs to.
    for (const group of groups) {
      for (const h of await this.usernameHashCandidates(group)) {
        hashes.add(h);
      }
    }
    hashes.add(PSEUDO_TOKEN_EVERYONE);
    if (opts.isAdmin) hashes.add(PSEUDO_TOKEN_ADMIN);
    if (opts.isAuthor) hashes.add(PSEUDO_TOKEN_AUTHOR);

    return { username, usernames, groups, hashes };
  }

  /**
   * Server-side Tier 1 evaluation for a pushed entry (docs/accesscontrol.md §7,
   * §10). The server identifies the author by signing key (it cannot read
   * encrypted content), resolves their identity set, and evaluates the identity
   * tier of the policy at `trustedTime`. Tier 2 (content) rules are deferred to
   * clients — `evaluateAccess` is called with `isServer: true`, so a gate that
   * only a Tier 2 rule could decide is treated as allowed here.
   *
   * @param input.op The operation (entry type) being pushed.
   * @param input.dbid The database the entry targets (witness binds this).
   * @param input.signingKey The author's Ed25519 signing public key (PEM).
   * @param input.trustedTime The trusted time to evaluate at (the witness's
   *   acceptance time for an inbound push).
   * @param input.isAuthor Whether the author is the document's original creator
   *   (resolved by the caller for `$author`; see §6.3). For `doc_create` the
   *   author is always the creator.
   */
  async evaluateAccessForSigningKey(input: {
    op: RuleType;
    dbid: string;
    signingKey: string;
    trustedTime: number;
    isAuthor?: boolean;
  }): Promise<AccessDecision> {
    const node = await this.getDirectoryStateAt(input.trustedTime);
    const identity = await this.identitySetForSigningKey(input.signingKey, node, {
      isAuthor: input.op === "doc_create" || !!input.isAuthor,
    });
    return evaluateAccess({
      op: input.op,
      dbid: input.dbid,
      identity,
      node,
      isServer: true,
    });
  }

  /**
   * Client-side (Tier 1 + Tier 2) evaluation for a single entry during
   * materialization (docs/accesscontrol.md §7, §10). Unlike the server path,
   * the client can read decrypted content, so it evaluates `withfields` clauses
   * against the supplied `before`/`after` document states.
   */
  async evaluateClientAccess(input: {
    op: RuleType;
    dbid: string;
    signingKey: string;
    trustedTime: number;
    isAuthor: boolean;
    beforeDoc: Record<string, unknown> | null;
    afterDoc: Record<string, unknown> | null;
  }): Promise<AccessDecision> {
    const node = await this.getDirectoryStateAt(input.trustedTime);
    const identity = await this.identitySetForSigningKey(input.signingKey, node, {
      isAuthor: input.op === "doc_create" || input.isAuthor,
    });
    return evaluateAccess({
      op: input.op,
      dbid: input.dbid,
      identity,
      node,
      beforeDoc: input.beforeDoc,
      afterDoc: input.afterDoc,
      isServer: false,
    });
  }

  /**
   * Whether the active policy has any Tier 2 (`withfields`) content rule for
   * operation `op` in database `dbid` at the current head state. Lets the
   * client write prechecks skip the (potentially costly) Automerge -> JS
   * materialization of the before/after document when only Tier 1
   * (identity/op) checks could apply (docs/accesscontrol.md §9).
   */
  async hasWriteContentRules(op: RuleType, dbid: string): Promise<boolean> {
    const node = await this.getDirectoryStateHead();
    const rules = node.rulesByType.get(op) ?? [];
    return rules.some(
      (r) => (r.dbid === dbid || r.dbid === "*") && (r.withfields?.length ?? 0) > 0,
    );
  }

  /**
   * Whether access control is active for this tenant right now: a default
   * policy exists and the master kill-switch is not engaged
   * (docs/accesscontrol.md §6.1, §7 step 0). When false, callers can skip the
   * (more expensive) per-entry access evaluation entirely.
   */
  async isAccessControlActive(): Promise<boolean> {
    const head = await this.getDirectoryStateHead();
    if (head.defaultPolicy === null) return false;
    return head.defaultPolicy.disableAllAccessChecksAndPolicies !== true;
  }

  /**
   * The effective default `decryptionKeyId` for a `doc_create` in `dbid` at the
   * current head state, or `undefined` when none is configured. Lets the client
   * fill in the key when the caller omits one, instead of falling back to the
   * hardcoded `"default"`. This is a create-time convenience, not a security
   * control — which keys a user may create/read under is governed by key
   * possession (the key distribution model, docs/accesscontrol.md §13).
   */
  async getEffectiveDefaultCreateKeyId(dbid: string): Promise<string | undefined> {
    const head = await this.getDirectoryStateHead();
    if (head.defaultPolicy === null) return undefined;
    const eff = effectivePolicy(head.defaultPolicy, head.dbPolicies.get(dbid) ?? null);
    if (eff.disableAllAccessChecksAndPolicies) return undefined;
    return eff.defaultCreateKeyId;
  }

  /**
   * The tenant-wide database-open policy at the current head state.
   *
   * This is a tenant-level control read only from the `acl_defaultpolicy`
   * document (never layered per-db). When no default policy exists (access
   * control off), or the field is omitted, the policy is `"open"`. In
   * `"directory-restricted"` mode only `"directory"` (always implicitly
   * allowed) and the returned `allowedDbIds` may be opened/synced.
   */
  async getDatabaseCreationPolicy(): Promise<{
    mode: "open" | "directory-restricted";
    allowedDbIds: string[];
  }> {
    const head = await this.getDirectoryStateHead();
    const policy = head.defaultPolicy;
    if (policy === null || policy.databaseCreationPolicy !== "directory-restricted") {
      return { mode: "open", allowedDbIds: [] };
    }
    return {
      mode: "directory-restricted",
      allowedDbIds: Array.isArray(policy.allowedDbIds) ? [...policy.allowedDbIds] : [],
    };
  }

  /**
   * The tenant-wide storage-format floor (`requireMetadataSignatureSince`): the
   * trusted-time cutoff at/after which entries must carry the v2 metadata-binding
   * signature, or `undefined` when no floor is configured (fully backward
   * compatible). Tenant-level only, read from the `acl_defaultpolicy` head.
   *
   * Cached with a short TTL and guarded against re-entrancy: resolving the
   * cutoff loads the directory head, and directory materialization itself runs
   * signature verification — without the guard a verify→resolve→materialize→
   * verify cycle could recurse. During such re-entry we return the last known
   * value (the directory store is anyway exempt from the floor by its callers).
   */
  async getRequireMetadataSignatureSince(): Promise<number | undefined> {
    const now = Date.now();
    if (this.resolvingMetadataSignatureCutoff) {
      return this.metadataSignatureCutoffCache;
    }
    if (
      this.metadataSignatureCutoffCachedAt !== 0 &&
      now - this.metadataSignatureCutoffCachedAt < METADATA_SIGNATURE_CUTOFF_TTL_MS
    ) {
      return this.metadataSignatureCutoffCache;
    }
    this.resolvingMetadataSignatureCutoff = true;
    try {
      const head = await this.getDirectoryStateHead();
      const since = head.defaultPolicy?.requireMetadataSignatureSince;
      this.metadataSignatureCutoffCache =
        typeof since === "number" && Number.isFinite(since) ? since : undefined;
      this.metadataSignatureCutoffCachedAt = now;
    } finally {
      this.resolvingMetadataSignatureCutoff = false;
    }
    return this.metadataSignatureCutoffCache;
  }

  /**
   * Whether `dbid` may be opened/synced under the current database-open policy.
   *
   * Always true for `"directory"` and in `"open"` mode. In
   * `"directory-restricted"` mode, true only when `dbid` is in `allowedDbIds`
   * or the optional `signingKey` is the tenant administration key (admin
   * bypass).
   */
  async isDatabaseAllowed(
    dbid: string,
    opts?: { signingKey?: string },
  ): Promise<boolean> {
    if (dbid === "directory") return true;
    const { mode, allowedDbIds } = await this.getDatabaseCreationPolicy();
    if (mode === "open") return true;
    if (allowedDbIds.includes(dbid)) return true;
    if (opts?.signingKey !== undefined) {
      const adminKey = (this.tenant as BaseMindooTenant).getAdministrationPublicKey();
      if (opts.signingKey === adminKey) return true;
    }
    return false;
  }

  /**
   * Server-oriented variant of {@link isDatabaseAllowed} that resolves the
   * admin bypass from a request principal's signing key. Used by the sync
   * server to gate all sync operations for a database id.
   */
  async evaluateDbAccessForSigningKey(input: {
    dbid: string;
    signingKey: string;
  }): Promise<boolean> {
    // Gate 1 — tenant-wide database-id allowlist (`databaseCreationPolicy`).
    // Orthogonal to read access: a database must clear BOTH gates.
    if (!(await this.isDatabaseAllowed(input.dbid, { signingKey: input.signingKey }))) {
      return false;
    }
    // The directory database is never read-gated (it must always sync so the
    // policy that defines the read gate can be read at all).
    if (input.dbid === "directory") return true;
    // The tenant admin is exempt from the read gate.
    const adminKey = (this.tenant as BaseMindooTenant).getAdministrationPublicKey();
    if (input.signingKey === adminKey) return true;
    // Gate 2 — per-user/group database read gate (`doc_read`, §6.6). Evaluated
    // server-side (Tier 1) from the principal's signing key at acceptance time.
    // A denied principal cannot pull or push the database, which also prevents
    // creating data in it (read is required to create).
    const decision = await this.evaluateAccessForSigningKey({
      op: "doc_read",
      dbid: input.dbid,
      signingKey: input.signingKey,
      trustedTime: Date.now(),
    });
    return decision.allowed;
  }

  /**
   * Whether the current user may open and sync `dbid` under the database read
   * gate (`doc_read`, §6.6). The client-side counterpart of
   * {@link evaluateDbAccessForSigningKey}'s read gate: it evaluates the
   * `doc_read` policy for the current user against the directory head. The
   * `"directory"` database is never gated and the tenant admin is always
   * exempt. This does NOT apply the tenant-wide database-id allowlist
   * ({@link isDatabaseAllowed}); callers enforce both gates.
   */
  async canReadDatabase(dbid: string): Promise<boolean> {
    if (dbid === "directory") return true;
    const currentUser = await this.tenant.getCurrentUserId();
    const adminKey = (this.tenant as BaseMindooTenant).getAdministrationPublicKey();
    if (currentUser.userSigningPublicKey === adminKey) return true;
    const decision = await this.canDo("doc_read", dbid);
    return decision.allowed;
  }

  // -------------------------------------------------------------------------
  // Access-control authoring API (docs/accesscontrol.md §6). All writes are
  // admin-signed and encrypted with `$publicinfos` so the sync server can read
  // the Tier 1-relevant policy. Creating `acl_defaultpolicy` is what activates
  // access control for the tenant (§6.1).
  // -------------------------------------------------------------------------

  /**
   * Create or update the tenant-wide default policy (§6.1). The mere existence
   * of this document activates access control. Only the fields supplied are
   * written; omit a field to leave it unset (interpreted as its default).
   */
  async setDefaultAccessPolicy(
    policy: Partial<Omit<DefaultAccessPolicyDoc, "form" | "type">>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    validateAccessPolicy(policy);
    await this.writePolicyDoc(
      ACL_DEFAULT_POLICY_DOC_ID,
      policy,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
    );
  }

  /**
   * Create or update a per-database policy override (§6.2). Fields set here
   * override the tenant default for `dbid`; unset fields inherit it.
   */
  async setDatabaseAccessPolicy(
    dbid: string,
    policy: Partial<Omit<DefaultAccessPolicyDoc, "form" | "type">>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    validateAccessPolicy(policy);
    await this.writePolicyDoc(
      aclDbPolicyDocId(dbid),
      policy,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
    );
  }

  /** Shared writer for default / per-db policy documents. */
  private async writePolicyDoc(
    docId: string,
    policy: Partial<Omit<DefaultAccessPolicyDoc, "form" | "type">>,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      docId,
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = "defaultpolicy";
        for (const [key, value] of Object.entries(policy)) {
          if (value !== undefined) data[key] = value;
        }
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
    );
    await this.updateUnifiedCache();
  }

  /**
   * Create or replace an access-control rule (§6.3). A rule with `withfields`
   * is Tier 2 (client-enforced); otherwise it is Tier 1 (server-enforced). The
   * spec is validated before writing.
   */
  async createAccessRule(
    rule: {
      ruleId: string;
      type: RuleType;
      dbid?: string;
      action?: "allow" | "deny";
      users_hashes?: string[];
      /** Usernames to target; resolved to their (salted v2) hashes. */
      usernames?: string[];
      /** Group names to target; resolved to their (salted v2) hashes. */
      groups?: string[];
      withfields?: WithFieldClause[];
      description?: string;
    },
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    // Resolve any username/group names into hashes and merge with explicit
    // hashes / pseudo-tokens (§6.3). Names are hashed the same way as
    // membership entries so they intersect the acting user's identity set.
    const resolvedHashes = await this.resolveRuleTargetHashes(rule);

    const ruleDoc: AclRuleDoc = {
      form: ACCESS_CONTROL_FORM,
      type: rule.type,
      ruleId: rule.ruleId,
      description: rule.description,
      dbid: rule.dbid ?? "*",
      withfields: rule.withfields,
      users_hashes: Array.from(resolvedHashes),
      users_encrypted: await this.encryptRuleTargetsForTenant({
        usernames: rule.usernames ?? [],
        groups: rule.groups ?? [],
      }),
      action: rule.action ?? "allow",
    };
    // Fail fast on malformed clauses / operators (§6.3 closed set).
    validateAclRule(ruleDoc);

    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      aclRuleDocId(rule.ruleId),
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = ruleDoc.type;
        data.ruleId = ruleDoc.ruleId;
        data.dbid = ruleDoc.dbid;
        data.action = ruleDoc.action;
        data.users_hashes = ruleDoc.users_hashes;
        data.users_encrypted = ruleDoc.users_encrypted;
        if (ruleDoc.description !== undefined) data.description = ruleDoc.description;
        if (ruleDoc.withfields !== undefined) data.withfields = ruleDoc.withfields;
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
    );
    await this.updateUnifiedCache();
  }

  /**
   * List access-control rules currently in effect (§9), optionally filtered by
   * operation type and/or database. Rules with `dbid: "*"` match any database.
   */
  async listRules(
    filter?: { type?: RuleType; dbid?: string },
  ): Promise<Array<AclRuleDoc & { targets?: RuleTargets }>> {
    const head = await this.getDirectoryStateHead();
    const out: Array<AclRuleDoc & { targets?: RuleTargets }> = [];
    for (const [type, rules] of head.rulesByType) {
      if (filter?.type && filter.type !== type) continue;
      for (const rule of rules) {
        if (filter?.dbid && rule.dbid !== filter.dbid && rule.dbid !== "*") continue;
        const targets = await this.decryptRuleTargetsForTenant(rule.users_encrypted);
        out.push(targets ? { ...rule, targets } : rule);
      }
    }
    return out;
  }

  /** Delete an access-control rule by id (§9): a soft-delete of its document. */
  async deleteRule(
    ruleId: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    try {
      await directoryDB.deleteDocument(aclRuleDocId(ruleId), {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.debug(`deleteRule: rule ${ruleId} not found or already deleted: ${error}`);
    }
    await this.updateUnifiedCache();
  }

  /**
   * Add (or refresh) a trusted witness (§6.4). The witness document is keyed by
   * a fingerprint of its public key so add/remove are symmetric.
   */
  async addTrustedWitness(
    witness: { witnessPublicKey: string; serverUrl?: string },
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const fingerprint = await this.sha256Hex(witness.witnessPublicKey);
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      aclTrustedWitnessDocId(fingerprint),
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = "trustedwitness";
        data.witnessPublicKey = witness.witnessPublicKey;
        if (witness.serverUrl !== undefined) data.serverUrl = witness.serverUrl;
      },
      { signingKeyPair: adminSigningKeyPair, signingKeyPassword: administrationPrivateKeyPassword },
    );
    await this.updateUnifiedCache();
  }

  /** Remove a trusted witness by its public key (§6.4): soft-deletes its document. */
  async removeTrustedWitness(
    witnessPublicKey: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const fingerprint = await this.sha256Hex(witnessPublicKey);
    try {
      await directoryDB.deleteDocument(aclTrustedWitnessDocId(fingerprint), {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.debug(`removeTrustedWitness: witness not found: ${error}`);
    }
    await this.updateUnifiedCache();
  }

  /**
   * Add device key pairs to a user's grant (§6.5 key rollover / new device).
   * Pairs are merged by signing key (a pair with an already-present signing key
   * updates its encryption key/label). See {@link mergeKeyPairs}.
   */
  async addUserKeys(
    username: string,
    keyPairs: GrantKeyPair[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const additions = keyPairs.map((pair) => {
      const trimmedLabel = typeof pair.label === "string" ? pair.label.trim() : "";
      return trimmedLabel.length > 0
        ? { ...pair, label: trimmedLabel }
        : { signingPublicKey: pair.signingPublicKey, encryptionPublicKey: pair.encryptionPublicKey };
    });
    await this.editGrantArrays(
      username,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      (data) => {
        applyKeyPairFields(data, mergeKeyPairs(extractKeyPairs(data), additions));
      },
    );
  }

  /**
   * Revoke keys from a user's grant (§6.5 revoke a device/key). A device is
   * identified by its signing key; revoking a signing key marks its entire
   * paired entry revoked. `encryptionKeys` additionally targets any pair whose
   * encryption key matches (kept for callers that target encryption keys
   * directly).
   *
   * Revoked pairs are RETAINED on the grant document with `revoked: true` and a
   * `revokedAt` timestamp (instead of being deleted), so admin UIs can list and
   * optionally restore revoked devices. They are excluded from the active key
   * arrays (via {@link applyKeyPairFields}), so the server/auth treat them as
   * having no access — identical observable behavior to the previous
   * delete-based revocation.
   */
  async removeUserKeys(
    username: string,
    signingKeys: string[],
    encryptionKeys: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const signingToRemove = new Set(signingKeys);
    const encToRemove = new Set(encryptionKeys);
    const revokedAt = Date.now();
    await this.editGrantArrays(
      username,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      (data) => {
        const next = extractKeyPairs(data).map((pair) => {
          if (pair.revoked) return pair; // already revoked; keep timestamp
          const targeted =
            signingToRemove.has(pair.signingPublicKey) ||
            (pair.encryptionPublicKey.length > 0 && encToRemove.has(pair.encryptionPublicKey));
          if (!targeted) return pair;
          return { ...pair, revoked: true, revokedAt };
        });
        applyKeyPairFields(data, next);
      },
    );
  }

  /**
   * Set or clear the label of a device's key pair, identified by its signing
   * public key (§6.5). An empty/whitespace `label` clears it. No-op if no pair
   * with that signing key exists on the user's grant.
   */
  async setKeyPairLabel(
    username: string,
    signingPublicKey: string,
    label: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const trimmedLabel = typeof label === "string" ? label.trim() : "";
    await this.editGrantArrays(
      username,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      (data) => {
        const pairs = extractKeyPairs(data);
        let changed = false;
        const next = pairs.map((pair) => {
          if (pair.signingPublicKey !== signingPublicKey) return pair;
          changed = true;
          if (trimmedLabel.length > 0) {
            return { ...pair, label: trimmedLabel };
          }
          // Clear the label by dropping the field entirely, preserving any
          // retained-revocation flags (§6.5).
          const { label: _dropLabel, ...rest } = pair;
          return rest;
        });
        // Only rewrite when this grant actually carries the targeted key, to
        // avoid touching other grant documents for the same user.
        if (changed) applyKeyPairFields(data, next);
      },
    );
  }

  /**
   * Request a remote wipe of specific devices (§6.5). Targets devices by signing
   * public key; the values are stored self-contained in
   * `wipeRequestedForSigningKeys` so they survive key removal. This is an
   * explicit, opt-in directive and is independent of revocation.
   */
  async requestDeviceWipe(
    username: string,
    signingKeys: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    await this.editGrantArrays(
      username,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      (data) => {
        data.wipeRequestedForSigningKeys = unionStrings(
          extractWipeRequestedSigningKeys(data),
          signingKeys,
        );
      },
    );
  }

  /** Cancel a previously-requested device wipe for the given signing keys (§6.5). */
  async cancelDeviceWipe(
    username: string,
    signingKeys: string[],
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const toCancel = new Set(signingKeys);
    await this.editGrantArrays(
      username,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      (data) => {
        data.wipeRequestedForSigningKeys = extractWipeRequestedSigningKeys(data).filter(
          (k) => !toCancel.has(k),
        );
      },
    );
  }

  /**
   * Read the current grant overview for a user, for prefilling an admin
   * "manage user" UI: the decrypted user-details payload (requires the tenant
   * default key, which the admin client holds), the active device key pairs,
   * and the retained revoked device key pairs (each with its `revokedAt` and
   * remote-wipe status). Devices are de-duplicated by signing key across the
   * user's grant documents (most recent wins).
   */
  async getUserGrantOverview(username: string): Promise<{
    details: DirectoryUserDetails | null;
    activeDevices: GrantKeyPairInfo[];
    revokedDevices: Array<GrantKeyPair & { wipeRequested: boolean }>;
  }> {
    const grants = await this.findGrantAccessDocuments(username);
    const active = new Map<string, GrantKeyPairInfo>();
    const revoked = new Map<string, GrantKeyPair & { wipeRequested: boolean }>();
    let details: DirectoryUserDetails | null = null;
    for (const grant of grants) {
      const data = grant.getData();
      const wipeRequestedKeys = new Set(extractWipeRequestedSigningKeys(data));
      for (const pair of extractActiveKeyPairs(data)) {
        active.set(pair.signingPublicKey, {
          ...pair,
          wipeRequested: wipeRequestedKeys.has(pair.signingPublicKey),
        });
        revoked.delete(pair.signingPublicKey);
      }
      for (const pair of extractRevokedKeyPairs(data)) {
        if (active.has(pair.signingPublicKey)) continue;
        revoked.set(pair.signingPublicKey, {
          ...pair,
          wipeRequested: wipeRequestedKeys.has(pair.signingPublicKey),
        });
      }
      if (typeof data.user_details_encrypted === "string" && data.user_details_encrypted) {
        const decoded = await this.decryptUserDetailsForTenant(data);
        if (decoded) details = decoded;
      }
    }
    return {
      details,
      activeDevices: Array.from(active.values()),
      revokedDevices: Array.from(revoked.values()),
    };
  }

  /**
   * Apply a batch of admin-signed edits to a user's grant in a single change per
   * grant document (docs/accesscontrol.md §6.5). In one pass this:
   *  - rewrites `user_details_encrypted` (when `changes.details` is supplied),
   *  - recomputes the `identity_hashes` bundle + version (the per-user backfill
   *    trigger for grants written before the bundle existed),
   *  - sets per-device labels (`deviceLabels`: signing key → label; empty clears),
   *  - revokes devices (`revokeSigningKeys`: marks `revoked:true` + `revokedAt`,
   *    retaining the pair) and restores devices (`restoreSigningKeys`: clears the
   *    revoked flags, moving the key back to active and dropping any wipe flag),
   *  - and sets the remote-wipe set (`wipeSigningKeys`, authoritative when
   *    supplied) minus any restored keys.
   *
   * This is the SDK primitive behind the Haven "Manage user" dialog's batched
   * Save: every staged change is committed atomically per grant document.
   */
  async updateUserGrant(
    username: string,
    changes: {
      details?: DirectoryUserDetails;
      deviceLabels?: Record<string, string>;
      revokeSigningKeys?: string[];
      restoreSigningKeys?: string[];
      wipeSigningKeys?: string[];
    },
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const revokeSet = new Set(changes.revokeSigningKeys ?? []);
    const restoreSet = new Set(changes.restoreSigningKeys ?? []);
    const labels = changes.deviceLabels ?? {};
    const now = Date.now();

    // Precompute async-derived fields before the (sync) per-doc mutate.
    const userDetailsEncrypted = changes.details
      ? await this.encryptUserDetailsForTenant(
          this.buildUserDetailsPayload(username, changes.details),
        )
      : null;
    const identityHashes = await this.computeIdentityHashes(username);

    await this.editGrantArrays(
      username,
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      (data) => {
        if (userDetailsEncrypted !== null) {
          data.user_details_encrypted = userDetailsEncrypted;
          data.user_details_encrypted_key = DEFAULT_TENANT_KEY_ID;
        }
        // Recompute the $publicinfos-readable identity-hash bundle (§6.5).
        data.identity_hashes = identityHashes;
        data.identity_hashes_v = BaseMindooTenantDirectory.IDENTITY_VARIANTS_VERSION;

        // Per-device labels + revoke/restore flags, preserving retention.
        const next = extractKeyPairs(data).map((pair) => {
          let p: GrantKeyPair = pair;
          if (Object.prototype.hasOwnProperty.call(labels, pair.signingPublicKey)) {
            const trimmed = (labels[pair.signingPublicKey] ?? "").trim();
            if (trimmed.length > 0) {
              p = { ...p, label: trimmed };
            } else {
              const { label: _dropLabel, ...rest } = p;
              p = rest;
            }
          }
          if (restoreSet.has(pair.signingPublicKey)) {
            // Un-revoke: clear the retention flags, moving the key back to active.
            const { revoked: _r, revokedAt: _ra, ...rest } = p;
            p = rest;
          } else if (revokeSet.has(pair.signingPublicKey) && !p.revoked) {
            p = { ...p, revoked: true, revokedAt: now };
          }
          return p;
        });
        applyKeyPairFields(data, next);

        // Remote-wipe set: authoritative when supplied (else preserve existing),
        // restricted to keys present on this grant doc and never for restored keys.
        const present = new Set(next.map((p) => p.signingPublicKey));
        const desiredWipe = changes.wipeSigningKeys ?? extractWipeRequestedSigningKeys(data);
        data.wipeRequestedForSigningKeys = Array.from(
          new Set(desiredWipe.filter((k) => present.has(k) && !restoreSet.has(k))),
        );
      },
    );
  }

  /**
   * Predict whether the current user may perform `op` on `dbid` (§9). Pure read;
   * evaluates Tier 1 + Tier 2 against the head directory state, treating the
   * caller as the prospective author. `candidateDoc` supplies the content that
   * `withfields` clauses are checked against.
   */
  async canDo(op: RuleType, dbid: string, candidateDoc?: Record<string, unknown>): Promise<AccessDecision> {
    const currentUser = await this.tenant.getCurrentUserId();
    return this.evaluateClientAccess({
      op,
      dbid,
      signingKey: currentUser.userSigningPublicKey,
      trustedTime: Date.now(),
      isAuthor: true,
      beforeDoc: candidateDoc ?? null,
      afterDoc: candidateDoc ?? null,
    });
  }

  /**
   * Audit query (§9): would `username` have been allowed to perform `op` on
   * `dbid` at trusted time `at`? Evaluates against the directory state as it was
   * at `at`, so historical decisions can be explained.
   */
  async wasAllowedAt(
    op: RuleType,
    username: string,
    dbid: string,
    at: number,
    candidateDoc?: Record<string, unknown>,
  ): Promise<AccessDecision> {
    const node = await this.getDirectoryStateAt(at);
    const identity = await this.buildIdentitySet(username, { isAuthor: op === "doc_create" });
    return evaluateAccess({
      op,
      dbid,
      identity,
      node,
      beforeDoc: candidateDoc ?? null,
      afterDoc: candidateDoc ?? null,
      isServer: false,
    });
  }

  // -------------------------------------------------------------------------
  // Key distribution (admin-blind, declarative). ONE singleton document per key
  // (`acl_keydistribution_<keyId>`) is the source of truth for who holds the
  // key. A key-HOLDER wraps every key version to each recipient device's RSA
  // encryption public key; an ADMIN merely signs and writes the document, so an
  // admin outside the recipient set never sees plaintext. Syncing clients
  // reconcile their KeyBag against the head state (docs/accesscontrol.md §13).
  // -------------------------------------------------------------------------

  /**
   * All ACTIVE (non-revoked) RSA encryption public keys (PEM) for `username`
   * across the user's grant documents — one per active device. De-duplicated.
   */
  async getUserEncryptionPublicKeys(username: string): Promise<string[]> {
    const grants = await this.findGrantAccessDocuments(username);
    const keys = new Set<string>();
    for (const grant of grants) {
      for (const pem of extractEncryptionPublicKeys(grant.getData())) {
        if (pem) keys.add(pem);
      }
    }
    return Array.from(keys);
  }

  /**
   * Fingerprint of an RSA encryption public key (PEM): SHA-256 over the decoded
   * SPKI body, first 8 bytes as colon-separated hex. Matches Haven's
   * `getPublicKeyFingerprint`, so the device-map keys built here line up with
   * what Haven UIs display. Stable for a given key value across wrap (key-holder)
   * and reconcile (recipient) sides.
   */
  private async encryptionKeyFingerprint(pem: string): Promise<string> {
    const body = pem
      .replace(/-----BEGIN [^-]+-----/g, "")
      .replace(/-----END [^-]+-----/g, "")
      .replace(/\s+/g, "");
    let source: Uint8Array;
    try {
      source = body ? this.base64ToBytes(body) : new TextEncoder().encode(pem);
    } catch {
      source = new TextEncoder().encode(pem);
    }
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const digest = await subtle.digest("SHA-256", source as unknown as BufferSource);
    return Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(":");
  }

  /**
   * Wrap every stored version of `keyId` (from the caller's KeyBag) to ALL
   * active encryption devices of `username`, producing the exact `pushto`
   * device-map shape used by both the distribution doc (`pushto_users_keys`) and
   * the request URI (`KeyDistributionRequest.pushto[].devices`):
   * `deviceEncKeyFingerprint -> { versionFingerprint -> wrappedKey(b64) }`.
   * Throws if the caller does not hold the key or the recipient has no active
   * encryption device.
   */
  async wrapKeyForUserDevices(keyId: string, username: string): Promise<KeyDistributionPushRecipient> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const versions = await baseTenant.fingerprintKeyVersions(keyId);
    if (versions.length === 0) {
      throw new Error(`Cannot wrap key: key "${keyId}" is not in your KeyBag`);
    }
    const devicePems = await this.getUserEncryptionPublicKeys(username);
    if (devicePems.length === 0) {
      throw new Error(`Cannot wrap key: recipient "${username}" has no active encryption device`);
    }
    const rsa = new RSAEncryption(this.tenant.getCryptoAdapter(), this.logger.createChild("RSAEncryption"));
    const devices: Record<string, DeviceWrappedVersions> = {};
    for (const pem of devicePems) {
      const deviceFp = await this.encryptionKeyFingerprint(pem);
      const wrappedByVersion: DeviceWrappedVersions = {};
      for (const version of versions) {
        const wrapped = await rsa.encrypt(version.bytes, pem);
        wrappedByVersion[version.fingerprint] = this.bytesToBase64(wrapped);
      }
      devices[deviceFp] = wrappedByVersion;
    }
    return {
      username,
      username_hash: await this.hashUsernameForWrite(username),
      devices,
    };
  }

  /**
   * The canonical write-time hash for `username` (the value stored in
   * `pushto_users_hashes` / `pullfrom_users_hashes`). Exposed so callers (the
   * Haven dialog/session) can build `pullfrom` entries for users they are
   * removing.
   */
  async getUsernameHash(username: string): Promise<string> {
    return this.hashUsernameForWrite(username);
  }

  /**
   * The version manifest (`{createdAt, fingerprint}`) of `keyId` from the
   * caller's KeyBag. The single source of truth for the distribution's
   * `keyVersions`. Empty when the key is not held.
   */
  async getKeyVersionManifest(keyId: string): Promise<KeyVersionRef[]> {
    const versions = await (this.tenant as BaseMindooTenant).fingerprintKeyVersions(keyId);
    return versions.map((v) => ({ createdAt: v.createdAt, fingerprint: v.fingerprint }));
  }

  /** Encrypt a UTF-8 string with the tenant default key, base64-encoded. */
  private async encryptToDefaultField(plaintext: string): Promise<string> {
    const payload = new TextEncoder().encode(plaintext);
    const encrypted = await this.tenant.encryptPayload(payload, DEFAULT_TENANT_KEY_ID);
    return this.uint8ArrayToBase64(encrypted);
  }

  /**
   * Admin-sign and upsert the singleton `acl_keydistribution_<keyId>` document
   * from a {@link KeyDistributionRequest} (built in-dialog or decoded from a
   * request URI). The full desired state is written each time. Validates the
   * structural invariants plus, against the directory, that every `pushto` user
   * has an active grant and every active device is covered by wrapped material.
   */
  async publishKeyDistribution(
    request: KeyDistributionRequest,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const keyId = request.keyId;

    // Fold per-recipient device maps into the doc's flat `<hash>|<deviceFp>` map.
    const pushtoUsersKeys: Record<string, DeviceWrappedVersions> = {};
    for (const p of request.pushto) {
      for (const [deviceFp, wrapped] of Object.entries(p.devices)) {
        pushtoUsersKeys[`${p.username_hash}|${deviceFp}`] = wrapped;
      }
    }
    const pushtoHashes = request.pushto.map((p) => p.username_hash);
    const pullfromHashes = request.pullfrom.map((p) => p.username_hash);

    validateKeyDistribution({
      keyId,
      keyVersions: request.keyVersions,
      pushto_users_hashes: pushtoHashes,
      pullfrom_users_hashes: pullfromHashes,
      pushto_users_keys: pushtoUsersKeys,
    });

    // Directory-level validation: every pushto user must have an active grant,
    // and every active encryption device must have wrapped material (otherwise a
    // newly-added device could not decrypt — re-wrap is required).
    const manifestFps = new Set(request.keyVersions.map((v) => v.fingerprint));
    for (const p of request.pushto) {
      const userKeys = await this.getUserPublicKeys(p.username);
      if (!userKeys) {
        throw new Error(`Cannot publish: pushto user "${p.username}" has no active grant`);
      }
      const activePems = await this.getUserEncryptionPublicKeys(p.username);
      for (const pem of activePems) {
        const deviceFp = await this.encryptionKeyFingerprint(pem);
        const wrapped = p.devices[deviceFp];
        if (!wrapped) {
          throw new Error(
            `Cannot publish: pushto user "${p.username}" has an active device without wrapped key material (re-wrap required)`,
          );
        }
        const covered = Object.keys(wrapped);
        if (covered.length !== manifestFps.size || covered.some((fp) => !manifestFps.has(fp))) {
          throw new Error(
            `Cannot publish: device coverage for "${p.username}" does not match the version manifest`,
          );
        }
      }
    }

    const titleEncrypted = await this.encryptToDefaultField(request.title ?? keyId);
    const commentEncrypted = request.comment
      ? await this.encryptToDefaultField(request.comment)
      : undefined;
    const pushtoUsernamesEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pushto.map((p) => p.username)),
    );
    const pullfromUsernamesEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pullfrom.map((p) => p.username)),
    );

    const docId = aclKeyDistributionDocId(keyId);
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      docId,
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = KEY_DISTRIBUTION_TYPE;
        data.keyId = keyId;
        data.keyVersions = request.keyVersions.map((v) => ({
          createdAt: v.createdAt,
          fingerprint: v.fingerprint,
        }));
        data.preparedByPublicKey = request.preparedByPublicKey;
        data.title_encrypted = titleEncrypted;
        data.title_encrypted_key = "default";
        if (commentEncrypted !== undefined) {
          data.comment_encrypted = commentEncrypted;
          data.comment_encrypted_key = "default";
        } else {
          delete data.comment_encrypted;
          delete data.comment_encrypted_key;
        }
        data.pushto_users_hashes = pushtoHashes;
        data.pushto_users_encrypted = pushtoUsernamesEncrypted;
        data.pushto_users_encrypted_key = "default";
        data.pushto_users_keys = pushtoUsersKeys;
        data.pullfrom_users_hashes = pullfromHashes;
        data.pullfrom_users_encrypted = pullfromUsernamesEncrypted;
        data.pullfrom_users_encrypted_key = "default";
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
    );
    await this.updateUnifiedCache();
  }

  /**
   * Decrypt a `<field>_encrypted` JSON array of strings on a distribution doc.
   * Returns null when the field is missing/unreadable (e.g. the tenant default
   * key is not held).
   */
  private async decryptUsernameArray(
    data: Record<string, unknown>,
    fieldName: string,
  ): Promise<string[] | null> {
    const decoded = await decryptEncryptedField(this.tenant, data, fieldName);
    if (decoded === null) return null;
    try {
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Parse a raw distribution doc's data into a {@link KeyDistributionView}. */
  private async toKeyDistributionView(data: Record<string, unknown>): Promise<KeyDistributionView | null> {
    if (data.type !== KEY_DISTRIBUTION_TYPE || typeof data.keyId !== "string") return null;
    const keyVersions = Array.isArray(data.keyVersions)
      ? (data.keyVersions as unknown[])
          .filter(
            (v): v is KeyVersionRef =>
              !!v && typeof (v as KeyVersionRef).fingerprint === "string",
          )
          .map((v) => ({ createdAt: Number(v.createdAt) || 0, fingerprint: v.fingerprint }))
      : [];
    const title = await decryptEncryptedField(this.tenant, data, "title_encrypted");
    const comment = await decryptEncryptedField(this.tenant, data, "comment_encrypted");
    return {
      keyId: data.keyId,
      title,
      comment,
      keyVersions,
      preparedByPublicKey: typeof data.preparedByPublicKey === "string" ? data.preparedByPublicKey : "",
      pushto_users_hashes: Array.isArray(data.pushto_users_hashes)
        ? (data.pushto_users_hashes as unknown[]).filter((h): h is string => typeof h === "string")
        : [],
      pushto_users_keys:
        data.pushto_users_keys && typeof data.pushto_users_keys === "object"
          ? (data.pushto_users_keys as Record<string, DeviceWrappedVersions>)
          : {},
      pullfrom_users_hashes: Array.isArray(data.pullfrom_users_hashes)
        ? (data.pullfrom_users_hashes as unknown[]).filter((h): h is string => typeof h === "string")
        : [],
      pushtoUsernames: await this.decryptUsernameArray(data, "pushto_users_encrypted"),
      pullfromUsernames: await this.decryptUsernameArray(data, "pullfrom_users_encrypted"),
    };
  }

  /**
   * List all key-distribution documents at the directory head as
   * {@link KeyDistributionView}s (decrypting display fields when the tenant
   * default key is held; null-tolerant otherwise).
   */
  async listKeyDistributions(): Promise<KeyDistributionView[]> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    const allIds = await directoryDB.getAllDocumentIds();
    const ids = allIds.filter((id) => id.startsWith(ACL_KEY_DISTRIBUTION_PREFIX));
    const views: KeyDistributionView[] = [];
    for (const id of ids) {
      let doc: MindooDoc;
      try {
        doc = await directoryDB.getDocument(id);
      } catch {
        continue;
      }
      if (!doc) continue;
      const view = await this.toKeyDistributionView(doc.getData());
      if (view) views.push(view);
    }
    return views;
  }

  /** Delete the singleton distribution document for `keyId` (admin-signed). */
  async deleteKeyDistribution(
    keyId: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    try {
      await directoryDB.deleteDocument(aclKeyDistributionDocId(keyId), {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.debug(`deleteKeyDistribution: ${keyId} not found or already deleted: ${error}`);
    }
    await this.updateUnifiedCache();
  }

  /**
   * Internal entry point for `MindooTenant.reconcileKeyDistributionsForCurrentUser`'s
   * import pass ({@link KeyBagReconciler}). Unlocks this directory's OWN tenant
   * session key and merges the key versions pushed to `username`. The key never
   * crosses an API boundary — callers cannot supply a foreign one. Returns the
   * imported/removed ids; both empty when the host is locked (no session key).
   */
  async reconcileImportedKeysForCurrentUser(
    username: string,
  ): Promise<{ imported: string[]; removed: string[] }> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const key = await baseTenant.getEncryptionPrivateKeyForReconcile();
    if (!key) {
      this.logger.debug(
        "reconcileImportedKeysForCurrentUser: no encryption key available; " +
          "skipping import pass (revoke pass still ran)",
      );
      return { imported: [], removed: [] };
    }
    return this.reconcileKeyDistributionsWithKey(username, key);
  }

  /**
   * Reconcile the local KeyBag against the directory head for `username`
   * (docs/accesscontrol.md §13), driven by an already-imported RSA-OAEP private
   * {@link CryptoKey} (usage `["decrypt"]`). Pure function of (head, bag):
   * idempotent and convergent, so an offline client catches up after one sync.
   * Private: the only callers are this class's own
   * {@link reconcileImportedKeysForCurrentUser}, which sources the key from the
   * tenant, so no foreign key is ever applied to the bag. Per
   * `acl_keydistribution_` doc:
   *
   *  - **pullfrom** (wins): remove the whole key id from the bag (all versions),
   *    matching the server's key-id-grain blacklist; a no-op when the bag does
   *    not hold it. The KeyBag change feed triggers visibility reconciliation,
   *    purging the scope once the key is gone. Never touches protected ids.
   *  - **pushto**: unwrap own device entries, VERIFY each unwrapped version's
   *    fingerprint against the manifest (reject + log on mismatch), and merge the
   *    missing versions (never destructive). Self-healing: a locally deleted
   *    pushed key is re-imported here.
   *
   * Returns the key ids imported and removed.
   */
  private async reconcileKeyDistributionsWithKey(
    username: string,
    encryptionPrivateCryptoKey: CryptoKey,
  ): Promise<{ imported: string[]; removed: string[] }> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();

    if (this.keyDistributionCache.size === 0) return { imported: [], removed: [] };

    const myHashes = new Set(await this.usernameHashCandidates(username));
    const baseTenant = this.tenant as BaseMindooTenant;

    const privateKey = encryptionPrivateCryptoKey;
    const rsa = new RSAEncryption(this.tenant.getCryptoAdapter(), this.logger.createChild("RSAEncryption"));

    const imported: string[] = [];
    const removed: string[] = [];

    for (const [keyId, entry] of this.keyDistributionCache.entries()) {
      if (PROTECTED_DISTRIBUTION_KEY_IDS.includes(keyId)) continue;

      const manifest: KeyVersionRef[] = entry.keyVersions;
      const meInPull = entry.pullfrom_users_hashes.some((h) => myHashes.has(h));
      const meInPush = entry.pushto_users_hashes.some((h) => myHashes.has(h));

      // Pull wins over push if a CRDT merge ever overlapped the lists. Revocation
      // removes the whole key id from the bag (matching the server's key-id-grain
      // blacklist); a no-op when the bag does not hold it.
      if (meInPull) {
        const didRemove = await baseTenant.removeNamedDecryptionKey(keyId);
        if (didRemove) removed.push(keyId);
        continue;
      }

      if (!meInPush) continue;

      const wrappedMap = entry.pushto_users_keys;

      // Collect device entries addressed to me (by hash prefix). We do not know
      // which device is ours without trying, so attempt to unwrap each; only our
      // private key succeeds.
      const myEntries = Object.entries(wrappedMap).filter(([entryKey]) => {
        const hash = entryKey.split("|")[0];
        return myHashes.has(hash);
      });
      if (myEntries.length === 0) continue;

      const collected = new Map<string, { bytes: Uint8Array; keyVersionCreatedAt: number }>();
      for (const [, wrappedByVersion] of myEntries) {
        for (const ref of manifest) {
          if (collected.has(ref.fingerprint)) continue;
          const wrappedB64 = wrappedByVersion[ref.fingerprint];
          if (typeof wrappedB64 !== "string") continue;
          try {
            const bytes = await rsa.decrypt(this.base64ToBytes(wrappedB64), privateKey);
            const actualFp = await baseTenant.fingerprintKeyBytes(bytes);
            if (actualFp !== ref.fingerprint) {
              this.logger.warn(
                `reconcileKeyDistributions: fingerprint mismatch for ${keyId}@${ref.fingerprint} (got ${actualFp}); rejecting`,
              );
              continue;
            }
            collected.set(ref.fingerprint, { bytes, keyVersionCreatedAt: ref.createdAt });
          } catch {
            // Not our device entry (or corrupt); try the next one.
          }
        }
        if (collected.size === manifest.length) break;
      }

      if (collected.size === 0) continue;
      const count = await baseTenant.importDeliveredDecryptionKeyVersions(
        keyId,
        Array.from(collected.values()),
      );
      if (count > 0) imported.push(keyId);
    }

    return { imported, removed };
  }

  /**
   * Whether `keyId` is managed by a distribution at the directory head AND the
   * current/given user is in its `pushto` list (status is derived, never
   * persisted in the KeyBag).
   */
  async getManagedKeyIds(username: string): Promise<string[]> {
    const myHashes = new Set(await this.usernameHashCandidates(username));
    const views = await this.listKeyDistributions();
    return views
      .filter((v) => v.pushto_users_hashes.some((h) => myHashes.has(h)))
      .map((v) => v.keyId);
  }

  // -------------------------------------------------------------------------
  // App distribution (docs/accesscontrol.md §13). Mirrors key distribution; the
  // payload is a Haven application registration and recipient lists support
  // both users and groups, resolved client-side at reconcile time.
  // -------------------------------------------------------------------------

  /**
   * Admin-sign and upsert the singleton `acl_appdistribution_<appId>` document
   * from an {@link AppDistributionRequest} (built in-dialog or decoded from a
   * request URI). The full desired state is written each time. Validates the
   * structural invariants plus, against the directory, that every `pushto` user
   * has an active grant.
   */
  async publishAppDistribution(
    request: AppDistributionRequest,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const appId = request.appId;

    const pushtoUserHashes = await Promise.all(
      request.pushtoUsernames.map((u) => this.hashUsernameForWrite(u)),
    );
    const pullfromUserHashes = await Promise.all(
      request.pullfromUsernames.map((u) => this.hashUsernameForWrite(u)),
    );
    const pushtoGroupHashes = await Promise.all(
      request.pushtoGroups.map((g) => this.hashUsernameForWrite(this.normalizeGroupName(g))),
    );
    const pullfromGroupHashes = await Promise.all(
      request.pullfromGroups.map((g) => this.hashUsernameForWrite(this.normalizeGroupName(g))),
    );

    validateAppDistribution({
      appId,
      pushto_users_hashes: pushtoUserHashes,
      pullfrom_users_hashes: pullfromUserHashes,
      pushto_groups_hashes: pushtoGroupHashes,
      pullfrom_groups_hashes: pullfromGroupHashes,
    });

    // Directory-level validation: every pushto user must have an active grant.
    for (const username of request.pushtoUsernames) {
      const userKeys = await this.getUserPublicKeys(username);
      if (!userKeys) {
        throw new Error(`Cannot publish: pushto user "${username}" has no active grant`);
      }
    }

    const appidEncrypted = await this.encryptToDefaultField(appId);
    const versionEncrypted = await this.encryptToDefaultField(request.version ?? "");
    const titleEncrypted = await this.encryptToDefaultField(request.title ?? appId);
    const commentEncrypted = request.comment
      ? await this.encryptToDefaultField(request.comment)
      : undefined;
    const appdataEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.appData ?? {}),
    );
    const pushtoUsernamesEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pushtoUsernames),
    );
    const pushtoGroupsEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pushtoGroups),
    );
    const pullfromUsernamesEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pullfromUsernames),
    );
    const pullfromGroupsEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pullfromGroups),
    );

    const docId = aclAppDistributionDocId(appId);
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      docId,
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = APP_DISTRIBUTION_TYPE;
        data.appId = appId;
        data.appid_encrypted = appidEncrypted;
        data.appid_encrypted_key = "default";
        data.version_encrypted = versionEncrypted;
        data.version_encrypted_key = "default";
        data.title_encrypted = titleEncrypted;
        data.title_encrypted_key = "default";
        if (commentEncrypted !== undefined) {
          data.comment_encrypted = commentEncrypted;
          data.comment_encrypted_key = "default";
        } else {
          delete data.comment_encrypted;
          delete data.comment_encrypted_key;
        }
        data.appdata_encrypted = appdataEncrypted;
        data.appdata_encrypted_key = "default";
        data.preparedByPublicKey = request.preparedByPublicKey;
        data.pushto_users_hashes = pushtoUserHashes;
        data.pushto_users_encrypted = pushtoUsernamesEncrypted;
        data.pushto_users_encrypted_key = "default";
        data.pushto_groups_hashes = pushtoGroupHashes;
        data.pushto_groups_encrypted = pushtoGroupsEncrypted;
        data.pushto_groups_encrypted_key = "default";
        data.pullfrom_users_hashes = pullfromUserHashes;
        data.pullfrom_users_encrypted = pullfromUsernamesEncrypted;
        data.pullfrom_users_encrypted_key = "default";
        data.pullfrom_groups_hashes = pullfromGroupHashes;
        data.pullfrom_groups_encrypted = pullfromGroupsEncrypted;
        data.pullfrom_groups_encrypted_key = "default";
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
    );
    await this.updateUnifiedCache();
  }

  /** Parse a raw app-distribution doc's data into an {@link AppDistributionView}. */
  private async toAppDistributionView(
    data: Record<string, unknown>,
  ): Promise<AppDistributionView | null> {
    if (data.type !== APP_DISTRIBUTION_TYPE || typeof data.appId !== "string") return null;
    const stringArray = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((h): h is string => typeof h === "string") : [];
    const title = await decryptEncryptedField(this.tenant, data, "title_encrypted");
    const comment = await decryptEncryptedField(this.tenant, data, "comment_encrypted");
    const version = await decryptEncryptedField(this.tenant, data, "version_encrypted");
    let appData: unknown | null = null;
    const appdataDecoded = await decryptEncryptedField(this.tenant, data, "appdata_encrypted");
    if (appdataDecoded !== null) {
      try {
        appData = JSON.parse(appdataDecoded);
      } catch {
        appData = null;
      }
    }
    return {
      appId: data.appId,
      title,
      comment,
      version,
      appData,
      preparedByPublicKey:
        typeof data.preparedByPublicKey === "string" ? data.preparedByPublicKey : "",
      pushto_users_hashes: stringArray(data.pushto_users_hashes),
      pushto_groups_hashes: stringArray(data.pushto_groups_hashes),
      pullfrom_users_hashes: stringArray(data.pullfrom_users_hashes),
      pullfrom_groups_hashes: stringArray(data.pullfrom_groups_hashes),
      pushtoUsernames: await this.decryptUsernameArray(data, "pushto_users_encrypted"),
      pushtoGroups: await this.decryptUsernameArray(data, "pushto_groups_encrypted"),
      pullfromUsernames: await this.decryptUsernameArray(data, "pullfrom_users_encrypted"),
      pullfromGroups: await this.decryptUsernameArray(data, "pullfrom_groups_encrypted"),
    };
  }

  /**
   * List all app-distribution documents at the directory head as
   * {@link AppDistributionView}s (decrypting display fields when the tenant
   * default key is held; null-tolerant otherwise).
   */
  async listAppDistributions(): Promise<AppDistributionView[]> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    const allIds = await directoryDB.getAllDocumentIds();
    const ids = allIds.filter((id) => id.startsWith(ACL_APP_DISTRIBUTION_PREFIX));
    const views: AppDistributionView[] = [];
    for (const id of ids) {
      let doc: MindooDoc;
      try {
        doc = await directoryDB.getDocument(id);
      } catch {
        continue;
      }
      if (!doc) continue;
      const view = await this.toAppDistributionView(doc.getData());
      if (view) views.push(view);
    }
    return views;
  }

  /** Delete the singleton distribution document for `appId` (admin-signed). */
  async deleteAppDistribution(
    appId: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    try {
      await directoryDB.deleteDocument(aclAppDistributionDocId(appId), {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.debug(`deleteAppDistribution: ${appId} not found or already deleted: ${error}`);
    }
    await this.updateUnifiedCache();
  }

  /**
   * Build the set of recipient-matching hashes for `username`: the user's own
   * username-hash candidates plus the hash candidates of every group the user
   * belongs to (resolved against the directory head). App-distribution
   * `pushto`/`pullfrom` group hashes are written as the v3 hash of the
   * normalized group name, which is exactly the v3 candidate of the group name,
   * so a member intersects a group target here.
   */
  private async appDistributionIdentityHashes(username: string): Promise<Set<string>> {
    const hashes = new Set<string>(await this.usernameHashCandidates(username));
    const groups = await this.resolveGroupsForUser(username);
    for (const group of groups) {
      for (const h of await this.usernameHashCandidates(group)) {
        hashes.add(h);
      }
    }
    return hashes;
  }

  /**
   * The per-user app-distribution reconcile plan at the directory head
   * (docs/accesscontrol.md §13): `have` is every app the user is entitled to
   * (matched by `pushto` user/group and NOT by `pullfrom` — pull wins on any
   * overlap), `notHave` is every other distributed app id (the user must not
   * keep it). Drives the Haven install/update/remove pass after a directory
   * sync. Idempotent and convergent.
   */
  async getAppDistributionsForCurrentUser(
    username: string,
  ): Promise<AppDistributionReconcilePlan> {
    const myHashes = await this.appDistributionIdentityHashes(username);
    const views = await this.listAppDistributions();
    const have: AppDistributionReconcilePlan["have"] = [];
    const notHave: string[] = [];
    for (const view of views) {
      const meInPull =
        view.pullfrom_users_hashes.some((h) => myHashes.has(h)) ||
        view.pullfrom_groups_hashes.some((h) => myHashes.has(h));
      const meInPush =
        view.pushto_users_hashes.some((h) => myHashes.has(h)) ||
        view.pushto_groups_hashes.some((h) => myHashes.has(h));
      if (meInPush && !meInPull) {
        have.push({
          appId: view.appId,
          title: view.title ?? "",
          version: view.version ?? "",
          appData: view.appData,
        });
      } else {
        notHave.push(view.appId);
      }
    }
    return { have, notHave };
  }

  /**
   * The app ids the active/given user is entitled to receive via `pushto` at the
   * directory head (status is derived, never persisted). Convenience wrapper
   * over {@link getAppDistributionsForCurrentUser}.
   */
  async getManagedAppIds(username: string): Promise<string[]> {
    const plan = await this.getAppDistributionsForCurrentUser(username);
    return plan.have.map((entry) => entry.appId);
  }

  // -------------------------------------------------------------------------
  // Sync setup policy. Mirrors app distribution; the payload is a list of
  // database ids the targeted clients should have on their Haven Sync page,
  // and the per-policy `mode` controls whether the seeding is just initial
  // (user may change/disable) or permanently enforced (locked to bidirectional).
  // Reconciled client-side after the directory syncs; no server enforcement.
  // -------------------------------------------------------------------------

  /**
   * Admin-sign and upsert the `acl_syncsetuppolicy_<policyId>` document from a
   * {@link SyncSetupPolicyRequest} (built in-dialog or decoded from a request
   * URI). The full desired state is written each time. Validates the structural
   * invariants plus, against the directory, that every `pushto` user has an
   * active grant.
   */
  async publishSyncSetupPolicy(
    request: SyncSetupPolicyRequest,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const policyId = request.policyId;
    const mode: SyncSetupPolicyMode = request.mode === "permanent" ? "permanent" : "initial";
    const databaseIds = Array.isArray(request.databaseIds)
      ? request.databaseIds.map((id) => id.trim()).filter((id) => id.length > 0)
      : [];

    const pushtoUserHashes = await Promise.all(
      request.pushtoUsernames.map((u) => this.hashUsernameForWrite(u)),
    );
    const pullfromUserHashes = await Promise.all(
      request.pullfromUsernames.map((u) => this.hashUsernameForWrite(u)),
    );
    const pushtoGroupHashes = await Promise.all(
      request.pushtoGroups.map((g) => this.hashUsernameForWrite(this.normalizeGroupName(g))),
    );
    const pullfromGroupHashes = await Promise.all(
      request.pullfromGroups.map((g) => this.hashUsernameForWrite(this.normalizeGroupName(g))),
    );

    validateSyncSetupPolicy({
      policyId,
      mode,
      databaseIds,
      pushto_users_hashes: pushtoUserHashes,
      pullfrom_users_hashes: pullfromUserHashes,
      pushto_groups_hashes: pushtoGroupHashes,
      pullfrom_groups_hashes: pullfromGroupHashes,
    });

    // Directory-level validation: every pushto user must have an active grant.
    for (const username of request.pushtoUsernames) {
      const userKeys = await this.getUserPublicKeys(username);
      if (!userKeys) {
        throw new Error(`Cannot publish: pushto user "${username}" has no active grant`);
      }
    }

    const policyidEncrypted = await this.encryptToDefaultField(policyId);
    const titleEncrypted = await this.encryptToDefaultField(request.title ?? policyId);
    const commentEncrypted = request.comment
      ? await this.encryptToDefaultField(request.comment)
      : undefined;
    const databaseidsEncrypted = await this.encryptToDefaultField(JSON.stringify(databaseIds));
    const pushtoUsernamesEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pushtoUsernames),
    );
    const pushtoGroupsEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pushtoGroups),
    );
    const pullfromUsernamesEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pullfromUsernames),
    );
    const pullfromGroupsEncrypted = await this.encryptToDefaultField(
      JSON.stringify(request.pullfromGroups),
    );

    const docId = aclSyncSetupPolicyDocId(policyId);
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      docId,
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = SYNC_SETUP_POLICY_TYPE;
        data.policyId = policyId;
        data.policyid_encrypted = policyidEncrypted;
        data.policyid_encrypted_key = "default";
        data.mode = mode;
        data.title_encrypted = titleEncrypted;
        data.title_encrypted_key = "default";
        if (commentEncrypted !== undefined) {
          data.comment_encrypted = commentEncrypted;
          data.comment_encrypted_key = "default";
        } else {
          delete data.comment_encrypted;
          delete data.comment_encrypted_key;
        }
        data.databaseids_encrypted = databaseidsEncrypted;
        data.databaseids_encrypted_key = "default";
        data.preparedByPublicKey = request.preparedByPublicKey;
        data.pushto_users_hashes = pushtoUserHashes;
        data.pushto_users_encrypted = pushtoUsernamesEncrypted;
        data.pushto_users_encrypted_key = "default";
        data.pushto_groups_hashes = pushtoGroupHashes;
        data.pushto_groups_encrypted = pushtoGroupsEncrypted;
        data.pushto_groups_encrypted_key = "default";
        data.pullfrom_users_hashes = pullfromUserHashes;
        data.pullfrom_users_encrypted = pullfromUsernamesEncrypted;
        data.pullfrom_users_encrypted_key = "default";
        data.pullfrom_groups_hashes = pullfromGroupHashes;
        data.pullfrom_groups_encrypted = pullfromGroupsEncrypted;
        data.pullfrom_groups_encrypted_key = "default";
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
    );
    await this.updateUnifiedCache();
  }

  /** Parse a raw sync-setup-policy doc's data into a {@link SyncSetupPolicyView}. */
  private async toSyncSetupPolicyView(
    data: Record<string, unknown>,
  ): Promise<SyncSetupPolicyView | null> {
    if (data.type !== SYNC_SETUP_POLICY_TYPE || typeof data.policyId !== "string") return null;
    const stringArray = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((h): h is string => typeof h === "string") : [];
    const title = await decryptEncryptedField(this.tenant, data, "title_encrypted");
    const comment = await decryptEncryptedField(this.tenant, data, "comment_encrypted");
    let databaseIds: string[] | null = null;
    const databaseIdsDecoded = await decryptEncryptedField(this.tenant, data, "databaseids_encrypted");
    if (databaseIdsDecoded !== null) {
      try {
        const parsed = JSON.parse(databaseIdsDecoded);
        databaseIds = Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string")
          : null;
      } catch {
        databaseIds = null;
      }
    }
    return {
      policyId: data.policyId,
      mode: data.mode === "permanent" ? "permanent" : "initial",
      title,
      comment,
      databaseIds,
      preparedByPublicKey:
        typeof data.preparedByPublicKey === "string" ? data.preparedByPublicKey : "",
      pushto_users_hashes: stringArray(data.pushto_users_hashes),
      pushto_groups_hashes: stringArray(data.pushto_groups_hashes),
      pullfrom_users_hashes: stringArray(data.pullfrom_users_hashes),
      pullfrom_groups_hashes: stringArray(data.pullfrom_groups_hashes),
      pushtoUsernames: await this.decryptUsernameArray(data, "pushto_users_encrypted"),
      pushtoGroups: await this.decryptUsernameArray(data, "pushto_groups_encrypted"),
      pullfromUsernames: await this.decryptUsernameArray(data, "pullfrom_users_encrypted"),
      pullfromGroups: await this.decryptUsernameArray(data, "pullfrom_groups_encrypted"),
    };
  }

  /**
   * List all sync-setup-policy documents at the directory head as
   * {@link SyncSetupPolicyView}s (decrypting display fields when the tenant
   * default key is held; null-tolerant otherwise).
   */
  async listSyncSetupPolicies(): Promise<SyncSetupPolicyView[]> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    const allIds = await directoryDB.getAllDocumentIds();
    const ids = allIds.filter((id) => id.startsWith(ACL_SYNC_SETUP_POLICY_PREFIX));
    const views: SyncSetupPolicyView[] = [];
    for (const id of ids) {
      let doc: MindooDoc;
      try {
        doc = await directoryDB.getDocument(id);
      } catch {
        continue;
      }
      if (!doc) continue;
      const view = await this.toSyncSetupPolicyView(doc.getData());
      if (view) views.push(view);
    }
    return views;
  }

  /** Delete the sync-setup-policy document for `policyId` (admin-signed). */
  async deleteSyncSetupPolicy(
    policyId: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    try {
      await directoryDB.deleteDocument(aclSyncSetupPolicyDocId(policyId), {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.debug(`deleteSyncSetupPolicy: ${policyId} not found or already deleted: ${error}`);
    }
    await this.updateUnifiedCache();
  }

  /**
   * The per-user sync-setup reconcile plan at the directory head: the union of
   * databases the user is targeted for across all policies (matched by `pushto`
   * user/group), each carrying the effective lock state. A database is locked
   * when a `permanent` policy targets it AND the user is not released via
   * `pullfrom`; lock wins on overlap. A user only present in `pullfrom` (never
   * in `pushto`) is not targeted. Drives the Haven Sync-page seed/lock pass
   * after a directory sync. Idempotent and convergent.
   */
  async getSyncSetupForCurrentUser(
    username: string,
  ): Promise<SyncSetupPolicyReconcilePlan> {
    const myHashes = await this.appDistributionIdentityHashes(username);
    const views = await this.listSyncSetupPolicies();
    const lockByDb = new Map<string, boolean>();
    for (const view of views) {
      const meInPush =
        view.pushto_users_hashes.some((h) => myHashes.has(h)) ||
        view.pushto_groups_hashes.some((h) => myHashes.has(h));
      if (!meInPush) continue;
      const meInPull =
        view.pullfrom_users_hashes.some((h) => myHashes.has(h)) ||
        view.pullfrom_groups_hashes.some((h) => myHashes.has(h));
      const locked = view.mode === "permanent" && !meInPull;
      for (const databaseId of view.databaseIds ?? []) {
        const id = databaseId.trim();
        if (!id) continue;
        lockByDb.set(id, (lockByDb.get(id) ?? false) || locked);
      }
    }
    const databases = Array.from(lockByDb.entries()).map(([databaseId, locked]) => ({
      databaseId,
      locked,
    }));
    return { databases };
  }

  /**
   * The decryption key ids revoked for `username` at the directory head: every
   * `acl_keydistribution_<keyId>` whose `pullfrom_users_hashes` matches one of
   * the user's hash candidates (docs/accesscontrol.md §13). Protected ids (the
   * tenant default / public-infos keys) are never reported. Read straight from
   * the {@link keyDistributionCache} (O(cache size), no doc scan) so the sync
   * server can apply the per-user blacklist on every pull/push, and the client
   * can bulk-remove these ids from its KeyBag.
   */
  async getRevokedDecryptionKeyIdsForUser(username: string): Promise<string[]> {
    await this.updateUnifiedCache();
    const myHashes = new Set(await this.usernameHashCandidates(username));
    return this.collectRevokedKeyIdsForHashes(myHashes);
  }

  /**
   * Signing-key variant of {@link getRevokedDecryptionKeyIdsForUser}, for the
   * sync server which authenticates principals by signing public key. The tenant
   * admin and any non-user (service) key are never revoked, so they get an empty
   * list.
   *
   * Matching is done purely in hash space against the grant's precomputed,
   * `$publicinfos`-readable `identity_hashes` bundle (docs/accesscontrol.md §6.5,
   * §13). This is the ONLY form that works on a real sync server: the server
   * holds only the `$publicinfos` key, never the tenant default key, so it can
   * NEVER decrypt `user_details_encrypted` — {@link getUserBySigningPublicKey}
   * returns the bare `username_hash` as `username`. Re-hashing that single hash
   * (routing through {@link getRevokedDecryptionKeyIdsForUser}, the old behavior)
   * produces hash-of-hash values that cannot match the multi-variant
   * `pullfrom_users_hashes`, so the blacklist silently did nothing on the server.
   * The precomputed bundle, written from the cleartext name at grant time, is
   * server-readable and carries every variant.
   */
  async getRevokedDecryptionKeyIdsForSigningKey(signingKey: string): Promise<string[]> {
    if (signingKey === this.tenant.getAdministrationPublicKey()) return [];
    const lookup = await this.getUserBySigningPublicKey(signingKey);
    if (!lookup) return [];
    const myHashes = await this.identityHashesForLookup(lookup);
    if (myHashes.size === 0) return [];
    return this.collectRevokedKeyIdsForHashes(myHashes);
  }

  /**
   * The hash set identifying a looked-up grant, for hash-space matching against
   * directory rules / blacklists (docs/accesscontrol.md §6.5). Prefers the
   * precomputed `$publicinfos`-readable `identity_hashes` bundle (the v1/v2/v3
   * hashes of every DN-hierarchy username variant), so it works on a sync server
   * that cannot read the cleartext name. Legacy grants written before the bundle
   * existed (`identityHashesV` 0/absent) carry only the single exact-match
   * `username_hash`; when the cleartext name IS available (a client that holds
   * the tenant key) we additionally recompute the scheme variants so matching is
   * no weaker than before the bundle existed.
   */
  private async identityHashesForLookup(lookup: DirectoryUserLookup): Promise<Set<string>> {
    const hashes = new Set<string>(lookup.identityHashes ?? []);
    if ((lookup.identityHashesV ?? 0) === 0 && lookup.username) {
      for (const h of await this.usernameHashCandidates(lookup.username)) {
        hashes.add(h);
      }
    }
    return hashes;
  }

  /**
   * Hash-space core of the revoked-key blacklist (docs/accesscontrol.md §13):
   * every `acl_keydistribution_<keyId>` whose `pullfrom_users_hashes` intersects
   * `myHashes`. Protected ids (the tenant default / public-infos keys) are never
   * reported. Reads straight from {@link keyDistributionCache} (O(cache size),
   * no doc scan); the caller must have refreshed it first (both entry points do,
   * via `updateUnifiedCache` / `getUserBySigningPublicKey`).
   */
  private collectRevokedKeyIdsForHashes(myHashes: Set<string>): string[] {
    const revoked: string[] = [];
    for (const [keyId, entry] of this.keyDistributionCache.entries()) {
      if (PROTECTED_DISTRIBUTION_KEY_IDS.includes(keyId)) continue;
      if (entry.pullfrom_users_hashes.some((h) => myHashes.has(h))) {
        revoked.push(keyId);
      }
    }
    return revoked;
  }

  /** Encode bytes as base64 (mirrors RSAEncryption's transport encoding). */
  private bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Decode a base64 string into bytes. */
  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Load the user's active grant document and apply an admin-signed edit to its
   * key/wipe arrays. Shared by {@link addUserKeys}, {@link removeUserKeys},
   * {@link requestDeviceWipe}, and {@link cancelDeviceWipe}.
   */
  private async editGrantArrays(
    username: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
    mutate: (data: Record<string, unknown>) => void,
  ): Promise<void> {
    const grants = await this.findGrantAccessDocuments(username);
    if (grants.length === 0) {
      throw new Error(`No active grant found for user "${username}"`);
    }
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    for (const grant of grants) {
      const doc = await directoryDB.getDocument(grant.getId());
      await directoryDB.changeDoc(
        doc,
        async (d: MindooDoc) => {
          mutate(d.getData());
        },
        { signingKeyPair: adminSigningKeyPair, signingKeyPassword: administrationPrivateKeyPassword },
      );
    }
    await this.updateUnifiedCache();
  }

  /** Load an ACL document by its fixed id, creating it (admin-signed) if absent. */
  private async getOrCreateAclDoc(
    directoryDB: MindooDB,
    docId: string,
    adminSigningKeyPair: SigningKeyPair,
    administrationPrivateKeyPassword: string,
  ): Promise<MindooDoc> {
    try {
      const existing = await directoryDB.getDocument(docId);
      if (existing) return existing;
    } catch {
      // Not found; fall through to create.
    }
    return directoryDB.createDocument({
      id: docId,
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: administrationPrivateKeyPassword,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
    });
  }

  /**
   * Resolve the identity set for a signing key (admin, granted user, or trusted
   * non-user key), shared by the server and client evaluation paths.
   */
  private async identitySetForSigningKey(
    signingKey: string,
    node: DirectoryStateNode,
    opts: { isAuthor?: boolean },
  ): Promise<IdentitySet> {
    // The tenant admin key is the root of trust and is resolved even without a
    // grant document (it authors the directory itself).
    const adminKey = this.tenant.getAdministrationPublicKey();
    const isAdmin = signingKey === adminKey;

    // Audit #4 (revocation lag): resolve the acting identity strictly from the
    // directory state at the entry's trusted time `T`. A signing key that was
    // not an ACTIVE grant at `T` carries only the pseudo-tokens
    // (`$everyone`/`$author`), even though the live `userLookupCache`
    // intentionally still remembers its username/group label after revocation.
    // Without this gate, a just-revoked key would keep matching username/group
    // allow-rules until the trust cache refreshed (up to
    // DIRECTORY_SYNC_INTERVAL_MS later). The `node` is the time-`T` snapshot
    // whose `bySigningKey` only contains keys whose grant is active at `T`.
    const grantedAtT = node.bySigningKey.has(signingKey);

    // Resolve the author's username from their signing key. Trusted non-user
    // keys (e.g. server-to-server sync identities) have no grant; treat them as
    // an empty identity that still carries `$everyone`/`$author`. Keys that were
    // revoked (or not yet granted) at `T` are likewise reduced to the minimal
    // identity so they cannot match name/group rules.
    const lookup =
      isAdmin || !grantedAtT ? null : await this.getUserBySigningPublicKey(signingKey);

    if (!lookup) {
      return this.minimalIdentitySet({ isAdmin, isAuthor: opts.isAuthor });
    }

    // A client holding the tenant default key decrypts `user_details_encrypted`,
    // so `lookup.username` is the cleartext name (`details` is populated). Build
    // the full identity set, including the cleartext usernames/groups needed for
    // Tier 2 `${user.*}` placeholder resolution.
    if (lookup.details !== null && lookup.username) {
      return this.buildIdentitySet(lookup.username, { isAdmin, isAuthor: opts.isAuthor });
    }

    // A $publicinfos-only sync server can NEVER decrypt `user_details_encrypted`
    // (it is under the tenant default key), so `getUserBySigningPublicKey`
    // degrades `username` to the bare `username_hash`. Re-hashing that single
    // hash (the old `buildIdentitySet(username)` path) produces hash-of-hash
    // values that match no rule, silently breaking server-side Tier 1
    // username/group rule matching. Build the matching hashes from the
    // precomputed, $publicinfos-readable `identity_hashes` bundle instead, which
    // carries every DN-variant hash (docs/accesscontrol.md §6.5, §7). The server
    // ignores Tier 2 (placeholder) rules, so the empty cleartext
    // usernames/groups are never read here.
    return this.buildIdentitySetFromHashes(
      await this.identityHashesForLookup(lookup),
      { isAdmin, isAuthor: opts.isAuthor },
    );
  }

  /**
   * The identity set for a key with no resolvable username (admin or a trusted
   * service key): only the pseudo-tokens apply.
   */
  private minimalIdentitySet(opts: { isAdmin?: boolean; isAuthor?: boolean }): IdentitySet {
    const hashes = new Set<string>();
    hashes.add(PSEUDO_TOKEN_EVERYONE);
    if (opts.isAdmin) hashes.add(PSEUDO_TOKEN_ADMIN);
    if (opts.isAuthor) hashes.add(PSEUDO_TOKEN_AUTHOR);
    return { username: "", usernames: [], groups: [], hashes };
  }

  /**
   * Build an identity set for access evaluation purely from a set of identity
   * hashes (docs/accesscontrol.md §6.5/§7), without the cleartext username. Used
   * on a $publicinfos-only sync server, which cannot read the cleartext name but
   * must still match Tier 1 username/group rules in hash space. Group membership
   * is resolved from the hashes (group docs store `members_hashes` and a
   * `$publicinfos`-readable `groupName`), and each resolved group's name hashes
   * are folded in so group-targeted rules match. Cleartext
   * `username`/`usernames`/`groups` are left empty: the server defers every
   * Tier 2 (placeholder) rule to clients, so they are never read here.
   */
  private async buildIdentitySetFromHashes(
    userHashes: Set<string>,
    opts: { isAdmin?: boolean; isAuthor?: boolean },
  ): Promise<IdentitySet> {
    await this.updateUnifiedCache();
    const hashes = new Set<string>(userHashes);
    const groups = await this.resolveGroupsFromVariantHashes(userHashes);
    for (const group of groups) {
      for (const h of await this.usernameHashCandidates(group)) {
        hashes.add(h);
      }
    }
    hashes.add(PSEUDO_TOKEN_EVERYONE);
    if (opts.isAdmin) hashes.add(PSEUDO_TOKEN_ADMIN);
    if (opts.isAuthor) hashes.add(PSEUDO_TOKEN_AUTHOR);
    return { username: "", usernames: [], groups, hashes };
  }
  
  /**
   * Normalize group name to lowercase for case-insensitive comparison.
   */
  private normalizeGroupName(name: string): string {
    // NFKC-normalize before lowercasing so visually-equivalent Unicode group
    // names collapse to one key (homoglyph/normalization defense). ASCII names
    // are unchanged.
    return name.normalize("NFKC").toLowerCase();
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
    // Generate username variants for matching and compute their hashes.
    // Include both legacy (v1) and salted (v2) hash forms for every variant so
    // membership written under either scheme is matched (docs/accesscontrol.md §6.5).
    const usernameVariants = this.generateUsernameVariants(username);
    const variantHashes = new Set(
      (await Promise.all(usernameVariants.map(v => this.usernameHashCandidates(v)))).flat()
    );
    return this.resolveGroupsFromVariantHashes(variantHashes);
  }

  /**
   * Hash-space core of {@link resolveGroupsForUser}: given the set of a user's
   * username-variant hashes (v1+v2 of every DN-hierarchy variant), recursively
   * resolve all groups that contain the user (directly or via nested groups).
   * Works purely from hashes, so the server can resolve group membership for a
   * key-based reader using the precomputed `identity_hashes` bundle — no
   * cleartext username required (docs/accesscontrol.md §6.5).
   */
  private async resolveGroupsFromVariantHashes(variantHashes: Set<string>): Promise<string[]> {
    const resultGroups = new Set<string>();

    // Sync changes and update cache
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();

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
        
        // Hash the child group name for comparison (both legacy + salted forms).
        const childGroupHashes = await this.usernameHashCandidates(childGroup);
        
        // Find all groups that contain this child group as a member (by hash)
        for (const [parentGroupName, parentGroupData] of this.groupsCache.entries()) {
          if (resultGroups.has(parentGroupName)) {
            continue; // Already found this group
          }
          
          if (childGroupHashes.some(h => parentGroupData.members_hashes.includes(h))) {
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
    details?: DirectoryUserDetails | null;
  } | null> {
    this.logger.debug(`Getting public keys for username: ${username}`);
    
    // Find all grant access documents for this user, then keep only those that
    // still carry signing keys. Revocation removes keys in place (§6.5), so a
    // grant with an empty key array is a revoked grant and must be ignored.
    const grantDocs = await this.findGrantAccessDocuments(username);
    const activeDocs = grantDocs.filter(
      (doc) => extractSigningPublicKeys(doc.getData()).length > 0,
    );
    
    if (activeDocs.length === 0) {
      this.logger.debug(`No active grant access documents found for username: ${username}`);
      return null;
    }
    
    // Use the most recent active grant access document (most recent registration).
    // In most cases there should only be one active grant access document per user.
    const doc = activeDocs[activeDocs.length - 1];
    const data = doc.getData();
    
    // Prefer the array key form, falling back to the legacy scalar fields (§6.5).
    const signingPublicKey = extractSigningPublicKeys(data)[0] ?? null;
    const encryptionPublicKey = extractEncryptionPublicKeys(data)[0] ?? null;
    
    if (typeof signingPublicKey !== "string" || typeof encryptionPublicKey !== "string") {
      this.logger.error(`Invalid key data in grant access document for username: ${username}`);
      return null;
    }
    
    this.logger.debug(`Found public keys for username: ${username}`);
    const cachedLookup = this.userLookupCache.get(signingPublicKey);
    return {
      signingPublicKey,
      encryptionPublicKey,
      details: cachedLookup?.details ?? null,
    };
  }

  async getUserBySigningPublicKey(publicKey: string): Promise<DirectoryUserLookup | null> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    return this.userLookupCache.get(publicKey) ?? null;
  }

  /**
   * Resolve the full set of signing keys relevant to authenticating a device for
   * `username` (docs/accesscontrol.md §6.5):
   *  - `active`: keys currently granted (the device may sync normally), and
   *  - `wipeRequested`: keys an admin has targeted for remote wipe.
   *
   * The two sets are independent: a stolen device may still be active yet
   * wipe-targeted, or revoked (removed from `active`) yet still wipe-targeted.
   * The server uses this to let a wipe-targeted (possibly revoked) device
   * authenticate just far enough to receive the wipe directive.
   */
  async getUserSigningKeyUniverse(
    username: string,
  ): Promise<{ active: string[]; wipeRequested: string[] }> {
    const grants = await this.findGrantAccessDocuments(username);
    const active = new Set<string>();
    const wipeRequested = new Set<string>();
    for (const grant of grants) {
      const data = grant.getData();
      for (const key of extractSigningPublicKeys(data)) active.add(key);
      for (const key of extractWipeRequestedSigningKeys(data)) wipeRequested.add(key);
    }
    return { active: Array.from(active), wipeRequested: Array.from(wipeRequested) };
  }

  /**
   * List a user's currently-granted device key pairs (§6.5), each with its
   * optional label and current remote-wipe status. Returns one entry per
   * signing key (revoked keys are excluded). Used by admin UIs to pick specific
   * devices to revoke or relabel. Grant documents are processed oldest→newest,
   * so the most recent label/encryption key for a signing key wins.
   */
  async getUserKeyPairs(username: string): Promise<GrantKeyPairInfo[]> {
    const grants = await this.findGrantAccessDocuments(username);
    const bySigningKey = new Map<string, GrantKeyPairInfo>();
    for (const grant of grants) {
      const data = grant.getData();
      const wipeRequestedKeys = new Set(extractWipeRequestedSigningKeys(data));
      // Active devices only: revoked pairs are retained on the document but
      // excluded here, preserving the "currently-granted devices" semantics.
      for (const pair of extractActiveKeyPairs(data)) {
        bySigningKey.set(pair.signingPublicKey, {
          ...pair,
          wipeRequested: wipeRequestedKeys.has(pair.signingPublicKey),
        });
      }
    }
    return Array.from(bySigningKey.values());
  }

  /**
   * If `signingKey` is the target of an admin-requested remote wipe (§6.5),
   * return the id of the admin-signed grant document carrying the directive so
   * the sync server can serve only that document to the targeted device. Returns
   * null when the key is not wipe-targeted.
   */
  async getWipeGrantDocId(signingKey: string): Promise<string | null> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    await this.updateUnifiedCache();
    return this.wipeKeyToGrantDocId.get(signingKey) ?? null;
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

    // Revocation removes the signing keys from the grant document(s) rather
    // than creating a separate revoke document (docs/accesscontrol.md §6.5).
    // A user is revoked when no grant document retains any signing key. Users
    // who were never granted access (no grant documents at all) are likewise
    // reported as having no active access.
    const grantDocs = await this.findGrantAccessDocuments(username);
    const hasActiveKey = grantDocs.some(
      (doc) => extractSigningPublicKeys(doc.getData()).length > 0,
    );
    const isRevoked = !hasActiveKey;

    this.logger.debug(`User ${username} revoked: ${isRevoked}`);
    return isRevoked;
  }

  /**
   * Publish an admin-signed document-history purge request (docs/accesscontrol.md
   * §13). Maps an unsigned {@link DocHistoryPurgeRequest} (built in-dialog or
   * decoded from an `mdb://doc-history-purge/...` URI) to a
   * {@link DocHistoryPurgeDoc} stored at the fixed id
   * `acl_dochistorypurge_<requestId>` (one doc per request; append-only audit
   * record). The doc shell is `$publicinfos`-readable so the sync server can read
   * the cleartext `dbId` + `docIds` routing fields and execute the purge on its
   * own stores; only `reason` is encrypted with the tenant `default` key.
   */
  async publishDocHistoryPurge(
    request: DocHistoryPurgeRequest,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    validateDocHistoryPurge({
      requestId: request.requestId,
      dbId: request.dbId,
      docIds: request.docIds,
    });

    this.logger.info(
      `Publishing doc history purge request ${request.requestId} for ${request.docIds.length} doc(s) in ${request.dbId}`,
    );

    const reasonEncrypted = request.reason
      ? await this.encryptToDefaultField(request.reason)
      : undefined;

    const docId = aclDocHistoryPurgeDocId(request.requestId);
    const requestedAt = Date.now();
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    const doc = await this.getOrCreateAclDoc(
      directoryDB,
      docId,
      adminSigningKeyPair,
      administrationPrivateKeyPassword,
    );
    await directoryDB.changeDoc(
      doc,
      async (d: MindooDoc) => {
        const data = d.getData();
        data.form = ACCESS_CONTROL_FORM;
        data.type = DOC_HISTORY_PURGE_TYPE;
        data.requestId = request.requestId;
        data.dbId = request.dbId;
        data.docIds = [...request.docIds];
        if (reasonEncrypted !== undefined) {
          data.reason_encrypted = reasonEncrypted;
          data.reason_encrypted_key = "default";
        } else {
          delete data.reason_encrypted;
          delete data.reason_encrypted_key;
        }
        data.preparedByPublicKey = request.preparedByPublicKey;
        data.requestedAt = requestedAt;
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
    );
    this.logger.info(`Created purge request ${request.requestId} in ${request.dbId}`);
  }

  /** Parse a raw purge-request doc's data into a {@link DocHistoryPurgeView}. */
  private async toDocHistoryPurgeView(
    data: Record<string, unknown>,
    purgeRequestDocId: string,
  ): Promise<DocHistoryPurgeView | null> {
    if (data.type !== DOC_HISTORY_PURGE_TYPE) return null;
    const dbId = data.dbId;
    if (typeof dbId !== "string") return null;
    const docIds = Array.isArray(data.docIds)
      ? data.docIds.filter((id): id is string => typeof id === "string")
      : [];
    if (docIds.length === 0) return null;
    const reason = await decryptEncryptedField(this.tenant, data, "reason_encrypted");
    return {
      requestId:
        typeof data.requestId === "string" ? data.requestId : purgeRequestDocId,
      dbId,
      docIds,
      reason,
      preparedByPublicKey:
        typeof data.preparedByPublicKey === "string" ? data.preparedByPublicKey : "",
      requestedAt: typeof data.requestedAt === "number" ? data.requestedAt : 0,
      purgeRequestDocId,
    };
  }

  /**
   * List all purge-request documents at the directory head as
   * {@link DocHistoryPurgeView}s (decrypting `reason` when the tenant default
   * key is held; null-tolerant otherwise).
   */
  async listDocHistoryPurges(): Promise<DocHistoryPurgeView[]> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();
    const allIds = await directoryDB.getAllDocumentIds();
    const ids = allIds.filter((id) => id.startsWith(ACL_DOC_HISTORY_PURGE_PREFIX));
    const views: DocHistoryPurgeView[] = [];
    for (const id of ids) {
      let doc: MindooDoc;
      try {
        doc = await directoryDB.getDocument(id);
      } catch {
        continue;
      }
      if (!doc) continue;
      const view = await this.toDocHistoryPurgeView(doc.getData(), id);
      if (view) views.push(view);
    }
    return views;
  }

  /** Delete a still-pending purge request document (admin-signed). */
  async deleteDocHistoryPurge(
    requestId: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string,
  ): Promise<void> {
    const baseTenant = this.tenant as BaseMindooTenant;
    const directoryDB = await this.getDirectoryDB();
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };
    try {
      await directoryDB.deleteDocument(aclDocHistoryPurgeDocId(requestId), {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      });
    } catch (error) {
      this.logger.debug(
        `deleteDocHistoryPurge: ${requestId} not found or already deleted: ${error}`,
      );
    }
  }

  async getRequestedDocHistoryPurges(): Promise<Array<{
    requestId: string;
    dbId: string;
    docIds: string[];
    reason?: string;
    requestedAt: number;
    purgeRequestDocId: string;
  }>> {
    const views = await this.listDocHistoryPurges();
    return views.map((view) => ({
      requestId: view.requestId,
      dbId: view.dbId,
      docIds: view.docIds,
      reason: view.reason ?? undefined,
      requestedAt: view.requestedAt,
      purgeRequestDocId: view.purgeRequestDocId,
    }));
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

  async listKnownDBIds(): Promise<string[]> {
    const directoryDB = await this.getDirectoryDB();
    await directoryDB.syncStoreChanges();

    await this.updateUnifiedCache();

    const known = new Set<string>(["directory", "main"]);
    for (const dbId of this.dbSettingsCache.keys()) {
      known.add(dbId);
    }

    return Array.from(known).sort();
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
    await directoryDB.changeDoc(
      settingsDoc,
      async (d: MindooDoc) => {
        // Call user's change function
        await changeFunc(d);
        
        // Ensure form field is always correct (overwrite if user changed it)
        d.getData().form = "tenantsettings";
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
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
    await directoryDB.changeDoc(
      settingsDoc,
      async (d: MindooDoc) => {
        // Call user's change function
        await changeFunc(d);
        
        // Ensure form and dbid fields are always correct (overwrite if user changed them)
        const data = d.getData();
        data.form = "dbsettings";
        data.dbid = dbId;
      },
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
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
    
    const members = new Set<string>();
    for (const encryptedMember of groupData.members_encrypted) {
      const decryptedMember = await this.decryptGroupMemberForTenant(encryptedMember);
      if (decryptedMember) {
        members.add(decryptedMember);
      }
    }
    return Array.from(members);
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
    
    // Compute hashes (salted v2 for new writes) and encrypted values for all
    // new usernames. Reads match both v1 and v2 forms (docs/accesscontrol.md §6.5).
    const newMembersHashes = await Promise.all(username.map(u => this.hashUsernameForWrite(u)));
    const newMembersEncrypted = await Promise.all(username.map(u => this.encryptGroupMemberForTenant(u)));
    
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
    await directoryDB.changeDoc(
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
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
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
    
    // Compute hashes of usernames to remove. Include both legacy (v1) and
    // salted (v2) forms so members stored under either scheme are removed.
    const hashesToRemove = new Set(
      (await Promise.all(username.map(u => this.usernameHashCandidates(u)))).flat()
    );
    
    // Remove users from members arrays
    await directoryDB.changeDoc(
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
      {
        signingKeyPair: adminSigningKeyPair,
        signingKeyPassword: administrationPrivateKeyPassword,
      },
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
    await directoryDB.deleteDocument(cachedGroup.docId, {
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: administrationPrivateKeyPassword,
    });
    
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
   * Current username-hash scheme version written on new directory documents.
   * v1 = unsalted `SHA-256(lower(username))` (legacy);
   * v2 = tenant-salted `SHA-256(tenantId + "/" + lower(username))`;
   * v3 = tenant-salted over the **NFKC-normalized** lowercase username,
   *      `SHA-256(tenantId + "/" + lower(NFKC(username)))`.
   * v3 defends against Unicode homoglyph/normalization tricks (e.g. fullwidth
   * or decomposed forms that look identical but hash differently), so an
   * attacker cannot register a visually-equal variant of a privileged name and
   * have it treated as a distinct identity. See docs/accesscontrol.md §6.5
   * ("Username hashing"). Matching keeps v1/v2/v3 candidates so documents
   * written under any prior scheme still resolve (backward compatible).
   */
  private static readonly USERNAME_HASH_VERSION = 3;

  /**
   * Version of the identity-hash bundle (`identity_hashes`) variant-generation
   * algorithm (docs/accesscontrol.md §6.5). This is a SEPARATE axis from
   * {@link USERNAME_HASH_VERSION} (which versions only the hash scheme): it
   * tracks how completely {@link generateUsernameVariants} enumerated the
   * DN-hierarchy wildcards. Bump it whenever `generateUsernameVariants` is
   * extended so readers can detect stale bundles and trigger a backfill.
   */
  private static readonly IDENTITY_VARIANTS_VERSION = 1;

  /**
   * Compute the precomputed identity-hash bundle for a cleartext username
   * (docs/accesscontrol.md §6.5): the flattened, deduped v1+v2 hashes of every
   * DN-hierarchy variant from {@link generateUsernameVariants}. Stored on the
   * grant doc so the server can match wildcard/group read rules in hash space
   * without ever holding the cleartext name. Only username variant hashes are
   * included; group membership stays dynamic (resolved at read time).
   */
  private async computeIdentityHashes(username: string): Promise<string[]> {
    const variants = this.generateUsernameVariants(username);
    const hashes = new Set<string>();
    for (const variant of variants) {
      for (const h of await this.usernameHashCandidates(variant)) {
        hashes.add(h);
      }
    }
    return Array.from(hashes);
  }

  /**
   * Legacy (v1) username hash: `SHA-256(lower(username))`, hex-encoded.
   *
   * Retained because pre-existing directory documents (and clients that predate
   * the salted scheme) store this form, and lookups must keep matching them.
   *
   * @param username The username to hash
   * @return The hex-encoded SHA-256 hash of the lowercase username
   */
  private async hashUsername(username: string): Promise<string> {
    return this.sha256Hex(username.toLowerCase());
  }

  /**
   * Salted (v2) username hash: `SHA-256(tenantId + "/" + lower(username))`,
   * hex-encoded. The tenant id salt prevents precomputed/rainbow-table attacks
   * and cross-tenant hash correlation. New documents write this form
   * (docs/accesscontrol.md §6.5).
   */
  private async hashUsernameSalted(username: string): Promise<string> {
    return this.sha256Hex(`${this.tenant.getId()}/${username.toLowerCase()}`);
  }

  /**
   * NFKC-normalized salted (v3) username hash:
   * `SHA-256(tenantId + "/" + lower(NFKC(username)))`, hex-encoded. NFKC
   * canonicalizes Unicode so visually-equivalent or differently-encoded forms
   * collapse to one hash, blocking homoglyph/normalization impersonation. New
   * documents write this form. For pure-ASCII usernames it equals v2, so
   * existing common cases are unaffected.
   */
  private async hashUsernameSaltedNormalized(username: string): Promise<string> {
    return this.sha256Hex(`${this.tenant.getId()}/${username.normalize("NFKC").toLowerCase()}`);
  }

  /**
   * The canonical hash to WRITE on new directory documents (currently v3,
   * NFKC-normalized salted).
   */
  private async hashUsernameForWrite(username: string): Promise<string> {
    return this.hashUsernameSaltedNormalized(username);
  }

  /**
   * All hash forms a given username could be stored as, for MATCHING/lookup.
   * Returns the legacy (v1), salted (v2) and NFKC-normalized salted (v3) hashes
   * so that documents written under any scheme are found. Deduplicated.
   */
  private async usernameHashCandidates(username: string): Promise<string[]> {
    const [legacy, salted, saltedNormalized] = await Promise.all([
      this.hashUsername(username),
      this.hashUsernameSalted(username),
      this.hashUsernameSaltedNormalized(username),
    ]);
    return Array.from(new Set([legacy, salted, saltedNormalized]));
  }

  /** Hex-encoded SHA-256 of a UTF-8 string. */
  private async sha256Hex(value: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const hashBuffer = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private buildUserDetailsPayload(
    username: string,
    userDetails?: DirectoryUserDetails,
  ): DirectoryUserDetails {
    const details: DirectoryUserDetails = { username };
    if (!userDetails) {
      return details;
    }

    for (const [key, value] of Object.entries(userDetails)) {
      if (key === "username" || typeof value !== "string" || !value.trim()) {
        continue;
      }
      details[key] = value;
    }

    return details;
  }

  private async encryptUserDetailsForTenant(userDetails: DirectoryUserDetails): Promise<string> {
    const encoder = new TextEncoder();
    const payload = encoder.encode(JSON.stringify(userDetails));
    const encrypted = await this.tenant.encryptPayload(payload, DEFAULT_TENANT_KEY_ID);
    return this.uint8ArrayToBase64(encrypted);
  }

  /**
   * Decrypt the `user_details_encrypted` blob on a grant document. Uses the
   * shared `_encrypted` / `_encrypted_key` field convention so the key id is
   * resolved from the optional `user_details_encrypted_key` companion field,
   * defaulting to the tenant default key for legacy grants that lack it.
   */
  private async decryptUserDetailsForTenant(data: Record<string, unknown>): Promise<DirectoryUserDetails | null> {
    const decoded = await decryptEncryptedField(this.tenant, data, "user_details_encrypted");
    if (decoded === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }

      const details: DirectoryUserDetails = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.trim()) {
          details[key] = value;
        }
      }

      return Object.keys(details).length ? details : null;
    } catch (error) {
      this.logger.debug("Could not parse tenant-readable user details, treating entry as legacy or inaccessible", error);
      return null;
    }
  }

  private async buildUserLookup(data: Record<string, unknown>): Promise<DirectoryUserLookup | null> {
    // Prefer the array key form (key rollover / multiple devices) and fall back
    // to the legacy scalar fields (§6.5).
    const signingPublicKey = extractSigningPublicKeys(data)[0] ?? null;
    const encryptionPublicKey = extractEncryptionPublicKeys(data)[0] ?? null;
    if (!signingPublicKey || !encryptionPublicKey) {
      return null;
    }

    const encryptedDetails = typeof data.user_details_encrypted === "string" ? data.user_details_encrypted : null;
    const details = encryptedDetails ? await this.decryptUserDetailsForTenant(data) : null;
    const username = details?.username
      ?? (typeof data.username_hash === "string" ? data.username_hash : "");

    // Surface the precomputed identity-hash bundle (§6.5). Legacy grants written
    // before the bundle existed have neither field; fall back to the single
    // username_hash (exact-match only, version 0) so the reader can flag the
    // grant for backfill.
    const usernameHash = typeof data.username_hash === "string" ? data.username_hash : null;
    const identityHashes = Array.isArray(data.identity_hashes)
      ? data.identity_hashes.filter((h): h is string => typeof h === "string" && h.length > 0)
      : usernameHash
        ? [usernameHash]
        : [];
    const identityHashesV = typeof data.identity_hashes_v === "number"
      ? data.identity_hashes_v
      : 0;

    return {
      username,
      signingPublicKey,
      encryptionPublicKey,
      details,
      identityHashes,
      identityHashesV,
    };
  }

  private async encryptGroupMemberForTenant(plaintext: string): Promise<string> {
    const encoder = new TextEncoder();
    const encrypted = await this.tenant.encryptPayload(encoder.encode(plaintext), DEFAULT_TENANT_KEY_ID);
    return this.uint8ArrayToBase64(encrypted);
  }

  /**
   * Encrypt a rule's cleartext targets (usernames + groups) with the tenant
   * default key so admin UIs can display who a rule targets without reversing
   * the salted hashes. Mirrors {@link encryptUserDetailsForTenant}: the blob is
   * opaque to the sync server (it never holds the tenant key) but readable by
   * tenant clients. Returns "" when there is nothing cleartext to store (e.g. a
   * rule authored from raw hashes / pseudo-tokens only).
   */
  /**
   * Resolve a rule's targets (explicit `users_hashes` + named `usernames` /
   * `groups`) to the salted hash set evaluation matches against. Usernames are
   * hashed as-is; **group names are normalized (lowercased) first** so they
   * match the identity set, which hashes the normalized group names returned by
   * {@link resolveGroupsForUser} (the group cache is keyed by
   * {@link normalizeGroupName}). Without this, a mixed-case group target like
   * "Analysts" would never intersect a member's identity (hashed as "analysts").
   */
  private async resolveRuleTargetHashes(rule: {
    users_hashes?: string[];
    usernames?: string[];
    groups?: string[];
  }): Promise<Set<string>> {
    const resolvedHashes = new Set<string>(rule.users_hashes ?? []);
    for (const name of rule.usernames ?? []) {
      resolvedHashes.add(await this.hashUsernameForWrite(name));
    }
    for (const group of rule.groups ?? []) {
      resolvedHashes.add(await this.hashUsernameForWrite(this.normalizeGroupName(group)));
    }
    return resolvedHashes;
  }

  private async encryptRuleTargetsForTenant(targets: RuleTargets): Promise<string> {
    const usernames = targets.usernames.filter((u) => typeof u === "string" && u.trim());
    const groups = targets.groups.filter((g) => typeof g === "string" && g.trim());
    if (usernames.length === 0 && groups.length === 0) {
      return "";
    }
    const payload = new TextEncoder().encode(JSON.stringify({ usernames, groups }));
    const encrypted = await this.tenant.encryptPayload(payload, DEFAULT_TENANT_KEY_ID);
    return this.uint8ArrayToBase64(encrypted);
  }

  /**
   * Decrypt a rule's {@link RuleTargets} display blob. Returns `null` for an
   * empty/unreadable blob (e.g. a client lacking the tenant default key), in
   * which case callers fall back to showing the raw `users_hashes`.
   */
  private async decryptRuleTargetsForTenant(encryptedBase64: string): Promise<RuleTargets | null> {
    if (!encryptedBase64) return null;
    try {
      const encrypted = this.base64ToUint8Array(encryptedBase64);
      const decrypted = await this.tenant.decryptPayload(encrypted, DEFAULT_TENANT_KEY_ID);
      const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, unknown>;
      const usernames = Array.isArray(parsed.usernames)
        ? parsed.usernames.filter((u): u is string => typeof u === "string")
        : [];
      const groups = Array.isArray(parsed.groups)
        ? parsed.groups.filter((g): g is string => typeof g === "string")
        : [];
      return { usernames, groups };
    } catch (error) {
      this.logger.debug("Could not decrypt rule targets, falling back to hashes", error);
      return null;
    }
  }

  private async decryptGroupMemberForTenant(encryptedBase64: string): Promise<string | null> {
    try {
      const encrypted = this.base64ToUint8Array(encryptedBase64);
      const decrypted = await this.tenant.decryptPayload(encrypted, DEFAULT_TENANT_KEY_ID);
      const member = new TextDecoder().decode(decrypted).trim();
      return member || null;
    } catch (error) {
      this.logger.debug("Could not decrypt group member entry, skipping unreadable member", error);
      return null;
    }
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

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}