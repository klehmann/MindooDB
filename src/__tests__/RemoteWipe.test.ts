import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { NetworkError } from "../core/appendonlystores/network/types";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  StoreEntry,
  MindooTenant,
  MindooTenantDirectory,
  PrivateUserId,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";

/**
 * Tests for the transport-side remote-wipe feature (docs/accesscontrol.md §6.5):
 *  - the sync server serves a wipe-targeted device ONLY the admin-signed grant
 *    document carrying the directive (and nothing else), and denies its pushes;
 *  - authentication identifies which signing key a device used and marks
 *    wipe-targeted (even revoked) devices so they can still receive the directive;
 *  - the client detects the directive and deletes the whole local tenant.
 */
const subtle = new NodeCryptoAdapter().getSubtle();
const cryptoAdapter = new NodeCryptoAdapter();

function storeEntry(overrides: Partial<StoreEntry> = {}): StoreEntry {
  return {
    entryType: "doc_change",
    id: `e_${Math.random().toString(36).slice(2)}`,
    contentHash: "h",
    docId: "doc",
    dependencyIds: [],
    createdAt: 1_700_000_000_000,
    createdByPublicKey: "-----BEGIN PUBLIC KEY-----AUTHOR-----END PUBLIC KEY-----",
    decryptionKeyId: "default",
    originalSize: 1,
    encryptedSize: 1,
    signature: new Uint8Array([1]),
    encryptedData: new Uint8Array([9]),
    ...overrides,
  } as StoreEntry;
}

