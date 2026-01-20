import type { ContentAddressedStore } from "../../core/types";
import type { StoreEntry, StoreEntryMetadata } from "../../core/types";
import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import type { NetworkTransport } from "../../core/appendonlystores/network/NetworkTransport";
import type { NetworkEncryptedEntry } from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";
import { RSAEncryption } from "../../core/crypto/RSAEncryption";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";

/**
 * Client-side network ContentAddressedStore that forwards all operations to a remote server.
 * 
 * This store acts as a pure remote proxy:
 * 1. All read/write operations are forwarded to the remote server
 * 2. Authenticates with the remote peer using challenge-response
 * 3. Decrypts RSA-encrypted entries received from the network
 * 
 * Usage patterns:
 * 1. **Direct remote**: Instantiate MindooDB with ClientNetworkContentAddressedStore for
 *    transparent remote read/write operations.
 * 2. **Sync-based**: Use a local store (e.g., InMemoryContentAddressedStore) with MindooDB,
 *    then sync with a ClientNetworkContentAddressedStore via pullChangesFrom/pushChangesTo.
 */
export class ClientNetworkContentAddressedStore implements ContentAddressedStore {
  private dbId: string;
  private transport: NetworkTransport;
  private rsaEncryption: RSAEncryption;
  private privateEncryptionKey: CryptoKey | string;
  private username: string;
  private signingKey: CryptoKey;
  private cryptoAdapter: CryptoAdapter;
  
  // Cached access token
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private logger: Logger;

