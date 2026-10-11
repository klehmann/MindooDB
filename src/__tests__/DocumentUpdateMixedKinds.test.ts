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
 * Mixed edit kinds in ONE change (one undo step): `applyDocumentUpdate` with
 * fields, JSON patch (incl. counters), text and rich-text parts, and the
 * `changeDoc` callback with assignments and `incrementCounter`.
 *
 * Covers that all kinds combine into one store entry, and how the same field
 * touched by several kinds resolves:
 * - applyDocumentUpdate: parts apply in the documented order
 *   set → unset → json (set, unset, listDelete, listInsert, textSplice,
 *   textMark, textUnmark, counterIncrement) → text → richText → richTextSteps;
 *   a later part sees the result of the earlier ones; a part that does not fit
 *   the value an earlier part left (text on a number, increment on a plain
 *   number) fails the whole update and nothing is written.
 * - changeDoc: assignments, deletions and incrementCounter() calls on the same
 *   field resolve in call order.
 */
describe("one change with mixed edit kinds", () => {
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
    adminUser = await factory.createUserId("CN=admin/O=mixedkinds", adminUserPassword);
    currentUserPassword = createTestSecret("user");
    currentUser = await factory.createUserId("CN=testuser/O=mixedkinds", currentUserPassword);
    const keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-mixedkinds";
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

  const block = { type: "block" as const, value: { type: "p" } };
  const text = (value: string) => ({ type: "text" as const, value });

  async function changeEntryCount(docId: string): Promise<number> {
    const metas = await db.getStore().findNewEntriesForDoc([], docId);
    return metas.filter((m) => m.entryType === "doc_change").length;
  }

  async function seed(values: Record<string, unknown>): Promise<MindooDoc> {
    const doc = await db.createDocument();
    await db.applyDocumentUpdate(doc, { set: values });
    return db.getDocument(doc.getId());
  }

  /** Applies `update`, asserts it produced exactly one store entry, returns the data. */
  async function applyAsOne(doc: MindooDoc, update: MindooDocumentUpdate): Promise<Record<string, any>> {
    const before = await changeEntryCount(doc.getId());
    const result = await db.applyDocumentUpdate(doc, update);
    expect(await changeEntryCount(doc.getId())).toBe(before + 1);
    // What the result reports is what a reload reads.
    const reloaded = (await db.getDocument(doc.getId())).getData() as Record<string, any>;
    expect(reloaded).toEqual(result.data);
    return reloaded;
  }

  /** Expects `update` to fail with `error` and to leave the document untouched. */
  async function expectRejectedUnchanged(doc: MindooDoc, update: MindooDocumentUpdate, error: RegExp): Promise<void> {
    const entriesBefore = await changeEntryCount(doc.getId());
    const dataBefore = (await db.getDocument(doc.getId())).getData();
    await expect(db.applyDocumentUpdate(doc, update)).rejects.toThrow(error);
    expect(await changeEntryCount(doc.getId())).toBe(entriesBefore);
    expect((await db.getDocument(doc.getId())).getData()).toEqual(dataBefore);
  }

  describe("applyDocumentUpdate: all kinds together", () => {
    it("applies fields, every JSON operation, text and rich text as one store entry", async () => {
      const doc = await seed({
        old: "remove me",
        count: MindooValue.counter(1),
        list: [1, 2, 3],
        body: "Hello",
        marked: "bold me",
        steps: "x",
      });
      await db.applyRichTextPatch(doc, { path: ["rt"], spans: [block, text("Alpha")] });

      const data = await applyAsOne(doc, {
        set: { title: "Title", status: MindooValue.atomic("open") },
        unset: ["old"],
        json: {
          set: [{ path: ["meta", "edited"], value: true }],
          unset: [{ path: ["meta", "missing"] }],
          listDelete: [{ path: ["list"], index: 0, deleteCount: 1 }],
          listInsert: [{ path: ["list"], index: 2, values: [4] }],
          textSplice: [{ path: ["body"], index: 5, deleteCount: 0, insert: " world" }],
          textMark: [{ path: ["marked"], index: 0, length: 4, marks: { bold: true } }],
          counterIncrement: [{ path: ["count"], delta: 2 }],
        },
        text: [{ path: ["notes"], edits: [{ index: 0, deleteCount: 0, insert: "note" }] }],
        richText: [{ path: ["rt"], spans: [block, text("Alpha!")] }],
        richTextSteps: [{ path: ["steps"], steps: [{ type: "splice", index: 1, deleteCount: 0, insert: "y" }] }],
      });

      expect(data.title).toBe("Title");
      expect(data.status).toBe("open");
      expect("old" in data).toBe(false);
      expect(data.meta).toEqual({ edited: true });
      expect(data.list).toEqual([2, 3, 4]);
      expect(data.body).toBe("Hello world");
      expect(data.marked).toBe("bold me");
      expect(data.count).toBe(3);
      expect(data.notes).toBe("note");
      expect(data.rt).toBe("￼Alpha!");
      expect(data.steps).toBe("xy");
    }, 30000);

    it("writes the change even when every part targets a different nested level of one object", async () => {
      const doc = await seed({});
      const data = await applyAsOne(doc, {
        json: {
          set: [{ path: ["card"], value: { title: "", counters: { views: MindooValue.counter(0) }, lines: [] } }],
          listInsert: [{ path: ["card", "lines"], index: 0, values: ["a", "b"] }],
          counterIncrement: [{ path: ["card", "counters", "views"], delta: 5 }],
        },
        text: [{ path: ["card", "title"], edits: [{ index: 0, deleteCount: 0, insert: "Hi" }] }],
        richText: [{ path: ["card", "body"], spans: [block, text("Body")] }],
      });
      expect(data.card).toEqual({
        title: "Hi",
        counters: { views: 5 },
        lines: ["a", "b"],
        body: "￼Body",
      });
    }, 30000);
  });

  describe("applyDocumentUpdate: the same field in several kinds", () => {
    it("json set wins over a top-level set of the same field", async () => {
      const doc = await seed({ title: "start" });
      const data = await applyAsOne(doc, {
        set: { title: "from set" },
        json: { set: [{ path: ["title"], value: "from json" }] },
      });
      expect(data.title).toBe("from json");
    }, 30000);

    it("unset wins over a top-level set of the same field", async () => {
      const doc = await seed({ title: "start" });
      const data = await applyAsOne(doc, { set: { title: "from set" }, unset: ["title"] });
      expect("title" in data).toBe(false);
    }, 30000);

    it("json set recreates a field removed by unset", async () => {
      const doc = await seed({ title: "start" });
      const data = await applyAsOne(doc, {
        unset: ["title"],
        json: { set: [{ path: ["title"], value: "again" }] },
      });
      expect(data.title).toBe("again");
    }, 30000);

    it("a text patch edits the value a set assigned in the same update", async () => {
      const doc = await seed({ title: "old" });
      const data = await applyAsOne(doc, {
        set: { title: "new" },
        text: [{ path: ["title"], edits: [{ index: 3, deleteCount: 0, insert: "er" }] }],
      });
      expect(data.title).toBe("newer");
    }, 30000);

    it("a text patch on a field removed by unset starts from an empty text", async () => {
      const doc = await seed({ title: "old" });
      const data = await applyAsOne(doc, {
        unset: ["title"],
        text: [{ path: ["title"], edits: [{ index: 0, deleteCount: 0, insert: "fresh" }] }],
      });
      expect(data.title).toBe("fresh");
    }, 30000);

    it("json textSplice and a text patch on the same field both apply, json first", async () => {
      const doc = await seed({ body: "abc" });
      const data = await applyAsOne(doc, {
        json: { textSplice: [{ path: ["body"], index: 3, deleteCount: 0, insert: "d" }] },
        // Indexes refer to the text after the json part.
        text: [{ path: ["body"], edits: [{ index: 4, deleteCount: 0, insert: "e" }] }],
      });
      expect(data.body).toBe("abcde");
    }, 30000);

    it("a rich-text snapshot replaces what a text patch wrote to the same field", async () => {
      const doc = await seed({ body: "plain" });
      const data = await applyAsOne(doc, {
        text: [{ path: ["body"], edits: [{ index: 5, deleteCount: 0, insert: " text" }] }],
        richText: [{ path: ["body"], spans: [block, text("Rich")] }],
      });
      expect(data.body).toBe("￼Rich");
    }, 30000);

    it("rich-text steps apply on top of a rich-text snapshot of the same field", async () => {
      const doc = await seed({});
      const data = await applyAsOne(doc, {
        richText: [{ path: ["body"], spans: [block, text("Rich")] }],
        richTextSteps: [{ path: ["body"], steps: [{ type: "splice", index: 5, deleteCount: 0, insert: "er" }] }],
      });
      expect(data.body).toBe("￼Richer");
    }, 30000);

    it("rich text goes into an object the json part creates", async () => {
      const doc = await seed({});
      const data = await applyAsOne(doc, {
        json: { set: [{ path: ["sections"], value: [{ heading: "One" }] }] },
        richText: [{ path: ["sections", 0, "body"], spans: [block, text("First")] }],
      });
      expect(data.sections).toEqual([{ heading: "One", body: "￼First" }]);
    }, 30000);

    it("json listDelete runs before listInsert regardless of how they are listed", async () => {
      const doc = await seed({ list: ["a", "b", "c"] });
      const data = await applyAsOne(doc, {
        json: {
          listInsert: [{ path: ["list"], index: 0, values: ["x"] }],
          listDelete: [{ path: ["list"], index: 0, deleteCount: 1 }],
        },
      });
      // Delete "a" first, then insert "x" at the front.
      expect(data.list).toEqual(["x", "b", "c"]);
    }, 30000);

    it("several increments of the same counter add up", async () => {
      const doc = await seed({ count: MindooValue.counter(10) });
      const data = await applyAsOne(doc, {
        json: {
          counterIncrement: [
            { path: ["count"], delta: 5 },
            { path: ["count"], delta: -2 },
          ],
        },
      });
      expect(data.count).toBe(13);
    }, 30000);

    it("an increment counts on top of a counter the same update creates", async () => {
      const doc = await seed({});
      const data = await applyAsOne(doc, {
        set: { count: MindooValue.counter(10) },
        json: { counterIncrement: [{ path: ["count"], delta: 1 }] },
      });
      expect(data.count).toBe(11);
    }, 30000);

    it("an increment of a field removed by unset starts a new counter at the delta", async () => {
      const doc = await seed({ count: MindooValue.counter(10) });
      const data = await applyAsOne(doc, {
        unset: ["count"],
        json: { counterIncrement: [{ path: ["count"], delta: 3 }] },
      });
      expect(data.count).toBe(3);
    }, 30000);

    it("rejects the whole update when an increment hits a plain number set in it", async () => {
      const doc = await seed({ title: "start", count: MindooValue.counter(1) });
      await expectRejectedUnchanged(doc, {
        set: { title: "changed", count: 5 },
        json: { counterIncrement: [{ path: ["count"], delta: 1 }] },
      }, /Cannot increment non-counter value at 'count'/);
    }, 30000);

    it("rejects the whole update when a text patch hits a number set in it", async () => {
      const doc = await seed({ title: "start" });
      await expectRejectedUnchanged(doc, {
        set: { other: "changed", title: 42 },
        text: [{ path: ["title"], edits: [{ index: 0, deleteCount: 0, insert: "x" }] }],
      }, /Cannot apply text patch to non-string value at 'title'/);
    }, 30000);

    it("rejects the whole update when json textSplice hits a counter", async () => {
      const doc = await seed({ count: MindooValue.counter(1) });
      await expectRejectedUnchanged(doc, {
        set: { other: "changed" },
        json: { textSplice: [{ path: ["count"], index: 0, deleteCount: 0, insert: "x" }] },
      }, /non-string value at 'count'/);
    }, 30000);

    it("rejects the whole update when a text patch hits an atomic string", async () => {
      const doc = await seed({ status: MindooValue.atomic("open") });
      await expectRejectedUnchanged(doc, {
        set: { other: "changed" },
        text: [{ path: ["status"], edits: [{ index: 0, deleteCount: 0, insert: "re" }] }],
      }, /non-string value at 'status'/);
    }, 30000);

    it("rejects the whole update when rich text targets a field the json part made a list", async () => {
      const doc = await seed({ body: "text" });
      await expectRejectedUnchanged(doc, {
        json: { set: [{ path: ["body"], value: ["now", "a", "list"] }] },
        richText: [{ path: ["body"], spans: [block, text("Rich")] }],
      }, /Cannot apply rich-text patch to non-string value at 'body'/);
    }, 30000);
  });

  describe("changeDoc: assignments and incrementCounter on the same field", () => {
    it("combines assignments, deletions and increments on different fields in one entry", async () => {
      const doc = await seed({ a: 1, gone: true, count: MindooValue.counter(1) });
      const before = await changeEntryCount(doc.getId());
      await db.changeDoc(doc, (d) => {
        d.getData().a = 2;
        delete d.getData().gone;
        d.incrementCounter("count", 4);
        d.incrementCounter(["nested", "hits"], 1);
      });
      expect(await changeEntryCount(doc.getId())).toBe(before + 1);
      const data = (await db.getDocument(doc.getId())).getData();
      expect(data).toMatchObject({ a: 2, count: 5, nested: { hits: 1 } });
      expect("gone" in data).toBe(false);
    }, 30000);

    it("an increment after assigning a counter counts on top of it", async () => {
      const doc = await seed({ count: MindooValue.counter(1) });
      await db.changeDoc(doc, (d) => {
        d.getData().count = MindooValue.counter(10);
        d.incrementCounter("count", 2);
      });
      expect((await db.getDocument(doc.getId())).getData().count).toBe(12);
    }, 30000);

    it("an assignment after an increment replaces the counter, dropping the earlier increment", async () => {
      const doc = await seed({ count: MindooValue.counter(1) });
      await db.changeDoc(doc, (d) => {
        d.incrementCounter("count", 2);
        d.getData().count = MindooValue.counter(10);
      });
      expect((await db.getDocument(doc.getId())).getData().count).toBe(10);
    }, 30000);

    it("a deletion after an increment removes the field", async () => {
      const doc = await seed({ count: MindooValue.counter(1) });
      await db.changeDoc(doc, (d) => {
        d.incrementCounter("count", 2);
        delete d.getData().count;
      });
      expect("count" in (await db.getDocument(doc.getId())).getData()).toBe(false);
    }, 30000);

    it("a deletion after an increment of a nested counter removes the parent field", async () => {
      const doc = await seed({ stats: { views: MindooValue.counter(1) } });
      await db.changeDoc(doc, (d) => {
        d.incrementCounter(["stats", "views"], 2);
        delete d.getData().stats;
      });
      expect("stats" in (await db.getDocument(doc.getId())).getData()).toBe(false);
    }, 30000);

    it("an increment after a deletion starts a new counter at the delta", async () => {
      const doc = await seed({ count: MindooValue.counter(10) });
      await db.changeDoc(doc, (d) => {
        delete d.getData().count;
        d.incrementCounter("count", 3);
      });
      expect((await db.getDocument(doc.getId())).getData().count).toBe(3);
    }, 30000);

    it("rejects the change when an increment follows a plain number assignment", async () => {
      const doc = await seed({ title: "start", count: MindooValue.counter(1) });
      const before = await changeEntryCount(doc.getId());
      await expect(db.changeDoc(doc, (d) => {
        d.getData().title = "changed";
        d.getData().count = 5;
        d.incrementCounter("count", 1);
      })).rejects.toThrow(/Cannot increment non-counter value at 'count'/);
      expect(await changeEntryCount(doc.getId())).toBe(before);
      expect((await db.getDocument(doc.getId())).getData()).toMatchObject({ title: "start", count: 1 });
    }, 30000);
  });
});

function createTestSecret(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random()}`;
}
