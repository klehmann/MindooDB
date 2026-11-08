import type { MindooDB } from "../core/types";
import { DEFAULT_FILING_PRUNE_GRACE_MS } from "../core/filing";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";
import { addPerson, makeTenant, syncAll } from "./_helpers/multiDevice";

async function createDoc(db: MindooDB, subject: string, decryptionKeyId?: string): Promise<string> {
  const doc = await db.createDocument(decryptionKeyId ? { decryptionKeyId } : undefined);
  await db.changeDoc(doc, (d) => {
    d.getData().subject = subject;
  });
  return doc.getId();
}

describe("filing cleanup of deleted documents", () => {
  it("removes deleted documents of the filing database automatically (grace period 0)", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-prune-auto");
    const db = await ctx.tenant.openDB("mail");
    const filing = db.filing!("mail", { pruneGracePeriodMs: 0 });
    const kept = await createDoc(db, "kept");
    const gone = await createDoc(db, "gone");
    await filing.add(kept, "inbox");
    await filing.add(gone, ["inbox", "projA"]);
    expect(await filing.count("inbox")).toBe(2);

    await db.deleteDocument(gone);
    await (await filing.getIndex()).update();
    await filing.whenIdle();
    expect(await filing.foldersOf(gone)).toEqual([]);
    expect(await filing.foldersOf(kept)).toEqual(["inbox"]);
    expect(await filing.count("projA")).toBe(0);
  }, 60000);

  it("keeps deleted documents in their folders for the grace period (undelete brings them back)", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-prune-grace");
    const db = await ctx.tenant.openDB("mail");
    const filing = db.filing!("mail");
    const a = await createDoc(db, "a");
    const b = await createDoc(db, "b");
    await filing.add(a, "inbox");
    await filing.add(b, "inbox");
    await db.deleteDocument(a);
    await db.deleteDocument(b);
    await (await filing.getIndex()).update();
    await filing.whenIdle();
    // Default: 30 days — nothing removed yet.
    expect(await filing.prune()).toEqual({ removed: 0, pending: 2 });
    expect(await filing.count("inbox")).toBe(2);

    // b comes back within the grace period: its folders were kept.
    await db.undeleteDocument(b);
    const later = Date.now() + DEFAULT_FILING_PRUNE_GRACE_MS + 1000;
    expect(await filing.prune({ now: later })).toEqual({ removed: 1, pending: 0 });
    expect(await filing.foldersOf(a)).toEqual([]);
    expect(await filing.foldersOf(b)).toEqual(["inbox"]);
  }, 60000);

  it("touches documents of other databases only when they are given", async () => {
    const ctx = await createWitnessingTenant("tenant-filing-prune-crossdb");
    const folders = await ctx.tenant.openDB("folders");
    const crm = await ctx.tenant.openDB("crm");
    const filing = folders.filing!("work", { pruneGracePeriodMs: 0 });
    const deal = await createDoc(crm, "deal");
    await filing.add({ dbId: "crm", docId: deal }, "customerA");
    await crm.deleteDocument(deal);

    expect(await filing.prune()).toEqual({ removed: 0, pending: 0 });
    expect(await filing.count("customerA")).toBe(1);
    expect(await filing.prune({ databases: [crm] })).toEqual({ removed: 1, pending: 0 });
    expect(await filing.count("customerA")).toBe(0);
  }, 60000);

  it("never removes documents this device cannot read", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-filing-prune-unreadable" });
    const alice = await addPerson(fixture, "alice", "phone");
    const bob = await addPerson(fixture, "bob", "laptop");
    await syncAll(fixture, "directory");
    await alice.keyBag.createDocKey(fixture.tenantId, "secret");
    const aliceDb = await alice.tenant.openDB("mail");
    const secret = await createDoc(aliceDb, "secret", "secret");
    await aliceDb.filing!("mail").add(secret, "inbox");
    await syncAll(fixture, "mail", [alice, bob]);

    const bobDb = await bob.tenant.openDB("mail");
    const bobFiling = bobDb.filing!("mail", { pruneGracePeriodMs: 0 });
    await (await bobFiling.getIndex()).update();
    await bobFiling.whenIdle();
    expect(await bobFiling.prune()).toEqual({ removed: 0, pending: 0 });
    expect(await bobFiling.foldersOf(secret)).toEqual(["inbox"]);
  }, 180000);
});
