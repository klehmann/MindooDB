import type {
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../../core/types";
import type { NetworkTransport, NetworkTransportConfig } from "../../core/appendonlystores/network/NetworkTransport";
import type {
  NetworkEncryptedEntry,
  AuthResult,
  NetworkSyncCapabilities,
} from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";

/**
 * HTTP implementation of the NetworkTransport interface.
 * 
 * Uses fetch API for making HTTP requests to a remote server.
 * Supports retry with exponential backoff for transient failures.
 * 
 * REST API endpoints:
 * - POST /auth/challenge - Request authentication challenge
 * - POST /auth/authenticate - Authenticate with signed challenge
 * - POST /sync/findNewEntries - Find entries we don't have
 * - POST /sync/getCompactionStatus - Get remote compaction metrics
 * - POST /sync/getEntries - Get specific entries
 * - POST /sync/putEntries - Push entries to the server
 * - GET /sync/getAllIds - Get all entry IDs from the server
 */
export class HttpTransport implements NetworkTransport {
  private config: NetworkTransportConfig;
  private baseUrl: string;
  private logger: Logger;

  constructor(config: NetworkTransportConfig, logger?: Logger) {
    this.config = {
      timeout: 30000,
      retryAttempts: 3,
      retryDelayMs: 1000,
      ...config,
    };
    
    if (!config.baseUrl) {
      throw new Error("HttpTransport requires baseUrl in config");
    }
    
    // Ensure baseUrl doesn't end with /
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "HttpTransport", true);
  }

  /**
   * Request a challenge string for authentication.
   */
  async requestChallenge(username: string): Promise<string> {
    this.logger.debug(`Requesting challenge for user: ${username}`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/auth/challenge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username }),
      }
    );
    
    const data = await response.json();
    
    if (!data.challenge) {
      throw new NetworkError(
        NetworkErrorType.SERVER_ERROR,
        "Server did not return a challenge"
      );
    }
    
    this.logger.debug(`Received challenge: ${data.challenge}`);
    return data.challenge;
  }

  /**
   * Authenticate by providing a signed challenge.
   */
  async authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    this.logger.debug(`Authenticating with challenge: ${challenge}`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/auth/authenticate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          challenge,
          signature: this.uint8ArrayToBase64(signature),
        }),
      }
    );
    
    const data = await response.json();
    
    this.logger.debug(`Authentication result: ${data.success ? "success" : "failed"}`);
    return {
      success: data.success,
      token: data.token,
      error: data.error,
    };
  }

  async getCapabilities(token: string): Promise<NetworkSyncCapabilities> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/sync/capabilities${this.config.dbId ? `?dbId=${encodeURIComponent(this.config.dbId)}` : ""}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${token}`,
          },
        }
      );
      const data = await response.json();
      const capabilities = data.capabilities as NetworkSyncCapabilities | undefined;
      if (!capabilities) {
        throw new Error("Missing capabilities payload");
      }
      return capabilities;
    } catch {
      // Backward-compat fallback for older servers.
      return {
        protocolVersion: "sync-v1",
        supportsCursorScan: false,
        supportsIdBloomSummary: false,
        supportsCompactionStatus: false,
      };
    }
  }

  /**
   * Find entries that the remote has which we don't have locally.
   */
  async findNewEntries(
    token: string,
    haveIds: string[]
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Finding new entries, have ${haveIds.length} IDs`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/findNewEntries`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          haveIds,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the entries
    const entries: StoreEntryMetadata[] = (data.entries || []).map((e: SerializedEntryMetadata) => 
      this.deserializeEntryMetadata(e)
    );
    
    this.logger.debug(`Found ${entries.length} new entries`);
    return entries;
  }

  /**
   * Find entries for a specific document that the remote has which we don't have locally.
   */
  async findNewEntriesForDoc(
    token: string,
    haveIds: string[],
    docId: string
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Finding new entries for doc ${docId}, have ${haveIds.length} IDs`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/findNewEntriesForDoc`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          haveIds,
          docId,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the entries
    const entries: StoreEntryMetadata[] = (data.entries || []).map((e: SerializedEntryMetadata) => 
      this.deserializeEntryMetadata(e)
    );
    
    this.logger.debug(`Found ${entries.length} new entries for doc ${docId}`);
    return entries;
  }

  /**
   * Find entries by type and creation date range from the remote store.
   */
  async findEntries(
    token: string,
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Finding entries of type ${type} in date range`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/findEntries`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          type,
          creationDateFrom,
          creationDateUntil,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the entries
    const entries: StoreEntryMetadata[] = (data.entries || []).map((e: SerializedEntryMetadata) => 
      this.deserializeEntryMetadata(e)
    );
    
    this.logger.debug(`Found ${entries.length} entries`);
    return entries;
  }

  /**
   * Cursor-based metadata scan.
   */
  async scanEntriesSince(
    token: string,
    cursor: StoreScanCursor | null,
    limit: number = Number.MAX_SAFE_INTEGER,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    this.logger.debug(`Scanning entries since cursor`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/scanEntriesSince`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          cursor,
          limit,
          filters,
        }),
      }
    );

    const data = await response.json();
    const entries: StoreEntryMetadata[] = (data.entries || []).map((e: SerializedEntryMetadata) =>
      this.deserializeEntryMetadata(e)
    );

    return {
      entries,
      nextCursor: data.nextCursor ?? null,
      hasMore: data.hasMore === true,
    };
  }

  /**
   * Get probabilistic ID summary from remote store.
   */
  async getIdBloomSummary(token: string): Promise<StoreIdBloomSummary> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/getIdBloomSummary`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
        }),
      }
    );

    const data = await response.json();
    return data.summary as StoreIdBloomSummary;
  }

  async getCompactionStatus(token: string): Promise<StoreCompactionStatus> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/getCompactionStatus`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
        }),
      }
    );

    const data = await response.json();
    return data.status as StoreCompactionStatus;
  }

  /**
   * Get entries from the remote store.
   */
  async getEntries(
    token: string,
    ids: string[]
  ): Promise<NetworkEncryptedEntry[]> {
    this.logger.debug(`Getting ${ids.length} entries`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/getEntries`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          ids,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the encrypted entries
    const entries: NetworkEncryptedEntry[] = (data.entries || []).map((e: SerializedNetworkEncryptedEntry) => ({
      ...this.deserializeEntryMetadata(e),
      rsaEncryptedPayload: this.base64ToUint8Array(e.rsaEncryptedPayload),
    }));
    
    this.logger.debug(`Retrieved ${entries.length} encrypted entries`);
    return entries;
  }

  /**
   * Push entries to the remote store.
   */
  async putEntries(token: string, entries: StoreEntry[]): Promise<void> {
    this.logger.debug(`Pushing ${entries.length} entries`);
    
    // Serialize the entries for transmission
    const serializedEntries = entries.map(e => this.serializeEntry(e));
    
    await this.fetchWithRetry(
      `${this.baseUrl}/sync/putEntries`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          entries: serializedEntries,
        }),
      }
    );
    
    this.logger.debug(`Successfully pushed ${entries.length} entries`);
  }

  /**
   * Check which of the provided IDs exist in the remote store.
   */
  async hasEntries(token: string, ids: string[]): Promise<string[]> {
    this.logger.debug(`Checking ${ids.length} entry IDs`);
    
    if (ids.length === 0) {
      return [];
    }
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/hasEntries`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          ids,
        }),
      }
    );
    
    const data = await response.json();
    const existingIds: string[] = data.ids || [];
    
    this.logger.debug(`Found ${existingIds.length} existing entries out of ${ids.length} checked`);
    return existingIds;
  }

  /**
   * Get all entry IDs from the remote store.
   */
  async getAllIds(token: string): Promise<string[]> {
    this.logger.debug(`Getting all entry IDs`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/getAllIds?tenantId=${encodeURIComponent(this.config.tenantId)}${this.config.dbId ? `&dbId=${encodeURIComponent(this.config.dbId)}` : ""}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      }
    );
    
    const data = await response.json();
    const ids: string[] = data.ids || [];
    
    this.logger.debug(`Retrieved ${ids.length} entry IDs`);
    return ids;
  }

  /**
   * Resolve the dependency chain starting from an entry ID.
   */
  async resolveDependencies(
    token: string,
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    this.logger.debug(`Resolving dependencies for ${startId}`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/resolveDependencies`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          startId,
          options,
        }),
      }
    );
    
    const data = await response.json();
    const ids: string[] = data.ids || [];
    
    this.logger.debug(`Resolved ${ids.length} dependencies`);
    return ids;
  }

  /**
   * Fetch with retry and exponential backoff.
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    let lastError: Error | null = null;
    const attempts = this.config.retryAttempts || 3;
    const baseDelay = this.config.retryDelayMs || 1000;
    
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeout || 30000
        );
        
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        // Handle HTTP error responses
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          
          switch (response.status) {
            case 401:
              throw new NetworkError(
                NetworkErrorType.INVALID_TOKEN,
                errorData.error || "Unauthorized"
              );
            case 403:
              throw new NetworkError(
                NetworkErrorType.USER_REVOKED,
                errorData.error || "Access denied"
              );
            case 404:
              throw new NetworkError(
                NetworkErrorType.USER_NOT_FOUND,
                errorData.error || "Not found"
              );
            default:
              throw new NetworkError(
                NetworkErrorType.SERVER_ERROR,
                errorData.error || `HTTP ${response.status}`
              );
          }
        }
        
        return response;
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry for certain error types
        if (error instanceof NetworkError) {
          if (
            error.type === NetworkErrorType.INVALID_TOKEN ||
            error.type === NetworkErrorType.USER_REVOKED ||
            error.type === NetworkErrorType.INVALID_SIGNATURE
          ) {
            throw error;
          }
        }
        
        // Check if it's an abort error (timeout)
        if ((error as Error).name === "AbortError") {
          this.logger.warn(`Request timeout, attempt ${attempt + 1}/${attempts}`);
        } else {
          this.logger.warn(`Request failed, attempt ${attempt + 1}/${attempts}:`, error);
        }
        
        // Wait before retrying (exponential backoff)
        if (attempt < attempts - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }
    
    throw new NetworkError(
      NetworkErrorType.NETWORK_ERROR,
      lastError?.message || "Request failed after retries"
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

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

  /**
   * Serialize StoreEntryMetadata for network transmission.
   */
  private serializeEntryMetadata(metadata: StoreEntryMetadata): SerializedEntryMetadata {
    return {
      entryType: metadata.entryType,
      id: metadata.id,
      contentHash: metadata.contentHash,
      docId: metadata.docId,
      dependencyIds: metadata.dependencyIds,
      createdAt: metadata.createdAt,
      createdByPublicKey: metadata.createdByPublicKey,
      decryptionKeyId: metadata.decryptionKeyId,
      signature: this.uint8ArrayToBase64(metadata.signature),
      originalSize: metadata.originalSize,
      encryptedSize: metadata.encryptedSize,
    };
  }

  /**
   * Deserialize StoreEntryMetadata from network format.
   */
  private deserializeEntryMetadata(serialized: SerializedEntryMetadata): StoreEntryMetadata {
    return {
      entryType: serialized.entryType,
      id: serialized.id,
      contentHash: serialized.contentHash,
      docId: serialized.docId,
      dependencyIds: serialized.dependencyIds,
      createdAt: serialized.createdAt,
      createdByPublicKey: serialized.createdByPublicKey,
      decryptionKeyId: serialized.decryptionKeyId,
      signature: this.base64ToUint8Array(serialized.signature),
      originalSize: serialized.originalSize,
      encryptedSize: serialized.encryptedSize,
    };
  }

  /**
   * Serialize StoreEntry for network transmission.
   */
  private serializeEntry(entry: StoreEntry): SerializedEntry {
    return {
      ...this.serializeEntryMetadata(entry),
      encryptedData: this.uint8ArrayToBase64(entry.encryptedData),
    };
  }
}

// Types for serialized network data (Uint8Array converted to base64)
interface SerializedEntryMetadata {
  entryType: StoreEntryType;
  id: string;
  contentHash: string;
  docId: string;
  dependencyIds: string[];
  createdAt: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  signature: string; // base64
  originalSize: number;
  encryptedSize: number;
}

interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string; // base64
}

interface SerializedNetworkEncryptedEntry extends SerializedEntryMetadata {
  rsaEncryptedPayload: string; // base64
}
