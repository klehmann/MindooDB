import {
  addDevice,
  addPerson,
  makeTenant,
  restoreDevice,
  revokeDevice,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { asUserKeyPayload, isPendingUserKeyDocument } from "../core/userkeys";

describe("userkey device enrollment", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-userkey-enroll" });
    alice1 = await addPerson(fixture, "alice", "laptop");
    await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("legacy fleet: first mint wraps every current grant device so siblings import without approval", async () => {
    const carol1 = await addPerson(fixture, "carol", "studio");
    const carol2 = await addDevice(fixture, carol1, "tablet");
    await carol1.factory.ensureUserKeyPair!(carol1.user, carol1.password);
    await carol2.factory.ensureUserKeyPair!(carol2.user, carol2.password);
    await syncAll(fixture, "directory");
    carol1.tenant.noteUserDirectoryFetched!();
    await carol1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    carol2.tenant.noteUserDirectoryFetched!();
    const status = await carol2.tenant.reconcileUserKeys!();
    expect(status.state).toBe("approved");
    expect(await carol1.tenant.listPendingUserKeyDevices!()).toEqual([]);
    const rows = await carol1.tenant.listUserKeyDevices!();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "approved")).toBe(true);
  });

  it("a userdirectory fetch is enough to mint and wrap the current grant without allowSelfCreate", async () => {
    const dave1 = await addPerson(fixture, "dave", "studio");
    const dave2 = await addDevice(fixture, dave1, "tablet");
    await dave1.factory.ensureUserKeyPair!(dave1.user, dave1.password);
    await dave2.factory.ensureUserKeyPair!(dave2.user, dave2.password);
    await syncAll(fixture, "directory");
    dave1.tenant.noteUserDirectoryFetched!();
    await dave1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect(await dave1.tenant.listPendingUserKeyDevices!()).toEqual([]);
    const rows = await dave1.tenant.listUserKeyDevices!();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "approved")).toBe(true);
  });

  it("first device has no pending devices after writing its own wrap", async () => {
    const pending = await alice1.tenant.listPendingUserKeyDevices!();
    expect(pending).toEqual([]);
    const status = await alice1.tenant.getUserKeyEnrollmentStatus!();
    expect(status.state).toBe("approved");
    expect(status.pending).toBe(false);
  });

  it("a wrapped device stays approved after reopen without another userdirectory fetch", async () => {
    const reopened = await alice1.factory.openTenant(
      fixture.tenantId,
      fixture.adminUser.userSigningKeyPair.publicKey,
      fixture.adminUser.userEncryptionKeyPair.publicKey,
      alice1.user,
      alice1.password,
      alice1.keyBag,
    );
    await reopened.openDB(USER_DIRECTORY_DB_ID);
    const status = await reopened.reconcileUserKeys!({ allowSelfCreate: true });
    expect(status.state).toBe("approved");
  });

  it("allowSelfCreate without a fetch still reports approved once this device is wrapped", async () => {
    const eve1 = await addPerson(fixture, "eve", "studio");
    await eve1.factory.ensureUserKeyPair!(eve1.user, eve1.password);
    await syncAll(fixture, "directory");
    await eve1.tenant.openDB(USER_DIRECTORY_DB_ID);
    const status = await eve1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    expect(status.state).toBe("approved");
  });

  it("does not create a second key document before userdirectory has been fetched (trap 1)", async () => {
    const bob = await addPerson(fixture, "bob", "desk");
    await bob.factory.ensureUserKeyPair!(bob.user, bob.password);
    await syncAll(fixture, "directory");
    bob.tenant.noteUserDirectoryFetched!();
    await bob.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const bob2 = await addDevice(fixture, bob, "tablet");
    const idsBefore = await (await bob2.tenant.openDB(USER_DIRECTORY_DB_ID)).getAllDocumentIds();
    await bob2.tenant.reconcileUserKeys!();
    const idsAfter = await (await bob2.tenant.openDB(USER_DIRECTORY_DB_ID)).getAllDocumentIds();
    expect(idsAfter).toEqual(idsBefore);
    expect(idsBefore).toEqual([]);
  });

  it("second device is pending on device 1 until approve wraps every epoch", async () => {
    const alice2 = await addDevice(fixture, alice1, "phone");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const pending = await alice1.tenant.listPendingUserKeyDevices!();
    expect(pending).toHaveLength(1);
    expect(pending[0].label).toBe("phone");

    alice2.tenant.noteUserDirectoryFetched!();
    const waiting = await alice2.tenant.reconcileUserKeys!();
    expect(waiting.state).toBe("waiting");

    await alice1.tenant.approveUserKeyDevice!(pending[0].fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    const after = await alice2.tenant.reconcileUserKeys!();
    expect(after.state).toBe("approved");
    expect(await alice1.tenant.listPendingUserKeyDevices!()).toEqual([]);
  });

  it("decline hides the device from other devices after sync; undo restores pending", async () => {
    const alice2 = await addDevice(fixture, alice1, "kiosk");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const pending = await alice1.tenant.listPendingUserKeyDevices!();
    const kiosk = pending.find((p) => p.label === "kiosk");
    expect(kiosk).toBeDefined();
    await alice1.tenant.declineUserKeyDevice!(kiosk!.fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect((await alice1.tenant.listPendingUserKeyDevices!()).some((p) => p.fingerprint === kiosk!.fingerprint)).toBe(
      false,
    );
    await alice1.tenant.undoDeclineUserKeyDevice!(kiosk!.fingerprint);
    expect((await alice1.tenant.listPendingUserKeyDevices!()).some((p) => p.fingerprint === kiosk!.fingerprint)).toBe(
      true,
    );
  });

  it("never auto-wraps a grant-only device", async () => {
    const alice2 = await addDevice(fixture, alice1, "planted");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const resolved = await alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const wraps = Object.values(resolved!.payload.userKeys).flatMap((g) => Object.keys(g.deviceWraps ?? {}));
    const pending = await alice1.tenant.listPendingUserKeyDevices!();
    const planted = pending.find((p) => p.label === "planted");
    expect(planted).toBeDefined();
    expect(wraps).not.toContain(planted!.fingerprint);
  });

  it("revoked devices drop wraps and do not reappear as pending; restore returns to pending", async () => {
    const alice2 = await addDevice(fixture, alice1, "spare");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const pending = (await alice1.tenant.listPendingUserKeyDevices!()).find((p) => p.label === "spare");
    await alice1.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await revokeDevice(fixture, alice1.username, alice2.user.userSigningKeyPair.publicKey);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const afterRevoke = await alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(asUserKeyPayload(afterRevoke!.doc.getData())!.userKeys["1"].deviceWraps[pending!.fingerprint]).toBeUndefined();
    expect((await alice1.tenant.listPendingUserKeyDevices!()).some((p) => p.fingerprint === pending!.fingerprint)).toBe(
      false,
    );
    await restoreDevice(fixture, alice1.username, alice2.user.userSigningKeyPair.publicKey);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    expect((await alice1.tenant.listPendingUserKeyDevices!()).some((p) => p.fingerprint === pending!.fingerprint)).toBe(
      true,
    );
  });
});

void isPendingUserKeyDocument;
