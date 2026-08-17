import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { WitnessingInMemoryContentAddressedStore } from "./_helpers/witnessingStore";
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
 * `$author` is grant-level: two devices of the same person share authorship,
 * a foreign user does not, and a revoked device cannot act as author. The
 * creator is resolved at create time so retiring the creating device does not
 * drop authorship.
 */
class SharedWitnessingStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  private readonly ticks = { n: Date.now() };

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      const ticks = this.ticks;
      class SharedClockStore extends WitnessingInMemoryContentAddressedStore {
        override nextWitnessTime(): number {
          return ++ticks.n;
        }
      }
      this.stores.set(dbId, {
        docStore: new SharedClockStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new SharedClockStore(dbId, StoreKind.attachments, undefined, options),
      });
    }
    return this.stores.get(dbId)!;
  }
}

describe("$author at grant level", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedWitnessingStoreFactory;
  const tenantId = "tenant-author-grant";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice1: PrivateUserId;
  const alice1Password = "alice1pass123";
  let alice2: PrivateUserId;
  const alice2Password = "alice2pass123";
  let bob: PrivateUserId;
  const bobPassword = "bobpass123";

  let writerTenant: MindooTenant;
  let aliceUsername: string;
  let alice1Signing: SigningKeyPair;
  let alice2Signing: SigningKeyPair;
  let bobSigning: SigningKeyPair;

  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      | "setDatabaseAccessPolicy"
      | "setDefaultAccessPolicy"
      | "createAccessRule"
      | "addUserKeys"
      | "updateUserGrant"
    >
  > & {
    getUserBySigningPublicKey(key: string): Promise<{ username: string } | null>;
  };
  let aclDir: AclDirectory;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await kb.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );
    return kb;
  }

  async function openTenantAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
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
    storeFactory = new SharedWitnessingStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=ag", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice1 = await factory.createUserId("CN=alice/O=ag", alice1Password);
    alice2 = await factory.createUserId("CN=alice/O=ag", alice2Password);
    bob = await factory.createUserId("CN=bob/O=ag", bobPassword);

    const writerUser = await factory.createUserId("CN=writer/O=ag", "writerpass123");
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writerUser,
      "writerpass123",
      await keyBagFor(writerUser, "writerpass123"),
    );

    const directory = await writerTenant.openDirectory();
    for (const u of [admin, alice1, bob, writerUser]) {
      await directory.registerUser(factory.toPublicUserId(u), admin.userSigningKeyPair.privateKey, adminPassword);
    }
    aclDir = directory as unknown as AclDirectory;
    aliceUsername = (await aclDir.getUserBySigningPublicKey(alice1.userSigningKeyPair.publicKey))!.username;

    await aclDir.addUserKeys(
      aliceUsername,
      [
        {
          signingPublicKey: alice2.userSigningKeyPair.publicKey,
          encryptionPublicKey: alice2.userEncryptionKeyPair.publicKey,
          label: "laptop",
        },
      ],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    alice1Signing = {
      publicKey: alice1.userSigningKeyPair.publicKey,
      privateKey: alice1.userSigningKeyPair.privateKey,
    };
    alice2Signing = {
      publicKey: alice2.userSigningKeyPair.publicKey,
      privateKey: alice2.userSigningKeyPair.privateKey,
    };
    bobSigning = {
      publicKey: bob.userSigningKeyPair.publicKey,
      privateKey: bob.userSigningKeyPair.privateKey,
    };

    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseAccessPolicy(
      "notes",
      { denyDocCreate: true, denyDocChange: true, denyDocDelete: true, denyDocUndelete: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aclDir.createAccessRule(
      {
        ruleId: "notes_create_everyone",
        type: "doc_create",
        dbid: "notes",
        action: "allow",
        users_hashes: ["$everyone"],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aclDir.createAccessRule(
      { ruleId: "notes_change_author", type: "doc_change", dbid: "notes", action: "allow", users_hashes: ["$author"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await aclDir.createAccessRule(
      { ruleId: "notes_delete_author", type: "doc_delete", dbid: "notes", action: "allow", users_hashes: ["$author"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
  }, 120000);

  it("lets a second device of the creator change and delete the document", async () => {
    const notes = await writerTenant.openDB("notes");
    const doc = await notes.createDocument({
      signingKeyPair: alice1Signing,
      signingKeyPassword: alice1Password,
      initialValues: { title: "from-device-1", v: 1 },
    });
    const docId = doc.getId();

    const canChange = await notes.canChange(
      doc,
      { title: "from-device-1", v: 2 },
      alice2Signing,
    );
    expect(canChange.allowed).toBe(true);

    await notes.changeDoc(
      doc,
      (d) => {
        d.getData().v = 2;
      },
      { signingKeyPair: alice2Signing, signingKeyPassword: alice2Password },
    );
    expect((await notes.getDocument(docId))!.getData().v).toBe(2);

    await notes.deleteDocument(docId, {
      signingKeyPair: alice2Signing,
      signingKeyPassword: alice2Password,
    });
    await expect(notes.getDocument(docId)).rejects.toBeInstanceOf(Error);
  }, 120000);

  it("denies a foreign user even when $author is the only allow rule", async () => {
    const notes = await writerTenant.openDB("notes");
    const doc = await notes.createDocument({
      signingKeyPair: alice1Signing,
      signingKeyPassword: alice1Password,
      initialValues: { title: "alice-only", v: 1 },
    });
    await expect(
      notes.changeDoc(
        doc,
        (d) => {
          d.getData().v = 99;
        },
        { signingKeyPair: bobSigning, signingKeyPassword: bobPassword },
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  }, 120000);

  it("denies a device that was revoked before the change, even if it created the document", async () => {
    const notes = await writerTenant.openDB("notes");
    const doc = await notes.createDocument({
      signingKeyPair: alice2Signing,
      signingKeyPassword: alice2Password,
      initialValues: { title: "soon-revoked", v: 1 },
    });
    await aclDir.updateUserGrant(
      aliceUsername,
      { revokeSigningKeys: [alice2.userSigningKeyPair.publicKey] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await expect(
      notes.changeDoc(
        doc,
        (d) => {
          d.getData().v = 2;
        },
        { signingKeyPair: alice2Signing, signingKeyPassword: alice2Password },
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  }, 120000);

  it("keeps authorship after the creating device is retired", async () => {
    const notes = await writerTenant.openDB("notes");
    const doc = await notes.createDocument({
      signingKeyPair: alice1Signing,
      signingKeyPassword: alice1Password,
      initialValues: { title: "survive-retire", v: 1 },
    });
    await aclDir.updateUserGrant(
      aliceUsername,
      { revokeSigningKeys: [alice1.userSigningKeyPair.publicKey] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await notes.changeDoc(
      doc,
      (d) => {
        d.getData().v = 2;
      },
      { signingKeyPair: alice2Signing, signingKeyPassword: alice2Password },
    );
    expect(doc.getData().v).toBe(2);
  }, 120000);

  it("keeps a change that was allowed at the time even after the signing device is later revoked", async () => {
    const notes = await writerTenant.openDB("notes");
    const doc = await notes.createDocument({
      signingKeyPair: alice1Signing,
      signingKeyPassword: alice1Password,
      initialValues: { title: "historical", v: 1 },
    });
    const docId = doc.getId();
    await notes.changeDoc(
      doc,
      (d) => {
        d.getData().v = 2;
      },
      { signingKeyPair: alice2Signing, signingKeyPassword: alice2Password },
    );

    await aclDir.updateUserGrant(
      aliceUsername,
      { revokeSigningKeys: [alice2.userSigningKeyPair.publicKey] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const readerTenant = await openTenantAs(bob, bobPassword);
    await readerTenant.openDirectory();
    const readerNotes = await readerTenant.openDB("notes");
    const readDoc = await readerNotes.getDocument(docId);
    expect(readDoc).not.toBeNull();
    expect(readDoc!.getData().v).toBe(2);
  }, 120000);
});
