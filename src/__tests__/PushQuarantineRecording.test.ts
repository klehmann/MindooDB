/**
 * `recordPushRejections` is the step that decides whether a refused push leaves a
 * trace or is simply lost, so its failure modes are the interesting part:
 *
 * - it must fold a causal cascade into one record per document and class, or a
 *   single refused entry near the root of a long history writes hundreds of
 *   documents that all say the same thing,
 * - it must refuse to record a refused *quarantine record*, or a server that
 *   turns those away makes a device emit them without end,
 * - it must write nothing when it is told the same thing twice, because a record
 *   is written during a push and a write is something to push,
 * - and it must not throw, because the push it is reporting on already
 *   half-succeeded.
 */

import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import {
  UNKNOWN_QUARANTINED_DOC_ID,
  recordPushRejections,
} from "../core/quarantine/recordPushRejections";
import { listQuarantineRecords, type QuarantineDirectory } from "../core/quarantine/QuarantineDocument";
import type { RejectedPutEntry } from "../core/appendonlystores/types";
import { USER_DIRECTORY_DB_ID, type MindooDB } from "../core/types";

describe("recording what a push left behind", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let subtle: SubtleCrypto;
  let userdirectoryDb: MindooDB;

  /** Refused entry ids follow `<docId>_d_<deps>_<hash>`, which is how the doc is found again. */
  function refusal(
    docId: string,
    hash: string,
    rejectionClass: RejectedPutEntry["rejectionClass"] = "policy",
  ): RejectedPutEntry {
    return {
      id: `${docId}_d_0_${hash}`,
      reason: "denied by Tier 1 policy: no doc_change rule grants this user",
      rejectionClass,
    };
  }

  function record(
    rejected: readonly RejectedPutEntry[],
    overrides: { userdirectoryDb?: MindooDB } = {},
  ) {
    return recordPushRejections({
      dbid: "projects",
      userdirectoryDb: overrides.userdirectoryDb ?? userdirectoryDb,
      rejected,
      signingPublicKey: alice.user.userSigningKeyPair.publicKey,
      subtle,
    });
  }

  async function recordsFor(docId: string) {
    const all = await listQuarantineRecords({
      db: userdirectoryDb,
      directory: (await alice.tenant.openDirectory()) as unknown as QuarantineDirectory,
      subtle,
    });
    return all.filter((entry) => entry.quarantinedDocId === docId);
  }

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-push-quarantine" });
    subtle = fixture.crypto.getSubtle();
    alice = await addPerson(fixture, "alice", "laptop");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    userdirectoryDb = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
  });

  it("folds a cascade into one record per document and class", async () => {
    const result = await record([
      refusal("cascade_one", "h1"),
      refusal("cascade_one", "h2"),
      refusal("cascade_one", "h3"),
      refusal("cascade_one", "h4", "purged"),
      refusal("cascade_two", "h5"),
    ]);

    // Five refusals, three records: the document and the class are what differ.
    expect(result.failures).toEqual([]);
    expect(
      result.recorded
        .map((entry) => `${entry.documentId}/${entry.rejectionClass}:${entry.entryCount}`)
        .sort(),
    ).toEqual(["cascade_one/policy:3", "cascade_one/purged:1", "cascade_two/policy:1"]);

    const one = await recordsFor("cascade_one");
    expect(one.map((entry) => entry.rejectionClass).sort()).toEqual(["policy", "purged"]);
    expect(one.find((entry) => entry.rejectionClass === "policy")!.entryIds).toHaveLength(3);
  });

  it("counts a refused quarantine record instead of recording another one", async () => {
    const result = await record([
      refusal("qtn_a1b2c3", "h1"),
      refusal("qtn_a1b2c3", "h2"),
      refusal("legit_doc", "h3"),
    ]);

    // Recording these would name a new `qtn_` document each round, and each of
    // those could be refused in turn.
    expect(result.skippedOwnRecords).toBe(2);
    expect(result.recorded.map((entry) => entry.documentId)).toEqual(["legit_doc"]);
    expect(await recordsFor("qtn_a1b2c3")).toEqual([]);
  });

  it("writes nothing when the same refusal is reported again", async () => {
    const rejected = [refusal("repeat_doc", "h1"), refusal("repeat_doc", "h2")];
    await record(rejected);
    const [first] = await recordsFor("repeat_doc");
    expect(first.entryIds).toHaveLength(2);

    for (let push = 0; push < 4; push++) {
      await record(rejected);
    }

    // `updatedAt` only moves on a write, and a write here is an entry to push,
    // which is what would bring this function round again.
    const [after] = await recordsFor("repeat_doc");
    expect(after.updatedAt).toBe(first.updatedAt);
    expect(after.entryIds).toHaveLength(2);
  });

  it("still records the rest when one record cannot be written", async () => {
    let calls = 0;
    const flaky = new Proxy(userdirectoryDb, {
      get(target, prop, receiver) {
        // Not `getDocument`: recordPushQuarantine treats a failed read as "not
        // recorded yet" on purpose, so the write is where a failure shows.
        if (prop === "createDocument") {
          return async (...args: unknown[]) => {
            if (++calls === 1) throw new Error("directory busy");
            return (
              target.createDocument as unknown as (...a: unknown[]) => Promise<unknown>
            ).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as MindooDB;

    const result = await record(
      [refusal("flaky_one", "h1"), refusal("flaky_two", "h2")],
      { userdirectoryDb: flaky },
    );

    // A push that already half-succeeded must not be turned into a thrown error
    // by the bookkeeping that follows it.
    expect(result.failures).toHaveLength(1);
    expect(result.recorded).toHaveLength(1);
    expect(result.failures[0].error).toContain("directory busy");
  });

  it("files an entry whose id follows no known scheme under a sentinel document", async () => {
    const result = await record([
      { id: "opaque-entry-id", reason: "refused", rejectionClass: "signature" },
    ]);

    // Unrecognizable is not a reason to drop it: the entry is gone from the push
    // either way, and the record is the only thing left pointing at it.
    expect(result.recorded).toEqual([
      {
        documentId: UNKNOWN_QUARANTINED_DOC_ID,
        rejectionClass: "signature",
        entryCount: 1,
      },
    ]);
    const stored = await recordsFor(UNKNOWN_QUARANTINED_DOC_ID);
    expect(stored[0].entryIds).toEqual(["opaque-entry-id"]);
  });

  it("does nothing at all when the push was clean", async () => {
    const result = await record([]);
    expect(result).toEqual({ recorded: [], skippedOwnRecords: 0, failures: [] });
  });
});
