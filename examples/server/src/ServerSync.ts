/**
 * ServerSync handles server-to-server synchronization.
 *
 * Uses the global server identity (PrivateUserId) to authenticate with
 * remote servers via the same HttpTransport protocol that clients use.
 */

import { HttpTransport } from "mindoodb/appendonlystores/network/HttpTransport";
import { ClientNetworkContentAddressedStore } from "mindoodb/appendonlystores/network/ClientNetworkContentAddressedStore";
import type { ContentAddressedStore, EncryptedPrivateKey } from "mindoodb/core/types";
import type { CryptoAdapter } from "mindoodb/core/crypto/CryptoAdapter";
import type { PrivateUserId } from "mindoodb/core/userid";
import type { RemoteServerConfig } from "./types";

export interface SyncResult {
  success: boolean;
  remoteUrl: string;
  database: string;
  entriesPushed: number;
  entriesPulled: number;
  error?: string;
}

/**
 * ServerSync manages synchronization with remote servers using the
 * global server identity for authentication.
 */
export class ServerSync {
  private cryptoAdapter: CryptoAdapter;
  private tenantId: string;
  private serverIdentity: PrivateUserId;
  private keyPassword: string;
  private localStoreFactory: (dbId: string) => ContentAddressedStore | Promise<ContentAddressedStore>;

  private signingKey: CryptoKey | null = null;
  private encryptionKey: CryptoKey | null = null;

  constructor(
    cryptoAdapter: CryptoAdapter,
    tenantId: string,
    serverIdentity: PrivateUserId,
    keyPassword: string,
    localStoreFactory: (dbId: string) => ContentAddressedStore | Promise<ContentAddressedStore>,
  ) {
    this.cryptoAdapter = cryptoAdapter;
    this.tenantId = tenantId;
    this.serverIdentity = serverIdentity;
    this.keyPassword = keyPassword;
    this.localStoreFactory = localStoreFactory;
  }

  async syncWithRemote(
    remoteConfig: RemoteServerConfig,
    databases?: string[],
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const dbsToSync = databases || remoteConfig.databases || ["directory"];

    console.log(`[ServerSync] Starting sync with ${remoteConfig.url} for tenant ${this.tenantId}`);

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

  async syncAllRemotes(remoteServers: RemoteServerConfig[]): Promise<SyncResult[]> {
    const allResults: SyncResult[] = [];

    for (const remoteConfig of remoteServers) {
      const results = await this.syncWithRemote(remoteConfig);
      allResults.push(...results);
    }

    return allResults;
  }

  private async syncDatabase(
    remoteConfig: RemoteServerConfig,
    dbId: string,
  ): Promise<SyncResult> {
    console.log(`[ServerSync] Syncing database ${dbId} with ${remoteConfig.url}`);

    const transport = new HttpTransport({
      baseUrl: remoteConfig.url,
      tenantId: this.tenantId,
      dbId: dbId,
    });

    const remoteStore = new ClientNetworkContentAddressedStore(
      dbId,
      transport,
      this.cryptoAdapter,
      this.serverIdentity.username,
      this.signingKey!,
      this.encryptionKey!,
    );

    const localStore = await this.localStoreFactory(dbId);

    // Pull from remote
    const localIds = await localStore.getAllIds();
    const newFromRemote = await remoteStore.findNewEntries(localIds);

    let entriesPulled = 0;
    if (newFromRemote.length > 0) {
      const newEntryIds = newFromRemote.map((e) => e.id);
      const entries = await remoteStore.getEntries(newEntryIds);
      await localStore.putEntries(entries);
      entriesPulled = entries.length;
      console.log(`[ServerSync] Pulled ${entriesPulled} entries from remote for ${dbId}`);
    }

    // Push to remote
    const remoteIds = await remoteStore.getAllIds();
    const newForRemote = await localStore.findNewEntries(remoteIds);

    let entriesPushed = 0;
    if (newForRemote.length > 0) {
      const entryIds = newForRemote.map((e) => e.id);
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

  private async ensureKeysLoaded(): Promise<void> {
    if (this.signingKey && this.encryptionKey) {
      return;
    }

    console.log(`[ServerSync] Loading server keys for ${this.serverIdentity.username}`);

    this.signingKey = await this.decryptAndImportSigningKey(
      this.serverIdentity.userSigningKeyPair.privateKey as unknown as EncryptedPrivateKey,
      this.keyPassword,
    );

    this.encryptionKey = await this.decryptAndImportEncryptionKey(
      this.serverIdentity.userEncryptionKeyPair.privateKey as unknown as EncryptedPrivateKey,
      this.keyPassword,
    );

    console.log(`[ServerSync] Server keys loaded successfully`);
  }

  private async decryptAndImportSigningKey(
    encryptedKey: EncryptedPrivateKey,
    password: string,
  ): Promise<CryptoKey> {
    const subtle = this.cryptoAdapter.getSubtle();

    const salt = this.base64ToUint8Array(encryptedKey.salt);
    const keyMaterial = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"],
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
      ["decrypt"],
    );

    const iv = this.base64ToUint8Array(encryptedKey.iv);
    const ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
    const tag = this.base64ToUint8Array(encryptedKey.tag);

    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);

    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      decryptionKey,
      combined,
    );

    const signingKey = await subtle.importKey(
      "pkcs8",
      decrypted,
      { name: "Ed25519" },
      false,
      ["sign"],
    );

    return signingKey;
  }

  private async decryptAndImportEncryptionKey(
    encryptedKey: EncryptedPrivateKey,
    password: string,
  ): Promise<CryptoKey> {
    const subtle = this.cryptoAdapter.getSubtle();

    const salt = this.base64ToUint8Array(encryptedKey.salt);
    const keyMaterial = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"],
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
      ["decrypt"],
    );

    const iv = this.base64ToUint8Array(encryptedKey.iv);
    const ciphertext = this.base64ToUint8Array(encryptedKey.ciphertext);
    const tag = this.base64ToUint8Array(encryptedKey.tag);

    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);

    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      decryptionKey,
      combined,
    );

    const encryptionKey = await subtle.importKey(
      "pkcs8",
      decrypted,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );

    return encryptionKey;
  }

  private base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const buf = Buffer.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

export function startPeriodicSync(
  serverSync: ServerSync,
  remoteServers: RemoteServerConfig[],
  defaultIntervalMs: number = 60000,
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
              `pushed ${result.entriesPushed}, pulled ${result.entriesPulled}`,
            );
          } else {
            console.error(
              `[PeriodicSync] Failed to sync ${result.database} with ${result.remoteUrl}: ${result.error}`,
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

  return () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
    console.log(`[PeriodicSync] Stopped all periodic syncs`);
  };
}
