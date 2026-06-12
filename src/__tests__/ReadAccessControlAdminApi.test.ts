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
} from "../core/types";
import type { KeyDistributionRequest } from "../core/accesscontrol/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

// One isolated store namespace per tenant. Alice, Bob and Carol each get their
// own instance, so their directories converge only through explicit pull-sync —
// modelling three real devices that share tenant keys but not storage.
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

/**
 * Ferry one isolated tenant's directory into another via the public push-changes
 * API, then materialize. A directory PULL would fire the SDK's after-pull
 * `reconcileKeyDistributionsForCurrentUserSafe()` (BaseMindooDB §13) and race
 * the test's explicit, tenant-owned reconcile; a push only transfers entries, so
 * `reconcileKeyDistributionsForCurrentUser()` stays the single authoritative
 * reconcile whose imported/removed result we assert on.
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
 * Tests for the admin-blind key distribution ceremony (docs/accesscontrol.md
 * §13) across four separate identities, each on its own isolated store:
 *
 *  - **admin** — authorizes (signs) directory writes but NEVER opens a tenant of
 *    its own and never holds the distributed key (structurally admin-blind).
 *  - **alice** — the key-holder: owns `team-key`, wraps every version to each
 *    recipient device, and prepares the distribution request.
 *  - **bob** — the recipient (in `pushto`): reconciles his KeyBag and receives
 *    the key, byte-identical to Alice's.
 *  - **carol** — a regular user whose tenant session HOSTS the admin-authorized
 *    publish, and who doubles as the out-of-audience reconciliation check: a real
 *    user with a valid tenant + encryption key who is NOT in `pushto` and so
 *    receives nothing.
 */
