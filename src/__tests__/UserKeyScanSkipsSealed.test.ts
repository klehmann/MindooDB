import { resolveUserKeyDocument } from "../core/userkeys/resolveUserKeyDocument";
import type { MindooDB, MindooTenantDirectory, StoreEntryMetadata } from "../core/types";

/**
 * When the canonical User-Key document does not validate, the lookup scans
 * userdirectory. It must never load a sealed document there: opening one
 * needs the User-Key, whose lookup runs this scan again and then waited for
 * its own load (Haven Desktop: Mindoo Mail hung at "Loading…" after a tenant
 * was pushed to a server).
 */
describe("resolveUserKeyDocument scan", () => {
  function meta(docId: string, decryptionKeyId: string): StoreEntryMetadata {
    return { docId, decryptionKeyId, entryType: "doc_create", id: `${docId}_d_0_x` } as unknown as StoreEntryMetadata;
  }

  it("skips sealed documents and documents without a create entry", async () => {
    const metas: Record<string, StoreEntryMetadata[]> = {
      wks_1: [meta("wks_1", "$sealed:wks_1")],
      dev_1: [meta("dev_1", "$publicinfos")],
      orphan: [],
    };
    const loaded: string[] = [];
    const db = {
      getStore: () => ({
        getId: () => "userdirectory",
        findNewEntriesForDoc: async (_known: string[], docId: string) => metas[docId] ?? [],
      }),
      getAllDocumentIds: async () => ["wks_1", "dev_1", "orphan"],
      getDocument: async (docId: string) => {
        loaded.push(docId);
        if (docId === "userkey_grant1") throw new Error("not found");
        return { isDeleted: () => false, getId: () => docId, getData: () => ({ type: "device" }) };
      },
    } as unknown as MindooDB;

    const resolved = await resolveUserKeyDocument({
      db,
      directory: {} as MindooTenantDirectory,
      username: "cn=Test/o=Org",
      usernameHashCandidates: [],
      grantDocIds: ["grant1"],
    });

    expect(resolved).toBeNull();
    expect(loaded).toEqual(["userkey_grant1", "dev_1"]);
  });
});
