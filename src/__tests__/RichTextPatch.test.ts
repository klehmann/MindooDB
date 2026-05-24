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

  it("applies structured rich-text text operations at the supplied base heads", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().bodyDoc = {
        version: 1,
        blocks: [{ id: "p1", type: "paragraph", attrs: {}, text: "Hello" }],
      };
    });
    const baseHeads = doc.getHeads();

    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "insertText",
        blockId: "p1",
        offset: 5,
        text: " left",
      }],
    });
    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "insertText",
        blockId: "p1",
        offset: 0,
        text: "right ",
      }],
    });

    const reloaded = await db.getDocument(doc.getId());
    const bodyDoc = reloaded?.getData().bodyDoc as { blocks: Array<{ text?: string }> };
    const blocks = bodyDoc.blocks;
    expect(blocks[0].text).toContain("right ");
    expect(blocks[0].text).toContain("Hello");
    expect(blocks[0].text).toContain(" left");
  }, 30000);

  it("persists structured rich-text paragraph splits without rich-text span diffing", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().bodyDoc = {
        version: 1,
        blocks: [{ id: "p1", type: "paragraph", attrs: {}, text: "abcdef" }],
      };
    });
    const baseHeads = doc.getHeads();

    const result = await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "splitBlock",
        blockId: "p1",
        offset: 3,
        newBlock: { id: "p2", type: "paragraph", attrs: {}, text: "def" },
      }],
    });

    expect((result.data.bodyDoc as { blocks: unknown[] }).blocks).toEqual([
      { id: "p1", type: "paragraph", attrs: {}, text: "abc" },
      { id: "p2", type: "paragraph", attrs: {}, text: "def" },
    ]);
  }, 30000);

  it("initializes a missing structured rich-text body before replaying semantic operations", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().type = "word";
      draft.getData().body = "";
    });
    const baseHeads = doc.getHeads();

    const result = await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [
        {
          type: "setDocument",
          body: {
            version: 1,
            blocks: [{ id: "p1", type: "paragraph", attrs: {}, text: "abcdef" }],
          },
        },
        {
          type: "deleteText",
          blockId: "p1",
          offset: 1,
          length: 5,
        },
        {
          type: "insertText",
          blockId: "p1",
          offset: 1,
          text: "bcd",
        },
      ],
    });

    expect((result.data.bodyDoc as { blocks: Array<{ text?: string }> }).blocks[0].text).toBe("abcd");
  }, 30000);

  it("preserves structured rich-text inline formatting runs through semantic block replacement", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().bodyDoc = {
        version: 1,
        blocks: [{ id: "p1", type: "paragraph", attrs: {}, text: "Hello" }],
      };
    });
    const baseHeads = doc.getHeads();

    const result = await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "replaceBlock",
        blockId: "p1",
        block: {
          id: "p1",
          type: "paragraph",
          attrs: {},
          text: "Hello",
          runs: [
            { text: "He" },
            { text: "llo", marks: { bold: true, italic: true } },
          ],
        },
      }],
    });

    expect((result.data.bodyDoc as { blocks: Array<{ runs?: unknown[] }> }).blocks[0].runs).toEqual([
      { text: "He" },
      { text: "llo", marks: { bold: true, italic: true } },
    ]);
  }, 30000);

  it("merges a concurrent paragraph split with a text edit from another base", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().bodyDoc = {
        version: 1,
        blocks: [{ id: "p1", type: "paragraph", attrs: {}, text: "abcdef" }],
      };
    });
    const baseHeads = doc.getHeads();

    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "splitBlock",
        blockId: "p1",
        offset: 3,
        newBlock: { id: "p2", type: "paragraph", attrs: {}, text: "def" },
      }],
    });
    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "insertText",
        blockId: "p1",
        offset: 0,
        text: "X",
      }],
    });

    const reloaded = await db.getDocument(doc.getId());
    const blocks = (reloaded?.getData().bodyDoc as { blocks: Array<{ id: string; text?: string }> }).blocks;
    expect(blocks.some((block) => block.id === "p2" && block.text === "def")).toBe(true);
    expect(blocks.find((block) => block.id === "p1")?.text).toContain("X");
  }, 30000);

  it("merges concurrent text edits in different structured rich-text blocks without duplicating blocks", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().bodyDoc = {
        version: 1,
        blocks: [
          { id: "p1", type: "paragraph", attrs: {}, text: "first row" },
          { id: "p2", type: "paragraph", attrs: {}, text: "second row" },
        ],
      };
    });
    const baseHeads = doc.getHeads();

    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "insertText",
        blockId: "p2",
        offset: "second row".length,
        text: " from A",
      }],
    });
    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [{
        type: "insertText",
        blockId: "p1",
        offset: "first row".length,
        text: " from B",
      }],
    });

    const reloaded = await db.getDocument(doc.getId());
    const blocks = (reloaded?.getData().bodyDoc as { blocks: Array<{ id: string; text?: string }> }).blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks.find((block) => block.id === "p1")?.text).toBe("first row from B");
    expect(blocks.find((block) => block.id === "p2")?.text).toBe("second row from A");
  }, 30000);

  it("does not duplicate blocks when concurrent editors initialize the same structured rich-text body", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().type = "word";
      draft.getData().body = "";
    });
    const baseHeads = doc.getHeads();
    const baseBody = {
      version: 1 as const,
      blocks: [
        { id: "p1", type: "paragraph", attrs: {}, text: "first row" },
        { id: "p2", type: "paragraph", attrs: {}, text: "second row" },
      ],
    };

    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [
        { type: "setDocument", body: baseBody },
        {
          type: "insertText",
          blockId: "p2",
          offset: "second row".length,
          text: " from A",
        },
      ],
    });
    await db.applyStructuredRichTextPatch(doc, {
      path: ["bodyDoc"],
      baseHeads,
      operations: [
        { type: "setDocument", body: baseBody },
        {
          type: "insertText",
          blockId: "p1",
          offset: "first row".length,
          text: " from B",
        },
      ],
    });

    const reloaded = await db.getDocument(doc.getId());
    const blocks = (reloaded?.getData().bodyDoc as { blocks: Array<{ id: string; text?: string }> }).blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks.find((block) => block.id === "p1")?.text).toBe("first row from B");
    expect(blocks.find((block) => block.id === "p2")?.text).toBe("second row from A");
  }, 30000);

});

function createTestSecret(label: string) {
  return `test-${label}-${Date.now()}-${Math.random()}`;
}
