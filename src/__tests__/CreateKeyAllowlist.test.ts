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

/**
 * Create-key allowlist (docs/accesscontrol.md §6.6) end-to-end. A policy can pin
 * which `decryptionKeyId`s a `doc_create` may use. This exercises the two client
 * enforcement points against a real database:
 *  - the create-time pre-check (`createDocument` throws for a disallowed key);
 *  - the materialization re-check (an allowed doc is judged against the policy at
 *    its own trusted time, so it survives later rotation — no retroactive
 *    invalidation).
 * It also covers rotation by policy revision and the `wasAllowedAt` audit query.
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

describe("create-key allowlist (§6.6) end-to-end", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-create-key";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let writer: PrivateUserId;
  const writerPassword = "writerpass123";
  let writerTenant: MindooTenant;
  let writerUsername: string;

  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      "setDatabaseAccessPolicy" | "setDefaultAccessPolicy" | "wasAllowedAt"
    >
  > & {
    getUserBySigningPublicKey(key: string): Promise<{ username: string } | null>;
    getEffectiveCreateKeyAllowlist(dbid: string): Promise<string[] | undefined>;
  };
  let aclDir: AclDirectory;

  async function writerKeyBag(): Promise<KeyBag> {
    const kb = new KeyBag(writer.userEncryptionKeyPair.privateKey, writerPassword, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    // Named keys the allowlist will reference; the writer holds them so it can
    // both encrypt new documents and decrypt them on read-back.
    await kb.createDocKey(tenantId, "projkey");
    await kb.createDocKey(tenantId, "projkey2");
    return kb;
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=ck", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    writer = await factory.createUserId("CN=writer/O=ck", writerPassword);
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writer,
      writerPassword,
      await writerKeyBag(),
    );

    const directory = await writerTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(admin), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(writer), admin.userSigningKeyPair.privateKey, adminPassword);
    aclDir = directory as unknown as AclDirectory;
    writerUsername = (await aclDir.getUserBySigningPublicKey(writer.userSigningKeyPair.publicKey))!.username;

    // Activate access control and restrict crm creates to "projkey".
    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseAccessPolicy(
      "crm",
      { allowedCreateKeyIds: ["projkey"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
  }, 90000);

  const NOW = () => Date.now() + 60_000; // safely after all policy revisions

  it("exposes the effective allowlist for the database", async () => {
    expect(await aclDir.getEffectiveCreateKeyAllowlist("crm")).toEqual(["projkey"]);
    // A database with no per-db policy inherits the (unset) tenant default.
    expect(await aclDir.getEffectiveCreateKeyAllowlist("other")).toBeUndefined();
  }, 90000);

  it("blocks createDocument with a disallowed key and allows the listed key", async () => {
    const crm = await writerTenant.openDB("crm");

    // The default key is not in the allowlist -> create-time pre-check throws.
    await expect(crm.createDocument({ decryptionKeyId: "default" })).rejects.toThrow(/not in allowed create-key set/);

    // The listed key succeeds and the document materializes (passes the
    // client re-check too).
    const doc = await crm.createDocument({ decryptionKeyId: "projkey" });
    const readBack = await crm.getDocument(doc.getId());
    expect(readBack).not.toBeNull();
  }, 90000);

  it("rotation by policy revision: new key required, but earlier docs stay valid", async () => {
    const crm = await writerTenant.openDB("crm");

    // Created under the projkey policy.
    const beforeRotation = await crm.createDocument({ decryptionKeyId: "projkey" });
    const beforeId = beforeRotation.getId();

    // Rotate the policy to require projkey2.
    await aclDir.setDatabaseAccessPolicy(
      "crm",
      { allowedCreateKeyIds: ["projkey2"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    expect(await aclDir.getEffectiveCreateKeyAllowlist("crm")).toEqual(["projkey2"]);

    // New creates must now use projkey2; the old key is rejected.
    await expect(crm.createDocument({ decryptionKeyId: "projkey" })).rejects.toThrow(/not in allowed create-key set/);
    const afterRotation = await crm.createDocument({ decryptionKeyId: "projkey2" });

    // The pre-rotation document is grandfathered: it is judged against the
    // policy at its own trusted time and remains visible and valid.
    const readOld = await crm.getDocument(beforeId);
    expect(readOld).not.toBeNull();
    const readNew = await crm.getDocument(afterRotation.getId());
    expect(readNew).not.toBeNull();
  }, 90000);

  it("wasAllowedAt reproduces the create-key verdict for the supplied key", async () => {
    // Against the current head policy (projkey only).
    const allowed = await aclDir.wasAllowedAt("doc_create", writerUsername, "crm", NOW(), undefined, {
      decryptionKeyId: "projkey",
    });
    expect(allowed.allowed).toBe(true);

    const denied = await aclDir.wasAllowedAt("doc_create", writerUsername, "crm", NOW(), undefined, {
      decryptionKeyId: "default",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.tier).toBe("tier1");

    // Before any policy existed, creation was unconstrained.
    const past = await aclDir.wasAllowedAt("doc_create", writerUsername, "crm", 1, undefined, {
      decryptionKeyId: "default",
    });
    expect(past.allowed).toBe(true);
  }, 90000);
});
