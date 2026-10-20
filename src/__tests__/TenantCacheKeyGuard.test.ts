import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import type { BaseMindooTenant } from "../core/BaseMindooTenant";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { EncryptedLocalCacheStore } from "../core/cache/EncryptedLocalCacheStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { USERKEY_PRIVATE_SALT } from "../core/userkeys/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import type { MindooTenant, PrivateUserId } from "../core/types";

const PASSWORD = "identity-pass";

async function liveKeys(cryptoAdapter: NodeCryptoAdapter, user: PrivateUserId) {
  const subtle = cryptoAdapter.getSubtle();
  const signingKey = await subtle.importKey(
    "pkcs8",
    await decryptPrivateKey(cryptoAdapter, user.userSigningKeyPair.privateKey, PASSWORD, "signing"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const encryptionKey = await subtle.importKey(
    "pkcs8",
    await decryptPrivateKey(cryptoAdapter, user.userEncryptionKeyPair.privateKey, PASSWORD, "encryption"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const userKeyPrivateBytes = new Uint8Array(
    await decryptPrivateKey(cryptoAdapter, user.userKeyPair!.privateKey, PASSWORD, USERKEY_PRIVATE_SALT),
  );
  return { signingKey, encryptionKey, userKeyPrivateBytes };
}

async function fillCache(tenant: MindooTenant): Promise<void> {
  const db = await tenant.openDB("notes");
  const doc = await db.createDocument();
  await db.changeDoc(doc, (d) => {
    d.getData().title = "Quarterly report";
  });
  await (tenant as unknown as BaseMindooTenant).getCacheManager()!.flush();
}

async function setup(label: string) {
  const cryptoAdapter = new NodeCryptoAdapter();
  const cacheStore = new InMemoryLocalCacheStore();
  const factory = new BaseMindooTenantFactory(
    new IsolatedInMemoryStoreFactory(),
    cryptoAdapter,
    undefined,
    cacheStore,
  );
  const adminUser = await factory.createUserId(`cn=admin/o=${label}`, PASSWORD);
  const appUser = await factory.createUserId(`cn=user/o=${label}`, PASSWORD);
  await factory.ensureUserKeyPair(appUser, PASSWORD);
  return { cryptoAdapter, cacheStore, factory, adminUser, appUser };
}

async function persistedEntries(cacheStore: InMemoryLocalCacheStore): Promise<number> {
  return (await cacheStore.list("db-meta")).length + (await cacheStore.list("doc")).length;
}

describe("tenant cache key", () => {
  jest.setTimeout(120000);

  test("keeps the cache in memory without a key or a password", async () => {
    const { cryptoAdapter, cacheStore, factory, adminUser, appUser } = await setup("cache-guard-none");
    const { tenant } = await factory.createTenant({
      tenantId: `cache-guard-none-${Date.now().toString(16)}`,
      adminUser,
      adminPassword: PASSWORD,
      appUser,
      userPassword: "",
      preDecryptedAppUserKeys: await liveKeys(cryptoAdapter, appUser),
    });
    await fillCache(tenant);

    expect((tenant as unknown as BaseMindooTenant).getCacheManager()).not.toBeNull();
    expect(await persistedEntries(cacheStore)).toBe(0);
  });

  test("persists the cache with the supplied cache key", async () => {
    const { cryptoAdapter, cacheStore, factory, adminUser, appUser } = await setup("cache-guard-key");
    const cacheEncryptionKey = await cryptoAdapter
      .getSubtle()
      .generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const { tenant } = await factory.createTenant({
      tenantId: `cache-guard-key-${Date.now().toString(16)}`,
      adminUser,
      adminPassword: PASSWORD,
      appUser,
      userPassword: "",
      preDecryptedAppUserKeys: { ...(await liveKeys(cryptoAdapter, appUser)), cacheEncryptionKey },
    });
    await fillCache(tenant);

    const [metaKey] = await cacheStore.list("db-meta");
    expect(metaKey).toBeTruthy();
    const reader = new EncryptedLocalCacheStore(cacheStore, { cacheKey: cacheEncryptionKey, cryptoAdapter });
    expect(await reader.get("db-meta", metaKey)).not.toBeNull();
  });

  test("salts a password-derived cache key with the user's signing key", async () => {
    const { cryptoAdapter, cacheStore, factory, adminUser, appUser } = await setup("cache-guard-pw");
    const { tenant } = await factory.createTenant({
      tenantId: `cache-guard-pw-${Date.now().toString(16)}`,
      adminUser,
      adminPassword: PASSWORD,
      appUser,
      userPassword: PASSWORD,
    });
    await fillCache(tenant);

    const [metaKey] = await cacheStore.list("db-meta");
    expect(metaKey).toBeTruthy();
    const salted = new EncryptedLocalCacheStore(
      cacheStore,
      PASSWORD,
      cryptoAdapter,
      undefined,
      appUser.userSigningKeyPair.publicKey,
    );
    const unsalted = new EncryptedLocalCacheStore(cacheStore, PASSWORD, cryptoAdapter);
    expect(await salted.get("db-meta", metaKey)).not.toBeNull();
    expect(await unsalted.get("db-meta", metaKey)).toBeNull();
  });
});
