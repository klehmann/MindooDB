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
 * Database read/sync access gate (docs/accesscontrol.md §6.6). The tenant
 * default policy can set `denyDocRead`, and `doc_read` rules grant read/sync
 * access to specific users/groups per database. This is the coarse gate in
 * front of every sync operation: a denied user can neither open the database
 * locally (client gate) nor pull/push it (server gate), which also prevents
 * creating data in it.
 *
 * Verified here against a real tenant/directory:
 *  - reads are open by default (no read policy / denyDocRead false);
 *  - `denyDocRead` blocks a granted user unless a `doc_read` allow rule matches;
 *  - the client open path (`openDB`) throws when read access is denied;
 *  - the server gate (`evaluateDbAccessForSigningKey`) mirrors the decision;
 *  - the tenant admin is exempt and `"directory"` is never gated.
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

describe("database read access gate (doc_read)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-read-gate";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  const aliceName = "CN=alice/O=rg";
  const alicePassword = "alicepass123";
  let alice: PrivateUserId;
  let aliceTenant: MindooTenant;

  const bobName = "CN=bob/O=rg";
  const bobPassword = "bobpass123";
  let bob: PrivateUserId;
  let bobTenant: MindooTenant;

  type AclDirectory = Awaited<ReturnType<MindooTenant["openDirectory"]>> & {
    setDefaultAccessPolicy(
      policy: Record<string, unknown>,
      adminSigningPrivateKey: string,
      adminPassword: string,
    ): Promise<unknown>;
    createAccessRule(
      rule: {
        ruleId: string;
        type: string;
        dbid?: string;
        action?: "allow" | "deny";
        users_hashes?: string[];
        usernames?: string[];
        groups?: string[];
        description?: string;
      },
      adminSigningPrivateKey: string,
      adminPassword: string,
    ): Promise<unknown>;
    canReadDatabase(dbid: string): Promise<boolean>;
    evaluateDbAccessForSigningKey(input: { dbid: string; signingKey: string }): Promise<boolean>;
  };

  async function buildKeyBag(identity: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(identity.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  function aclDir(directory: Awaited<ReturnType<MindooTenant["openDirectory"]>>): AclDirectory {
    return directory as unknown as AclDirectory;
  }

  // The tenants share the underlying stores but each keeps its own in-memory
  // directory state, so a tenant only observes admin writes made via another
  // tenant after it ingests the shared directory store (the production
  // equivalent is pulling the directory database from the sync server).
  async function ingestDirectory(tenant: MindooTenant): Promise<void> {
    const dirDb = await tenant.openDB("directory");
    await dirDb.syncStoreChanges();
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=rg", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId(aliceName, alicePassword);
    bob = await factory.createUserId(bobName, bobPassword);

    aliceTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      await buildKeyBag(alice, alicePassword),
    );
    bobTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      bob,
      bobPassword,
      await buildKeyBag(bob, bobPassword),
    );

    const directory = await aliceTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(admin), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);
  }, 90000);

  it("reads are open by default (no read policy) for granted users", async () => {
    const dir = aclDir(await aliceTenant.openDirectory());
    await dir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);

    expect(await dir.canReadDatabase("main")).toBe(true);
    await expect(aliceTenant.openDB("main")).resolves.toBeDefined();
    expect(
      await dir.evaluateDbAccessForSigningKey({ dbid: "main", signingKey: alice.userSigningKeyPair.publicKey }),
    ).toBe(true);
  }, 90000);

  it("denyDocRead blocks a granted user unless a doc_read allow rule matches", async () => {
    const dir = aclDir(await aliceTenant.openDirectory());
    await dir.setDefaultAccessPolicy(
      { denyDocRead: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Grant read on "main" to alice only.
    await dir.createAccessRule(
      { ruleId: "read-main-alice", type: "doc_read", dbid: "main", action: "allow", usernames: [aliceName] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Alice (allowed) — client gate and server gate agree.
    const aliceDir = aclDir(await aliceTenant.openDirectory());
    expect(await aliceDir.canReadDatabase("main")).toBe(true);
    await expect(aliceTenant.openDB("main")).resolves.toBeDefined();
    expect(
      await aliceDir.evaluateDbAccessForSigningKey({ dbid: "main", signingKey: alice.userSigningKeyPair.publicKey }),
    ).toBe(true);

    // Bob (no rule) — client refuses to open, server gate denies sync.
    await ingestDirectory(bobTenant);
    const bobDir = aclDir(await bobTenant.openDirectory());
    expect(await bobDir.canReadDatabase("main")).toBe(false);
    await expect(bobTenant.openDB("main")).rejects.toThrow(/does not have read access/);
    expect(
      await bobDir.evaluateDbAccessForSigningKey({ dbid: "main", signingKey: bob.userSigningKeyPair.publicKey }),
    ).toBe(false);
  }, 90000);

  it("a per-database doc_read allow does not leak to other databases", async () => {
    const dir = aclDir(await aliceTenant.openDirectory());
    await dir.setDefaultAccessPolicy(
      { denyDocRead: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await dir.createAccessRule(
      { ruleId: "read-main-alice", type: "doc_read", dbid: "main", action: "allow", usernames: [aliceName] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const aliceDir = aclDir(await aliceTenant.openDirectory());
    expect(await aliceDir.canReadDatabase("main")).toBe(true);
    expect(await aliceDir.canReadDatabase("secret")).toBe(false);
    await expect(aliceTenant.openDB("secret")).rejects.toThrow(/does not have read access/);
  }, 90000);

  it("exempts the admin signing key and never gates the directory database", async () => {
    const dir = aclDir(await aliceTenant.openDirectory());
    await dir.setDefaultAccessPolicy(
      { denyDocRead: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Admin principal bypasses the read gate for any database.
    expect(
      await dir.evaluateDbAccessForSigningKey({ dbid: "main", signingKey: admin.userSigningKeyPair.publicKey }),
    ).toBe(true);
    // The directory database is never read-gated, even for a denied principal.
    expect(
      await dir.evaluateDbAccessForSigningKey({ dbid: "directory", signingKey: bob.userSigningKeyPair.publicKey }),
    ).toBe(true);
    expect(await dir.canReadDatabase("directory")).toBe(true);
  }, 90000);
});
