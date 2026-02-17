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
    logger?: Logger
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
    
    return newEntries;
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
    
    return newEntries;
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
    
    return entries;
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
      .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt));

    const max = limit ?? Number.MAX_SAFE_INTEGER;
    const startIndex =
      cursor === null
        ? 0
        : sorted.findIndex((meta) => meta.createdAt > cursor.createdAt || (meta.createdAt === cursor.createdAt && meta.id > cursor.id));

    if (startIndex === -1) {
      return { entries: [], nextCursor: cursor, hasMore: false };
    }

    const page = sorted.slice(startIndex, startIndex + max);
    const last = page.length > 0 ? page[page.length - 1] : null;
    return {
      entries: page,
      nextCursor: last ? { createdAt: last.createdAt, id: last.id } : cursor,
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
      protocolVersion: "sync-v2",
      supportsCursorScan: typeof this.localStore.scanEntriesSince === "function",
      supportsIdBloomSummary: typeof this.localStore.getIdBloomSummary === "function",
      supportsCompactionStatus: typeof this.localStore.getCompactionStatus === "function",
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
        `User ${username} not found or revoked`
      );
    }
    
    this.logger.debug(`Retrieved encryption key for user: ${username}`);
    
    // Get the entries from local store
    const entries = await this.localStore.getEntries(ids);
    this.logger.debug(`Retrieved ${entries.length} entries from local store`);
    
    // Encrypt each entry with the user's RSA public key
    const encryptedEntries = await this.encryptEntriesForUser(
      entries,
      userKeys.encryptionPublicKey
    );
    
    this.logger.debug(`Encrypted ${encryptedEntries.length} entries for user: ${username}`);
    return encryptedEntries;
  }

  /**
   * Handle a putEntries request from a client.
   * 
   * @param token The JWT access token
   * @param entries The entries to store
   */
  async handlePutEntries(token: string, entries: StoreEntry[]): Promise<void> {
    this.logger.debug(`Handling putEntries request for ${entries.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Process each entry
    for (const entry of entries) {
      // Verify the entry was created by a trusted user
      const isValidKey = await this.directory.validatePublicSigningKey(entry.createdByPublicKey);
      if (!isValidKey) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Entry ${entry.id} was not signed by a trusted user`
        );
      }
    }
    
    // Store all entries
    await this.localStore.putEntries(entries);
    this.logger.debug(`Successfully stored ${entries.length} entries`);
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
    
    return existingIds;
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
    
    return allIds;
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
    
    // Resolve dependencies in local store
    const resolvedIds = await this.localStore.resolveDependencies(startId, options);
    this.logger.debug(`Resolved ${resolvedIds.length} dependencies`);
    
    return resolvedIds;
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
