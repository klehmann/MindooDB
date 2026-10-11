import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { MigratingContentAddressedStoreFactory } from "../core/appendonlystores/migration/StoreMigration";
import { SqliteContentAddressedStoreFactory } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { createMemorySqliteBackend, type SqliteStoreBackend } from "../core/appendonlystores/sqlite/SqliteDriver";
import { StoreKind } from "../core/appendonlystores/types";
import type { StoreEntry } from "../core/types";

function entry(id: string): StoreEntry {
  const encryptedData = new Uint8Array([id.length, 1, 2, 3]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId: "doc-1",
    dependencyIds: [],
    createdAt: 1000,
    createdByPublicKey: "pk",
    decryptionKeyId: "default",
    signature: new Uint8Array([9, 9]),
    originalSize: 4,
    encryptedSize: 4,
    encryptedData,
  };
}

describe("MigratingContentAddressedStoreFactory", () => {
  test("copies source entries into an empty target once", async () => {
    // A persistent source: the same stores every time (like IndexedDB).
    const memory = new InMemoryContentAddressedStoreFactory();
    const opened = new Map<string, ReturnType<InMemoryContentAddressedStoreFactory["createStore"]>>();
    const source = {
      createStore(dbId: string) {
        if (!opened.has(dbId)) opened.set(dbId, memory.createStore(dbId));
        return opened.get(dbId)!;
      },
    };
    const backends = new Map<string, SqliteStoreBackend>();
    const target = new SqliteContentAddressedStoreFactory((dbId, kind) => {
      const key = `${dbId}:${kind}`;
      if (!backends.has(key)) backends.set(key, createMemorySqliteBackend());
      return backends.get(key)!;
    });
    const old = source.createStore("db1").docStore;
    await old.putEntries(Array.from({ length: 250 }, (_, i) => entry(`e${i}`)));

    const migrated: number[] = [];
    const factory = new MigratingContentAddressedStoreFactory(target, source, {
      batchSize: 40,
      onMigrated: ({ entries }) => migrated.push(entries),
    });
    const { docStore, attachmentStore } = factory.createStore("db1");
    expect(docStore.getStoreKind()).toBe(StoreKind.docs);
    expect((await docStore.getAllIds()).length).toBe(250);
    const [first] = await docStore.getEntries(["e7"]);
    expect(Array.from(first.encryptedData)).toEqual([2, 1, 2, 3]);
    expect(await attachmentStore.getAllIds()).toEqual([]);
    expect(migrated).toEqual([250]);

    // A second start finds data in the target and copies nothing.
    await old.putEntries([entry("late")]);
    const again = new MigratingContentAddressedStoreFactory(target, source, {
      onMigrated: ({ entries }) => migrated.push(entries),
    }).createStore("db1");
    expect((await again.docStore.getAllIds()).length).toBe(250);
    expect(migrated).toEqual([250]);
  });
});
