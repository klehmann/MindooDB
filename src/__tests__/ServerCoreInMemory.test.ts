/**
 * The platform-neutral server core runs without Express and without files:
 * a {@link MemoryServerDataStore}, in-memory stores and direct handler calls
 * are all a host needs. This is the shape a serverless host builds on.
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { StoreKind, type ContentAddressedStore } from "../core/types";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import type { EncryptedPrivateKey, PrivateUserId } from "../core/types";
import { bytesToBase64 } from "../core/utils/base64";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import {
  CapabilityMatcher,
  DeviceDiscoveryService,
  MemoryServerDataStore,
  MindooDBServerCore,
  SyncEventBus,
  SystemAdminAuthService,
  TenantManager,
  isJsonResponse,
  type ServerConfig,
  type ServerRequest,
  type ServerResponse,
  type ServerStoreProvider,
} from "../server";

const SERVER_PASSWORD = "core-server-pass";
const ADMIN_PASSWORD = "core-admin-pass";

function request(overrides: Partial<ServerRequest>): ServerRequest {
  return {
    method: "POST",
    path: "/",
    params: {},
    query: {},
    headers: {},
    body: {},
    ...overrides,
  };
}

function json(response: ServerResponse): any {
  if (!isJsonResponse(response)) {
    throw new Error("expected a JSON response");
  }
  return response.json;
}

/** Every tenant database is an in-memory store, kept for the test's lifetime. */
class MemoryStoreProvider implements ServerStoreProvider {
  readonly stores = new Map<string, ContentAddressedStore>();

  createTenantStores(tenantId: string) {
    return {
      getStore: (dbId: string, storeKind: StoreKind) => {
        const key = `${tenantId}/${dbId}/${storeKind}`;
        let store = this.stores.get(key);
        if (!store) {
          store = new InMemoryContentAddressedStore(dbId, storeKind);
          this.stores.set(key, store);
        }
        return store;
      },
    };
  }

  listDatabases(tenantId: string): string[] {
    const dbIds = new Set<string>();
    for (const key of this.stores.keys()) {
      const [tenant, dbId] = key.split("/");
      if (tenant === tenantId) dbIds.add(dbId);
    }
    return [...dbIds];
  }

  removeTenantStores(tenantId: string): void {
    for (const key of [...this.stores.keys()]) {
      if (key.startsWith(`${tenantId}/`)) this.stores.delete(key);
    }
  }
}

describe("MindooDBServerCore without a host framework", () => {
  const cryptoAdapter = new NodeCryptoAdapter();
  let adminUser: PrivateUserId;
  let dataStore: MemoryServerDataStore;
  let storeProvider: MemoryStoreProvider;
  let core: MindooDBServerCore;

  beforeAll(async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );
    const serverIdentity = await factory.createUserId("CN=core-server", SERVER_PASSWORD);
    adminUser = await factory.createUserId("cn=admin/o=core", ADMIN_PASSWORD);

    dataStore = new MemoryServerDataStore();
    dataStore.writeText("server.identity.json", JSON.stringify(serverIdentity));
    storeProvider = new MemoryStoreProvider();

    const tenantManager = new TenantManager({
      dataStore,
      storeProvider,
      cryptoAdapter,
      serverPassword: SERVER_PASSWORD,
    });
    let serverConfig: ServerConfig = { capabilities: {} };
    const capabilityMatcher = new CapabilityMatcher(serverConfig);
    core = new MindooDBServerCore({
      tenantManager,
      systemAdminAuth: new SystemAdminAuthService(cryptoAdapter, serverConfig),
      capabilityMatcher,
      deviceDiscovery: new DeviceDiscoveryService(tenantManager, cryptoAdapter),
      syncEvents: new SyncEventBus(),
      configRepository: {
        listBackups: () => [],
        loadBackup: (file) => {
          throw new Error(`Config backup not found: ${file}`);
        },
        replace: () => null,
      },
      getServerConfig: () => serverConfig,
      reloadConfig: (config) => {
        serverConfig = config;
        capabilityMatcher.reload(config);
      },
      tsaProviders: [],
      jsonBodyLimit: "5mb",
      allowInsecureSyncUrls: false,
    });
  }, 60_000);

  test("server info comes from the identity in the data store", () => {
    const info = json(core.serverInfo());
    expect(info.name).toBe("CN=core-server");
    expect(info.maxJsonRequestBodyBytes).toBe(5 * 1024 * 1024);
  });

  test("unknown tenants are rejected by the tenant guard", () => {
    const rejection = core.tenantGuard(request({ params: { tenantId: "nope" } }));
    expect(rejection?.status).toBe(404);
  });

  test("register a tenant, authenticate its admin and read a store head", async () => {
    const registered = await core.registerTenant(
      request({
        params: { tenantId: "Core-Tenant" },
        systemAdmin: { username: "operator", publicsignkey: "-" },
        body: {
          adminUsername: adminUser.username,
          adminSigningPublicKey: adminUser.userSigningKeyPair.publicKey,
          adminEncryptionPublicKey: adminUser.userEncryptionKeyPair.publicKey,
          publicInfosKey: bytesToBase64(cryptoAdapter.getRandomValues(new Uint8Array(32))),
        },
      }),
    );
    expect(registered.status).toBe(201);
    expect(dataStore.readText("core-tenant/config.json")).toContain("adminSigningPublicKey");
    expect(json(core.listTenants()).tenants).toEqual(["core-tenant"]);

    const tenantRequest = (overrides: Partial<ServerRequest>) => {
      const req = request({ params: { tenantId: "core-tenant" }, ...overrides });
      expect(core.tenantGuard(req)).toBeNull();
      return req;
    };

    const challenge = json(
      await core.challenge(
        tenantRequest({ body: { signingPublicKey: adminUser.userSigningKeyPair.publicKey } }),
      ),
    ).challenge as string;
    expect(typeof challenge).toBe("string");

    const signingKeyBytes = await decryptPrivateKey(
      cryptoAdapter,
      adminUser.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      ADMIN_PASSWORD,
      "signing",
    );
    const subtle = cryptoAdapter.getSubtle();
    const signingKey = await subtle.importKey("pkcs8", signingKeyBytes, { name: "Ed25519" }, false, ["sign"]);
    const signature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, signingKey, new TextEncoder().encode(challenge)),
    );
    const authenticated = await core.authenticate(
      tenantRequest({ body: { challenge, signature: bytesToBase64(signature) } }),
    );
    expect(authenticated.status).toBe(200);
    const token = json(authenticated).token as string;

    const head = await core.sync(
      "getStoreHead",
      tenantRequest({ headers: { authorization: `Bearer ${token}` }, body: { dbId: "directory" } }),
      StoreKind.docs,
    );
    expect(head.status).toBe(200);
    expect(json(head).head).toEqual(expect.objectContaining({ maxReceiptOrder: expect.any(Number) }));
    expect(storeProvider.listDatabases("core-tenant")).toContain("directory");

    const anonymous = await core.sync(
      "getStoreHead",
      tenantRequest({ body: { dbId: "directory" } }),
      StoreKind.docs,
    );
    expect(anonymous.status).toBe(401);

    const removed = await core.deleteTenant(request({ params: { tenantId: "core-tenant" } }));
    expect(removed.status).toBe(200);
    expect(dataStore.exists("core-tenant")).toBe(false);
    expect(storeProvider.listDatabases("core-tenant")).toEqual([]);
  }, 60_000);
});
