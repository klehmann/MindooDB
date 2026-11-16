import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { DEFAULT_TENANT_KEY_ID, USER_DIRECTORY_DB_ID } from "../core/types";
import type { KeyDistributionRequest } from "../core/accesscontrol/types";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";

/**
 * Scenario D (docs/userkeys.md §4.5) for people who got `default` through a
 * key distribution before User-Keys existed: per-device wraps, no User-Key
 * document. They used to be stuck, because the "default is already
 * distributed to you" guard refused to mint, so nothing could be sealed to
 * them ("No published User-Key is available to seal this document to").
 */
describe("userkey self-create for people from before User-Keys", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-userkey-legacy-dist" });
  });

  /** The admin distributes `default` the old way: one wrap per grant device of each person. */
  async function distributeDefaultPerDevice(usernames: string[]): Promise<void> {
    const directory = (await fixture.host.tenant.openDirectory()) as BaseMindooTenantDirectory;
    const request: KeyDistributionRequest = {
      v: 1,
      keyId: DEFAULT_TENANT_KEY_ID,
      keyVersions: await directory.getKeyVersionManifest(DEFAULT_TENANT_KEY_ID),
      title: DEFAULT_TENANT_KEY_ID,
      preparedByPublicKey: fixture.host.user.userSigningKeyPair.publicKey,
      pushto: await Promise.all(
        usernames.map((username) => directory.wrapKeyForUserDevices(DEFAULT_TENANT_KEY_ID, username)),
      ),
      pullfrom: [],
    };
    await directory.publishKeyDistribution(request, fixture.adminUser.userSigningKeyPair.privateKey, fixture.adminPassword);
    await syncAll(fixture, "directory");
  }

  async function userKeyDocIds(device: DeviceHandle): Promise<string[]> {
    const ids = await (await device.tenant.openDB(USER_DIRECTORY_DB_ID)).getAllDocumentIds();
    return ids.filter((id) => id.startsWith("userkey_"));
  }

  it("mints once userdirectory was fetched, without allowSelfCreate, and the sibling imports it", async () => {
    const erin1 = await addPerson(fixture, "erin", "laptop");
    const erin2 = await addDevice(fixture, erin1, "phone");
    await erin1.factory.ensureUserKeyPair!(erin1.user, erin1.password);
    await erin2.factory.ensureUserKeyPair!(erin2.user, erin2.password);
    await distributeDefaultPerDevice([erin1.username]);

    const directory = (await erin1.tenant.openDirectory()) as BaseMindooTenantDirectory;
    expect(await directory.getManagedKeyIds(erin1.username)).toContain(DEFAULT_TENANT_KEY_ID);
    expect(await directory.isKeyDistributedViaUserKey(DEFAULT_TENANT_KEY_ID, erin1.username)).toBe(false);

    // Like a server tenant in Haven: no allowSelfCreate, but a fresh pull.
    erin1.tenant.noteUserDirectoryFetched!();
    const status = await erin1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    expect(status.state).toBe("approved");
    expect(await userKeyDocIds(erin1)).toHaveLength(1);
    const published = await erin1.tenant.getUserKeyManager().publishedUserKeyFor(erin1.username);
    expect(published).not.toBeNull();
    expect(published!.pending).toBe(false);

    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    erin2.tenant.noteUserDirectoryFetched!();
    expect((await erin2.tenant.reconcileUserKeys!()).state).toBe("approved");
    expect(await userKeyDocIds(erin2)).toHaveLength(1);
    const rows = await erin1.tenant.listUserKeyDevices!();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "approved")).toBe(true);
  });

  it("does not mint before userdirectory was fetched", async () => {
    const finn1 = await addPerson(fixture, "finn", "laptop");
    await finn1.factory.ensureUserKeyPair!(finn1.user, finn1.password);
    await distributeDefaultPerDevice([finn1.username]);
    await finn1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    expect(await userKeyDocIds(finn1)).toEqual([]);
  });

  it("does not mint on a device that does not hold default itself", async () => {
    const gina1 = await addPerson(fixture, "gina", "laptop");
    await gina1.factory.ensureUserKeyPair!(gina1.user, gina1.password);
    await distributeDefaultPerDevice([gina1.username]);
    await gina1.keyBag.deleteKey("doc", fixture.tenantId, DEFAULT_TENANT_KEY_ID);
    gina1.tenant.noteUserDirectoryFetched!();
    await gina1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    expect(await userKeyDocIds(gina1)).toEqual([]);
  });

  it("two devices that mint at the same time end up with one key both can use", async () => {
    const hugo1 = await addPerson(fixture, "hugo", "laptop");
    const hugo2 = await addDevice(fixture, hugo1, "phone");
    await hugo1.factory.ensureUserKeyPair!(hugo1.user, hugo1.password);
    await hugo2.factory.ensureUserKeyPair!(hugo2.user, hugo2.password);
    await distributeDefaultPerDevice([hugo1.username]);
    hugo1.tenant.noteUserDirectoryFetched!();
    hugo2.tenant.noteUserDirectoryFetched!();
    await hugo1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    await hugo2.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    await hugo1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    await hugo2.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect((await hugo1.tenant.reconcileUserKeys!()).state).toBe("approved");
    expect((await hugo2.tenant.reconcileUserKeys!()).state).toBe("approved");
    const published = await hugo1.tenant.getUserKeyManager().publishedUserKeyFor(hugo1.username);
    expect(published).not.toBeNull();
    expect(await hugo1.tenant.getUserKeyManager().getLocalUserPublicKey()).toBe(published!.publicKey);
    expect(await hugo2.tenant.getUserKeyManager().getLocalUserPublicKey()).toBe(published!.publicKey);
  });
});
