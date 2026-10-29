import * as Automerge from "@automerge/automerge";
import {
  CHANGE_ATTRIBUTION_MESSAGE_KEY,
  decodeChangeAttribution,
  encodeChangeAttribution,
  type ChangeAttribution,
  type ChangeAttributionInput,
} from "../core/changeAttribution";
import type { DocumentHistoryResult, MindooDB } from "../core/types";
import { createCopyTestTenant, docEntries, type CopyTestTenant } from "./_helpers/copyTestHarness";

const agent: ChangeAttributionInput = {
  kind: "agent",
  via: "haven-assistant",
  app: "todos",
  tool: "todo_create",
  model: "claude-test",
  runId: "run-1",
  confirmed: true,
};

const expected: ChangeAttribution = { v: 1, ...agent } as ChangeAttribution;

async function history(db: MindooDB, docId: string): Promise<DocumentHistoryResult[]> {
  const result: DocumentHistoryResult[] = [];
  for await (const entry of db.iterateDocumentHistory(docId)) result.push(entry);
  return result;
}

describe("change attribution format", () => {
  it("round-trips through the change message", () => {
    const message = encodeChangeAttribution(agent)!;
    expect(JSON.parse(message)).toEqual({ [CHANGE_ATTRIBUTION_MESSAGE_KEY]: expected });
    expect(decodeChangeAttribution(message)).toEqual(expected);
  });

  it("writes nothing for an absent attribution", () => {
    expect(encodeChangeAttribution(undefined)).toBeUndefined();
    expect(encodeChangeAttribution(null)).toBeUndefined();
  });

  it("rejects a malformed attribution instead of writing an unattributed change", () => {
    expect(() => encodeChangeAttribution({ kind: "agent", via: "  " })).toThrow(/Invalid change attribution/);
    expect(() =>
      encodeChangeAttribution({ kind: "robot", via: "mcp" } as unknown as ChangeAttributionInput),
    ).toThrow(/Invalid change attribution/);
  });

  it("trims labels, caps their length and drops empty ones", () => {
    const decoded = decodeChangeAttribution(
      encodeChangeAttribution({ kind: "agent", via: " mcp ", tool: "x".repeat(500), model: "", confirmed: false }),
    );
    expect(decoded).toEqual({ v: 1, kind: "agent", via: "mcp", tool: "x".repeat(128) });
  });

  it("ignores foreign, broken and oversized messages", () => {
    expect(decodeChangeAttribution(null)).toBeUndefined();
    expect(decodeChangeAttribution("")).toBeUndefined();
    expect(decodeChangeAttribution("Fix typo")).toBeUndefined();
    expect(decodeChangeAttribution('{"mindoo.attribution": ')).toBeUndefined();
    expect(decodeChangeAttribution('{"author":"someone"}')).toBeUndefined();
    expect(decodeChangeAttribution('["mindoo.attribution"]')).toBeUndefined();
    expect(decodeChangeAttribution('{"mindoo.attribution":{"kind":"human","via":"x"}}')).toBeUndefined();
    expect(
      decodeChangeAttribution(
        JSON.stringify({ [CHANGE_ATTRIBUTION_MESSAGE_KEY]: { kind: "agent", via: "mcp", pad: "x".repeat(2000) } }),
      ),
    ).toBeUndefined();
  });

  it("reads unknown fields and newer versions tolerantly", () => {
    const decoded = decodeChangeAttribution(
      JSON.stringify({
        other: 1,
        [CHANGE_ATTRIBUTION_MESSAGE_KEY]: { v: 2, kind: "agent", via: "webmcp", future: { a: 1 }, confirmed: "yes" },
      }),
    );
    expect(decoded).toEqual({ v: 2, kind: "agent", via: "webmcp" });
  });
});

