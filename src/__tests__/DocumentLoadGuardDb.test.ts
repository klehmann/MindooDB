import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import { PUBLIC_INFOS_KEY_ID, type MindooDB } from "../core/types";
import { MindooValue } from "../core/values";
import { DocumentTooLargeError, setDocumentLoadBudget } from "../core/documentLoadGuard";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * The load budget stops a document whose estimated Automerge memory is too
 * large before it reaches Automerge, and lets smaller documents load.
 */
describe("document load budget", () => {
  const tenantId = "test-tenant-loadguard";
  const adminPassword = "admin-pass";
  const userPassword = "user-pass";

  afterEach(() => setDocumentLoadBudget(null));

  /** Forget the materialized documents, so the next read loads from the store. */
  function forgetLoadedDocuments(db: MindooDB) {
    (db as unknown as { docCache: Map<string, unknown> }).docCache.clear();
  }

  it("refuses a large text document and still loads an atomic one of the same size", async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    const factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    const adminUser = await factory.createUserId("CN=admin/O=guard", adminPassword);
    const user = await factory.createUserId("CN=user/O=guard", userPassword);
    const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, userPassword, factory.getCryptoAdapter());
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    const tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      keyBag,
    );
    const directory = await tenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(user), adminUser.userSigningKeyPair.privateKey, adminPassword);
    const db = await tenant.openDB("test-db");

    const big = "x".repeat(200_000);
    const textDoc = await db.createDocument({ initialValues: { body: MindooValue.text(big) } });
    const atomicDoc = await db.createDocument({ initialValues: { body: MindooValue.atomic(big) } });
    forgetLoadedDocuments(db);

    // ~200k ops of text need ~100 MB; the atomic copy is a handful of ops.
    setDocumentLoadBudget(20 * 1024 * 1024);
    await expect(db.getDocument(textDoc.getId())).rejects.toBeInstanceOf(DocumentTooLargeError);
    const loaded = await db.getDocument(atomicDoc.getId());
    expect(loaded.getData().body).toBe(big);

    setDocumentLoadBudget(null);
    const again = await db.getDocument(textDoc.getId());
    expect(again.getData().body).toBe(big);
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  }, 60_000);
});