describe("remote wipe — server wipe-scoped serving (§6.5)", () => {
  const DEVICE_KEY = "-----BEGIN PUBLIC KEY-----WIPED-DEVICE-----END PUBLIC KEY-----";
  const GRANT_DOC_ID = "acl_grant_alice";

  function fakeDirectory(): MindooTenantDirectory {
    return {
      validatePublicSigningKey: async () => true,
      getUserPublicKeys: async () => ({ signingPublicKey: "x", encryptionPublicKey: "y" }),
    } as unknown as MindooTenantDirectory;
  }

  // Auth stub yielding a wipe-scoped token for DEVICE_KEY.
  function wipeAuth(): AuthenticationService {
    return {
      validateToken: async () => ({
        sub: "CN=alice",
        iat: 0,
        exp: 0,
        tenantId: "t",
        deviceSigningKey: DEVICE_KEY,
        wipe: true,
      }),
    } as unknown as AuthenticationService;
  }

  function normalAuth(): AuthenticationService {
    return {
      validateToken: async () => ({ sub: "CN=alice", iat: 0, exp: 0, tenantId: "t" }),
    } as unknown as AuthenticationService;
  }

  const resolver = async (key: string) => (key === DEVICE_KEY ? GRANT_DOC_ID : null);

  async function directoryStoreWithGrant(): Promise<InMemoryContentAddressedStore> {
    const store = new InMemoryContentAddressedStore("directory", StoreKind.docs);
    await store.putEntries([
      storeEntry({ id: "grant_1", docId: GRANT_DOC_ID }),
      storeEntry({ id: "grant_2", docId: GRANT_DOC_ID }),
      storeEntry({ id: "policy_1", docId: "acl_defaultpolicy" }),
      storeEntry({ id: "othergrant_1", docId: "acl_grant_bob" }),
    ]);
    return store;
  }

  it("serves a wipe-targeted device ONLY the grant directive from the directory store", async () => {
    const store = await directoryStoreWithGrant();
    const server = new ServerNetworkContentAddressedStore(
      store,
      fakeDirectory(),
      wipeAuth(),
      cryptoAdapter,
      undefined,
      { wipeGrantDocIdResolver: resolver },
    );

    expect((await server.handleGetAllIds("t")).sort()).toEqual(["grant_1", "grant_2"]);
    expect((await server.handleFindNewEntries("t", [])).map((e) => e.id).sort()).toEqual([
      "grant_1",
      "grant_2",
    ]);
    expect((await server.handleHasEntries("t", ["grant_1", "policy_1"])).sort()).toEqual(["grant_1"]);
    expect((await server.handleScanEntriesSince("t", null)).entries.map((e) => e.id).sort()).toEqual([
      "grant_1",
      "grant_2",
    ]);
    // Metadata for a non-grant entry is hidden.
    expect(await server.handleGetEntryMetadata("t", "policy_1")).toBeNull();
    expect((await server.handleGetEntryMetadata("t", "grant_1"))?.id).toBe("grant_1");
  });

  it("serves a wipe-targeted device NOTHING from a data store", async () => {
    const dataStore = new InMemoryContentAddressedStore("crm", StoreKind.docs);
    await dataStore.putEntries([storeEntry({ id: "d1", docId: "contact1" })]);
    const server = new ServerNetworkContentAddressedStore(
      dataStore,
      fakeDirectory(),
      wipeAuth(),
      cryptoAdapter,
      undefined,
      { wipeGrantDocIdResolver: resolver },
    );
    expect(await server.handleGetAllIds("t")).toEqual([]);
    expect(await server.handleFindNewEntries("t", [])).toEqual([]);
  });

  it("denies pushes from a wipe-targeted device", async () => {
    const store = await directoryStoreWithGrant();
    const server = new ServerNetworkContentAddressedStore(
      store,
      fakeDirectory(),
      wipeAuth(),
      cryptoAdapter,
      undefined,
      { wipeGrantDocIdResolver: resolver },
    );
    await expect(server.handlePutEntries("t", [storeEntry()])).rejects.toBeInstanceOf(NetworkError);
  });

  it("does not restrict a normal (non-wipe) token", async () => {
    const store = await directoryStoreWithGrant();
    const server = new ServerNetworkContentAddressedStore(
      store,
      fakeDirectory(),
      normalAuth(),
      cryptoAdapter,
      undefined,
      { wipeGrantDocIdResolver: resolver },
    );
    expect((await server.handleGetAllIds("t")).length).toBe(4);
  });

  it("advertises supportsRemoteWipeV1 when a resolver is configured", async () => {
    const store = await directoryStoreWithGrant();
    const withResolver = new ServerNetworkContentAddressedStore(
      store, fakeDirectory(), normalAuth(), cryptoAdapter, undefined, { wipeGrantDocIdResolver: resolver },
    );
    const without = new ServerNetworkContentAddressedStore(
      store, fakeDirectory(), normalAuth(), cryptoAdapter,
    );
    expect((await withResolver.handleGetCapabilities("t")).supportsRemoteWipeV1).toBe(true);
    expect((await without.handleGetCapabilities("t")).supportsRemoteWipeV1).toBe(false);
  });
});

