import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { currentUserKeyEpoch } from "../core/userkeys";

describe("userkey rotation", () => {
  jest.setTimeout(180000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;
  let alice2: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-userkey-rot" });
    alice1 = await addPerson(fixture, "alice", "laptop");
    await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    alice2 = await addDevice(fixture, alice1, "phone");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const pending = (await alice1.tenant.listPendingUserKeyDevices!()).find((p) => p.label === "phone");
    await alice1.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    await alice2.tenant.reconcileUserKeys!();
  });

  it("adds a strictly later epoch, keeps old generations, and remaining devices can still unwrap both", async () => {
    const before = await alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const oldEpoch = currentUserKeyEpoch(before!.payload)!;
    const oldFp = before!.payload.userKeys[oldEpoch].fingerprint;
    await alice1.tenant.rotateUserKey!();
    const after = await alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const newEpoch = currentUserKeyEpoch(after!.payload)!;
    expect(BigInt(newEpoch) > BigInt(oldEpoch)).toBe(true);
    expect(after!.payload.userKeys[oldEpoch].retiredAt).toBeGreaterThan(0);
    expect(after!.payload.userKeys[oldEpoch].fingerprint).toBe(oldFp);
    expect(after!.payload.userKeys[newEpoch]).toBeDefined();
    expect(Object.keys(after!.payload.userKeys[oldEpoch].deviceWraps).length).toBeGreaterThan(0);
    expect(Object.keys(after!.payload.userKeys[newEpoch].deviceWraps).length).toBeGreaterThan(1);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    await alice2.tenant.reconcileUserKeys!();
    const alice2Doc = await alice2.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(currentUserKeyEpoch(alice2Doc!.payload)).toBe(newEpoch);
    expect(alice2.user.userKeyPair!.publicKey).toBe(after!.payload.userKeys[newEpoch].publicKey);
  });
});
