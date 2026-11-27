/**
 * Team mailbox and team calendar (docs/accesscontrol.md §6.11, "Team
 * databases"): `tmail_<id>` / `tcal_<id>` belong to the directory group whose
 * `team_mailbox_id` is that id. Members (also through nested groups) read and
 * write; other members of the tenant only deposit (internal mail); without a
 * group nobody but the admin gets anything.
 */
import { addPerson, makeTenant, type DeviceHandle, type MultiDeviceFixture } from "./_helpers/multiDevice";
import { personalDatabaseOwner, isTeamDatabasePrefix } from "../core/builtinDbInvariants";

describe("team databases", () => {
  jest.setTimeout(120000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let carol: DeviceHandle;
  let dave: DeviceHandle;

  const keyOf = (device: DeviceHandle) => device.user.userSigningKeyPair.publicKey as string;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-team-mailbox" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    carol = await addPerson(fixture, "carol", "phone");
    dave = await addPerson(fixture, "dave", "tablet");
  });

  it("parses team database ids", () => {
    expect(personalDatabaseOwner("tmail_abc12345")).toEqual({ prefix: "tmail_", grantDocId: "abc12345" });
    expect(personalDatabaseOwner("tcal_abc12345")).toEqual({ prefix: "tcal_", grantDocId: "abc12345" });
    expect(isTeamDatabasePrefix("tmail_")).toBe(true);
    expect(isTeamDatabasePrefix("mmail_")).toBe(false);
  });

  it("members read and write, others deposit, nested groups count, removal takes effect", async () => {
    const directory = await fixture.host.tenant.openDirectory();
    const admin = fixture.adminUser.userSigningKeyPair.privateKey;
    const pw = fixture.adminPassword;
    await directory.addUsersToGroup("support", [alice.username, "support-nested"], admin, pw);
    await directory.addUsersToGroup("support-nested", [bob.username], admin, pw);
    const mailboxId = "sup0rt1234";

    const access = (device: DeviceHandle, dbid: string) =>
      directory.evaluatePersonalDatabaseAccess!({ dbid, signingKey: keyOf(device) });

    // Not yet a team mailbox: nobody but the admin.
    expect((await access(alice, `tmail_${mailboxId}`))?.mode).toBe("none");

    await directory.setGroupTeamMailboxId!("support", mailboxId, admin, pw);
    expect(await directory.getGroupTeamMailboxId!("Support")).toBe(mailboxId);
    expect(await directory.listTeamMailboxes!()).toEqual([{ groupName: "support", mailboxId }]);

    for (const dbid of [`tmail_${mailboxId}`, `tcal_${mailboxId}`]) {
      expect((await access(alice, dbid))?.mode).toBe("read");
      expect((await access(bob, dbid))?.mode).toBe("read"); // through support-nested
      const other = await access(carol, dbid);
      expect(other?.mode).toBe("deposit");
      expect(other?.docIdPrefixes).toEqual([dbid.startsWith("tmail_") ? "memo_" : "cinv_"]);
    }
    const adminAccess = await directory.evaluatePersonalDatabaseAccess!({
      dbid: `tmail_${mailboxId}`,
      signingKey: fixture.adminUser.userSigningKeyPair.publicKey as string,
    });
    expect(adminAccess?.mode).toBe("read");

    // An id belongs to one group only.
    await directory.addUsersToGroup("sales", [dave.username], admin, pw);
    await expect(directory.setGroupTeamMailboxId!("sales", mailboxId, admin, pw)).rejects.toThrow(/already belongs/);
    await expect(directory.setGroupTeamMailboxId!("sales", "NOPE", admin, pw)).rejects.toThrow(/not a team mailbox id/);

    // Bob leaves the nested group: read access ends at once.
    await directory.removeUsersFromGroup("support-nested", [bob.username], admin, pw);
    expect((await access(bob, `tmail_${mailboxId}`))?.mode).toBe("deposit");

    // Ending the team mailbox: the databases stay, but belong to nobody.
    await directory.setGroupTeamMailboxId!("support", null, admin, pw);
    expect((await access(alice, `tmail_${mailboxId}`))?.mode).toBe("none");
  });
});
