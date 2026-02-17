/**
 * Factory for creating content-addressed stores based on configuration.
 */

import { InMemoryContentAddressedStore } from "mindoodb/core/appendonlystores/InMemoryContentAddressedStore";
import { BasicOnDiskContentAddressedStore } from "mindoodb/node/appendonlystores/BasicOnDiskContentAddressedStore";
import type { ContentAddressedStore } from "mindoodb/core/types";
import type { StoreType, TenantConfig } from "./types";

/**
 * Factory for creating ContentAddressedStore instances based on configuration.
 * 
 * Supports "inmemory" stores (volatile, for testing) and "file" stores
 * (persistent, backed by BasicOnDiskContentAddressedStore).
 */
export class StoreFactory {
  private config: TenantConfig;
  private tenantId: string;
  private dataDir: string;
  
  /** Cache of created stores: Map<"tenantId:dbId", store> */
  private stores: Map<string, ContentAddressedStore> = new Map();

  constructor(tenantId: string, config: TenantConfig, dataDir?: string) {
    this.tenantId = tenantId;
    this.config = config;
    this.dataDir = dataDir || ".";
  }

  /**
   * Get or create a content-addressed store for a database.
   * 
   * @param dbId The database identifier
   * @returns The content-addressed store for the database
   */
  getStore(dbId: string): ContentAddressedStore {
    const cacheKey = `${this.tenantId}:${dbId}`;
    
    // Check cache first
    const existing = this.stores.get(cacheKey);
    if (existing) {
      return existing;
    }

    // Determine store type for this database
    const storeType = this.getStoreTypeForDb(dbId);
    
    // Create the store
    const store = this.createStore(dbId, storeType);
    
    // Cache and return
    this.stores.set(cacheKey, store);
    console.log(`[StoreFactory] Created ${storeType} store for ${this.tenantId}/${dbId}`);
    
    return store;
  }

  /**
   * Get the store type configured for a specific database.
   */
  private getStoreTypeForDb(dbId: string): StoreType {
    // Check for database-specific override
    const dbConfig = this.config.databaseStores?.[dbId];
    if (dbConfig?.storeType) {
      return dbConfig.storeType;
    }
    
    // Fall back to default
    return this.config.defaultStoreType || "inmemory";
  }

  /**
   * Create a new store instance of the specified type.
   */
  private createStore(dbId: string, storeType: StoreType): ContentAddressedStore {
    switch (storeType) {
      case "inmemory":
        return new InMemoryContentAddressedStore(dbId);
      
      case "file": {
        const basePath = `${this.dataDir}/${this.tenantId}/stores`;
        return new BasicOnDiskContentAddressedStore(dbId, undefined, { basePath });
      }
      
      default:
        throw new Error(`Unknown store type: ${storeType}`);
    }
  }

  /**
   * Get all cached stores.
   * Useful for cleanup or iteration.
   */
  getAllStores(): Map<string, ContentAddressedStore> {
    return new Map(this.stores);
  }

  /**
   * Clear the store cache.
   * Note: This doesn't delete any persisted data, just clears the in-memory cache.
   */
  clearCache(): void {
    this.stores.clear();
    console.log(`[StoreFactory] Cleared store cache for tenant ${this.tenantId}`);
  }
}
