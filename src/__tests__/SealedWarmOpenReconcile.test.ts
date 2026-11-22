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
 * Opening a database from its cache in a fresh session: the sealed documents in
 * the open-time delta "gain" their key (the session cache starts empty). That
 * must only reconcile the documents of those key series, not unwrap the
 * recipient block of every sealed document in the database (one RSA decryption
 * each, seconds for a mail store with thousands of per-document sealed mails).
 */
describe("warm open with sealed documents in the delta", () => {
  jest.setTimeout(240000);

  const COUNT = 25;
  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  const bobCache = new InMemoryLocalCacheStore();

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-warm-open" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  async function bobSession(): Promise<MindooTenant> {
    const factory = new BaseMindooTenantFactory(bob.storeFactory, fixture.crypto, undefined, bobCache);
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

  function abandonSession(tenant: MindooTenant): void {
    const cm = (tenant as any).cacheManager as any;
    if (!cm) return;
    cm.disposed = true;
    if (cm.timer !== null) clearTimeout(cm.timer);
    cm.timer = null;
  }

  /** Put Alice's entries into Bob's store without a cache flush that covers them. */
  async function deliverToBobOffline(): Promise<void> {
    const carrier = await bobSession();
    const bobDb = await carrier.openDB("mail");
    const aliceDb = await alice.tenant.openDB("mail");
    await aliceDb.pushChangesTo(bobDb.getStore());
    abandonSession(carrier);
  }

  it("unwraps only the documents of the delta, and they all stay readable", async () => {
    const aliceDb = await alice.tenant.openDB("mail");
    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const doc = await aliceDb.createDocument({ recipients: [bob.username], initialValues: { n: i } });
      ids.push(doc.getId());
    }

    // Bob's first session reads everything and flushes its cache.
    await deliverToBobOffline();
    const first = await bobSession();
    const firstDb = await first.openDB("mail");
    expect((await firstDb.getAllDocumentIds()).sort()).toEqual([...ids].sort());
    await endSession(first);

    // One new sealed document arrives while Bob is away.
    const late = await aliceDb.createDocument({ recipients: [bob.username], initialValues: { n: COUNT } });
    ids.push(late.getId());
    await deliverToBobOffline();

    const second = await bobSession();
    const opened = jest.spyOn(second as any, "openSealedBlock");
    const secondDb = await second.openDB("mail");
    expect((await secondDb.getAllDocumentIds()).sort()).toEqual([...ids].sort());
    // The delta's document (and at most a retry), not all COUNT + 1 documents.
    expect(opened.mock.calls.length).toBeLessThan(5);
    expect((await secondDb.getDocument(late.getId())).getData().n).toBe(COUNT);
    expect((await secondDb.getDocument(ids[0])).getData().n).toBe(0);
    await endSession(second);
  });
});
