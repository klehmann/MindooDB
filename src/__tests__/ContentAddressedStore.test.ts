import { InMemoryContentAddressedStore, InMemoryContentAddressedStoreFactory } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreEntry, StoreEntryMetadata } from "../core/types";
import { bloomMightContainId } from "../core/appendonlystores/bloom";

describe("InMemoryContentAddressedStore", () => {
  let store: InMemoryContentAddressedStore;

  beforeEach(() => {
    store = new InMemoryContentAddressedStore("test-db");
  });

  describe("basic operations", () => {
    test("should store and retrieve entries by id", async () => {
      const entry = createTestEntry("doc1", "id1", "content1");
      await store.putEntries([entry]);
      
      const retrieved = await store.getEntries(["id1"]);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0].id).toBe("id1");
      expect(retrieved[0].docId).toBe("doc1");
      expect(retrieved[0].encryptedData).toEqual(entry.encryptedData);
    });

    test("should return empty array for non-existent ids", async () => {
      const retrieved = await store.getEntries(["non-existent"]);
      expect(retrieved.length).toBe(0);
    });

    test("should check which ids exist with hasEntries", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc1", "id2", "content2");
      await store.putEntries([entry1, entry2]);
      
      const existing = await store.hasEntries(["id1", "id2", "id3"]);
      expect(existing.length).toBe(2);
      expect(existing).toContain("id1");
      expect(existing).toContain("id2");
      expect(existing).not.toContain("id3");
    });

    test("should get all entry ids", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc2", "id2", "content2");
      await store.putEntries([entry1, entry2]);
      
      const allIds = await store.getAllIds();
      expect(allIds.length).toBe(2);
      expect(allIds).toContain("id1");
      expect(allIds).toContain("id2");
    });
  });

  describe("content deduplication", () => {
    test("should deduplicate entries with same contentHash", async () => {
      // Two entries with same contentHash but different ids
      const entry1 = createTestEntry("doc1", "id1", "same-content-hash");
      const entry2 = createTestEntry("doc2", "id2", "same-content-hash");
      
      await store.putEntries([entry1, entry2]);
      
      // Both entries should be retrievable
      const retrieved1 = await store.getEntries(["id1"]);
      const retrieved2 = await store.getEntries(["id2"]);
      
      expect(retrieved1.length).toBe(1);
      expect(retrieved2.length).toBe(1);
      expect(retrieved1[0].id).toBe("id1");
      expect(retrieved2[0].id).toBe("id2");
      
      // They should have different docIds
      expect(retrieved1[0].docId).toBe("doc1");
      expect(retrieved2[0].docId).toBe("doc2");
      
      // But same content
      expect(retrieved1[0].encryptedData).toEqual(retrieved2[0].encryptedData);
      
      // Verify deduplication via stats
      const stats = store.getStats();
      expect(stats.entryCount).toBe(2); // Two metadata entries
      expect(stats.contentCount).toBe(1); // Only one content blob
    });

    test("should not overwrite entry with same id", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc1", "id1", "content2"); // Same id, different content
      
      await store.putEntries([entry1]);
      await store.putEntries([entry2]); // Should be a no-op
      
      const retrieved = await store.getEntries(["id1"]);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0].contentHash).toBe("content1"); // Original content
    });

    test("should handle entries with different contentHash independently", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc1", "id2", "content2");
      
      await store.putEntries([entry1, entry2]);
      
      const stats = store.getStats();
      expect(stats.entryCount).toBe(2);
      expect(stats.contentCount).toBe(2); // Two different content blobs
    });
  });

  describe("document-scoped queries", () => {
    test("should find new entries for specific document", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc1", "id2", "content2");
      const entry3 = createTestEntry("doc2", "id3", "content3");
      await store.putEntries([entry1, entry2, entry3]);
      
      // Find new entries for doc1, already knowing id1
      const newForDoc1 = await store.findNewEntriesForDoc(["id1"], "doc1");
      expect(newForDoc1.length).toBe(1);
      expect(newForDoc1[0].id).toBe("id2");
      
      // Find new entries for doc2, knowing nothing
      const newForDoc2 = await store.findNewEntriesForDoc([], "doc2");
      expect(newForDoc2.length).toBe(1);
      expect(newForDoc2[0].id).toBe("id3");
    });

    test("should find all new entries across documents", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc2", "id2", "content2");
      await store.putEntries([entry1, entry2]);
      
      // Find all new entries, knowing id1
      const newEntries = await store.findNewEntries(["id1"]);
      expect(newEntries.length).toBe(1);
      expect(newEntries[0].id).toBe("id2");
    });
  });

  describe("cursor-based scan", () => {
    test("should scan entries in stable order with cursor pagination", async () => {
      const now = Date.now();
      const entry1 = createTestEntry("doc1", "id1", "c1");
      const entry2 = createTestEntry("doc1", "id2", "c2");
      const entry3 = createTestEntry("doc2", "id3", "c3");
      entry1.createdAt = now;
      entry2.createdAt = now + 1;
      entry3.createdAt = now + 2;
      await store.putEntries([entry1, entry2, entry3]);

      const page1 = await store.scanEntriesSince!(null, 2);
      expect(page1.entries.map((e) => e.id)).toEqual(["id1", "id2"]);
      expect(page1.hasMore).toBe(true);

      const page2 = await store.scanEntriesSince!(page1.nextCursor, 2);
      expect(page2.entries.map((e) => e.id)).toEqual(["id3"]);
      expect(page2.hasMore).toBe(false);
    });

    test("should support doc filter in cursor scan", async () => {
      await store.putEntries([
        createTestEntry("docA", "id1", "c1"),
        createTestEntry("docB", "id2", "c2"),
        createTestEntry("docA", "id3", "c3"),
      ]);

      const scanned = await store.scanEntriesSince!(null, 100, { docId: "docA" });
      expect(scanned.entries.length).toBe(2);
      expect(scanned.entries.every((e) => e.docId === "docA")).toBe(true);
    });
  });

  describe("bloom summary", () => {
    test("should include known IDs in bloom summary", async () => {
      await store.putEntries([
        createTestEntry("doc1", "id1", "c1"),
        createTestEntry("doc2", "id2", "c2"),
      ]);

      const summary = await store.getIdBloomSummary!();
      expect(summary.version).toBe("bloom-v1");
      expect(summary.totalIds).toBe(2);
      expect(bloomMightContainId(summary, "id1")).toBe(true);
      expect(bloomMightContainId(summary, "id2")).toBe(true);
    });
  });

  describe("purgeDocHistory", () => {
    test("should remove all entries for a document", async () => {
      const entry1 = createTestEntry("doc1", "id1", "content1");
      const entry2 = createTestEntry("doc1", "id2", "content2");
      const entry3 = createTestEntry("doc2", "id3", "content3");
      await store.putEntries([entry1, entry2, entry3]);
      
      await store.purgeDocHistory("doc1");
      
      // doc1 entries should be gone
      const doc1Entries = await store.getEntries(["id1", "id2"]);
      expect(doc1Entries.length).toBe(0);
      
      // doc2 entries should remain
      const doc2Entries = await store.getEntries(["id3"]);
      expect(doc2Entries.length).toBe(1);
    });

    test("should clean up orphaned content after purge", async () => {
      const entry1 = createTestEntry("doc1", "id1", "unique-content");
      const entry2 = createTestEntry("doc2", "id2", "shared-content");
      const entry3 = createTestEntry("doc1", "id3", "shared-content"); // Same content as doc2
      await store.putEntries([entry1, entry2, entry3]);
      
      // Before purge: 3 entries, 2 content blobs (unique + shared)
      expect(store.getStats().entryCount).toBe(3);
      expect(store.getStats().contentCount).toBe(2);
      
      await store.purgeDocHistory("doc1");
      
      // After purge: 1 entry, 1 content blob (unique-content is orphaned and cleaned up)
      expect(store.getStats().entryCount).toBe(1);
      expect(store.getStats().contentCount).toBe(1); // shared-content still has a reference
    });
  });

  describe("dependency resolution", () => {
    test("should resolve dependency chain", async () => {
      const entry1 = createTestEntry("doc1", "id1", "c1", []);
      const entry2 = createTestEntry("doc1", "id2", "c2", ["id1"]);
      const entry3 = createTestEntry("doc1", "id3", "c3", ["id2"]);
      await store.putEntries([entry1, entry2, entry3]);
      
      const deps = await store.resolveDependencies("id3");
      expect(deps).toEqual(["id1", "id2", "id3"]); // Oldest first
    });

    test("should stop at specified entry type", async () => {
      const entry1 = createTestEntry("doc1", "id1", "c1", [], "doc_create");
      const entry2 = createTestEntry("doc1", "id2", "c2", ["id1"], "doc_snapshot");
      const entry3 = createTestEntry("doc1", "id3", "c3", ["id2"], "doc_change");
      await store.putEntries([entry1, entry2, entry3]);
      
      const deps = await store.resolveDependencies("id3", { stopAtEntryType: "doc_snapshot" });
      expect(deps).toEqual(["id2", "id3"]); // Stops at snapshot, includes it
    });
  });
});

// Helper function to create test entries
function createTestEntry(
  docId: string,
  id: string,
  contentHash: string,
  dependencyIds: string[] = [],
  entryType: "doc_create" | "doc_change" | "doc_snapshot" | "doc_delete" | "attachment_chunk" = "doc_change"
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
    originalSize: 4, // Simulated original size
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}
