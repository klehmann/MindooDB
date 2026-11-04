/**
 * registerUser got slower with every registered user (500 users: 24 min).
 *
 * 1. Each directory write runs the time-travel pass, which resumes the
 *    revision feed before the first un-witnessed entry. Every un-witnessed
 *    (provisional) document was therefore loaded, verified, decrypted and
 *    re-folded on every pass, so the cost of one registration grew with the
 *    number of registrations before it. The feed now re-emits the previous
 *    fold of an unchanged provisional document with the current trusted
 *    times; a new change or a witness receipt folds again.
 * 2. One registration decrypted the administration key (PBKDF2) six times.
 *    registerUser now decrypts it once, registerUsers once per batch.
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import type {
  ChangeRevisionResult,
  EncryptedPrivateKey,
  MindooDB,
  PrivateUserId,
  PublicUserId,
  RevisionCursor,
} from "../core/types";
import { createWitnessingTenant, WitnessingTenantContext } from "./_helpers/witnessingTenant";
import { WitnessingInMemoryContentAddressedStore } from "./_helpers/witnessingStore";

async function collect(db: MindooDB, cursor: RevisionCursor | null = null): Promise<ChangeRevisionResult[]> {
  const out: ChangeRevisionResult[] = [];
  for await (const rev of db.iterateChangeRevisionsSince(cursor)) {
    out.push(rev);
  }
  return out;
}

/** Everything of a revision except the provisional trusted time (moves with `now`). */
function content(rev: ChangeRevisionResult): string {
  return [rev.docId, rev.entryId, rev.witnessed, rev.doc.isDeleted(), JSON.stringify(rev.doc.getData())].join("|");
}

describe("revision feed reuses the fold of unchanged provisional documents", () => {
  let ctx: WitnessingTenantContext;

  afterEach(async () => {
    await (ctx?.tenant as unknown as { disposeCacheManager?: () => Promise<void> })?.disposeCacheManager?.();
  });

  /** The same feed from an empty fold cache. */
  async function collectUncached(db: MindooDB, cursor: RevisionCursor | null): Promise<string[]> {
    const internal = db as unknown as { provisionalRevisionCache: Map<string, unknown>; provisionalRevisionCacheSize: number };
    internal.provisionalRevisionCache.clear();
    internal.provisionalRevisionCacheSize = 0;
    return (await collect(db, cursor)).map(content);
  }

  it("re-emits, re-folds on a new change and on a witness receipt", async () => {
    ctx = await createWitnessingTenant("register-scaling-feed");
    const db = await ctx.tenant.openDB("feed-db");
    const store = db.getStore() as unknown as WitnessingInMemoryContentAddressedStore;

    const witnessedDoc = await db.createDocument();
    await db.changeDoc(await db.getDocument(witnessedDoc.getId()), (d) => {
      (d.getData() as Record<string, unknown>).v = "witnessed";
    });
    await db.syncStoreChanges();

    store.witnessingEnabled = false;
    const doc = await db.createDocument();
    const docId = doc.getId();
    for (let i = 0; i < 3; i++) {
      await db.changeDoc(await db.getDocument(docId), (d) => {
        (d.getData() as Record<string, unknown>).counter = i;
      });
    }
    await db.syncStoreChanges();

    const first = await collect(db);
    const provisional = first.filter((r) => r.docId === docId);
    expect(provisional.length).toBeGreaterThanOrEqual(4);
    expect(provisional.every((r) => !r.witnessed)).toBe(true);
    // The feed parks the cursor before the first provisional entry.
    const cursor = first[first.length - 1].cursor;

    // Second pass: same revisions, current trusted times, nothing loaded.
    const loads = jest.spyOn(store, "getEntries");
    let second: ChangeRevisionResult[];
    try {
      second = await collect(db, cursor);
      expect(loads.mock.calls.flat(2).filter((id) => String(id).startsWith(docId))).toEqual([]);
    } finally {
      loads.mockRestore();
    }
    const resumed = second.filter((r) => r.docId === docId);
    expect(resumed.map(content)).toEqual(provisional.map(content));
    resumed.forEach((rev, i) => expect(rev.trustedTime).toBeGreaterThanOrEqual(provisional[i].trustedTime));
    expect(second.map(content)).toEqual(await collectUncached(db, cursor));

    // A new provisional change folds again.
    await db.changeDoc(await db.getDocument(docId), (d) => {
      (d.getData() as Record<string, unknown>).counter = 99;
    });
    await db.syncStoreChanges();
    const afterChange = await collect(db, cursor);
    expect(afterChange.filter((r) => r.docId === docId)).toHaveLength(provisional.length + 1);
    expect(afterChange.map(content)).toEqual(await collectUncached(db, cursor));

    // A witness receipt on one entry folds again with its witnessed time.
    const entryId = afterChange.filter((r) => r.docId === docId)[1].entryId;
    const witnessTime = store.nextWitnessTime();
    store.restampWithFreshReceiptOrder(entryId, witnessTime);
    (db as unknown as { revisionFeedDocCache: Map<string, unknown> }).revisionFeedDocCache.clear();
    const afterWitness = await collect(db, cursor);
    const witnessed = afterWitness.filter((r) => r.entryId === entryId);
    expect(witnessed).toHaveLength(1);
    expect(witnessed[0].witnessed).toBe(true);
    expect(witnessed[0].trustedTime).toBe(witnessTime);
    expect(afterWitness.map(content)).toEqual(await collectUncached(db, cursor));
  }, 60000);
});

