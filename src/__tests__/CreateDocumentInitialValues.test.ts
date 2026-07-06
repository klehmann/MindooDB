import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Tests for `CreateOptions.initialValues` (docs/accesscontrol.md §6.3, §9).
 *
 * The values must be present in the document produced by the `doc_create`
 * change so a `doc_create` Tier 2 rule can evaluate them against the "after"
 * state. Reserved/internal fields are ignored, and the feature is rejected on
 * the convergence-sensitive custom-id path.
 */
describe("createDocument initialValues", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=initvals", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=initvals", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-initvals";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      keyBag,
    );
    const directory = await tenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(currentUser),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("seeds initial values into the created document", async () => {
    const doc = await db.createDocument({
      initialValues: { form: "CRMContact", name: "ACME GmbH", myeditors: ["cn=alice/o=acme"] },
    });
    const data = doc.getData();
    expect(data.form).toBe("CRMContact");
    expect(data.name).toBe("ACME GmbH");
    expect(data.myeditors).toEqual(["cn=alice/o=acme"]);

    // Values must persist on reload (i.e. they are part of the doc_create change).
    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded.getData()).toMatchObject({
      form: "CRMContact",
      name: "ACME GmbH",
      myeditors: ["cn=alice/o=acme"],
    });
  }, 30000);

  it("ignores reserved/internal field names", async () => {
    const doc = await db.createDocument({
      initialValues: { _attachments: ["malicious"], _private: 1, ok: "yes" } as Record<string, unknown>,
    });
    const data = doc.getData();
    expect(data.ok).toBe("yes");
    // _attachments must remain MindooDB-managed (empty array), not the injected value.
    expect(data._attachments).toEqual([]);
    expect(data._private).toBeUndefined();
  }, 30000);

  it("rejects initialValues together with a custom id", async () => {
    await expect(
      db.createDocument({ id: "AppSettings", initialValues: { theme: "dark" } }),
    ).rejects.toThrow(/not supported together with a custom id/i);
  }, 30000);

  it("treats initialValues with only reserved keys as no values (custom id allowed)", async () => {
    // Only reserved keys -> effectively empty -> custom id path is fine.
    const doc = await db.createDocument({
      id: "WithReserved",
      initialValues: { _attachments: ["x"] } as Record<string, unknown>,
    });
    expect(doc.getId()).toBe("WithReserved");
  }, 30000);
});