describe("remote wipe — authentication identifies the device key (§6.5)", () => {
  async function makeDeviceKey(): Promise<{ pem: string; privateKey: CryptoKey }> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    return { pem: `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`, privateKey: pair.privateKey };
  }

  async function sign(challenge: string, key: CryptoKey): Promise<Uint8Array> {
    const sig = await subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(challenge));
    return new Uint8Array(sig);
  }

  function directory(opts: {
    active: string[];
    wipeRequested: string[];
    revoked?: boolean;
  }): MindooTenantDirectory {
    const primary = opts.active[0] ?? opts.wipeRequested[0] ?? null;
    return {
      getUserPublicKeys: async () =>
        primary ? { signingPublicKey: primary, encryptionPublicKey: "y" } : null,
      getUserSigningKeyUniverse: async () => ({ active: opts.active, wipeRequested: opts.wipeRequested }),
      isUserRevoked: async () => opts.revoked === true,
    } as unknown as MindooTenantDirectory;
  }

  it("records the authenticated device key and the wipe flag in the token", async () => {
    const device = await makeDeviceKey();
    const auth = new AuthenticationService(
      cryptoAdapter,
      directory({ active: [device.pem], wipeRequested: [device.pem] }),
      "t",
    );
    const challenge = await auth.generateChallenge("CN=alice");
    const result = await auth.authenticate(challenge, await sign(challenge, device.privateKey));
    expect(result.success).toBe(true);

    const payload = await auth.validateToken(result.token!);
    expect(payload).not.toBeNull();
    expect(payload!.deviceSigningKey).toBe(device.pem);
    expect(payload!.wipe).toBe(true);
  });

  it("authenticates a username-omitted, key-based challenge (§6.5)", async () => {
    const device = await makeDeviceKey();
    // A key-aware directory: the client identifies by its signing key and the
    // server resolves the principal without ever seeing a cleartext username.
    const dir = {
      getUserPublicKeys: async () => ({ signingPublicKey: device.pem, encryptionPublicKey: "y" }),
      getUserBySigningPublicKey: async (key: string) =>
        key === device.pem
          ? { username: "CN=alice", signingPublicKey: device.pem, encryptionPublicKey: "y" }
          : null,
      getUserSigningKeyUniverse: async () => ({ active: [device.pem], wipeRequested: [] }),
      isUserRevoked: async () => false,
    } as unknown as MindooTenantDirectory;
    const auth = new AuthenticationService(cryptoAdapter, dir, "t");

    // No username — only the signing public key.
    const challenge = await auth.generateChallenge(undefined, { signingPublicKey: device.pem });
    const result = await auth.authenticate(challenge, await sign(challenge, device.privateKey));
    expect(result.success).toBe(true);

    const payload = await auth.validateToken(result.token!);
    expect(payload).not.toBeNull();
    expect(payload!.deviceSigningKey).toBe(device.pem);
    // The client sent no username on the wire; the server resolved the principal
    // from the signing key alone (recorded on the challenge), so the read gate
    // can still key off `deviceSigningKey`.
    expect(payload!.sub).toBe("CN=alice");
  });

  it("issues a non-wipe token for an active, non-targeted device", async () => {
    const device = await makeDeviceKey();
    const auth = new AuthenticationService(
      cryptoAdapter,
      directory({ active: [device.pem], wipeRequested: [] }),
      "t",
    );
    const challenge = await auth.generateChallenge("CN=alice");
    const result = await auth.authenticate(challenge, await sign(challenge, device.privateKey));
    const payload = await auth.validateToken(result.token!);
    expect(payload!.deviceSigningKey).toBe(device.pem);
    expect(payload!.wipe).toBeUndefined();
  });

  it("lets a revoked but wipe-targeted device authenticate and keep a valid token", async () => {
    const device = await makeDeviceKey();
    // Revoked (no active keys) but still wipe-targeted: the device must learn it
    // should wipe, so the challenge succeeds and the wipe token survives the
    // revocation check.
    const auth = new AuthenticationService(
      cryptoAdapter,
      directory({ active: [], wipeRequested: [device.pem], revoked: true }),
      "t",
    );
    const challenge = await auth.generateChallenge("CN=alice");
    const result = await auth.authenticate(challenge, await sign(challenge, device.privateKey));
    expect(result.success).toBe(true);
    const payload = await auth.validateToken(result.token!);
    expect(payload).not.toBeNull();
    expect(payload!.wipe).toBe(true);
  });

  it("rejects a revoked, non-wipe token at validation", async () => {
    const device = await makeDeviceKey();
    const auth = new AuthenticationService(
      cryptoAdapter,
      directory({ active: [device.pem], wipeRequested: [], revoked: false }),
      "t",
    );
    const challenge = await auth.generateChallenge("CN=alice");
    const result = await auth.authenticate(challenge, await sign(challenge, device.privateKey));
    // Now flip to revoked: a normal token must stop validating.
    const revokedAuth = new AuthenticationService(
      cryptoAdapter,
      directory({ active: [device.pem], wipeRequested: [], revoked: true }),
      "t",
    );
    // Re-validate the issued token under a revoked directory by using a fresh
    // service sharing the same secret is not possible; instead verify the same
    // service rejects once the directory reports revoked.
    (auth as unknown as { directory: MindooTenantDirectory }).directory =
      (revokedAuth as unknown as { directory: MindooTenantDirectory }).directory;
    expect(await auth.validateToken(result.token!)).toBeNull();
  });
});

