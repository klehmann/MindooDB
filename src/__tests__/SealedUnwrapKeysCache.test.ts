import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { CacheManager } from "../core/cache/CacheManager";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";
import { USER_DIRECTORY_DB_ID, type MindooTenant } from "../core/types";
import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

/**
 * Opening a database of per-document sealed documents asks for the unwrap keys
 * once per document. Resolving them reads the directory and the userkey
 * document (each a request on a remote store, e.g. a database opened on the
 * server) and imports an RSA key: it must happen once, not per document.
 */
describe("sealed unwrap keys are resolved once per session", () => {
  jest.setTimeout(240000);

  const COUNT = 20;
  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-unwrap-cache" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  async function bobSession(cache: InMemoryLocalCacheStore): Promise<MindooTenant> {
    const factory = new BaseMindooTenantFactory(bob.storeFactory, fixture.crypto, undefined, cache);
    const tenant = await factory.openTenant(
      fixture.tenantId,
      fixture.adminUser.userSigningKeyPair.publicKey,
      fixture.adminUser.userEncryptionKeyPair.publicKey,
      bob.user,
      bob.password,
      bob.keyBag,
    );
    await tenant.openDB(USER_DIRECTORY_DB_ID);
    await tenant.reconcileUserKeys!();
    return tenant;
  }

  async function endSession(tenant: MindooTenant): Promise<void> {
    const cm = (tenant as any).cacheManager as CacheManager | null;
    if (cm) await cm.dispose();
  }

  it("opens every document with one key lookup", async () => {
    const aliceDb = await alice.tenant.openDB("mail");
    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const doc = await aliceDb.createDocument({ recipients: [bob.username], initialValues: { n: i } });
      ids.push(doc.getId());
    }
    const carrier = await bobSession(new InMemoryLocalCacheStore());
    await aliceDb.pushChangesTo((await carrier.openDB("mail")).getStore());
    await endSession(carrier);

    const session = await bobSession(new InMemoryLocalCacheStore());
    const manager = (session as any).getUserKeyManager();
    const lookups = jest.spyOn(manager, "resolveOwnUserKeyDocument");
    const db = await session.openDB("mail");
    expect((await db.getAllDocumentIds()).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(typeof (await db.getDocument(id)).getData().n).toBe("number");
    }
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(2);
    await endSession(session);
  });

  it("looks the keys up again when the user directory changed", async () => {
    const session = await bobSession(new InMemoryLocalCacheStore());
    const manager = (session as any).getUserKeyManager();
    const first = await manager.getUserKeyCryptoKeysForReconcile();
    const lookups = jest.spyOn(manager, "resolveOwnUserKeyDocument");
    expect(await manager.getUserKeyCryptoKeysForReconcile()).toHaveLength(first.length);
    expect(lookups).not.toHaveBeenCalled();

    // Something new arrived in the user directory (e.g. a new User-Key epoch).
    const userDirectory = await session.openDB(USER_DIRECTORY_DB_ID);
    const latest = userDirectory.getLatestChangeCursor!()!;
    jest.spyOn(userDirectory, "getLatestChangeCursor").mockReturnValue({ ...latest, changeSeq: (latest.changeSeq ?? 0) + 1 });
    await manager.getUserKeyCryptoKeysForReconcile();
    expect(lookups).toHaveBeenCalledTimes(1);

    await manager.getUserKeyCryptoKeysForReconcile({ fresh: true });
    expect(lookups).toHaveBeenCalledTimes(2);
    await endSession(session);
  });
});
