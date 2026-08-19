import {
  addDevice,
  addPerson,
  makeTenant,
  revokeDevice,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { currentUserKeyEpoch, fingerprintEncryptionPublicKey } from "../core/userkeys";

/**
 * The forward-cutoff contract of docs/userkeys.md: an approved device really
 * holds the User-Key private half, removing a device from `grantaccess` drops
 * its wraps without rotating on its own, and an explicit rotation excludes the
 * removed device from the new generation while keeping the retired one
 * readable for the devices that stayed.
 */
describe("userkey device removal and rotation", () => {
  jest.setTimeout(240000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;
  let alice2: DeviceHandle;
  let alice2Fingerprint: string;
  let alice1Fingerprint: string;
  /** Epoch both devices were enrolled in, captured before any rotation. */
  let enrolledEpoch: string;
  /** The private bytes of `enrolledEpoch`, as seen by the minting device. */
  let enrolledBytes: Uint8Array;

  const fingerprintOf = (device: DeviceHandle): Promise<string> =>
    fingerprintEncryptionPublicKey(
      device.user.userEncryptionKeyPair.publicKey,
      fixture.crypto.getSubtle(),
    );

  const ownDocument = async (device: DeviceHandle) => {
    const resolved = await device.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    if (!resolved) throw new Error(`no user-key document for ${device.label}`);
    return resolved;
  };

  const privateBytes = async (device: DeviceHandle): Promise<Uint8Array> => {
    const bytes = await device.tenant.getUserKeyManager().getDecryptedUserKeyBytes();
    if (!bytes) throw new Error(`${device.label} holds no User-Key private bytes`);
    return bytes;
  };

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-userkey-removal" });

    // Device 1 mints the person's User-Key.
    alice1 = await addPerson(fixture, "alice", "laptop");
    await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    // Device 2 joins the grant after the document exists, so it is pending
    // until device 1 approves it explicitly.
    alice2 = await addDevice(fixture, alice1, "phone");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();

    alice1Fingerprint = await fingerprintOf(alice1);
    alice2Fingerprint = await fingerprintOf(alice2);
  });

  it("a device on the grant stays without the User-Key until it is approved", async () => {
    const pending = await alice1.tenant.listPendingUserKeyDevices!();
    expect(pending.map((entry) => entry.fingerprint)).toContain(alice2Fingerprint);

    alice2.tenant.noteUserDirectoryFetched!();
    const waiting = await alice2.tenant.reconcileUserKeys!();
    expect(waiting.state).toBe("waiting");

    // Grant membership alone never produces a wrap.
    const doc = await ownDocument(alice1);
    const wrapped = Object.values(doc.payload.userKeys).flatMap((generation) =>
      Object.keys(generation.deviceWraps ?? {}),
    );
    expect(wrapped).not.toContain(alice2Fingerprint);
  });

  it("approval on the enrolled device hands the new device the same private half", async () => {
    await alice1.tenant.approveUserKeyDevice!(alice2Fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    alice2.tenant.noteUserDirectoryFetched!();
    const approved = await alice2.tenant.reconcileUserKeys!();
    expect(approved.state).toBe("approved");

    const doc = await ownDocument(alice1);
    enrolledEpoch = currentUserKeyEpoch(doc.payload)!;
    enrolledBytes = await privateBytes(alice1);

    // The published pair is now openable on device 2, and it is the very same
    // key -- not a second pair this device minted for itself.
    expect(alice2.user.userKeyPair!.publicKey).toBe(doc.payload.userKeys[enrolledEpoch].publicKey);
    expect(Buffer.from(await privateBytes(alice2))).toEqual(Buffer.from(enrolledBytes));
  });

  it("removing the device from grantaccess drops its wraps but does not rotate by itself", async () => {
    await revokeDevice(fixture, alice1.username, alice2.user.userSigningKeyPair.publicKey);
    await syncAll(fixture, "directory");
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.reconcileUserKeys!();

    const doc = await ownDocument(alice1);
    // Hygiene: the wrap is gone from *every* generation, not just the newest.
    for (const generation of Object.values(doc.payload.userKeys)) {
      expect(Object.keys(generation.deviceWraps ?? {})).not.toContain(alice2Fingerprint);
    }
    expect(Object.keys(doc.payload.userKeys[enrolledEpoch].deviceWraps)).toContain(
      alice1Fingerprint,
    );

    // Removal is not revocation: no new generation appears on its own, and the
    // removed device still holds the bytes it already unwrapped.
    expect(currentUserKeyEpoch(doc.payload)).toBe(enrolledEpoch);
    expect(Buffer.from(await privateBytes(alice2))).toEqual(Buffer.from(enrolledBytes));
  });

  it("rotation excludes the removed device from the new generation", async () => {
    await alice1.tenant.rotateUserKey!();
    const doc = await ownDocument(alice1);
    const rotatedEpoch = currentUserKeyEpoch(doc.payload)!;

    expect(BigInt(rotatedEpoch) > BigInt(enrolledEpoch)).toBe(true);
    expect(doc.payload.userKeys[enrolledEpoch].retiredAt).toBeGreaterThan(0);

    // Only the device that stayed is addressed by the new generation.
    expect(Object.keys(doc.payload.userKeys[rotatedEpoch].deviceWraps)).toEqual([
      alice1Fingerprint,
    ]);

    // The retired generation survives with its remaining wrap, so the devices
    // that stayed keep reading everything sealed to the old public key.
    expect(Object.keys(doc.payload.userKeys[enrolledEpoch].deviceWraps)).toEqual([
      alice1Fingerprint,
    ]);
    const openable = await alice1.tenant
      .getUserKeyManager()
      .getUserKeyCryptoKeysForReconcile();
    expect(openable.length).toBeGreaterThanOrEqual(2);
  });

  it("the removed device cannot obtain the rotated generation", async () => {
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice2.tenant.noteUserDirectoryFetched!();
    await alice2.tenant.reconcileUserKeys!();

    const doc = await ownDocument(alice1);
    const rotatedEpoch = currentUserKeyEpoch(doc.payload)!;
    const rotatedPublicKey = doc.payload.userKeys[rotatedEpoch].publicKey;
    const rotatedBytes = await privateBytes(alice1);

    // Device 2 can see the rotated document -- it just cannot open the new
    // generation, so it is stuck on the one it was enrolled in.
    const seenByRemoved = await ownDocument(alice2);
    expect(currentUserKeyEpoch(seenByRemoved.payload)).toBe(rotatedEpoch);
    expect(alice2.user.userKeyPair!.publicKey).not.toBe(rotatedPublicKey);
    expect(alice2.user.userKeyPair!.publicKey).toBe(
      doc.payload.userKeys[enrolledEpoch].publicKey,
    );

    const heldByRemoved = await privateBytes(alice2);
    expect(Buffer.from(heldByRemoved)).toEqual(Buffer.from(enrolledBytes));
    expect(Buffer.from(heldByRemoved)).not.toEqual(Buffer.from(rotatedBytes));

    // Anything addressed to the current published User-Key from here on is
    // wrapped to a fingerprint the removed device cannot open.
    const published = await alice1.tenant
      .getUserKeyManager()
      .publishedUserKeyFor(alice1.username);
    expect(published!.fingerprint).toBe(doc.payload.userKeys[rotatedEpoch].fingerprint);
    expect(published!.fingerprint).not.toBe(doc.payload.userKeys[enrolledEpoch].fingerprint);
  });
});
