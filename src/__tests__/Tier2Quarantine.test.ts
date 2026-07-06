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
 * Store factory that returns the SAME in-memory stores for a given dbId, so two
 * tenant instances opened over it observe each other's writes — simulating two
 * synced replicas sharing one append-only store. Used to exercise the
 * client-side Tier 2 quarantine path on a fresh (reader) replica that did not
 * author the entries locally (docs/accesscontrol.md §10).
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

describe("Tier 2 content-rule quarantine (materialization)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-acl-tier2";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice: PrivateUserId;
  const alicePassword = "alicepass123";
  let bob: PrivateUserId;
  const bobPassword = "bobpass123";

  let writerTenant: MindooTenant;
  let aliceUsername: string;

  /** Build a KeyBag for `user` seeded with the tenant's $publicinfos + default keys. */
  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const adapter = new NodeCryptoAdapter();
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, adapter);
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  async function openTenantAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
    // The current user must be granted before it can open databases.
    const directory = await writerTenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(user),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const kb = await keyBagFor(user, password);
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      password,
      kb,
    );
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=acltenant", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=acltenant", alicePassword);
    bob = await factory.createUserId("CN=bob/O=acltenant", bobPassword);

    const adminCurrentUser = await factory.createUserId("CN=writer/O=acltenant", "writerpass123");
    const adminCurrentKb = await keyBagFor(adminCurrentUser, "writerpass123");
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      adminCurrentUser,
      "writerpass123",
      adminCurrentKb,
    );

    // Register all participants so their signing keys are trusted.
    const directory = await writerTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(admin), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);

    // The writer's current user must be granted to open databases.
    await directory.registerUser(factory.toPublicUserId(adminCurrentUser), admin.userSigningKeyPair.privateKey, adminPassword);

    const aliceLookup = await directory.getUserBySigningPublicKey(alice.userSigningKeyPair.publicKey);
    aliceUsername = aliceLookup!.username;
  }, 60000);

  it("quarantines a content-rule-violating change on a fresh replica, keeping the document at the last valid state", async () => {
    const crm = await writerTenant.openDB("crm");

    const aliceSigning: SigningKeyPair = {
      publicKey: alice.userSigningKeyPair.publicKey,
      privateKey: alice.userSigningKeyPair.privateKey,
    };
    const bobSigning: SigningKeyPair = {
      publicKey: bob.userSigningKeyPair.publicKey,
      privateKey: bob.userSigningKeyPair.privateKey,
    };

    // Alice creates a contact with herself as the sole editor (seeded into the
    // doc_create entry so the content rule can see it).
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { title: "Acme", myeditors: [aliceUsername], v: 1 },
    });
    const docId = doc.getId();

    // Turn on access control: deny changes to `crm` by default, but allow a
    // change when the author is already listed in `myeditors` (Tier 2).
    const directory = (await writerTenant.openDirectory()) as Required<
      Pick<
        Awaited<ReturnType<typeof writerTenant.openDirectory>>,
        "setDefaultAccessPolicy" | "setDatabaseAccessPolicy" | "createAccessRule"
      >
    >;
    await directory.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.setDatabaseAccessPolicy(
      "crm",
      { denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await directory.createAccessRule(
      {
        ruleId: "crm-editors-may-change",
        type: "doc_change",
        dbid: "crm",
        action: "allow",
        users_hashes: ["$everyone"],
        withfields: [{ key: "myeditors", op: "contains", value: "${user.username}", when: "before" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Alice (an editor) bumps v -> 2: allowed.
    await crm.changeDoc(
      doc,
      async (d) => {
        d.getData().v = 2;
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );

    // Bob (NOT an editor) tries to bump v -> 99: a valid signed entry that must
    // be quarantined on materialization.
    const docForBob = await crm.getDocument(docId);
    await crm.changeDoc(
      docForBob,
      async (d) => {
        d.getData().v = 99;
      },
      { signingKeyPair: bobSigning, signingKeyPassword: bobPassword },
    );

    // Read on a FRESH replica that shares the same store but never applied the
    // writes locally — this drives the access-control materialization path.
    const readerTenant = await openTenantAs(
      await factory.createUserId("CN=reader/O=acltenant", "readerpass123"),
      "readerpass123",
    );
    const readerCrm = await readerTenant.openDB("crm");
    const readDoc = await readerCrm.getDocument(docId);

    // Alice's change materialized; Bob's was quarantined, so v stays at 2.
    expect(readDoc).not.toBeNull();
    expect(readDoc!.getData().v).toBe(2);

    const log = (readerCrm as unknown as {
      getQuarantineLog: () => Array<{ reason: string; entryType: string; docId: string }>;
    }).getQuarantineLog();
    // Bob's doc_change was quarantined. Because the only rule that could permit
    // it is a Tier 2 *allow* whose content check fails for Bob, the effective
    // verdict is the baseline deny (a content-driven exclusion).
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(
      log.some(
        (r) =>
          r.entryType === "doc_change" &&
          r.docId === docId &&
          (r.reason === "tier2_denied" || r.reason === "tier1_recheck_denied"),
      ),
    ).toBe(true);
  }, 60000);

  it("quarantines a change matched by an explicit Tier 2 deny rule", async () => {
    const crm = await writerTenant.openDB("crm");
    const aliceSigning: SigningKeyPair = {
      publicKey: alice.userSigningKeyPair.publicKey,
      privateKey: alice.userSigningKeyPair.privateKey,
    };

    // Alice creates a contact she can edit.
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { title: "Beta", myeditors: [aliceUsername], status: "open", v: 1 },
    });
    const docId = doc.getId();

    // Activate ACL: changes are allowed by default, but a Tier 2 DENY rule
    // forbids changing a contact once its `status` is "archived" (checked on the
    // before state, so the archive-then-edit cannot be done in one change).
    const directory = (await writerTenant.openDirectory()) as Required<
      Pick<
        Awaited<ReturnType<typeof writerTenant.openDirectory>>,
        "setDefaultAccessPolicy" | "createAccessRule"
      >
    >;
    await directory.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.createAccessRule(
      {
        ruleId: "crm-no-edit-archived",
        type: "doc_change",
        dbid: "crm",
        action: "deny",
        users_hashes: ["$everyone"],
        withfields: [{ key: "status", op: "equals", value: "archived", when: "before" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Alice archives the contact: status open -> archived (allowed; before=open).
    await crm.changeDoc(
      doc,
      async (d) => {
        d.getData().status = "archived";
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );

    // Alice tries to edit the now-archived contact: before=archived -> Tier 2 deny.
    const archived = await crm.getDocument(docId);
    await crm.changeDoc(
      archived,
      async (d) => {
        d.getData().v = 2;
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );

    const readerTenant = await openTenantAs(
      await factory.createUserId("CN=reader2/O=acltenant", "reader2pass123"),
      "reader2pass123",
    );
    const readerCrm = await readerTenant.openDB("crm");
    const readDoc = await readerCrm.getDocument(docId);

    // The archive change applied; the post-archive edit was quarantined.
    expect(readDoc!.getData().status).toBe("archived");
    expect(readDoc!.getData().v).toBe(1);

    const log = (readerCrm as unknown as {
      getQuarantineLog: () => Array<{ reason: string; entryType: string; docId: string }>;
    }).getQuarantineLog();
    expect(
      log.some((r) => r.entryType === "doc_change" && r.docId === docId && r.reason === "tier2_denied"),
    ).toBe(true);
  }, 60000);
});
