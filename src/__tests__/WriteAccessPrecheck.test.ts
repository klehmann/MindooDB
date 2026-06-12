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
import { AccessDeniedError } from "../core/accesscontrol/AccessDeniedError";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Synchronous client-side write-policy prechecks (docs/accesscontrol.md §9).
 *
 * Same `crm` policy as the §11 worked example: baseline deny for create/change/
 * delete, plus allow rules:
 *  - create if the creator lists themselves in `myeditors` (Tier 2, after);
 *  - change only by an existing editor (Tier 2, before);
 *  - delete only by the creator (Tier 1, `$author`).
 *
 * Verifies that an honest client's createDocument / changeDoc / deleteDocument
 * throws {@link AccessDeniedError} at the call site when denied, that allowed
 * writes succeed, that the non-throwing canCreate/canChange/canDelete
 * predictions agree, and that `bypassAccessControlPrecheck` skips the gate.
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

describe("client write-policy prechecks (§9)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-write-precheck";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice: PrivateUserId;
  const alicePassword = "alicepass123";
  let bob: PrivateUserId;
  const bobPassword = "bobpass123";

  let writerTenant: MindooTenant;
  let aliceUsername: string;

  let aliceSigning: SigningKeyPair;
  let bobSigning: SigningKeyPair;

  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      "setDatabaseAccessPolicy" | "setDefaultAccessPolicy" | "createAccessRule"
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

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=wp", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=wp", alicePassword);
    bob = await factory.createUserId("CN=bob/O=wp", bobPassword);

    const writerUser = await factory.createUserId("CN=writer/O=wp", "writerpass123");
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writerUser,
      "writerpass123",
      await keyBagFor(writerUser, "writerpass123"),
    );

    const directory = await writerTenant.openDirectory();
    for (const u of [admin, alice, bob, writerUser]) {
      await directory.registerUser(factory.toPublicUserId(u), admin.userSigningKeyPair.privateKey, adminPassword);
    }
    aclDir = directory as unknown as AclDirectory;
    aliceUsername = (await aclDir.getUserBySigningPublicKey(alice.userSigningKeyPair.publicKey))!.username;

    aliceSigning = { publicKey: alice.userSigningKeyPair.publicKey, privateKey: alice.userSigningKeyPair.privateKey };
    bobSigning = { publicKey: bob.userSigningKeyPair.publicKey, privateKey: bob.userSigningKeyPair.privateKey };

    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseAccessPolicy(
      "crm",
      { denyDocCreate: true, denyDocChange: true, denyDocDelete: true, denyDocUndelete: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
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
    await aclDir.createAccessRule(
      { ruleId: "crm_delete_by_author", type: "doc_delete", dbid: "crm", action: "allow", users_hashes: ["$author"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aclDir.createAccessRule(
      { ruleId: "crm_undelete_by_author", type: "doc_undelete", dbid: "crm", action: "allow", users_hashes: ["$author"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
  }, 90000);

  it("createDocument throws AccessDeniedError when the creator omits themselves from myeditors", async () => {
    const crm = await writerTenant.openDB("crm");
    await expect(
      crm.createDocument({
        signingKeyPair: aliceSigning,
        signingKeyPassword: alicePassword,
        initialValues: { form: "CRMContact", name: "ACME", myeditors: [] },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  }, 90000);

  it("createDocument succeeds when the creator lists themselves (Tier 2 after)", async () => {
    const crm = await writerTenant.openDB("crm");
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", name: "ACME", myeditors: [aliceUsername], rev: 1 },
    });
    expect(doc.getId()).toBeTruthy();
    expect(doc.getData().rev).toBe(1);
  }, 90000);

  it("changeDoc throws AccessDeniedError for a non-editor and succeeds for an editor", async () => {
    const crm = await writerTenant.openDB("crm");
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", myeditors: [aliceUsername], rev: 1 },
    });
    const docId = doc.getId();

    // Bob is not an editor -> denied.
    const forBob = await crm.getDocument(docId);
    await expect(
      crm.changeDoc(
        forBob!,
        (d) => {
          d.getData().rev = 2;
        },
        { signingKeyPair: bobSigning, signingKeyPassword: bobPassword },
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // Alice is an editor (before-state) -> allowed.
    const forAlice = await crm.getDocument(docId);
    await crm.changeDoc(
      forAlice!,
      (d) => {
        d.getData().rev = 3;
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );
    const after = await crm.getDocument(docId);
    expect(after!.getData().rev).toBe(3);
  }, 90000);

  it("deleteDocument is allowed for the creator ($author) and denied for others", async () => {
    const crm = await writerTenant.openDB("crm");
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", myeditors: [aliceUsername] },
    });
    const docId = doc.getId();

    // Bob did not author it -> baseline deny, no $author match.
    await expect(
      crm.deleteDocument(docId, { signingKeyPair: bobSigning, signingKeyPassword: bobPassword }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // Alice authored it -> allowed (resolves without throwing).
    await expect(
      crm.deleteDocument(docId, { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword }),
    ).resolves.toBeUndefined();
    // The document is now a tombstone (getDocument rejects for deleted docs).
    await expect(crm.getDocument(docId)).rejects.toThrow(/has been deleted/);
  }, 90000);

  it("AccessDeniedError carries the op, dbid, and decision", async () => {
    const crm = await writerTenant.openDB("crm");
    let captured: AccessDeniedError | null = null;
    try {
      await crm.createDocument({
        signingKeyPair: aliceSigning,
        signingKeyPassword: alicePassword,
        initialValues: { form: "CRMContact", myeditors: [] },
      });
    } catch (e) {
      captured = e as AccessDeniedError;
    }
    expect(captured).toBeInstanceOf(AccessDeniedError);
    expect(captured!.op).toBe("doc_create");
    expect(captured!.dbid).toBe("crm");
    expect(captured!.decision.allowed).toBe(false);
    expect(typeof captured!.decision.reason).toBe("string");
  }, 90000);

  it("bypassAccessControlPrecheck lets an honest call skip the gate (server stays authoritative)", async () => {
    const crm = await writerTenant.openDB("crm");
    // Would be denied (no self in myeditors), but the bypass skips the precheck.
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", myeditors: [] },
      bypassAccessControlPrecheck: true,
    });
    expect(doc.getId()).toBeTruthy();
  }, 90000);

  it("canCreate / canChange / canDelete predict the same verdicts without writing", async () => {
    const crm = await writerTenant.openDB("crm");

    const createDenied = await crm.canCreate({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { myeditors: [] },
    });
    expect(createDenied.allowed).toBe(false);

    const createAllowed = await crm.canCreate({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { myeditors: [aliceUsername] },
    });
    expect(createAllowed.allowed).toBe(true);
    expect(createAllowed.matchedRuleId).toBe("crm_create_self_editor");

    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { form: "CRMContact", myeditors: [aliceUsername], rev: 1 },
    });

    const changeByBob = await crm.canChange(doc, { ...doc.getData(), rev: 9 }, bobSigning);
    expect(changeByBob.allowed).toBe(false);

    const changeByAlice = await crm.canChange(doc, { ...doc.getData(), rev: 9 }, aliceSigning);
    expect(changeByAlice.allowed).toBe(true);

    const deleteByBob = await crm.canDelete(doc, bobSigning);
    expect(deleteByBob.allowed).toBe(false);

    const deleteByAlice = await crm.canDelete(doc, aliceSigning);
    expect(deleteByAlice.allowed).toBe(true);
    expect(deleteByAlice.matchedRuleId).toBe("crm_delete_by_author");

    const undeleteByBob = await crm.canUndelete(doc, bobSigning);
    expect(undeleteByBob.allowed).toBe(false);

    const undeleteByAlice = await crm.canUndelete(doc, aliceSigning);
    expect(undeleteByAlice.allowed).toBe(true);
    expect(undeleteByAlice.matchedRuleId).toBe("crm_undelete_by_author");
  }, 90000);
});
