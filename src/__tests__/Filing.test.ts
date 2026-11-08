import type { MindooDB } from "../core/types";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";
import { resolveFilingRef, formatFilingRef, type FilingEntry } from "../core/filing";

async function createDoc(db: MindooDB, values: Record<string, unknown>): Promise<string> {
  const doc = await db.createDocument();
  await db.changeDoc(doc, (d) => {
    Object.assign(d.getData(), values);
  });
  return doc.getId();
}

describe("filing refs", () => {
  const base = { tenantId: "t1", dbId: "mail" };

  it("resolves and formats the three reference forms", () => {
    expect(resolveFilingRef("doc_a", base)).toEqual({ tenantId: "t1", dbId: "mail", docId: "doc_a" });
    expect(resolveFilingRef("mdbref:/crm/doc_b", base)).toEqual({ tenantId: "t1", dbId: "crm", docId: "doc_b" });
    expect(resolveFilingRef("mdbref://t2/crm/doc_c", base)).toEqual({ tenantId: "t2", dbId: "crm", docId: "doc_c" });
    expect(resolveFilingRef({ dbId: "crm", docId: "x" }, base)).toEqual({ tenantId: "t1", dbId: "crm", docId: "x" });

    expect(formatFilingRef({ tenantId: "t1", dbId: "mail", docId: "a" }, base)).toBe("a");
    expect(formatFilingRef({ tenantId: "t1", dbId: "crm", docId: "a" }, base)).toBe("mdbref:/crm/a");
    expect(formatFilingRef({ tenantId: "t2", dbId: "crm", docId: "a" }, base)).toBe("mdbref://t2/crm/a");
  });

  it("rejects malformed references", () => {
    expect(() => resolveFilingRef("mdbref:/onlydb", base)).toThrow();
    expect(() => resolveFilingRef("mdbref://t/db", base)).toThrow();
    expect(() => resolveFilingRef("", base)).toThrow();
    expect(() => resolveFilingRef("a/b", base)).toThrow();
  });
});

