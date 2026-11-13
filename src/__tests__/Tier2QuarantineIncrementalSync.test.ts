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
 * Same setup as CrmWorkedExample.test.ts. There a fresh replica materializes the
 * document and quarantines a tampered change. Here the replica has the document
 * loaded (cached) BEFORE the tampered change arrives, so the change reaches it
 * through syncStoreChanges' incremental path, which must apply the same rules.
 *
 * Original description of the setup: end-to-end walk of the §11 CRM worked example (docs/accesscontrol.md). One
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

describe("Tier 2 quarantine for entries that reach an already-loaded document", () => {
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

  function signing(user: PrivateUserId): SigningKeyPair {
    return { publicKey: user.userSigningKeyPair.publicKey, privateKey: user.userSigningKeyPair.privateKey };
  }

  it("quarantines a tampered change that arrives after the replica loaded the document", async () => {
    const crm = await writerTenant.openDB("crm");
    const contact = await crm.createDocument({
      signingKeyPair: signing(alice),
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", name: "ACME GmbH", myeditors: [aliceUsername], rev: 1 },
    });
    const docId = contact.getId();

    // The reader loads the document while it is still valid: it is now cached.
    const readerTenant = await openTenantAs(await factory.createUserId("CN=reader/O=crm", "readerpass123"), "readerpass123");
    const readerCrm = await readerTenant.openDB("crm");
    expect((await readerCrm.getDocument(docId))!.getData().rev).toBe(1);

    // Bob (not an editor) authors a change with a tampered client.
    await crm.changeDoc(
      (await crm.getDocument(docId))!,
      async (d) => {
        d.getData().rev = 999;
        d.getData().myeditors = [aliceUsername, "cn=bob/o=crm"];
      },
      { signingKeyPair: signing(bob), signingKeyPassword: bobPassword, bypassAccessControlPrecheck: true },
    );

    // The change reaches the reader through the incremental sync path.
    await readerCrm.syncStoreChanges();
    const readDoc = await readerCrm.getDocument(docId);
    expect(readDoc!.getData().rev).toBe(1);
    expect(readDoc!.getData().myeditors).toEqual([aliceUsername]);
    const log = (readerCrm as unknown as {
      getQuarantineLog: () => Array<{ reason: string; entryType: string; docId: string }>;
    }).getQuarantineLog();
    expect(log.some((r) => r.docId === docId && r.entryType === "doc_change")).toBe(true);
  }, 90000);

  it("still applies an allowed change that arrives after the replica loaded the document", async () => {
    const crm = await writerTenant.openDB("crm");
    const contact = await crm.createDocument({
      signingKeyPair: signing(alice),
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", name: "ACME GmbH", myeditors: [aliceUsername], rev: 1 },
    });
    const docId = contact.getId();
    const readerTenant = await openTenantAs(await factory.createUserId("CN=reader2/O=crm", "readerpass123"), "readerpass123");
    const readerCrm = await readerTenant.openDB("crm");
    expect((await readerCrm.getDocument(docId))!.getData().rev).toBe(1);

    // Alice is an editor: her change is valid and must show up.
    await crm.changeDoc(
      (await crm.getDocument(docId))!,
      async (d) => {
        d.getData().rev = 2;
      },
      { signingKeyPair: signing(alice), signingKeyPassword: alicePassword },
    );
    await readerCrm.syncStoreChanges();
    expect((await readerCrm.getDocument(docId))!.getData().rev).toBe(2);
  }, 90000);
});
