import type { AppendOnlyStore } from "../types";
import type { MindooDocChange, MindooDocChangeHashes, MindooTenantDirectory } from "../../types";
import type { CryptoAdapter } from "../../crypto/CryptoAdapter";
import type { NetworkEncryptedChange, NetworkAuthTokenPayload } from "./types";
import { NetworkError, NetworkErrorType } from "./types";
import { RSAEncryption } from "../../crypto/RSAEncryption";
import { AuthenticationService } from "./AuthenticationService";

/**
 * Server-side network handler for AppendOnlyStore operations.
 * 
 * This class handles incoming sync requests from clients:
 * 1. Validates authentication tokens
 * 2. Retrieves changes from the local store
 * 3. Encrypts changes with the requesting user's RSA public key
 * 4. Returns encrypted changes to the client
 * 
 * This is not an AppendOnlyStore implementation itself, but rather
 * a service that wraps a local AppendOnlyStore and handles network requests.
 */
export class ServerNetworkAppendOnlyStore {
  private localStore: AppendOnlyStore;
  private directory: MindooTenantDirectory;
  private authService: AuthenticationService;
  private rsaEncryption: RSAEncryption;
  private cryptoAdapter: CryptoAdapter;

  /**
   * Create a new ServerNetworkAppendOnlyStore.
   * 
   * @param localStore The local store containing the actual data
   * @param directory The tenant directory for user lookup
   * @param authService The authentication service for token validation
   * @param cryptoAdapter The crypto adapter for encryption
   */
  constructor(
    localStore: AppendOnlyStore,
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
    console.log(`[ServerNetworkAppendOnlyStore] Handling challenge request for user: ${username}`);
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
    console.log(`[ServerNetworkAppendOnlyStore] Handling authentication for challenge: ${challenge}`);
    return this.authService.authenticate(challenge, signature);
  }

