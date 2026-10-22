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
 * A reader removed from a sealed document must lose it, also when the removal
 * (or a later plain change) first reaches them in a fresh session's open-time
 * sync. Guards the full-history wrap lookup added for SealedRichTextReload:
 * it must not hand the key back to someone the newest wrap list excludes.
 */
describe("sealed document removal across sessions", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  const bobCache = new InMemoryLocalCacheStore();

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-removal-reload" });
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

  /** Put Alice's entries into Bob's store without Bob's next session seeing them live. */
  async function deliverToBobOffline(): Promise<void> {
    const carrier = await bobSession();
    const bobDb = await carrier.openDB("removal");
    const aliceDb = await alice.tenant.openDB("removal");
    await aliceDb.pushChangesTo(bobDb.getStore());
    abandonSession(carrier);
  }

  it("stays hidden when the removal or a later change first arrives in a fresh session", async () => {
    const aliceDb = await alice.tenant.openDB("removal");
    const doc = await aliceDb.createDocument({ recipients: [bob.username], initialValues: { v: 1 } });
    const docId = doc.getId();

    // Bob reads it once and closes the tab cleanly.
    await deliverToBobOffline();
    const b1 = await bobSession();
    const b1Db = await b1.openDB("removal");
    expect(await b1Db.getAllDocumentIds()).toContain(docId);
    await endSession(b1);

    // Alice removes Bob and edits; Bob's next session sees both in its open-time delta.
    await aliceDb.removeRecipients!(doc, [bob.username]);
    await aliceDb.changeDoc(await aliceDb.getDocument(docId), (d) => {
      d.getData().v = 2;
    });
    await deliverToBobOffline();
    const b2 = await bobSession();
    const b2Db = await b2.openDB("removal");
    expect(await b2Db.getAllDocumentIds()).not.toContain(docId);
    await endSession(b2);

    // A later plain change (no wrap list of its own) must not bring it back.
    await aliceDb.changeDoc(await aliceDb.getDocument(docId), (d) => {
      d.getData().v = 3;
    });
    await deliverToBobOffline();
    const b3 = await bobSession();
    const b3Db = await b3.openDB("removal");
    expect(await b3Db.getAllDocumentIds()).not.toContain(docId);
    await expect(b3Db.getDocument(docId)).rejects.toThrow();
    await endSession(b3);
  });
});
