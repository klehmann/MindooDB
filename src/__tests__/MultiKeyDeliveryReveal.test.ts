import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DEFAULT_TENANT_KEY_ID,
  MindooDB,
  MindooDoc,
  MindooTenant,
  OpenStoreOptions,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

// Shared store so the creator (key-holder), admin (publisher) and reader
// (recipient) all see the same directory + data stores, mirroring a single
// synced tenant.
class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private docStores = new Map<string, InMemoryContentAddressedStore>();
  private attachmentStores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    let docStore = this.docStores.get(dbId);
    if (!docStore) {
      docStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options);
      this.docStores.set(dbId, docStore);
    }
    let attachmentStore = this.attachmentStores.get(dbId);
    if (!attachmentStore) {
      attachmentStore = new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options);
      this.attachmentStores.set(dbId, attachmentStore);
    }
    return { docStore, attachmentStore };
  }
}

/**
 * End-to-end multi-version key delivery + reveal-on-add.
 *
 * User1 (creator/key-holder) holds TWO versions of one `keyId` and encrypts a
 * different document under each (rotation). User2 (reader) initially has
 * neither version, so the encrypted docs are invisible. User1 prepares an
 * admin-blind key delivery, an admin publishes it, and User2 imports it on
 * sync — at which point BOTH documents surface, because (a) delivery carries
 * every key version and (b) decryption tries every version.
 */
