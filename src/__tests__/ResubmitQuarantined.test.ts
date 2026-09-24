/**
 * Re-submit is the only thing that ever offers a quarantined entry again, so the
 * questions worth asking of it are about what it must *not* do:
 *
 * - it must never re-offer a `"purged"` entry, because that document's history
 *   was erased on purpose and pushing it back is undoing somebody's deletion,
 * - it must withdraw a record once the entries get through, or the list grows
 *   until nothing in it means anything,
 * - it must leave a record standing while anything about it is still refused,
 *   without rewriting it — a rewrite is a write, and a write is what brings the
 *   next push, and the next re-submit, round again,
 * - and it must survive an unreachable server, since it runs in the background.
 */

import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  DEFAULT_MAX_RESUBMIT_RECORDS,
  resubmitQuarantinedEntries,
} from "../core/quarantine/resubmitQuarantined";
import { isResubmittableRejection } from "../core/appendonlystores/types";
import type {
  ContentAddressedStore,
  PutEntriesAck,
  PutRejectionClass,
  StoreEntry,
} from "../core/appendonlystores/types";
import { StoreKind, type MindooDB } from "../core/types";
import type { QuarantineRecordDoc } from "../core/quarantine/QuarantineDocument";

function record(overrides: Partial<QuarantineRecordDoc> = {}): QuarantineRecordDoc {
  return {
    docId: "qtn_record1",
    signingPublicKey: "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----",
    signingKeyFingerprint: "ab:cd",
    dbid: "projects",
    quarantinedDocId: "proj_alpha",
    rejectionClass: "policy",
    reason: "denied by Tier 1 policy",
    entryIds: ["e1", "e2"],
    omittedEntryCount: 0,
    firstSeenAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function createEntry(id: string): StoreEntry {
  const encryptedData = new Uint8Array([1, 2, 3]);
  return {
    entryType: "doc_change",
    id,
    contentHash: `hash-${id}`,
    docId: "proj_alpha",
    dependencyIds: [],
    createdAt: 1000,
    createdByPublicKey: "test-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([4, 5]),
    originalSize: encryptedData.length,
    encryptedSize: encryptedData.length,
    encryptedData,
  };
}

async function localStoreWith(ids: string[]): Promise<ContentAddressedStore> {
  const store = new InMemoryContentAddressedStore("projects", StoreKind.docs);
  await store.putEntries(ids.map(createEntry));
  return store;
}

/** A target that refuses the ids it is told to, and remembers what it was offered. */
function remoteStore(options: {
  refuse?: Set<string>;
  rejectionClass?: PutRejectionClass;
  throwOnPut?: boolean;
} = {}) {
  const offered: string[] = [];
  const store = new InMemoryContentAddressedStore("projects", StoreKind.docs);
  const accept = store.putEntries.bind(store);
  store.putEntries = async (entries: StoreEntry[]): Promise<PutEntriesAck> => {
    offered.push(...entries.map((entry) => entry.id));
    if (options.throwOnPut) {
      throw new Error("server unreachable");
    }
    const refused = entries.filter((entry) => options.refuse?.has(entry.id));
    await accept(entries.filter((entry) => !options.refuse?.has(entry.id)));
    return {
      receipts: [],
      rejected: refused.map((entry) => ({
        id: entry.id,
        reason: "still denied",
        rejectionClass: options.rejectionClass ?? ("policy" as PutRejectionClass),
      })),
    };
  };
  return { store: store as ContentAddressedStore, offered };
}

/** Records the ids whose quarantine documents were deleted. */
function userdirectoryStub() {
  const deleted: string[] = [];
  const db = {
    deleteDocument: async (docId: string) => {
      deleted.push(docId);
    },
  } as unknown as MindooDB;
  return { db, deleted };
}

const subtle = globalThis.crypto.subtle;

describe("re-submitting quarantined entries", () => {
  it("never offers a purged entry again", async () => {
    const remote = remoteStore();
    const directory = userdirectoryStub();

    const result = await resubmitQuarantinedEntries({
      records: [record({ rejectionClass: "purged" })],
      localStore: await localStoreWith(["e1", "e2"]),
      remoteStore: remote.store,
      userdirectoryDb: directory.db,
      subtle,
    });

    // The document's history was erased deliberately. Offering the entry again
    // is an attempt to undo that, so it must not reach the target at all.
    expect(remote.offered).toEqual([]);
    expect(result.skippedFinal).toBe(1);
    expect(result.outcomes).toEqual([]);
    // And the record stays: it is the audit trail of a refusal that stands.
    expect(directory.deleted).toEqual([]);
  });

  it.each<PutRejectionClass>(["signature", "revoked-key"])(
    "does not re-offer a %s rejection either",
    async (rejectionClass) => {
      const remote = remoteStore();
      const result = await resubmitQuarantinedEntries({
        records: [record({ rejectionClass })],
        localStore: await localStoreWith(["e1", "e2"]),
        remoteStore: remote.store,
        userdirectoryDb: userdirectoryStub().db,
        subtle,
      });
      expect(remote.offered).toEqual([]);
      expect(result.skippedFinal).toBe(1);
    },
  );

  it.each<PutRejectionClass>(["policy", "untrusted-key"])(
    "does re-offer a %s rejection, since something outside the entry can have changed",
    async (rejectionClass) => {
      const remote = remoteStore();
      const result = await resubmitQuarantinedEntries({
        records: [record({ rejectionClass })],
        localStore: await localStoreWith(["e1", "e2"]),
        remoteStore: remote.store,
        userdirectoryDb: userdirectoryStub().db,
        subtle,
      });
      expect(remote.offered.sort()).toEqual(["e1", "e2"]);
      expect(result.skippedFinal).toBe(0);
    },
  );

  it("agrees with the taxonomy about which classes are worth another attempt", () => {
    // Pinning this keeps a class added later from silently becoming
    // re-submittable, which for a purge-like class would be a correctness bug.
    expect(
      (["signature", "untrusted-key", "policy", "purged", "revoked-key"] as const).filter(
        isResubmittableRejection,
      ),
    ).toEqual(["untrusted-key", "policy"]);
  });

  it("withdraws the record once every entry gets through", async () => {
    const remote = remoteStore();
    const directory = userdirectoryStub();

    const result = await resubmitQuarantinedEntries({
      records: [record()],
      localStore: await localStoreWith(["e1", "e2"]),
      remoteStore: remote.store,
      userdirectoryDb: directory.db,
      subtle,
    });

    expect(result.outcomes[0].accepted.sort()).toEqual(["e1", "e2"]);
    expect(result.outcomes[0].cleared).toBe(true);
    expect(directory.deleted).toHaveLength(1);
  });

  it("leaves the record standing while anything is still refused", async () => {
    const remote = remoteStore({ refuse: new Set(["e2"]) });
    const directory = userdirectoryStub();

    const result = await resubmitQuarantinedEntries({
      records: [record()],
      localStore: await localStoreWith(["e1", "e2"]),
      remoteStore: remote.store,
      userdirectoryDb: directory.db,
      subtle,
    });

    expect(result.outcomes[0].accepted).toEqual(["e1"]);
    expect(result.outcomes[0].refused.map((entry) => entry.id)).toEqual(["e2"]);
    expect(result.outcomes[0].cleared).toBe(false);
    // Not narrowed to just e2 either: that would be a write, and a write is
    // something to push, which brings the next re-submit round.
    expect(directory.deleted).toEqual([]);
  });

  it("withdraws a record whose entries are no longer here at all", async () => {
    const remote = remoteStore();
    const directory = userdirectoryStub();

    const result = await resubmitQuarantinedEntries({
      records: [record()],
      localStore: await localStoreWith([]),
      remoteStore: remote.store,
      userdirectoryDb: directory.db,
      subtle,
    });

    // Nothing can ever be offered for it, so keeping the record would make it
    // permanent — an accusation nobody can answer.
    expect(remote.offered).toEqual([]);
    expect(result.outcomes[0].missing.sort()).toEqual(["e1", "e2"]);
    expect(result.outcomes[0].cleared).toBe(true);
    expect(directory.deleted).toHaveLength(1);
  });

  it("reports an unreachable server instead of throwing", async () => {
    const remote = remoteStore({ throwOnPut: true });
    const directory = userdirectoryStub();

    const result = await resubmitQuarantinedEntries({
      records: [record()],
      localStore: await localStoreWith(["e1", "e2"]),
      remoteStore: remote.store,
      userdirectoryDb: directory.db,
      subtle,
    });

    // This runs in the background off a directory change; it must not take the
    // caller down, and it must not withdraw a record it never delivered.
    expect(result.outcomes[0].error).toContain("server unreachable");
    expect(result.outcomes[0].cleared).toBe(false);
    expect(directory.deleted).toEqual([]);
  });

  it("stops at the per-pass budget and leaves the rest for later", async () => {
    const remote = remoteStore();
    const many = Array.from({ length: 30 }, (_, i) =>
      record({ docId: `qtn_r${i}`, quarantinedDocId: `proj_${i}`, entryIds: [`e${i}`] }),
    );

    const result = await resubmitQuarantinedEntries({
      records: many,
      localStore: await localStoreWith(many.map((r) => r.entryIds[0])),
      remoteStore: remote.store,
      userdirectoryDb: userdirectoryStub().db,
      subtle,
      maxRecords: 4,
    });

    // A pass runs on every directory change, and a record that still fails costs
    // a round trip to learn nothing.
    expect(result.outcomes).toHaveLength(4);
    expect(result.notAttempted).toBe(26);
    expect(remote.offered).toHaveLength(4);
  });

  it("counts a final record against neither the budget nor the outcomes", async () => {
    const remote = remoteStore();
    const result = await resubmitQuarantinedEntries({
      records: [
        record({ docId: "qtn_p", rejectionClass: "purged", entryIds: ["e1"] }),
        record({ docId: "qtn_a", quarantinedDocId: "proj_b", entryIds: ["e2"] }),
      ],
      localStore: await localStoreWith(["e1", "e2"]),
      remoteStore: remote.store,
      userdirectoryDb: userdirectoryStub().db,
      subtle,
      maxRecords: 1,
    });

    // The purged one is not a candidate, so it must not consume the one attempt
    // this pass is allowed.
    expect(result.skippedFinal).toBe(1);
    expect(result.notAttempted).toBe(0);
    expect(remote.offered).toEqual(["e2"]);
  });

  it("does nothing when there is nothing quarantined", async () => {
    const remote = remoteStore();
    const result = await resubmitQuarantinedEntries({
      records: [],
      localStore: await localStoreWith([]),
      remoteStore: remote.store,
      userdirectoryDb: userdirectoryStub().db,
      subtle,
    });
    expect(result).toEqual({ outcomes: [], skippedFinal: 0, notAttempted: 0 });
    expect(DEFAULT_MAX_RESUBMIT_RECORDS).toBeGreaterThan(0);
  });
});
