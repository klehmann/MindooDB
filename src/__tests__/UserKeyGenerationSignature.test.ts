import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { currentUserKeyEpoch } from "../core/userkeys";
import { replaceUserKeys } from "../core/userkeys/UserKeyDocument";
import { generateRsaOaep3072 } from "../core/crypto/rsaOaep3072";
import { fingerprintEncryptionPublicKey } from "../core/userkeys/fingerprint";

/**
 * docs/userkeys.md §8.1: a device that the admin put on Alice's grant but that
 * Alice never approved must not be able to make its own key Alice's current
 * User-Key generation.
 */
describe("userkey generation signatures", () => {
  jest.setTimeout(180000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;
  let planted: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-userkey-gensig" });
    alice1 = await addPerson(fixture, "alice", "laptop");
    await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    // The admin plants a device on Alice's grant. Alice never approves it.
    planted = await addDevice(fixture, alice1, "planted");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
  });

  it("ignores a generation written by a grant device that never held the User-Key", async () => {
    const before = await alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const aliceEpoch = currentUserKeyEpoch(before!.payload)!;
    const alicePublicKey = before!.payload.userKeys[aliceEpoch].publicKey;

    // The planted device opens Alice's document in its own replica and adds
    // epoch N+1 with a key pair only it knows.
    const plantedDb = await planted.tenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await plantedDb.getDocument(before!.doc.getId());
    const foreign = await generateRsaOaep3072(fixture.crypto);
    const foreignFp = await fingerprintEncryptionPublicKey(
      foreign.publicKeyPem,
      fixture.crypto.getSubtle(),
    );
    const nextEpoch = (BigInt(aliceEpoch) + 1n).toString();
    await replaceUserKeys(plantedDb, doc, {
      ...before!.payload.userKeys,
      [nextEpoch]: {
        publicKey: foreign.publicKeyPem,
        fingerprint: foreignFp,
        createdAt: Date.now(),
        deviceWraps: {},
      },
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    // Honest clients (the host here, sealing to Alice) must keep using
    // Alice's own generation.
    const published = await fixture.host.tenant
      .getUserKeyManager()
      .publishedUserKeyFor(alice1.username);
    expect(published?.publicKey).toBe(alicePublicKey);
  });
});
