import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  MindooTenant,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options),
      });
    }
    return this.stores.get(dbId)!;
  }
}

type FloorDirectory = Awaited<ReturnType<MindooTenant["openDirectory"]>> & {
  getRequireMetadataSignatureSince(): Promise<number | undefined>;
  isAccessControlActive(): Promise<boolean>;
};

/**
 * New-tenant enforcement of the v2 storage-format floor. `createTenant` writes
 * an admin-signed default policy with `requireMetadataSignatureSince = now` (and
 * `disableAllAccessChecksAndPolicies: true`), so the tenant is v2-only from
 * creation WITHOUT turning on ACL deny-gates. The opt-out leaves no floor.
 */
describe("createTenant v2 storage-format floor", () => {
  let factory: BaseMindooTenantFactory;

  beforeEach(() => {
    factory = new BaseMindooTenantFactory(new SharedInMemoryStoreFactory(), new NodeCryptoAdapter());
  });

  it("sets requireMetadataSignatureSince=now by default without activating ACL", async () => {
    const before = Date.now();
    const userPassword = "userpass123";
    const { tenant, appUser } = await factory.createTenant({
      tenantId: "v2-on",
      adminName: "CN=admin/O=v2",
      userName: "CN=alice/O=v2",
      adminPassword: "adminpass123",
      userPassword,
    });
    const after = Date.now();

    const dir = (await tenant.openDirectory()) as FloorDirectory;
    const cutoff = await dir.getRequireMetadataSignatureSince();
    expect(typeof cutoff).toBe("number");
    expect(cutoff!).toBeGreaterThanOrEqual(before);
    expect(cutoff!).toBeLessThanOrEqual(after);

    // The floor must not turn on ACL deny-gates (master switch engaged).
    expect(await dir.isAccessControlActive()).toBe(false);

    // Normal writes (always v2) still work end-to-end under the floor.
    const db = await tenant.openDB("main");
    const doc = await db.createDocument({
      signingKeyPair: {
        publicKey: appUser.userSigningKeyPair.publicKey,
        privateKey: appUser.userSigningKeyPair.privateKey,
      },
      signingKeyPassword: userPassword,
      initialValues: { title: "hello" },
    });
    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded?.getData().title).toBe("hello");
  }, 90000);

  it("writes no floor when requireV2Entries is false", async () => {
    const { tenant } = await factory.createTenant({
      tenantId: "v2-off",
      adminName: "CN=admin/O=v2off",
      userName: "CN=alice/O=v2off",
      adminPassword: "adminpass123",
      userPassword: "userpass123",
      requireV2Entries: false,
    });

    const dir = (await tenant.openDirectory()) as FloorDirectory;
    expect(await dir.getRequireMetadataSignatureSince()).toBeUndefined();
    expect(await dir.isAccessControlActive()).toBe(false);
  }, 90000);
});
