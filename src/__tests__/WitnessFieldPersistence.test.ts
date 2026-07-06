import { mkdtempSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { StoreEntry, StoreKind } from "../core/types";

/**
 * Witness-receipt fields (docs/accesscontrol.md §5) must survive every metadata
 * persistence path or the receipt signature is silently lost. These tests cover
 * the on-disk store (which base64-encodes binary fields) across a restart, and
 * the in-memory store.
 */
function witnessedEntry(): StoreEntry {
  const encryptedData = new Uint8Array([9, 8, 7, 6, 5]);
  return {
    entryType: "doc_change",
    id: "docW_d_0_HASH",
    contentHash: "contentW",
    docId: "docW",
    dependencyIds: [],
    createdAt: 1_700_000_000_000,
    createdByPublicKey: "author-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: 5,
    encryptedSize: encryptedData.length,
    // Witness receipt fields:
    receivedAt: 1_700_000_005_000,
    receivedByPublicKey: "witness-key-pem",
    receivedDateSignature: new Uint8Array([200, 150, 100, 50, 25]),
    encryptedData,
  };
}

describe("witness field persistence", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = mkdtempSync(join(tmpdir(), "mindoodb-witness-store-"));
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it("round-trips witness fields through the on-disk store across restart", async () => {
    const store1 = new BasicOnDiskContentAddressedStore("wdb", StoreKind.docs, undefined, {
      basePath,
    });
    await store1.putEntries([witnessedEntry()]);

    // Re-open from disk to force a serialize -> deserialize cycle.
    const store2 = new BasicOnDiskContentAddressedStore("wdb", StoreKind.docs, undefined, {
      basePath,
    });
    const meta = await store2.getEntryMetadata("docW_d_0_HASH");
    expect(meta).toBeTruthy();
    expect(meta!.receivedAt).toBe(1_700_000_005_000);
    expect(meta!.receivedByPublicKey).toBe("witness-key-pem");
    expect(Array.from(meta!.receivedDateSignature!)).toEqual([200, 150, 100, 50, 25]);

    const [full] = await store2.getEntries(["docW_d_0_HASH"]);
    expect(full.receivedAt).toBe(1_700_000_005_000);
    expect(Array.from(full.receivedDateSignature!)).toEqual([200, 150, 100, 50, 25]);
  });

  it("preserves the absence of witness fields for local entries", async () => {
    const store = new BasicOnDiskContentAddressedStore("wdb2", StoreKind.docs, undefined, {
      basePath,
    });
    const local = witnessedEntry();
    delete local.receivedAt;
    delete local.receivedByPublicKey;
    delete local.receivedDateSignature;
    local.id = "local_d_0_H";
    await store.putEntries([local]);

    const reopened = new BasicOnDiskContentAddressedStore("wdb2", StoreKind.docs, undefined, {
      basePath,
    });
    const meta = await reopened.getEntryMetadata("local_d_0_H");
    expect(meta).toBeTruthy();
    expect(meta!.receivedAt).toBeUndefined();
    expect(meta!.receivedByPublicKey).toBeUndefined();
    expect(meta!.receivedDateSignature).toBeUndefined();
  });

  it("round-trips witness fields through the in-memory store", async () => {
    const store = new InMemoryContentAddressedStore("mdb", StoreKind.docs);
    await store.putEntries([witnessedEntry()]);
    const meta = await store.getEntryMetadata("docW_d_0_HASH");
    expect(meta!.receivedAt).toBe(1_700_000_005_000);
    expect(meta!.receivedByPublicKey).toBe("witness-key-pem");
    expect(Array.from(meta!.receivedDateSignature!)).toEqual([200, 150, 100, 50, 25]);
  });
});
