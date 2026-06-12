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
import { ColumnSorting, VirtualViewFactory } from "../core/indexing/virtualviews";

class PersistentInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, InMemoryContentAddressedStore>();
  private attachmentStores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    let docStore = this.stores.get(dbId);
    if (!docStore) {
      docStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options);
      this.stores.set(dbId, docStore);
    }

    let attachmentStore = this.attachmentStores.get(dbId);
    if (!attachmentStore) {
      attachmentStore = new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options);
      this.attachmentStores.set(dbId, attachmentStore);
    }

    return { docStore, attachmentStore };
  }
}

describe("key visibility reconciliation", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "key-visibility-tenant";
  const namedKeyId = "project-alpha-key";
  const adminPassword = "admin-pass";
  const creatorPassword = "creator-pass";
  const readerPassword = "reader-pass";

  let creatorFactory: BaseMindooTenantFactory;
  let readerFactory: BaseMindooTenantFactory;
  let cacheStore: InMemoryLocalCacheStore;
  let creatorKeyBag: KeyBag;
  let readerKeyBag: KeyBag;
  let creatorTenant: MindooTenant;
  let readerTenant: MindooTenant;
  let creatorDb: MindooDB;
  let readerDb: MindooDB;
  let secretDocId: string;
  let adminUser: PrivateUserId;
  let adminSigningPublicKey: string;
  let adminEncryptionPublicKey: string;
  let readerUserId: PrivateUserId;

  beforeEach(async () => {
    const storeFactory = new PersistentInMemoryStoreFactory();
    cacheStore = new InMemoryLocalCacheStore();
    creatorFactory = new BaseMindooTenantFactory(storeFactory, crypto);
    readerFactory = new BaseMindooTenantFactory(storeFactory, crypto, undefined, cacheStore);

    adminUser = await creatorFactory.createUserId("CN=admin/O=keyvis", adminPassword);
    const creatorUser = await creatorFactory.createUserId("CN=creator/O=keyvis", creatorPassword);
    const readerUser = await readerFactory.createUserId("CN=reader/O=keyvis", readerPassword);
    adminSigningPublicKey = adminUser.userSigningKeyPair.publicKey;
    adminEncryptionPublicKey = adminUser.userEncryptionKeyPair.publicKey;
    readerUserId = readerUser;

    creatorKeyBag = new KeyBag(creatorUser.userEncryptionKeyPair.privateKey, creatorPassword, crypto);
    readerKeyBag = new KeyBag(readerUser.userEncryptionKeyPair.privateKey, readerPassword, crypto);

    await creatorKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await creatorKeyBag.createTenantKey(tenantId);
    await creatorKeyBag.createDocKey(tenantId, namedKeyId);

    await readerKeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await creatorKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await readerKeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await creatorKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);

    creatorTenant = await creatorFactory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      creatorUser,
      creatorPassword,
      creatorKeyBag,
    );

    const directory = await creatorTenant.openDirectory();
    await directory.registerUser(creatorFactory.toPublicUserId(creatorUser), adminUser.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(readerFactory.toPublicUserId(readerUser), adminUser.userSigningKeyPair.privateKey, adminPassword);

    creatorDb = await creatorTenant.openDB("secrets");
    const secretDoc = await creatorDb.createDocument({ decryptionKeyId: namedKeyId });
    secretDocId = secretDoc.getId();
    await creatorDb.changeDoc(secretDoc, (doc: MindooDoc) => {
      const data = doc.getData();
      data.title = "Project Alpha";
      data.department = "Restricted";
      data.rank = 1;
    });

    readerTenant = await readerFactory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      readerUser,
      readerPassword,
      readerKeyBag,
    );
    readerDb = await readerTenant.openDB("secrets");
    await readerDb.syncStoreChanges();
  }, 30000);

  afterEach(async () => {
    await (creatorTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    await (readerTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("emits cursor-based KeyBag changes without key material", async () => {
    const cursor = readerKeyBag.getLatestChangeCursor();

    await readerKeyBag.set("doc", tenantId, namedKeyId, (await creatorKeyBag.get("doc", tenantId, namedKeyId))!);
    await readerKeyBag.deleteKey("doc", tenantId, namedKeyId);

    const events = [];
    for await (const event of readerKeyBag.iterateChangesSince(cursor)) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        action: "add",
        type: "doc",
        tenantId,
        keyId: namedKeyId,
        hasKey: true,
        versionsRemaining: 1,
      }),
      expect.objectContaining({
        action: "remove",
        type: "doc",
        tenantId,
        keyId: namedKeyId,
        hasKey: false,
        versionsRemaining: 0,
      }),
    ]);
    expect(events.every((event) => !("key" in event) && !("keyBytes" in event))).toBe(true);
    expect(events[1].changeSeq).toBeGreaterThan(events[0].changeSeq);
  }, 30000);

  it("hides, reveals, purges, and re-reveals named-key documents and view entries", async () => {
    expect(await readerDb.getAllDocumentIds()).toEqual([]);

    const initialChanges = [];
    for await (const change of readerDb.iterateChangesSince(null)) {
      initialChanges.push(change);
    }
    expect(initialChanges).toEqual([]);

    const initialMetadata = [];
    for await (const summary of readerDb.iterateChangeMetadataSince(null)) {
      initialMetadata.push(summary);
    }
    expect(initialMetadata).toEqual([]);

    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("department", { sorting: ColumnSorting.ASCENDING })
      .addSortedColumn("rank", ColumnSorting.ASCENDING)
      .withDB("secrets", readerDb)
      .buildAndUpdate();
    expect(view.getRoot().getChildCategories()).toHaveLength(0);

    const beforeRevealCursor = readerDb.getLatestChangeCursor?.() ?? null;
    await readerKeyBag.set("doc", tenantId, namedKeyId, (await creatorKeyBag.get("doc", tenantId, namedKeyId))!);
    await readerTenant.reconcileKeyBagChanges?.();
    await view.update();

    expect(await readerDb.getAllDocumentIds()).toEqual([secretDocId]);
    const revealedDoc = await readerDb.getDocument(secretDocId);
    expect(revealedDoc.getData().title).toBe("Project Alpha");
    // A normally-loaded doc is accessible and not deleted.
    expect(revealedDoc.isAccessible()).toBe(true);
    expect(revealedDoc.isDeleted()).toBe(false);
    expect(view.getRoot().getChildCategories().map((entry) => entry.getCategoryValue())).toEqual(["Restricted"]);
    expect(view.getRoot().getChildCategories()[0].getChildDocuments()).toHaveLength(1);
    expect(view.getRoot().getChildCategories()[0].getChildDocuments()[0].getDecryptionKeyId()).toBe(namedKeyId);

    const revealMetadata = [];
    for await (const summary of readerDb.iterateChangeMetadataSince(beforeRevealCursor)) {
      revealMetadata.push(summary);
    }
    expect(revealMetadata).toEqual([
      expect.objectContaining({ docId: secretDocId, isDeleted: false }),
    ]);

    const cacheManager = (readerTenant as unknown as { cacheManager?: { flush: () => Promise<number> } }).cacheManager;
    await cacheManager?.flush();
    expect((await cacheStore.list("doc")).some((key) => key.includes(secretDocId))).toBe(true);

    const beforePurgeCursor = readerDb.getLatestChangeCursor?.() ?? null;
    await readerKeyBag.deleteKey("doc", tenantId, namedKeyId);
    await readerTenant.reconcileKeyBagChanges?.();
    await view.update();

    expect(await readerDb.getAllDocumentIds()).toEqual([]);
    await expect(readerDb.getDocument(secretDocId)).rejects.toThrow(`Document ${secretDocId} not found`);
    expect((await cacheStore.list("doc")).some((key) => key.includes(secretDocId))).toBe(false);
    expect(view.getRoot().getChildCategories()).toHaveLength(0);

    const purgeMetadata = [];
    for await (const summary of readerDb.iterateChangeMetadataSince(beforePurgeCursor)) {
      purgeMetadata.push(summary);
    }
    expect(purgeMetadata).toEqual([
      expect.objectContaining({ docId: secretDocId, isDeleted: true }),
    ]);

    // The full-body feed emits the now-inaccessible doc as a tombstone:
    // isDeleted() === true, isAccessible() === false, empty data. This lets
    // incremental consumers drop it and distinguish a missing key from a
    // genuine deletion (docs/accesscontrol.md §13.5).
    const purgeChanges = [];
    for await (const change of readerDb.iterateChangesSince(beforePurgeCursor)) {
      purgeChanges.push(change);
    }
    expect(purgeChanges).toHaveLength(1);
    expect(purgeChanges[0].doc.getId()).toBe(secretDocId);
    expect(purgeChanges[0].doc.isDeleted()).toBe(true);
    expect(purgeChanges[0].doc.isAccessible()).toBe(false);
    expect(purgeChanges[0].doc.getData()).toEqual({});

    await readerKeyBag.set("doc", tenantId, namedKeyId, (await creatorKeyBag.get("doc", tenantId, namedKeyId))!);
    await readerTenant.reconcileKeyBagChanges?.();
    await view.update();

    expect(await readerDb.getAllDocumentIds()).toEqual([secretDocId]);
    expect((await readerDb.getDocument(secretDocId)).getData().title).toBe("Project Alpha");
    const restrictedCategory = view.getRoot().getChildCategories()[0];
    expect(restrictedCategory.getCategoryValue()).toBe("Restricted");
    expect(restrictedCategory.getChildDocuments().map((entry) => entry.docId)).toEqual([secretDocId]);
  }, 30000);

  it("skips the visibility scan on a warm restart with an unchanged KeyBag", async () => {
    // Reveal the secret doc, flush the cache, then tear down the reader
    // tenant so we can simulate a process restart.
    await readerKeyBag.set("doc", tenantId, namedKeyId, (await creatorKeyBag.get("doc", tenantId, namedKeyId))!);
    await readerTenant.reconcileKeyBagChanges?.();
    const cacheManager = (readerTenant as unknown as { cacheManager?: { flush: () => Promise<number> } }).cacheManager;
    await cacheManager?.flush();
    await (readerTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();

    // Instrument `scanEntriesSince` so we can count full metadata scans
    // (cursor === null AND no docId filter). Delta scans driven by the
    // persisted cursor are not full scans and are expected to keep
    // happening.
    const originalScan = InMemoryContentAddressedStore.prototype.scanEntriesSince;
    let fullScanCount = 0;
    InMemoryContentAddressedStore.prototype.scanEntriesSince = async function (
      this: InMemoryContentAddressedStore,
      cursor,
      limit,
      filters,
    ) {
      if (cursor === null && !filters?.docId) {
        fullScanCount += 1;
      }
      return originalScan.call(this, cursor, limit, filters);
    } as typeof originalScan;

    try {
      // Warm restart with an unchanged KeyBag - fingerprint matches the
      // persisted one, so no visibility scan should fire.
      const warmTenant = await readerFactory.openTenant(
        tenantId,
        adminSigningPublicKey,
        adminEncryptionPublicKey,
        readerUserId,
        readerPassword,
        readerKeyBag,
      );
      const warmDb = await warmTenant.openDB("secrets");
      expect(await warmDb.getAllDocumentIds()).toEqual([secretDocId]);
      expect(fullScanCount).toBe(0);

      // Cold-mutate the KeyBag between sessions (drop the named key)
      // and restart again - the fingerprint changes, so exactly one
      // visibility scan should fire.
      await (warmTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
      const offlineMutationKeyBag = readerKeyBag.clone();
      await offlineMutationKeyBag.deleteKey("doc", tenantId, namedKeyId);
      fullScanCount = 0;

      const restartedTenant = await readerFactory.openTenant(
        tenantId,
        adminSigningPublicKey,
        adminEncryptionPublicKey,
        readerUserId,
        readerPassword,
        offlineMutationKeyBag,
      );
      const restartedDb = await restartedTenant.openDB("secrets");
      expect(await restartedDb.getAllDocumentIds()).toEqual([]);
      // We expect at least one full scan because the named-key removal
      // is observable: each cached database whose tenant fingerprint
      // changed pays one visibility scan. The actual count depends on
      // how many cached databases the factory carries (directory +
      // secrets in this test), but the important invariant is that
      // the warm-restart short-circuit no longer applies.
      expect(fullScanCount).toBeGreaterThan(0);
      await (restartedTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    } finally {
      InMemoryContentAddressedStore.prototype.scanEntriesSince = originalScan;
    }
  }, 30000);
});
