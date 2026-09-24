import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import {
  MAX_QUARANTINED_ENTRY_IDS,
  QuarantineRecursionError,
  clearQuarantineRecord,
  listQuarantineRecords,
  quarantineDocumentId,
  recordPushQuarantine,
  verifyQuarantineRecord,
  type QuarantineDirectory,
} from "../core/quarantine/QuarantineDocument";
import { fingerprintPublicKeyPem } from "../core/userkeys/fingerprint";
import {
  DEFAULT_TENANT_KEY_ID,
  USER_DIRECTORY_DB_ID,
  type MindooDB,
  type MindooDoc,
} from "../core/types";

/**
 * Quarantine records (`qtn_…` in `userdirectory`) remember a write the server
 * refused because the author's right had been withdrawn, so it can be found and
 * offered again rather than blocking the database's push or vanishing on
 * reload.
 *
 * Three properties carry the weight here:
 *
 * - **They cost nothing when nothing changed.** A record is written during a
 *   push, and a write syncs, and a sync can trigger the next push. A record
 *   that rewrote itself on every attempt would feed that circle.
 * - **One record per author, not per document.** The id folds in the recording
 *   device's key fingerprint. Without that, two members refused on the same
 *   document would derive the same id, and the personal-document invariant —
 *   which only lets the creator write — would refuse the second one.
 * - **Unspoofable.** These records say "this person tried to write something
 *   they were not allowed to write", so an unverified one puts words in
 *   somebody else's mouth.
 */