describe("change attribution in MindooDB", () => {
  let alpha: CopyTestTenant;
  let db: MindooDB;

  beforeEach(async () => {
    alpha = await createCopyTestTenant("attribution-tenant", []);
    db = await alpha.openDB("attribution-db");
  }, 60000);

  afterEach(async () => {
    await alpha.dispose();
  });

  it("marks doc_create, doc_change, doc_delete and doc_undelete entries", async () => {
    const doc = await db.createDocument({ initialValues: { title: "A" }, attribution: agent });
    await db.changeDoc(doc, (d) => {
      d.getData().title = "B";
    }, { attribution: { kind: "agent", via: "webmcp", app: "todos", tool: "todo_rename" } });
    await db.deleteDocument(doc.getId(), { attribution: agent });
    await db.undeleteDocument(doc.getId(), { attribution: { kind: "agent", via: "mcp" } });

    const entries = await history(db, doc.getId());
    expect(entries.map((entry) => entry.attribution)).toEqual([
      expected,
      { v: 1, kind: "agent", via: "webmcp", app: "todos", tool: "todo_rename" },
      expected,
      { v: 1, kind: "agent", via: "mcp" },
    ]);
    // never in the plaintext metadata
    for (const entry of await docEntries(db, doc.getId())) {
      expect(JSON.stringify(entry)).not.toContain("haven-assistant");
      expect(JSON.stringify(entry)).not.toContain("todo_create");
    }
  }, 30000);

  it("leaves ordinary changes unmarked", async () => {
    const doc = await db.createDocument({ initialValues: { title: "A" } });
    await db.changeDoc(doc, (d) => {
      d.getData().title = "user";
    });
    await db.changeDoc(doc, (d) => {
      d.getData().title = "agent";
    }, { attribution: agent });
    await db.changeDoc(doc, (d) => {
      d.getData().title = "user again";
    });

    const entries = await history(db, doc.getId());
    expect(entries.map((entry) => entry.attribution)).toEqual([undefined, undefined, expected, undefined]);
    expect(entries.every((entry) => !("attribution" in entry) || entry.attribution)).toBe(true);
  }, 30000);

  it("marks the patch methods, also when they rebase onto older heads", async () => {
    const doc = await db.createDocument({ initialValues: { title: "Hello", body: "" } });
    const firstHeads = (await db.getDocument(doc.getId())).getHeads();
    await db.applyDocumentUpdate(doc, { set: { title: "Update" } }, { attribution: agent });
    await db.applyJsonPatch(doc, { set: [{ path: ["n"], value: 1 }] }, { attribution: agent });
    await db.applyTextPatch(
      doc,
      { path: ["title"], baseHeads: firstHeads, edits: [{ index: 0, deleteCount: 0, insert: ">" }] },
      { attribution: agent },
    );
    await db.applyRichTextPatch(
      doc,
      { path: ["body"], baseHeads: firstHeads, spans: [{ type: "text", value: "rich" }] },
      { attribution: agent },
    );
    await db.applyDocumentUpdate(
      doc,
      { text: [{ path: ["title"], baseHeads: firstHeads, edits: [{ index: 0, deleteCount: 0, insert: "#" }] }] },
      { attribution: agent },
    );
    await db.applyDocumentUpdate(doc, { set: { plain: true } });

    const entries = await history(db, doc.getId());
    expect(entries.map((entry) => entry.attribution)).toEqual([
      undefined,
      expected,
      expected,
      expected,
      expected,
      expected,
      undefined,
    ]);
  }, 30000);

  it("rejects a malformed attribution before anything is written", async () => {
    const bad = { kind: "agent", via: "" } as ChangeAttributionInput;
    await expect(db.createDocument({ attribution: bad })).rejects.toThrow(/Invalid change attribution/);
    const doc = await db.createDocument();
    const before = (await docEntries(db, doc.getId())).length;
    await expect(db.applyDocumentUpdate(doc, { set: { a: 1 } }, { attribution: bad })).rejects.toThrow();
    await expect(db.deleteDocument(doc.getId(), { attribution: bad })).rejects.toThrow();
    await expect(db.deleteDocuments([doc.getId()], { attribution: bad })).rejects.toThrow();
    await expect(db.createDocuments([{}, { attribution: bad }])).rejects.toThrow();
    expect((await docEntries(db, doc.getId())).length).toBe(before);
    expect((await db.getDocument(doc.getId())).isDeleted()).toBe(false);
  }, 30000);

  it("marks bulk creates and deletes", async () => {
    const [generated, custom] = await db.createDocuments([
      { initialValues: { n: 1 }, attribution: agent },
      { id: "fixed_settings", initialValues: { n: 2 }, attribution: agent },
    ]);
    // A convergent custom id starts with fixed seed bytes; the values change carries the mark.
    expect((await history(db, generated.getId())).map((e) => e.attribution)).toEqual([expected]);
    expect((await history(db, custom.getId())).map((e) => e.attribution)).toEqual([undefined, expected]);

    await db.deleteDocuments([generated.getId(), custom.getId()], { attribution: agent });
    expect((await history(db, generated.getId())).map((e) => e.attribution)).toEqual([expected, expected]);
    expect((await history(db, custom.getId())).at(-1)?.attribution).toEqual(expected);
  }, 30000);

  it("marks the undelete of an idempotent custom-id create", async () => {
    const doc = await db.createDocument({ id: "settings_main" });
    await db.deleteDocument(doc.getId());
    await db.createDocument({ id: "settings_main", attribution: agent });
    const entries = await history(db, doc.getId());
    expect(entries.map((entry) => entry.attribution)).toEqual([undefined, undefined, expected]);
  }, 30000);

  it("reports the attribution on history pages only when asked", async () => {
    const doc = await db.createDocument({ attribution: agent });
    await db.changeDoc(doc, (d) => {
      d.getData().x = 1;
    });

    const plain = await db.getDocumentHistoryPage(doc.getId());
    expect(plain.entries.map((entry) => entry.attribution)).toEqual([undefined, undefined]);

    const detailed = await db.getDocumentHistoryPage(doc.getId(), { includeAttribution: true });
    expect(detailed.entries.map((entry) => entry.attribution)).toEqual([expected, undefined]);

    const details = await db.describeDocumentDagEntry(doc.getId(), detailed.entries[0].entryId);
    expect(details?.decodedChange?.attribution).toEqual(expected);
  }, 30000);

  it("survives snapshots", async () => {
    const snapDb = await alpha.openDB("attribution-snapshots", {
      snapshotConfig: { minChanges: 1, cooldownMs: 0 },
    });
    const doc = await snapDb.createDocument({ initialValues: { n: 0 }, attribution: agent });
    for (let i = 1; i <= 3; i++) {
      await snapDb.changeDoc(doc, (d) => {
        d.getData().n = i;
      }, i === 2 ? { attribution: agent } : {});
    }
    const entries = await docEntries(snapDb, doc.getId());
    const snapshot = entries.find((entry) => entry.entryType === "doc_snapshot");
    expect(snapshot).toBeDefined();

    // The snapshot keeps the Automerge change history, messages included.
    const [full] = await snapDb.getStore().getEntries([snapshot!.id]);
    const saved = await alpha.tenant.decryptPayload(full.encryptedData, full.decryptionKeyId);
    const messages = Automerge.getAllChanges(Automerge.load(saved)).map(
      (change) => decodeChangeAttribution(Automerge.decodeChange(change).message)?.via,
    );
    expect(messages).toContain("haven-assistant");

    const reopened = await alpha.openDB("attribution-snapshots");
    expect((await history(reopened, doc.getId())).map((e) => e.attribution)).toEqual([
      expected,
      undefined,
      expected,
      undefined,
    ]);
  }, 30000);

  it("is carried along by history copies, not by flatten copies", async () => {
    const target = await alpha.openDB("attribution-target");
    const doc = await db.createDocument({ initialValues: { a: 1 }, attribution: agent });
    await db.changeDoc(doc, (d) => {
      d.getData().a = 2;
    });

    const grafted = await db.copyDocumentTo(doc.getId(), target, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });
    expect((await history(target, grafted.targetDocId)).map((e) => e.attribution)).toEqual([expected, undefined]);

    const reauthored = await db.copyDocumentTo(doc.getId(), target, { mode: "history", targetDocId: "new" });
    expect((await history(target, reauthored.targetDocId)).map((e) => e.attribution)).toEqual([
      expected,
      undefined,
    ]);

    // A flatten copy is a new document written by the copying user.
    const flat = await db.copyDocumentTo(doc.getId(), target);
    expect((await history(target, flat.targetDocId)).map((e) => e.attribution)).toEqual([undefined]);
  }, 60000);

  it("reads whatever message raw Automerge changes carry", async () => {
    const doc = await db.createDocument({ initialValues: { a: "x" } });
    const snapshot = await db.exportAutomergeSnapshot(doc);
    let replica = Automerge.load<{ a: string; b?: number }>(snapshot.binary);
    replica = Automerge.change(replica, "a plain commit message", (draft) => {
      draft.a = "y";
    });
    replica = Automerge.change(replica, encodeChangeAttribution({ kind: "agent", via: "webmcp" })!, (draft) => {
      draft.b = 1;
    });
    await db.applyAutomergeChanges(doc, {
      baseHeads: snapshot.heads,
      changes: Automerge.getChangesSince(replica, snapshot.heads as Automerge.Heads),
    });

    const entries = await history(db, doc.getId());
    expect(entries.map((entry) => entry.attribution)).toEqual([
      undefined,
      undefined,
      { v: 1, kind: "agent", via: "webmcp" },
    ]);
  }, 30000);
});
