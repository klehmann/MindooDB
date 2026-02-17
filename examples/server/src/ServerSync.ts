/**
 * ServerSync handles server-to-server synchronization.
 * 
 * This module enables a server to act as a client and sync with remote servers
 * using the same HttpTransport protocol that clients use.
 */

import { HttpTransport } from "mindoodb/appendonlystores/network/HttpTransport";
import { ClientNetworkContentAddressedStore } from "mindoodb/appendonlystores/network/ClientNetworkContentAddressedStore";
import type { ContentAddressedStore, EncryptedPrivateKey } from "mindoodb/core/types";
import type { CryptoAdapter } from "mindoodb/core/crypto/CryptoAdapter";
import type { RemoteServerConfig, ServerKeysConfig } from "./types";

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  success: boolean;
  remoteUrl: string;
  database: string;
  entriesPushed: number;
  entriesPulled: number;
  error?: string;
}

/**
 * ServerSync manages synchronization with remote servers.
 * 
 * It uses the server's identity (from server-keys.json) to authenticate
 * with remote servers and sync content-addressed store entries.
 */
export class ServerSync {
  private cryptoAdapter: CryptoAdapter;
  private tenantId: string;
  private serverKeys: ServerKeysConfig;
  private keyPassword: string;
  private localStoreFactory: (dbId: string) => ContentAddressedStore | Promise<ContentAddressedStore>;
  
  // Cached crypto keys
  private signingKey: CryptoKey | null = null;
  private encryptionKey: CryptoKey | null = null;

  /**
   * Create a new ServerSync instance.
   * 
   * @param cryptoAdapter The crypto adapter for key operations
   * @param tenantId The tenant identifier
   * @param serverKeys The server's key configuration
   * @param keyPassword The password to decrypt server private keys
   * @param localStoreFactory Factory function to get local stores by dbId
   */
  constructor(
    cryptoAdapter: CryptoAdapter,
    tenantId: string,
    serverKeys: ServerKeysConfig,
    keyPassword: string,
    localStoreFactory: (dbId: string) => ContentAddressedStore | Promise<ContentAddressedStore>
  ) {
    this.cryptoAdapter = cryptoAdapter;
    this.tenantId = tenantId;
    this.serverKeys = serverKeys;
    this.keyPassword = keyPassword;
    this.localStoreFactory = localStoreFactory;
  }

