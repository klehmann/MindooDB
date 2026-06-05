import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, PrivateUserId, MindooTenant } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { extractSigningPublicKeys, extractWipeRequestedSigningKeys } from "../core/accesscontrol/grantKeys";

/**
 * Tests for the public access-control authoring/query API on
 * MindooTenantDirectory (docs/accesscontrol.md §9): policy + rule authoring,
 * rule listing/deletion, trusted witnesses, grant key arrays + remote wipe, and
 * the `canDo` / `wasAllowedAt` prediction/audit helpers.
 */
describe("access-control admin API (§9)", () => {
  let factory: BaseMindooTenantFactory;
  const tenantId = "tenant-acl-admin";
  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;
  let alice: PrivateUserId;
  const alicePassword = "alicepass123";
  let tenant: MindooTenant;
  let aclDir: AclDirectory;

  // Structural type exposing the (optional) §9 methods as required.
  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      | "setDefaultAccessPolicy"
      | "createAccessRule"
      | "listRules"
      | "deleteRule"
      | "addTrustedWitness"
      | "removeTrustedWitness"
      | "addUserKeys"
      | "removeUserKeys"
      | "setKeyPairLabel"
      | "getUserKeyPairs"
      | "requestDeviceWipe"
      | "cancelDeviceWipe"
      | "registerUser"
      | "revokeUser"
      | "isUserRevoked"
      | "validatePublicSigningKey"
      | "getUserPublicKeys"
      | "canDo"
      | "wasAllowedAt"
    >
  > & {
    getTrustedWitnessKeysAt(T: number): Promise<Set<string>>;
    findGrantAccessDocuments(username: string): Promise<Array<{ getData(): Record<string, unknown> }>>;
  };

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=acladmin", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=acladmin", alicePassword);
    const aliceKb = new KeyBag(alice.userEncryptionKeyPair.privateKey, alicePassword, new NodeCryptoAdapter());
    await aliceKb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await aliceKb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);

    // Open the tenant with Alice as the current user.
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
    aclDir = directory as unknown as AclDirectory;
  }, 60000);

  it("creates, lists, filters, and deletes rules", async () => {
    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.createAccessRule(
      { ruleId: "r-create", type: "doc_create", dbid: "crm", action: "allow", users_hashes: ["$everyone"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aclDir.createAccessRule(
      { ruleId: "r-change", type: "doc_change", dbid: "hr", action: "deny", users_hashes: ["$everyone"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const all = await aclDir.listRules();
    expect(all.map((r) => r.ruleId).sort()).toEqual(["r-change", "r-create"]);

    const onlyCreate = await aclDir.listRules({ type: "doc_create" });
    expect(onlyCreate.map((r) => r.ruleId)).toEqual(["r-create"]);

    const onlyCrm = await aclDir.listRules({ dbid: "crm" });
    expect(onlyCrm.map((r) => r.ruleId)).toEqual(["r-create"]);

    await aclDir.deleteRule("r-create", admin.userSigningKeyPair.privateKey, adminPassword);
    const afterDelete = await aclDir.listRules();
    expect(afterDelete.map((r) => r.ruleId)).toEqual(["r-change"]);
  }, 60000);

  it("adds and removes trusted witnesses", async () => {
    const witnessKey = "WITNESS_PUBLIC_KEY_ABC";
    await aclDir.addTrustedWitness({ witnessPublicKey: witnessKey }, admin.userSigningKeyPair.privateKey, adminPassword);

    let trusted = await aclDir.getTrustedWitnessKeysAt(Date.now() + 1000);
    expect(trusted.has(witnessKey)).toBe(true);

    await aclDir.removeTrustedWitness(witnessKey, admin.userSigningKeyPair.privateKey, adminPassword);
    trusted = await aclDir.getTrustedWitnessKeysAt(Date.now() + 1000);
    expect(trusted.has(witnessKey)).toBe(false);
  }, 60000);

  it("adds/removes user keys and manages remote-wipe directives", async () => {
    const newDeviceKey = "ALICE_DEVICE_2_SIGNING_KEY";
    await aclDir.addUserKeys(
      alice.username,
      [{ signingPublicKey: newDeviceKey, encryptionPublicKey: "ALICE_DEVICE_2_ENCRYPTION_KEY" }],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    let grants = await aclDir.findGrantAccessDocuments(alice.username);
    expect(grants.length).toBeGreaterThan(0);
    expect(extractSigningPublicKeys(grants[0].getData())).toContain(newDeviceKey);

    // Request a wipe for the stolen device, then cancel it.
    await aclDir.requestDeviceWipe(alice.username, [newDeviceKey], admin.userSigningKeyPair.privateKey, adminPassword);
    grants = await aclDir.findGrantAccessDocuments(alice.username);
    expect(extractWipeRequestedSigningKeys(grants[0].getData())).toContain(newDeviceKey);

    await aclDir.cancelDeviceWipe(alice.username, [newDeviceKey], admin.userSigningKeyPair.privateKey, adminPassword);
    grants = await aclDir.findGrantAccessDocuments(alice.username);
    expect(extractWipeRequestedSigningKeys(grants[0].getData())).not.toContain(newDeviceKey);

    await aclDir.removeUserKeys(alice.username, [newDeviceKey], [], admin.userSigningKeyPair.privateKey, adminPassword);
    grants = await aclDir.findGrantAccessDocuments(alice.username);
    expect(extractSigningPublicKeys(grants[0].getData())).not.toContain(newDeviceKey);
  }, 60000);

  it("revokeUser removes a specific key but leaves the user's other keys active", async () => {
    const device2 = "ALICE_DEVICE_2_SIGNING_KEY";
    await aclDir.addUserKeys(
      alice.username,
      [{ signingPublicKey: device2, encryptionPublicKey: "ALICE_DEVICE_2_ENCRYPTION_KEY" }],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Revoke only the second device.
    await aclDir.revokeUser(
      alice.username,
      { signingKeys: [device2] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const grants = await aclDir.findGrantAccessDocuments(alice.username);
    const signing = extractSigningPublicKeys(grants[0].getData());
    expect(signing).not.toContain(device2);
    expect(signing).toContain(alice.userSigningKeyPair.publicKey);

    // The user still has active access and the primary device is still trusted.
    expect(await aclDir.isUserRevoked(alice.username)).toBe(false);
    expect(await aclDir.validatePublicSigningKey(alice.userSigningKeyPair.publicKey)).toBe(true);
    expect(await aclDir.validatePublicSigningKey(device2)).toBe(false);
  }, 60000);

  it("revokeUser with no keys fully revokes the user (and a stale scalar cannot resurrect access)", async () => {
    // Sanity: Alice is trusted before revocation.
    expect(await aclDir.validatePublicSigningKey(alice.userSigningKeyPair.publicKey)).toBe(true);
    expect(await aclDir.isUserRevoked(alice.username)).toBe(false);

    await aclDir.revokeUser(alice.username, {}, admin.userSigningKeyPair.privateKey, adminPassword);

    // The grant document still exists, but with empty key arrays.
    const grants = await aclDir.findGrantAccessDocuments(alice.username);
    expect(grants.length).toBeGreaterThan(0);
    expect(extractSigningPublicKeys(grants[0].getData())).toEqual([]);

    // The user is fully revoked even though registerUser also wrote a legacy
    // scalar userSigningPublicKey on the grant document.
    expect(await aclDir.isUserRevoked(alice.username)).toBe(true);
    expect(await aclDir.validatePublicSigningKey(alice.userSigningKeyPair.publicKey)).toBe(false);
    expect(await aclDir.getUserPublicKeys(alice.username)).toBeNull();
  }, 60000);

  it("a fully revoked user can be re-registered with the same keys", async () => {
    await aclDir.revokeUser(alice.username, {}, admin.userSigningKeyPair.privateKey, adminPassword);
    expect(await aclDir.isUserRevoked(alice.username)).toBe(true);

    // Re-registration creates a fresh active grant; access is restored.
    await aclDir.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);

    expect(await aclDir.isUserRevoked(alice.username)).toBe(false);
    expect(await aclDir.validatePublicSigningKey(alice.userSigningKeyPair.publicKey)).toBe(true);
  }, 60000);

  it("revokeUser with requestDataWipe flags the removed device for remote wipe", async () => {
    const device2 = "ALICE_DEVICE_2_SIGNING_KEY";
    await aclDir.addUserKeys(
      alice.username,
      [{ signingPublicKey: device2, encryptionPublicKey: "ALICE_DEVICE_2_ENCRYPTION_KEY" }],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    await aclDir.revokeUser(
      alice.username,
      { signingKeys: [device2], requestDataWipe: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const grants = await aclDir.findGrantAccessDocuments(alice.username);
    // The key is removed from the active set but flagged for wipe (self-contained).
    expect(extractSigningPublicKeys(grants[0].getData())).not.toContain(device2);
    expect(extractWipeRequestedSigningKeys(grants[0].getData())).toContain(device2);
  }, 60000);

  it("registers a device with a label and lists it via getUserKeyPairs", async () => {
    // Alice's primary device was registered without a label in beforeEach.
    const primary = await aclDir.getUserKeyPairs(alice.username);
    expect(primary).toHaveLength(1);
    expect(primary[0].signingPublicKey).toBe(alice.userSigningKeyPair.publicKey);
    expect(primary[0].label).toBeUndefined();
    expect(primary[0].wipeRequested).toBe(false);

    // Add a second labeled device.
    await aclDir.addUserKeys(
      alice.username,
      [
        {
          signingPublicKey: "ALICE_LAPTOP_SIGNING_KEY",
          encryptionPublicKey: "ALICE_LAPTOP_ENCRYPTION_KEY",
          label: "Work laptop (2026-05)",
        },
      ],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const pairs = await aclDir.getUserKeyPairs(alice.username);
    expect(pairs).toHaveLength(2);
    const laptop = pairs.find((p) => p.signingPublicKey === "ALICE_LAPTOP_SIGNING_KEY");
    expect(laptop?.encryptionPublicKey).toBe("ALICE_LAPTOP_ENCRYPTION_KEY");
    expect(laptop?.label).toBe("Work laptop (2026-05)");
  }, 60000);

  it("setKeyPairLabel sets and clears a device label", async () => {
    await aclDir.setKeyPairLabel(
      alice.username,
      alice.userSigningKeyPair.publicKey,
      "  Alice phone  ",
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    let pairs = await aclDir.getUserKeyPairs(alice.username);
    expect(pairs[0].label).toBe("Alice phone");

    // The canonical userKeyPairs field carries the label on the grant document.
    const grants = await aclDir.findGrantAccessDocuments(alice.username);
    const keyPairsField = grants[0].getData().userKeyPairs as Array<Record<string, unknown>>;
    expect(Array.isArray(keyPairsField)).toBe(true);
    expect(keyPairsField[0].label).toBe("Alice phone");

    // Clearing with a blank label drops the label field.
    await aclDir.setKeyPairLabel(
      alice.username,
      alice.userSigningKeyPair.publicKey,
      "   ",
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    pairs = await aclDir.getUserKeyPairs(alice.username);
    expect(pairs[0].label).toBeUndefined();
  }, 60000);

  it("getUserKeyPairs reflects per-device remote-wipe status", async () => {
    await aclDir.addUserKeys(
      alice.username,
      [{ signingPublicKey: "ALICE_TABLET_SIGNING_KEY", encryptionPublicKey: "ALICE_TABLET_ENCRYPTION_KEY" }],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aclDir.requestDeviceWipe(
      alice.username,
      ["ALICE_TABLET_SIGNING_KEY"],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const pairs = await aclDir.getUserKeyPairs(alice.username);
    const tablet = pairs.find((p) => p.signingPublicKey === "ALICE_TABLET_SIGNING_KEY");
    expect(tablet?.wipeRequested).toBe(true);
    const phone = pairs.find((p) => p.signingPublicKey === alice.userSigningKeyPair.publicKey);
    expect(phone?.wipeRequested).toBe(false);
  }, 60000);

  it("canDo predicts the current user's permission against the head policy", async () => {
    // No policy yet -> everything allowed.
    expect((await aclDir.canDo("doc_create", "crm")).allowed).toBe(true);

    // Deny creates by default; allow only for $everyone WITH a matching rule.
    await aclDir.setDefaultAccessPolicy(
      { denyDocCreate: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    expect((await aclDir.canDo("doc_create", "crm")).allowed).toBe(false);

    await aclDir.createAccessRule(
      { ruleId: "allow-create-crm", type: "doc_create", dbid: "crm", action: "allow", users_hashes: ["$everyone"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    expect((await aclDir.canDo("doc_create", "crm")).allowed).toBe(true);
    // The rule is crm-scoped; another db still inherits the deny baseline.
    expect((await aclDir.canDo("doc_create", "hr")).allowed).toBe(false);
  }, 60000);

  it("wasAllowedAt evaluates against the directory state at a past trusted time", async () => {
    const beforePolicy = 1; // epoch: before any policy existed
    await aclDir.setDefaultAccessPolicy(
      { denyDocCreate: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const afterPolicy = Date.now() + 60_000;

    const past = await aclDir.wasAllowedAt("doc_create", alice.username, "crm", beforePolicy);
    expect(past.allowed).toBe(true); // no policy existed yet

    const now = await aclDir.wasAllowedAt("doc_create", alice.username, "crm", afterPolicy);
    expect(now.allowed).toBe(false); // baseline deny is in effect
  }, 60000);
});
