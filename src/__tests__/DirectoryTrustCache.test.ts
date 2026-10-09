import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  PrivateUserId,
  MindooTenant,
  MindooTenantDirectory,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { injectIoJitter } from "./_helpers/ioJitter";
import { grantForSigningKey } from "../core/accesscontrol/DirectoryStateNode";

/**
 * Store factory that returns the SAME in-memory stores for a given dbId, so two
 * tenant instances opened over it observe each other's writes once they read
 * the store — simulating two processes sharing one local store.
 */
class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options),
      });
    }
    return this.stores.get(dbId)!;
  }
}

/**
 * The directory trust cache (validatePublicSigningKey) separates two layers:
 * reading new entries from the store is throttled, but entries already in the
 * directory index take effect on the next validation, independent of time.
 */
describe("directory trust cache", () => {
  const tenantId = "tenant-trust-cache";
  const adminPassword = "adminpass123";
  let factory: BaseMindooTenantFactory;
  let admin: PrivateUserId;
  let adminKeyBag: KeyBag;
  let adminTenant: MindooTenant;
  let otherTenant: MindooTenant;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  async function openTenantAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      password,
      await keyBagFor(user, password),
    );
  }

  /** Read the directory store into `tenant`'s directory index, as a pull or sync would. */
  async function readDirectoryStore(tenant: MindooTenant): Promise<void> {
    const directory = (await tenant.openDirectory()) as unknown as {
      getDirectoryDB(): Promise<{ syncStoreChanges(): Promise<void> }>;
    };
    await (await directory.getDirectoryDB()).syncStoreChanges();
  }

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new SharedInMemoryStoreFactory(), new NodeCryptoAdapter());
    admin = await factory.createUserId("CN=admin/O=trustcache", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    const writer = await factory.createUserId("CN=writer/O=trustcache", "writerpass123");
    adminTenant = await openTenantAs(writer, "writerpass123");
    const directory = await adminTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(writer), admin.userSigningKeyPair.privateKey, adminPassword);

    const otherUser = await factory.createUserId("CN=other/O=trustcache", "otherpass123");
    await directory.registerUser(factory.toPublicUserId(otherUser), admin.userSigningKeyPair.privateKey, adminPassword);
    otherTenant = await openTenantAs(otherUser, "otherpass123");
  }, 60000);

  it("applies a revocation that is already in the directory index on the next validation", async () => {
    const alice = await factory.createUserId("CN=alice/O=trustcache", "alicepass123");
    const adminDirectory = await adminTenant.openDirectory();
    await adminDirectory.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);
    const aliceKey = alice.userSigningKeyPair.publicKey;

    const otherDirectory = await otherTenant.openDirectory();
    expect(await otherDirectory.validatePublicSigningKey(aliceKey)).toBe(true);

    const username = (await adminDirectory.getUserBySigningPublicKey(aliceKey))!.username;
    await adminDirectory.revokeUser(username, {}, admin.userSigningKeyPair.privateKey, adminPassword);

    // The other instance reads the revocation into its index (no forceRefresh,
    // well within the store-poll interval).
    await readDirectoryStore(otherTenant);
    expect(await otherDirectory.validatePublicSigningKey(aliceKey)).toBe(false);
  }, 60000);

  describe("under concurrent load", () => {
    const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
    /** Count how many passes of `method` run at the same time. */
    function trackPasses(
      directory: unknown,
      method = "runUnifiedCachePass",
    ): { maxRunning: () => number; restore: () => void } {
      const record = directory as Record<string, () => Promise<unknown>>;
      const original = record[method];
      let running = 0;
      let maxRunning = 0;
      record[method] = async function (this: unknown) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          return await original.call(this);
        } finally {
          running--;
        }
      };
      return {
        maxRunning: () => maxRunning,
        restore: () => {
          delete record[method];
        },
      };
    }

    /** An admin write invalidates the unified cache; the next read rebuilds it. */
    async function invalidate(directory: MindooTenantDirectory, round: number): Promise<void> {
      await directory.changeTenantSettings(
        (doc) => {
          doc.getData().note = `rebuild-${round}`;
        },
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }

    /**
     * Start `count` operations one macrotask apart while the directory DB
     * yields with seeded I/O jitter, so they land at different points of a
     * rebuild pass.
     */
    async function runStaggered<T>(
      directory: MindooTenantDirectory,
      seed: number,
      count: number,
      op: (i: number) => Promise<T>,
    ): Promise<T[]> {
      const directoryDB = await (directory as unknown as { getDirectoryDB(): Promise<object> }).getDirectoryDB();
      const restoreJitter = injectIoJitter(
        directoryDB,
        ["iterateChangesSince", "iterateChangeRevisionsSince", "getDocument"],
        { seed },
      );
      try {
        const pending: Promise<T>[] = [];
        for (let i = 0; i < count; i++) {
          pending.push(op(i));
          await new Promise((resolve) => setImmediate(resolve));
        }
        return await Promise.all(pending);
      } finally {
        restoreJitter();
      }
    }

    async function registerUsers(directory: MindooTenantDirectory, names: string[]): Promise<PrivateUserId[]> {
      const users = await Promise.all(
        names.map((name) => factory.createUserId(`CN=${name}/O=trustcache`, `${name}pass123`)),
      );
      for (const user of users) {
        await directory.registerUser(factory.toPublicUserId(user), admin.userSigningKeyPair.privateKey, adminPassword);
      }
      return users;
    }

    it("keeps registered keys trusted and runs one rebuild pass at a time", async () => {
      const directory = await adminTenant.openDirectory();
      const keys = (await registerUsers(directory, ["u1", "u2", "u3"])).map((u) => u.userSigningKeyPair.publicKey);
      const passes = trackPasses(directory);
      const failures: string[] = [];
      try {
        for (const seed of SEEDS) {
          await invalidate(directory, seed);
          const results = await runStaggered(directory, seed, 30, (i) =>
            directory.validatePublicSigningKey(keys[i % keys.length]),
          );
          const rejected = results.filter((ok) => !ok).length;
          if (rejected > 0) failures.push(`seed ${seed}: ${rejected} of ${results.length} rejected`);
        }
        expect(failures).toEqual([]);
        expect(passes.maxRunning()).toBe(1);
      } finally {
        passes.restore();
      }
    }, 120000);

    it("keeps group membership visible for reads that overlap a rebuild", async () => {
      const directory = await adminTenant.openDirectory();
      const users = await registerUsers(directory, ["g1", "g2"]);
      const members = users.map((u) => u.username.toLowerCase()).sort();
      await directory.addUsersToGroup("sales", members, admin.userSigningKeyPair.privateKey, adminPassword);
      expect((await directory.getGroupMembers("sales")).sort()).toEqual(members);

      const failures: string[] = [];
      for (const seed of SEEDS) {
        await invalidate(directory, seed);
        const results = await runStaggered(directory, seed, 30, async (i) =>
          i === 0
            ? (await directory.validatePublicSigningKey(users[0].userSigningKeyPair.publicKey), members)
            : directory.getGroupMembers("sales"),
        );
        const wrong = results.filter((list) => [...list].sort().join(",") !== members.join(",")).length;
        if (wrong > 0) failures.push(`seed ${seed}: ${wrong} of ${results.length} reads saw a wrong member list`);
      }
      expect(failures).toEqual([]);
    }, 120000);

    it("advances the time-travel chain in one pass at a time and every head sees the new grant", async () => {
      const directory = await otherTenant.openDirectory();
      const passes = trackPasses(directory, "runTimeTravelPass");
      const failures: string[] = [];
      try {
        for (const seed of SEEDS) {
          const [user] = await registerUsers(await adminTenant.openDirectory(), [`tt${seed}`]);
          await readDirectoryStore(otherTenant);
          const heads = await runStaggered(directory, seed, 20, () => directory.getDirectoryStateHead!());
          const missing = heads.filter((node) => !grantForSigningKey(node, user.userSigningKeyPair.publicKey)).length;
          if (missing > 0) failures.push(`seed ${seed}: ${missing} of ${heads.length} heads miss the new grant`);
        }
        expect(failures).toEqual([]);
        expect(passes.maxRunning()).toBe(1);
      } finally {
        passes.restore();
      }
    }, 120000);
  });

  it("does not poll the store again for a repeatedly missed key, but trusts it once its grant is in the index", async () => {
    const bob = await factory.createUserId("CN=bob/O=trustcache", "bobpass123");
    const bobKey = bob.userSigningKeyPair.publicKey;

    const otherDirectory = await otherTenant.openDirectory();
    const otherDirectoryDB = await (otherDirectory as unknown as {
      getDirectoryDB(): Promise<{ syncStoreChanges(): Promise<void> }>;
    }).getDirectoryDB();
    const pollSpy = jest.spyOn(otherDirectoryDB, "syncStoreChanges");

    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(false);
    const pollsAfterFirstMiss = pollSpy.mock.calls.length;
    expect(pollsAfterFirstMiss).toBeGreaterThanOrEqual(1);

    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(false);
    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(false);
    expect(pollSpy.mock.calls.length).toBe(pollsAfterFirstMiss);

    const adminDirectory = await adminTenant.openDirectory();
    await adminDirectory.registerUser(factory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);
    await readDirectoryStore(otherTenant);
    expect(await otherDirectory.validatePublicSigningKey(bobKey)).toBe(true);
    pollSpy.mockRestore();
  }, 60000);
});
