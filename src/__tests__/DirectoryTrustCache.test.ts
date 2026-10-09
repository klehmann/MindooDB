import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  PrivateUserId,
  MindooTenant,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Store factory that returns the SAME in-memory stores for a given dbId, so two
 * tenant instances opened over it observe each other's writes once they read
 * the store — simulating two processes sharing one local store.
 */
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

/**
 * The directory trust cache (validatePublicSigningKey) separates two layers:
 * reading new entries from the store is throttled, but entries already in the
 * directory index take effect on the next validation, independent of time.
 */
describe("directory trust cache", () => {
  const tenantId = "tenant-trust-cache";
  const adminPassword = "adminpass123";
  let factory: BaseMindooTenantFactory;
  let admin: PrivateUserId;
  let adminKeyBag: KeyBag;
  let adminTenant: MindooTenant;
  let otherTenant: MindooTenant;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  async function openTenantAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      password,
      await keyBagFor(user, password),
    );
  }

  /** Read the directory store into `tenant`'s directory index, as a pull or sync would. */
  async function readDirectoryStore(tenant: MindooTenant): Promise<void> {
    const directory = (await tenant.openDirectory()) as unknown as {
      getDirectoryDB(): Promise<{ syncStoreChanges(): Promise<void> }>;
    };
    await (await directory.getDirectoryDB()).syncStoreChanges();
  }

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new SharedInMemoryStoreFactory(), new NodeCryptoAdapter());
    admin = await factory.createUserId("CN=admin/O=trustcache", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    const writer = await factory.createUserId("CN=writer/O=trustcache", "writerpass123");
    adminTenant = await openTenantAs(writer, "writerpass123");
    const directory = await adminTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(writer), admin.userSigningKeyPair.privateKey, adminPassword);

    const otherUser = await factory.createUserId("CN=other/O=trustcache", "otherpass123");
    await directory.registerUser(factory.toPublicUserId(otherUser), admin.userSigningKeyPair.privateKey, adminPassword);
    otherTenant = await openTenantAs(otherUser, "otherpass123");
  }, 60000);

  it("applies a revocation that is already in the directory index on the next validation", async () => {
    const alice = await factory.createUserId("CN=alice/O=trustcache", "alicepass123");
    const adminDirectory = await adminTenant.openDirectory();
    await adminDirectory.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    const aliceKey = alice.userSigningKeyPair.publicKey;

    const otherDirectory = await otherTenant.openDirectory();
    expect(await otherDirectory.validatePublicSigningKey(aliceKey)).toBe(true);

    const username = (await adminDirectory.getUserBySigningPublicKey(aliceKey))!.username;
    await adminDirectory.revokeUser(username, {}, admin.userSigningKeyPair.privateKey, adminPassword);

    // The other instance reads the revocation into its index (no forceRefresh,
    // well within the store-poll interval).
    await readDirectoryStore(otherTenant);
    expect(await otherDirectory.validatePublicSigningKey(aliceKey)).toBe(false);
  }, 60000);

  it("does not poll the store again for a repeatedly missed key, but trusts it once its grant is in the index", async () => {
    const bob = await factory.createUserId("CN=bob/O=trustcache", "bobpass123");
    const bobKey = bob.userSigningKeyPair.publicKey;

    const otherDirectory = await otherTenant.openDirectory();
    const otherDirectoryDB = await (otherDirectory as unknown as {
      getDirectoryDB(): Promise<{ syncStoreChanges(): Promise<void> }>;
    }).getDirectoryDB();
    const pollSpy = jest.spyOn(otherDirectoryDB, "syncStoreChanges");

    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(false);
    const pollsAfterFirstMiss = pollSpy.mock.calls.length;
    expect(pollsAfterFirstMiss).toBeGreaterThanOrEqual(1);

    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(false);
    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(false);
    expect(pollSpy.mock.calls.length).toBe(pollsAfterFirstMiss);

    const adminDirectory = await adminTenant.openDirectory();
    await adminDirectory.registerUser(factory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);
    await readDirectoryStore(otherTenant);
    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(true);
    pollSpy.mockRestore();
  }, 60000);
});