describe("quarantine documents", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let subtle: SubtleCrypto;

  async function directoryOf(device: DeviceHandle): Promise<QuarantineDirectory> {
    return (await device.tenant.openDirectory()) as unknown as QuarantineDirectory;
  }

  function fingerprintOf(device: DeviceHandle): Promise<string> {
    return fingerprintPublicKeyPem(device.user.userSigningKeyPair.publicKey, subtle);
  }

  /** Record one refused entry on a document in `projects`, as `device`. */
  function record(
    device: DeviceHandle,
    db: MindooDB,
    overrides: {
      quarantinedDocId?: string;
      entryIds?: string[];
      reason?: string;
      now?: number;
    } = {},
  ): Promise<MindooDoc> {
    return recordPushQuarantine({
      db,
      signingPublicKey: device.user.userSigningKeyPair.publicKey,
      dbid: "projects",
      quarantinedDocId: overrides.quarantinedDocId ?? "proj_alpha",
      rejectionClass: "policy",
      reason: overrides.reason ?? "denied by Tier 1 policy: no doc_change rule grants this user",
      entryIds: overrides.entryIds ?? ["proj_alpha_d_1"],
      subtle,
      now: overrides.now,
    });
  }

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-quarantine" });
    subtle = fixture.crypto.getSubtle();
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("records a refusal and lists it back verified", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await record(alice, db);

    const records = await listQuarantineRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
      dbid: "projects",
    });
    const mine = records.filter((entry) => entry.quarantinedDocId === "proj_alpha");
    expect(mine).toHaveLength(1);
    expect(mine[0].rejectionClass).toBe("policy");
    expect(mine[0].entryIds).toEqual(["proj_alpha_d_1"]);
    expect(mine[0].reason).toContain("no doc_change rule grants this user");
    expect(mine[0].signingKeyFingerprint).toBe(await fingerprintOf(alice));
  });

  it("stores the payload under the tenant default key, not $publicinfos", async () => {
    // Which of a tenant's writes were refused is not the hoster's business, and
    // the hoster holds the $publicinfos key.
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const docId = await quarantineDocumentId(
      {
        signingKeyFingerprint: await fingerprintOf(alice),
        dbid: "projects",
        quarantinedDocId: "proj_alpha",
        rejectionClass: "policy",
      },
      subtle,
    );
    const metas = await db.getStore().findNewEntriesForDoc([], docId);
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) {
      expect(meta.decryptionKeyId).toBe(DEFAULT_TENANT_KEY_ID);
    }
  });

  it("writes nothing when the same refusal is recorded again", async () => {
    // The loop this closes: recording appends an entry to `userdirectory`, which
    // syncs, which can trigger the next push, which would record again. A push
    // that keeps failing the same way is the normal case here — it must be free.
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const first = await record(alice, db, { quarantinedDocId: "proj_stable" });
    const afterFirst = (first.getData() as unknown as { updatedAt: number }).updatedAt;

    for (let attempt = 0; attempt < 5; attempt++) {
      const again = await record(alice, db, { quarantinedDocId: "proj_stable" });
      expect((again.getData() as unknown as { updatedAt: number }).updatedAt).toBe(afterFirst);
    }

    // And the document's history did not grow either.
    const docId = await quarantineDocumentId(
      {
        signingKeyFingerprint: await fingerprintOf(alice),
        dbid: "projects",
        quarantinedDocId: "proj_stable",
        rejectionClass: "policy",
      },
      subtle,
    );
    const page = await db.getDocumentHistoryPage(docId, { limit: 50 });
    expect(page.entries.length).toBeLessThanOrEqual(2);
  });

  it("extends the same record when a further entry is refused", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await record(alice, db, { quarantinedDocId: "proj_growing", entryIds: ["g_1"] });
    await record(alice, db, { quarantinedDocId: "proj_growing", entryIds: ["g_1", "g_2"] });

    const records = await listQuarantineRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
      dbid: "projects",
    });
    const mine = records.filter((entry) => entry.quarantinedDocId === "proj_growing");
    expect(mine).toHaveLength(1);
    expect(mine[0].entryIds).toEqual(["g_1", "g_2"]);
  });

  it("gives two members refused on the same document separate records", async () => {
    // Without the author fingerprint in the id derivation, both would derive the
    // same doc id — and the personal-document invariant, which only lets the
    // creator write, would refuse the second member's record.
    const aliceDb = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);

    const aliceDoc = await record(alice, aliceDb, { quarantinedDocId: "proj_shared" });
    const bobDoc = await record(bob, bobDb, { quarantinedDocId: "proj_shared" });
    expect(aliceDoc.getId()).not.toBe(bobDoc.getId());

    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    // Both survive the trip through the server, which enforces the invariant.
    const seen = await listQuarantineRecords({
      db: aliceDb,
      directory: await directoryOf(alice),
      subtle,
      dbid: "projects",
    });
    const shared = seen.filter((entry) => entry.quarantinedDocId === "proj_shared");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((entry) => entry.signingKeyFingerprint)).size).toBe(2);
  });

  it("refuses to record a quarantine about a quarantine record", async () => {
    // Otherwise one refusal could generate a record, whose own refusal generates
    // a record, without end.
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(
      record(alice, db, { quarantinedDocId: "qtn_00112233445566778899" }),
    ).rejects.toBeInstanceOf(QuarantineRecursionError);
  });

  it("caps the entry id list and counts what did not fit", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const tooMany = Array.from(
      { length: MAX_QUARANTINED_ENTRY_IDS + 25 },
      (_unused, index) => `cascade_${index}`,
    );
    await record(alice, db, { quarantinedDocId: "proj_cascade", entryIds: tooMany });

    const records = await listQuarantineRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
      dbid: "projects",
    });
    const mine = records.filter((entry) => entry.quarantinedDocId === "proj_cascade")[0];
    expect(mine.entryIds).toHaveLength(MAX_QUARANTINED_ENTRY_IDS);
    expect(mine.omittedEntryCount).toBe(25);
  });

  it("filters to the records this device wrote itself", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const mine = await listQuarantineRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
      signingKeyFingerprint: await fingerprintOf(alice),
    });
    expect(mine.length).toBeGreaterThan(0);
    for (const entry of mine) {
      expect(entry.signingKeyFingerprint).toBe(await fingerprintOf(alice));
    }
  });

  it("discards a record that names someone else's signing key", async () => {
    // Bob files a well-formed record claiming Alice was refused. The id even
    // derives correctly from her fingerprint — but he signed `doc_create`.
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const docId = await quarantineDocumentId(
      {
        signingKeyFingerprint: await fingerprintOf(alice),
        dbid: "projects",
        quarantinedDocId: "proj_forged",
        rejectionClass: "policy",
      },
      subtle,
    );
    const forged = await bobDb.createDocument({
      id: docId,
      decryptionKeyId: DEFAULT_TENANT_KEY_ID,
    });
    await bobDb.changeDoc(forged, (editable) => {
      const data = editable.getData() as unknown as Record<string, unknown>;
      data.form = "userdirectory";
      data.type = "quarantine";
      data.schemaVersion = 1;
      data.signingPublicKey = alice.user.userSigningKeyPair.publicKey;
      data.dbid = "projects";
      data.quarantinedDocId = "proj_forged";
      data.rejectionClass = "policy";
      data.reason = "alice was up to no good";
      data.entryIds = ["proj_forged_d_1"];
      data.firstSeenAt = Date.now();
      data.updatedAt = Date.now();
    });

    await expect(
      verifyQuarantineRecord({
        db: bobDb,
        directory: await directoryOf(bob),
        doc: forged,
        subtle,
      }),
    ).resolves.toBeNull();
  });

  it("discards a record whose id does not match the fields it names", async () => {
    // Signed correctly, but filed under an id describing a different document,
    // so the id could no longer be used to find or replace the record.
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const mismatched = await bobDb.createDocument({
      id: "qtn_ffffffffffffffffffff",
      decryptionKeyId: DEFAULT_TENANT_KEY_ID,
    });
    await bobDb.changeDoc(mismatched, (editable) => {
      const data = editable.getData() as unknown as Record<string, unknown>;
      data.form = "userdirectory";
      data.type = "quarantine";
      data.schemaVersion = 1;
      data.signingPublicKey = bob.user.userSigningKeyPair.publicKey;
      data.dbid = "projects";
      data.quarantinedDocId = "proj_mismatched";
      data.rejectionClass = "policy";
      data.reason = "refused";
      data.entryIds = [];
      data.firstSeenAt = Date.now();
      data.updatedAt = Date.now();
    });

    await expect(
      verifyQuarantineRecord({
        db: bobDb,
        directory: await directoryOf(bob),
        doc: mismatched,
        subtle,
      }),
    ).resolves.toBeNull();
  });

  it("refuses a delete from another person", async () => {
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const aliceDocId = await quarantineDocumentId(
      {
        signingKeyFingerprint: await fingerprintOf(alice),
        dbid: "projects",
        quarantinedDocId: "proj_alpha",
        rejectionClass: "policy",
      },
      subtle,
    );
    await expect(bobDb.deleteDocument(aliceDocId)).rejects.toThrow(
      /only the owning person or the admin can delete a personal document/,
    );
  });

  it("lets a device clear its own record once the entries are through", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await record(alice, db, { quarantinedDocId: "proj_resolved" });
    await clearQuarantineRecord({
      db,
      key: {
        signingKeyFingerprint: await fingerprintOf(alice),
        dbid: "projects",
        quarantinedDocId: "proj_resolved",
        rejectionClass: "policy",
      },
      subtle,
    });

    const records = await listQuarantineRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
      dbid: "projects",
    });
    expect(records.some((entry) => entry.quarantinedDocId === "proj_resolved")).toBe(false);
  });
});
