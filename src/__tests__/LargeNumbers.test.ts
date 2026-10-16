import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  type MindooDB,
  type MindooDoc,
  type MindooDocumentUpdate,
  type MindooTenant,
  type PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { MindooValue } from "../core/values";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Integers beyond Number.MAX_SAFE_INTEGER (spreadsheet values like 1E+20): Automerge
 * stores a JS integer as int64 and clamps larger ones to 9223372036854775807, which
 * reads back as a BigInt. They are written as 64-bit floats instead, so they read back
 * as the numbers that were written.
 */
describe("numbers beyond the safe integer range", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    adminUserPassword = createTestSecret("admin");
    adminUser = await factory.createUserId("CN=admin/O=largenumbers", adminUserPassword);
    currentUserPassword = createTestSecret("user");
    currentUser = await factory.createUserId("CN=testuser/O=largenumbers", currentUserPassword);
    const keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-largenumbers";
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
    await directory.registerUser(factory.toPublicUserId(currentUser), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  const big = { huge: 1e20, negative: -1e20, max: Number.MAX_VALUE, safe: Number.MAX_SAFE_INTEGER }

  it("keeps them as numbers through applyDocumentUpdate (set and JSON patch)", async () => {
    const doc = await db.createDocument()
    await db.applyDocumentUpdate(doc, { set: { ...big, nested: { list: [1e21] } } })
    const first = (await db.getDocument(doc.getId())).getData() as Record<string, unknown>
    expect(typeof first.huge).toBe("number")
    await db.applyDocumentUpdate(await db.getDocument(doc.getId()), {
      json: { set: [{ path: ["patched"], value: 2e25 }] },
    })
    const data = (await db.getDocument(doc.getId())).getData() as Record<string, unknown>
    expect(data).toMatchObject({ ...big, patched: 2e25, nested: { list: [1e21] } })
    for (const value of Object.values(big)) expect(typeof value).toBe("number")
    expect(typeof data.huge).toBe("number")
  })

  it("keeps them as numbers in new documents and list inserts", async () => {
    const doc = await db.createDocument({ initialValues: { huge: 1e20, nested: { list: [1e21] } } } as never)
    await db.applyDocumentUpdate(doc, { json: { listInsert: [{ path: ["nested", "list"], index: 1, values: [3e22, { deep: -4e23 }] }] } })
    const data = (await db.getDocument(doc.getId())).getData() as Record<string, any>
    expect(data.huge).toBe(1e20)
    expect(data.nested.list).toEqual([1e21, 3e22, { deep: -4e23 }])
  })

  it("keeps them as numbers through changeDoc", async () => {
    const doc = await db.createDocument()
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), big)
    })
    const data = (await db.getDocument(doc.getId())).getData() as Record<string, unknown>
    expect(data).toMatchObject(big)
    expect(typeof data.huge).toBe("number")
  })
});

function createTestSecret(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random()}`;
}
