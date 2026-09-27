import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { MindooValue } from "../core/values";
import { createViewLanguage } from "../core/expressions";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Typed values (atomic strings, timestamps) and text cursors", () => {
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
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=typedvalues", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=typedvalues", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-typedvalues";
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

  it("stores atomic strings from createDocument, set and listInsert and reads them as strings", async () => {
    const doc = await db.createDocument({
      initialValues: {
        status: MindooValue.atomic("open"),
        task: { title: "Write docs", id: MindooValue.atomic("task-42") },
      },
    });
    const result = await db.applyJsonPatch(doc, {
      set: [{ path: ["owner"], value: MindooValue.atomic("u-1") }],
      listInsert: [{ path: ["tags"], index: 0, values: [MindooValue.atomic("docs"), "free text"] }],
    });

    expect(result.data.status).toBe("open");
    expect(typeof result.data.status).toBe("string");
    expect(result.data.task).toEqual({ title: "Write docs", id: "task-42" });
    expect(result.data.owner).toBe("u-1");
    expect(result.data.tags).toEqual(["docs", "free text"]);
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(
      expect.objectContaining({ status: "open" }),
    );
  }, 30000);

  it("keeps atomic strings queryable as plain strings", async () => {
    await db.createDocument({ initialValues: { status: MindooValue.atomic("open"), n: 1 } });
    await db.createDocument({ initialValues: { status: MindooValue.atomic("closed"), n: 2 } });
    const v = createViewLanguage<{ status: string; n: number }>();
    const result = await db.query!({ filter: v.eq(v.field("status"), "open") });
    expect(result.rows.map((row) => row.fields.n)).toEqual([1]);
  }, 30000);

  it("replaces atomic strings as a whole on concurrent writes", async () => {
    const doc = await db.createDocument({ initialValues: { status: MindooValue.atomic("open") } });
    const baseHeads = doc.getHeads();

    await db.applyJsonPatch(doc, {
      baseHeads,
      set: [{ path: ["status"], value: MindooValue.atomic("closed") }],
    });
    const result = await db.applyJsonPatch(doc, {
      baseHeads,
      set: [{ path: ["status"], value: MindooValue.atomic("blocked") }],
    });

    expect(["closed", "blocked"]).toContain(result.data.status);
  }, 30000);

  it("merges concurrent writes to plain text character by character (contrast)", async () => {
    const doc = await db.createDocument({ initialValues: { status: "open" } });
    const baseHeads = doc.getHeads();
    await db.applyJsonPatch(doc, {
      baseHeads,
      textSplice: [{ path: ["status"], index: 0, deleteCount: 4, insert: "closed" }],
    });
    const result = await db.applyJsonPatch(doc, {
      baseHeads,
      textSplice: [{ path: ["status"], index: 0, deleteCount: 4, insert: "blocked" }],
    });
    expect(["closed", "blocked"]).not.toContain(result.data.status);
  }, 30000);

  it("stores timestamps from Dates, epoch millis and ISO strings and reads them as Dates", async () => {
    const doc = await db.createDocument({
      initialValues: { createdAt: MindooValue.timestamp(1700000000000) },
    });
    const result = await db.applyJsonPatch(doc, {
      set: [
        { path: ["meta", "dueAt"], value: MindooValue.timestamp("2026-10-01T12:00:00.000Z") },
        { path: ["meta", "doneAt"], value: { $mindoo: "timestamp", value: 1767225600000 } },
      ],
    });

    const createdAt = result.data.createdAt as Date;
    expect(createdAt).toBeInstanceOf(Date);
    expect(createdAt.getTime()).toBe(1700000000000);
    expect(((result.data.meta as any).dueAt as Date).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(((result.data.meta as any).doneAt as Date).getTime()).toBe(1767225600000);
    expect(JSON.parse(JSON.stringify(result.data)).createdAt).toBe("2023-11-14T22:13:20.000Z");
  }, 30000);

  it("filters and sorts by timestamps through the summary buffer", async () => {
    await db.createDocument({ initialValues: { name: "late", dueAt: MindooValue.timestamp("2026-12-01T00:00:00Z") } });
    await db.createDocument({ initialValues: { name: "early", dueAt: MindooValue.timestamp("2026-02-01T00:00:00Z") } });
    await db.createDocument({ initialValues: { name: "mid", dueAt: MindooValue.timestamp(Date.UTC(2026, 5, 1)) } });
    const v = createViewLanguage<{ name: string; dueAt: string }>();

    const result = await db.query!({
      filter: v.gte(v.field("dueAt"), "2026-03-01T00:00:00.000Z"),
      sortBy: [{ field: "dueAt", direction: "ascending" }],
    });

    expect(result.coverage).toBe("full");
    expect(result.rows.map((row) => row.fields.name)).toEqual(["mid", "late"]);
    expect(result.rows[0].fields.dueAt).toBe("2026-06-01T00:00:00.000Z");
  }, 30000);

  it("returns Dates from getData whose methods work", async () => {
    const doc = await db.createDocument({ initialValues: { at: MindooValue.timestamp(0) } });
    const at = doc.getData().at as Date;
    expect(at.getTime()).toBe(0);
    expect(at.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  }, 30000);

  it("rejects malformed typed values and unknown tags", async () => {
    const doc = await db.createDocument();
    expect(() => MindooValue.timestamp("not a date")).toThrow(/ISO 8601/);
    expect(() => MindooValue.atomic(5 as unknown as string)).toThrow(/must be a string/);
    await expect(
      db.applyJsonPatch(doc, { set: [{ path: ["at"], value: { $mindoo: "timestamp", value: "nope" } }] }),
    ).rejects.toThrow(/ISO 8601/);
    await expect(
      db.applyJsonPatch(doc, { set: [{ path: ["x"], value: { nested: { $mindoo: "whatever" } } }] }),
    ).rejects.toThrow(/reserved/);
    await expect(
      db.createDocument({ initialValues: { id: { $mindoo: "atomic", value: 1 } } }),
    ).rejects.toThrow(/string value/);
  }, 30000);

  it("assigns typed values inside changeDoc", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().order = {
        note: "urgent",
        sku: MindooValue.atomic("SKU-1"),
        placedAt: MindooValue.timestamp(new Date(1700000000000)),
      };
      draft.getData().shippedAt = new Date("2026-09-27T10:00:00Z");
    });

    const data = doc.getData() as any;
    expect(data.order.sku).toBe("SKU-1");
    expect(data.order.note).toBe("urgent");
    expect(data.order.placedAt.getTime()).toBe(1700000000000);
    expect(data.shippedAt.toISOString()).toBe("2026-09-27T10:00:00.000Z");
  }, 30000);

  it("keeps text cursors attached to their character while text is inserted before them", async () => {
    const doc = await db.createDocument();
    await db.applyJsonPatch(doc, { set: [{ path: ["body"], value: "hello world" }] });

    const created = await db.getTextCursors(doc, ["body"], [6, "start", "end"]);
    expect(created.cursors).toHaveLength(3);
    expect(created.heads).toEqual(doc.getHeads());

    await db.applyJsonPatch(doc, {
      textSplice: [{ path: ["body"], index: 0, deleteCount: 0, insert: ">> " }],
    });
    await db.applyJsonPatch(doc, {
      textSplice: [{ path: ["body"], index: 14, deleteCount: 0, insert: "!" }],
    });

    const resolved = await db.resolveTextCursors(doc, ["body"], created.cursors);
    expect(doc.getData().body).toBe(">> hello world!");
    expect(resolved.positions).toEqual([9, 0, 15]);
  }, 30000);

  it("resolves a cursor whose character was deleted to where it used to be", async () => {
    const doc = await db.createDocument();
    await db.applyJsonPatch(doc, { set: [{ path: ["body"], value: "hello world" }] });
    const { cursors } = await db.getTextCursors(doc, ["body"], [8]);
    await db.applyJsonPatch(doc, {
      textSplice: [{ path: ["body"], index: 5, deleteCount: 6, insert: "" }],
    });
    const resolved = await db.resolveTextCursors(doc, ["body"], cursors);
    expect(resolved.positions).toEqual([5]);
  }, 30000);

  it("resolves move: \"before\" cursors towards the start when their character is deleted", async () => {
    const doc = await db.createDocument({ initialValues: { body: "abcdef" } });
    const after = await db.getTextCursors(doc, ["body"], [2]);
    const before = await db.getTextCursors(doc, ["body"], [2], { move: "before" });
    await db.applyJsonPatch(doc, {
      textSplice: [{ path: ["body"], index: 1, deleteCount: 3, insert: "" }],
    });

    expect(doc.getData().body).toBe("aef");
    const resolvedAfter = await db.resolveTextCursors(doc, ["body"], after.cursors);
    const resolvedBefore = await db.resolveTextCursors(doc, ["body"], before.cursors);
    expect(resolvedAfter.positions).toEqual([1]);
    expect(resolvedBefore.positions).toEqual([0]);
    await expect(
      db.getTextCursors(doc, ["body"], [0], { move: "sideways" as "before" }),
    ).rejects.toThrow(/before" or "after/);
  }, 30000);

  it("keeps cursors stable across replicas that edit concurrently and sync", async () => {
    // A second replica of the same user and tenant with its own local stores.
    const factory2 = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const tenant2 = await factory2.openTenant(
      "test-tenant-typedvalues",
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      keyBag,
    );
    try {
      await (await tenant2.openDB("directory")).pullChangesFrom(
        (await tenant.openDB("directory")).getStore(),
      );

      const doc = await db.createDocument({ initialValues: { body: "The quick fox" } });
      // Anchor "quick" (characters 4..9) on replica 1 in two ways: with an
      // exclusive end cursor on the space after it (index 9), and with an
      // inclusive end cursor on its last character "k" (index 8).
      const { cursors } = await db.getTextCursors(doc, ["body"], [4, 9, 8]);

      const db2 = await tenant2.openDB("test-db");
      await db2.pullChangesFrom(db.getStore());
      const doc2 = await db2.getDocument(doc.getId());

      // Concurrent edits: replica 1 prepends, replica 2 inserts inside the range and appends.
      await db.applyJsonPatch(doc, {
        textSplice: [{ path: ["body"], index: 0, deleteCount: 0, insert: "Look: " }],
      });
      await db2.applyJsonPatch(doc2, {
        textSplice: [
          { path: ["body"], index: 9, deleteCount: 0, insert: " brown" },
        ],
      });

      await db.pullChangesFrom(db2.getStore());
      await db2.pullChangesFrom(db.getStore());

      const merged1 = await db.getDocument(doc.getId());
      const merged2 = await db2.getDocument(doc.getId());
      expect(merged1.getData().body).toBe("Look: The quick brown fox");
      expect(merged2.getData().body).toBe(merged1.getData().body);

      // The cursors created on replica 1 resolve identically on both replicas.
      const on1 = await db.resolveTextCursors(merged1, ["body"], cursors);
      const on2 = await db2.resolveTextCursors(merged2, ["body"], cursors);
      expect(on2.positions).toEqual(on1.positions);
      const body = merged1.getData().body as string;
      const [start, exclusiveEnd, lastChar] = on1.positions;
      // A cursor names the character at its index, and text inserted exactly
      // there lands before that character: the exclusive end moved behind the
      // concurrently inserted " brown", so the range grew.
      expect(body.slice(start, exclusiveEnd)).toBe("quick brown");
      // Anchoring the last character keeps the range to "quick".
      expect(body.slice(start, lastChar + 1)).toBe("quick");
    } finally {
      await (tenant2 as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    }
  }, 60000);

  it("creates and resolves cursors at historical heads", async () => {
    const doc = await db.createDocument();
    await db.applyJsonPatch(doc, { set: [{ path: ["body"], value: "abc" }] });
    const oldHeads = doc.getHeads();
    await db.applyJsonPatch(doc, {
      textSplice: [{ path: ["body"], index: 0, deleteCount: 0, insert: "xyz" }],
    });

    const created = await db.getTextCursors(doc, ["body"], [1], { heads: oldHeads });
    expect(created.heads).toEqual(oldHeads);
    const atOld = await db.resolveTextCursors(doc, ["body"], created.cursors, { heads: oldHeads });
    const now = await db.resolveTextCursors(doc, ["body"], created.cursors);
    expect(atOld.positions).toEqual([1]);
    expect(now.positions).toEqual([4]);
  }, 30000);

  it("rejects cursors on non-text fields", async () => {
    const doc = await db.createDocument();
    await db.applyJsonPatch(doc, {
      set: [
        { path: ["id"], value: MindooValue.atomic("abc") },
        { path: ["count"], value: 3 },
      ],
    });
    await expect(db.getTextCursors(doc, ["id"], [1])).rejects.toThrow(/text field/);
    await expect(db.getTextCursors(doc, ["count"], [0])).rejects.toThrow(/text field/);
    await expect(db.getTextCursors(doc, ["missing"], [0])).rejects.toThrow(/text field/);
  }, 30000);
});
