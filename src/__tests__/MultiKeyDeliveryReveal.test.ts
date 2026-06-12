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
import type { KeyDistributionRequest } from "../core/accesscontrol/types";
import { encodeKeyDistributionRequest, decodeKeyDistributionRequest } from "../core/uri/MindooURI";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

// One isolated store namespace per tenant (creator vs reader each get their own
// instance). Replicas converge only through explicit pull-sync, mirroring two
// real devices that share keys but not storage.
class InMemoryStoreFactory implements ContentAddressedStoreFactory {
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
 * Ferry one isolated tenant's database (the `"directory"` or a data DB) into
 * another via the public push/pull-changes API, then materialize. Models a
 * one-way sync between two replicas that share keys but not stores.
 *
 * Uses `source.pushChangesTo(targetStore)` rather than
 * `target.pullChangesFrom(...)` on purpose: a directory PULL fires the SDK's
 * after-pull `reconcileKeyDistributionsForCurrentUserSafe()` (BaseMindooDB
 * §13), which would race the test's explicit reconcile and swallow its
 * imported/removed result. A push only transfers entries, leaving the
 * tenant-owned reconcile as the single, authoritative reconcile call.
 */
async function syncTenantDb(
  target: MindooTenant,
  source: MindooTenant,
  dbId: string,
): Promise<void> {
  const targetDb = await target.openDB(dbId);
  const sourceDb = await source.openDB(dbId);
  await sourceDb.pushChangesTo(targetDb.getStore());
  await targetDb.syncStoreChanges();
}

/**
 * End-to-end key DISTRIBUTION (the declarative, admin-blind successor to key
 * delivery) + reveal-on-add + version-scoped pull.
 *
 * User1 (creator/key-holder) holds TWO versions of one `keyId` and encrypts a
 * different document under each (rotation). User2 (reader) initially has
 * neither version, so the encrypted docs are invisible. User1 wraps the key to
 * the reader's devices, an admin publishes the `acl_keydistribution_<keyId>`
 * document, and the reader reconciles on sync — at which point BOTH documents
 * surface, because the manifest carries every version and decryption tries them
 * all. A later `pullfrom` revocation deletes exactly the manifest versions and
 * crypto-shreds the scope.
 */
describe("key distribution reveals rotated-key documents end-to-end", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-multikey-delivery";
  const namedKeyId = "shared-project-key";
  const adminPassword = "admin-pass-123";
  const creatorPassword = "creator-pass-123";
  const readerPassword = "reader-pass-123";

  type DistributionDirectory = MindooTenant extends { openDirectory(): Promise<infer D> } ? D : never;

  let factory: BaseMindooTenantFactory;
  let readerFactory: BaseMindooTenantFactory;
  let creatorStore: InMemoryStoreFactory;
  let readerStore: InMemoryStoreFactory;
  let cacheStore: InMemoryLocalCacheStore;

  let admin: PrivateUserId;
  let creator: PrivateUserId;
  let reader: PrivateUserId;
  let creatorKeyBag: KeyBag;
  let readerKeyBag: KeyBag;

  let creatorTenant: MindooTenant;
  let readerTenant: MindooTenant;
  let creatorDir: DistributionDirectory;
  let creatorDb: MindooDB;
  let readerDb: MindooDB;

  let docV1Id: string;
  let docV2Id: string;

  /** Build a full distribution request (all versions to all of the reader's devices). */
  async function buildRequest(
    dir: DistributionDirectory,
    pushUsernames: string[],
    pullUsernames: string[],
  ): Promise<KeyDistributionRequest> {
    const keyVersions = await dir.getKeyVersionManifest!(namedKeyId);
    const pushto = [];
    for (const username of pushUsernames) {
      pushto.push(await dir.wrapKeyForUserDevices!(namedKeyId, username));
    }
    const pullfrom = [];
    for (const username of pullUsernames) {
      pullfrom.push({ username, username_hash: await dir.getUsernameHash!(username) });
    }
    return {
      v: 1,
      tenantId,
      keyId: namedKeyId,
      keyVersions,
      title: namedKeyId,
      preparedByPublicKey: creator.userSigningKeyPair.publicKey,
      pushto,
      pullfrom,
    };
  }

  /**
   * Reconcile the reader's KeyBag the production way: pull the latest directory
   * head from the creator's replica, then drive the tenant-owned
   * `reconcileKeyDistributionsForCurrentUser()` (which sources the RSA session
   * key from the tenant itself — no foreign key, no password prompt).
   */
  async function reconcileReader() {
    await syncTenantDb(readerTenant, creatorTenant, "directory");
    return readerTenant.reconcileKeyDistributionsForCurrentUser!();
  }

  beforeEach(async () => {
    creatorStore = new InMemoryStoreFactory();
    readerStore = new InMemoryStoreFactory();
    cacheStore = new InMemoryLocalCacheStore();
    factory = new BaseMindooTenantFactory(creatorStore, crypto);
    readerFactory = new BaseMindooTenantFactory(readerStore, crypto, undefined, cacheStore);

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
    creatorDir = directory as DistributionDirectory;

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

    // Reader opens the tenant on its OWN isolated store, then pulls the
    // creator's directory (so its user is recognized) and the still-encrypted
    // project data from the creator replica.
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

    // Warm the reader's directory once on the (still distribution-free) head so
    // the one-time bring-up reconcile (getDirectoryDB §13) fires here as a
    // no-op, leaving each test's reconcileReader() as the sole authoritative
    // reconcile.
    await readerTenant.reconcileKeyDistributionsForCurrentUser?.();
  }, 60000);

  afterEach(async () => {
    await (creatorTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    await (readerTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("creator (key-holder) can read documents encrypted under both key versions", async () => {
    expect((await creatorDb.getDocument(docV1Id)).getData().title).toBe("Encrypted under v1");
    expect((await creatorDb.getDocument(docV2Id)).getData().title).toBe("Encrypted under v2");
  }, 60000);

  it("wraps every version to every device and the manifest matches the KeyBag", async () => {
    const request = await buildRequest(creatorDir, [reader.username], []);
    expect(request.keyVersions).toHaveLength(2);
    expect(request.pushto).toHaveLength(1);
    const recipient = request.pushto[0];
    const deviceFps = Object.keys(recipient.devices);
    expect(deviceFps).toHaveLength(1); // reader has one device
    // The single device entry must cover EXACTLY the manifest versions.
    const manifestFps = request.keyVersions.map((v) => v.fingerprint).sort();
    expect(Object.keys(recipient.devices[deviceFps[0]]).sort()).toEqual(manifestFps);
  }, 60000);

  it("round-trips the request through an mdb://key-distribution URI", async () => {
    const request = await buildRequest(creatorDir, [reader.username], []);
    const uri = encodeKeyDistributionRequest(request);
    expect(uri).toMatch(/^mdb:\/\/key-distribution\//);
    expect(decodeKeyDistributionRequest(uri)).toEqual(request);
  }, 60000);

  it("reader cannot see the docs until the key is distributed, then both appear", async () => {
    // 1. Reader has no named key yet -> the encrypted docs are invisible.
    expect(await readerDb.getAllDocumentIds()).toEqual([]);

    // 2. Creator wraps to the reader's devices; 3. admin publishes (admin-blind).
    const request = await buildRequest(creatorDir, [reader.username], []);
    await creatorDir.publishKeyDistribution!(request, admin.userSigningKeyPair.privateKey, adminPassword);

    // 4. Reader reconciles its KeyBag against the directory head on sync.
    const result = await reconcileReader();
    expect(result.imported).toEqual([namedKeyId]);

    // The reader now holds both versions of the key...
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(2);

    // 5. ...and BOTH documents surface via reveal-on-add, decryptable despite
    //    being encrypted under different versions.
    expect((await readerDb.getAllDocumentIds()).sort()).toEqual([docV1Id, docV2Id].sort());
    expect((await readerDb.getDocument(docV1Id)).getData().title).toBe("Encrypted under v1");
    expect((await readerDb.getDocument(docV2Id)).getData().title).toBe("Encrypted under v2");

    // Reconcile is idempotent: a second pass imports nothing new.
    const again = await reconcileReader();
    expect(again.imported).toEqual([]);

    // 6. Revoke via pullfrom: the admin republishes the distribution with the
    //    reader moved from pushto to pullfrom (version-scoped removal).
    const revoke = await buildRequest(creatorDir, [], [reader.username]);
    await creatorDir.publishKeyDistribution!(revoke, admin.userSigningKeyPair.privateKey, adminPassword);

    const pull = await reconcileReader();
    expect(pull.removed).toEqual([namedKeyId]);

    // The directory-sync path drives visibility reconcile in production.
    await (readerDb as unknown as { reconcileKeyVisibility: () => Promise<void> }).reconcileKeyVisibility();

    // 7. Both docs disappear locally and the named key's versions are gone; the
    //    tenant default key stays intact (protected).
    expect(await readerDb.getAllDocumentIds()).toEqual([]);
    await expect(readerDb.getDocument(docV1Id)).rejects.toThrow(`Document ${docV1Id} not found`);
    await expect(readerDb.getDocument(docV2Id)).rejects.toThrow(`Document ${docV2Id} not found`);
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(0);
    expect(await readerKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID)).toBeTruthy();
  }, 60000);

  it("pull is whole-key: revocation removes every same-id version (incl. ones obtained elsewhere)", async () => {
    // Distribute both versions, reader imports them.
    const request = await buildRequest(creatorDir, [reader.username], []);
    await creatorDir.publishKeyDistribution!(request, admin.userSigningKeyPair.privateKey, adminPassword);
    const readerDir = (await readerTenant.openDirectory()) as DistributionDirectory;
    await reconcileReader();
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(2);

    // The reader independently obtains a THIRD version of the same key id (e.g.
    // via shared-password export) — NOT part of the distribution manifest.
    await readerKeyBag.set("doc", tenantId, namedKeyId, new Uint8Array(32).fill(7), Date.now() + 5_000);
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(3);

    // Pull (revoke) is now WHOLE-KEY: `removeNamedDecryptionKey(keyId)` drops the
    // entire key id from the bag, so all three versions — including the
    // independently-obtained one — are removed. The revoked key id is the unit of
    // revocation (docs/accesscontrol.md §13.4/§13.6), matching the server-side
    // per-key-id blacklist.
    const revoke = await buildRequest(creatorDir, [], [reader.username]);
    await creatorDir.publishKeyDistribution!(revoke, admin.userSigningKeyPair.privateKey, adminPassword);
    const pull = await reconcileReader();
    expect(pull.removed).toEqual([namedKeyId]);
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(0);

    // The revoked key id is also reported by the server-blacklist resolver.
    expect(await readerDir.getRevokedDecryptionKeyIdsForUser!(reader.username)).toEqual([namedKeyId]);
  }, 60000);

  it("auto-reconciles the current user's KeyBag on directory bring-up (no explicit reconcile call)", async () => {
    // Grant: admin publishes a distribution that pushes the key to the reader.
    const request = await buildRequest(creatorDir, [reader.username], []);
    await creatorDir.publishKeyDistribution!(request, admin.userSigningKeyPair.privateKey, adminPassword);

    // Drive the SDK reconcile the way bring-up / after-pull does: pull the
    // directory head, then the tenant-owned reconcile sources the encryption key
    // from its own session (getEncryptionPrivateKeyForReconcile) — no foreign key.
    await reconcileReader();

    // The key was imported and both docs are now visible.
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(2);
    expect((await readerDb.getAllDocumentIds()).sort()).toEqual([docV1Id, docV2Id].sort());

    // Revoke: republish with the reader in pullfrom, then reconcile again.
    const revoke = await buildRequest(creatorDir, [], [reader.username]);
    await creatorDir.publishKeyDistribution!(revoke, admin.userSigningKeyPair.privateKey, adminPassword);
    await reconcileReader();
    await (readerDb as unknown as { reconcileKeyVisibility: () => Promise<void> }).reconcileKeyVisibility();

    // The revoke pass removed the key and the docs are forgotten again.
    expect(await readerKeyBag.getAllKeys("doc", tenantId, namedKeyId)).toHaveLength(0);
    expect(await readerDb.getAllDocumentIds()).toEqual([]);
  }, 60000);

  it("a $publicinfos-only sync server resolves the revoked-key blacklist by signing key, in hash space (§13)", async () => {
    // Admin publishes a distribution that revokes (pullfrom) the reader from the
    // key, so `acl_keydistribution_<keyId>.pullfrom_users_hashes` carries the
    // reader's write-hash.
    const revoke = await buildRequest(creatorDir, [], [reader.username]);
    await creatorDir.publishKeyDistribution!(revoke, admin.userSigningKeyPair.privateKey, adminPassword);

    // Simulate the real sync server: a tenant whose KeyBag holds ONLY the
    // $publicinfos key — never the tenant default key — exactly like
    // TenantManager.createDirectoryTenant. It can read the $publicinfos grant
    // fields (signing keys, username_hash, identity_hashes, pullfrom_users_hashes)
    // but can NEVER decrypt user_details_encrypted (written under "default").
    const serverPassword = "server-pass-123";
    const serverUser = await factory.createUserId("CN=syncserver/O=multikey", serverPassword);
    const serverKeyBag = new KeyBag(serverUser.userEncryptionKeyPair.privateKey, serverPassword, crypto);
    await serverKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await creatorKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    const serverTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      serverUser,
      serverPassword,
      serverKeyBag,
    );

    try {
      const serverDir = (await serverTenant.openDirectory()) as DistributionDirectory;

      // Realism check: with no default key the server cannot read the cleartext
      // name, so the lookup degrades to the bare username_hash (details === null,
      // username !== cleartext) — yet the $publicinfos-readable identity_hashes
      // bundle IS available.
      const serverLookup = await serverDir.getUserBySigningPublicKey(reader.userSigningKeyPair.publicKey);
      expect(serverLookup).not.toBeNull();
      expect(serverLookup!.details).toBeNull();
      expect(serverLookup!.username).not.toBe(reader.username);
      expect(serverLookup!.identityHashes!.length).toBeGreaterThan(0);

      // The signing-key resolver matches purely in hash space via the bundle: the
      // revoked key id is reported even though the server never sees the cleartext.
      expect(
        await serverDir.getRevokedDecryptionKeyIdsForSigningKey!(reader.userSigningKeyPair.publicKey),
      ).toEqual([namedKeyId]);

      // Regression guard for the original bug: routing the server's bare
      // username_hash through the username-based resolver re-hashes it (hash of a
      // hash) and matches nothing — which is exactly why the signing-key path must
      // use the precomputed bundle rather than a resolved "username".
      expect(
        await serverDir.getRevokedDecryptionKeyIdsForUser!(serverLookup!.username),
      ).toEqual([]);
    } finally {
      await (serverTenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    }
  }, 60000);
});
