import { mkdtempSync } from "fs";
import { access, readFile, readdir, rm, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";
import type { StoreEntry } from "../core/types";

const describeStress = process.env.MINDOODB_STRESS_TESTS === "1" ? describe : describe.skip;
const isSoak = process.env.MINDOODB_SOAK_TESTS === "1";

describeStress("BasicOnDiskContentAddressedStore stress matrix", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = mkdtempSync(join(tmpdir(), "mindoodb-ondisk-stress-"));
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  test(
    "high-volume append + restart + cursor scan remains consistent",
    async () => {
      const totalEntries = isSoak ? 8000 : 1500;
      const store = new BasicOnDiskContentAddressedStore("stress-db", undefined, {
        basePath,
        indexingEnabled: true,
        metadataSegmentCompactionMinFiles: 48,
        metadataSegmentCompactionMaxBytes: 128 * 1024,
      });

      const now = Date.now();
      for (let i = 0; i < totalEntries; i++) {
        const entry = createTestEntry("doc-stress", `hv-id-${i}`, `hv-content-${i}`, now + i);
        await store.putEntries([entry]);
      }
      const statusBeforeRestart = await store.getCompactionStatus!();

      const restarted = new BasicOnDiskContentAddressedStore("stress-db", undefined, {
        basePath,
        indexingEnabled: true,
      });

      let cursor: { createdAt: number; id: string } | null = null;
      let scanned = 0;
      do {
        const page = await restarted.scanEntriesSince!(cursor, 256);
        scanned += page.entries.length;
        cursor = page.nextCursor;
        if (!page.hasMore) {
          break;
        }
      } while (true);

      expect(scanned).toBe(totalEntries);
      expect(statusBeforeRestart.totalCompactions).toBeGreaterThan(0);
    },
    isSoak ? 180000 : 60000
  );

  test(
    "concurrent writer instances preserve visibility and completeness",
    async () => {
      const writers = 4;
      const entriesPerWriter = isSoak ? 800 : 200;
      const now = Date.now();

      const writerTasks: Array<Promise<void>> = [];
      for (let w = 0; w < writers; w++) {
        writerTasks.push(
          (async () => {
            const writer = new BasicOnDiskContentAddressedStore("stress-db", undefined, {
              basePath,
              indexingEnabled: true,
              metadataSegmentCompactionMinFiles: 32,
            });
            for (let i = 0; i < entriesPerWriter; i++) {
              const id = `cw-w${w}-id-${i}`;
              await writer.putEntries([
                createTestEntry(`doc-${w}`, id, `cw-content-${w}-${i}`, now + w * 100000 + i),
              ]);
            }
          })()
        );
      }

      await Promise.all(writerTasks);

      const verifier = new BasicOnDiskContentAddressedStore("stress-db", undefined, {
        basePath,
        indexingEnabled: true,
      });
      const allIds = await verifier.getAllIds();
      expect(allIds.length).toBe(writers * entriesPerWriter);
      expect(new Set(allIds).size).toBe(allIds.length);
    },
    isSoak ? 180000 : 60000
  );

  test(
    "fault-injection loop recovers from stale snapshots and stale segments",
    async () => {
      const rounds = isSoak ? 40 : 10;
      const entriesPerRound = isSoak ? 120 : 40;
      const dbRoot = join(basePath, "stress-db");
      const indexPath = join(dbRoot, "metadata-index.json");
      const segmentsDir = join(dbRoot, "metadata-segments");
      const expectedIds = new Set<string>();

      const store = new BasicOnDiskContentAddressedStore("stress-db", undefined, {
        basePath,
        indexingEnabled: true,
        metadataSegmentCompactionMinFiles: 16,
      });

      let createdAt = Date.now();
      for (let round = 0; round < rounds; round++) {
        const batch: StoreEntry[] = [];
        for (let i = 0; i < entriesPerRound; i++) {
          const id = `fi-r${round}-id-${i}`;
          expectedIds.add(id);
          batch.push(createTestEntry("fault-doc", id, `fi-content-${round}-${i}`, createdAt++));
        }
        await store.putEntries(batch);

        if (round % 2 === 0 && (await fileExists(indexPath))) {
          // Corrupt snapshot coverage.
          const raw = await readFile(indexPath, "utf-8");
          const parsed = JSON.parse(raw) as unknown[];
          await writeFile(indexPath, JSON.stringify(parsed.slice(0, Math.max(0, parsed.length - 3))));
        } else {
          // Corrupt latest segment.
          const segmentFiles = (await readdir(segmentsDir))
            .filter((f) => f.endsWith(".json"))
            .sort();
          if (segmentFiles.length > 0) {
            const latest = join(segmentsDir, segmentFiles[segmentFiles.length - 1]);
            const raw = await readFile(latest, "utf-8");
            const parsed = JSON.parse(raw) as unknown[];
            await writeFile(latest, JSON.stringify(parsed.slice(0, Math.max(0, parsed.length - 1))));
          }
        }

        const restarted = new BasicOnDiskContentAddressedStore("stress-db", undefined, {
          basePath,
          indexingEnabled: true,
        });
        const ids = await restarted.getAllIds();
        expect(new Set(ids).size).toBe(expectedIds.size);
      }
    },
    isSoak ? 240000 : 90000
  );
});

function createTestEntry(
  docId: string,
  id: string,
  contentHash: string,
  createdAt: number
): StoreEntry {
  const encryptedData = new Uint8Array([10, 20, 30, 40, 50, createdAt % 251]);
  return {
    entryType: "doc_change",
    id,
    contentHash,
    docId,
    dependencyIds: [],
    createdAt,
    createdByPublicKey: "stress-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: 4,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
