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
import type { SyncSetupPolicyRequest } from "../core/accesscontrol/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

// One isolated store namespace per tenant device, so directories converge only
// through explicit pull-sync (see AppDistributionAdminApi.test.ts).
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
 * Tests for the sync-setup-policy authoring + reconcile-plan API. Policies live
 * in the directory database; the SDK side owns the document and the per-user
 * `{ databases: [{ databaseId, locked }] }` plan that drives the Haven Sync-page
 * seed/lock pass.
 */
describe("sync setup policy admin API", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-syncsetup";

  const adminPassword = "adminpass123";
  const alicePassword = "alicepass123";
  const bobPassword = "bobpass123";
  const carolPassword = "carolpass123";

  let aliceFactory: BaseMindooTenantFactory;
  let bobFactory: BaseMindooTenantFactory;
  let carolFactory: BaseMindooTenantFactory;

  let admin: PrivateUserId;
  let alice: PrivateUserId;
  let bob: PrivateUserId;
  let carol: PrivateUserId;

  let adminKb: KeyBag;
  let aliceKb: KeyBag;
  let bobKb: KeyBag;
  let carolKb: KeyBag;

  let publicInfosKey: Uint8Array;
  let tenantKey: Uint8Array;

  let aliceTenant: MindooTenant;
  let bobTenant: MindooTenant;
  let carolTenant: MindooTenant;

  let aliceDir: MindooTenantDirectory;
  let bobDir: MindooTenantDirectory;
  let carolDir: MindooTenantDirectory;

  beforeEach(async () => {
    aliceFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);
    bobFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);
    carolFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);

    admin = await aliceFactory.createUserId("CN=admin/O=syncsetup", adminPassword);
    adminKb = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKb.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKb.createTenantKey(tenantId);
    publicInfosKey = (await adminKb.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    tenantKey = (await adminKb.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;

    alice = await aliceFactory.createUserId("CN=alice/O=syncsetup", alicePassword);
    aliceKb = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, crypto);
    await aliceKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await aliceKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    bob = await bobFactory.createUserId("CN=bob/O=syncsetup", bobPassword);
    bobKb = new KeyBag(bob.userEncryptionKeyPair.privateKey, bobPassword, crypto);
    await bobKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await bobKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    carol = await carolFactory.createUserId("CN=carol/O=syncsetup", carolPassword);
    carolKb = new KeyBag(carol.userEncryptionKeyPair.privateKey, carolPassword, crypto);
    await carolKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await carolKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

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
    await aliceDir.registerUser(aliceFactory.toPublicUserId(carol), admin.userSigningKeyPair.privateKey, adminPassword);

    bobTenant = await bobFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      bob,
      bobPassword,
      bobKb,
    );
    carolTenant = await carolFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      carol,
      carolPassword,
      carolKb,
    );

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    await syncTenantDb(carolTenant, aliceTenant, "directory");
    bobDir = await bobTenant.openDirectory();
    carolDir = await carolTenant.openDirectory();
  }, 60000);

  function buildRequest(overrides: Partial<SyncSetupPolicyRequest>): SyncSetupPolicyRequest {
    return {
      v: 1,
      tenantId,
      policyId: "onboarding",
      mode: "initial",
      title: "Onboarding databases",
      comment: "Databases every member should sync",
      databaseIds: ["contacts", "tasks"],
      preparedByPublicKey: alice.userSigningKeyPair.publicKey,
      pushtoUsernames: [],
      pushtoGroups: [],
      pullfromUsernames: [],
      pullfromGroups: [],
      ...overrides,
    };
  }

  it("seeds an initial policy's databases to a pushto user; out-of-audience user gets nothing", async () => {
    const request = buildRequest({ pushtoUsernames: [bob.username] });
    await aliceDir.publishSyncSetupPolicy!(request, admin.userSigningKeyPair.privateKey, adminPassword);

    const views = await aliceDir.listSyncSetupPolicies!();
    expect(views).toHaveLength(1);
    expect(views[0].policyId).toBe("onboarding");
    expect(views[0].mode).toBe("initial");
    expect(views[0].title).toBe("Onboarding databases");
    expect(views[0].databaseIds).toEqual(["contacts", "tasks"]);
    expect(views[0].pushtoUsernames).toEqual([bob.username]);

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    await syncTenantDb(carolTenant, aliceTenant, "directory");

    const bobPlan = await bobDir.getSyncSetupForCurrentUser!(bob.username);
    expect(bobPlan.databases).toEqual([
      { databaseId: "contacts", locked: false },
      { databaseId: "tasks", locked: false },
    ]);

    const carolPlan = await carolDir.getSyncSetupForCurrentUser!(carol.username);
    expect(carolPlan.databases).toEqual([]);
  }, 60000);

  it("locks databases for a permanent policy; an initial policy does not", async () => {
    await aliceDir.publishSyncSetupPolicy!(
      buildRequest({ policyId: "locked", mode: "permanent", databaseIds: ["contacts"], pushtoUsernames: [bob.username] }),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    const bobPlan = await bobDir.getSyncSetupForCurrentUser!(bob.username);
    expect(bobPlan.databases).toEqual([{ databaseId: "contacts", locked: true }]);
  }, 60000);

  it("targets a group; members get the databases, pullfrom releases the lock but keeps them", async () => {
    await aliceDir.addUsersToGroup(
      "engineers",
      [bob.username, carol.username],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Carol is a group member (pushto) and explicitly in pullfrom -> unlocked but still seeded.
    const request = buildRequest({
      mode: "permanent",
      databaseIds: ["contacts"],
      pushtoGroups: ["engineers"],
      pullfromUsernames: [carol.username],
    });
    await aliceDir.publishSyncSetupPolicy!(request, admin.userSigningKeyPair.privateKey, adminPassword);

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    await syncTenantDb(carolTenant, aliceTenant, "directory");

    const bobPlan = await bobDir.getSyncSetupForCurrentUser!(bob.username);
    expect(bobPlan.databases).toEqual([{ databaseId: "contacts", locked: true }]);

    const carolPlan = await carolDir.getSyncSetupForCurrentUser!(carol.username);
    expect(carolPlan.databases).toEqual([{ databaseId: "contacts", locked: false }]);
  }, 60000);

  it("merges databases across policies with lock winning on overlap", async () => {
    await aliceDir.publishSyncSetupPolicy!(
      buildRequest({ policyId: "initial-set", mode: "initial", databaseIds: ["contacts"], pushtoUsernames: [bob.username] }),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aliceDir.publishSyncSetupPolicy!(
      buildRequest({
        policyId: "permanent-set",
        mode: "permanent",
        databaseIds: ["contacts", "tasks"],
        pushtoUsernames: [bob.username],
      }),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    const bobPlan = await bobDir.getSyncSetupForCurrentUser!(bob.username);
    const byId = new Map(bobPlan.databases.map((d) => [d.databaseId, d.locked]));
    expect(byId.get("contacts")).toBe(true);
    expect(byId.get("tasks")).toBe(true);
  }, 60000);

  it("rejects disjoint-set violations, empty database lists, and missing grants", async () => {
    await expect(
      aliceDir.publishSyncSetupPolicy!(
        buildRequest({ pushtoUsernames: [bob.username], pullfromUsernames: [bob.username] }),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/disjoint/);

    await expect(
      aliceDir.publishSyncSetupPolicy!(
        buildRequest({ pushtoUsernames: [bob.username], databaseIds: [] }),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/at least one database id/);

    await expect(
      aliceDir.publishSyncSetupPolicy!(
        buildRequest({ pushtoUsernames: ["CN=ghost/O=syncsetup"] }),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/no active grant/);
  }, 60000);
});
