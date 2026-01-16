import type { ContentAddressedStore } from "../../core/types";
import type { StoreEntry, StoreEntryMetadata, MindooTenantDirectory } from "../../core/types";
import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import type { NetworkEncryptedEntry, NetworkAuthTokenPayload } from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";
import { RSAEncryption } from "../../core/crypto/RSAEncryption";
import { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";

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

  /**
   * Create a new ServerNetworkContentAddressedStore.
   * 
   * @param localStore The local store containing the actual data
   * @param directory The tenant directory for user lookup
   * @param authService The authentication service for token validation
   * @param cryptoAdapter The crypto adapter for encryption
   */
  constructor(
    localStore: ContentAddressedStore,
    directory: MindooTenantDirectory,
    authService: AuthenticationService,
    cryptoAdapter: CryptoAdapter
  ) {
    this.localStore = localStore;
    this.directory = directory;
    this.authService = authService;
    this.cryptoAdapter = cryptoAdapter;
    this.rsaEncryption = new RSAEncryption(cryptoAdapter);
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
    console.log(`[ServerNetworkContentAddressedStore] Handling challenge request for user: ${username}`);
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
    console.log(`[ServerNetworkContentAddressedStore] Handling authentication for challenge: ${challenge}`);
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
    console.log(`[ServerNetworkContentAddressedStore] Handling findNewEntries request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Find new entries
    const newEntries = await this.localStore.findNewEntries(knownIds);
    console.log(`[ServerNetworkContentAddressedStore] Found ${newEntries.length} new entries`);
    
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
    console.log(`[ServerNetworkContentAddressedStore] Handling findNewEntriesForDoc request for doc ${docId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Find new entries for the specific document
    const newEntries = await this.localStore.findNewEntriesForDoc(knownIds, docId);
    console.log(`[ServerNetworkContentAddressedStore] Found ${newEntries.length} new entries for doc ${docId}`);
    
    return newEntries;
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
    console.log(`[ServerNetworkContentAddressedStore] Handling getEntries request for ${ids.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    const username = tokenPayload.sub;
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${username}`);
    
    // Get user's public encryption key
    const userKeys = await this.directory.getUserPublicKeys(username);
    if (!userKeys) {
      throw new NetworkError(
        NetworkErrorType.USER_NOT_FOUND,
        `User ${username} not found or revoked`
      );
    }
    
    console.log(`[ServerNetworkContentAddressedStore] Retrieved encryption key for user: ${username}`);
    
    // Get the entries from local store
    const entries = await this.localStore.getEntries(ids);
    console.log(`[ServerNetworkContentAddressedStore] Retrieved ${entries.length} entries from local store`);
    
    // Encrypt each entry with the user's RSA public key
    const encryptedEntries = await this.encryptEntriesForUser(
      entries,
      userKeys.encryptionPublicKey
    );
    
    console.log(`[ServerNetworkContentAddressedStore] Encrypted ${encryptedEntries.length} entries for user: ${username}`);
    return encryptedEntries;
  }

  /**
   * Handle a putEntries request from a client.
   * 
   * @param token The JWT access token
   * @param entries The entries to store
   */
  async handlePutEntries(token: string, entries: StoreEntry[]): Promise<void> {
    console.log(`[ServerNetworkContentAddressedStore] Handling putEntries request for ${entries.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${tokenPayload.sub}`);
    
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
    console.log(`[ServerNetworkContentAddressedStore] Successfully stored ${entries.length} entries`);
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
    console.log(`[ServerNetworkContentAddressedStore] Handling hasEntries request for ${ids.length} IDs`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Check which IDs exist in local store
    const existingIds = await this.localStore.hasEntries(ids);
    console.log(`[ServerNetworkContentAddressedStore] Found ${existingIds.length} existing entries out of ${ids.length} checked`);
    
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
    console.log(`[ServerNetworkContentAddressedStore] Handling getAllIds request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Get all entry IDs from local store
    const allIds = await this.localStore.getAllIds();
    console.log(`[ServerNetworkContentAddressedStore] Returning ${allIds.length} entry IDs`);
    
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
    console.log(`[ServerNetworkContentAddressedStore] Handling resolveDependencies request for ${startId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkContentAddressedStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Resolve dependencies in local store
    const resolvedIds = await this.localStore.resolveDependencies(startId, options);
    console.log(`[ServerNetworkContentAddressedStore] Resolved ${resolvedIds.length} dependencies`);
    
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