describe("remote wipe — client tenant deletion (§6.5)", () => {
  // Shared in-memory stores so the admin's directive and the device share one
  // append-only store (as if the device had synced), letting us drive
  // checkAndApplyRemoteWipe end-to-end.
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
    get(dbId: string): CreateStoreResult | undefined {
      return this.stores.get(dbId);
    }
  }

  const tenantId = "tenant-wipe";
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;
  let setupTenant: MindooTenant;
  let setupDir: WipeDir;

  type WipeTenant = MindooTenant & {
    checkAndApplyRemoteWipe(): Promise<boolean>;
    wipeLocalTenant(dbIds?: string[]): Promise<void>;
  };
  type WipeDir = MindooTenantDirectory & {
    requestDeviceWipe(u: string, k: string[], pk: unknown, pw: string): Promise<void>;
  };

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

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    admin = await factory.createUserId("CN=admin/O=wipe", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    // A regular (non-admin) user drives admin-signed directory setup, passing the
    // admin private key as a parameter (openTenant forbids admin as current user).
    const writer = await factory.createUserId("CN=writer/O=wipe", "writerpass123");
    setupTenant = await openTenantAs(writer, "writerpass123");
    setupDir = (await setupTenant.openDirectory()) as WipeDir;
    await setupDir.registerUser(factory.toPublicUserId(writer), admin.userSigningKeyPair.privateKey, adminPassword);
  }, 60000);

  it("checkAndApplyRemoteWipe deletes the local tenant when this device is targeted", async () => {
    const alice = await factory.createUserId("CN=alice/O=wipe", "alicepass123");
    await setupDir.registerUser(factory.toPublicUserId(alice), admin.userSigningKeyPair.privateKey, adminPassword);

    // Seed directory + data content.
    const crm = await setupTenant.openDB("crm");
    await crm.createDocument({ initialValues: { form: "Contact", name: "ACME" } });
    expect((await storeFactory.get("directory")!.docStore.getAllIds()).length).toBeGreaterThan(0);
    expect((await storeFactory.get("crm")!.docStore.getAllIds()).length).toBeGreaterThan(0);

    // Admin targets Alice's device for remote wipe.
    await setupDir.requestDeviceWipe(
      alice.username,
      [alice.userSigningKeyPair.publicKey],
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Alice's device opens the tenant, opens its DBs, then checks for a wipe.
    const aliceTenant = (await openTenantAs(alice, "alicepass123")) as WipeTenant;
    await aliceTenant.openDB("crm");
    const wiped = await aliceTenant.checkAndApplyRemoteWipe();

    expect(wiped).toBe(true);
    expect(await storeFactory.get("directory")!.docStore.getAllIds()).toEqual([]);
    expect(await storeFactory.get("crm")!.docStore.getAllIds()).toEqual([]);
  }, 60000);

  it("checkAndApplyRemoteWipe is a no-op for a device that is not targeted", async () => {
    const bob = await factory.createUserId("CN=bob/O=wipe", "bobpass123");
    await setupDir.registerUser(factory.toPublicUserId(bob), admin.userSigningKeyPair.privateKey, adminPassword);
    const crm = await setupTenant.openDB("crm");
    await crm.createDocument({ initialValues: { form: "Contact", name: "Globex" } });
    const before = (await storeFactory.get("crm")!.docStore.getAllIds()).length;

    const bobTenant = (await openTenantAs(bob, "bobpass123")) as WipeTenant;
    const wiped = await bobTenant.checkAndApplyRemoteWipe();

    expect(wiped).toBe(false);
    expect((await storeFactory.get("crm")!.docStore.getAllIds()).length).toBe(before);
  }, 60000);
});
