import { addDevice, addPerson, makeTenant, syncAll } from "./_helpers/multiDevice";

describe("multi-device test harness", () => {
  it("registers two devices of one user with labels in the grant overview", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-md-smoke" });
    const alice1 = await addPerson(fixture, "alice", "phone");
    const alice2 = await addDevice(fixture, alice1, "laptop");
    await syncAll(fixture, "directory");

    const directory = await fixture.host.tenant.openDirectory();
    const overview = await directory.getUserGrantOverview!(alice1.username);
    const labels = overview.activeDevices.map((d) => d.label).sort();
    expect(labels).toEqual(["laptop", "phone"]);
    expect(overview.activeDevices).toHaveLength(2);
    expect(alice2.username).toBe(alice1.username);
  }, 120000);
});
