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
import type { AppDistributionRequest } from "../core/accesscontrol/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

// One isolated store namespace per tenant device, so directories converge only
// through explicit pull-sync (see ReadAccessControlAdminApi.test.ts).
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
 * Tests for the app-distribution authoring + reconcile-plan API
 * (docs/accesscontrol.md §13.8). Apps live in the Haven client, so the SDK side
 * only owns the directory document and the per-user `{ have, notHave }` plan.
 */
describe("app distribution admin API", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-appdist";

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

    admin = await aliceFactory.createUserId("CN=admin/O=appdist", adminPassword);
    adminKb = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKb.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKb.createTenantKey(tenantId);
    publicInfosKey = (await adminKb.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    tenantKey = (await adminKb.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;

    alice = await aliceFactory.createUserId("CN=alice/O=appdist", alicePassword);
    aliceKb = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, crypto);
    await aliceKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await aliceKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    bob = await bobFactory.createUserId("CN=bob/O=appdist", bobPassword);
    bobKb = new KeyBag(bob.userEncryptionKeyPair.privateKey, bobPassword, crypto);
    await bobKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await bobKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    carol = await carolFactory.createUserId("CN=carol/O=appdist", carolPassword);
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

  function buildRequest(overrides: Partial<AppDistributionRequest>): AppDistributionRequest {
    return {
      v: 1,
      tenantId,
      appId: "app-todo",
      version: "1.0.0",
      title: "Todo Manager",
      comment: "Team todo app",
      appData: { label: "Todo", entryUrl: "https://app-todo.example.com" },
      preparedByPublicKey: alice.userSigningKeyPair.publicKey,
      pushtoUsernames: [],
      pushtoGroups: [],
      pullfromUsernames: [],
      pullfromGroups: [],
      ...overrides,
    };
  }

  it("distributes an app to a pushto user; an out-of-audience user gets it in notHave", async () => {
    const request = buildRequest({ pushtoUsernames: [bob.username] });
    await aliceDir.publishAppDistribution!(request, admin.userSigningKeyPair.privateKey, adminPassword);

    const views = await aliceDir.listAppDistributions!();
    expect(views).toHaveLength(1);
    expect(views[0].appId).toBe("app-todo");
    expect(views[0].title).toBe("Todo Manager");
    expect(views[0].version).toBe("1.0.0");
    expect(views[0].appData).toEqual({ label: "Todo", entryUrl: "https://app-todo.example.com" });
    expect(views[0].pushtoUsernames).toEqual([bob.username]);

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    await syncTenantDb(carolTenant, aliceTenant, "directory");

    const bobPlan = await bobDir.getAppDistributionsForCurrentUser!(bob.username);
    expect(bobPlan.have).toHaveLength(1);
    expect(bobPlan.have[0]).toEqual({
      appId: "app-todo",
      title: "Todo Manager",
      version: "1.0.0",
      appData: { label: "Todo", entryUrl: "https://app-todo.example.com" },
    });
    expect(bobPlan.notHave).toEqual([]);

    const carolPlan = await carolDir.getAppDistributionsForCurrentUser!(carol.username);
    expect(carolPlan.have).toEqual([]);
    expect(carolPlan.notHave).toEqual(["app-todo"]);

    expect(await bobDir.getManagedAppIds!(bob.username)).toEqual(["app-todo"]);
    expect(await carolDir.getManagedAppIds!(carol.username)).toEqual([]);
  }, 60000);

  it("distributes an app to a group; members get it, pull wins on overlap", async () => {
    await aliceDir.addUsersToGroup(
      "engineers",
      [bob.username, carol.username],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Carol is both a group member (pushto) and explicitly in pullfrom -> pull wins.
    const request = buildRequest({
      pushtoGroups: ["engineers"],
      pullfromUsernames: [carol.username],
    });
    await aliceDir.publishAppDistribution!(request, admin.userSigningKeyPair.privateKey, adminPassword);

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    await syncTenantDb(carolTenant, aliceTenant, "directory");

    const bobPlan = await bobDir.getAppDistributionsForCurrentUser!(bob.username);
    expect(bobPlan.have.map((e) => e.appId)).toEqual(["app-todo"]);

    const carolPlan = await carolDir.getAppDistributionsForCurrentUser!(carol.username);
    expect(carolPlan.have).toEqual([]);
    expect(carolPlan.notHave).toEqual(["app-todo"]);
  }, 60000);

  it("reflects a version change on re-publish", async () => {
    await aliceDir.publishAppDistribution!(
      buildRequest({ pushtoUsernames: [bob.username], version: "1.0.0" }),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aliceDir.publishAppDistribution!(
      buildRequest({
        pushtoUsernames: [bob.username],
        version: "2.0.0",
        appData: { label: "Todo v2", entryUrl: "https://app-todo.example.com" },
      }),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    await syncTenantDb(bobTenant, aliceTenant, "directory");
    const bobPlan = await bobDir.getAppDistributionsForCurrentUser!(bob.username);
    expect(bobPlan.have).toHaveLength(1);
    expect(bobPlan.have[0].version).toBe("2.0.0");
    expect(bobPlan.have[0].appData).toEqual({ label: "Todo v2", entryUrl: "https://app-todo.example.com" });
  }, 60000);

  it("rejects disjoint-set violations and missing grants", async () => {
    await expect(
      aliceDir.publishAppDistribution!(
        buildRequest({ pushtoUsernames: [bob.username], pullfromUsernames: [bob.username] }),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/disjoint/);

    await expect(
      aliceDir.publishAppDistribution!(
        buildRequest({ pushtoUsernames: ["CN=ghost/O=appdist"] }),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/no active grant/);
  }, 60000);
});