  /**
   * Create a new ClientNetworkContentAddressedStore.
   * 
   * @param dbId The database ID
   * @param transport The network transport for remote communication
   * @param cryptoAdapter The crypto adapter for encryption
   * @param username The username for authentication
   * @param signingKey The user's private signing key (for signing challenges)
   * @param privateEncryptionKey The user's private RSA key (for decrypting received entries)
   * @param logger Optional logger instance
   */
  constructor(
    dbId: string,
    transport: NetworkTransport,
    cryptoAdapter: CryptoAdapter,
    username: string,
    signingKey: CryptoKey,
    privateEncryptionKey: CryptoKey | string,
    logger?: Logger
  ) {
    this.dbId = dbId;
    this.transport = transport;
    this.cryptoAdapter = cryptoAdapter;
    this.username = username;
    this.signingKey = signingKey;
    this.privateEncryptionKey = privateEncryptionKey;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `ClientNetworkStore:${dbId}`, true);
    const rsaLogger = this.logger.createChild("RSAEncryption");
    this.rsaEncryption = new RSAEncryption(cryptoAdapter, rsaLogger);
  }

  getId(): string {
    return this.dbId;
  }

  /**
   * Store entries to the remote store.
   * The entries are pushed to the server immediately.
   */
  async putEntries(entries: StoreEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    
    this.logger.debug(`Pushing ${entries.length} entries to remote`);
    
    const token = await this.ensureAuthenticated();
    await this.transport.putEntries(token, entries);
    
    this.logger.debug(`Successfully pushed ${entries.length} entries`);
  }

  /**
   * Get entries from the remote store by their IDs.
   * 
   * @param ids The IDs of entries to retrieve
   * @returns The entries with decrypted payloads
   */
  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    this.logger.debug(`Getting ${ids.length} entries from remote`);
    
    if (ids.length === 0) {
      return [];
    }
    
    const token = await this.ensureAuthenticated();
    
    const encryptedEntries = await this.transport.getEntries(token, ids);
    this.logger.debug(`Received ${encryptedEntries.length} encrypted entries from remote`);
    
    // Decrypt the RSA layer for each entry
    const entries = await this.decryptNetworkEntries(encryptedEntries);
    this.logger.debug(`Decrypted ${entries.length} entries`);
    
    return entries;
  }

  /**
   * Check which IDs exist in the remote store.
   * 
   * @param ids The IDs to check
   * @returns List of IDs that exist in the remote store
   */
  async hasEntries(ids: string[]): Promise<string[]> {
    this.logger.debug(`Checking ${ids.length} IDs in remote`);
    
    if (ids.length === 0) {
      return [];
    }
    
    const token = await this.ensureAuthenticated();
    const existingIds = await this.transport.hasEntries(token, ids);
    this.logger.debug(`Found ${existingIds.length} existing entries`);
    
    return existingIds;
  }

  /**
   * Find new entries from the remote store.
   * 
   * @param knownIds The list of entry IDs we already have
   * @returns List of new entry metadata from the remote store
   */
  async findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Finding new entries from remote`);
    
    const token = await this.ensureAuthenticated();
    //TODO improve this by using a bloom filter
    const newEntries = await this.transport.findNewEntries(token, knownIds);
    
    this.logger.debug(`Found ${newEntries.length} new entries from remote`);
    return newEntries;
  }

  /**
   * Find new entries for a specific document from the remote store.
   */
  async findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Finding new entries for doc ${docId} from remote`);
    
    const token = await this.ensureAuthenticated();
    const newEntries = await this.transport.findNewEntriesForDoc(token, knownIds, docId);
    
    this.logger.debug(`Found ${newEntries.length} new entries for doc ${docId}`);
    return newEntries;
  }

  /**
   * Get all entry IDs from the remote store.
   * Used for synchronization to identify which entries the remote has.
   */
  async getAllIds(): Promise<string[]> {
    this.logger.debug(`Getting all entry IDs from remote`);
    
    const token = await this.ensureAuthenticated();
    const allIds = await this.transport.getAllIds(token);
    
    this.logger.debug(`Remote has ${allIds.length} entry IDs`);
    return allIds;
  }

  /**
   * Resolve dependencies for an entry.
   * 
   * Delegates to the remote server for efficient server-side traversal.
   */
  async resolveDependencies(
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    this.logger.debug(`Resolving dependencies for ${startId}`);
    
    const token = await this.ensureAuthenticated();
    const resolvedIds = await this.transport.resolveDependencies(token, startId, options);
    
    this.logger.debug(`Resolved ${resolvedIds.length} dependencies`);
    return resolvedIds;
  }

  /**
   * Purge document history from the store.
   * 
   * Note: Network stores are proxies that forward operations to remote servers.
   * Purging should be done on local stores after syncing data from remote stores.
   * This method is a no-op for network stores.
   * 
   * @param docId The document ID whose entry history should be purged
   */
  async purgeDocHistory(docId: string): Promise<void> {
    this.logger.warn(`purgeDocHistory() called on network store for doc ${docId}. Network stores do not support purging directly. Purge should be done on local stores after syncing from remote.`);
    // No-op: Network stores forward to server, purging should be done on local stores
  }

  /**
   * Ensure we have a valid access token, authenticating if necessary.
   */
  private async ensureAuthenticated(): Promise<string> {
    const now = Date.now();
    
    // Check if we have a valid token
    if (this.accessToken && this.tokenExpiry > now + 60000) { // 1 minute buffer
      return this.accessToken;
    }
    
    this.logger.debug(`Authenticating user: ${this.username}`);
    
    // Request a challenge
    const challenge = await this.transport.requestChallenge(this.username);
    this.logger.debug(`Received challenge: ${challenge}`);
    
    // Sign the challenge
    const signature = await this.signChallenge(challenge);
    this.logger.debug(`Signed challenge`);
    
    // Authenticate
    const result = await this.transport.authenticate(challenge, signature);
    
    if (!result.success || !result.token) {
      throw new NetworkError(
        NetworkErrorType.INVALID_SIGNATURE,
        result.error || "Authentication failed"
      );
    }
    
    this.accessToken = result.token;
    
    // Parse token expiry from JWT (simple extraction)
    try {
      const parts = result.token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        this.tokenExpiry = payload.exp * 1000; // Convert to milliseconds
      }
    } catch {
      // Default to 1 hour if we can't parse
      this.tokenExpiry = now + 3600000;
    }
    
    this.logger.debug(`Authentication successful`);
    return this.accessToken;
  }

  /**
   * Sign a challenge with the user's private signing key.
   */
  private async signChallenge(challenge: string): Promise<Uint8Array> {
    const subtle = this.cryptoAdapter.getSubtle();
    const messageBytes = new TextEncoder().encode(challenge);
    
    const signature = await subtle.sign(
      { name: "Ed25519" },
      this.signingKey,
      messageBytes
    );
    
    return new Uint8Array(signature);
  }

  /**
   * Decrypt network-encrypted entries.
   * Transforms NetworkEncryptedEntry[] to StoreEntry[].
   */
  private async decryptNetworkEntries(
    encryptedEntries: NetworkEncryptedEntry[]
  ): Promise<StoreEntry[]> {
    const results: StoreEntry[] = [];
    
    for (const enc of encryptedEntries) {
      // Decrypt the RSA layer to get the original symmetric-encrypted payload
      const encryptedData = await this.rsaEncryption.decrypt(
        enc.rsaEncryptedPayload,
        this.privateEncryptionKey
      );
      
      // Create the full StoreEntry using metadata from the network entry
      const entry: StoreEntry = {
        entryType: enc.entryType,
        id: enc.id,
        contentHash: enc.contentHash,
        docId: enc.docId,
        dependencyIds: enc.dependencyIds,
        createdAt: enc.createdAt,
        createdByPublicKey: enc.createdByPublicKey,
        decryptionKeyId: enc.decryptionKeyId,
        signature: enc.signature,
        originalSize: enc.originalSize,
        encryptedSize: enc.encryptedSize,
        encryptedData,
      };
      
      results.push(entry);
    }
    
    return results;
  }

  /**
   * Clear the cached access token.
   * Call this if you need to force re-authentication.
   */
  clearAuthCache(): void {
    this.accessToken = null;
    this.tokenExpiry = 0;
  }
}