describe("multi-version key delivery reveals rotated-key documents end-to-end", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-multikey-delivery";
  const namedKeyId = "shared-project-key";
  const adminPassword = "admin-pass-123";
  const creatorPassword = "creator-pass-123";
  const readerPassword = "reader-pass-123";

  type DeliveryDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      | "prepareKeyDelivery"
      | "publishKeyDelivery"
      | "importKeyDeliveriesForUser"
      | "registerUser"
      | "setDefaultReadPolicy"
    >
  >;

  let factory: BaseMindooTenantFactory;
  let readerFactory: BaseMindooTenantFactory;
  let cacheStore: InMemoryLocalCacheStore;

  let admin: PrivateUserId;
  let creator: PrivateUserId;
  let reader: PrivateUserId;
  let creatorKeyBag: KeyBag;
  let readerKeyBag: KeyBag;

  let creatorTenant: MindooTenant;
  let readerTenant: MindooTenant;
  let creatorDir: DeliveryDirectory;
  let creatorDb: MindooDB;
  let readerDb: MindooDB;

  let docV1Id: string;
  let docV2Id: string;

  beforeEach(async () => {
    const storeFactory = new SharedInMemoryStoreFactory();
    cacheStore = new InMemoryLocalCacheStore();
    factory = new BaseMindooTenantFactory(storeFactory, crypto);
    readerFactory = new BaseMindooTenantFactory(storeFactory, crypto, undefined, cacheStore);

    admin = await factory.createUserId("CN=admin/O=multikey", adminPassword);
    creator = await factory.createUserId("CN=creator/O=multikey", creatorPassword);
    reader = await readerFactory.createUserId("CN=reader/O=multikey", readerPassword);

    creatorKeyBag = new KeyBag(creator.userEncryptionKeyPair.privateKey, creatorPassword, crypto);
    readerKeyBag = new KeyBag(reader.userEncryptionKeyPair.privateKey, readerPassword, crypto);

    await creatorKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await creatorKeyBag.createTenantKey(tenantId);
    // First version of the named key (v1, older timestamp).
    await creatorKeyBag.createDocKey(tenantId, namedKeyId, Date.now() - 10_000);

    // The reader starts with the baseline keys but NOT the named key.
    await readerKeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await creatorKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await readerKeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await creatorKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);

    creatorTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      creator,
      creatorPassword,
      creatorKeyBag,
    );

    const directory = await creatorTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(creator), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(reader), admin.userSigningKeyPair.privateKey, adminPassword);
    creatorDir = directory as unknown as DeliveryDirectory;

    creatorDb = await creatorTenant.openDB("projects");

    // Doc encrypted under v1 (the only version that exists right now).
    const docV1 = await creatorDb.createDocument({ decryptionKeyId: namedKeyId });
    docV1Id = docV1.getId();
    await creatorDb.changeDoc(docV1, (doc: MindooDoc) => {
      doc.getData().title = "Encrypted under v1";
    });

    // Rotate the named key: v2 becomes the newest version.
    await creatorKeyBag.createDocKey(tenantId, namedKeyId, Date.now());
    await creatorTenant.reconcileKeyBagChanges?.();

    // Doc encrypted under v2 (now the newest version).
    const docV2 = await creatorDb.createDocument({ decryptionKeyId: namedKeyId });
    docV2Id = docV2.getId();
    await creatorDb.changeDoc(docV2, (doc: MindooDoc) => {
      doc.getData().title = "Encrypted under v2";
    });

    // Reader opens the tenant + database and syncs the (still encrypted) data.
    readerTenant = await readerFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      reader,
      readerPassword,
      readerKeyBag,
    );
    readerDb = await readerTenant.openDB("projects");
    await readerDb.syncStoreChanges();
  }, 60000);

  afterEach(async () => {
    await (creatorTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    await (readerTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("creator (key-holder) can read documents encrypted under both key versions", async () => {
    // Sanity: rotation must not break the author's own access to older docs.
    expect((await creatorDb.getDocument(docV1Id)).getData().title).toBe("Encrypted under v1");
    expect((await creatorDb.getDocument(docV2Id)).getData().title).toBe("Encrypted under v2");
  }, 60000);

  it("reader cannot see the docs until both key versions are delivered, then both appear", async () => {
    // 1. Reader has no named key yet -> the encrypted docs are invisible.
    expect(await readerDb.getAllDocumentIds()).toEqual([]);

    // 2. Creator (key-holder) prepares the delivery; it must carry BOTH versions.
    const payload = await creatorDir.prepareKeyDelivery(namedKeyId, [reader.username]);
    expect(payload.recipients).toHaveLength(1);
    expect(payload.recipients[0].versions).toHaveLength(2);
    expect(payload.preparedByPublicKey).toBe(creator.userSigningKeyPair.publicKey);

    // 3. Admin publishes the wrapped bundle (admin-blind).
    await creatorDir.publishKeyDelivery(payload, admin.userSigningKeyPair.privateKey, adminPassword);

    // 4. Reader pulls the delivery on sync and imports it.
    const readerDir = (await readerTenant.openDirectory()) as unknown as DeliveryDirectory;
    const imported = await readerDir.importKeyDeliveriesForUser(
      reader.username,
      reader.userEncryptionKeyPair.privateKey,
      readerPassword,
    );
    expect(imported).toEqual([namedKeyId]);

    // The reader now holds both versions of the key...
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(2);

    // 5. ...and BOTH documents have surfaced via reveal-on-add, decryptable
    //    despite being encrypted under different key versions.
    expect((await readerDb.getAllDocumentIds()).sort()).toEqual([docV1Id, docV2Id].sort());
    expect((await readerDb.getDocument(docV1Id)).getData().title).toBe("Encrypted under v1");
    expect((await readerDb.getDocument(docV2Id)).getData().title).toBe("Encrypted under v2");

    // 6. Revoke read access by policy revision: the admin flips the tenant to
    //    default-deny reads (no client-trusted clock involved).
    await creatorDir.setDefaultReadPolicy(
      { defaultReadAccess: "deny" },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // The reader ingests the new policy, then runs the read-visibility reconcile
    // (the directory-sync path drives this in production).
    await (readerDir as unknown as { listKnownDBIds: () => Promise<string[]> }).listKnownDBIds();
    await (readerDb as unknown as { reconcileKeyVisibility: () => Promise<void> }).reconcileKeyVisibility();

    // 7. Both docs disappear locally and the named key is crypto-shredded so the
    //    scope cannot be re-materialized; the tenant default key stays intact.
    expect(await readerDb.getAllDocumentIds()).toEqual([]);
    await expect(readerDb.getDocument(docV1Id)).rejects.toThrow(`Document ${docV1Id} not found`);
    await expect(readerDb.getDocument(docV2Id)).rejects.toThrow(`Document ${docV2Id} not found`);
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(0);
    expect(await readerKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID)).toBeTruthy();
  }, 60000);
});
