import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { EncryptedLocalCacheStore } from "../core/cache/EncryptedLocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
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

/**
 * `getInaccessibleDocumentCount()`: how many documents a device holds that it
 * cannot decrypt.
 *
 * Every listing hides such documents by design, which leaves an
 * under-provisioned device (keys not delivered yet, user key still waiting for
 * approval) looking exactly like an empty database. The tally is the only way
 * to tell those apart, and it cannot be derived from the index: a document that
 * was never readable here gets no index entry at all.
 */

/** Same store instance per dbId, so a simulated restart finds its data again. */
class PersistentInMemoryStoreFactory implements ContentAddressedStoreFactory {
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

/** One-way transfer between two replicas that share keys but not stores. */
async function syncTenantDb(target: MindooTenant, source: MindooTenant, dbId: string): Promise<void> {
  const targetDb = await target.openDB(dbId);
  const sourceDb = await source.openDB(dbId);
  await sourceDb.pushChangesTo(targetDb.getStore());
  await targetDb.syncStoreChanges();
}

function hiddenCount(db: MindooDB): number {
  return db.getInaccessibleDocumentCount!();
}

describe("inaccessible document count", () => {
  jest.setTimeout(60000);

  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-hidden-count";
  const namedKeyId = "project-key";
  const adminPassword = "admin-pass-123";
  const creatorPassword = "creator-pass-123";
  const readerPassword = "reader-pass-123";

  let admin: PrivateUserId;
  let creator: PrivateUserId;
  let reader: PrivateUserId;
  let creatorKeyBag: KeyBag;
  let readerKeyBag: KeyBag;
  let creatorTenant: MindooTenant;
  let readerTenant: MindooTenant;
  let readerFactory: BaseMindooTenantFactory;
  let readerDb: MindooDB;
  let cacheStore: InMemoryLocalCacheStore;
  let openDocId: string;
  let hiddenDocIds: string[];

  beforeEach(async () => {
    cacheStore = new InMemoryLocalCacheStore();
    const factory = new BaseMindooTenantFactory(new PersistentInMemoryStoreFactory(), crypto);
    readerFactory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
      undefined,
      cacheStore,
    );

    admin = await factory.createUserId("CN=admin/O=hidden", adminPassword);
    creator = await factory.createUserId("CN=creator/O=hidden", creatorPassword);
    reader = await readerFactory.createUserId("CN=reader/O=hidden", readerPassword);

    creatorKeyBag = new KeyBag(creator.userEncryptionKeyPair.privateKey, creatorPassword, crypto);
    readerKeyBag = new KeyBag(reader.userEncryptionKeyPair.privateKey, readerPassword, crypto);
    await creatorKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await creatorKeyBag.createTenantKey(tenantId);
    await creatorKeyBag.createDocKey(tenantId, namedKeyId);

    // The reader gets the baseline keys, never the named one.
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

    const creatorDb = await creatorTenant.openDB("projects");
    const open = await creatorDb.createDocument();
    openDocId = open.getId();
    await creatorDb.changeDoc(open, (doc: MindooDoc) => {
      doc.getData().title = "Everyone can read this";
    });
    hiddenDocIds = [];
    for (const title of ["Hidden one", "Hidden two"]) {
      const hidden = await creatorDb.createDocument({ decryptionKeyId: namedKeyId });
      hiddenDocIds.push(hidden.getId());
      await creatorDb.changeDoc(hidden, (doc: MindooDoc) => {
        doc.getData().title = title;
      });
    }

    readerTenant = await readerFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      reader,
      readerPassword,
      readerKeyBag,
    );
    await syncTenantDb(readerTenant, creatorTenant, "directory");
    readerDb = await readerTenant.openDB("projects");
    await syncTenantDb(readerTenant, creatorTenant, "projects");
  }, 60000);

