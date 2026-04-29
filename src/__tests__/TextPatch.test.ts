import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  MindooDB,
  MindooTenant,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("applyTextPatch", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=textpatch", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=textpatch", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-textpatch";
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
    const publicUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(publicUser, adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("applies stale-head text edits without overwriting newer document fields", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello world";
    });
    const baseHeads = doc.getHeads();

    await db.changeDoc(doc, (draft) => {
      draft.getData().title = "Concurrent title";
    });

    const result = await db.applyTextPatch(doc, {
      path: ["body"],
      baseHeads,
      edits: [{ index: 6, deleteCount: 0, insert: "collaborative " }],
    });

    expect(result.data.body).toBe("Hello collaborative world");
    expect(result.data.title).toBe("Concurrent title");
    expect(result.heads.length).toBeGreaterThan(0);

    (db as unknown as { docCache?: Map<string, unknown> }).docCache?.clear();
    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded.getData()).toMatchObject({
      body: "Hello collaborative world",
      title: "Concurrent title",
    });
  }, 30000);

  it("merges two stale-head text edits into one visible body", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });
    const baseHeads = doc.getHeads();

    await db.applyTextPatch(doc, {
      path: ["body"],
      baseHeads,
      edits: [{ index: 5, deleteCount: 0, insert: " from one" }],
    });

    const result = await db.applyTextPatch(doc, {
      path: ["body"],
      baseHeads,
      edits: [{ index: 5, deleteCount: 0, insert: " from two" }],
    });

    expect(result.data.body).toContain("from one");
    expect(result.data.body).toContain("from two");

    (db as unknown as { docCache?: Map<string, unknown> }).docCache?.clear();
    const reloaded = await db.getDocument(doc.getId());
    expect(String(reloaded.getData().body)).toContain("from one");
    expect(String(reloaded.getData().body)).toContain("from two");
  }, 30000);
});