describe("registration decrypts the administration key once", () => {
  jest.setTimeout(120_000);

  const PASSWORD = "register-scaling-pass";
  const crypto = new NodeCryptoAdapter();
  const subtle = crypto.getSubtle();
  let admin: PrivateUserId;
  let appUser: PrivateUserId;
  let tenant: Awaited<ReturnType<BaseMindooTenantFactory["createTenant"]>>["tenant"];
  let decrypts: jest.SpyInstance;

  async function newUser(name: string): Promise<PublicUserId> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey)).toString("base64");
    return {
      username: `cn=${name}/o=register-scaling`,
      userSigningPublicKey: `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`,
      userEncryptionPublicKey: appUser.userEncryptionKeyPair.publicKey,
    } as PublicUserId;
  }

  const adminKey = () => admin.userSigningKeyPair.privateKey as EncryptedPrivateKey;
  const adminKeyDecrypts = () => decrypts.mock.calls.filter(([key]) => key === adminKey()).length;

  beforeAll(async () => {
    const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    admin = await factory.createUserId("cn=admin/o=register-scaling", PASSWORD);
    appUser = await factory.createUserId("cn=app/o=register-scaling", PASSWORD);
    ({ tenant } = await factory.createTenant({
      tenantId: "register-scaling",
      adminUser: admin,
      adminPassword: PASSWORD,
      appUser,
      userPassword: PASSWORD,
    }));
  });

  beforeEach(() => {
    decrypts = jest.spyOn(tenant as unknown as { decryptPrivateKeyUncached: () => Promise<ArrayBuffer> }, "decryptPrivateKeyUncached");
  });

  afterEach(() => decrypts.mockRestore());

  test("registerUser decrypts once per registration", async () => {
    const directory = await tenant.openDirectory();
    const user = await newUser("single");
    await directory.registerUser(user, adminKey(), PASSWORD);
    expect(adminKeyDecrypts()).toBe(1);
    expect(await directory.validatePublicSigningKey(user.userSigningPublicKey)).toBe(true);

    // Outside a registration every decryption runs again.
    await tenant.decryptPrivateKey(adminKey(), PASSWORD, "signing");
    await tenant.decryptPrivateKey(adminKey(), PASSWORD, "signing");
    expect(adminKeyDecrypts()).toBe(3);
  });

  test("registerUsers decrypts once per batch and registers like single calls", async () => {
    const directory = await tenant.openDirectory();
    const users = await Promise.all(["batch1", "batch2", "batch3"].map(newUser));
    await directory.registerUsers!(
      users.map((userId, i) => ({ userId, label: `device ${i}` })),
      adminKey(),
      PASSWORD,
    );
    expect(adminKeyDecrypts()).toBe(1);
    for (const user of users) {
      expect(await directory.validatePublicSigningKey(user.userSigningPublicKey)).toBe(true);
      expect(await directory.getUserPublicKeys(user.username)).toEqual(
        expect.objectContaining({ signingPublicKey: user.userSigningPublicKey }),
      );
    }
  });

  test("a wrong password still fails and registers nobody", async () => {
    const directory = await tenant.openDirectory();
    const users = await Promise.all(["wrong1", "wrong2"].map(newUser));
    await expect(
      directory.registerUsers!(users.map((userId) => ({ userId })), adminKey(), "not-the-password"),
    ).rejects.toThrow();
    for (const user of users) {
      expect(await directory.validatePublicSigningKey(user.userSigningPublicKey)).toBe(false);
    }
  });
});
