import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { EncryptedLocalCacheStore } from "../core/cache/EncryptedLocalCacheStore";
import { CacheManager } from "../core/cache/CacheManager";
import { KeyBag } from "../core/keys/KeyBag";
import {
  MindooTenant,
  MindooDB,
  PrivateUserId,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  StoreEntry,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Regression tests for the "delayed directory sync" healing path
 * (reconcileAuthorTrust): a client receives entries of a tenant member whose
 * grantaccess document has not arrived locally yet. The entries land in the
 * local append-only store but materialization skips them (author key not
 * trusted by the directory). Once the directory sync delivers the
 * grantaccess, the previously skipped entries must be re-materialized —
 * live (open DB), across a restart (open-time reconcile) and on legacy
 * devices whose checkpoint predates the pendingUntrustedAuthors field.
 */

/**
 * Store factory that returns the same store instance per dbId, simulating
 * persistent storage across simulated app restarts.
 */
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
      attachmentStore = new InMemoryContentAddressedStore(
        dbId,
        StoreKind.attachments,
        undefined,
        options,
      );
      this.attachmentStores.set(dbId, attachmentStore);
    }
    return { docStore, attachmentStore };
  }
}

interface TestSetup {
  tenantA: MindooTenant;
  tenantB: MindooTenant;
  userA: PrivateUserId;
  userB: PrivateUserId;
  adminUser: PrivateUserId;
  cacheStoreA: InMemoryLocalCacheStore;
}

