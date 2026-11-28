/**
 * `$sealed:<groupDocId>` names a key series by a document id, and document ids
 * are unique per database only. Mindoo Mail derives the group id of the Mindoo
 * Mail account from the account id alone, so every mailbox has the same
 * `mgrp_…` id. A delegate who holds her own group under that id must not take
 * it for the owner's.
 */
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { addPerson, makeTenant, syncAll, type DeviceHandle, type MultiDeviceFixture } from "./_helpers/multiDevice";

async function publishUserKey(device: DeviceHandle): Promise<void> {
  await device.factory.ensureUserKeyPair!(device.user, device.password);
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

describe("one group document id in two databases", () => {
  jest.setTimeout(240000);
  let fixture: MultiDeviceFixture;
  let ada: DeviceHandle;
  let hedy: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-across-dbs" });
    ada = await addPerson(fixture, "ada", "laptop");
    hedy = await addPerson(fixture, "hedy", "pc");
    await syncAll(fixture, "directory");
    for (const device of [ada, hedy]) await publishUserKey(device);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    for (const device of [ada, hedy]) {
      device.tenant.noteUserDirectoryFetched!();
      await device.tenant.reconcileUserKeys!();
    }
  });

  it("keeps each database's series apart", async () => {
    const adaDb = await ada.tenant.openDB("mbox_ada");
    await adaDb.createDocument({ id: "mgrp_same", assumeUniqueId: true, recipients: [], initialValues: { type: "group" } });
    await adaDb.createDocument({ id: "m_ada", assumeUniqueId: true, groupKeyDocId: "mgrp_same", initialValues: { type: "mail" } });
    await syncAll(fixture, "mbox_ada");

    const hedyOwn = await hedy.tenant.openDB("mbox_hedy");
    await hedyOwn.createDocument({ id: "mgrp_same", assumeUniqueId: true, recipients: [], initialValues: { type: "group" } });
    await hedyOwn.createDocument({ id: "m_hedy", assumeUniqueId: true, groupKeyDocId: "mgrp_same", initialValues: { type: "mail" } });

    const hedyOnAda = await hedy.tenant.openDB("mbox_ada");
    await hedyOnAda.syncStoreChanges();
    // Hedy is not in Ada's group: Ada's documents are not hers to list.
    expect(await hedyOnAda.getAllDocumentIds()).toEqual([]);
    // Her own group still opens, from a cold cache too.
    (hedyOwn as unknown as { docCache: Map<string, unknown> }).docCache.clear();
    expect((await hedyOwn.getDocument("m_hedy")).getData().type).toBe("mail");

    // Ada writes more after Hedy's own series is back in the session.
    await adaDb.createDocument({ id: "m_ada2", assumeUniqueId: true, groupKeyDocId: "mgrp_same", initialValues: { type: "mail" } });
    await syncAll(fixture, "mbox_ada");
    await hedyOnAda.syncStoreChanges();
    expect(await hedyOnAda.getAllDocumentIds()).toEqual([]);
    const rows = await hedyOnAda.query({ fields: ["type"], limit: 10 });
    expect(rows.rows).toEqual([]);
  });

  it("lets a delegate read and write the owner's group while she has her own under the same id", async () => {
    const adaDb = await ada.tenant.openDB("mbox2_ada");
    await adaDb.createDocument({ id: "mgrp_shared", assumeUniqueId: true, recipients: [], initialValues: { type: "group" } });
    await adaDb.createDocument({ id: "m_before", assumeUniqueId: true, groupKeyDocId: "mgrp_shared", initialValues: { type: "mail", n: "before" } });
    const hedyOwn = await hedy.tenant.openDB("mbox2_hedy");
    await hedyOwn.createDocument({ id: "mgrp_shared", assumeUniqueId: true, recipients: [], initialValues: { type: "group" } });
    await adaDb.addRecipients!(await adaDb.getDocument("mgrp_shared"), [hedy.username], { history: "all" });
    await syncAll(fixture, "mbox2_ada");

    const hedyOnAda = await hedy.tenant.openDB("mbox2_ada");
    await hedyOnAda.syncStoreChanges();
    expect((await hedyOnAda.getDocument("m_before")).getData().n).toBe("before");
    await hedyOnAda.createDocument({ id: "m_by_hedy", assumeUniqueId: true, groupKeyDocId: "mgrp_shared", initialValues: { type: "mail", n: "hedy" } });
    await syncAll(fixture, "mbox2_ada");

    await adaDb.syncStoreChanges();
    (adaDb as unknown as { docCache: Map<string, unknown> }).docCache.clear();
    expect((await adaDb.getDocument("m_by_hedy")).getData().n).toBe("hedy");
    // Her own group is untouched.
    await hedyOwn.createDocument({ id: "m_own", assumeUniqueId: true, groupKeyDocId: "mgrp_shared", initialValues: { type: "mail", n: "own" } });
    (hedyOwn as unknown as { docCache: Map<string, unknown> }).docCache.clear();
    expect((await hedyOwn.getDocument("m_own")).getData().n).toBe("own");
  });
});
