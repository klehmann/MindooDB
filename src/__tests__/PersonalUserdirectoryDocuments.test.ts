import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import {
  CURRENT_STORE_ENTRY_VERSION,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
  type StoreEntry,
} from "../core/types";
import {
  listPeerDeviceRecords,
  peerDeviceDocumentId,
  publishPeerDeviceRecord,
} from "../core/peerdevices/PeerDeviceDocument";
import { fingerprintPublicKeyPem } from "../core/userkeys/fingerprint";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { NetworkErrorType } from "../core/appendonlystores/network/types";
import type { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { computeContentHash } from "../core/utils/idGeneration";
import {
  buildEntrySigningBytes,
  entrySignatureFieldsFromEntry,
} from "../core/crypto/EntrySignature";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";

/**
 * Personal documents in `userdirectory` (docs/userkeys.md §7.6): the roamed
 * workspace lives there as `wks_<objectid>`, sealed to its owner so no other
 * member can read it, and owned by the person who created it so no other
 * member can overwrite or delete it. Neither property can be expressed with
 * the userkey rule, which reads `username_hash` out of the payload — a sealed
 * payload is opaque to everyone else, the server included.
 */
describe("personal userdirectory documents", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;
  let alice2: DeviceHandle;
  let bob: DeviceHandle;

  async function publishUserKey(device: DeviceHandle): Promise<void> {
    await device.factory.ensureUserKeyPair!(device.user, device.password);
    device.tenant.noteUserDirectoryFetched!();
    await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
  }

  /** A correctly signed entry from `device`, so only the invariant can reject it. */
  async function signAs(
    device: DeviceHandle,
    fields: { entryType: StoreEntry["entryType"]; id: string; docId: string },
  ): Promise<StoreEntry> {
    const crypto = fixture.crypto;
    const subtle = crypto.getSubtle();
    const encryptedData = new Uint8Array([1, 2, 3]);
    const pkcs8 = await decryptPrivateKey(
      crypto,
      device.user.userSigningKeyPair.privateKey,
      device.password,
      "signing",
    );
    const privateKey = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    const entry = {
      ...fields,
      contentHash: await computeContentHash(encryptedData, subtle),
      dependencyIds: [],
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

  async function createWorkspaceDoc(device: DeviceHandle, saveId: string) {
    const db = await device.tenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await db.createDocument({
      idPrefix: "wks",
      recipients: [],
      initialValues: {
        form: "userdata",
        type: "workspace",
        schemaVersion: 1,
        workspacesaveid: saveId,
      },
    });
    return { db, doc };
  }

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-personal-userdir" });
    alice1 = await addPerson(fixture, "alice", "desktop");
    bob = await addPerson(fixture, "bob", "desk");
    await syncAll(fixture, "directory");
    await publishUserKey(alice1);
    await publishUserKey(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    // Alice's phone: a second device of the same person, approved so it holds
    // the same User-Key private half and can therefore open her sealed data.
    alice2 = await addDevice(fixture, alice1, "phone");
    await syncAll(fixture, "directory");
    await alice2.factory.ensureUserKeyPair!(alice2.user, alice2.password);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();
    const pending = (await alice1.tenant.listPendingUserKeyDevices!()).find(
      (candidate) => candidate.label === "phone",
    );
    await alice1.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    await alice2.tenant.reconcileUserKeys!();
  });

  it("roams from one device of a person to another and stays unreadable for everyone else", async () => {
    const { doc } = await createWorkspaceDoc(alice1, "desktop");
    const docId = doc.getId();
    expect(docId.startsWith("wks_")).toBe(true);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const phoneDb = await alice2.tenant.openDB(USER_DIRECTORY_DB_ID);
    const onPhone = await phoneDb.getDocument(docId);
    expect(onPhone.getData().workspacesaveid).toBe("desktop");
    await phoneDb.changeDoc(onPhone, (d) => {
      d.getData().tabs = { tab1: { name: "Workspace 1", order: 1 } };
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const desktopDb = await alice1.tenant.openDB(USER_DIRECTORY_DB_ID);
    const backOnDesktop = await desktopDb.getDocument(docId);
    expect((backOnDesktop.getData().tabs as Record<string, { name: string }>).tab1.name).toBe(
      "Workspace 1",
    );

    // Bob syncs the bytes like every member but holds no wrap for them.
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    await expect(bobDb.getDocument(docId)).rejects.toThrow();
  });

  it("refuses a change from another person", async () => {
    const { doc } = await createWorkspaceDoc(alice1, "shared");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
    // Bob cannot even materialize it, so he forges the write gate directly by
    // asking to delete — the operation that needs no plaintext.
    await expect(bobDb.deleteDocument(doc.getId())).rejects.toThrow(
      /only the owning person or the admin can delete a personal document/,
    );
  });

  it("lets the owner delete their own document, unlike a userkey document", async () => {
    const { db, doc } = await createWorkspaceDoc(alice1, "throwaway");
    await expect(db.deleteDocument(doc.getId())).resolves.toBeUndefined();
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    // The load path must let the owner's own tombstone through: the userkey
    // rule drops every non-admin delete, which would resurrect it here.
    const phoneDb = await alice2.tenant.openDB(USER_DIRECTORY_DB_ID);
    const ids = await phoneDb.getAllDocumentIds();
    expect(ids).not.toContain(doc.getId());
  });

  /**
   * Peer-device records are the one personal document that is deliberately
   * *not* sealed: it names an Iroh endpoint, which every member needs in order
   * to dial the device, while the hoster has no business knowing who talks to
   * whom. Encrypting with the tenant `default` key gives exactly that split —
   * and because the invariant keys off the id prefix rather than the
   * encryption, the ownership rule is unchanged.
   */
  describe("peer-device records under the tenant default key", () => {
    const endpointId = "c".repeat(64);

    it("is readable by another member but still only writable by its owner", async () => {
      const aliceDb = await alice1.tenant.openDB(USER_DIRECTORY_DB_ID);
      await publishPeerDeviceRecord({
        db: aliceDb,
        signingPublicKey: alice1.user.userSigningKeyPair.publicKey,
        irohEndpointId: endpointId,
        label: "desktop",
        subtle: fixture.crypto.getSubtle(),
      });
      await syncAll(fixture, USER_DIRECTORY_DB_ID);

      // Bob is a different person, not another device of Alice. He could not
      // read her sealed `wks_` document above; this one he can.
      const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
      const docId = peerDeviceDocumentId(
        await fingerprintPublicKeyPem(
          alice1.user.userSigningKeyPair.publicKey,
          fixture.crypto.getSubtle(),
        ),
      );
      const onBob = await bobDb.getDocument(docId);
      expect(onBob.getData().irohEndpointId).toBe(endpointId);

      // Readable is not writable: the personal-document invariant still binds
      // the record to the device that created it.
      await expect(
        bobDb.changeDoc(onBob, (d) => {
          d.getData().irohEndpointId = "d".repeat(64);
        }),
      ).rejects.toThrow();
    });

    it("travels under the tenant key, which the hoster never holds", async () => {
      // What keeps who-dials-whom away from the hoster is the key the entries
      // are sealed with. A server only ever holds `$publicinfos`; `default` is
      // distributed to members and never leaves the tenant. Asserting on the
      // wire format rather than on a read, because every party in this fixture
      // is a tenant member and therefore legitimately holds `default`.
      const aliceDb = await alice1.tenant.openDB(USER_DIRECTORY_DB_ID);
      const docId = peerDeviceDocumentId(
        await fingerprintPublicKeyPem(
          alice1.user.userSigningKeyPair.publicKey,
          fixture.crypto.getSubtle(),
        ),
      );
      const ids = await aliceDb.getStore().getAllIds();
      const entries = await aliceDb.getStore().getEntries(ids);
      const deviceEntries = entries.filter((entry) => entry.docId === docId);
      expect(deviceEntries.length).toBeGreaterThan(0);
      for (const entry of deviceEntries) {
        expect(entry.decryptionKeyId).toBe(DEFAULT_TENANT_KEY_ID);
        expect(entry.decryptionKeyId).not.toBe(PUBLIC_INFOS_KEY_ID);
      }
    });

    it("only counts when the creator owns the key it names", async () => {
      // Bob publishes a record under his own id but naming Alice's key — the
      // shape of an attempt to claim her device. Verification has to drop it.
      const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);
      const spoofId = peerDeviceDocumentId(
        await fingerprintPublicKeyPem(
          bob.user.userSigningKeyPair.publicKey,
          fixture.crypto.getSubtle(),
        ),
      );
      const spoof = await bobDb.createDocument({
        id: spoofId,
        decryptionKeyId: DEFAULT_TENANT_KEY_ID,
      });
      await bobDb.changeDoc(spoof, (d) => {
        const data = d.getData() as unknown as Record<string, unknown>;
        data.type = "peerdevice";
        data.irohEndpointId = "e".repeat(64);
        data.signingPublicKey = alice1.user.userSigningKeyPair.publicKey;
        data.updatedAt = Date.now();
      });
      await syncAll(fixture, USER_DIRECTORY_DB_ID);

      const aliceDb = await alice1.tenant.openDB(USER_DIRECTORY_DB_ID);
      const records = await listPeerDeviceRecords({
        db: aliceDb,
        directory: await alice1.tenant.openDirectory(),
        subtle: fixture.crypto.getSubtle(),
      });
      expect(records.map((record) => record.docId)).not.toContain(spoofId);
      // Alice's own record is untouched by the attempt.
      expect(records.map((record) => record.irohEndpointId)).toContain(endpointId);
    });
  });

  it("passes server ingest even though the server cannot decrypt it", async () => {
    const { db, doc } = await createWorkspaceDoc(alice1, "onserver");
    await db.changeDoc(doc, (d) => {
      d.getData().tabs = { tab1: { name: "First", order: 1 } };
    });

    const serverStore = new InMemoryContentAddressedStore(USER_DIRECTORY_DB_ID, StoreKind.docs);
    const directory = await fixture.host.tenant.openDirectory();
    const server = new ServerNetworkContentAddressedStore(
      serverStore,
      directory,
      {
        validateToken: async () => ({
          sub: alice1.username,
          iat: 0,
          exp: 0,
          tenantId: fixture.tenantId,
        }),
      } as unknown as AuthenticationService,
      new NodeCryptoAdapter(),
      undefined,
      {
        witnessDbid: USER_DIRECTORY_DB_ID,
        builtinWriteContext: {
          adminPublicKey: fixture.adminUser.userSigningKeyPair.publicKey,
          // No `resolveDocumentUsernameHash`: a sealed payload gives the server
          // nothing, which is exactly the situation this rule exists for.
          resolveCreatorSigningKey: async (entry: StoreEntry) => {
            const metas = await serverStore.findNewEntriesForDoc([], entry.docId);
            const create = metas.find((meta) => meta.entryType === "doc_create");
            if (!create) return null;
            const [loaded] = await serverStore.getEntries([create.id]);
            return loaded?.createdByPublicKey ?? null;
          },
        },
      },
    );

    const ownStore = (await alice1.tenant.openDB(USER_DIRECTORY_DB_ID)).getStore();
    const metas = await ownStore.findNewEntriesForDoc([], doc.getId());
    const entries = await ownStore.getEntries(metas.map((meta) => meta.id));
    await expect(server.handlePutEntries("token", entries)).resolves.toBeDefined();

    // Bob is a member and signs correctly, but the document is not his: the
    // server rejects his delete without ever looking inside it.
    const forged = await signAs(bob, {
      entryType: "doc_delete",
      id: `${doc.getId()}_x_forged_bob`,
      docId: doc.getId(),
    });
    const ack = await server.handlePutEntries("token", [forged]);
    expect(ack.receipts).toHaveLength(0);
    expect(ack.rejected).toEqual([
      {
        id: forged.id,
        reason: expect.stringContaining("only the owning person or the admin can delete"),
        rejectionClass: "policy",
      },
    ]);
  });
});