describe("key distribution admin API", () => {
  const crypto = new NodeCryptoAdapter();
  const tenantId = "tenant-read-acl";

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

  let aliceDir: KeyDistDirectory; // key-holder: builds the wrapped request
  let carolDir: KeyDistDirectory; // regular-user session that hosts the publish

  type KeyDistDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      | "getKeyVersionManifest"
      | "wrapKeyForUserDevices"
      | "getUsernameHash"
      | "publishKeyDistribution"
      | "registerUser"
    >
  >;

  beforeEach(async () => {
    aliceFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);
    bobFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);
    carolFactory = new BaseMindooTenantFactory(new IsolatedStoreFactory(), crypto);

    // The admin identity authorizes writes but never opens a tenant. Its KeyBag
    // exists only to MINT the shared tenant keys (creating keys in a bag is not
    // "opening a tenant"); those keys are then copied into the user bags. The
    // admin never receives `team-key`.
    admin = await aliceFactory.createUserId("CN=admin/O=readacl", adminPassword);
    adminKb = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKb.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKb.createTenantKey(tenantId);
    publicInfosKey = (await adminKb.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    tenantKey = (await adminKb.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;

    alice = await aliceFactory.createUserId("CN=alice/O=readacl", alicePassword);
    aliceKb = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, crypto);
    await aliceKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await aliceKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);
    // A named, fine-grained read-scoping key that Alice (the key-holder) pushes.
    await aliceKb.createDocKey(tenantId, "team-key");

    bob = await bobFactory.createUserId("CN=bob/O=readacl", bobPassword);
    bobKb = new KeyBag(bob.userEncryptionKeyPair.privateKey, bobPassword, crypto);
    await bobKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await bobKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    carol = await carolFactory.createUserId("CN=carol/O=readacl", carolPassword);
    carolKb = new KeyBag(carol.userEncryptionKeyPair.privateKey, carolPassword, crypto);
    await carolKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await carolKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);

    // Alice's tenant is where users are registered and the request is wrapped.
    aliceTenant = await aliceFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      aliceKb,
    );
    const aliceDirectory = await aliceTenant.openDirectory();
    await aliceDirectory.registerUser(aliceFactory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    await aliceDirectory.registerUser(aliceFactory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);
    await aliceDirectory.registerUser(aliceFactory.toPublicUserId(carol), admin.userSigningKeyPair.privateKey, adminPassword);
    aliceDir = aliceDirectory as unknown as KeyDistDirectory;

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

    // Sync the registrations (still distribution-free) into Bob's and Carol's
    // replicas, then warm each directory once so the one-time bring-up reconcile
    // (getDirectoryDB §13) fires here as a no-op — leaving each test's explicit
    // reconcile as the sole authoritative one.
    await syncTenantDb(bobTenant, aliceTenant, "directory");
    await bobTenant.reconcileKeyDistributionsForCurrentUser?.();
    await syncTenantDb(carolTenant, aliceTenant, "directory");
    await carolTenant.reconcileKeyDistributionsForCurrentUser?.();

    carolDir = (await carolTenant.openDirectory()) as unknown as KeyDistDirectory;
  }, 60000);

  /** Build a full distribution request for "team-key" (all versions to all devices). */
  async function buildTeamKeyRequest(
    pushUsernames: string[],
    pullUsernames: string[],
  ): Promise<KeyDistributionRequest> {
    const keyVersions = await aliceDir.getKeyVersionManifest("team-key");
    const pushto = [];
    for (const username of pushUsernames) {
      pushto.push(await aliceDir.wrapKeyForUserDevices("team-key", username));
    }
    const pullfrom = [];
    for (const username of pullUsernames) {
      pullfrom.push({ username, username_hash: await aliceDir.getUsernameHash(username) });
    }
    return {
      v: 1,
      tenantId,
      keyId: "team-key",
      keyVersions,
      title: "Team key",
      preparedByPublicKey: alice.userSigningKeyPair.publicKey,
      pushto,
      pullfrom,
    };
  }

  it("distributes a key to a recipient; an out-of-audience user (and the admin) cannot receive it", async () => {
    // Alice (key-holder) wraps "team-key" to Bob ONLY; Carol and the admin are
    // not in the audience.
    const request = await buildTeamKeyRequest([bob.username], []);
    expect(request.keyId).toBe("team-key");
    expect(request.pushto).toHaveLength(1);
    expect(Object.keys(request.pushto[0].devices)).toHaveLength(1);
    expect(request.preparedByPublicKey).toBe(alice.userSigningKeyPair.publicKey);

    // The admin authorizes the publish through Carol's regular-user session: the
    // admin signs the distribution but has no tenant of its own (admin-blind).
    await carolDir.publishKeyDistribution(request, admin.userSigningKeyPair.privateKey, adminPassword);

    // Bob (in audience) pulls the directory head and reconciles: he RSA-unwraps
    // the key into his KeyBag, byte-identical to Alice's original.
    await syncTenantDb(bobTenant, carolTenant, "directory");
    expect(await bobKb.get("doc", tenantId, "team-key")).toBeFalsy();
    const bobResult = await bobTenant.reconcileKeyDistributionsForCurrentUser!();
    expect(bobResult.imported).toEqual(["team-key"]);

    const delivered = await bobKb.get("doc", tenantId, "team-key");
    const original = await aliceKb.get("doc", tenantId, "team-key");
    expect(delivered).toBeTruthy();
    expect(Array.from(delivered!)).toEqual(Array.from(original!));

    // Carol (out-of-audience): a real user with a valid tenant + encryption key,
    // but NOT in pushto — reconciling imports nothing. This is the admin-blind
    // property made observable: only the wrapped recipient can receive the key.
    const carolResult = await carolTenant.reconcileKeyDistributionsForCurrentUser!();
    expect(carolResult.imported).toEqual([]);
    expect(await carolKb.get("doc", tenantId, "team-key")).toBeFalsy();

    // The admin, who merely signed the publish, never holds the key either.
    expect(await adminKb.get("doc", tenantId, "team-key")).toBeFalsy();
  }, 60000);

  it("distributes ALL versions of a rotated key, not just the latest", async () => {
    // Rotate "team-key": Alice now holds two versions. Documents may be encrypted
    // under either, so the manifest must carry both.
    await aliceKb.set("doc", tenantId, "team-key", new Uint8Array(32).fill(7), Date.now() + 1000);
    const aliceVersions = await aliceKb.getAllKeys("doc", tenantId, "team-key");
    expect(aliceVersions).toHaveLength(2);

    const request = await buildTeamKeyRequest([bob.username], []);
    expect(request.keyVersions).toHaveLength(2);
    // The single device entry covers both versions.
    const onlyDevice = Object.values(request.pushto[0].devices)[0];
    expect(Object.keys(onlyDevice)).toHaveLength(2);

    await carolDir.publishKeyDistribution(request, admin.userSigningKeyPair.privateKey, adminPassword);

    await syncTenantDb(bobTenant, carolTenant, "directory");
    const bobResult = await bobTenant.reconcileKeyDistributionsForCurrentUser!();
    expect(bobResult.imported).toEqual(["team-key"]);

    // Bob ends up with BOTH versions, byte-identical to Alice's (newest first).
    const bobVersions = await bobKb.getAllKeys("doc", tenantId, "team-key");
    expect(bobVersions).toHaveLength(2);
    expect(bobVersions.map((v) => Array.from(v))).toEqual(aliceVersions.map((v) => Array.from(v)));

    // Re-reconciling is idempotent: nothing new imported, no duplicate versions.
    const again = await bobTenant.reconcileKeyDistributionsForCurrentUser!();
    expect(again.imported).toEqual([]);
    expect(await bobKb.getAllKeys("doc", tenantId, "team-key")).toHaveLength(2);
  }, 60000);
});