  /**
   * Handle a findNewChanges request from a client.
   * 
   * @param token The JWT access token
   * @param haveChangeHashes The change hashes the client already has
   * @returns List of new change hashes
   */
  async handleFindNewChanges(
    token: string,
    haveChangeHashes: string[]
  ): Promise<MindooDocChangeHashes[]> {
    console.log(`[ServerNetworkAppendOnlyStore] Handling findNewChanges request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkAppendOnlyStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Find new changes
    const newChanges = await this.localStore.findNewChanges(haveChangeHashes);
    console.log(`[ServerNetworkAppendOnlyStore] Found ${newChanges.length} new changes`);
    
    return newChanges;
  }

  /**
   * Handle a findNewChangesForDoc request from a client.
   * This is an optimized version that only returns changes for a specific document.
   * 
   * @param token The JWT access token
   * @param haveChangeHashes The change hashes the client already has for this document
   * @param docId The document ID to filter by
   * @returns List of new change hashes for the specified document
   */
  async handleFindNewChangesForDoc(
    token: string,
    haveChangeHashes: string[],
    docId: string
  ): Promise<MindooDocChangeHashes[]> {
    console.log(`[ServerNetworkAppendOnlyStore] Handling findNewChangesForDoc request for doc ${docId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkAppendOnlyStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Find new changes for the specific document
    const newChanges = await this.localStore.findNewChangesForDoc(haveChangeHashes, docId);
    console.log(`[ServerNetworkAppendOnlyStore] Found ${newChanges.length} new changes for doc ${docId}`);
    
    return newChanges;
  }

  /**
   * Handle a getChanges request from a client.
   * Encrypts the changes with the client's RSA public key.
   * 
   * @param token The JWT access token
   * @param changeHashes The change hashes to retrieve
   * @returns The changes with RSA-encrypted payloads
   */
  async handleGetChanges(
    token: string,
    changeHashes: MindooDocChangeHashes[]
  ): Promise<NetworkEncryptedChange[]> {
    console.log(`[ServerNetworkAppendOnlyStore] Handling getChanges request for ${changeHashes.length} changes`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    const username = tokenPayload.sub;
    console.log(`[ServerNetworkAppendOnlyStore] Token validated for user: ${username}`);
    
    // Get user's public encryption key
    const userKeys = await this.directory.getUserPublicKeys(username);
    if (!userKeys) {
      throw new NetworkError(
        NetworkErrorType.USER_NOT_FOUND,
        `User ${username} not found or revoked`
      );
    }
    
    console.log(`[ServerNetworkAppendOnlyStore] Retrieved encryption key for user: ${username}`);
    
    // Get the changes from local store
    const changes = await this.localStore.getChanges(changeHashes);
    console.log(`[ServerNetworkAppendOnlyStore] Retrieved ${changes.length} changes from local store`);
    
    // Encrypt each change with the user's RSA public key
    const encryptedChanges = await this.encryptChangesForUser(
      changes,
      userKeys.encryptionPublicKey
    );
    
    console.log(`[ServerNetworkAppendOnlyStore] Encrypted ${encryptedChanges.length} changes for user: ${username}`);
    return encryptedChanges;
  }

  /**
   * Handle an append request from a client.
   * Note: In a typical sync scenario, clients push changes to the server.
   * 
   * @param token The JWT access token
   * @param change The change to append
   */
  async handleAppend(token: string, change: MindooDocChange): Promise<void> {
    console.log(`[ServerNetworkAppendOnlyStore] Handling append request for change: ${change.changeHash}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkAppendOnlyStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Verify the change was created by a trusted user
    // The change.createdByPublicKey should match a registered user
    const isValidKey = await this.directory.validatePublicSigningKey(change.createdByPublicKey);
    if (!isValidKey) {
      throw new NetworkError(
        NetworkErrorType.INVALID_SIGNATURE,
        "Change was not signed by a trusted user"
      );
    }
    
    // Append to local store
    await this.localStore.append(change);
    console.log(`[ServerNetworkAppendOnlyStore] Appended change: ${change.changeHash}`);
  }

  /**
   * Handle a pushChanges request from a client (bulk append).
   * This allows clients to push multiple changes at once for efficiency.
   * 
   * @param token The JWT access token
   * @param changes The changes to push
   */
  async handlePushChanges(token: string, changes: MindooDocChange[]): Promise<void> {
    console.log(`[ServerNetworkAppendOnlyStore] Handling pushChanges request for ${changes.length} changes`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkAppendOnlyStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Process each change
    for (const change of changes) {
      // Verify the change was created by a trusted user
      const isValidKey = await this.directory.validatePublicSigningKey(change.createdByPublicKey);
      if (!isValidKey) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Change ${change.changeHash} was not signed by a trusted user`
        );
      }
      
      // Append to local store
      await this.localStore.append(change);
      console.log(`[ServerNetworkAppendOnlyStore] Appended change: ${change.changeHash}`);
    }
    
    console.log(`[ServerNetworkAppendOnlyStore] Successfully pushed ${changes.length} changes`);
  }

  /**
   * Handle a getAllChangeHashes request from a client.
   * This is used by clients to determine which changes they need to push.
   * 
   * @param token The JWT access token
   * @returns List of all change hashes in the store
   */
  async handleGetAllChangeHashes(token: string): Promise<string[]> {
    console.log(`[ServerNetworkAppendOnlyStore] Handling getAllChangeHashes request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    console.log(`[ServerNetworkAppendOnlyStore] Token validated for user: ${tokenPayload.sub}`);
    
    // Get all change hashes from local store
    const allHashes = await this.localStore.getAllChangeHashes();
    console.log(`[ServerNetworkAppendOnlyStore] Returning ${allHashes.length} change hashes`);
    
    return allHashes;
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
   * Encrypt changes with a user's RSA public key.
   * Transforms MindooDocChange[] to NetworkEncryptedChange[].
   */
  private async encryptChangesForUser(
    changes: MindooDocChange[],
    encryptionPublicKey: string
  ): Promise<NetworkEncryptedChange[]> {
    const results: NetworkEncryptedChange[] = [];
    
    // Import the public key once for all changes
    const publicKey = await this.rsaEncryption.importPublicKey(encryptionPublicKey);
    
    for (const change of changes) {
      // Encrypt the payload with RSA
      const rsaEncryptedPayload = await this.rsaEncryption.encrypt(
        change.payload,
        publicKey
      );
      
      // Extract metadata (everything except payload)
      const { payload, ...metadata } = change;
      
      // Create NetworkEncryptedChange
      const encryptedChange: NetworkEncryptedChange = {
        ...metadata,
        rsaEncryptedPayload,
      };
      
      results.push(encryptedChange);
    }
    
    return results;
  }
}
