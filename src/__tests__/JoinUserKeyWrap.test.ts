import {
  addPerson,
  IsolatedInMemoryStoreFactory,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { fingerprintEncryptionPublicKey } from "../core/userkeys/fingerprint";
import { USER_DIRECTORY_DB_ID } from "../core/types";

async function mintUserKey(device: DeviceHandle, fixture: MultiDeviceFixture): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  await syncAll(fixture, "directory");
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
  await syncAll(fixture, USER_DIRECTORY_DB_ID);
}

describe("join approval wraps User-Key for the current person only", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-join-uk-wrap" });
    alice1 = await addPerson(fixture, "alice", "laptop");
    await mintUserKey(alice1, fixture);
  });

  it("wraps the current person's User-Key to the joining device", async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), fixture.crypto);
    const joining = await factory.createUserId("", "phone-pass-123");
    await factory.ensureUserKeyPair!(joining, "phone-pass-123");
    const joinRequest = factory.createJoinRequest(joining, { label: "phone" });
    await alice1.tenant.approveJoinRequest(joinRequest, {
      adminSigningKey: fixture.adminUser.userSigningKeyPair.privateKey,
      adminPassword: fixture.adminPassword,
      username: alice1.username,
      label: "phone",
    });
    expect(await alice1.tenant.listPendingUserKeyDevices!()).toEqual([]);
    const rows = await alice1.tenant.listUserKeyDevices!();
    const joiningFp = await fingerprintEncryptionPublicKey(
      joining.userEncryptionKeyPair.publicKey,
      fixture.crypto.getSubtle(),
    );
    expect(rows.find((row) => row.fingerprint === joiningFp)?.status).toBe("approved");
  });

  it("leaves another person's additional device pending until they wrap it", async () => {
    const bob1 = await addPerson(fixture, "bob", "desk");
    await mintUserKey(bob1, fixture);
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), fixture.crypto);
    const joining = await factory.createUserId("", "bob-phone-pass-123");
    await factory.ensureUserKeyPair!(joining, "bob-phone-pass-123");
    const joinRequest = factory.createJoinRequest(joining, { label: "bob-phone" });
    await alice1.tenant.approveJoinRequest(joinRequest, {
      adminSigningKey: fixture.adminUser.userSigningKeyPair.privateKey,
      adminPassword: fixture.adminPassword,
      username: bob1.username,
      label: "bob-phone",
    });
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    bob1.tenant.noteUserDirectoryFetched!();
    await bob1.tenant.reconcileUserKeys!();
    const pending = await bob1.tenant.listPendingUserKeyDevices!();
    expect(pending).toHaveLength(1);
    expect(pending[0].label).toBe("bob-phone");
    expect(await alice1.tenant.listPendingUserKeyDevices!()).toEqual([]);
  });
});
