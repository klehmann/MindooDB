/**
 * Store contract for document-history purges, run against every store
 * implementation: purging or deleting entries by id must never take content
 * another entry still uses, and the store-level purge must keep attachment
 * chunks another document's history references (docs/accesscontrol.md §13).
 */
import "fake-indexeddb/auto";

import { mkdtempSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { SqliteContentAddressedStore } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { createMemorySqliteBackend } from "../core/appendonlystores/sqlite/SqliteDriver";
import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";
import { IndexedDBContentAddressedStore } from "../browser/appendonlystores/IndexedDBContentAddressedStore";
import { purgeDocumentHistoryFromStores } from "../core/appendonlystores/purgeDocumentHistory";
import { StoreKind } from "../core/appendonlystores/types";
import type { ContentAddressedStore } from "../core/appendonlystores/types";
import type { StoreEntry, StoreEntryType } from "../core/types";

function entry(
  docId: string,
  id: string,
  contentHash: string,
  options: {
    bytes?: number[];
    entryType?: StoreEntryType;
    dependencyIds?: string[];
    lastChunkIds?: string[];
  } = {},
): StoreEntry {
  const encryptedData = new Uint8Array(options.bytes ?? [contentHash.length, 1, 2, 3]);
  return {
    entryType: options.entryType ?? "doc_change",
    id,
    contentHash,
    docId,
    dependencyIds: options.dependencyIds ?? [],
    createdAt: Date.now(),
    createdByPublicKey: "test-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: encryptedData.length,
    encryptedSize: encryptedData.length,
    encryptedData,
    ...(options.lastChunkIds
      ? {
          attachmentRefs: options.lastChunkIds.map((lastChunkId, index) => ({
            attachmentId: `att${index}`,
            lastChunkId,
            size: 100,
          })),
        }
      : {}),
  };
}

type StoreMaker = (storeId: string, kind: StoreKind) => ContentAddressedStore;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

let storeCounter = 0;
const implementations: Array<[string, StoreMaker]> = [
  ["InMemory", (storeId, kind) => new InMemoryContentAddressedStore(storeId, kind)],
  [
    "Sqlite",
    (storeId, kind) => new SqliteContentAddressedStore(storeId, kind, createMemorySqliteBackend()),
  ],
  [
    "BasicOnDisk",
    (storeId, kind) => {
      const basePath = mkdtempSync(join(tmpdir(), "mindoodb-purge-contract-"));
      cleanups.push(() => rm(basePath, { recursive: true, force: true }));
      return new BasicOnDiskContentAddressedStore(storeId, kind, undefined, { basePath });
    },
  ],
  [
    "IndexedDB",
    (storeId, kind) =>
      new IndexedDBContentAddressedStore(storeId, kind, undefined, {
        basePath: `purgecontract${++storeCounter}`,
      }),
  ],
];

describe.each(implementations)("%s store", (_name, makeStore) => {
  it("purgeDocHistory keeps content another document's entry shares", async () => {
    const store = makeStore("db", StoreKind.attachments);
    await store.putEntries([
      entry("doc1", "doc1_a_x_1", "hash-shared", { bytes: [9, 9, 9] }),
      entry("doc1", "doc1_a_x_2", "hash-only-doc1", { bytes: [7, 7] }),
      entry("doc2", "doc2_a_y_1", "hash-shared", { bytes: [9, 9, 9] }),
    ]);

    await store.purgeDocHistory("doc1");

    expect(await store.hasEntries(["doc1_a_x_1", "doc1_a_x_2"])).toEqual([]);
    const [kept] = await store.getEntries(["doc2_a_y_1"]);
    expect(Array.from(kept.encryptedData)).toEqual([9, 9, 9]);
  });

  it("deleteEntriesById removes exactly the listed entries and releases unshared content only", async () => {
    const store = makeStore("db", StoreKind.attachments);
    expect(typeof store.deleteEntriesById).toBe("function");
    await store.putEntries([
      entry("doc1", "e1", "hash-shared", { bytes: [5, 5] }),
      entry("doc1", "e2", "hash-e2", { bytes: [6] }),
      entry("doc1", "e3", "hash-e3", { bytes: [8] }),
      entry("doc2", "e4", "hash-shared", { bytes: [5, 5] }),
    ]);

    expect(await store.deleteEntriesById!(["e1", "e2", "missing"])).toBe(2);

    expect((await store.findNewEntriesForDoc([], "doc1")).map((e) => e.id)).toEqual(["e3"]);
    expect(await store.hasEntries(["e1", "e2", "e3", "e4"])).toEqual(["e3", "e4"]);
    const [shared] = await store.getEntries(["e4"]);
    expect(Array.from(shared.encryptedData)).toEqual([5, 5]);
    // Writing the deleted entry again works: its content was released cleanly.
    await store.putEntries([entry("doc1", "e2", "hash-e2", { bytes: [6] })]);
    const [rewritten] = await store.getEntries(["e2"]);
    expect(Array.from(rewritten.encryptedData)).toEqual([6]);
  });

  it("purgeDocumentHistoryFromStores keeps chunks another document's history references", async () => {
    const docs = makeStore("db", StoreKind.docs);
    const attachments = makeStore("db", StoreKind.attachments);
    // doc1 owns two attachment chains: c1 <- c2 <- c3, and d1.
    await attachments.putEntries([
      entry("doc1", "doc1_a_A_c1", "hc1", { entryType: "attachment_chunk" }),
      entry("doc1", "doc1_a_A_c2", "hc2", {
        entryType: "attachment_chunk",
        dependencyIds: ["doc1_a_A_c1"],
      }),
      entry("doc1", "doc1_a_A_c3", "hc3", {
        entryType: "attachment_chunk",
        dependencyIds: ["doc1_a_A_c2"],
      }),
      entry("doc1", "doc1_a_B_d1", "hd1", { entryType: "attachment_chunk" }),
    ]);
    await docs.putEntries([
      entry("doc1", "doc1_d_1", "h-doc1", { lastChunkIds: ["doc1_a_A_c3", "doc1_a_B_d1"] }),
      // doc2's history (an in-place copy) still points at c2, the chain's state
      // before doc1 appended c3.
      entry("doc2", "doc2_d_1", "h-doc2", { lastChunkIds: ["doc1_a_A_c2"] }),
    ]);

    const outcome = await purgeDocumentHistoryFromStores(
      { docsStore: docs, attachmentStore: attachments },
      "doc1",
    );

    expect(outcome).toEqual({
      docEntriesPurged: 1,
      attachmentChunksPurged: 2,
      attachmentChunksRetained: 2,
    });
    expect(await docs.hasEntries(["doc1_d_1", "doc2_d_1"])).toEqual(["doc2_d_1"]);
    expect(
      (await attachments.hasEntries(["doc1_a_A_c1", "doc1_a_A_c2", "doc1_a_A_c3", "doc1_a_B_d1"]))
        .sort(),
    ).toEqual(["doc1_a_A_c1", "doc1_a_A_c2"]);

    // Once nothing references them, a repeated purge removes the rest.
    await docs.purgeDocHistory("doc2");
    const sweep = await purgeDocumentHistoryFromStores(
      { docsStore: docs, attachmentStore: attachments },
      "doc1",
    );
    expect(sweep).toEqual({
      docEntriesPurged: 0,
      attachmentChunksPurged: 2,
      attachmentChunksRetained: 0,
    });
    expect(await attachments.findNewEntriesForDoc([], "doc1")).toEqual([]);
  });
});
