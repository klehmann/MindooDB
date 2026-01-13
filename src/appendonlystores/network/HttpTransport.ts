import type { MindooDocChange, MindooDocChangeHashes } from "../../core/types";
import type { NetworkTransport, NetworkTransportConfig } from "../../core/appendonlystores/network/NetworkTransport";
import type { NetworkEncryptedChange, AuthResult } from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";

/**
 * HTTP implementation of the NetworkTransport interface.
 * 
 * Uses fetch API for making HTTP requests to a remote server.
 * Supports retry with exponential backoff for transient failures.
 * 
 * REST API endpoints:
 * - POST /auth/challenge - Request authentication challenge
 * - POST /auth/authenticate - Authenticate with signed challenge
 * - POST /sync/findNewChanges - Find changes we don't have
 * - POST /sync/getChanges - Get specific changes
 * - POST /sync/pushChanges - Push changes to the server
 * - GET /sync/getAllChangeHashes - Get all change hashes from the server
 */
export class HttpTransport implements NetworkTransport {
  private config: NetworkTransportConfig;
  private baseUrl: string;

  constructor(config: NetworkTransportConfig) {
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
  }

  /**
   * Request a challenge string for authentication.
   */
  async requestChallenge(username: string): Promise<string> {
    console.log(`[HttpTransport] Requesting challenge for user: ${username}`);
    
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
    
    console.log(`[HttpTransport] Received challenge: ${data.challenge}`);
    return data.challenge;
  }

  /**
   * Authenticate by providing a signed challenge.
   */
  async authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    console.log(`[HttpTransport] Authenticating with challenge: ${challenge}`);
    
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
    
    console.log(`[HttpTransport] Authentication result: ${data.success ? "success" : "failed"}`);
    return {
      success: data.success,
      token: data.token,
      error: data.error,
    };
  }

  /**
   * Find changes that the remote has which we don't have locally.
   */
  async findNewChanges(
    token: string,
    haveChangeHashes: string[]
  ): Promise<MindooDocChangeHashes[]> {
    console.log(`[HttpTransport] Finding new changes, have ${haveChangeHashes.length} hashes`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/findNewChanges`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          haveChangeHashes,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the signature Uint8Arrays
    const changes: MindooDocChangeHashes[] = (data.changes || []).map((c: SerializedChangeHashes) => ({
      ...c,
      signature: this.base64ToUint8Array(c.signature),
    }));
    
    console.log(`[HttpTransport] Found ${changes.length} new changes`);
    return changes;
  }

  /**
   * Find changes for a specific document that the remote has which we don't have locally.
   */
  async findNewChangesForDoc(
    token: string,
    haveChangeHashes: string[],
    docId: string
  ): Promise<MindooDocChangeHashes[]> {
    console.log(`[HttpTransport] Finding new changes for doc ${docId}, have ${haveChangeHashes.length} hashes`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/findNewChangesForDoc`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          haveChangeHashes,
          docId,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the signature Uint8Arrays
    const changes: MindooDocChangeHashes[] = (data.changes || []).map((c: SerializedChangeHashes) => ({
      ...c,
      signature: this.base64ToUint8Array(c.signature),
    }));
    
    console.log(`[HttpTransport] Found ${changes.length} new changes for doc ${docId}`);
    return changes;
  }

  /**
   * Get changes from the remote store.
   */
  async getChanges(
    token: string,
    changeHashes: MindooDocChangeHashes[]
  ): Promise<NetworkEncryptedChange[]> {
    console.log(`[HttpTransport] Getting ${changeHashes.length} changes`);
    
    // Serialize the signature Uint8Arrays for transmission
    const serializedHashes = changeHashes.map(c => ({
      ...c,
      signature: this.uint8ArrayToBase64(c.signature),
    }));
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/getChanges`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          changeHashes: serializedHashes,
        }),
      }
    );
    
    const data = await response.json();
    
    // Deserialize the Uint8Arrays
    const changes: NetworkEncryptedChange[] = (data.changes || []).map((c: SerializedEncryptedChange) => ({
      ...c,
      signature: this.base64ToUint8Array(c.signature),
      rsaEncryptedPayload: this.base64ToUint8Array(c.rsaEncryptedPayload),
    }));
    
    console.log(`[HttpTransport] Retrieved ${changes.length} encrypted changes`);
    return changes;
  }

  /**
   * Push changes to the remote store.
   */
  async pushChanges(token: string, changes: MindooDocChange[]): Promise<void> {
    console.log(`[HttpTransport] Pushing ${changes.length} changes`);
    
    // Serialize the Uint8Arrays for transmission
    const serializedChanges = changes.map(c => ({
      ...c,
      signature: this.uint8ArrayToBase64(c.signature),
      payload: this.uint8ArrayToBase64(c.payload),
    }));
    
    await this.fetchWithRetry(
      `${this.baseUrl}/sync/pushChanges`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: this.config.tenantId,
          dbId: this.config.dbId,
          changes: serializedChanges,
        }),
      }
    );
    
    console.log(`[HttpTransport] Successfully pushed ${changes.length} changes`);
  }

  /**
   * Get all change hashes from the remote store.
   */
  async getAllChangeHashes(token: string): Promise<string[]> {
    console.log(`[HttpTransport] Getting all change hashes`);
    
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/sync/getAllChangeHashes?tenantId=${encodeURIComponent(this.config.tenantId)}${this.config.dbId ? `&dbId=${encodeURIComponent(this.config.dbId)}` : ""}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      }
    );
    
    const data = await response.json();
    const hashes: string[] = data.hashes || [];
    
    console.log(`[HttpTransport] Retrieved ${hashes.length} change hashes`);
    return hashes;
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
          console.warn(`[HttpTransport] Request timeout, attempt ${attempt + 1}/${attempts}`);
        } else {
          console.warn(`[HttpTransport] Request failed, attempt ${attempt + 1}/${attempts}:`, error);
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
}

// Types for serialized network data (Uint8Array converted to base64)
interface SerializedChangeHashes {
  type: "create" | "change" | "snapshot" | "delete";
  docId: string;
  changeHash: string;
  depsHashes: string[];
  createdAt: number;
  createdByPublicKey: string;
  decryptionKeyId: string;
  signature: string; // base64
}

interface SerializedChange extends SerializedChangeHashes {
  payload: string; // base64
}

interface SerializedEncryptedChange extends SerializedChangeHashes {
  rsaEncryptedPayload: string; // base64
}
