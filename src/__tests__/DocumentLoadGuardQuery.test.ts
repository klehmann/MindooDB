import { MindooValue } from "../core/values";
import { DocumentTooLargeError, setDocumentLoadBudget } from "../core/documentLoadGuard";
import { addPerson, makeTenant, syncAll, type DeviceHandle, type MultiDeviceFixture } from "./_helpers/multiDevice";

/**
 * A document above the load budget must not take its database's queries down:
 * the summary update materializes changed documents and used to stop at the
 * first error.
 */
describe("oversized document and queries", () => {
  jest.setTimeout(240000);
  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-oversized-query" });
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "pc");
    await syncAll(fixture, "directory");
  });

  afterEach(() => setDocumentLoadBudget(null));

  it("keeps the other documents queryable on a replica that cannot load the big one", async () => {
    const db = await alice.tenant.openDB("notes");
    await db.createDocument({ id: "small_1", assumeUniqueId: true, initialValues: { type: "note", n: "one" } });
    await db.createDocument({ id: "big_1", assumeUniqueId: true, initialValues: { type: "note", n: "big", body: MindooValue.text("x".repeat(200_000)) } });
    await db.createDocument({ id: "small_2", assumeUniqueId: true, initialValues: { type: "note", n: "two" } });
    await syncAll(fixture, "notes");

    setDocumentLoadBudget(20 * 1024 * 1024);
    const bobDb = await bob.tenant.openDB("notes");
    await bobDb.syncStoreChanges();
    const result = await bobDb.query({ filter: `v.eq(v.field("type"), v.string("note"))`, fields: ["n"], limit: 100 });
    const ids = result.rows.map((row) => row.docId).sort();
    expect(ids).toEqual(expect.arrayContaining(["small_1", "small_2"]));
    await expect(bobDb.getDocument("big_1")).rejects.toBeInstanceOf(DocumentTooLargeError);
    expect((await bobDb.getDocument("small_2")).getData().n).toBe("two");
  });
});
