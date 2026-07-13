import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import { Ed25519WitnessProvider } from "../core/accesscontrol/timestamp/Ed25519WitnessProvider";
import type { WitnessSigner } from "../core/crypto/WitnessReceipt";
import type { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { KeyBag } from "../core/keys/KeyBag";
import {
  PrivateUserId,
  MindooTenant,
  MindooTenantDirectory,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  StoreEntry,
  SyncProgress,
} from "../core/types";
import type { ContentAddressedStore } from "../core/appendonlystores/types";

/**
 * Reproduces the "first sync never finishes" bug observed when pushing a
 * freshly seeded local database to an empty witnessing server for the first
 * time.
 *
 * The loop was caused by three interacting behaviors:
 *
 * 1. After each transfer batch the witnessing server returns receipts; the
 *    client's `applyWitnessReceipts` re-anchors the just-pushed entries to a
 *    FRESH `receiptOrder` — i.e. past the running scan cursor — so the
 *    cursor scan re-discovered its own transfers.
 * 2. The target bloom summary is fetched once up front. On a first sync the
 *    target is empty, so the stale bloom classified every re-discovered id
 *    as "definitely missing", skipping the exact `hasEntries` check — the
 *    entries were pushed AGAIN.
 * 3. The server re-stamped duplicates with a fresh `receivedAt` on every
 *    push, so the client re-anchored them again, forever.
 *
 * The fix bounds the scan at the source head captured before the scan
 * started, tracks already-transferred ids per session, and makes the server
 * acknowledge duplicates with the stored receipt (see
 * ServerWitnessStamping.test.ts for that unit test).
 */
describe("first push to an empty witnessing server terminates", () => {
  jest.setTimeout(60000);

  const cryptoAdapter = new NodeCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const dbId = "contacts";

  let user1: PrivateUserId;
  let user1KeyBag: KeyBag;
  let adminUser: PrivateUserId;
  let tenant1: MindooTenant;

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

    const user1Password = "user1pass123";
    user1 = await factory.createUserId("CN=user1/O=testtenant", user1Password);
    user1KeyBag = new KeyBag(
      user1.userEncryptionKeyPair.privateKey,
      user1Password,
      cryptoAdapter
    );

    const adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);

    const tenantId = "first-sync-loop-tenant";
    await user1KeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await user1KeyBag.createTenantKey(tenantId);

    tenant1 = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user1,
      user1Password,
      user1KeyBag
    );

    const directory1 = await tenant1.openDirectory();
    await directory1.registerUser(
      factory.toPublicUserId(user1),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
  }, 30000);

  async function generateSigner(): Promise<WitnessSigner> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
    return { publicKeyPem, signingPrivateKey: pair.privateKey, subtle };
  }

  /**
   * A witnessing "server" target for pushChangesTo: reads are served straight
   * from the server's local store, while putEntries goes through the real
   * `handlePutEntries` (validation + witness stamping + PutEntriesAck), the
   * same path a ClientNetworkContentAddressedStore push takes over HTTP.
   */
  async function createWitnessingTarget(): Promise<{
    target: ContentAddressedStore;
    serverLocalStore: InMemoryContentAddressedStore;
  }> {
    const serverLocalStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs);
    const signer = await generateSigner();
    const fakeAuth = {
      validateToken: async () => ({ sub: "CN=user1", iat: 0, exp: 0, tenantId: "t" }),
    } as unknown as AuthenticationService;
    const fakeDirectory = {
      validatePublicSigningKey: async () => true,
    } as unknown as MindooTenantDirectory;

    const server = new ServerNetworkContentAddressedStore(
      serverLocalStore,
      fakeDirectory,
      fakeAuth,
      cryptoAdapter,
      undefined,
      {
        timestampProvider: new Ed25519WitnessProvider({ signer, subtle }),
        witnessDbid: dbId,
      }
    );

    const target = new Proxy(serverLocalStore, {
      get(storeTarget, prop) {
        if (prop === "putEntries") {
          return (entries: StoreEntry[]) => server.handlePutEntries("token", entries);
        }
        const value = Reflect.get(storeTarget, prop);
        return typeof value === "function" ? value.bind(storeTarget) : value;
      },
    }) as unknown as ContentAddressedStore;

    return { target, serverLocalStore };
  }

  it("scans every source entry exactly once and transfers each entry exactly once", async () => {
    const db = await tenant1.openDB(dbId);

    // Seed enough entries for several scan pages (pageSize 4 below), the
    // precondition for the loop: page N's transfer re-anchors entries while
    // pages N+1... are still being scanned.
    for (let i = 0; i < 6; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, async (d) => {
        d.getData().title = `doc ${i}`;
      });
    }

    const localStore = db.getStore();
    const localIds = await localStore.getAllIds();
    const totalEntries = localIds.length;
    expect(totalEntries).toBeGreaterThanOrEqual(12);

    const { target, serverLocalStore } = await createWitnessingTarget();

    const progress: SyncProgress[] = [];
    const result = await db.pushChangesTo(target, {
      pageSize: 4,
      onProgress: (p) => progress.push(p),
    });

    // Every entry arrives on the server...
    expect((await serverLocalStore.getAllIds()).sort()).toEqual([...localIds].sort());

    // ...each was transferred exactly once and the scan never re-visited
    // entries the push itself re-anchored (pre-fix: scanned/transferred grew
    // without bound until the sync was cancelled).
    expect(result.cancelled).toBe(false);
    expect(result.transferredEntries).toBe(totalEntries);
    expect(result.scannedEntries).toBe(totalEntries);
    const maxScannedInProgress = Math.max(
      ...progress.map((p) => p.scannedEntries ?? 0),
    );
    expect(maxScannedInProgress).toBeLessThanOrEqual(totalEntries);

    // The witness receipts really were applied locally during the push (the
    // re-anchor trigger this regression test exists for was armed).
    const witnessed = await localStore.getEntries(localIds);
    expect(witnessed.length).toBe(totalEntries);
    for (const entry of witnessed) {
      expect(entry.receivedAt).toBeDefined();
    }

    // A follow-up push finds nothing new: the re-anchored tail is scanned,
    // recognized as already present, and NOT re-transferred.
    const secondPush = await db.pushChangesTo(target, { pageSize: 4 });
    expect(secondPush.cancelled).toBe(false);
    expect(secondPush.transferredEntries).toBe(0);

    // And a third push (cursor now at the head) is a no-op as well.
    const thirdPush = await db.pushChangesTo(target, { pageSize: 4 });
    expect(thirdPush.transferredEntries).toBe(0);
  });
});