  /**
   * Sync with a single remote server.
   * 
   * @param remoteConfig The remote server configuration
   * @param databases Optional list of databases to sync (default: sync all)
   * @returns Results for each database synced
   */
  async syncWithRemote(
    remoteConfig: RemoteServerConfig,
    databases?: string[]
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const dbsToSync = databases || remoteConfig.databases || ["directory"];

    console.log(`[ServerSync] Starting sync with ${remoteConfig.url} for tenant ${this.tenantId}`);

    // Ensure keys are loaded
    await this.ensureKeysLoaded();

    for (const dbId of dbsToSync) {
      try {
        const result = await this.syncDatabase(remoteConfig, dbId);
        results.push(result);
      } catch (error) {
        console.error(`[ServerSync] Error syncing ${dbId} with ${remoteConfig.url}:`, error);
        results.push({
          success: false,
          remoteUrl: remoteConfig.url,
          database: dbId,
          entriesPushed: 0,
          entriesPulled: 0,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return results;
  }

  /**
   * Sync all configured remote servers.
   * 
   * @param remoteServers List of remote server configurations
   * @returns Results for all syncs
   */
  async syncAllRemotes(remoteServers: RemoteServerConfig[]): Promise<SyncResult[]> {
    const allResults: SyncResult[] = [];

    for (const remoteConfig of remoteServers) {
      const results = await this.syncWithRemote(remoteConfig);
      allResults.push(...results);
    }

    return allResults;
  }

  /**
   * Sync a single database with a remote server.
   */
  private async syncDatabase(
    remoteConfig: RemoteServerConfig,
    dbId: string
  ): Promise<SyncResult> {
    console.log(`[ServerSync] Syncing database ${dbId} with ${remoteConfig.url}`);

    // Create transport for this remote
    const transport = new HttpTransport({
      baseUrl: remoteConfig.url,
      tenantId: this.tenantId,
      dbId: dbId,
    });

    // Create client store for the remote
    const remoteStore = new ClientNetworkContentAddressedStore(
      dbId,
      transport,
      this.cryptoAdapter,
      remoteConfig.username,
      this.signingKey!,
      this.encryptionKey!
    );

    // Get local store
    const localStore = await this.localStoreFactory(dbId);

    // Pull from remote (get entries we don't have)
    const localIds = await localStore.getAllIds();
    const newFromRemote = await remoteStore.findNewEntries(localIds);
    
    let entriesPulled = 0;
    if (newFromRemote.length > 0) {
      const newEntryIds = newFromRemote.map(e => e.id);
      const entries = await remoteStore.getEntries(newEntryIds);
      await localStore.putEntries(entries);
      entriesPulled = entries.length;
      console.log(`[ServerSync] Pulled ${entriesPulled} entries from remote for ${dbId}`);
    }

    // Push to remote (send entries they don't have)
    const remoteIds = await remoteStore.getAllIds();
    const newForRemote = await localStore.findNewEntries(remoteIds);
    
    let entriesPushed = 0;
    if (newForRemote.length > 0) {
      const entryIds = newForRemote.map(e => e.id);
      const entries = await localStore.getEntries(entryIds);
      await remoteStore.putEntries(entries);
      entriesPushed = entries.length;
      console.log(`[ServerSync] Pushed ${entriesPushed} entries to remote for ${dbId}`);
    }

    return {
      success: true,
      remoteUrl: remoteConfig.url,
      database: dbId,
      entriesPushed,
      entriesPulled,
    };
  }

  /**
   * Ensure the server's crypto keys are loaded and decrypted.
   */
  private async ensureKeysLoaded(): Promise<void> {
    if (this.signingKey && this.encryptionKey) {
      return;
    }

    console.log(`[ServerSync] Loading server keys for ${this.serverKeys.username}`);

    // Import the signing key
    this.signingKey = await this.decryptAndImportSigningKey(
      this.serverKeys.signingPrivateKey,
      this.keyPassword
    );

    // Import the encryption key
    this.encryptionKey = await this.decryptAndImportEncryptionKey(
      this.serverKeys.encryptionPrivateKey,
      this.keyPassword
    );

    console.log(`[ServerSync] Server keys loaded successfully`);
  }

  /**
   * Decrypt and import an Ed25519 signing key.
   */
  private async decryptAndImportSigningKey(
    encryptedKey: EncryptedPrivateKey,
    password: string
  ): Promise<CryptoKey> {
    const subtle = this.cryptoAdapter.getSubtle();

    // Derive the decryption key from password
    const salt = this.base64ToUint8Array(encryptedKey.salt);
    const keyMaterial = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    const decryptionKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: encryptedKey.iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    // Decrypt the private key
    const iv = this.base64ToUint8Array(encryptedKey.iv);
    const ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
    const tag = this.base64ToUint8Array(encryptedKey.tag);

    // Combine ciphertext and tag for AES-GCM
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);

    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      decryptionKey,
      combined
    );

    // Import as Ed25519 private key
    const signingKey = await subtle.importKey(
      "pkcs8",
      decrypted,
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    return signingKey;
  }

  /**
   * Decrypt and import an RSA-OAEP encryption key.
   */
  private async decryptAndImportEncryptionKey(
    encryptedKey: EncryptedPrivateKey,
    password: string
  ): Promise<CryptoKey> {
    const subtle = this.cryptoAdapter.getSubtle();

    // Derive the decryption key from password
    const salt = this.base64ToUint8Array(encryptedKey.salt);
    const keyMaterial = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    const decryptionKey = await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: encryptedKey.iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    // Decrypt the private key
    const iv = this.base64ToUint8Array(encryptedKey.iv);
    const ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
    const tag = this.base64ToUint8Array(encryptedKey.tag);

    // Combine ciphertext and tag for AES-GCM
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);

    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      decryptionKey,
      combined
    );

    // Import as RSA-OAEP private key
    const encryptionKey = await subtle.importKey(
      "pkcs8",
      decrypted,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"]
    );

    return encryptionKey;
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = Buffer.from(base64, "base64");
    return new Uint8Array(binary);
  }
}

/**
 * Start a periodic sync with remote servers.
 * 
 * @param serverSync The ServerSync instance
 * @param remoteServers List of remote server configurations
 * @param defaultIntervalMs Default sync interval if not specified per-server
 * @returns A function to stop the periodic sync
 */
export function startPeriodicSync(
  serverSync: ServerSync,
  remoteServers: RemoteServerConfig[],
  defaultIntervalMs: number = 60000
): () => void {
  const timers: NodeJS.Timeout[] = [];

  for (const remoteConfig of remoteServers) {
    const interval = remoteConfig.syncIntervalMs || defaultIntervalMs;

    const timer = setInterval(async () => {
      try {
        const results = await serverSync.syncWithRemote(remoteConfig);
        for (const result of results) {
          if (result.success) {
            console.log(
              `[PeriodicSync] Synced ${result.database} with ${result.remoteUrl}: ` +
              `pushed ${result.entriesPushed}, pulled ${result.entriesPulled}`
            );
          } else {
            console.error(
              `[PeriodicSync] Failed to sync ${result.database} with ${result.remoteUrl}: ${result.error}`
            );
          }
        }
      } catch (error) {
        console.error(`[PeriodicSync] Error syncing with ${remoteConfig.url}:`, error);
      }
    }, interval);

    timers.push(timer);
    console.log(`[PeriodicSync] Started sync with ${remoteConfig.url} every ${interval}ms`);
  }

  // Return stop function
  return () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
    console.log(`[PeriodicSync] Stopped all periodic syncs`);
  };
}
