import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { BaseMindooDB } from "../core/BaseMindooDB";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { EncryptedLocalCacheStore } from "../core/cache/EncryptedLocalCacheStore";
import { KeyBag } from "../core/keys/KeyBag";
import {
  MindooTenant,
  MindooDoc,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  PrivateUserId,
  AttachmentReference,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { CacheManager } from "../core/cache/CacheManager";

/**
 * A store factory that caches and returns the same store instance for
 * a given dbId, simulating persistent storage across re-opens.
 */
class PersistentInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    let store = this.stores.get(dbId);
    if (!store) {
      store = new InMemoryContentAddressedStore(dbId, undefined, options);
      this.stores.set(dbId, store);
    }
    return { docStore: store };
  }
}

/**
 * Integration tests that verify BaseMindooDB correctly uses the local cache:
 * - Populate a DB, flush the cache, re-open, verify cache-based restore
 * - Verify delta-only processing when new entries arrive after cache
 * - Verify that the cache is actually written (not empty)
 */
describe("BaseMindooDB cache integration", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "test-cache-tenant";
  const adminPassword = "adminpass";
  const userPassword = "userpass";

  let cacheStore: InMemoryLocalCacheStore;
  let factory: BaseMindooTenantFactory;
  let tenant: MindooTenant;
  let adminUser: PrivateUserId;
  let appUser: PrivateUserId;
  let keyBag: KeyBag;
  let remoteTenant: MindooTenant | undefined;

  beforeEach(async () => {
    cacheStore = new InMemoryLocalCacheStore();
    factory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
      undefined,
      cacheStore,
    );

    const result = await factory.createTenant({
      tenantId,
      adminName: "CN=admin/O=test",
      adminPassword,
      userName: "CN=user/O=test",
      userPassword,
    });
    tenant = result.tenant;
    adminUser = result.adminUser;
    appUser = result.appUser;
    keyBag = result.keyBag;
  }, 30000);

  afterEach(async () => {
    await (tenant as any).disposeCacheManager?.();
    await (remoteTenant as any)?.disposeCacheManager?.();
  });

  /**
   * Simulate an app restart: dispose the tenant's cache manager (flush + stop timer),
   * then clear the tenant's internal DB cache so openDB creates a fresh BaseMindooDB.
   */
  async function simulateRestart(): Promise<void> {
    const t = tenant as any;
    if (t.cacheManager) {
      await (t.cacheManager as CacheManager).dispose();
      const store = (t.cacheManager as CacheManager).getStore();
      t.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    }
    t.databaseCache.clear();
  }

  function simulateRestartWithoutFlush(): void {
    const t = tenant as any;
    if (t.cacheManager) {
      const oldManager = t.cacheManager as any;
      if (oldManager.timer) {
        clearTimeout(oldManager.timer);
        oldManager.timer = null;
      }
      oldManager.disposed = true;
      const store = oldManager.getStore();
      t.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    }
    t.databaseCache.clear();
  }

  async function loadContactsCheckpoint() {
    const metaKey = (await cacheStore.list("db-meta")).find((key) => key.endsWith("/contacts"));
    expect(metaKey).toBeTruthy();
    const encryptedCacheStore = new EncryptedLocalCacheStore(cacheStore, userPassword, crypto);
    const rawMeta = await encryptedCacheStore.get("db-meta", metaKey!);
    expect(rawMeta).toBeTruthy();
    const checkpoint = JSON.parse(new TextDecoder().decode(rawMeta!)) as {
      processedEntryCursor?: { receiptOrder: number; id: string } | null;
      index: Array<{ docId: string }>;
    };
    return { metaKey: metaKey!, encryptedCacheStore, checkpoint };
  }

  async function createRemoteTenant(): Promise<MindooTenant> {
    const remoteFactory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
    );
    const remoteKeyBag = new KeyBag(
      appUser.userEncryptionKeyPair.privateKey,
      userPassword,
      crypto,
    );

    const publicInfosKey = await keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID);
    const tenantKey = await keyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID);
    expect(publicInfosKey).toBeTruthy();
    expect(tenantKey).toBeTruthy();

    await remoteKeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey!);
    await remoteKeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey!);

    remoteTenant = await remoteFactory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      appUser,
      userPassword,
      remoteKeyBag,
    );

    const localDirectory = await tenant.openDB("directory");
    const remoteDirectory = await remoteTenant.openDB("directory");
    await remoteDirectory.pullChangesFrom(localDirectory.getStore());

    return remoteTenant;
  }

  function summarizeAttachments(doc: MindooDoc): Array<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    size: number;
    lastChunkId: string;
  }> {
    const attachments = ((doc.getData()._attachments as AttachmentReference[] | undefined) ?? [])
      .map((attachment) => ({
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        lastChunkId: attachment.lastChunkId,
      }))
      .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));

    expect(doc.getAttachments().map((attachment) => attachment.attachmentId).sort()).toEqual(
      attachments.map((attachment) => attachment.attachmentId),
    );

    return attachments;
  }

  it("should write cache entries when a document is created and flushed", async () => {
    const db = await tenant.openDB("testdb");

    const doc = await db.createDocument();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "Hello Cache";
    });

    expect(await cacheStore.list("doc")).toEqual([]);
    expect(await cacheStore.list("db-meta")).toEqual([]);

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    expect(cacheManager).toBeTruthy();
    await cacheManager.flush();

    const docIds = await cacheStore.list("doc");
    expect(docIds.length).toBeGreaterThanOrEqual(1);
    const metaIds = await cacheStore.list("db-meta");
    expect(metaIds.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("should restore a DB from cache instead of full rebuild", async () => {
    const db = await tenant.openDB("contacts");

    const doc1 = await db.createDocument();
    const doc1Id = doc1.getId();
    await db.changeDoc(doc1, (d: MindooDoc) => {
      const data = d.getData();
      data.name = "Alice";
      data.email = "alice@example.com";
    });

    const doc2 = await db.createDocument();
    const doc2Id = doc2.getId();
    await db.changeDoc(doc2, (d: MindooDoc) => {
      const data = d.getData();
      data.name = "Bob";
      data.email = "bob@example.com";
    });

    await simulateRestart();

    const getSpy = jest.spyOn(cacheStore, "get");

    const db2 = await tenant.openDB("contacts");

    expect(getSpy).toHaveBeenCalled();
    const getTypes = getSpy.mock.calls.map(([type]) => type);
    expect(getTypes).toContain("db-meta");
    expect(getTypes).toContain("doc");

    const restoredDoc1 = await db2.getDocument(doc1Id);
    expect(restoredDoc1.getData().name).toBe("Alice");
    expect(restoredDoc1.getData().email).toBe("alice@example.com");

    const restoredDoc2 = await db2.getDocument(doc2Id);
    expect(restoredDoc2.getData().name).toBe("Bob");
    expect(restoredDoc2.getData().email).toBe("bob@example.com");

    getSpy.mockRestore();
  }, 30000);

  it("should process delta entries after cache restore", async () => {
    const db1 = await tenant.openDB("contacts");

    const doc1 = await db1.createDocument();
    const doc1Id = doc1.getId();
    await db1.changeDoc(doc1, (d: MindooDoc) => {
      d.getData().name = "Charlie";
    });

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    await cacheManager.flush();

    const doc2 = await db1.createDocument();
    const doc2Id = doc2.getId();
    await db1.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().name = "Diana";
    });

    await simulateRestart();

    const db2 = await tenant.openDB("contacts");

    const restored1 = await db2.getDocument(doc1Id);
    expect(restored1.getData().name).toBe("Charlie");

    const restored2 = await db2.getDocument(doc2Id);
    expect(restored2.getData().name).toBe("Diana");
  }, 30000);

  it("should operate normally when no LocalCacheStore is provided", async () => {
    const noCacheFactory = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
    );

    const result = await noCacheFactory.createTenant({
      tenantId: "plain-tenant",
      adminName: "CN=admin/O=test",
      adminPassword: "adminpw",
      userName: "CN=user/O=test",
      userPassword: "userpw",
    });

    expect((result.tenant as any).cacheManager).toBeNull();

    const db = await result.tenant.openDB("testdb");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "Works without cache";
    });

    expect(doc.getData().title).toBe("Works without cache");
  }, 30000);

  it("should update cache when documents are modified", async () => {
    const db = await tenant.openDB("mutable");

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().version = 1;
    });

    const cm = (tenant as any).cacheManager as CacheManager;
    await cm.flush();

    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().version = 2;
    });

    await simulateRestart();

    const db2 = await tenant.openDB("mutable");
    const rd = await db2.getDocument(docId);
    expect(rd.getData().version).toBe(2);
  }, 30000);

  it("should merge concurrent attachment additions across sync and restore merged attachments from cache", async () => {
    const otherTenant = await createRemoteTenant();

    const localDb = await tenant.openDB("contacts");
    const remoteDb = await otherTenant.openDB("contacts");

    const initialDoc = await localDb.createDocument();
    const docId = initialDoc.getId();
    await localDb.changeDoc(initialDoc, (d: MindooDoc) => {
      d.getData().title = "Shared attachment doc";
    });

    await remoteDb.pullChangesFrom(localDb.getStore());

    const localAttachmentData = new Uint8Array([1, 2, 3, 4]);
    const remoteAttachmentData = new Uint8Array([9, 8, 7, 6, 5]);
    let localAttachmentId = "";
    let remoteAttachmentId = "";

    await localDb.changeDoc(initialDoc, async (d: MindooDoc) => {
      const attachment = await d.addAttachment(localAttachmentData, "local.bin", "application/octet-stream");
      localAttachmentId = attachment.attachmentId;
    });

    const remoteInitialDoc = await remoteDb.getDocument(docId);
    await remoteDb.changeDoc(remoteInitialDoc, async (d: MindooDoc) => {
      const attachment = await d.addAttachment(remoteAttachmentData, "remote.bin", "application/octet-stream");
      remoteAttachmentId = attachment.attachmentId;
    });

    const divergentLocalDoc = await localDb.getDocument(docId);
    const divergentRemoteDoc = await remoteDb.getDocument(docId);
    expect(summarizeAttachments(divergentLocalDoc).map((attachment) => attachment.fileName)).toEqual(["local.bin"]);
    expect(summarizeAttachments(divergentRemoteDoc).map((attachment) => attachment.fileName)).toEqual(["remote.bin"]);

    await localDb.pushChangesTo(remoteDb.getStore());
    await remoteDb.syncStoreChanges();
    await localDb.pullChangesFrom(remoteDb.getStore());

    const mergedLocalDoc = await localDb.getDocument(docId);
    const mergedRemoteDoc = await remoteDb.getDocument(docId);
    const localSummary = summarizeAttachments(mergedLocalDoc);
    const remoteSummary = summarizeAttachments(mergedRemoteDoc);

    expect(localSummary).toEqual(remoteSummary);
    expect(localSummary.map((attachment) => attachment.fileName).sort()).toEqual(["local.bin", "remote.bin"]);

    expect(await mergedLocalDoc.getAttachment(localAttachmentId)).toEqual(localAttachmentData);
    expect(await mergedLocalDoc.getAttachment(remoteAttachmentId)).toEqual(remoteAttachmentData);
    expect(await mergedRemoteDoc.getAttachment(localAttachmentId)).toEqual(localAttachmentData);
    expect(await mergedRemoteDoc.getAttachment(remoteAttachmentId)).toEqual(remoteAttachmentData);

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    await cacheManager.flush();
    await simulateRestart();

    const getSpy = jest.spyOn(cacheStore, "get");
    const reopenedDb = await tenant.openDB("contacts");
    const restoredDoc = await reopenedDb.getDocument(docId);
    const restoredSummary = summarizeAttachments(restoredDoc);

    expect(getSpy).toHaveBeenCalled();
    expect(restoredSummary).toEqual(localSummary);
    expect(await restoredDoc.getAttachment(localAttachmentId)).toEqual(localAttachmentData);
    expect(await restoredDoc.getAttachment(remoteAttachmentId)).toEqual(remoteAttachmentData);

    getSpy.mockRestore();
  }, 30000);

  it("should discover pulled backfilled attachment changes older than the processed cursor", async () => {
    const otherTenant = await createRemoteTenant();

    const localDb = await tenant.openDB("contacts");
    const remoteDb = await otherTenant.openDB("contacts");

    const initialDoc = await localDb.createDocument();
    const docId = initialDoc.getId();
    await localDb.changeDoc(initialDoc, (d: MindooDoc) => {
      d.getData().title = "Backfilled attachment doc";
    });

    await remoteDb.pullChangesFrom(localDb.getStore());
    await remoteDb.syncStoreChanges();

    const remoteAttachmentData = new Uint8Array([9, 8, 7, 6, 5]);
    const localAttachmentData = new Uint8Array([1, 2, 3, 4]);
    let remoteAttachmentId = "";
    let localAttachmentId = "";

    const remoteInitialDoc = await remoteDb.getDocument(docId);
    await remoteDb.changeDoc(remoteInitialDoc, async (d: MindooDoc) => {
      const attachment = await d.addAttachment(remoteAttachmentData, "remote-first.bin", "application/octet-stream");
      remoteAttachmentId = attachment.attachmentId;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const localInitialDoc = await localDb.getDocument(docId);
    await localDb.changeDoc(localInitialDoc, async (d: MindooDoc) => {
      const attachment = await d.addAttachment(localAttachmentData, "local-second.bin", "application/octet-stream");
      localAttachmentId = attachment.attachmentId;
    });

    await localDb.pullChangesFrom(remoteDb.getStore());
    await localDb.syncStoreChanges();

    const mergedLocalDoc = await localDb.getDocument(docId);
    const mergedSummary = summarizeAttachments(mergedLocalDoc);

    expect(mergedSummary.map((attachment) => attachment.fileName).sort()).toEqual([
      "local-second.bin",
      "remote-first.bin",
    ]);
    expect(await mergedLocalDoc.getAttachment(localAttachmentId)).toEqual(localAttachmentData);
    expect(await mergedLocalDoc.getAttachment(remoteAttachmentId)).toEqual(remoteAttachmentData);
  }, 30000);

  it("should expose a stale cache checkpoint when reconcileRestoredIndexOnInit is disabled", async () => {
    const db1 = await tenant.openDB("contacts");

    const doc1 = await db1.createDocument();
    const doc1Id = doc1.getId();
    await db1.changeDoc(doc1, (d: MindooDoc) => {
      d.getData().name = "Charlie";
    });

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    await cacheManager.flush();

    const doc2 = await db1.createDocument();
    const doc2Id = doc2.getId();
    await db1.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().name = "Diana";
    });

    const store = db1.getStore();
    let cursor: { receiptOrder: number; id: string } | null = null;
    while (true) {
      const page = await store.scanEntriesSince!(cursor, 1000);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    const { metaKey, encryptedCacheStore, checkpoint } = await loadContactsCheckpoint();
    checkpoint.processedEntryCursor = cursor;
    expect(checkpoint.index.map((entry) => entry.docId)).toEqual([doc1Id]);
    await encryptedCacheStore.put("db-meta", metaKey, new TextEncoder().encode(JSON.stringify(checkpoint)));

    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("contacts", {
      documentCacheConfig: {
        reconcileRestoredIndexOnInit: false,
      },
    });
    expect(await db2.getAllDocumentIds()).toEqual([doc1Id]);
  }, 30000);

  it("should rebuild metadata when reconcileRestoredIndexOnInit is enabled", async () => {
    const db1 = await tenant.openDB("contacts");

    const doc1 = await db1.createDocument();
    const doc1Id = doc1.getId();
    await db1.changeDoc(doc1, (d: MindooDoc) => {
      d.getData().name = "Charlie";
    });

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    await cacheManager.flush();

    const doc2 = await db1.createDocument();
    const doc2Id = doc2.getId();
    await db1.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().name = "Diana";
    });

    const store = db1.getStore();
    let cursor: { receiptOrder: number; id: string } | null = null;
    while (true) {
      const page = await store.scanEntriesSince!(cursor, 1000);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }

    const { metaKey, encryptedCacheStore, checkpoint } = await loadContactsCheckpoint();
    checkpoint.processedEntryCursor = cursor;
    expect(checkpoint.index.map((entry) => entry.docId)).toEqual([doc1Id]);
    await encryptedCacheStore.put("db-meta", metaKey, new TextEncoder().encode(JSON.stringify(checkpoint)));

    simulateRestartWithoutFlush();

    const db2 = await tenant.openDB("contacts", {
      documentCacheConfig: {
        reconcileRestoredIndexOnInit: true,
      },
    });
    expect(await db2.getAllDocumentIds()).toEqual([doc1Id, doc2Id].sort((left, right) => left.localeCompare(right)));

    const restored1 = await db2.getDocument(doc1Id);
    expect(restored1.getData().name).toBe("Charlie");

    const restored2 = await db2.getDocument(doc2Id);
    expect(restored2.getData().name).toBe("Diana");
  }, 30000);

  it("should not commit processedEntryCursor when sync processing fails", async () => {
    const db1 = await tenant.openDB("contacts");

    const doc1 = await db1.createDocument();
    await db1.changeDoc(doc1, (d: MindooDoc) => {
      d.getData().name = "Charlie";
    });

    const cacheManager = (tenant as any).cacheManager as CacheManager;
    await cacheManager.flush();

    const doc2 = await db1.createDocument();
    const doc2Id = doc2.getId();
    await db1.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().name = "Diana";
    });

    simulateRestartWithoutFlush();

    const db2 = new BaseMindooDB(
      tenant as any,
      db1.getStore(),
      db1.getAttachmentStore(),
      undefined,
      {
        reconcileRestoredIndexOnInit: false,
      },
    );
    const restartedCacheManager = (tenant as any).cacheManager as CacheManager;
    db2.setCacheManager(restartedCacheManager);
    const restored = await (db2 as any).restoreFromCache(restartedCacheManager.getStore());
    expect(restored).toBe(true);

    const beforeCursor = (db2 as any).processedEntryCursor;
    const originalHasDecryptionKey = (tenant as any).hasDecryptionKey.bind(tenant);
    (tenant as any).hasDecryptionKey = jest.fn(async () => {
      throw new Error(`boom:${doc2Id}`);
    });

    try {
      await expect((db2 as any).syncStoreChanges()).rejects.toThrow(`boom:${doc2Id}`);
      expect((db2 as any).processedEntryCursor).toEqual(beforeCursor);
    } finally {
      (tenant as any).hasDecryptionKey = originalHasDecryptionKey;
    }
  }, 30000);
});
