import {
  ColumnSorting,
  SelectedOnly,
  VirtualViewFactory,
  type VirtualView,
} from "../core/indexing/virtualviews";
import { createViewLanguage } from "../core/expressions";
import { addPerson, makeTenant, syncAll } from "./_helpers/multiDevice";

const v = createViewLanguage<{ subject: string; n: number }>();

async function rows(view: VirtualView): Promise<string[]> {
  const nav = VirtualViewFactory.createNavigator(view).build().expandAll();
  const result: string[] = [];
  for await (const entry of nav.entriesForward(SelectedOnly.NO)) {
    if (entry.isDocument()) {
      const parent = entry.getParent();
      const category = parent && parent.getParent() ? String(parent.getCategoryValue()) : "-";
      result.push(`${category} > ${entry.getColumnValues().subject}`);
    }
  }
  return result;
}

describe("filing across replicas", () => {
  it("converges when two replicas file the same document concurrently", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-filing-replicas" });
    const alice = await addPerson(fixture, "alice", "phone");
    const bob = await addPerson(fixture, "bob", "laptop");
    await syncAll(fixture, "directory");

    const aliceDb = await alice.tenant.openDB("mail");
    const doc = await aliceDb.createDocument();
    await aliceDb.changeDoc(doc, (d) => {
      Object.assign(d.getData(), { subject: "shared", n: 1 });
    });
    await syncAll(fixture, "mail", [alice, bob]);
    const bobDb = await bob.tenant.openDB("mail");

    // Both replicas file the same document for the first time, offline.
    await aliceDb.filing!("mail").add(doc.getId(), "inbox");
    await aliceDb.filing!("mail").add(doc.getId(), "todo");
    await bobDb.filing!("mail").add(doc.getId(), "projA");
    // ...and one moves concurrently.
    await bobDb.filing!("mail").move(doc.getId(), { from: "projA", to: "projB" });

    await syncAll(fixture, "mail", [alice, bob]);

    const expected = ["inbox", "projB", "todo"];
    expect(await aliceDb.filing!("mail").foldersOf(doc.getId())).toEqual(expected);
    expect(await bobDb.filing!("mail").foldersOf(doc.getId())).toEqual(expected);
    // The deterministic sidecar id makes both replicas write ONE document.
    const sidecars = (await aliceDb.getAllDocumentIds()).filter((id) => id.startsWith("fil_"));
    expect(sidecars).toHaveLength(1);
    expect((await bobDb.getAllDocumentIds()).filter((id) => id.startsWith("fil_"))).toEqual(sidecars);

    // Concurrent remove (alice) and add (bob) of different folders merge.
    await aliceDb.filing!("mail").remove(doc.getId(), "inbox");
    await bobDb.filing!("mail").add(doc.getId(), "later");
    await syncAll(fixture, "mail", [alice, bob]);
    expect(await aliceDb.filing!("mail").foldersOf(doc.getId())).toEqual(["later", "projB", "todo"]);

    // A view on bob's replica reflects everything after sync.
    const view = await VirtualViewFactory.createView()
      .withFilingStore("mail", { db: bobDb, store: "mail" })
      .addCategoryColumn("folder", { expression: v.folders("mail") })
      .addSortedColumn("n", ColumnSorting.ASCENDING)
      .addDisplayColumn("subject")
      .withDB("mail", bobDb, v.inFolder("mail"))
      .buildAndUpdate();
    expect(await rows(view)).toEqual(["later > shared", "projB > shared", "todo > shared"]);
  }, 180000);

  it("shows no row for a filed document the user cannot read, and the row once the key arrives", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-filing-unreadable" });
    const alice = await addPerson(fixture, "alice", "phone");
    const bob = await addPerson(fixture, "bob", "laptop");
    await syncAll(fixture, "directory");

    // Alice has a key bob does not have.
    await alice.keyBag.createDocKey(fixture.tenantId, "secret");
    const aliceDb = await alice.tenant.openDB("mail");
    const secret = await aliceDb.createDocument({ decryptionKeyId: "secret" });
    await aliceDb.changeDoc(secret, (d) => {
      Object.assign(d.getData(), { subject: "secret", n: 1 });
    });
    const open = await aliceDb.createDocument();
    await aliceDb.changeDoc(open, (d) => {
      Object.assign(d.getData(), { subject: "open", n: 2 });
    });
    await aliceDb.filing!("mail").add(secret.getId(), "inbox");
    await aliceDb.filing!("mail").add(open.getId(), "inbox");
    await syncAll(fixture, "mail", [alice, bob]);

    const bobDb = await bob.tenant.openDB("mail");
    const build = (db: typeof bobDb) =>
      VirtualViewFactory.createView()
        .withFilingStore("mail", { db, store: "mail" })
        .addCategoryColumn("folder", { expression: v.folders("mail") })
        .addSortedColumn("n", ColumnSorting.ASCENDING)
        .addDisplayColumn("subject")
        .withDB("mail", db, v.inFolder("mail"))
        .buildAndUpdate();

    const bobView = await build(bobDb);
    // Bob sees the filing (the sidecar is readable) but not the document.
    expect(await bobDb.filing!("mail").foldersOf(secret.getId())).toEqual(["inbox"]);
    expect(await rows(bobView)).toEqual(["inbox > open"]);
    const aliceView = await build(aliceDb);
    expect(await rows(aliceView)).toEqual(["inbox > secret", "inbox > open"]);

    // The key arrives: the document becomes readable and shows up through
    // its own changefeed, with its folder.
    await bob.keyBag.set("doc", fixture.tenantId, "secret", (await alice.keyBag.get("doc", fixture.tenantId, "secret"))!);
    await bob.tenant.reconcileKeyBagChanges?.();
    await bobView.update();
    expect(await rows(bobView)).toEqual(["inbox > secret", "inbox > open"]);
  }, 180000);
});
