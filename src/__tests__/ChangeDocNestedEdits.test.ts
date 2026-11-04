import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { diffTextSplice } from "../core/ChangeDocDraft";
import { KeyBag } from "../core/keys/KeyBag";
import {
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
} from "../core/types";
import { MindooValue } from "../core/values";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * `changeDoc()` records edits at any depth of `getData()`, not only top-level
 * assignments: nested sets and deletes and list methods (push, splice, ...). List and text edits
 * from two replicas must merge like the equivalent `applyJsonPatch()` calls.
 * Text set through `updateText()` is stored as a splice; a plain string
 * assignment keeps replacing the whole value.
 */
describe("changeDoc: nested edits", () => {
  const tenantId = "test-tenant-nested";
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  const adminPassword = "admin-pass";
  let user: PrivateUserId;
  const userPassword = "user-pass";
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    adminUser = await factory.createUserId("CN=admin/O=nested", adminPassword);
    user = await factory.createUserId("CN=user/O=nested", userPassword);
    keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, userPassword, factory.getCryptoAdapter());
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      keyBag,
    );
    const directory = await tenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(user), adminUser.userSigningKeyPair.privateKey, adminPassword);
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  async function seed(values: Record<string, unknown>): Promise<string> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), values);
    });
    return doc.getId();
  }

  async function read(target: MindooDB, docId: string): Promise<Record<string, unknown>> {
    const data = { ...(await target.getDocument(docId)).getData() } as Record<string, unknown>;
    delete data._lastModified;
    delete data._attachments;
    return JSON.parse(JSON.stringify(data));
  }

  async function change(target: MindooDB, docId: string, fn: (data: any) => void | Promise<void>): Promise<void> {
    await target.changeDoc(await target.getDocument(docId), (d) => fn(d.getData()));
  }

  test("list methods are stored", async () => {
    const id = await seed({ tags: ["a", "b", "c"] });
    await change(db, id, (data) => {
      expect(data.tags.push("d", "e")).toBe(5);
      expect(data.tags.shift()).toBe("a");
      data.tags.unshift("z");
      expect(data.tags.pop()).toBe("e");
      expect(data.tags.splice(1, 1, "B1", "B2")).toEqual(["b"]);
      data.tags[data.tags.length] = "end";
      data.tags[0] = "Z";
      // Reads inside the callback see the edits so far.
      expect([...data.tags]).toEqual(["Z", "B1", "B2", "c", "d", "end"]);
      expect(data.tags.includes("B2")).toBe(true);
    });
    expect((await read(db, id)).tags).toEqual(["Z", "B1", "B2", "c", "d", "end"]);

    await change(db, id, (data) => {
      data.tags.length = 2;
      data.tags.reverse();
    });
    expect((await read(db, id)).tags).toEqual(["B1", "Z"]);

    await change(db, id, (data) => {
      data.tags.push("a");
      data.tags.sort();
    });
    expect((await read(db, id)).tags).toEqual(["B1", "Z", "a"]);
  });

  test("nested objects: set, delete, new objects edited further, lists of objects", async () => {
    const id = await seed({
      meta: { owner: { name: "Karsten", city: "Köln" }, size: 1 },
      rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
    });
    await change(db, id, (data) => {
      data.meta.owner.city = "Bonn";
      delete data.meta.size;
      data.meta.extra = { list: [] };
      data.meta.extra.list.push({ x: 1 });
      data.meta.extra.list[0].y = 2;
      // An element proxy kept across a splice still edits that element.
      const third = data.rows[2];
      data.rows.splice(0, 1);
      third.n = 30;
      data.rows.push({ n: 4 });
      data.rows[2].n = 40;
    });
    expect(await read(db, id)).toEqual({
      meta: { owner: { name: "Karsten", city: "Bonn" }, extra: { list: [{ x: 1, y: 2 }] } },
      rows: [{ n: 2 }, { n: 30 }, { n: 40 }],
    });
  });

  test("assigning a value read from the document copies it", async () => {
    const id = await seed({ a: { list: [1, 2] } });
    await change(db, id, (data) => {
      data.b = data.a;
      data.b.list.push(3);
    });
    expect(await read(db, id)).toEqual({ a: { list: [1, 2] }, b: { list: [1, 2, 3] } });
  });

  test("an edit to a removed element is refused instead of landing elsewhere", async () => {
    const id = await seed({ rows: [{ n: 1 }, { n: 2 }] });
    await expect(
      change(db, id, (data) => {
        const first = data.rows[0];
        data.rows.shift();
        first.n = 10;
      }),
    ).rejects.toThrow(/no longer part of the document/);
    expect((await read(db, id)).rows).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("typed values and counters inside nested containers", async () => {
    const id = await seed({ stats: { views: MindooValue.counter(1) }, labels: [] });
    await change(db, id, (data) => {
      data.labels.push(MindooValue.atomic("open"));
      expect(data.stats.views).toBe(1);
    });
    await db.changeDoc(await db.getDocument(id), (d) => {
      d.incrementCounter(["stats", "views"], 2);
    });
    expect(await read(db, id)).toEqual({ stats: { views: 3 }, labels: ["open"] });
  });

  test("async callbacks keep working", async () => {
    const id = await seed({ tags: [] });
    await change(db, id, async (data) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      data.tags.push("later");
    });
    expect((await read(db, id)).tags).toEqual(["later"]);
  });

  test("lists refuse holes, named properties and delete", async () => {
    const id = await seed({ tags: ["a"] });
    await expect(change(db, id, (data) => { data.tags[3] = "x"; })).rejects.toThrow(/past the end/);
    await expect(change(db, id, (data) => { data.tags.foo = "x"; })).rejects.toThrow(/named property/);
    await expect(change(db, id, (data) => { delete data.tags[0]; })).rejects.toThrow(/splice/);
  });

  test("updateText stores a splice; a plain assignment replaces", async () => {
    const id = await seed({ meta: { title: "Projektplan" }, status: "open" });
    await db.changeDoc(await db.getDocument(id), (d) => {
      d.updateText(["meta", "title"], "Neuer Projektplan");
      expect(d.getData().meta.title).toBe("Neuer Projektplan");
      d.updateText("summary", "neu");
    });
    expect(await read(db, id)).toEqual({ meta: { title: "Neuer Projektplan" }, status: "open", summary: "neu" });
    await expect(
      db.changeDoc(await db.getDocument(id), (d) => d.updateText("meta", "x")),
    ).rejects.toThrow(/not text/);
    const outside = await db.getDocument(id);
    expect(() => outside.updateText("status", "x")).toThrow(/only be called within changeDoc/);
  });

  test("diffTextSplice", () => {
    expect(diffTextSplice("Projektplan", "Neuer Projektplan")).toEqual({ index: 0, deleteCount: 0, insert: "Neuer " });
    expect(diffTextSplice("Projektplan", "Projektplan 2027")).toEqual({ index: 11, deleteCount: 0, insert: " 2027" });
    expect(diffTextSplice("abcdef", "abXef")).toEqual({ index: 2, deleteCount: 2, insert: "X" });
    expect(diffTextSplice("aaa", "aa")).toEqual({ index: 2, deleteCount: 1, insert: "" });
    expect(diffTextSplice("same", "same")).toBeNull();
    // Never splits a surrogate pair (two emoji sharing the high surrogate).
    const splice = diffTextSplice("x😀", "x😁")!;
    expect(splice).toEqual({ index: 1, deleteCount: 2, insert: "😁" });
  });

  describe("two replicas", () => {
    let dbB: MindooDB;

    beforeEach(async () => {
      const factoryB = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
      const userB = await factoryB.createUserId("CN=replicaB/O=nested", "userBpass");
      const keyBagB = new KeyBag(userB.userEncryptionKeyPair.privateKey, "userBpass", factoryB.getCryptoAdapter());
      await keyBagB.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await keyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
      await keyBagB.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
      const tenantB = await factoryB.openTenant(
        tenantId,
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        userB,
        "userBpass",
        keyBagB,
      );
      const directoryA = await tenant.openDirectory();
      await directoryA.registerUser(factoryB.toPublicUserId(userB), adminUser.userSigningKeyPair.privateKey, adminPassword);
      await (await tenantB.openDB("directory")).pullChangesFrom((await tenant.openDB("directory")).getStore());
      dbB = await tenantB.openDB("test-db");
    }, 30000);

    async function syncBothWays(): Promise<void> {
      await dbB.pullChangesFrom(db.getStore());
      await db.pullChangesFrom(dbB.getStore());
      await db.syncStoreChanges();
      await dbB.syncStoreChanges();
    }

    test("concurrent push, nested edits and updateText merge", async () => {
      const id = await seed({ title: "Projektplan", tags: ["start"], meta: { owner: "?" }, state: "neu" });
      await syncBothWays();

      await db.changeDoc(await db.getDocument(id), (d) => {
        const data = d.getData() as any;
        data.tags.push("karsten");
        d.updateText("title", data.title + " 2027");
        data.meta.status = "in Arbeit";
        data.state = "Karsten";
      });
      await dbB.changeDoc(await dbB.getDocument(id), (d) => {
        const data = d.getData() as any;
        data.tags.push("jane");
        d.updateText("title", "Neuer " + data.title);
        data.meta.owner = "Jane";
        data.state = "Jane";
      });
      await syncBothWays();

      const a = await read(db, id);
      expect(await read(dbB, id)).toEqual(a);
      expect(a.title).toBe("Neuer Projektplan 2027");
      expect([...(a.tags as string[])].sort()).toEqual(["jane", "karsten", "start"]);
      expect((a.tags as string[])[0]).toBe("start");
      expect(a.meta).toEqual({ owner: "Jane", status: "in Arbeit" });
      // Plain assignments still replace: one value wins, never a mix.
      expect(["Karsten", "Jane"]).toContain(a.state);
    });
  });
});