describe("author-trust reconcile after delayed directory sync", () => {
  jest.setTimeout(60000);

  const crypto = new NodeCryptoAdapter();
  const tenantId = "trust-heal-tenant";
  const adminPassword = "adminpass123";
  const userAPassword = "userApass123";
  const userBPassword = "userBpass123";

  let setup: TestSetup;

  beforeEach(async () => {
    // --- Client A: tenant owner side (with a local cache so restart
    // scenarios can restore from a checkpoint). ---
    const cacheStoreA = new InMemoryLocalCacheStore();
    const factoryA = new BaseMindooTenantFactory(
      new PersistentInMemoryStoreFactory(),
      crypto,
      undefined,
      cacheStoreA,
    );
    const created = await factoryA.createTenant({
      tenantId,
      adminName: "CN=admin/O=trusttest",
      adminPassword,
      userName: "CN=userA/O=trusttest",
      userPassword: userAPassword,
    });
    const tenantA = created.tenant;
    const adminUser = created.adminUser;
    const userA = created.appUser;

    // --- Client B: separate device/store. Registered in ITS directory copy
    // only, so client A does not know userB's signing key yet. ---
    const factoryB = new BaseMindooTenantFactory(new PersistentInMemoryStoreFactory(), crypto);
    const userB = await factoryB.createUserId("CN=userB/O=trusttest", userBPassword);
    const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, userBPassword, crypto);
    const tenantKey = (await created.keyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;
    const publicInfosKey = (await created.keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    await keyBagB.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);
    await keyBagB.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);

    const tenantB = await factoryB.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      userB,
      userBPassword,
      keyBagB,
    );

    // B first pulls A's directory (userA grant + default policy), then the
    // admin registers userB in B's directory copy ONLY. A's directory stays
    // stale — exactly the reported scenario.
    const directoryDbB = await tenantB.openDB("directory");
    await directoryDbB.pullChangesFrom((await tenantA.openDB("directory")).getStore());
    const directoryB = await tenantB.openDirectory();
    await directoryB.registerUser(
      factoryB.toPublicUserId(userB),
      adminUser.userSigningKeyPair.privateKey,
      adminPassword,
    );

    setup = { tenantA, tenantB, userA, userB, adminUser, cacheStoreA };
  });

  afterEach(async () => {
    await (setup.tenantA as any).disposeCacheManager?.();
    await (setup.tenantB as any).disposeCacheManager?.();
  });

  /** Loads the doc (triggering materialization) and reports whether the given field arrived. */
  async function docHasField(db: MindooDB, docId: string, field: string, value: unknown): Promise<boolean> {
    try {
      const doc = await db.getDocument(docId);
      return doc.getData()[field] === value;
    } catch {
      return false;
    }
  }

  function pendingMap(db: MindooDB): Map<string, Set<string>> {
    return (db as any).pendingUntrustedAuthors as Map<string, Set<string>>;
  }

  /** Creates a doc as userB on client B and returns its id. */
  async function createDocOnB(): Promise<{ docId: string; contactsB: MindooDB }> {
    const contactsB = await setup.tenantB.openDB("contacts");
    const doc = await contactsB.createDocument();
    await contactsB.changeDoc(doc, async (d) => {
      d.getData().name = "Bob";
    });
    return { docId: doc.getId(), contactsB };
  }

  async function simulateRestartA(): Promise<void> {
    const t = setup.tenantA as any;
    if (t.cacheManager) {
      await (t.cacheManager as CacheManager).dispose();
      const store = (t.cacheManager as CacheManager).getStore();
      t.cacheManager = new CacheManager(store, { flushIntervalMs: 60000 });
    }
    t.databaseCache.clear();
  }

  it("heals live: directory pull with the missing grantaccess re-materializes skipped entries and re-emits them on the changefeed", async () => {
    const { docId, contactsB } = await createDocOnB();

    // Client A receives userB's entries while its directory is stale.
    const contactsA = await setup.tenantA.openDB("contacts");
    await contactsA.pullChangesFrom(contactsB.getStore());

    // The entries ARE in the local store...
    const storeA = contactsA.getStore();
    const bEntryIds = await contactsB.getStore().getAllIds();
    expect(await storeA.hasEntries(bEntryIds)).toEqual(bEntryIds);

    // ...but materialization skips them (author unknown) and records the
    // author as pending.
    expect(await docHasField(contactsA, docId, "name", "Bob")).toBe(false);
    const pendingKeys = Array.from(pendingMap(contactsA).keys());
    expect(pendingKeys).toContain(setup.userB.userSigningKeyPair.publicKey);
    expect(pendingMap(contactsA).get(setup.userB.userSigningKeyPair.publicKey)).toContain(docId);

    // Baseline changeSeq of the (still stale) index entry, to prove the
    // heal bumps it for iterateChangesSince consumers (virtual views etc.).
    const indexBefore = ((contactsA as any).index as Array<{ docId: string; changeSeq: number }>)
      .find((entry) => entry.docId === docId);
    expect(indexBefore).toBeTruthy();
    const seqBefore = indexBefore!.changeSeq;

    const seenChangedDocIds: string[] = [];
    contactsA.addChangeListener?.((event) => {
      for (const change of event.changes) {
        seenChangedDocIds.push(change.docId);
      }
    });

    // The directory sync delivers the grantaccess for userB. The pull hook
    // refreshes the trust caches and reconciles author trust across open DBs.
    const directoryDbA = await setup.tenantA.openDB("directory");
    const directoryDbB = await setup.tenantB.openDB("directory");
    await directoryDbA.pullChangesFrom(directoryDbB.getStore());

    // The document materializes now, including userB's change.
    expect(await docHasField(contactsA, docId, "name", "Bob")).toBe(true);

    // Pending record is cleared and persisted state marked dirty.
    expect(pendingMap(contactsA).size).toBe(0);

    // The doc got force-re-emitted: changeSeq bumped and delivered by
    // iterateChangesSince from the pre-heal cursor.
    const indexAfter = ((contactsA as any).index as Array<{ docId: string; changeSeq: number }>)
      .find((entry) => entry.docId === docId);
    expect(indexAfter!.changeSeq).toBeGreaterThan(seqBefore);

    const reEmitted: string[] = [];
    for await (const result of contactsA.iterateChangesSince({
      changeSeq: seqBefore,
      lastModified: 0,
      docId: "",
    })) {
      reEmitted.push(result.doc.getId());
    }
    expect(reEmitted).toContain(docId);

    // Change listeners (virtual views, summaries, fulltext) got notified.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seenChangedDocIds).toContain(docId);
  });

  it("heals across a restart: directory sync while the content DB is closed, open-time reconcile re-materializes", async () => {
    const { docId, contactsB } = await createDocOnB();

    const contactsA = await setup.tenantA.openDB("contacts");
    await contactsA.pullChangesFrom(contactsB.getStore());
    // Trigger materialization so the skip is recorded as pending.
    expect(await docHasField(contactsA, docId, "name", "Bob")).toBe(false);
    expect(pendingMap(contactsA).size).toBeGreaterThan(0);

    // Persist the checkpoint (including pendingUntrustedAuthors) and restart.
    await ((setup.tenantA as any).cacheManager as CacheManager).flush();
    await simulateRestartA();

    // Directory sync happens while the content DB is NOT open.
    const directoryDbA = await setup.tenantA.openDB("directory");
    const directoryDbB = await setup.tenantB.openDB("directory");
    await directoryDbA.pullChangesFrom(directoryDbB.getStore());

    // Re-opening the content DB restores the pending map from the checkpoint
    // and runs the open-time reconcile against the now-updated directory.
    const contactsA2 = await setup.tenantA.openDB("contacts");
    expect(await docHasField(contactsA2, docId, "name", "Bob")).toBe(true);
    expect(pendingMap(contactsA2).size).toBe(0);
  });

  it("heals legacy devices: checkpoint without pendingUntrustedAuthors triggers the one-time scan for unapplied entries", async () => {
    const { docId, contactsB } = await createDocOnB();

    const contactsA = await setup.tenantA.openDB("contacts");
    await contactsA.pullChangesFrom(contactsB.getStore());
    expect(await docHasField(contactsA, docId, "name", "Bob")).toBe(false);

    await ((setup.tenantA as any).cacheManager as CacheManager).flush();
    await simulateRestartA();

    // Strip the pendingUntrustedAuthors field from the persisted checkpoint,
    // simulating a device whose skip happened on a build BEFORE this fix.
    const metaKey = (await setup.cacheStoreA.list("db-meta")).find((key) => key.endsWith("/contacts"));
    expect(metaKey).toBeTruthy();
    const encryptedCache = new EncryptedLocalCacheStore(setup.cacheStoreA, userAPassword, crypto);
    const rawMeta = await encryptedCache.get("db-meta", metaKey!);
    expect(rawMeta).toBeTruthy();
    const checkpoint = JSON.parse(new TextDecoder().decode(rawMeta!)) as Record<string, unknown>;
    expect(checkpoint.pendingUntrustedAuthors).toBeTruthy();
    delete checkpoint.pendingUntrustedAuthors;
    await encryptedCache.put(
      "db-meta",
      metaKey!,
      new TextEncoder().encode(JSON.stringify(checkpoint)),
    );

    // Directory has been synced in the meantime (like the affected test
    // device, where the directory was synced manually).
    const directoryDbA = await setup.tenantA.openDB("directory");
    const directoryDbB = await setup.tenantB.openDB("directory");
    await directoryDbA.pullChangesFrom(directoryDbB.getStore());

    // Opening the content DB detects the legacy checkpoint, scans for
    // unapplied store entries and heals them right away.
    const contactsA2 = await setup.tenantA.openDB("contacts");
    expect(await docHasField(contactsA2, docId, "name", "Bob")).toBe(true);
    expect(pendingMap(contactsA2).size).toBe(0);
  });

  it("does NOT materialize entries with a genuinely invalid signature after the author becomes trusted", async () => {
    const { docId, contactsB } = await createDocOnB();

    // Tamper userB's entries (signature + metadata signature) and inject
    // them directly into A's local store — as if corrupted data had been
    // synced in earlier.
    const storeB = contactsB.getStore();
    const entryIds = await storeB.getAllIds();
    const entries = await storeB.getEntries(entryIds);
    const tampered = entries.map((entry): StoreEntry => {
      const signature = new Uint8Array(entry.signature);
      if (signature.length > 0) {
        signature[0] = signature[0] ^ 0xff;
      }
      const metadataSignature = (entry as any).metadataSignature
        ? new Uint8Array((entry as any).metadataSignature as Uint8Array)
        : undefined;
      if (metadataSignature && metadataSignature.length > 0) {
        metadataSignature[0] = metadataSignature[0] ^ 0xff;
      }
      return {
        ...entry,
        signature,
        ...(metadataSignature ? { metadataSignature } : {}),
      } as StoreEntry;
    });

    const contactsA = await setup.tenantA.openDB("contacts");
    await contactsA.getStore().putEntries(tampered);
    await contactsA.syncStoreChanges();

    // Author unknown → skipped and recorded as pending.
    expect(await docHasField(contactsA, docId, "name", "Bob")).toBe(false);

    // Directory sync makes the author trusted...
    const directoryDbA = await setup.tenantA.openDB("directory");
    const directoryDbB = await setup.tenantB.openDB("directory");
    await directoryDbA.pullChangesFrom(directoryDbB.getStore());

    // ...but the tampered entries still fail signature verification and must
    // NOT be materialized by the heal.
    expect(await docHasField(contactsA, docId, "name", "Bob")).toBe(false);
  });
});
