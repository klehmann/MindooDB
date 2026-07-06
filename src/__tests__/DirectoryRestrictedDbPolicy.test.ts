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
 * Directory-restricted database policy (docs/accesscontrol.md). The tenant
 * default policy can switch `databaseCreationPolicy` to `"directory-restricted"`
 * and pin an `allowedDbIds` allowlist. This exercises the client open-path
 * enforcement against a real tenant:
 *  - `"open"` (the default) allows any valid database id;
 *  - `"directory-restricted"` allows only `"directory"` (implicit) and listed
 *    ids for a granted non-admin user;
 *  - the tenant admin is always exempt.
 * It also round-trips the policy projection through the directory.
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

describe("directory-restricted database policy (client open path)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-db-policy";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let writer: PrivateUserId;
  const writerPassword = "writerpass123";
  let writerTenant: MindooTenant;

  type AclDirectory = Awaited<ReturnType<MindooTenant["openDirectory"]>> & {
    setDefaultAccessPolicy(
      policy: Record<string, unknown>,
      adminSigningPrivateKey: string,
      adminPassword: string,
    ): Promise<unknown>;
    getDatabaseCreationPolicy(): Promise<{
      mode: "open" | "directory-restricted";
      allowedDbIds: string[];
    }>;
    isDatabaseAllowed(dbid: string, opts?: { signingKey?: string }): Promise<boolean>;
  };

  async function buildKeyBag(identity: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(identity.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=dbp", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    writer = await factory.createUserId("CN=writer/O=dbp", writerPassword);
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writer,
      writerPassword,
      await buildKeyBag(writer, writerPassword),
    );

    const directory = await writerTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(admin), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(writer), admin.userSigningKeyPair.privateKey, adminPassword);
  }, 90000);

  function aclDir(directory: Awaited<ReturnType<MindooTenant["openDirectory"]>>): AclDirectory {
    return directory as unknown as AclDirectory;
  }

  it("defaults to open mode and allows any database id", async () => {
    // Access control on, but no database-open restriction configured.
    const dir = aclDir(await writerTenant.openDirectory());
    await dir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);

    expect(await dir.getDatabaseCreationPolicy()).toEqual({ mode: "open", allowedDbIds: [] });

    await expect(writerTenant.openDB("main")).resolves.toBeDefined();
    await expect(writerTenant.openDB("anything-goes")).resolves.toBeDefined();
  }, 90000);

  it("restricted mode allows directory + listed ids and blocks the rest for a granted user", async () => {
    const dir = aclDir(await writerTenant.openDirectory());
    await dir.setDefaultAccessPolicy(
      { databaseCreationPolicy: "directory-restricted", allowedDbIds: ["main"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Round-trip projection reflects the written fields.
    expect(await dir.getDatabaseCreationPolicy()).toEqual({
      mode: "directory-restricted",
      allowedDbIds: ["main"],
    });

    await expect(writerTenant.openDB("main")).resolves.toBeDefined();
    await expect(writerTenant.openDB("directory")).resolves.toBeDefined();
    await expect(writerTenant.openDB("other")).rejects.toThrow(
      /not in the tenant's allowed database list/,
    );
  }, 90000);

  it("exempts the tenant admin from the allowlist (signing-key bypass)", async () => {
    const dir = aclDir(await writerTenant.openDirectory());
    await dir.setDefaultAccessPolicy(
      { databaseCreationPolicy: "directory-restricted", allowedDbIds: ["main"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Without a signing key (the granted-user path) the allowlist applies; with
    // the admin signing key (the server token-principal path) it is bypassed.
    expect(await dir.isDatabaseAllowed("other")).toBe(false);
    expect(
      await dir.isDatabaseAllowed("other", { signingKey: admin.userSigningKeyPair.publicKey }),
    ).toBe(true);
    // Listed ids and the directory are allowed regardless of principal.
    expect(await dir.isDatabaseAllowed("main")).toBe(true);
    expect(await dir.isDatabaseAllowed("directory")).toBe(true);
  }, 90000);

  it("treats a tenant without an acl_defaultpolicy as open", async () => {
    const dir = aclDir(await writerTenant.openDirectory());
    // No setDefaultAccessPolicy call: access control is off.
    expect(await dir.getDatabaseCreationPolicy()).toEqual({ mode: "open", allowedDbIds: [] });
    await expect(writerTenant.openDB("freeform")).resolves.toBeDefined();
  }, 90000);

  it("validates allowedDbIds entries at write time", async () => {
    const dir = aclDir(await writerTenant.openDirectory());
    await expect(
      dir.setDefaultAccessPolicy(
        { databaseCreationPolicy: "directory-restricted", allowedDbIds: ["bad id with spaces"] },
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow();
  }, 90000);
});
