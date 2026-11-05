import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import {
  CURRENT_STORE_ENTRY_VERSION,
  PUBLIC_INFOS_KEY_ID,
  USER_DIRECTORY_DB_ID,
  type StoreEntry,
} from "../core/types";
import { computeContentHash } from "../core/utils/idGeneration";
import {
  buildEntrySigningBytes,
  entrySignatureFieldsFromEntry,
} from "../core/crypto/EntrySignature";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { isPersonalUserdirectoryDocId } from "../core/builtinDbInvariants";

/**
 * `violatesBuiltinWriteInvariant` is what a device asks before it stores
 * entries a peer delivered. Nothing upstream has checked those entries, so it
 * has to apply the server's rule: only the owning person changes a userkey
 * document. It used to apply the load-path filter instead, which lets a
 * non-admin member's change to someone else's userkey document through
 * because the load path trusts that a server already refused it.
 */
describe("peer ingest applies the server's userdirectory rule", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let bob: DeviceHandle;
  let aliceUserKeyEntries: StoreEntry[];

  async function publishUserKey(device: DeviceHandle): Promise<void> {
    await device.factory.ensureUserKeyPair!(device.user, device.password);
    device.tenant.noteUserDirectoryFetched!();
    await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
  }

  /** A correctly signed entry from `device`, so only the invariant can reject it. */
  async function signAs(
    device: DeviceHandle,
    fields: { entryType: StoreEntry["entryType"]; id: string; docId: string; dependencyIds?: string[] },
  ): Promise<StoreEntry> {
    const subtle = fixture.crypto.getSubtle();
    const encryptedData = new Uint8Array([1, 2, 3]);
    const pkcs8 = await decryptPrivateKey(
      fixture.crypto,
      device.user.userSigningKeyPair.privateKey,
      device.password,
      "signing",
    );
    const privateKey = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    const entry = {
      ...fields,
      contentHash: await computeContentHash(encryptedData, subtle),
      dependencyIds: fields.dependencyIds ?? [],
      createdAt: Date.now(),
      createdByPublicKey: device.user.userSigningKeyPair.publicKey,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      originalSize: encryptedData.length,
      encryptedSize: encryptedData.length,
      signature: new Uint8Array(),
      encryptedData,
      entryVersion: CURRENT_STORE_ENTRY_VERSION,
    } as StoreEntry;
    entry.signature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, privateKey, entry.encryptedData.buffer as ArrayBuffer),
    );
    const metaBytes = buildEntrySigningBytes(entrySignatureFieldsFromEntry(entry));
    entry.metadataSignature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, privateKey, metaBytes.buffer as ArrayBuffer),
    );
    return entry;
  }

  /** Every entry of the userkey document `owner` created, as `reader` holds it. */
  async function userKeyDocEntries(reader: DeviceHandle, owner: DeviceHandle): Promise<StoreEntry[]> {
    const store = (await reader.tenant.openDB(USER_DIRECTORY_DB_ID)).getStore();
    const metas = await store.findNewEntries([]);
    const create = metas.find(
      (meta) =>
        meta.entryType === "doc_create" &&
        meta.createdByPublicKey === owner.user.userSigningKeyPair.publicKey &&
        !isPersonalUserdirectoryDocId(meta.docId),
    );
    expect(create).toBeDefined();
    const ids = metas.filter((meta) => meta.docId === create!.docId).map((meta) => meta.id);
    return store.getEntries(ids);
  }

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-peer-ingest" });
    alice = await addPerson(fixture, "alice", "desktop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await publishUserKey(alice);
    await publishUserKey(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    aliceUserKeyEntries = await userKeyDocEntries(bob, alice);
  });

  it("refuses a member's change to another person's userkey document", async () => {
    const docId = aliceUserKeyEntries[0].docId;
    const forged = await signAs(bob, { entryType: "doc_change", id: "bob-on-alice", docId });
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(db.violatesBuiltinWriteInvariant(forged)).resolves.toBe(true);
  });

  it("admits the owner's own change", async () => {
    const docId = aliceUserKeyEntries[0].docId;
    const own = await signAs(alice, { entryType: "doc_change", id: "alice-own", docId });
    const db = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(db.violatesBuiltinWriteInvariant(own)).resolves.toBe(false);
  });

  it("admits a person's real userkey document, create included", async () => {
    // A fresh device that has never seen Alice's document: the create in the
    // batch is the only thing that names her as owner.
    const carol = await addPerson(fixture, "carol", "laptop");
    await syncAll(fixture, "directory");
    const db = await carol.tenant.openDB(USER_DIRECTORY_DB_ID);
    for (const entry of aliceUserKeyEntries) {
      await expect(db.violatesBuiltinWriteInvariant(entry, aliceUserKeyEntries)).resolves.toBe(false);
    }
  });

  it("refuses a change whose owner cannot be resolved", async () => {
    const orphan = await signAs(bob, { entryType: "doc_change", id: "orphan", docId: "nobody-knows-this" });
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(db.violatesBuiltinWriteInvariant(orphan)).resolves.toBe(true);
  });

  it("refuses a non-admin delete and a non-admin write to directory", async () => {
    const docId = aliceUserKeyEntries[0].docId;
    const del = await signAs(alice, { entryType: "doc_delete", id: "alice-delete", docId });
    const userdir = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(userdir.violatesBuiltinWriteInvariant(del)).resolves.toBe(true);

    const directoryWrite = await signAs(bob, { entryType: "doc_change", id: "bob-dir", docId: "grant" });
    const directory = await bob.tenant.openDB("directory", { adminOnlyDb: true });
    await expect(directory.violatesBuiltinWriteInvariant(directoryWrite)).resolves.toBe(true);
  });
});
