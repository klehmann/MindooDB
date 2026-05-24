import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("applyRichTextPatch", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    adminUserPassword = createTestSecret("admin");
    adminUser = await factory.createUserId("CN=admin/O=richtextpatch", adminUserPassword);
    currentUserPassword = createTestSecret("user");
    currentUser = await factory.createUserId("CN=testuser/O=richtextpatch", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-richtextpatch";
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

  it("applies ordered span snapshots at the supplied base heads", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });
    const baseHeads = doc.getHeads();

    await db.changeDoc(doc, (draft) => {
      draft.getData().subject = "Concurrent metadata";
    });

    const result = await db.applyRichTextPatch(doc, {
      path: ["body"],
      baseHeads,
      spansSequence: [
        [{ type: "text", value: "XHello" }],
        [{ type: "text", value: "XYHello" }],
      ],
    });

    expect(result.data.body).toBe("XYHello");
    expect(result.data.subject).toBe("Concurrent metadata");
    expect(result.heads.length).toBeGreaterThan(0);
  }, 30000);

  it("rejects patches that include both spans and spansSequence", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });

    await expect(db.applyRichTextPatch(doc, {
      path: ["body"],
      spans: [{ type: "text", value: "Hi" }],
      spansSequence: [[{ type: "text", value: "Hi" }]],
    })).rejects.toThrow(/exactly one of spans or spansSequence/);
  }, 30000);

  it("applies positional rich-text steps at the supplied base heads", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });
    const baseHeads = doc.getHeads();

    await db.changeDoc(doc, (draft) => {
      draft.getData().subject = "Concurrent metadata";
    });

    const result = await db.applyRichTextStepsPatch(doc, {
      path: ["body"],
      baseHeads,
      steps: [{
        type: "splice",
        index: 0,
        deleteCount: 0,
        insert: "X",
      }],
    });

    expect(result.data.body).toContain("X");
    expect(result.data.body).toContain("Hello");
    expect(result.data.subject).toBe("Concurrent metadata");
  }, 30000);

  it("merges concurrent rich-text splices from the same base heads", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });
    const baseHeads = doc.getHeads();

    await db.applyRichTextStepsPatch(doc, {
      path: ["body"],
      baseHeads,
      steps: [{
        type: "splice",
        index: 5,
        deleteCount: 0,
        insert: " from A",
      }],
    });
    await db.applyRichTextStepsPatch(doc, {
      path: ["body"],
      baseHeads,
      steps: [{
        type: "splice",
        index: 5,
        deleteCount: 0,
        insert: " from B",
      }],
    });

    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded?.getData().body).toContain(" from A");
    expect(reloaded?.getData().body).toContain(" from B");
  }, 30000);

  it("rejects empty positional rich-text steps", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });

    await expect(db.applyRichTextStepsPatch(doc, {
      path: ["body"],
      steps: [],
    })).rejects.toThrow(/steps must be a non-empty array/);
  }, 30000);

});

function createTestSecret(label: string) {
  return `test-${label}-${Date.now()}-${Math.random()}`;
}