describe("db.filing()", () => {
  let db: MindooDB;

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-filing");
    db = await ctx.tenant.openDB("filing-db");
  }, 30000);

  it("files, moves and removes without changing the filed document", async () => {
    const mailId = await createDoc(db, { type: "message", subject: "Hello" });
    const before = await db.getDocument(mailId);
    const headsBefore = JSON.stringify(before.getData());
    const modifiedBefore = before.getLastModified();

    const filing = db.filing!("mail");
    const inbox = await filing.createFolder({ name: "Inbox", folderId: "inbox", role: "inbox" });
    const projA = await filing.createFolder({ name: "Project A" });
    expect(projA.folderId).toMatch(/^fld_[0-9a-f]{24}$/);

    await filing.add(mailId, inbox.folderId);
    expect(await filing.foldersOf(mailId)).toEqual(["inbox"]);

    await filing.move(mailId, { from: "inbox", to: projA.folderId });
    expect(await filing.foldersOf(mailId)).toEqual([projA.folderId]);

    await filing.add(mailId, ["inbox", projA.folderId]);
    expect((await filing.foldersOf(mailId)).sort()).toEqual(["inbox", projA.folderId].sort());

    const contents: FilingEntry[] = [];
    for await (const entry of filing.contents("inbox")) {
      contents.push(entry);
    }
    expect(contents.map((e) => e.ref)).toEqual([mailId]);
    expect(contents[0].filedAt).toBeGreaterThan(0);

    await filing.remove(mailId, "inbox");
    expect(await filing.foldersOf(mailId)).toEqual([projA.folderId]);
    await filing.remove(mailId);
    expect(await filing.foldersOf(mailId)).toEqual([]);

    const after = await db.getDocument(mailId);
    expect(JSON.stringify(after.getData())).toBe(headsBefore);
    expect(after.getLastModified()).toBe(modifiedBefore);
  }, 30000);

  it("uses one deterministic, opaque sidecar per document and store", async () => {
    const mailId = await createDoc(db, { type: "message" });
    const filing = db.filing!("mail");
    await filing.add(mailId, "a");
    await filing.add(mailId, "b");
    await filing.move(mailId, { from: "a", to: "c" });
    const ids = (await db.getAllDocumentIds()).filter((id) => id.startsWith("fil_"));
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^fil_[0-9a-f]{16}_r[0-9a-f]{32}$/);
    // The sidecar id does not contain the target id in clear text.
    expect(ids[0]).not.toContain(mailId);
    const sidecar = await db.getDocument(ids[0]);
    expect(sidecar.getData()).toMatchObject({ type: "$filing", store: "mail", ref: mailId });
    expect(Object.keys(sidecar.getData()).filter((k) => k.startsWith("f:")).sort()).toEqual(["f:b", "f:c"]);

    // Another store gets its own sidecar and prefix.
    await db.filing!("crm").add(mailId, "x");
    const all = (await db.getAllDocumentIds()).filter((id) => id.startsWith("fil_"));
    expect(all).toHaveLength(2);
    expect(all[0].slice(0, 20)).not.toBe(all[1].slice(0, 20));
  }, 30000);

  it("manages folder definitions and hides deleted folders", async () => {
    const filing = db.filing!("mail");
    const a = await filing.createFolder({ name: "A" });
    const b = await filing.createFolder({ name: "B", parentId: a.folderId, design: "mailfolder" });
    const doc1 = await createDoc(db, { n: 1 });
    const doc2 = await createDoc(db, { n: 2 });
    await filing.add(doc1, [a.folderId, b.folderId]);
    await filing.add(doc2, b.folderId);

    await filing.renameFolder(a.folderId, "A renamed");
    expect((await filing.getFolder(a.folderId))?.name).toBe("A renamed");
    expect((await filing.listFolders()).map((f) => f.name).sort()).toEqual(["A renamed", "B"]);
    expect(await filing.getFolder(b.folderId)).toMatchObject({ parentId: a.folderId, design: "mailfolder" });

    // keepFiling: sidecar keys stay but the deleted folder is hidden.
    await filing.deleteFolder(b.folderId, { keepFiling: true });
    expect(await filing.getFolder(b.folderId)).toBeNull();
    expect(await filing.foldersOf(doc1)).toEqual([a.folderId]);
    expect(await filing.foldersOf(doc2)).toEqual([]);
    expect(await filing.count(b.folderId)).toBe(0);

    // Re-creating the folder with the same id brings the filing back.
    await filing.createFolder({ name: "B again", folderId: b.folderId });
    expect(await filing.foldersOf(doc2)).toEqual([b.folderId]);

    // Default delete also cleans the sidecars.
    await filing.deleteFolder(b.folderId);
    await filing.createFolder({ name: "B third", folderId: b.folderId });
    expect(await filing.foldersOf(doc2)).toEqual([]);
  }, 30000);

  it("files documents of other databases and tenants by reference", async () => {
    const filing = db.filing!("mail");
    await filing.add("mdbref:/crm/doc_x", "f1");
    await filing.add({ tenantId: "other", dbId: "crm", docId: "doc_y" }, "f1");
    const refs: string[] = [];
    for await (const entry of filing.contents("f1")) {
      refs.push(entry.ref);
    }
    expect(refs.sort()).toEqual(["mdbref:/crm/doc_x", "mdbref://other/crm/doc_y"].sort());
    expect(await filing.foldersOf({ dbId: "crm", docId: "doc_x" })).toEqual(["f1"]);
  }, 30000);

  it("rejects folder ids that would break category paths", async () => {
    const filing = db.filing!("mail");
    await expect(filing.add("doc", "a\\b")).rejects.toThrow(/Invalid folder id/);
    await expect(filing.add("doc", "")).rejects.toThrow(/Invalid folder id/);
  }, 30000);
});
