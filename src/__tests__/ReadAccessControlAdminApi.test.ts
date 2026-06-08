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
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

// A store factory that memoizes stores per dbId, so two tenants opened over the
// same factory (Alice and Bob) share the directory store and therefore see each
// other's published access-control documents.
class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
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
 * Tests for the read-side access-control authoring/query API and the admin-blind
 * key delivery ceremony (read-side of docs/accesscontrol.md): read policy + rule
 * authoring, `canRead`, the `wasAllowedToReadAt` audit, and `prepareKeyDelivery`
 * / `publishKeyDelivery` / `importKeyDeliveriesForUser` with an out-of-audience
 * admin proven unable to receive the key.
 */
describe("read access-control admin API + key delivery", () => {
  let factory: BaseMindooTenantFactory;
  const tenantId = "tenant-read-acl";
  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;
  let alice: PrivateUserId;
  const alicePassword = "alicepass123";
  let aliceKb: KeyBag;
  let bob: PrivateUserId;
  const bobPassword = "bobpass123";
  let publicInfosKey: Uint8Array;
  let tenantKey: Uint8Array;
  let tenant: MindooTenant;
  let aclDir: ReadAclDirectory;
  let storeFactory: SharedInMemoryStoreFactory;

  type ReadAclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      | "setDefaultReadPolicy"
      | "setDatabaseReadPolicy"
      | "createReadRule"
      | "listReadRules"
      | "deleteReadRule"
      | "canRead"
      | "wasAllowedToReadAt"
      | "prepareKeyDelivery"
      | "publishKeyDelivery"
      | "pushKey"
      | "importKeyDeliveriesForUser"
      | "registerUser"
      | "addUsersToGroup"
      | "evaluateReadAccessForUser"
    >
  >;

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=readacl", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);
    publicInfosKey = (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;
    tenantKey = (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;

    alice = await factory.createUserId("CN=alice/O=readacl", alicePassword);
    aliceKb = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, new NodeCryptoAdapter());
    await aliceKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await aliceKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);
    // A named, fine-grained read-scoping key that Alice (a key-holder) can push.
    await aliceKb.createDocKey(tenantId, "team-key");

    bob = await factory.createUserId("CN=bob/O=readacl", bobPassword);

    tenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      aliceKb,
    );

    const directory = await tenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);
    aclDir = directory as unknown as ReadAclDirectory;
  }, 60000);

  it("canRead is unrestricted until a read policy is created", async () => {
    expect((await aclDir.canRead("crm")).allowed).toBe(true);
  }, 60000);

  it("creates, lists, and deletes read rules under a default-deny posture", async () => {
    await aclDir.setDefaultReadPolicy({ defaultReadAccess: "deny" }, admin.userSigningKeyPair.privateKey, adminPassword);
    // Alice is the current user; with no rule yet, default-deny applies.
    expect((await aclDir.canRead("crm")).allowed).toBe(false);

    const ruleId = await aclDir.createReadRule(
      { dbid: "crm", action: "allow", usernames: [alice.username] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    expect(typeof ruleId).toBe("string");

    const rules = await aclDir.listReadRules();
    expect(rules.map((r) => r.ruleId)).toContain(ruleId);
    expect((await aclDir.canRead("crm")).allowed).toBe(true);
    // Rule is crm-scoped; another db still inherits the deny baseline.
    expect((await aclDir.canRead("hr")).allowed).toBe(false);

    // Revocation by policy revision: deleting the allow rule denies again.
    await aclDir.deleteReadRule(ruleId, admin.userSigningKeyPair.privateKey, adminPassword);
    expect((await aclDir.listReadRules()).map((r) => r.ruleId)).not.toContain(ruleId);
    expect((await aclDir.canRead("crm")).allowed).toBe(false);
  }, 60000);

  it("stores targeted usernames/groups encrypted for admin-UI display, opaque to the server", async () => {
    const ruleId = await aclDir.createReadRule(
      { dbid: "crm", action: "allow", usernames: [alice.username], groups: ["analysts"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const rule = (await aclDir.listReadRules()).find((r) => r.ruleId === ruleId)!;
    expect(rule).toBeDefined();

    // The decrypted display targets round-trip back to the cleartext names.
    expect(rule.targets?.usernames).toContain(alice.username);
    expect(rule.targets?.groups).toContain("analysts");

    // The on-wire blob is tenant-key ciphertext: non-empty and NOT plaintext,
    // so the (publicinfos-only) sync server cannot read who the rule targets.
    expect(rule.users_encrypted).not.toBe("");
    expect(rule.users_encrypted).not.toContain(alice.username);
    expect(rule.users_encrypted).not.toContain("analysts");

    // A rule authored from pseudo-tokens only has nothing cleartext to show.
    const everyoneRuleId = await aclDir.createReadRule(
      { dbid: "crm", action: "allow", users_hashes: ["$everyone"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const everyoneRule = (await aclDir.listReadRules()).find((r) => r.ruleId === everyoneRuleId)!;
    expect(everyoneRule.users_encrypted).toBe("");
    expect(everyoneRule.targets).toBeUndefined();
  }, 60000);

  it("expands group-targeted read rules to members, case-insensitively", async () => {
    await aclDir.setDefaultReadPolicy({ defaultReadAccess: "deny" }, admin.userSigningKeyPair.privateKey, adminPassword);

    // Alice is a member of "Analysts"; Bob is not.
    await aclDir.addUsersToGroup("Analysts", [alice.username], admin.userSigningKeyPair.privateKey, adminPassword);

    // The rule targets the group by name with DIFFERENT casing than the member
    // identity will resolve to ("analysts"), exercising group-name normalization.
    await aclDir.createReadRule(
      { dbid: "crm", action: "allow", groups: ["Analysts"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Alice (current user) is a member -> allowed via group expansion.
    expect((await aclDir.canRead("crm")).allowed).toBe(true);
    // Bob is not a member -> still denied under the default-deny baseline.
    const bobDecision = await aclDir.evaluateReadAccessForUser({
      username: bob.username,
      dbid: "crm",
      decryptionKeyId: "default",
    });
    expect(bobDecision.allowed).toBe(false);
  }, 60000);

  it("honours a per-database read policy override", async () => {
    await aclDir.setDefaultReadPolicy({ defaultReadAccess: "allow" }, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseReadPolicy("crm", { defaultReadAccess: "deny" }, admin.userSigningKeyPair.privateKey, adminPassword);
    expect((await aclDir.canRead("hr")).allowed).toBe(true);
    expect((await aclDir.canRead("crm")).allowed).toBe(false);
  }, 60000);

  it("wasAllowedToReadAt evaluates against the directory state at a past trusted time", async () => {
    const beforePolicy = 1;
    await aclDir.setDefaultReadPolicy({ defaultReadAccess: "deny" }, admin.userSigningKeyPair.privateKey, adminPassword);
    const afterPolicy = Date.now() + 60_000;

    const past = await aclDir.wasAllowedToReadAt(alice.username, "crm", "default", beforePolicy);
    expect(past.allowed).toBe(true); // no read policy existed yet

    const now = await aclDir.wasAllowedToReadAt(alice.username, "crm", "default", afterPolicy);
    expect(now.allowed).toBe(false); // default-deny is in effect
  }, 60000);

  it("delivers a key to a recipient; an out-of-audience admin cannot receive it", async () => {
    // Alice (key-holder) wraps "team-key" to Bob; admin publishes (admin-blind).
    const payload = await aclDir.prepareKeyDelivery("team-key", [bob.username]);
    expect(payload.keyId).toBe("team-key");
    expect(payload.recipients).toHaveLength(1);
    expect(payload.recipients[0].versions).toHaveLength(1);
    expect(payload.preparedByPublicKey).toBe(alice.userSigningKeyPair.publicKey);

    await aclDir.publishKeyDelivery(payload, admin.userSigningKeyPair.privateKey, adminPassword);

    // The admin is NOT in the recipient set, so importing as the admin yields
    // nothing (admin-blind: the admin never receives the plaintext key).
    const adminImported = await aclDir.importKeyDeliveriesForUser(
      admin.username,
      admin.userEncryptionKeyPair.privateKey,
      adminPassword,
    );
    expect(adminImported).toEqual([]);
    expect(await adminKeyBag.get("doc", tenantId, "team-key")).toBeFalsy();

    // Bob opens the tenant and imports the delivery: he RSA-unwraps and the key
    // lands in his KeyBag, matching Alice's original bytes.
    const bobKb = new KeyBag(bob.userEncryptionKeyPair.privateKey, bobPassword, new NodeCryptoAdapter());
    await bobKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await bobKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);
    const bobTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      bob,
      bobPassword,
      bobKb,
    );
    const bobDir = (await bobTenant.openDirectory()) as unknown as ReadAclDirectory;

    expect(await bobKb.get("doc", tenantId, "team-key")).toBeFalsy();
    const bobImported = await bobDir.importKeyDeliveriesForUser(
      bob.username,
      bob.userEncryptionKeyPair.privateKey,
      bobPassword,
    );
    expect(bobImported).toEqual(["team-key"]);

    const delivered = await bobKb.get("doc", tenantId, "team-key");
    const original = await aliceKb.get("doc", tenantId, "team-key");
    expect(delivered).toBeTruthy();
    expect(Array.from(delivered!)).toEqual(Array.from(original!));
  }, 60000);

  it("delivers ALL versions of a rotated key, not just the latest", async () => {
    // Rotate "team-key": Alice now holds two versions (the beforeEach one plus a
    // newer rotation). Documents may be encrypted under either, so a delivery
    // must carry both for the recipient to read the full history.
    await aliceKb.set("doc", tenantId, "team-key", new Uint8Array(32).fill(7), Date.now() + 1000);
    const aliceVersions = await aliceKb.getAllKeys("doc", tenantId, "team-key");
    expect(aliceVersions).toHaveLength(2);

    const payload = await aclDir.prepareKeyDelivery("team-key", [bob.username]);
    expect(payload.recipients).toHaveLength(1);
    // Every stored version is wrapped for the recipient.
    expect(payload.recipients[0].versions).toHaveLength(2);

    await aclDir.publishKeyDelivery(payload, admin.userSigningKeyPair.privateKey, adminPassword);

    const bobKb = new KeyBag(bob.userEncryptionKeyPair.privateKey, bobPassword, new NodeCryptoAdapter());
    await bobKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await bobKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantKey);
    const bobTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      bob,
      bobPassword,
      bobKb,
    );
    const bobDir = (await bobTenant.openDirectory()) as unknown as ReadAclDirectory;

    const bobImported = await bobDir.importKeyDeliveriesForUser(
      bob.username,
      bob.userEncryptionKeyPair.privateKey,
      bobPassword,
    );
    expect(bobImported).toEqual(["team-key"]);

    // Bob ends up with BOTH versions, byte-identical to Alice's (newest first).
    const bobVersions = await bobKb.getAllKeys("doc", tenantId, "team-key");
    expect(bobVersions).toHaveLength(2);
    expect(bobVersions.map((v) => Array.from(v))).toEqual(aliceVersions.map((v) => Array.from(v)));

    // Re-importing is idempotent: no duplicate versions accumulate.
    await bobDir.importKeyDeliveriesForUser(
      bob.username,
      bob.userEncryptionKeyPair.privateKey,
      bobPassword,
    );
    expect(await bobKb.getAllKeys("doc", tenantId, "team-key")).toHaveLength(2);
  }, 60000);
});
