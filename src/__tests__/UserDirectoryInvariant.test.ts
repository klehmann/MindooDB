import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  CURRENT_STORE_ENTRY_VERSION,
  DEFAULT_TENANT_KEY_ID,
  MindooTenant,
  OpenStoreOptions,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
  StoreEntry,
  StoreKind,
  USER_DIRECTORY_DB_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { NetworkErrorType } from "../core/appendonlystores/network/types";
import type { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { computeContentHash } from "../core/utils/idGeneration";
import { buildEntrySigningBytes, entrySignatureFieldsFromEntry } from "../core/crypto/EntrySignature";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";

class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(
          dbId,
          StoreKind.attachments,
          undefined,
          options,
        ),
      });
    }
    return this.stores.get(dbId)!;
  }
}

describe("userdirectory builtin write invariant", () => {
  const tenantId = "tenant-userdir-invariant";
  const crypto = new NodeCryptoAdapter();
  const adminPassword = "adminpass123";
  const alice1Password = "alice1pass123";
  const alice2Password = "alice2pass123";
  const bobPassword = "bobpass123";

  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  let admin: PrivateUserId;
  let adminKeyBag: KeyBag;
  let alice1: PrivateUserId;
  let alice2: PrivateUserId;
  let bob: PrivateUserId;
  let alice1Tenant: MindooTenant;
  let alice2Tenant: MindooTenant;
  let bobTenant: MindooTenant;
  let aliceHash: string;
  let bobHash: string;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, crypto);
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

  async function openAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      password,
      await keyBagFor(user, password),
    );
  }

  const adminSigning = () => ({
    signingKeyPair: admin.userSigningKeyPair,
    signingKeyPassword: adminPassword,
  });

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, crypto);

    admin = await factory.createUserId("CN=admin/O=udi", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, crypto);
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice1 = await factory.createUserId("CN=alice/O=udi", alice1Password);
    alice2 = await factory.createUserId("CN=alice/O=udi", alice2Password);
    bob = await factory.createUserId("CN=bob/O=udi", bobPassword);

    alice1Tenant = await openAs(alice1, alice1Password);
    const directory = await alice1Tenant.openDirectory();
    for (const u of [admin, alice1, bob]) {
      await directory.registerUser(
        factory.toPublicUserId(u),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }
    await directory.addUserKeys!(
      alice1.username,
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

    aliceHash = await directory.getUsernameHash!(alice1.username);
    bobHash = await directory.getUsernameHash!(bob.username);

    alice2Tenant = await openAs(alice2, alice2Password);
    bobTenant = await openAs(bob, bobPassword);
  }, 120000);

  async function createAliceDoc() {
    const db = await alice1Tenant.openDB(USER_DIRECTORY_DB_ID);
    return db.createDocument({
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash, marker: "original" },
    });
  }

  it("lets Alice change her document from a second device and denies Bob", async () => {
    const created = await createAliceDoc();
    const alice2Db = await alice2Tenant.openDB(USER_DIRECTORY_DB_ID);
    const alice2Doc = await alice2Db.getDocument(created.getId());
    await alice2Db.changeDoc(alice2Doc, (d) => {
      d.getData().marker = "from-device-2";
    });
    expect((await alice2Db.getDocument(created.getId())).getData().marker).toBe("from-device-2");

    const bobDb = await bobTenant.openDB(USER_DIRECTORY_DB_ID);
    const bobView = await bobDb.getDocument(created.getId());
    await expect(
      bobDb.changeDoc(bobView, (d) => {
        d.getData().marker = "hijacked";
      }),
    ).rejects.toThrow(/userdirectory: only the owning person can change/);
  }, 120000);

  it("does not let the admin change a userkey document", async () => {
    const created = await createAliceDoc();
    const db = await alice1Tenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await db.getDocument(created.getId());
    await expect(
      db.changeDoc(
        doc,
        (d) => {
          d.getData().username_hash = bobHash;
        },
        adminSigning(),
      ),
    ).rejects.toThrow(/userdirectory: the admin cannot change/);
  }, 120000);

  it("lets the admin change their own userdirectory document and keeps it after reload", async () => {
    const directory = await alice1Tenant.openDirectory();
    const adminHash = await directory.getUsernameHash!(admin.username);
    const db = await alice1Tenant.openDB(USER_DIRECTORY_DB_ID);
    const created = await db.createDocument({
      ...adminSigning(),
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: adminHash, marker: "original" },
    });
    await db.changeDoc(
      created,
      (d) => {
        d.getData().marker = "wrapped";
      },
      adminSigning(),
    );
    expect((await db.getDocument(created.getId())).getData().marker).toBe("wrapped");

    const bobView = await (await bobTenant.openDB(USER_DIRECTORY_DB_ID)).getDocument(created.getId());
    expect(bobView.getData().marker).toBe("wrapped");
  }, 120000);

  it("lets only the admin delete", async () => {
    const created = await createAliceDoc();
    const aliceDb = await alice1Tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(aliceDb.deleteDocument(created.getId())).rejects.toThrow(
      /userdirectory: only the admin can delete/,
    );
    await expect(
      aliceDb.deleteDocument(created.getId(), adminSigning()),
    ).resolves.toBeUndefined();
  }, 120000);

  it("lets the admin create for Alice and Alice create for herself, but not for Bob", async () => {
    const db = await alice1Tenant.openDB(USER_DIRECTORY_DB_ID);
    const adminCreated = await db.createDocument({
      ...adminSigning(),
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash, source: "admin" },
    });
    expect(adminCreated.getData().username_hash).toBe(aliceHash);

    const selfCreated = await db.createDocument({
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: { username_hash: aliceHash, source: "self" },
    });
    expect(selfCreated.getData().source).toBe("self");

    await expect(
      db.createDocument({
        decryptionKeyId: PUBLIC_INFOS_KEY_ID,
        initialValues: { username_hash: bobHash, source: "spoof" },
      }),
    ).rejects.toThrow(/userdirectory: create requires the admin or a matching username_hash/);
  }, 120000);

  it("lets everyone read userdirectory documents", async () => {
    const created = await createAliceDoc();
    const bobDb = await bobTenant.openDB(USER_DIRECTORY_DB_ID);
    const bobView = await bobDb.getDocument(created.getId());
    expect(bobView.getData().marker).toBe("original");
    expect(bobView.getData().username_hash).toBe(aliceHash);
  }, 120000);

  it("holds on a fresh tenant with the ACL master switch on", async () => {
    // Default factory tenants leave disableAllAccessChecksAndPolicies true.
    const aliceDb = await alice1Tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(
      aliceDb.createDocument({
        decryptionKeyId: PUBLIC_INFOS_KEY_ID,
        initialValues: { username_hash: bobHash },
      }),
    ).rejects.toThrow(/userdirectory/);
  }, 120000);

  it("rejects a forged change from the server even if the client check is skipped", async () => {
    const created = await createAliceDoc();
    const directory = await alice1Tenant.openDirectory();
    const server = new ServerNetworkContentAddressedStore(
      new InMemoryContentAddressedStore(USER_DIRECTORY_DB_ID, StoreKind.docs),
      directory,
      { validateToken: async () => ({ sub: bob.username, iat: 0, exp: 0, tenantId }) } as unknown as AuthenticationService,
      crypto,
      undefined,
      {
        witnessDbid: USER_DIRECTORY_DB_ID,
        builtinWriteContext: {
          adminPublicKey: admin.userSigningKeyPair.publicKey,
          resolveDocumentUsernameHash: async () => aliceHash,
        },
      },
    );

    const subtle = crypto.getSubtle();
    const encryptedData = new Uint8Array([1, 2, 3]);
    const contentHash = await computeContentHash(encryptedData, subtle);
    const pkcs8 = await decryptPrivateKey(crypto, bob.userSigningKeyPair.privateKey, bobPassword, "signing");
    const privateKey = await subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const base = {
      entryType: "doc_change" as const,
      id: `${created.getId()}_d_forged_bob`,
      contentHash,
      docId: created.getId(),
      dependencyIds: [],
      createdAt: Date.now(),
      createdByPublicKey: bob.userSigningKeyPair.publicKey,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      originalSize: encryptedData.length,
      encryptedSize: encryptedData.length,
      signature: new Uint8Array(),
      encryptedData,
      entryVersion: CURRENT_STORE_ENTRY_VERSION,
    } as StoreEntry;
    base.signature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, privateKey, base.encryptedData.buffer as ArrayBuffer),
    );
    const metaBytes = buildEntrySigningBytes(entrySignatureFieldsFromEntry(base));
    base.metadataSignature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, privateKey, metaBytes.buffer as ArrayBuffer),
    );

    await expect(server.handlePutEntries("token", [base])).rejects.toMatchObject({
      type: NetworkErrorType.ACCESS_DENIED,
    });
  }, 120000);

  it("silently drops an injected admin-signed change on load", async () => {
    const created = await createAliceDoc();
    const store = storeFactory.createStore(USER_DIRECTORY_DB_ID).docStore;
    const subtle = crypto.getSubtle();
    const encryptedData = new Uint8Array([9, 9, 9]);
    const contentHash = await computeContentHash(encryptedData, subtle);
    const privateKeyBytes = await decryptPrivateKey(
      crypto,
      admin.userSigningKeyPair.privateKey,
      adminPassword,
      "signing",
    );
    const privateKey = await crypto.getSubtle().importKey(
      "pkcs8",
      privateKeyBytes,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const injected = {
      entryType: "doc_change" as const,
      id: `${created.getId()}_d_injected_admin`,
      contentHash,
      docId: created.getId(),
      dependencyIds: [],
      createdAt: Date.now() + 1,
      createdByPublicKey: admin.userSigningKeyPair.publicKey,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      originalSize: encryptedData.length,
      encryptedSize: encryptedData.length,
      signature: new Uint8Array(),
      encryptedData,
      entryVersion: CURRENT_STORE_ENTRY_VERSION,
    } as StoreEntry;
    injected.signature = new Uint8Array(
      await subtle.sign(
        { name: "Ed25519" },
        privateKey,
        injected.encryptedData.buffer as ArrayBuffer,
      ),
    );
    const metaBytes = buildEntrySigningBytes(entrySignatureFieldsFromEntry(injected));
    injected.metadataSignature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, privateKey, metaBytes.buffer as ArrayBuffer),
    );
    await store.putEntries([injected]);

    const bobDb = await bobTenant.openDB(USER_DIRECTORY_DB_ID);
    const view = await bobDb.getDocument(created.getId());
    expect(view.getData().marker).toBe("original");
  }, 120000);
});
