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
  SigningKeyPair,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * End-to-end walk of the §11 CRM worked example (docs/accesscontrol.md). One
 * `crm` database with four rules:
 *  1. anyone may CREATE if they put themselves in `myeditors` (Tier 2, after).
 *  2. only an existing editor may CHANGE (Tier 2, before).
 *  3. only the creator may DELETE (Tier 1 via `$author`).
 *  4. the HR group may CHANGE anything (Tier 1, group rule, no withfields).
 *
 * The test exercises the prediction/audit engine (`wasAllowedAt` / `canDo`) for
 * each scenario and verifies that a tampered Tier 2-violating change is
 * quarantined on a fresh replica's materialization.
 */
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

describe("§11 CRM worked example (end-to-end)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-crm-example";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice: PrivateUserId;
  const alicePassword = "alicepass123";
  let bob: PrivateUserId;
  const bobPassword = "bobpass123";
  let hrUser: PrivateUserId;
  const hrPassword = "hrpass123";

  let writerTenant: MindooTenant;
  let aliceUsername: string;
  let hrUsername: string;

  // Structural view exposing the §9 methods we use.
  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      "setDatabaseAccessPolicy" | "setDefaultAccessPolicy" | "createAccessRule" | "wasAllowedAt" | "addUsersToGroup"
    >
  > & {
    getUserBySigningPublicKey(key: string): Promise<{ username: string } | null>;
  };
  let aclDir: AclDirectory;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  async function openTenantAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
    const directory = await writerTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(user), admin.userSigningKeyPair.privateKey, adminPassword);
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      password,
      await keyBagFor(user, password),
    );
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=crm", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=crm", alicePassword);
    bob = await factory.createUserId("CN=bob/O=crm", bobPassword);
    hrUser = await factory.createUserId("CN=hruser/O=crm", hrPassword);

    const writerUser = await factory.createUserId("CN=writer/O=crm", "writerpass123");
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writerUser,
      "writerpass123",
      await keyBagFor(writerUser, "writerpass123"),
    );

    const directory = await writerTenant.openDirectory();
    for (const u of [admin, alice, bob, hrUser, writerUser]) {
      await directory.registerUser(factory.toPublicUserId(u), admin.userSigningKeyPair.privateKey, adminPassword);
    }
    aclDir = directory as unknown as AclDirectory;

    aliceUsername = (await aclDir.getUserBySigningPublicKey(alice.userSigningKeyPair.publicKey))!.username;
    hrUsername = (await aclDir.getUserBySigningPublicKey(hrUser.userSigningKeyPair.publicKey))!.username;

    // HR group with hrUser as a member.
    await aclDir.addUsersToGroup("hr", [hrUsername], admin.userSigningKeyPair.privateKey, adminPassword);

    // Policy: deny lifecycle ops in crm by default.
    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseAccessPolicy(
      "crm",
      { denyDocCreate: true, denyDocChange: true, denyDocDelete: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Rule 1: create if creator is in myeditors (Tier 2, after).
    await aclDir.createAccessRule(
      {
        ruleId: "crm_create_self_editor",
        type: "doc_create",
        dbid: "crm",
        action: "allow",
        users_hashes: ["$everyone"],
        withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}", when: "after" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Rule 2: change only by an existing editor (Tier 2, before).
    await aclDir.createAccessRule(
      {
        ruleId: "crm_change_if_editor",
        type: "doc_change",
        dbid: "crm",
        action: "allow",
        users_hashes: ["$everyone"],
        withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}", when: "before" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Rule 3: delete only by the creator (Tier 1, $author).
    await aclDir.createAccessRule(
      { ruleId: "crm_delete_by_author", type: "doc_delete", dbid: "crm", action: "allow", users_hashes: ["$author"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Rule 4: HR group may change anything (Tier 1, group rule).
    await aclDir.createAccessRule(
      { ruleId: "crm_change_hr", type: "doc_change", dbid: "crm", action: "allow", groups: ["hr"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
  }, 90000);

  const NOW = () => Date.now() + 60_000; // safely after all policy revisions

  it("Rule 1: a create is allowed only when the creator lists themselves in myeditors", async () => {
    const withSelf = await aclDir.wasAllowedAt("doc_create", aliceUsername, "crm", NOW(), {
      form: "CRMContact",
      myeditors: [aliceUsername],
    });
    expect(withSelf.allowed).toBe(true);

    const withoutSelf = await aclDir.wasAllowedAt("doc_create", aliceUsername, "crm", NOW(), {
      form: "CRMContact",
      myeditors: [],
    });
    expect(withoutSelf.allowed).toBe(false);
  }, 90000);

  it("Rule 2: only an existing editor may change (self-insertion in the same change cannot authorize)", async () => {
    const before = { myeditors: [aliceUsername] };
    const aliceChange = await aclDir.wasAllowedAt("doc_change", aliceUsername, "crm", NOW(), before);
    expect(aliceChange.allowed).toBe(true);

    // Bob is not in the before-state editor list -> denied (baseline deny applies).
    const bobUsername = (await aclDir.getUserBySigningPublicKey(bob.userSigningKeyPair.publicKey))!.username;
    const bobChange = await aclDir.wasAllowedAt("doc_change", bobUsername, "crm", NOW(), before);
    expect(bobChange.allowed).toBe(false);
  }, 90000);

  it("Rule 4: an HR group member may change a contact regardless of myeditors", async () => {
    const before = { myeditors: [aliceUsername] }; // HR user not listed
    const hrChange = await aclDir.wasAllowedAt("doc_change", hrUsername, "crm", NOW(), before);
    expect(hrChange.allowed).toBe(true);
    expect(hrChange.tier).toBe("tier1"); // group rule has no withfields
  }, 90000);

  it("Scenario C: a tampered Tier 2-violating change is quarantined on a fresh replica", async () => {
    const crm = await writerTenant.openDB("crm");
    const aliceSigning: SigningKeyPair = {
      publicKey: alice.userSigningKeyPair.publicKey,
      privateKey: alice.userSigningKeyPair.privateKey,
    };
    const bobSigning: SigningKeyPair = {
      publicKey: bob.userSigningKeyPair.publicKey,
      privateKey: bob.userSigningKeyPair.privateKey,
    };

    // Alice creates a contact with herself as editor.
    const contact = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", name: "ACME GmbH", myeditors: [aliceUsername], rev: 1 },
    });
    const docId = contact.getId();

    // A tampered client (Bob) authors a change despite not being an editor.
    const forBob = await crm.getDocument(docId);
    await crm.changeDoc(
      forBob,
      async (d) => {
        d.getData().rev = 999;
      },
      { signingKeyPair: bobSigning, signingKeyPassword: bobPassword },
    );

    // Fresh replica materializes: Bob's change is quarantined, the contact keeps rev 1.
    const readerTenant = await openTenantAs(
      await factory.createUserId("CN=reader/O=crm", "readerpass123"),
      "readerpass123",
    );
    const readerCrm = await readerTenant.openDB("crm");
    const readDoc = await readerCrm.getDocument(docId);
    expect(readDoc!.getData().rev).toBe(1);

    const log = (readerCrm as unknown as {
      getQuarantineLog: () => Array<{ reason: string; entryType: string; docId: string }>;
    }).getQuarantineLog();
    expect(log.some((r) => r.docId === docId && r.entryType === "doc_change")).toBe(true);
  }, 90000);
});
