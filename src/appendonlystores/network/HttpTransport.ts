import type {
  MindooDBServerInfo,
  StoreEntry,
  StoreEntryMetadata,
  StoreEntryAttachmentRef,
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
  PutEntriesAck,
  RejectedPutEntry,
  StoreHead,
} from "../../core/appendonlystores/types";
import { StoreKind } from "../../core/appendonlystores/types";
import type { NetworkTransport, NetworkTransportConfig } from "../../core/appendonlystores/network/NetworkTransport";
import type {
  NetworkEncryptedEntry,
  NetworkSessionEncryptedEntry,
  SessionEncryptedEntriesBatch,
  StoreChangeEvent,
  AuthResult,
  NetworkSyncCapabilities,
} from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";
import {
  BINARY_ENTRIES_CONTENT_TYPE,
  BINARY_GET_ENTRIES_FORMAT,
  BINARY_PUT_ENTRIES_FORMAT,
  decodeBinaryEntryMessage,
  encodeBinaryEntryMessage,
  measureBinaryEntryMessage,
  type BinaryEntryFrame,
} from "../../core/appendonlystores/network/binaryEntryFraming";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";
import { isSameOrigin } from "../../core/utils/urlSafety";

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
  async requestChallenge(
    username?: string,
    options?: { signingPublicKey?: string },
  ): Promise<string> {
    this.logger.debug(`Requesting challenge${username ? ` for user: ${username}` : " by signing key"}`);

    const body: { username?: string; signingPublicKey?: string } = {};
    if (username) body.username = username;
    if (options?.signingPublicKey) body.signingPublicKey = options.signingPublicKey;

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/auth/challenge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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

    let response: Response;
    try {
      response = await this.fetchWithRetry(
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
    } catch (error) {
      // The server now returns HTTP 401 on a failed credential check (audit,
      // Low). `fetchWithRetry` surfaces that as a (non-retried) INVALID_TOKEN /
      // USER_REVOKED NetworkError; map it back to a structured AuthResult so the
      // caller's existing `result.success` handling keeps working.
      if (
        error instanceof NetworkError &&
        (error.type === NetworkErrorType.INVALID_TOKEN ||
          error.type === NetworkErrorType.USER_REVOKED)
      ) {
        this.logger.debug(`Authentication result: failed (${error.type})`);
        return { success: false, error: error.message };
      }
      throw error;
    }

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
   * Get the remote store head (`{ epoch, maxReceiptOrder }`) for
   * persisted-cursor sync (sync-v5, phase 1).
   */
  async getStoreHead(token: string): Promise<StoreHead> {
    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/getStoreHead`,
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
    return data.head as StoreHead;
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

  /**
   * Get entries in the session-key transport format (sync-v5, phase 2):
   * one RSA-wrapped AES-256-GCM session key per response, per-entry AES-GCM
   * payloads. Gated by the `supportsSessionKeyWrap` capability; the server
   * switches formats on the `sessionKeyWrap` request flag.
   */
  async getEntriesSessionWrapped(
    token: string,
    ids: string[]
  ): Promise<SessionEncryptedEntriesBatch> {
    this.logger.debug(`Getting ${ids.length} entries (session-key format)`);

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
          sessionKeyWrap: true,
        }),
      }
    );

    const data = await response.json();
    if (typeof data.wrappedSessionKey !== "string") {
      throw new NetworkError(
        NetworkErrorType.SERVER_ERROR,
        "Server did not return a session-key-wrapped getEntries response",
      );
    }

    const entries: NetworkSessionEncryptedEntry[] = (data.entries || []).map(
      (e: SerializedSessionEncryptedEntry) => ({
        ...this.deserializeEntryMetadata(e),
        iv: this.base64ToUint8Array(e.iv),
        sessionEncryptedPayload: this.base64ToUint8Array(e.sessionEncryptedPayload),
      })
    );

    this.logger.debug(`Retrieved ${entries.length} session-encrypted entries`);
    return {
      wrappedSessionKey: this.base64ToUint8Array(data.wrappedSessionKey),
      entries,
    };
  }

  /**
   * Get entries via the binary wire format v2 (sync-v5, phase 3): same
   * session-key encryption as getEntriesSessionWrapped, but the response is
   * length-prefixed octet-stream framing — no base64, no large-JSON parse.
   * Gated by the `supportsBinaryEntries` capability.
   */
  async getEntriesBinary(
    token: string,
    ids: string[]
  ): Promise<SessionEncryptedEntriesBatch> {
    this.logger.debug(`Getting ${ids.length} entries (binary v2 format)`);

    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/getEntriesBinary`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": BINARY_ENTRIES_CONTENT_TYPE,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          ids,
        }),
      }
    );

    const body = new Uint8Array(await response.arrayBuffer());
    const message = decodeBinaryEntryMessage(body);
    if (message.header.format !== BINARY_GET_ENTRIES_FORMAT) {
      throw new NetworkError(
        NetworkErrorType.SERVER_ERROR,
        `Server returned an unsupported binary entry format: ${String(message.header.format)}`,
      );
    }
    if (typeof message.header.wrappedSessionKey !== "string") {
      throw new NetworkError(
        NetworkErrorType.SERVER_ERROR,
        "Binary getEntries response is missing the wrapped session key",
      );
    }

    const entries: NetworkSessionEncryptedEntry[] = message.entries.map((frame) => {
      const meta = frame.meta as unknown as SerializedEntryMetadata & { iv: string };
      return {
        ...this.deserializeEntryMetadata(meta),
        iv: this.base64ToUint8Array(meta.iv),
        sessionEncryptedPayload: frame.payload,
      };
    });

    this.logger.debug(`Retrieved ${entries.length} session-encrypted entries (binary)`);
    return {
      wrappedSessionKey: this.base64ToUint8Array(message.header.wrappedSessionKey),
      entries,
    };
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
  async putEntries(token: string, entries: StoreEntry[]): Promise<PutEntriesAck> {
    this.logger.debug(`Pushing ${entries.length} entries`);
    if (entries.length === 0) {
      return { receipts: [], rejected: [] };
    }

    const serializedEntries = entries.map((entry) => this.serializeEntry(entry));
    const maxBodyBytes = await this.getRemoteJsonBodyLimitBytes();
    if (maxBodyBytes) {
      this.logger.debug(`Remote JSON body limit advertised as ${maxBodyBytes} bytes`);
    }
    const ack = await this.pushSerializedEntries(token, serializedEntries, maxBodyBytes);

    this.logger.debug(
      `Successfully pushed ${entries.length} entries (${ack.receipts.length} receipts, ${ack.rejected.length} rejected)`,
    );
    return ack;
  }

  /**
   * Push entries via the binary wire format v2 (sync-v5, phase 3): identical
   * semantics to putEntries (same witness receipts and per-entry rejections),
   * but the request body is length-prefixed octet-stream framing instead of
   * JSON+base64. Gated by the `supportsBinaryEntries` capability.
   */
  async putEntriesBinary(token: string, entries: StoreEntry[]): Promise<PutEntriesAck> {
    this.logger.debug(`Pushing ${entries.length} entries (binary v2 format)`);
    if (entries.length === 0) {
      return { receipts: [], rejected: [] };
    }

    const frames: BinaryEntryFrame[] = entries.map((entry) => ({
      meta: this.serializeEntryMetadata(entry) as unknown as Record<string, unknown>,
      payload: entry.encryptedData,
    }));
    const maxBodyBytes = await this.getRemoteJsonBodyLimitBytes();
    const ack = await this.pushBinaryFrames(token, frames, maxBodyBytes);

    this.logger.debug(
      `Successfully pushed ${entries.length} entries (${ack.receipts.length} receipts, ${ack.rejected.length} rejected, binary)`,
    );
    return ack;
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
   * Open the server's SSE live change feed (sync-v5, phase 5) via a
   * fetch-streaming reader — native `EventSource` cannot send the
   * `Authorization` header, so we parse the `text/event-stream` body
   * ourselves. The promise stays pending while the stream is open and
   * settles when it ends (resolves on orderly close or abort).
   */
  async subscribeToChanges(
    token: string,
    onEvent: (event: StoreChangeEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const dbId = this.config.dbId ?? "directory";
    const url = `${this.getSyncBasePath()}/events?dbId=${encodeURIComponent(dbId)}`;
    this.logger.debug(`Subscribing to change events at ${url}`);

    const response = await this.safeFetch(url, {
      method: "GET",
      headers: {
        "Accept": "text/event-stream",
        "Authorization": `Bearer ${token}`,
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        throw new NetworkError(NetworkErrorType.INVALID_TOKEN, errorData.error || "Unauthorized");
      }
      if (response.status === 403) {
        throw new NetworkError(NetworkErrorType.USER_REVOKED, errorData.error || "Access denied");
      }
      throw new NetworkError(
        NetworkErrorType.SERVER_ERROR,
        errorData.error || `Change feed returned HTTP ${response.status}`,
      );
    }
    if (!response.body) {
      // Environments without fetch response streaming (e.g. React Native)
      // cannot consume SSE; callers should treat this as "not supported".
      throw new NetworkError(
        NetworkErrorType.SERVER_ERROR,
        "Change feed requires fetch response streaming, which this environment does not support",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });

        // SSE messages are separated by a blank line.
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf("\n\n")) >= 0) {
          const rawMessage = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          this.dispatchSseMessage(rawMessage, onEvent);
        }
      }
    } catch (error) {
      if (options?.signal?.aborted) {
        return;
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /** Parse one raw SSE message block and forward `change` events. */
  private dispatchSseMessage(
    rawMessage: string,
    onEvent: (event: StoreChangeEvent) => void,
  ): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawMessage.split("\n")) {
      if (line.startsWith(":")) {
        continue; // heartbeat / comment
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (eventName !== "change" || dataLines.length === 0) {
      return;
    }
    try {
      const payload = JSON.parse(dataLines.join("\n")) as StoreChangeEvent;
      if (payload && typeof payload.dbId === "string") {
        onEvent(payload);
      }
    } catch (error) {
      this.logger.warn("Ignoring malformed change event payload", error);
    }
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
        const response = await this.safeFetch(url, {
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

  private static readonly MAX_REDIRECTS = 3;

  /**
   * `fetch` with manual redirect handling to mitigate redirect-based SSRF
   * (audit, Medium): a malicious or compromised remote could answer a
   * server-initiated request with a 3xx pointing at an internal address. We
   * disable automatic following (`redirect: "manual"`) and only follow a
   * redirect when it stays on the SAME origin as the original request; any
   * cross-origin redirect is rejected. Capped at {@link MAX_REDIRECTS} hops.
   */
  private async safeFetch(url: string, init: RequestInit): Promise<Response> {
    let currentUrl = url;
    for (let hop = 0; hop <= HttpTransport.MAX_REDIRECTS; hop++) {
      const response = await fetch(currentUrl, { ...init, redirect: "manual" });

      const isRedirect =
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400);
      if (!isRedirect) {
        return response;
      }

      // Browsers return an opaque redirect with no readable Location; we cannot
      // validate the target, so refuse to follow it.
      const location = response.headers.get("location");
      if (!location) {
        throw new NetworkError(
          NetworkErrorType.NETWORK_ERROR,
          "Server returned a redirect that cannot be safely followed",
        );
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new NetworkError(
          NetworkErrorType.NETWORK_ERROR,
          `Server returned an invalid redirect target: ${location}`,
        );
      }

      if (!isSameOrigin(nextUrl, new URL(currentUrl))) {
        throw new NetworkError(
          NetworkErrorType.NETWORK_ERROR,
          `Refusing to follow cross-origin redirect to ${nextUrl.origin}`,
        );
      }
      currentUrl = nextUrl.toString();
    }
    throw new NetworkError(
      NetworkErrorType.NETWORK_ERROR,
      `Too many redirects (>${HttpTransport.MAX_REDIRECTS})`,
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
      const response = await this.safeFetch(serverInfoUrl.toString(), {
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

  /** Merge putEntries batch acks (receipts and rejections concatenate). */
  private static mergePutAcks(acks: PutEntriesAck[]): PutEntriesAck {
    return {
      receipts: acks.flatMap((ack) => ack.receipts),
      rejected: acks.flatMap((ack) => ack.rejected),
    };
  }

  private async pushSerializedEntries(
    token: string,
    serializedEntries: SerializedEntry[],
    maxBodyBytes: number | null,
  ): Promise<PutEntriesAck> {
    if (serializedEntries.length === 0) {
      return { receipts: [], rejected: [] };
    }

    if (maxBodyBytes !== null) {
      const batches = this.partitionSerializedEntriesForMaxBodySize(serializedEntries, maxBodyBytes);
      if (batches.length > 1) {
        this.logger.debug(`Split putEntries payload into ${batches.length} batch(es) for body limit ${maxBodyBytes}`);
      }
      const acks: PutEntriesAck[] = [];
      for (const batch of batches) {
        acks.push(await this.sendSerializedEntriesBatch(token, batch, maxBodyBytes));
      }
      return HttpTransport.mergePutAcks(acks);
    }

    return this.sendSerializedEntriesBatch(token, serializedEntries, null);
  }

  private async sendSerializedEntriesBatch(
    token: string,
    serializedEntries: SerializedEntry[],
    maxBodyBytes: number | null,
  ): Promise<PutEntriesAck> {
    try {
      return await this.postSerializedEntries(token, serializedEntries);
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
        const leftAck = await this.pushSerializedEntries(token, left, maxBodyBytes);
        const rightAck = await this.pushSerializedEntries(token, right, maxBodyBytes);
        return HttpTransport.mergePutAcks([leftAck, rightAck]);
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

  /** Message header for binary putEntries bodies (dbId travels here — no JSON body). */
  private binaryPutHeader(): Record<string, unknown> {
    return {
      format: BINARY_PUT_ENTRIES_FORMAT,
      tenantId: this.config.tenantId,
      dbId: this.config.dbId,
    };
  }

  private async pushBinaryFrames(
    token: string,
    frames: BinaryEntryFrame[],
    maxBodyBytes: number | null,
  ): Promise<PutEntriesAck> {
    if (frames.length === 0) {
      return { receipts: [], rejected: [] };
    }

    if (maxBodyBytes !== null) {
      const batches = this.partitionBinaryFramesForMaxBodySize(frames, maxBodyBytes);
      if (batches.length > 1) {
        this.logger.debug(`Split binary putEntries payload into ${batches.length} batch(es) for body limit ${maxBodyBytes}`);
      }
      const acks: PutEntriesAck[] = [];
      for (const batch of batches) {
        acks.push(await this.sendBinaryFramesBatch(token, batch, maxBodyBytes));
      }
      return HttpTransport.mergePutAcks(acks);
    }

    return this.sendBinaryFramesBatch(token, frames, null);
  }

  private async sendBinaryFramesBatch(
    token: string,
    frames: BinaryEntryFrame[],
    maxBodyBytes: number | null,
  ): Promise<PutEntriesAck> {
    try {
      return await this.postBinaryFrames(token, frames);
    } catch (error) {
      if (
        error instanceof NetworkError
        && error.type === NetworkErrorType.PAYLOAD_TOO_LARGE
        && frames.length > 1
      ) {
        const midpoint = Math.ceil(frames.length / 2);
        const left = frames.slice(0, midpoint);
        const right = frames.slice(midpoint);
        this.logger.warn(
          `Binary putEntries batch with ${frames.length} entries exceeded remote limit; retrying as ${left.length} + ${right.length} batches.`,
        );
        const leftAck = await this.pushBinaryFrames(token, left, maxBodyBytes);
        const rightAck = await this.pushBinaryFrames(token, right, maxBodyBytes);
        return HttpTransport.mergePutAcks([leftAck, rightAck]);
      }
      throw error;
    }
  }

  private partitionBinaryFramesForMaxBodySize(
    frames: BinaryEntryFrame[],
    maxBodyBytes: number,
  ): BinaryEntryFrame[][] {
    const header = this.binaryPutHeader();
    const emptyBodyBytes = measureBinaryEntryMessage(header, []);

    const batches: BinaryEntryFrame[][] = [];
    let currentBatch: BinaryEntryFrame[] = [];
    let currentBodyBytes = emptyBodyBytes;

    for (const frame of frames) {
      const frameBytes = measureBinaryEntryMessage(header, [frame]) - emptyBodyBytes;

      if (emptyBodyBytes + frameBytes > maxBodyBytes) {
        throw new NetworkError(
          NetworkErrorType.PAYLOAD_TOO_LARGE,
          `Single entry ${String(frame.meta.id)} exceeds remote request body limit of ${maxBodyBytes} bytes`,
        );
      }

      if (currentBodyBytes + frameBytes > maxBodyBytes) {
        batches.push(currentBatch);
        currentBatch = [frame];
        currentBodyBytes = emptyBodyBytes + frameBytes;
      } else {
        currentBatch.push(frame);
        currentBodyBytes += frameBytes;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private async postBinaryFrames(
    token: string,
    frames: BinaryEntryFrame[],
  ): Promise<PutEntriesAck> {
    const body = encodeBinaryEntryMessage({
      header: this.binaryPutHeader(),
      entries: frames,
    });

    const response = await this.fetchWithRetry(
      `${this.getSyncBasePath()}/putEntriesBinary`,
      {
        method: "POST",
        headers: {
          "Content-Type": BINARY_ENTRIES_CONTENT_TYPE,
          "Authorization": `Bearer ${token}`,
        },
        // encodeBinaryEntryMessage returns a freshly allocated, exact-size
        // Uint8Array, so its backing buffer can be handed to fetch directly.
        body: body.buffer as ArrayBuffer,
      }
    );

    // Same JSON receipts/rejections contract as the legacy putEntries endpoint.
    try {
      const data = await response.json();
      return this.parsePutEntriesAck(data);
    } catch (error) {
      this.logger.warn("Could not parse binary putEntries receipts; continuing without them.", error);
      return { receipts: [], rejected: [] };
    }
  }

  /**
   * Parse the JSON body of a putEntries/putEntriesBinary response into a
   * {@link PutEntriesAck}. Older servers omit `receipts` and/or `rejected`.
   */
  private parsePutEntriesAck(data: unknown): PutEntriesAck {
    const body = (data ?? {}) as {
      receipts?: SerializedEntryMetadata[];
      rejected?: unknown;
    };
    const receipts = (body.receipts ?? []).map((e) => this.deserializeEntryMetadata(e));
    const rejected: RejectedPutEntry[] = Array.isArray(body.rejected)
      ? (body.rejected as Array<{ id?: unknown; reason?: unknown }>)
          .filter((r) => typeof r?.id === "string")
          .map((r) => ({
            id: r.id as string,
            reason: typeof r.reason === "string" ? r.reason : "rejected by remote",
          }))
      : [];
    return { receipts, rejected };
  }

  private async postSerializedEntries(
    token: string,
    serializedEntries: SerializedEntry[],
  ): Promise<PutEntriesAck> {
    const response = await this.fetchWithRetry(
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

    // The server returns witness receipts (stamped metadata) for accepted
    // entries (docs/accesscontrol.md §5.3) and per-entry rejections for
    // signature-class failures. Older servers omit both fields.
    try {
      const data = await response.json();
      return this.parsePutEntriesAck(data);
    } catch {
      // Non-JSON / empty body from a legacy server: no receipts to apply.
      return { receipts: [], rejected: [] };
    }
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
      metadataSignature: metadata.metadataSignature
        ? this.uint8ArrayToBase64(metadata.metadataSignature)
        : undefined,
      originalSize: metadata.originalSize,
      encryptedSize: metadata.encryptedSize,
      receivedAt: metadata.receivedAt,
      receivedByPublicKey: metadata.receivedByPublicKey,
      receivedDateSignature: metadata.receivedDateSignature
        ? this.uint8ArrayToBase64(metadata.receivedDateSignature)
        : undefined,
      // Signed attachment snapshot (plain JSON, no binary). Must survive the
      // round-trip or metadataSignature verification fails on the receiver.
      attachmentRefs: metadata.attachmentRefs,
      entryVersion: metadata.entryVersion,
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
      metadataSignature: serialized.metadataSignature
        ? this.base64ToUint8Array(serialized.metadataSignature)
        : undefined,
      originalSize: serialized.originalSize,
      encryptedSize: serialized.encryptedSize,
      receivedAt: serialized.receivedAt,
      receivedByPublicKey: serialized.receivedByPublicKey,
      receivedDateSignature: serialized.receivedDateSignature
        ? this.base64ToUint8Array(serialized.receivedDateSignature)
        : undefined,
      attachmentRefs: serialized.attachmentRefs,
      entryVersion: serialized.entryVersion,
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
  metadataSignature?: string; // base64 (author metadata-binding signature)
  originalSize: number;
  encryptedSize: number;
  // Access-control witness receipt (docs/accesscontrol.md §5).
  receivedAt?: number;
  receivedByPublicKey?: string;
  receivedDateSignature?: string; // base64
  // Signed attachment snapshot (plain JSON; see StoreEntryMetadata.attachmentRefs).
  attachmentRefs?: StoreEntryAttachmentRef[];
  // Writer-era version discriminator (see StoreEntryMetadata.entryVersion).
  entryVersion?: number;
}

interface SerializedEntry extends SerializedEntryMetadata {
  encryptedData: string; // base64
}

interface SerializedNetworkEncryptedEntry extends SerializedEntryMetadata {
  rsaEncryptedPayload: string; // base64
}

interface SerializedSessionEncryptedEntry extends SerializedEntryMetadata {
  iv: string; // base64
  sessionEncryptedPayload: string; // base64
}
