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
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Automerge counters", () => {
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
    adminUser = await factory.createUserId("CN=admin/O=counters", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=counters", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-counters";
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

  it("creates a counter from a typed value and reads it as a plain number", async () => {
    const doc = await db.createDocument({
      initialValues: { title: "Stats", stats: { views: MindooValue.counter(5) } },
    });

    const data = doc.getData() as any;
    expect(data.stats.views).toBe(5);
    expect(typeof data.stats.views).toBe("number");
    expect(JSON.parse(JSON.stringify(data))).toEqual(
      expect.objectContaining({ title: "Stats", stats: { views: 5 } }),
    );
  }, 30000);

  it("sums increments authored against the same stale heads", async () => {
    const doc = await db.createDocument({ initialValues: { votes: MindooValue.counter(10) } });
    const baseHeads = doc.getHeads();

    await db.applyJsonPatch(doc, { baseHeads, counterIncrement: [{ path: ["votes"], delta: 3 }] });
    const result = await db.applyJsonPatch(doc, {
      baseHeads,
      counterIncrement: [{ path: ["votes"], delta: -1 }],
    });

    expect(result.data.votes).toBe(12);
  }, 30000);

  it("creates counters through JSON patch set values", async () => {
    const doc = await db.createDocument();
    await db.applyJsonPatch(doc, { set: [{ path: ["likes"], value: MindooValue.counter(0) }] });
    const result = await db.applyJsonPatch(doc, {
      counterIncrement: [{ path: ["likes"], delta: 4 }],
    });
    expect(result.data.likes).toBe(4);
  }, 30000);

  it("initializes a missing counter from counterIncrement", async () => {
    const doc = await db.createDocument();
    const result = await db.applyJsonPatch(doc, {
      counterIncrement: [{ path: ["likes"], delta: 2 }],
    });
    expect(result.data.likes).toBe(2);
  }, 30000);

  it("rejects incrementing a plain number", async () => {
    const doc = await db.createDocument({ initialValues: { plain: 4 } });
    await expect(
      db.applyJsonPatch(doc, { counterIncrement: [{ path: ["plain"], delta: 1 }] }),
    ).rejects.toThrow(/non-counter/);
  }, 30000);

  it("rejects non-integer counter amounts", async () => {
    const doc = await db.createDocument();
    await expect(
      db.applyJsonPatch(doc, { counterIncrement: [{ path: ["n"], delta: 0.5 }] }),
    ).rejects.toThrow(/safe integer/);
    expect(() => MindooValue.counter(Number.NaN)).toThrow(/safe integer/);
    await expect(
      db.applyJsonPatch(doc, { set: [{ path: ["n"], value: { $mindoo: "counter", value: 1.5 } }] }),
    ).rejects.toThrow(/safe integer/);
  }, 30000);

  it("assigns and increments counters inside changeDoc", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().inventory = { name: "Widget", stock: MindooValue.counter(100) };
    });
    await db.changeDoc(doc, (draft) => {
      draft.incrementCounter(["inventory", "stock"], -3);
      draft.incrementCounter(["inventory", "stock"], -2);
      draft.incrementCounter("orders", 1);
    });

    const data = doc.getData() as any;
    expect(data.inventory).toEqual({ name: "Widget", stock: 95 });
    expect(data.orders).toBe(1);
  }, 30000);

  it("reads top-level counters as numbers inside changeDoc", async () => {
    const doc = await db.createDocument({ initialValues: { count: MindooValue.counter(7) } });
    let seen: unknown;
    await db.changeDoc(doc, (draft) => {
      seen = draft.getData().count;
      draft.incrementCounter("count", 1);
    });
    expect(seen).toBe(7);
    expect(doc.getData().count).toBe(8);
  }, 30000);

  it("throws when incrementCounter is used outside changeDoc", async () => {
    const doc = await db.createDocument();
    expect(() => doc.incrementCounter("count", 1)).toThrow(/changeDoc/);
  }, 30000);
});
