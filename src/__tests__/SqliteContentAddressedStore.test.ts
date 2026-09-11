import {
  SqliteContentAddressedStore,
  SqliteContentAddressedStoreFactory,
} from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { createMemorySqliteBackend } from "../core/appendonlystores/sqlite/SqliteDriver";
import { StoreEntry } from "../core/types";
import { StoreKind } from "../core/appendonlystores/types";

function createTestEntry(
  docId: string,
  id: string,
  contentHash: string,
  dependencyIds: string[] = [],
  entryType: "doc_create" | "doc_change" | "doc_snapshot" | "doc_delete" | "attachment_chunk" = "doc_change",
): StoreEntry {
  const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
  return {
    entryType,
    id,
    contentHash,
    docId,
    dependencyIds,
    createdAt: Date.now(),
    createdByPublicKey: "test-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: 4,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}

describe("SqliteContentAddressedStore", () => {
  let store: SqliteContentAddressedStore;

  beforeEach(() => {
    store = new SqliteContentAddressedStore("test-db", StoreKind.docs, createMemorySqliteBackend());
  });

  test("stores and retrieves entries by id", async () => {
    const entry = createTestEntry("doc1", "id1", "content1");
    await store.putEntries([entry]);
    const retrieved = await store.getEntries(["id1"]);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe("id1");
    expect(retrieved[0].encryptedData).toEqual(entry.encryptedData);
  });

  test("persists ten document entries across reopen", async () => {
    const backend = createMemorySqliteBackend();
    const first = new SqliteContentAddressedStore("ten-docs", StoreKind.docs, backend);
    const entries = Array.from({ length: 10 }, (_, index) =>
      createTestEntry(`doc-${index}`, `id-${index}`, `content-${index}`),
    );
    await first.putEntries(entries);
    const second = new SqliteContentAddressedStore("ten-docs", StoreKind.docs, backend);
    const retrieved = await second.getEntries(entries.map((entry) => entry.id));
    expect(retrieved).toHaveLength(10);
    expect(retrieved.map((entry) => entry.docId)).toEqual(entries.map((entry) => entry.docId));
  });

  test("survives reopen on the same backend", async () => {
    const backend = createMemorySqliteBackend();
    const first = new SqliteContentAddressedStore("persist-db", StoreKind.docs, backend);
    await first.putEntries([createTestEntry("doc1", "id1", "content1")]);
    const second = new SqliteContentAddressedStore("persist-db", StoreKind.docs, backend);
    const retrieved = await second.getEntries(["id1"]);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].docId).toBe("doc1");
  });

  test("deduplicates content by hash", async () => {
    await store.putEntries([
      createTestEntry("doc1", "id1", "same-hash"),
      createTestEntry("doc2", "id2", "same-hash"),
    ]);
    const stats = await store.getStats();
    expect(stats.entryCount).toBe(2);
    expect(stats.contentCount).toBe(1);
  });

  test("scanEntriesSince and store head", async () => {
    await store.putEntries([
      createTestEntry("doc1", "id1", "c1"),
      createTestEntry("doc1", "id2", "c2"),
    ]);
    const head = await store.getStoreHead();
    expect(head.maxReceiptOrder).toBe(2);
    const page = await store.scanEntriesSince(null, 1);
    expect(page.entries).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const rest = await store.scanEntriesSince(page.nextCursor, 10);
    expect(rest.entries).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
  });

  test("applyWitnessReceipts reorders the scan cursor", async () => {
    const entry = createTestEntry("doc1", "id1", "c1");
    await store.putEntries([entry]);
    await store.applyWitnessReceipts([
      { ...(await store.getEntryMetadata("id1"))!, receivedAt: 99, receivedByPublicKey: "server" },
    ]);
    const meta = await store.getEntryMetadata("id1");
    expect(meta?.receivedAt).toBe(99);
    expect(meta?.receiptOrder).toBeGreaterThan(1);
  });

  test("factory creates isolated doc and attachment stores", async () => {
    const factory = new SqliteContentAddressedStoreFactory();
    const { docStore, attachmentStore } = factory.createStore("db-a");
    await docStore.putEntries([createTestEntry("doc1", "id1", "c1")]);
    expect(await attachmentStore.getAllIds()).toEqual([]);
    expect(await docStore.getAllIds()).toEqual(["id1"]);
  });

  test("materialization planning matches in-memory store", async () => {
    const a = createTestEntry("doc1", "a", "ca", [], "doc_create");
    const b = createTestEntry("doc1", "b", "cb", ["a"], "doc_change");
    const c = createTestEntry("doc1", "c", "cc", ["a"], "doc_change");
    const d = createTestEntry("doc1", "d", "cd", ["b", "c"], "doc_change");
    const s = createTestEntry("doc1", "s", "cs", ["b"], "doc_snapshot");
    s.snapshotHeadEntryIds = ["b"];
    s.snapshotHeadHashes = ["hb"];
    await store.putEntries([a, b, c, d, s]);
    const plan = await store.planDocumentMaterialization("doc1", { includeDiagnostics: true });
    expect(plan.snapshotEntryId).toBe("s");
    expect(plan.entryIdsToApply).toEqual(["c", "d"]);
  });
});
