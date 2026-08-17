import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { DEFAULT_TENANT_KEY_ID, USER_DIRECTORY_DB_ID } from "../core/types";
import { aclKeyDistributionDocId } from "../core/accesscontrol/types";

async function stripDefaultKey(device: DeviceHandle, tenantId: string): Promise<void> {
  await device.keyBag.deleteKey("doc", tenantId, DEFAULT_TENANT_KEY_ID);
}

describe("key distribution targets user keys", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-uk-dist" });
    alice1 = await addPerson(fixture, "alice", "laptop");
    await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const directory = await fixture.host.tenant.openDirectory();
    await directory.autoDistributeKeysToUser!(
      alice1.username,
      [DEFAULT_TENANT_KEY_ID],
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    await syncAll(fixture, "directory");
  });

  it("wraps default to one user-key fingerprint, not per device", async () => {
    const directory = await fixture.host.tenant.openDirectory();
    const wrap = await directory.wrapKeyForUser!(DEFAULT_TENANT_KEY_ID, alice1.username);
    expect(wrap).not.toBeNull();
    expect(Object.keys(wrap!.devices)).toHaveLength(1);
  });

  it("wrapKeyForUser returns null when the person has no published User-Key", async () => {
    const bob = await addPerson(fixture, "bob", "desk");
    const directory = await fixture.host.tenant.openDirectory();
    const wrap = await directory.wrapKeyForUser!(DEFAULT_TENANT_KEY_ID, bob.username);
    expect(wrap).toBeNull();
  });

  it("addUserKeys does not rewrite the default distribution wrap map", async () => {
    const dirDb = await fixture.host.tenant.openDB("directory", { adminOnlyDb: true });
    const distId = aclKeyDistributionDocId(DEFAULT_TENANT_KEY_ID);
    const before = await dirDb.getDocument(distId);
    const beforeKeys = Object.keys(
      ((before?.getData() as { pushto_users_keys?: Record<string, unknown> })?.pushto_users_keys) ?? {},
    );
    const alice2 = await addDevice(fixture, alice1, "watch");
    await syncAll(fixture, "directory");
    const after = await dirDb.getDocument(distId);
    const afterKeys = Object.keys(
      ((after?.getData() as { pushto_users_keys?: Record<string, unknown> })?.pushto_users_keys) ?? {},
    );
    expect(afterKeys).toEqual(beforeKeys);
    expect(alice2.username).toBe(alice1.username);
  });

  it("an unapproved additional device does not import default", async () => {
    const alice2 = await addDevice(fixture, alice1, "pager");
    await stripDefaultKey(alice2, fixture.tenantId);
    expect(await alice2.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(false);
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    const waiting = await alice2.tenant.reconcileUserKeys!();
    expect(waiting.state).toBe("waiting");
    await alice2.tenant.reconcileKeyDistributionsForCurrentUser!();
    expect(await alice2.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(false);
  });

  it("an approved additional device imports default via the user key", async () => {
    const alice2 = await addDevice(fixture, alice1, "tablet");
    await stripDefaultKey(alice2, fixture.tenantId);
    await alice2.factory.ensureUserKeyPair!(alice2.user, alice2.password);
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const pending = (await alice1.tenant.listPendingUserKeyDevices!()).find((p) => p.label === "tablet");
    expect(pending).toBeDefined();
    await alice1.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    await alice2.tenant.reconcileUserKeys!();
    await alice2.tenant.reconcileKeyDistributionsForCurrentUser!();
    expect(await alice2.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);
  });

  it("wrapKeyForUser after rotation targets the new fingerprint", async () => {
    const before = await alice1.tenant.getUserKeyManager().publishedUserKeyFor(alice1.username);
    await alice1.tenant.rotateUserKey!();
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const after = await alice1.tenant.getUserKeyManager().publishedUserKeyFor(alice1.username);
    expect(after?.fingerprint).toBeDefined();
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
    const directory = await fixture.host.tenant.openDirectory();
    const wrap = await directory.wrapKeyForUser!(DEFAULT_TENANT_KEY_ID, alice1.username);
    expect(wrap).not.toBeNull();
    expect(Object.keys(wrap!.devices)).toEqual([after!.fingerprint]);
  });
});