  afterEach(async () => {
    await (creatorTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    await (readerTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  interface TenantInternals {
    cacheManager: CacheManager | null;
    databaseCache: Map<string, unknown>;
  }

  /** Restart the reader app: drop the in-memory DBs, keep stores and cache. */
  async function restartReader(): Promise<MindooDB> {
    const internals = readerTenant as unknown as TenantInternals;
    await internals.cacheManager!.flush();
    await internals.cacheManager!.dispose();
    swapCacheManager(internals);
    return readerTenant.openDB("projects");
  }

  /**
   * Restart WITHOUT flushing, so a checkpoint edited on "disk" survives instead
   * of being overwritten by the state still held in memory.
   */
  async function restartReaderKeepingCheckpoint(): Promise<MindooDB> {
    const internals = readerTenant as unknown as TenantInternals;
    const stale = internals.cacheManager as unknown as { timer: unknown; disposed: boolean };
    if (stale.timer) {
      clearTimeout(stale.timer as ReturnType<typeof setTimeout>);
      stale.timer = null;
    }
    stale.disposed = true;
    swapCacheManager(internals);
    return readerTenant.openDB("projects");
  }

  function swapCacheManager(internals: TenantInternals): void {
    const store = internals.cacheManager!.getStore();
    internals.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    internals.databaseCache.clear();
  }

  it("counts documents that were never readable here, which no listing reveals", async () => {
    expect(await readerDb.getAllDocumentIds()).toEqual([openDocId]);
    expect(await readerDb.getDeletedDocumentIds()).toEqual([]);
    expect(hiddenCount(readerDb)).toBe(2);
    // The creator holds the key for all three, so nothing is hidden there.
    expect(hiddenCount(await creatorTenant.openDB("projects"))).toBe(0);
  });

  it("drops back to zero once the key arrives and the documents surface", async () => {
    await readerKeyBag.set(
      "doc",
      tenantId,
      namedKeyId,
      (await creatorKeyBag.get("doc", tenantId, namedKeyId))!,
    );
    await readerTenant.reconcileKeyBagChanges?.();

    expect((await readerDb.getAllDocumentIds()).sort()).toEqual([openDocId, ...hiddenDocIds].sort());
    expect(hiddenCount(readerDb)).toBe(0);
  });

  it("counts a document that loses its key, and forgets it when access returns", async () => {
    await readerKeyBag.set(
      "doc",
      tenantId,
      namedKeyId,
      (await creatorKeyBag.get("doc", tenantId, namedKeyId))!,
    );
    await readerTenant.reconcileKeyBagChanges?.();
    expect(hiddenCount(readerDb)).toBe(0);

    await (
      readerTenant as unknown as { removeNamedDecryptionKey(keyId: string): Promise<boolean> }
    ).removeNamedDecryptionKey(namedKeyId);
    await readerTenant.reconcileKeyBagChanges?.();

    expect(await readerDb.getAllDocumentIds()).toEqual([openDocId]);
    expect(hiddenCount(readerDb)).toBe(2);
  });

  it("survives a restart that skips the visibility scan because the KeyBag is unchanged", async () => {
    const restarted = await restartReader();

    // Nothing forced a rescan here - an in-memory-only tally would read zero.
    expect(await restarted.getAllDocumentIds()).toEqual([openDocId]);
    expect(hiddenCount(restarted)).toBe(2);
  });

  it("rebuilds the tally at open for a checkpoint written before it existed", async () => {
    await restartReader();

    const metaKey = (await cacheStore.list("db-meta")).find((key) => key.endsWith("/projects"));
    expect(metaKey).toBeTruthy();
    const encryptedCache = new EncryptedLocalCacheStore(cacheStore, readerPassword, crypto);
    const rawMeta = await encryptedCache.get("db-meta", metaKey!);
    expect(rawMeta).toBeTruthy();
    const checkpoint = JSON.parse(new TextDecoder().decode(rawMeta!)) as Record<string, unknown>;
    expect(checkpoint.inaccessibleDocIds).toEqual(expect.arrayContaining(hiddenDocIds));
    delete checkpoint.inaccessibleDocIds;
    await encryptedCache.put("db-meta", metaKey!, new TextEncoder().encode(JSON.stringify(checkpoint)));

    // The KeyBag has not changed, so only the missing field can force the scan
    // that rebuilds the tally.
    const restarted = await restartReaderKeepingCheckpoint();
    expect(hiddenCount(restarted)).toBe(2);
  });
});
