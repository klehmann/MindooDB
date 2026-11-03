/**
 * Node host of the {@link CoreTenantManager}: tenant state lives in files
 * below the data directory and every tenant database is an on-disk store in
 * `<dataDir>/<tenantId>/stores` (see {@link StoreFactory}).
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import { TenantManager as CoreTenantManager } from "../../server/TenantManager";
import type { ServerStoreProvider } from "../../server/ServerDataStore";
import { FsServerDataStore } from "./FsServerDataStore";
import { StoreFactory } from "./StoreFactory";

export {
  SimpleMindooDirectory,
  type LoadedTenant,
  type RegisterTenantResult,
} from "../../server/TenantManager";

/** The on-disk stores of every tenant below `<dataDir>/<tenantId>/stores`. */
export class NodeServerStoreProvider implements ServerStoreProvider {
  constructor(
    private readonly dataDir: string,
    private readonly dataStore: FsServerDataStore,
  ) {}

  createTenantStores(tenantId: string, config: ConstructorParameters<typeof StoreFactory>[1]): StoreFactory {
    return new StoreFactory(tenantId, config, this.dataDir);
  }

  listDatabases(tenantId: string): string[] {
    const storesDir = this.dataStore.resolvePath(join(tenantId, "stores"));
    if (!existsSync(storesDir)) {
      return [];
    }
    try {
      return readdirSync(storesDir).filter((entry) =>
        statSync(join(storesDir, entry)).isDirectory(),
      );
    } catch (error) {
      console.warn(
        `[TenantManager] Could not list databases for ${tenantId}:`,
        error,
      );
      return [];
    }
  }
}

function ensureDataDir(dataDir: string): string {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`[TenantManager] Created data directory: ${dataDir}`);
  }
  return dataDir;
}

export class TenantManager extends CoreTenantManager {
  private readonly dataDir: string;

  constructor(dataDir: string, serverPassword?: string) {
    const dataStore = new FsServerDataStore(ensureDataDir(dataDir));
    super({
      dataStore,
      storeProvider: new NodeServerStoreProvider(dataDir, dataStore),
      cryptoAdapter: new NodeCryptoAdapter(),
      serverPassword,
    });
    this.dataDir = dataDir;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  override getCryptoAdapter(): NodeCryptoAdapter {
    return super.getCryptoAdapter() as NodeCryptoAdapter;
  }
}
