import { mkdtempSync } from "fs";
import { rm, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";
import { StoreEntry } from "../core/types";

describe.each([true, false])(
  "BasicOnDiskContentAddressedStore (indexingEnabled=%s)",
  (indexingEnabled) => {
    let basePath: string;

    beforeEach(() => {
      basePath = mkdtempSync(join(tmpdir(), "mindoodb-ondisk-store-"));
    });

    afterEach(async () => {
      await rm(basePath, { recursive: true, force: true });
    });

    test("persists entries across restart", async () => {
      const store1 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
        metadataSegmentCompactionMinFiles: 8,
      });
      await store1.putEntries([createTestEntry("doc1", "id1", "content1")]);

      const store2 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });

      const ids = await store2.getAllIds();
      expect(ids).toContain("id1");
      const entries = await store2.getEntries(["id1"]);
      expect(entries.length).toBe(1);
      expect(entries[0].docId).toBe("doc1");
    });

    test("clearLocalDataOnStartup starts with empty store", async () => {
      const store1 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      await store1.putEntries([
        createTestEntry("doc1", "id1", "content1"),
        createTestEntry("doc1", "id2", "content2"),
      ]);

      const beforeReset = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      expect((await beforeReset.getAllIds()).length).toBe(2);

      const resetStore = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
        clearLocalDataOnStartup: true,
      });

      const afterResetIds = await resetStore.getAllIds();
      expect(afterResetIds).toEqual([]);
      expect(await resetStore.getEntries(["id1", "id2"])).toEqual([]);
    });

    test("explicit clearAllLocalData wipes existing data", async () => {
      const store = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });

      await store.putEntries([
        createTestEntry("doc1", "id1", "content1"),
        createTestEntry("doc2", "id2", "content2"),
      ]);
      expect((await store.getAllIds()).length).toBe(2);

      await store.clearAllLocalData();
      expect(await store.getAllIds()).toEqual([]);
    });

    test("supports cursor scan pagination", async () => {
      const now = Date.now();
      const e1 = createTestEntry("doc1", "id1", "c1");
      const e2 = createTestEntry("doc1", "id2", "c2");
      const e3 = createTestEntry("doc2", "id3", "c3");
      e1.createdAt = now;
      e2.createdAt = now + 1;
      e3.createdAt = now + 2;

      const store = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      await store.putEntries([e1, e2, e3]);

      const page1 = await store.scanEntriesSince!(null, 2);
      expect(page1.entries.map((e) => e.id)).toEqual(["id1", "id2"]);
      expect(page1.hasMore).toBe(true);

      const page2 = await store.scanEntriesSince!(page1.nextCursor, 10);
      expect(page2.entries.map((e) => e.id)).toEqual(["id3"]);
      expect(page2.hasMore).toBe(false);
    });

    test("scan pagination remains correct after restart and append", async () => {
      const now = Date.now();
      const e1 = createTestEntry("doc1", "id1", "c1");
      const e2 = createTestEntry("doc1", "id2", "c2");
      e1.createdAt = now;
      e2.createdAt = now + 1;

      const store1 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      await store1.putEntries([e1, e2]);

      const page1 = await store1.scanEntriesSince!(null, 1);
      expect(page1.entries.map((e) => e.id)).toEqual(["id1"]);
      expect(page1.hasMore).toBe(true);

      const store2 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      const e3 = createTestEntry("doc1", "id3", "c3");
      e3.createdAt = now + 2;
      await store2.putEntries([e3]);

      const page2 = await store2.scanEntriesSince!(page1.nextCursor, 10);
      expect(page2.entries.map((e) => e.id)).toEqual(["id2", "id3"]);
      expect(page2.hasMore).toBe(false);
    });

    test("scan pagination remains correct after purge", async () => {
      const now = Date.now();
      const e1 = createTestEntry("docA", "id1", "c1");
      const e2 = createTestEntry("docB", "id2", "c2");
      const e3 = createTestEntry("docA", "id3", "c3");
      e1.createdAt = now;
      e2.createdAt = now + 1;
      e3.createdAt = now + 2;

      const store = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      await store.putEntries([e1, e2, e3]);
      await store.purgeDocHistory("docA");

      const page = await store.scanEntriesSince!(null, 10);
      expect(page.entries.map((e) => e.id)).toEqual(["id2"]);
      expect(page.hasMore).toBe(false);
    });

    test("rebuilds index on restart when metadata segment is stale", async () => {
      if (!indexingEnabled) {
        return;
      }

      const now = Date.now();
      const e1 = createTestEntry("docA", "id1", "c1");
      const e2 = createTestEntry("docB", "id2", "c2");
      const e3 = createTestEntry("docA", "id3", "c3");
      e1.createdAt = now;
      e2.createdAt = now + 1;
      e3.createdAt = now + 2;

      const store1 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      await store1.putEntries([e1, e2, e3]);

      // Simulate crash-stale index segment: drop one row from the latest segment.
      const segmentsDir = join(basePath, "test-db", "metadata-segments");
      const segmentFiles = (await readdir(segmentsDir))
        .filter((fileName) => fileName.endsWith(".json"))
        .sort();
      expect(segmentFiles.length).toBeGreaterThan(0);
      const latestSegmentPath = join(segmentsDir, segmentFiles[segmentFiles.length - 1]);
      const raw = await readFile(latestSegmentPath, "utf-8");
      const persisted = JSON.parse(raw) as unknown[];
      const stale = persisted.slice(0, 2);
      await writeFile(latestSegmentPath, JSON.stringify(stale), "utf-8");

      const store2 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });

      const ids = await store2.getAllIds();
      expect(ids).toEqual(["id1", "id2", "id3"]);
    });

    test("compacts metadata segments and keeps restart correctness", async () => {
      if (!indexingEnabled) {
        return;
      }

      const now = Date.now();
      const store1 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });

      const totalEntries = 40;
      for (let i = 0; i < totalEntries; i++) {
        const entry = createTestEntry("docA", `id-${i}`, `content-${i}`);
        entry.createdAt = now + i;
        await store1.putEntries([entry]);
      }

      const segmentsDir = join(basePath, "test-db", "metadata-segments");
      const segmentFiles = (await readdir(segmentsDir)).filter((fileName) =>
        fileName.endsWith(".json")
      );
      expect(segmentFiles.length).toBeLessThan(totalEntries);
      const compaction = await store1.getCompactionStatus?.();
      expect(compaction?.totalCompactions).toBeGreaterThan(0);
      expect(compaction?.lastCompactedFiles).toBeGreaterThan(0);
      expect(compaction?.lastCompactionAt).not.toBeNull();

      const store2 = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
      });
      const ids = await store2.getAllIds();
      expect(ids.length).toBe(totalEntries);
      expect(ids[0]).toBe("id-0");
      expect(ids[ids.length - 1]).toBe(`id-${totalEntries - 1}`);
    });

    test("can disable metadata segment compaction via option", async () => {
      if (!indexingEnabled) {
        return;
      }

      const now = Date.now();
      const store = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
        metadataSegmentCompactionMinFiles: 0,
      });

      const totalEntries = 12;
      for (let i = 0; i < totalEntries; i++) {
        const entry = createTestEntry("docA", `no-compact-id-${i}`, `no-compact-content-${i}`);
        entry.createdAt = now + i;
        await store.putEntries([entry]);
      }

      const segmentsDir = join(basePath, "test-db", "metadata-segments");
      const segmentFiles = (await readdir(segmentsDir)).filter((fileName) =>
        fileName.endsWith(".json")
      );
      expect(segmentFiles.length).toBe(totalEntries);
      const compaction = await store.getCompactionStatus?.();
      expect(compaction?.enabled).toBe(false);
      expect(compaction?.totalCompactions).toBe(0);
    });

    test("can compact metadata segments by max-bytes threshold", async () => {
      if (!indexingEnabled) {
        return;
      }

      const now = Date.now();
      const store = new BasicOnDiskContentAddressedStore("test-db", undefined, {
        basePath,
        indexingEnabled,
        metadataSegmentCompactionMinFiles: 10_000,
        metadataSegmentCompactionMaxBytes: 700,
      });

      const totalEntries = 8;
      for (let i = 0; i < totalEntries; i++) {
        const entry = createTestEntry("docA", `bytes-id-${i}`, `bytes-content-${i}`);
        entry.createdAt = now + i;
        await store.putEntries([entry]);
      }

      const segmentsDir = join(basePath, "test-db", "metadata-segments");
      const segmentFiles = (await readdir(segmentsDir)).filter((fileName) =>
        fileName.endsWith(".json")
      );
      expect(segmentFiles.length).toBeLessThan(totalEntries);
      const compaction = await store.getCompactionStatus?.();
      expect(compaction?.totalCompactions).toBeGreaterThan(0);
      expect(compaction?.lastCompactedBytes).toBeGreaterThan(0);
    });
  }
);

function createTestEntry(
  docId: string,
  id: string,
  contentHash: string
): StoreEntry {
  const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
  return {
    entryType: "doc_change",
    id,
    contentHash,
    docId,
    dependencyIds: [],
    createdAt: Date.now(),
    createdByPublicKey: "test-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: 4,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}
