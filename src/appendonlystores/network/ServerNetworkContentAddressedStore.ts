import type { ContentAddressedStore } from "../../core/types";
import type {
  StoreEntry,
  StoreEntryMetadata,
  MindooTenantDirectory,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../../core/types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
} from "../../core/appendonlystores/types";
import { createIdBloomSummary } from "../../core/appendonlystores/bloom";
import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import type {
  NetworkEncryptedEntry,
  NetworkAuthTokenPayload,
  NetworkSyncCapabilities,
} from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";
import { RSAEncryption } from "../../core/crypto/RSAEncryption";
import { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";
import type { TimestampProvider } from "../../core/accesscontrol/timestamp/TimestampProvider";
import type { AccessDecision } from "../../core/accesscontrol/types";

/**
 * Server-side Tier 1 access evaluator (docs/accesscontrol.md §7). Given a
 * pushed entry and the database it targets, returns whether the entry is
 * allowed by the identity-tier policy at the entry's trusted time. Supplied by
 * the host server, which has access to the directory-state node and can resolve
 * the author's identity set; kept as a callback so this transport layer stays
 * decoupled from the directory implementation and remains easy to unit-test.
 */
export type ServerTier1Evaluator = (
  entry: StoreEntry,
  dbid: string
) => Promise<AccessDecision>;

/**
 * Resolves a wipe-targeted signing key to the id of the admin-signed grant
 * document carrying its remote-wipe directive (docs/accesscontrol.md §6.5), or
 * null if the key is not wipe-targeted. Supplied by the host server from the
 * directory; kept as a callback so this transport layer stays decoupled.
 */
export type WipeGrantDocIdResolver = (signingKey: string) => Promise<string | null>;

/** Optional access-control wiring for the server store (docs/accesscontrol.md §5–§7). */
export interface ServerAccessControlOptions {
  /** The trusted-time provider used to stamp receipts on accepted entries (§5, §13). */
  timestampProvider?: TimestampProvider;
  /** The database id witnessed entries are bound to (the store's db context). */
  witnessDbid?: string;
  /** Tier 1 evaluator; when present, denied pushes are rejected with ACCESS_DENIED. */
  tier1Evaluator?: ServerTier1Evaluator;
  /**
   * Remote-wipe resolver (§6.5). When present, a wipe-scoped token is served
   * only the admin-signed grant document carrying its directive (on the
   * directory store) and nothing else (on data stores); pushes are denied.
   */
  wipeGrantDocIdResolver?: WipeGrantDocIdResolver;
}

/**
 * Server-side network handler for ContentAddressedStore operations.
 * 
 * This class handles incoming sync requests from clients:
 * 1. Validates authentication tokens
 * 2. Retrieves entries from the local store
 * 3. Encrypts entries with the requesting user's RSA public key
 * 4. Returns encrypted entries to the client
 * 
 * This is not a ContentAddressedStore implementation itself, but rather
 * a service that wraps a local ContentAddressedStore and handles network requests.
 */
export class ServerNetworkContentAddressedStore {
  private localStore: ContentAddressedStore;
  private directory: MindooTenantDirectory;
  private authService: AuthenticationService;
  private rsaEncryption: RSAEncryption;
  private cryptoAdapter: CryptoAdapter;
  private logger: Logger;
  /** Trusted-time provider for stamping receipts; undefined disables access-control v1. */
  private timestampProvider?: TimestampProvider;
  /** Database id bound into witness receipts for this store. */
  private witnessDbid?: string;
  /** Optional Tier 1 evaluator; undefined keeps the legacy membership-only check. */
  private tier1Evaluator?: ServerTier1Evaluator;
  /** Optional remote-wipe resolver; undefined disables wipe-scoped serving. */
  private wipeGrantDocIdResolver?: WipeGrantDocIdResolver;
  /** The directory database id, where grant documents live (§6.5). */
  private static readonly DIRECTORY_DB_ID = "directory";

  /**
   * Create a new ServerNetworkContentAddressedStore.
   * 
   * @param localStore The local store containing the actual data
   * @param directory The tenant directory for user lookup
   * @param authService The authentication service for token validation
   * @param cryptoAdapter The crypto adapter for encryption
   * @param logger Optional logger instance
   */
  constructor(
    localStore: ContentAddressedStore,
    directory: MindooTenantDirectory,
    authService: AuthenticationService,
    cryptoAdapter: CryptoAdapter,
    logger?: Logger,
    accessControl?: ServerAccessControlOptions
  ) {
    this.localStore = localStore;
    this.directory = directory;
    this.authService = authService;
    this.cryptoAdapter = cryptoAdapter;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `ServerNetworkStore:${localStore.getId()}`, true);
    const rsaLogger = this.logger.createChild("RSAEncryption");
    this.rsaEncryption = new RSAEncryption(cryptoAdapter, rsaLogger);
    this.timestampProvider = accessControl?.timestampProvider;
    this.witnessDbid = accessControl?.witnessDbid;
    this.tier1Evaluator = accessControl?.tier1Evaluator;
    this.wipeGrantDocIdResolver = accessControl?.wipeGrantDocIdResolver;
  }

  /**
   * Compute the id allow-list for a (possibly wipe-scoped) token
   * (docs/accesscontrol.md §6.5). Returns:
   *  - `null` for a normal token: serving is unrestricted; OR
   *  - a `Set<string>` for a wipe-scoped token: only these entry ids may be
   *    served. On the directory store this is exactly the admin-signed grant
   *    document carrying the directive; on any data store it is empty.
   */
  private async wipeAllowedIds(
    payload: NetworkAuthTokenPayload,
  ): Promise<Set<string> | null> {
    if (!payload.wipe || !payload.deviceSigningKey || !this.wipeGrantDocIdResolver) {
      return null;
    }
    // A wipe-targeted device gets no data-database content at all.
    if (this.localStore.getId() !== ServerNetworkContentAddressedStore.DIRECTORY_DB_ID) {
      return new Set<string>();
    }
    const grantDocId = await this.wipeGrantDocIdResolver(payload.deviceSigningKey);
    if (!grantDocId) {
      return new Set<string>();
    }
    const metas = await this.localStore.findNewEntriesForDoc([], grantDocId);
    return new Set(metas.map((m) => m.id));
  }

  /**
   * Get the ID of the underlying store.
   */
  getId(): string {
    return this.localStore.getId();
  }

  /**
   * Handle a challenge request from a client.
   * 
   * @param username The username requesting authentication
   * @returns The challenge string
   */
  async handleChallengeRequest(username: string): Promise<string> {
    this.logger.debug(`Handling challenge request for user: ${username}`);
    return this.authService.generateChallenge(username);
  }

  /**
   * Handle an authentication request from a client.
   * 
   * @param challenge The challenge string
   * @param signature The client's signature
   * @returns The authentication result with JWT token
   */
  async handleAuthenticate(challenge: string, signature: Uint8Array): Promise<{
    success: boolean;
    token?: string;
    error?: string;
  }> {
    this.logger.debug(`Handling authentication for challenge: ${challenge}`);
    return this.authService.authenticate(challenge, signature);
  }

  /**
   * Handle a findNewEntries request from a client.
   * 
   * @param token The JWT access token
   * @param knownIds The entry IDs the client already has
   * @returns List of new entry metadata
   */
  async handleFindNewEntries(
    token: string,
    knownIds: string[]
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling findNewEntries request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Find new entries
    const newEntries = await this.localStore.findNewEntries(knownIds);
    this.logger.debug(`Found ${newEntries.length} new entries`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    return allowed ? newEntries.filter((e) => allowed.has(e.id)) : newEntries;
  }

  /**
   * Handle a findNewEntriesForDoc request from a client.
   * This is an optimized version that only returns entries for a specific document.
   * 
   * @param token The JWT access token
   * @param knownIds The entry IDs the client already has for this document
   * @param docId The document ID to filter by
   * @returns List of new entry metadata for the specified document
   */
  async handleFindNewEntriesForDoc(
    token: string,
    knownIds: string[],
    docId: string
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling findNewEntriesForDoc request for doc ${docId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Find new entries for the specific document
    const newEntries = await this.localStore.findNewEntriesForDoc(knownIds, docId);
    this.logger.debug(`Found ${newEntries.length} new entries for doc ${docId}`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    return allowed ? newEntries.filter((e) => allowed.has(e.id)) : newEntries;
  }

  /**
   * Handle a findEntries request from a client.
   * 
   * @param token The JWT access token
   * @param type The entry type to filter by
   * @param creationDateFrom Optional start timestamp (inclusive)
   * @param creationDateUntil Optional end timestamp (exclusive)
   * @returns List of entry metadata matching the criteria
   */
  async handleFindEntries(
    token: string,
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling findEntries request for type ${type}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Find entries
    const entries = await this.localStore.findEntries(
      type,
      creationDateFrom,
      creationDateUntil
    );
    this.logger.debug(`Found ${entries.length} entries`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    return allowed ? entries.filter((e) => allowed.has(e.id)) : entries;
  }

  /**
   * Handle a cursor-based scanEntriesSince request from a client.
   * Uses local store native support when available, with legacy fallback.
   */
  async handleScanEntriesSince(
    token: string,
    cursor: StoreScanCursor | null,
    limit?: number,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    this.logger.debug(`Handling scanEntriesSince request`);

    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    // Wipe-scoped token (§6.5): return only the allowed entries (the grant
    // directive on the directory store, nothing on data stores) in a single
    // terminal page, regardless of cursor.
    const allowed = await this.wipeAllowedIds(tokenPayload);
    if (allowed) {
      if (allowed.size === 0) {
        return { entries: [], nextCursor: cursor, hasMore: false };
      }
      const all = await this.localStore.findNewEntries([]);
      const entries = all.filter((e) => allowed.has(e.id));
      return { entries, nextCursor: cursor, hasMore: false };
    }

    if (this.localStore.scanEntriesSince) {
      return this.localStore.scanEntriesSince(cursor, limit, filters);
    }

    // Fallback: emulate cursor scan using existing metadata query.
    const all = filters?.docId
      ? await this.localStore.findNewEntriesForDoc([], filters.docId)
      : await this.localStore.findNewEntries([]);
    const sorted = all
      .filter((meta) => {
        if (filters?.entryTypes && filters.entryTypes.length > 0 && !filters.entryTypes.includes(meta.entryType)) {
          return false;
        }
        if (filters?.creationDateFrom !== undefined && filters.creationDateFrom !== null && meta.createdAt < filters.creationDateFrom) {
          return false;
        }
        if (filters?.creationDateUntil !== undefined && filters.creationDateUntil !== null && meta.createdAt >= filters.creationDateUntil) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const leftReceiptOrder = a.receiptOrder ?? 0;
        const rightReceiptOrder = b.receiptOrder ?? 0;
        return leftReceiptOrder === rightReceiptOrder
          ? a.id.localeCompare(b.id)
          : leftReceiptOrder - rightReceiptOrder;
      });

    const max = limit ?? Number.MAX_SAFE_INTEGER;
    const startIndex =
      cursor === null
        ? 0
        : sorted.findIndex((meta) =>
            (meta.receiptOrder ?? 0) > cursor.receiptOrder ||
            ((meta.receiptOrder ?? 0) === cursor.receiptOrder && meta.id > cursor.id)
          );

    if (startIndex === -1) {
      return { entries: [], nextCursor: cursor, hasMore: false };
    }

    const page = sorted.slice(startIndex, startIndex + max);
    const last = page.length > 0 ? page[page.length - 1] : null;
    return {
      entries: page,
      nextCursor: last ? { receiptOrder: last.receiptOrder ?? 0, id: last.id } : cursor,
      hasMore: startIndex + page.length < sorted.length,
    };
  }

  /**
   * Handle a getIdBloomSummary request from a client.
   */
  async handleGetIdBloomSummary(token: string): Promise<StoreIdBloomSummary> {
    this.logger.debug(`Handling getIdBloomSummary request`);

    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    if (this.localStore.getIdBloomSummary) {
      return this.localStore.getIdBloomSummary();
    }

    const ids = await this.localStore.getAllIds();
    return createIdBloomSummary(ids);
  }

  /**
   * Handle sync capability negotiation.
   */
  async handleGetCapabilities(token: string): Promise<NetworkSyncCapabilities> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    return {
      protocolVersion: "sync-v4",
      supportsCursorScan: typeof this.localStore.scanEntriesSince === "function",
      supportsIdBloomSummary: typeof this.localStore.getIdBloomSummary === "function",
      supportsCompactionStatus: typeof this.localStore.getCompactionStatus === "function",
      supportsMaterializationPlanning:
        typeof this.localStore.planDocumentMaterialization === "function",
      supportsBatchMaterializationPlanning:
        typeof this.localStore.planDocumentMaterializationBatch === "function",
      supportsAttachmentReadPlanning:
        typeof this.localStore.planAttachmentReadByWalkingMetadata === "function",
      // Access-control v1 negotiation (docs/accesscontrol.md §4). `serverTime`
      // lets the client run its clock-skew guard before syncing; the flag
      // advertises that this server stamps witness receipts and enforces Tier 1.
      serverTime: Date.now(),
      supportsAccessControlV1: this.timestampProvider !== undefined,
      supportsRemoteWipeV1: this.wipeGrantDocIdResolver !== undefined,
    };
  }

  /**
   * Handle a getCompactionStatus request from a client.
   */
  async handleGetCompactionStatus(token: string): Promise<StoreCompactionStatus> {
    this.logger.debug(`Handling getCompactionStatus request`);

    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    if (this.localStore.getCompactionStatus) {
      return this.localStore.getCompactionStatus();
    }

    return {
      enabled: false,
      compactionMinFiles: 0,
      compactionMaxBytes: 0,
      totalCompactions: 0,
      totalCompactedFiles: 0,
      totalCompactedBytes: 0,
      totalCompactionDurationMs: 0,
      lastCompactionAt: null,
      lastCompactedFiles: 0,
      lastCompactedBytes: 0,
      lastCompactionDurationMs: 0,
    };
  }

  /**
   * Handle a getEntries request from a client.
   * Encrypts the entries with the client's RSA public key.
   * 
   * @param token The JWT access token
   * @param ids The IDs of entries to retrieve
   * @returns The entries with RSA-encrypted payloads
   */
  async handleGetEntries(
    token: string,
    ids: string[]
  ): Promise<NetworkEncryptedEntry[]> {
    this.logger.debug(`Handling getEntries request for ${ids.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    const username = tokenPayload.sub;
    this.logger.debug(`Token validated for user: ${username}`);
    
    // Get user's public encryption key
    const userKeys = await this.directory.getUserPublicKeys(username);
    if (!userKeys) {
      throw new NetworkError(
        NetworkErrorType.USER_NOT_FOUND,
        `User "${username}" is not found, or has no active access grant on this server. `
          + `The tenant's directory database may not have been synced to this server yet, `
          + `or the access was revoked.`,
      );
    }
    
    this.logger.debug(`Retrieved encryption key for user: ${username}`);
    
    // Restrict a wipe-scoped token to only the grant directive (§6.5).
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const requestedIds = allowed ? ids.filter((id) => allowed.has(id)) : ids;

    // Get the entries from local store
    const entries = await this.localStore.getEntries(requestedIds);
    this.logger.debug(`Retrieved ${entries.length} entries from local store`);
    
    // Encrypt each entry with the user's RSA public key
    const encryptedEntries = await this.encryptEntriesForUser(
      entries,
      userKeys.encryptionPublicKey
    );
    
    this.logger.debug(`Encrypted ${encryptedEntries.length} entries for user: ${username}`);
    return encryptedEntries;
  }

  async handleGetEntryMetadata(
    token: string,
    id: string
  ): Promise<StoreEntryMetadata | null> {
    this.logger.debug(`Handling getEntryMetadata request for ${id}`);

    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    const allowed = await this.wipeAllowedIds(tokenPayload);
    if (allowed && !allowed.has(id)) {
      return null;
    }
    return this.localStore.getEntryMetadata(id);
  }

  /**
   * Handle a putEntries request from a client.
   * 
   * @param token The JWT access token
   * @param entries The entries to store
   */
  async handlePutEntries(token: string, entries: StoreEntry[]): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling putEntries request for ${entries.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    // A wipe-targeted device may not push anything (§6.5): it exists only to
    // receive the wipe directive and then delete its local copy.
    if (tokenPayload.wipe && this.wipeGrantDocIdResolver) {
      throw new NetworkError(
        NetworkErrorType.ACCESS_DENIED,
        "Device is targeted for remote wipe and may not push entries",
      );
    }

    // A single acceptance time for this batch so receipts are consistent and a
    // batch cannot interleave with the witness's own monotonic clock (§5.3).
    const receivedAt = Date.now();
    const stampedMetadata: StoreEntryMetadata[] = [];

    // Process each entry
    const toStore: StoreEntry[] = [];
    for (const entry of entries) {
      // Verify the entry was created by a trusted user (baseline Tier 1).
      const isValidKey = await this.directory.validatePublicSigningKey(entry.createdByPublicKey);
      if (!isValidKey) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Entry ${entry.id} was not signed by a trusted user`
        );
      }

      // Rule-based Tier 1 enforcement (docs/accesscontrol.md §7). The server can
      // only decide the identity tier; content-tier (Tier 2) gates are deferred
      // to clients and treated as allowed here.
      if (this.tier1Evaluator) {
        const decision = await this.tier1Evaluator(entry, this.witnessDbid ?? this.localStore.getId());
        if (!decision.allowed) {
          throw new NetworkError(
            NetworkErrorType.ACCESS_DENIED,
            `Entry ${entry.id} denied by Tier 1 policy: ${decision.reason}`
          );
        }
      }

      // Stamp a witness receipt onto the accepted entry (§5.3). Self-authored
      // entries (the witness pushing its own data) are not self-witnessed.
      //
      // Legacy entries (no `entryVersion`) are NOT witnessed: they predate the
      // witness era and the version-aware trusted-time rule treats them as
      // stable at their `createdAt` (see core/storeEntryTime.ts). Stamping a
      // `receivedAt = now` on them when an old local DB first syncs to a fresh
      // server would collapse every old doc onto "today" and re-introduce the
      // "access since: today" bug. Only witness-era writers (`entryVersion`
      // present) are eligible for a receipt.
      if (
        this.timestampProvider
        && entry.entryVersion !== undefined
        && entry.createdByPublicKey !== this.timestampProvider.issuerPublicKey
      ) {
        const stamp = await this.timestampProvider.stamp(
          entry,
          { dbid: this.witnessDbid ?? this.localStore.getId(), receivedAt }
        );
        const witnessed: StoreEntry = { ...entry, ...stamp };
        toStore.push(witnessed);
        stampedMetadata.push(this.toMetadata(witnessed));
      } else {
        toStore.push(entry);
        stampedMetadata.push(this.toMetadata(entry));
      }
    }
    
    // Store all entries (witnessed where applicable)
    await this.localStore.putEntries(toStore);
    this.logger.debug(`Successfully stored ${toStore.length} entries`);
    return stampedMetadata;
  }

  /** Project a store entry to its metadata (including any witness fields). */
  private toMetadata(entry: StoreEntry): StoreEntryMetadata {
    const { encryptedData: _encryptedData, ...metadata } = entry;
    return metadata as StoreEntryMetadata;
  }

  /**
   * Handle a hasEntries request from a client.
   * Checks which of the provided IDs exist in the store.
   * 
   * @param token The JWT access token
   * @param ids The IDs to check for existence
   * @returns List of IDs that exist in the store
   */
  async handleHasEntries(token: string, ids: string[]): Promise<string[]> {
    this.logger.debug(`Handling hasEntries request for ${ids.length} IDs`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Check which IDs exist in local store
    const existingIds = await this.localStore.hasEntries(ids);
    this.logger.debug(`Found ${existingIds.length} existing entries out of ${ids.length} checked`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    return allowed ? existingIds.filter((id) => allowed.has(id)) : existingIds;
  }

  /**
   * Handle a getAllIds request from a client.
   * This is used by clients to determine which entries they need to push.
   * 
   * @param token The JWT access token
   * @returns List of all entry IDs in the store
   */
  async handleGetAllIds(token: string): Promise<string[]> {
    this.logger.debug(`Handling getAllIds request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Get all entry IDs from local store
    const allIds = await this.localStore.getAllIds();
    this.logger.debug(`Returning ${allIds.length} entry IDs`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    return allowed ? allIds.filter((id) => allowed.has(id)) : allIds;
  }

  /**
   * Handle a resolveDependencies request from a client.
   * Resolves the dependency chain starting from an entry ID.
   * 
   * @param token The JWT access token
   * @param startId The entry ID to start traversal from
   * @param options Optional traversal options
   * @returns List of entry IDs in dependency order
   */
  async handleResolveDependencies(
    token: string,
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    this.logger.debug(`Handling resolveDependencies request for ${startId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // A wipe-scoped token may not traverse the DAG beyond its grant directive.
    const allowed = await this.wipeAllowedIds(tokenPayload);
    if (allowed) {
      return allowed.has(startId) ? [startId] : [];
    }

    // Resolve dependencies in local store
    const resolvedIds = await this.localStore.resolveDependencies(startId, options);
    this.logger.debug(`Resolved ${resolvedIds.length} dependencies`);
    
    return resolvedIds;
  }

  async handlePlanDocumentMaterialization(
    token: string,
    docId: string,
    options?: MaterializationPlanOptions
  ): Promise<DocumentMaterializationPlan> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    return this.localStore.planDocumentMaterialization(docId, options);
  }

  async handlePlanDocumentMaterializationBatch(
    token: string,
    docIds: string[],
    options?: MaterializationPlanOptions
  ): Promise<DocumentMaterializationBatchPlan> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    return this.localStore.planDocumentMaterializationBatch(docIds, options);
  }

  async handlePlanAttachmentReadByWalkingMetadata(
    token: string,
    lastChunkId: string,
    attachmentSize: number,
    options: AttachmentReadPlanOptions,
  ): Promise<AttachmentReadPlan> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    if (!this.localStore.planAttachmentReadByWalkingMetadata) {
      throw new Error("Remote store does not support attachment read planning");
    }
    return this.localStore.planAttachmentReadByWalkingMetadata(lastChunkId, attachmentSize, options);
  }

  /**
   * Validate a JWT token and return the payload.
   * 
   * @param token The JWT token
   * @returns The token payload
   * @throws NetworkError if token is invalid
   */
  private async validateToken(token: string): Promise<NetworkAuthTokenPayload> {
    const payload = await this.authService.validateToken(token);
    
    if (!payload) {
      throw new NetworkError(
        NetworkErrorType.INVALID_TOKEN,
        "Invalid or expired token"
      );
    }
    
    return payload;
  }

  /**
   * Encrypt entries with a user's RSA public key.
   * Transforms StoreEntry[] to NetworkEncryptedEntry[].
   */
  private async encryptEntriesForUser(
    entries: StoreEntry[],
    encryptionPublicKey: string
  ): Promise<NetworkEncryptedEntry[]> {
    const results: NetworkEncryptedEntry[] = [];
    
    // Import the public key once for all entries
    const publicKey = await this.rsaEncryption.importPublicKey(encryptionPublicKey);
    
    for (const entry of entries) {
      // Encrypt the payload with RSA
      const rsaEncryptedPayload = await this.rsaEncryption.encrypt(
        entry.encryptedData,
        publicKey
      );
      
      // Create NetworkEncryptedEntry with all metadata plus RSA-encrypted payload
      const encryptedEntry: NetworkEncryptedEntry = {
        entryType: entry.entryType,
        id: entry.id,
        contentHash: entry.contentHash,
        docId: entry.docId,
        dependencyIds: entry.dependencyIds,
        createdAt: entry.createdAt,
        createdByPublicKey: entry.createdByPublicKey,
        decryptionKeyId: entry.decryptionKeyId,
        snapshotHeadHashes: entry.snapshotHeadHashes,
        snapshotHeadEntryIds: entry.snapshotHeadEntryIds,
        signature: entry.signature,
        originalSize: entry.originalSize,
        encryptedSize: entry.encryptedSize,
        rsaEncryptedPayload,
      };
      
      results.push(encryptedEntry);
    }
    
    return results;
  }
}
