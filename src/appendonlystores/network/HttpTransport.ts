import type {
  MindooDBServerInfo,
  StoreEntry,
  StoreEntryMetadata,
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
import { StoreKind } from "../../core/appendonlystores/types";
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
  private static readonly DEFAULT_TIMEOUT_MS = 120_000;
  private config: NetworkTransportConfig;
  private baseUrl: string;
  private logger: Logger;
  private remoteJsonBodyLimitBytesPromise: Promise<number | null> | null = null;
  private _syncAbortSignal?: AbortSignal;

  constructor(config: NetworkTransportConfig, logger?: Logger) {
    this.config = {
      timeout: HttpTransport.DEFAULT_TIMEOUT_MS,
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

  getIdentity(): string {
    return this.baseUrl;
  }

  setSyncAbortSignal(signal?: AbortSignal): void {
    this._syncAbortSignal = signal;
  }

  private getStoreKind(): StoreKind {
    return this.config.storeKind ?? StoreKind.docs;
  }

  private getSyncBasePath(): string {
    return `${this.baseUrl}/sync/${this.getStoreKind()}`;
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
        `${this.getSyncBasePath()}/capabilities${this.config.dbId ? `?dbId=${encodeURIComponent(this.config.dbId)}` : ""}`,
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
        supportsLatestScanCursor: false,
        supportsCompactionStatus: false,
        supportsMaterializationPlanning: false,
        supportsBatchMaterializationPlanning: false,
        supportsAttachmentReadPlanning: false,
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
      `${this.getSyncBasePath()}/findNewEntries`,
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
      `${this.getSyncBasePath()}/findNewEntriesForDoc`,
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
      `${this.getSyncBasePath()}/findEntries`,
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
      `${this.getSyncBasePath()}/scanEntriesSince`,
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
      `${this.getSyncBasePath()}/getIdBloomSummary`,
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
      `${this.getSyncBasePath()}/getCompactionStatus`,
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

  async planDocumentMaterialization(
    token: string,
    docId: string,
    options?: MaterializationPlanOptions
  ): Promise<DocumentMaterializationPlan> {
    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/planDocumentMaterialization`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          docId,
          options,
        }),
      }
    );
    const data = await response.json();
    return data.plan as DocumentMaterializationPlan;
  }

  async planDocumentMaterializationBatch(
    token: string,
    docIds: string[],
    options?: MaterializationPlanOptions
  ): Promise<DocumentMaterializationBatchPlan> {
    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/planDocumentMaterializationBatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          docIds,
          options,
        }),
      }
    );
    const data = await response.json();
    return data.batchPlan as DocumentMaterializationBatchPlan;
  }

  async planAttachmentReadByWalkingMetadata(
    token: string,
    lastChunkId: string,
    attachmentSize: number,
    options: AttachmentReadPlanOptions
  ): Promise<AttachmentReadPlan> {
    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/planAttachmentReadByWalkingMetadata`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          lastChunkId,
          attachmentSize,
          options,
        }),
      }
    );
    const data = await response.json();
    return data.plan as AttachmentReadPlan;
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
      `${this.getSyncBasePath()}/getEntries`,
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

  async getEntryMetadata(
    token: string,
    id: string
  ): Promise<StoreEntryMetadata | null> {
    this.logger.debug(`Getting metadata for entry ${id}`);

    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/getEntryMetadata`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          id,
        }),
      }
    );

    const data = await response.json();
    return data.entry ? this.deserializeEntryMetadata(data.entry as SerializedEntryMetadata) : null;
  }

  /**
   * Push entries to the remote store.
   */
  async putEntries(token: string, entries: StoreEntry[]): Promise<void> {
    this.logger.debug(`Pushing ${entries.length} entries`);
    if (entries.length === 0) {
      return;
    }

    const serializedEntries = entries.map((entry) => this.serializeEntry(entry));
    const maxBodyBytes = await this.getRemoteJsonBodyLimitBytes();
    if (maxBodyBytes) {
      this.logger.debug(`Remote JSON body limit advertised as ${maxBodyBytes} bytes`);
    }
    await this.pushSerializedEntries(token, serializedEntries, maxBodyBytes);

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
      `${this.getSyncBasePath()}/hasEntries`,
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
      `${this.getSyncBasePath()}/getAllIds?tenantId=${encodeURIComponent(this.config.tenantId)}${this.config.dbId ? `&dbId=${encodeURIComponent(this.config.dbId)}` : ""}`,
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
   * Get the latest store scan cursor from the remote store.
   */
  async getLatestScanCursor(token: string): Promise<StoreScanCursor | null> {
    this.logger.debug("Getting latest store scan cursor");

    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/getLatestScanCursor?tenantId=${encodeURIComponent(this.config.tenantId)}${this.config.dbId ? `&dbId=${encodeURIComponent(this.config.dbId)}` : ""}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      }
    );

    const data = await response.json();
    return (data.cursor as StoreScanCursor | null | undefined) ?? null;
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
      `${this.getSyncBasePath()}/resolveDependencies`,
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
    const externalSignal = this._syncAbortSignal;
    
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (externalSignal?.aborted) {
        throw new NetworkError(NetworkErrorType.SERVER_ERROR, "Sync cancelled");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout || HttpTransport.DEFAULT_TIMEOUT_MS
      );

      let onExternalAbort: (() => void) | undefined;
      if (externalSignal && !externalSignal.aborted) {
        onExternalAbort = () => controller.abort();
        externalSignal.addEventListener('abort', onExternalAbort);
      }

      try {
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
            case 413:
              throw new NetworkError(
                NetworkErrorType.PAYLOAD_TOO_LARGE,
                errorData.error || "Request body too large"
              );
            case 429: {
              const retryAfterMs = this.parseRetryAfterMs(response.headers.get("Retry-After"));
              throw new NetworkError(
                NetworkErrorType.RATE_LIMITED,
                errorData.error || "Too many requests",
                retryAfterMs,
              );
            }
            default:
              throw new NetworkError(
                NetworkErrorType.SERVER_ERROR,
                errorData.error || `HTTP ${response.status}`
              );
          }
        }
        
        return response;
      } catch (error) {
        if (externalSignal?.aborted) {
          clearTimeout(timeoutId);
          throw new NetworkError(NetworkErrorType.SERVER_ERROR, "Sync cancelled");
        }

        lastError = error as Error;
        
        // Don't retry for certain error types
        if (error instanceof NetworkError) {
          if (
            error.type === NetworkErrorType.INVALID_TOKEN ||
            error.type === NetworkErrorType.USER_REVOKED ||
            error.type === NetworkErrorType.INVALID_SIGNATURE ||
            error.type === NetworkErrorType.PAYLOAD_TOO_LARGE ||
            error.type === NetworkErrorType.RATE_LIMITED
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
      } finally {
        clearTimeout(timeoutId);
        if (onExternalAbort) {
          externalSignal!.removeEventListener('abort', onExternalAbort);
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

  private parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
    if (!retryAfterHeader) {
      return undefined;
    }
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const dateMs = Date.parse(retryAfterHeader);
    if (Number.isNaN(dateMs)) {
      return undefined;
    }
    return Math.max(0, dateMs - Date.now());
  }

  private async getRemoteJsonBodyLimitBytes(): Promise<number | null> {
    if (!this.remoteJsonBodyLimitBytesPromise) {
      this.remoteJsonBodyLimitBytesPromise = this.fetchRemoteJsonBodyLimitBytes();
    }
    return this.remoteJsonBodyLimitBytesPromise;
  }

  private async fetchRemoteJsonBodyLimitBytes(): Promise<number | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout || HttpTransport.DEFAULT_TIMEOUT_MS,
    );
    try {
      const serverInfoUrl = new URL("/.well-known/mindoodb-server-info", this.baseUrl);
      const response = await fetch(serverInfoUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json() as MindooDBServerInfo;
      if (
        typeof data.maxJsonRequestBodyBytes === "number"
        && Number.isFinite(data.maxJsonRequestBodyBytes)
        && data.maxJsonRequestBodyBytes > 0
      ) {
        return Math.floor(data.maxJsonRequestBodyBytes);
      }
      if (typeof data.maxJsonRequestBodyLimit === "string") {
        return this.parseByteSizeLimit(data.maxJsonRequestBodyLimit);
      }
      return null;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        this.logger.debug("Could not read remote JSON body limit; falling back to adaptive batching.", error);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseByteSizeLimit(limit: string): number | null {
    const normalized = limit.trim().toLowerCase();
    if (/^\d+$/.test(normalized)) {
      return Number(normalized);
    }
    const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/);
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === "b"
      ? 1
      : unit === "kb"
        ? 1024
        : unit === "mb"
          ? 1024 * 1024
          : 1024 * 1024 * 1024;
    return Math.round(value * multiplier);
  }

  private async pushSerializedEntries(
    token: string,
    serializedEntries: SerializedEntry[],
    maxBodyBytes: number | null,
  ): Promise<void> {
    if (serializedEntries.length === 0) {
      return;
    }

    if (maxBodyBytes !== null) {
      const batches = this.partitionSerializedEntriesForMaxBodySize(serializedEntries, maxBodyBytes);
      if (batches.length > 1) {
        this.logger.debug(`Split putEntries payload into ${batches.length} batch(es) for body limit ${maxBodyBytes}`);
      }
      for (const batch of batches) {
        await this.sendSerializedEntriesBatch(token, batch, maxBodyBytes);
      }
      return;
    }

    await this.sendSerializedEntriesBatch(token, serializedEntries, null);
  }

  private async sendSerializedEntriesBatch(
    token: string,
    serializedEntries: SerializedEntry[],
    maxBodyBytes: number | null,
  ): Promise<void> {
    try {
      await this.postSerializedEntries(token, serializedEntries);
    } catch (error) {
      if (
        error instanceof NetworkError
        && error.type === NetworkErrorType.PAYLOAD_TOO_LARGE
        && serializedEntries.length > 1
      ) {
        const midpoint = Math.ceil(serializedEntries.length / 2);
        const left = serializedEntries.slice(0, midpoint);
        const right = serializedEntries.slice(midpoint);
        this.logger.warn(
          `putEntries batch with ${serializedEntries.length} entries exceeded remote limit; retrying as ${left.length} + ${right.length} batches.`,
        );
        await this.pushSerializedEntries(token, left, maxBodyBytes);
        await this.pushSerializedEntries(token, right, maxBodyBytes);
        return;
      }
      throw error;
    }
  }

  private partitionSerializedEntriesForMaxBodySize(
    serializedEntries: SerializedEntry[],
    maxBodyBytes: number,
  ): SerializedEntry[][] {
    const batches: SerializedEntry[][] = [];
    const emptyBodyBytes = this.measureBodyBytes(JSON.stringify({
      tenantId: this.config.tenantId,
      dbId: this.config.dbId,
      entries: [],
    }));

    let currentBatch: SerializedEntry[] = [];
    let currentBodyBytes = emptyBodyBytes;

    for (const entry of serializedEntries) {
      const entryBodyBytes = this.measureBodyBytes(JSON.stringify(entry));
      const separatorBytes = currentBatch.length > 0 ? 1 : 0;
      const nextBodyBytes = currentBodyBytes + separatorBytes + entryBodyBytes;

      if (emptyBodyBytes + entryBodyBytes > maxBodyBytes) {
        throw new NetworkError(
          NetworkErrorType.PAYLOAD_TOO_LARGE,
          `Single entry ${entry.id} exceeds remote request body limit of ${maxBodyBytes} bytes`,
        );
      }

      if (nextBodyBytes > maxBodyBytes) {
        batches.push(currentBatch);
        currentBatch = [entry];
        currentBodyBytes = emptyBodyBytes + entryBodyBytes;
      } else {
        currentBatch.push(entry);
        currentBodyBytes = nextBodyBytes;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private async postSerializedEntries(
    token: string,
    serializedEntries: SerializedEntry[],
  ): Promise<void> {
    await this.fetchWithRetry(
      `${this.getSyncBasePath()}/putEntries`,
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
  }

  private measureBodyBytes(value: string): number {
    return new TextEncoder().encode(value).length;
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
      receiptOrder: metadata.receiptOrder,
      createdByPublicKey: metadata.createdByPublicKey,
      decryptionKeyId: metadata.decryptionKeyId,
      snapshotHeadHashes: metadata.snapshotHeadHashes,
      snapshotHeadEntryIds: metadata.snapshotHeadEntryIds,
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
      receiptOrder: serialized.receiptOrder,
      createdByPublicKey: serialized.createdByPublicKey,
      decryptionKeyId: serialized.decryptionKeyId,
      snapshotHeadHashes: serialized.snapshotHeadHashes,
      snapshotHeadEntryIds: serialized.snapshotHeadEntryIds,
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
  receiptOrder?: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  snapshotHeadHashes?: string[];
  snapshotHeadEntryIds?: string[];
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
