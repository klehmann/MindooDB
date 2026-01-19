/**
 * Factory for creating content-addressed stores based on configuration.
 */

import { InMemoryContentAddressedStore } from "../../../src/core/appendonlystores/InMemoryContentAddressedStore";
import type { ContentAddressedStore } from "../../../src/core/types";
import type { StoreType, TenantConfig } from "./types";

/**
 * Factory for creating ContentAddressedStore instances based on configuration.
 * 
 * Currently only supports "inmemory" stores. The "file" store type is reserved
 * for future implementation.
 */
export class StoreFactory {
  private config: TenantConfig;
  private tenantId: string;
  
  /** Cache of created stores: Map<"tenantId:dbId", store> */
  private stores: Map<string, ContentAddressedStore> = new Map();

  constructor(tenantId: string, config: TenantConfig) {
    this.tenantId = tenantId;
    this.config = config;
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
      
      case "file":
        // TODO: Implement file-based store
        throw new Error(`File-based store not yet implemented for ${this.tenantId}/${dbId}`);
      
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
