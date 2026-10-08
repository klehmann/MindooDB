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
import * as Automerge from "@automerge/automerge";

describe("applyDocumentUpdate", () => {
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

  const changeCount = (docId: string) =>
    Automerge.getAllChanges((db as any).getCachedDocument(docId).doc).length;
  const block = { type: "block" as const, value: { type: "p" } };

  it("applies a move and two text edits as one change", async () => {
    const doc = await db.createDocument();
    await db.applyDocumentUpdate(doc, {
      json: { set: [{ path: ["shape", "x"], value: 1 }, { path: ["shape", "y"], value: 1 }] },
      richText: [
        { path: ["a"], spans: [block, { type: "text", value: "Alpha" }] },
        { path: ["b"], spans: [block, { type: "text", value: "Beta" }] },
      ],
    });
    const before = changeCount(doc.getId());
    const heads = doc.getHeads();
    const result = await db.applyDocumentUpdate(doc, {
      json: { baseHeads: heads, set: [{ path: ["shape", "x"], value: 42 }] },
      richTextSteps: [
        { path: ["a"], baseHeads: heads, steps: [{ type: "splice", index: 6, deleteCount: 0, insert: "!" }] },
        { path: ["b"], baseHeads: heads, steps: [{ type: "splice", index: 1, deleteCount: 0, insert: "The " }] },
      ],
    });
    expect(changeCount(doc.getId()) - before).toBe(1);
    expect((result.data as any).shape).toEqual({ x: 42, y: 1 });
    expect(result.data.a).toBe("\uFFFCAlpha!");
    expect(result.data.b).toBe("\uFFFCThe Beta");
  }, 30000);

  it("merges with a concurrent edit when written at older heads", async () => {
    const doc = await db.createDocument();
    await db.applyRichTextPatch(doc, { path: ["body"], spans: [block, { type: "text", value: "Hello world" }] });
    const baseHeads = doc.getHeads();
    await db.applyRichTextStepsPatch(doc, {
      path: ["body"],
      baseHeads,
      steps: [{ type: "splice", index: 7, deleteCount: 0, insert: "brave " }],
    });
    const before = changeCount(doc.getId());
    const result = await db.applyDocumentUpdate(doc, {
      set: { title: "Greeting" },
      json: { baseHeads, set: [{ path: ["meta", "edited"], value: true }] },
      richText: [{ path: ["body"], baseHeads, spans: [block, { type: "text", value: "Hello world!" }] }],
    });
    expect(changeCount(doc.getId()) - before).toBe(1);
    expect(result.data.body).toBe("\uFFFCHello brave world!");
    expect(result.data.title).toBe("Greeting");
    expect((result.data as any).meta).toEqual({ edited: true });
  }, 30000);

  it("applies nothing when one part fails", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().count = 3;
    });
    const heads = doc.getHeads();
    await expect(
      db.applyDocumentUpdate(doc, {
        json: { set: [{ path: ["moved"], value: true }] },
        richText: [{ path: ["count"], spans: [{ type: "text", value: "x" }] }],
      }),
    ).rejects.toThrow(/non-string value/);
    expect(doc.getHeads()).toEqual(heads);
    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded?.getData().moved).toBeUndefined();
  }, 30000);

  it("rejects parts with different base heads", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "x";
    });
    const first = doc.getHeads();
    await db.changeDoc(doc, (draft) => {
      draft.getData().other = 1;
    });
    await expect(
      db.applyDocumentUpdate(doc, {
        json: { baseHeads: first, set: [{ path: ["a"], value: 1 }] },
        text: [{ path: ["body"], baseHeads: doc.getHeads(), edits: [{ index: 0, deleteCount: 0, insert: "y" }] }],
      }),
    ).rejects.toThrow(/share their baseHeads/);
  }, 30000);
});

function createTestSecret(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random()}`;
}
