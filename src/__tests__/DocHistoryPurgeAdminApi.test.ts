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
  MindooTenantDirectory,
} from "../core/types";
import type { DocHistoryPurgeRequest } from "../core/accesscontrol/types";
import {
  encodeDocHistoryPurgeRequest,
  decodeDocHistoryPurgeRequest,
} from "../core/uri/MindooURI";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

class IsolatedStoreFactory implements ContentAddressedStoreFactory {
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

/** Ferry one isolated tenant's directory into another via push, then materialize. */
async function syncTenantDb(target: MindooTenant, source: MindooTenant, dbId: string): Promise<void> {
  const targetDb = await target.openDB(dbId);
  const sourceDb = await source.openDB(dbId);
  await sourceDb.pushChangesTo(targetDb.getStore());
  await targetDb.syncStoreChanges();
}

/**
 * Tests for the document-history purge request authoring API
 * (docs/accesscontrol.md §13). The directory document is server-readable
 * ($publicinfos envelope with cleartext dbId + docIds); only `reason` is
 * encrypted with the tenant default key.
 */
describe("doc history purge admin API", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-purge";

  const adminPassword = "adminpass123";
  const alicePassword = "alicepass123";

  let aliceFactory: BaseMindooTenantFactory;
  let bobFactory: BaseMindooTenantFactory;

  let admin: PrivateUserId;
  let alice: PrivateUserId;

  let adminKb: KeyBag;
  let aliceKb: KeyBag;
  let bobKb: KeyBag;

  let publicInfosKey: Uint8Array;
  let tenantKey: Uint8Array;

  let aliceTenant: MindooTenant;
  let bobTenant: MindooTenant;

  let aliceDir: MindooTenantDirectory;
  // A "server" view that holds only the $publicinfos key (never the tenant
  // default key), to assert the routing fields are server-readable.
  let bobDir: MindooTenantDirectory;
  let bob: PrivateUserId;

  beforeEach(async () => {
    aliceFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);
    bobFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);

    admin = await aliceFactory.createUserId("CN=admin/O=purge", adminPassword);
    adminKb = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKb.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKb.createTenantKey(tenantId);
    publicInfosKey = (await adminKb.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    tenantKey = (await adminKb.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;

    alice = await aliceFactory.createUserId("CN=alice/O=purge", alicePassword);
    aliceKb = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, crypto);
    await aliceKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await aliceKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    // Bob models a $publicinfos-only principal (like the sync server): he holds
    // the public-infos key but NOT the tenant default key.
    bob = await bobFactory.createUserId("CN=bob/O=purge", "bobpass123");
    bobKb = new KeyBag(bob.userEncryptionKeyPair.privateKey, "bobpass123", crypto);
    await bobKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);

    aliceTenant = await aliceFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      aliceKb,
    );
    aliceDir = await aliceTenant.openDirectory();
    await aliceDir.registerUser(aliceFactory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    await aliceDir.registerUser(aliceFactory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);

    bobTenant = await bobFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      bob,
      "bobpass123",
      bobKb,
    );
    await syncTenantDb(bobTenant, aliceTenant, "directory");
    bobDir = await bobTenant.openDirectory();
  }, 60000);

  function buildRequest(overrides: Partial<DocHistoryPurgeRequest>): DocHistoryPurgeRequest {
    return {
      v: 1,
      tenantId,
      requestId: "req-1",
      dbId: "main",
      docIds: ["doc-1", "doc-2"],
      reason: "GDPR erasure",
      preparedByPublicKey: alice.userSigningKeyPair.publicKey,
      ...overrides,
    };
  }

  it("publishes a purge request; list decrypts reason and carries cleartext routing", async () => {
    await aliceDir.publishDocHistoryPurge!(buildRequest({}), admin.userSigningKeyPair.privateKey, adminPassword);

    const views = await aliceDir.listDocHistoryPurges!();
    expect(views).toHaveLength(1);
    expect(views[0].requestId).toBe("req-1");
    expect(views[0].dbId).toBe("main");
    expect(views[0].docIds).toEqual(["doc-1", "doc-2"]);
    expect(views[0].reason).toBe("GDPR erasure");
    expect(views[0].preparedByPublicKey).toBe(alice.userSigningKeyPair.publicKey);

    const requests = await aliceDir.getRequestedDocHistoryPurges();
    expect(requests).toHaveLength(1);
    expect(requests[0].dbId).toBe("main");
    expect(requests[0].docIds).toEqual(["doc-1", "doc-2"]);
    expect(requests[0].reason).toBe("GDPR erasure");
  }, 60000);

  it("exposes dbId + docIds to a $publicinfos-only principal but hides the reason", async () => {
    await aliceDir.publishDocHistoryPurge!(buildRequest({}), admin.userSigningKeyPair.privateKey, adminPassword);
    await syncTenantDb(bobTenant, aliceTenant, "directory");

    const requests = await bobDir.getRequestedDocHistoryPurges();
    expect(requests).toHaveLength(1);
    // Routing fields are cleartext inside the $publicinfos envelope -> readable.
    expect(requests[0].dbId).toBe("main");
    expect(requests[0].docIds).toEqual(["doc-1", "doc-2"]);
    // reason is encrypted with the tenant default key, which bob does not hold.
    expect(requests[0].reason).toBeUndefined();
  }, 60000);

  it("deletes a pending purge request", async () => {
    await aliceDir.publishDocHistoryPurge!(buildRequest({}), admin.userSigningKeyPair.privateKey, adminPassword);
    expect(await aliceDir.listDocHistoryPurges!()).toHaveLength(1);

    await aliceDir.deleteDocHistoryPurge!("req-1", admin.userSigningKeyPair.privateKey, adminPassword);
    expect(await aliceDir.listDocHistoryPurges!()).toHaveLength(0);
  }, 60000);

  it("rejects an empty docIds list", async () => {
    await expect(
      aliceDir.publishDocHistoryPurge!(
        buildRequest({ docIds: [] }),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/docIds/);
  }, 60000);

  it("round-trips through an mdb:// request URI", () => {
    const request = buildRequest({});
    const uri = encodeDocHistoryPurgeRequest(request);
    expect(uri.startsWith("mdb://doc-history-purge/")).toBe(true);
    const decoded = decodeDocHistoryPurgeRequest(uri);
    expect(decoded).toEqual(request);
  });
});
