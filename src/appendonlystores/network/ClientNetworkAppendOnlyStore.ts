import type { AppendOnlyStore } from "../types";
import type { MindooDocChange, MindooDocChangeHashes } from "../../types";
import type { CryptoAdapter } from "../../crypto/CryptoAdapter";
import type { NetworkTransport } from "./NetworkTransport";
import type { NetworkEncryptedChange } from "./types";
import { NetworkError, NetworkErrorType } from "./types";
import { RSAEncryption } from "../../crypto/RSAEncryption";

/**
 * Client-side network AppendOnlyStore that forwards all operations to a remote server.
 * 
 * This store acts as a pure remote proxy:
 * 1. All read/write operations are forwarded to the remote server
 * 2. Authenticates with the remote peer using challenge-response
 * 3. Decrypts RSA-encrypted changes received from the network
 * 
 * Usage patterns:
 * 1. **Direct remote**: Instantiate MindooDB with ClientNetworkAppendOnlyStore for
 *    transparent remote read/write operations.
 * 2. **Sync-based**: Use a local store (e.g., InMemoryAppendOnlyStore) with MindooDB,
 *    then sync with a ClientNetworkAppendOnlyStore via pullChangesFrom/pushChangesTo.
 */
export class ClientNetworkAppendOnlyStore implements AppendOnlyStore {
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

  /**
   * Create a new ClientNetworkAppendOnlyStore.
   * 
   * @param dbId The database ID
   * @param transport The network transport for remote communication
   * @param cryptoAdapter The crypto adapter for encryption
   * @param username The username for authentication
   * @param signingKey The user's private signing key (for signing challenges)
   * @param privateEncryptionKey The user's private RSA key (for decrypting received changes)
   */
  constructor(
    dbId: string,
    transport: NetworkTransport,
    cryptoAdapter: CryptoAdapter,
    username: string,
    signingKey: CryptoKey,
    privateEncryptionKey: CryptoKey | string
  ) {
    this.dbId = dbId;
    this.transport = transport;
    this.cryptoAdapter = cryptoAdapter;
    this.rsaEncryption = new RSAEncryption(cryptoAdapter);
    this.username = username;
    this.signingKey = signingKey;
    this.privateEncryptionKey = privateEncryptionKey;
  }

  getId(): string {
    return this.dbId;
  }

  /**
   * Append a change to the remote store.
   * The change is pushed to the server immediately.
   */
  async append(change: MindooDocChange): Promise<void> {
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Pushing change ${change.changeHash} to remote`);
    
    const token = await this.ensureAuthenticated();
    await this.transport.pushChanges(token, [change]);
    
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Successfully pushed change ${change.changeHash}`);
  }

  /**
   * Find new changes from the remote store.
   * 
   * @param haveChangeHashes The list of change hashes we already have
   * @returns List of new change hashes from the remote store
   */
  async findNewChanges(haveChangeHashes: string[]): Promise<MindooDocChangeHashes[]> {
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Finding new changes from remote`);
    
    const token = await this.ensureAuthenticated();
    const newChanges = await this.transport.findNewChanges(token, haveChangeHashes);
    
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Found ${newChanges.length} new changes from remote`);
    return newChanges;
  }

  /**
   * Find new changes for a specific document from the remote store.
   */
  async findNewChangesForDoc(haveChangeHashes: string[], docId: string): Promise<MindooDocChangeHashes[]> {
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Finding new changes for doc ${docId} from remote`);
    
    const token = await this.ensureAuthenticated();
    const newChanges = await this.transport.findNewChangesForDoc(token, haveChangeHashes, docId);
    
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Found ${newChanges.length} new changes for doc ${docId}`);
    return newChanges;
  }

  /**
   * Get changes from the remote store.
   * 
   * @param changeHashes The change hashes to retrieve
   * @returns The changes with decrypted payloads
   */
  async getChanges(changeHashes: MindooDocChangeHashes[]): Promise<MindooDocChange[]> {
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Getting ${changeHashes.length} changes from remote`);
    
    if (changeHashes.length === 0) {
      return [];
    }
    
    const token = await this.ensureAuthenticated();
    const encryptedChanges = await this.transport.getChanges(token, changeHashes);
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Received ${encryptedChanges.length} encrypted changes from remote`);
    
    // Decrypt the changes
    const decryptedChanges = await this.decryptNetworkChanges(encryptedChanges);
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Decrypted ${decryptedChanges.length} changes`);
    
    return decryptedChanges;
  }

  /**
   * Get all change hashes from the remote store.
   * Used for synchronization to identify which changes the remote has.
   */
  async getAllChangeHashes(): Promise<string[]> {
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Getting all change hashes from remote`);
    
    const token = await this.ensureAuthenticated();
    const allHashes = await this.transport.getAllChangeHashes(token);
    
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Remote has ${allHashes.length} change hashes`);
    return allHashes;
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
    
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Authenticating user: ${this.username}`);
    
    // Request a challenge
    const challenge = await this.transport.requestChallenge(this.username);
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Received challenge: ${challenge}`);
    
    // Sign the challenge
    const signature = await this.signChallenge(challenge);
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Signed challenge`);
    
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
    
    console.log(`[ClientNetworkAppendOnlyStore:${this.dbId}] Authentication successful`);
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
   * Decrypt network-encrypted changes.
   * Transforms NetworkEncryptedChange[] to MindooDocChange[].
   */
  private async decryptNetworkChanges(
    encryptedChanges: NetworkEncryptedChange[]
  ): Promise<MindooDocChange[]> {
    const results: MindooDocChange[] = [];
    
    for (const enc of encryptedChanges) {
      // Decrypt the RSA layer to get the original symmetric-encrypted payload
      const payload = await this.rsaEncryption.decrypt(
        enc.rsaEncryptedPayload,
        this.privateEncryptionKey
      );
      
      // Extract metadata (everything except rsaEncryptedPayload)
      const { rsaEncryptedPayload, ...metadata } = enc;
      
      // Combine to create MindooDocChange
      const change: MindooDocChange = {
        ...metadata,
        payload,
      };
      
      results.push(change);
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
