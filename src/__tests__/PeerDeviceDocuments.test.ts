import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import {
  listPeerDeviceRecords,
  peerDeviceDocumentId,
  publishPeerDeviceRecord,
  removePeerDeviceRecord,
  verifyPeerDeviceRecord,
  type PeerDeviceDirectory,
} from "../core/peerdevices/PeerDeviceDocument";
import { fingerprintPublicKeyPem } from "../core/userkeys/fingerprint";
import {
  DEFAULT_TENANT_KEY_ID,
  USER_DIRECTORY_DB_ID,
  type MindooDB,
  type MindooDoc,
} from "../core/types";

/**
 * Peer-device records (`dev_…` in `userdirectory`) advertise a device's Iroh
 * endpoint id to the rest of the tenant.
 *
 * Two properties matter and neither is free:
 *
 * - **Readable by other members, not by the hoster.** They are encrypted with
 *   the tenant `default` key rather than `$publicinfos`, which the server also
 *   holds. Who syncs with whom is not the hoster's business.
 * - **Unspoofable.** Any member can write any `dev_` payload they like, so a
 *   record only counts once its claimed signing key is shown to be the key
 *   that created it and an active grant.
 */
describe("peer device documents", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let subtle: SubtleCrypto;

  const ALICE_ENDPOINT = "a1".repeat(32);
  const BOB_ENDPOINT = "b2".repeat(32);

  /** The real directory gate: is this signing key an active grant? */
  async function directoryOf(device: DeviceHandle): Promise<PeerDeviceDirectory> {
    return (await device.tenant.openDirectory()) as unknown as PeerDeviceDirectory;
  }

  /**
   * Write a `dev_` document by hand, bypassing {@link publishPeerDeviceRecord},
   * so a test can produce the shapes an attacker would.
   */
  async function writeRawPeerDeviceDoc(
    db: MindooDB,
    docId: string,
    fields: { irohEndpointId: string; signingPublicKey: string; label?: string },
  ): Promise<MindooDoc> {
    const doc = await db.createDocument({ id: docId, decryptionKeyId: DEFAULT_TENANT_KEY_ID });
    await db.changeDoc(doc, (editable) => {
      const data = editable.getData() as unknown as Record<string, unknown>;
      data.form = "userdirectory";
      data.type = "peerdevice";
      data.schemaVersion = 1;
      data.irohEndpointId = fields.irohEndpointId;
      data.signingPublicKey = fields.signingPublicKey;
      data.label = fields.label ?? "";
      data.updatedAt = Date.now();
    });
    return doc;
  }

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-peer-devices" });
    subtle = fixture.crypto.getSubtle();
    alice = await addPerson(fixture, "alice", "laptop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("publishes a record another member can read, keyed on the device signing key", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await publishPeerDeviceRecord({
      db,
      signingPublicKey: alice.user.userSigningKeyPair.publicKey,
      irohEndpointId: ALICE_ENDPOINT,
      label: "Alice laptop",
      subtle,
    });

    const fingerprint = await fingerprintPublicKeyPem(
      alice.user.userSigningKeyPair.publicKey,
      subtle,
    );
    expect(doc.getId()).toBe(peerDeviceDocumentId(fingerprint));
    // `default`, not `$publicinfos`: the hoster must not learn the endpoint id.
    expect(doc.getId().startsWith("dev_")).toBe(true);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const records = await listPeerDeviceRecords({
      db: bobDb,
      directory: await directoryOf(bob),
      subtle,
    });
    const alicesRecord = records.find((record) => record.irohEndpointId === ALICE_ENDPOINT);
    expect(alicesRecord).toBeDefined();
    expect(alicesRecord!.label).toBe("Alice laptop");
    expect(alicesRecord!.signingKeyFingerprint).toBe(fingerprint);
  });

  it("stores the payload under the tenant default key", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const fingerprint = await fingerprintPublicKeyPem(
      alice.user.userSigningKeyPair.publicKey,
      subtle,
    );
    const store = db.getStore();
    const metas = await store.findNewEntriesForDoc([], peerDeviceDocumentId(fingerprint));
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) {
      expect(meta.decryptionKeyId).toBe(DEFAULT_TENANT_KEY_ID);
    }
  });

  it("republishes in place instead of accumulating one record per session", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await publishPeerDeviceRecord({
      db,
      signingPublicKey: alice.user.userSigningKeyPair.publicKey,
      irohEndpointId: ALICE_ENDPOINT,
      label: "Alice laptop (renamed)",
      subtle,
    });
    const records = await listPeerDeviceRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
    });
    const mine = records.filter((record) => record.irohEndpointId === ALICE_ENDPOINT);
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe("Alice laptop (renamed)");
  });

  it("does not write anything when the record already says what it would say", async () => {
    // Haven republishes on every unlock and after every `userdirectory` sync.
    // If an unchanged republish still bumped `updatedAt`, that write would
    // sync, trigger the next refresh, and republish again — a loop that never
    // settles. Re-running an identical publish must leave the doc untouched.
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const publishOnce = () =>
      publishPeerDeviceRecord({
        db,
        signingPublicKey: alice.user.userSigningKeyPair.publicKey,
        irohEndpointId: ALICE_ENDPOINT,
        label: "Alice laptop (stable)",
        subtle,
      });

    const first = await publishOnce();
    const afterFirst = (first.getData() as unknown as { updatedAt: number }).updatedAt;

    const second = await publishOnce();
    const afterSecond = (second.getData() as unknown as { updatedAt: number }).updatedAt;
    expect(afterSecond).toBe(afterFirst);

    // A genuine change still lands.
    const changed = await publishPeerDeviceRecord({
      db,
      signingPublicKey: alice.user.userSigningKeyPair.publicKey,
      irohEndpointId: ALICE_ENDPOINT,
      label: "Alice laptop (moved desks)",
      subtle,
    });
    expect((changed.getData() as unknown as { label: string }).label).toBe(
      "Alice laptop (moved desks)",
    );
  });

  it("excludes the local endpoint so a device cannot offer to sync with itself", async () => {
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const records = await listPeerDeviceRecords({
      db,
      directory: await directoryOf(alice),
      subtle,
      excludeEndpointId: ALICE_ENDPOINT,
    });
    expect(records.some((record) => record.irohEndpointId === ALICE_ENDPOINT)).toBe(false);
  });

  it("discards a record that claims someone else's signing key", async () => {
    // Bob writes a well-formed record naming Alice's key. The id even matches
    // her fingerprint — but he, not she, signed `doc_create`.
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const aliceFingerprint = await fingerprintPublicKeyPem(
      alice.user.userSigningKeyPair.publicKey,
      subtle,
    );
    const squattedId = `${peerDeviceDocumentId(aliceFingerprint)}_spoof`;
    const spoofed = await writeRawPeerDeviceDoc(bobDb, squattedId, {
      irohEndpointId: "ff".repeat(32),
      signingPublicKey: alice.user.userSigningKeyPair.publicKey,
      label: "Not really Alice",
    });

    await expect(
      verifyPeerDeviceRecord({
        db: bobDb,
        directory: await directoryOf(bob),
        doc: spoofed,
        subtle,
      }),
    ).resolves.toBeNull();

    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const aliceDb = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const records = await listPeerDeviceRecords({
      db: aliceDb,
      directory: await directoryOf(alice),
      subtle,
    });
    expect(records.some((record) => record.irohEndpointId === "ff".repeat(32))).toBe(false);
  });

  it("discards a record whose id does not match the key it names", async () => {
    // Bob signs his own record correctly but files it under a made-up id, so
    // the id can no longer be used to look a device up by fingerprint.
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const mismatched = await writeRawPeerDeviceDoc(bobDb, "dev_0000000000000000", {
      irohEndpointId: "cc".repeat(32),
      signingPublicKey: bob.user.userSigningKeyPair.publicKey,
    });

    await expect(
      verifyPeerDeviceRecord({
        db: bobDb,
        directory: await directoryOf(bob),
        doc: mismatched,
        subtle,
      }),
    ).resolves.toBeNull();
  });

  it("refuses a delete from another person", async () => {
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    const aliceFingerprint = await fingerprintPublicKeyPem(
      alice.user.userSigningKeyPair.publicKey,
      subtle,
    );
    await expect(bobDb.deleteDocument(peerDeviceDocumentId(aliceFingerprint))).rejects.toThrow(
      /only the owning person or the admin can delete a personal document/,
    );
  });

  it("lets a device withdraw its own record", async () => {
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    await publishPeerDeviceRecord({
      db: bobDb,
      signingPublicKey: bob.user.userSigningKeyPair.publicKey,
      irohEndpointId: BOB_ENDPOINT,
      label: "Bob desk",
      subtle,
    });
    await removePeerDeviceRecord({
      db: bobDb,
      signingPublicKey: bob.user.userSigningKeyPair.publicKey,
      subtle,
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const aliceDb = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const records = await listPeerDeviceRecords({
      db: aliceDb,
      directory: await directoryOf(alice),
      subtle,
    });
    expect(records.some((record) => record.irohEndpointId === BOB_ENDPOINT)).toBe(false);
  });
});
