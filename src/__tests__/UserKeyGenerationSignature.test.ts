import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { currentUserKeyEpoch, type UserKeyDocumentPayload } from "../core/userkeys";
import { asUserKeyPayload } from "../core/userkeys/validateUserKeyDocument";
import { replaceUserKeys } from "../core/userkeys/UserKeyDocument";
import { generateRsaOaep3072 } from "../core/crypto/rsaOaep3072";
import { fingerprintPublicKeyPem } from "../core/userkeys/fingerprint";
import {
  deriveGenerationSigningKey,
  signEd25519,
  userKeyGenerationSigningMessage,
} from "../core/userkeys/generationSignature";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { decodeJoinRequestUri } from "../core/uri/joinRequestUri";

/**
 * docs/userkeys.md §8.1 / §9.3: a device that the admin put on Alice's grant
 * but that Alice never approved must not be able to make its own key Alice's
 * current User-Key generation.
 */

interface Scenario {
  fixture: MultiDeviceFixture;
  alice1: DeviceHandle;
  planted: DeviceHandle;
}

async function setup(tenantId: string): Promise<Scenario> {
  const fixture = await makeTenant({ tenantId });
  const alice1 = await addPerson(fixture, "alice", "laptop");
  await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
  await syncAll(fixture, "directory");
  alice1.tenant.noteUserDirectoryFetched!();
  await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
  // The admin plants a device on Alice's grant. Alice never approves it.
  const planted = await addDevice(fixture, alice1, "planted");
  await syncAll(fixture, "directory");
  await syncAll(fixture, USER_DIRECTORY_DB_ID);
  return { fixture, alice1, planted };
}

async function hostDirectory(fixture: MultiDeviceFixture): Promise<BaseMindooTenantDirectory> {
  return (await fixture.host.tenant.openDirectory()) as BaseMindooTenantDirectory;
}

async function rawPayload(device: DeviceHandle, docId: string): Promise<UserKeyDocumentPayload> {
  const db = await device.tenant.openDB(USER_DIRECTORY_DB_ID);
  return asUserKeyPayload((await db.getDocument(docId)).getData())!;
}

/** The planted device writes epoch N+1 with a key pair only it knows. */
async function plantGeneration(
  s: Scenario,
  options?: { signWithOwnKey?: boolean },
): Promise<{ plantedPublicKey: string; epoch: string }> {
  const before = await s.alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
  const plantedDb = await s.planted.tenant.openDB(USER_DIRECTORY_DB_ID);
  const doc = await plantedDb.getDocument(before!.doc.getId());
  const raw = asUserKeyPayload(doc.getData())!;
  const aliceEpoch = currentUserKeyEpoch(raw)!;
  const foreign = await generateRsaOaep3072(s.fixture.crypto);
  const fingerprint = await fingerprintPublicKeyPem(
    foreign.publicKeyPem,
    s.fixture.crypto.getSubtle(),
  );
  const epoch = (BigInt(aliceEpoch) + 1n).toString();
  const gen = { publicKey: foreign.publicKeyPem, fingerprint, createdAt: Date.now() };
  let extra = {};
  if (options?.signWithOwnKey) {
    const own = await deriveGenerationSigningKey(s.fixture.crypto, foreign.privateKeyBytes);
    const message = userKeyGenerationSigningMessage(raw.username_hash, epoch, {
      ...gen,
      signingPublicKey: own.publicKeyPem,
    });
    extra = {
      signingPublicKey: own.publicKeyPem,
      signatures: [
        {
          signerPublicKey: own.publicKeyPem,
          signature: await signEd25519(s.fixture.crypto, own.privateKey, message),
        },
      ],
    };
  }
  await replaceUserKeys(plantedDb, doc, {
    ...raw.userKeys,
    [epoch]: { ...gen, deviceWraps: {}, ...extra },
  });
  await syncAll(s.fixture, USER_DIRECTORY_DB_ID);
  return { plantedPublicKey: foreign.publicKeyPem, epoch };
}

async function publishedForAlice(s: Scenario): Promise<string | undefined> {
  const published = await s.fixture.host.tenant
    .getUserKeyManager()
    .publishedUserKeyFor(s.alice1.username);
  return published?.publicKey;
}

describe("userkey generation signatures", () => {
  jest.setTimeout(180000);

  it("gives the first generation a signing key and gives Alice a self-grant key", async () => {
    const s = await setup("tenant-gensig-basics");
    const resolved = await s.alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const gen = resolved!.payload.userKeys["1"];
    expect(gen.signingPublicKey).toContain("BEGIN PUBLIC KEY");
    expect(s.alice1.user.deviceSelfGrantKeyPair?.publicKey).toContain("BEGIN PUBLIC KEY");
    const ownWrap = Object.values(gen.deviceWraps)[0];
    expect(ownWrap.wrappedSelfGrantKey).toBeTruthy();
    expect(await s.alice1.tenant.getDeviceSelfGrantPublicKey!()).toBe(
      s.alice1.user.deviceSelfGrantKeyPair!.publicKey,
    );
  });

  it("still lets an unsigned generation count when no cutoff applies (backward compatible)", async () => {
    const s = await setup("tenant-gensig-legacy");
    const { plantedPublicKey } = await plantGeneration(s);
    expect(await publishedForAlice(s)).toBe(plantedPublicKey);
  });

  it("ignores an unsigned generation from a device that never held the User-Key once the tenant requires signatures", async () => {
    const s = await setup("tenant-gensig-cutoff");
    const directory = await hostDirectory(s.fixture);
    await directory.requireUserKeyGenerationSignatures(
      s.fixture.adminUser.userSigningKeyPair.privateKey,
      s.fixture.adminPassword,
    );
    await syncAll(s.fixture, "directory");
    const before = await publishedForAlice(s);

    const { epoch } = await plantGeneration(s);
    expect(await publishedForAlice(s)).toBe(before);

    // Alice's own device also keeps her generation as current.
    const resolved = await s.alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(resolved!.rejectedEpochs).toContain(epoch);
    expect(currentUserKeyEpoch(resolved!.payload)).toBe("1");
  });

  it("ignores a planted generation signed with the planted device's own key", async () => {
    const s = await setup("tenant-gensig-selfsigned");
    const directory = await hostDirectory(s.fixture);
    await directory.requireUserKeyGenerationSignatures(
      s.fixture.adminUser.userSigningKeyPair.privateKey,
      s.fixture.adminPassword,
    );
    await syncAll(s.fixture, "directory");
    const before = await publishedForAlice(s);
    await plantGeneration(s, { signWithOwnKey: true });
    expect(await publishedForAlice(s)).toBe(before);
  });

  it("closes the gap per person once the admin grants device self-grant, and Alice can still rotate", async () => {
    const s = await setup("tenant-gensig-selfgrant");
    const directory = await hostDirectory(s.fixture);
    const selfGrantKey = await s.alice1.tenant.getDeviceSelfGrantPublicKey!();
    await directory.setDeviceSelfGrant(
      s.alice1.username,
      selfGrantKey,
      s.fixture.adminUser.userSigningKeyPair.privateKey,
      s.fixture.adminPassword,
    );
    await syncAll(s.fixture, "directory");
    const grant = await directory.getDeviceSelfGrant(s.alice1.username);
    expect(grant?.signingPublicKey).toBe(selfGrantKey);
    const before = await publishedForAlice(s);

    await plantGeneration(s);
    expect(await publishedForAlice(s)).toBe(before);

    // Alice rotates: the new generation is signed and counts everywhere.
    s.alice1.tenant.noteUserDirectoryFetched!();
    await s.alice1.tenant.rotateUserKey!();
    await syncAll(s.fixture, USER_DIRECTORY_DB_ID);
    const after = await s.alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const epoch = currentUserKeyEpoch(after!.payload)!;
    expect(BigInt(epoch)).toBe(3n); // above the planted epoch 2
    const gen = after!.payload.userKeys[epoch];
    expect(gen.signatures?.length).toBeGreaterThanOrEqual(2);
    expect(await publishedForAlice(s)).toBe(gen.publicKey);
    expect(s.alice1.user.userKeyPair!.publicKey).toBe(gen.publicKey);
  });

  it("falls back to the earlier value when a grant device overwrites a generation in place", async () => {
    const s = await setup("tenant-gensig-overwrite");
    const directory = await hostDirectory(s.fixture);
    await directory.requireUserKeyGenerationSignatures(
      s.fixture.adminUser.userSigningKeyPair.privateKey,
      s.fixture.adminPassword,
    );
    await syncAll(s.fixture, "directory");
    const before = await publishedForAlice(s);
    const docId = (await s.alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument())!.doc.getId();

    const plantedDb = await s.planted.tenant.openDB(USER_DIRECTORY_DB_ID);
    const doc = await plantedDb.getDocument(docId);
    const raw = asUserKeyPayload(doc.getData())!;
    const foreign = await generateRsaOaep3072(s.fixture.crypto);
    const own = await deriveGenerationSigningKey(s.fixture.crypto, foreign.privateKeyBytes);
    await replaceUserKeys(plantedDb, doc, {
      "1": {
        ...raw.userKeys["1"],
        publicKey: foreign.publicKeyPem,
        signingPublicKey: own.publicKeyPem,
        signatures: [],
      },
    });
    await syncAll(s.fixture, USER_DIRECTORY_DB_ID);

    expect((await rawPayload(s.fixture.host, docId)).userKeys["1"].publicKey).toBe(
      foreign.publicKeyPem,
    );
    expect(await publishedForAlice(s)).toBe(before);
  });

  it("carries the self-grant key in the join request and names it in the grant on approval", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-gensig-join" });
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), fixture.crypto);
    const joining = await factory.createUserId("CN=carol/O=tenant-gensig-join", "carol-pass-123");
    await factory.ensureUserKeyPair!(joining, "carol-pass-123");
    const uri = factory.createJoinRequest(joining, { label: "carol-laptop", format: "uri" }) as string;
    const request = decodeJoinRequestUri(uri);
    expect(request.deviceSelfGrantPublicKey).toBe(joining.deviceSelfGrantKeyPair!.publicKey);

    await fixture.host.tenant.approveJoinRequest(uri, {
      adminSigningKey: fixture.adminUser.userSigningKeyPair.privateKey,
      adminPassword: fixture.adminPassword,
      label: "carol-laptop",
      allowDeviceSelfGrant: true,
    });
    const directory = await hostDirectory(fixture);
    const grant = await directory.getDeviceSelfGrant(joining.username);
    expect(grant?.signingPublicKey).toBe(joining.deviceSelfGrantKeyPair!.publicKey);
    expect(grant?.revokedAt).toBeUndefined();

    await directory.setDeviceSelfGrant(
      joining.username,
      null,
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    const revoked = await directory.getDeviceSelfGrant(joining.username);
    expect(revoked?.signingPublicKey).toBe(joining.deviceSelfGrantKeyPair!.publicKey);
    expect(revoked?.revokedAt).toBeGreaterThanOrEqual(revoked!.grantedAt);
  });

  it("hands the self-grant key to a device Alice approves, and only to that one", async () => {
    const s = await setup("tenant-gensig-second-device");
    const phone = await addDevice(s.fixture, s.alice1, "phone");
    // Like a real joining device, the phone made its own keys first.
    await phone.factory.ensureUserKeyPair!(phone.user, phone.password);
    const phoneOwnKey = phone.user.deviceSelfGrantKeyPair!.publicKey;
    expect(phoneOwnKey).not.toBe(s.alice1.user.deviceSelfGrantKeyPair!.publicKey);
    await syncAll(s.fixture, "directory");
    await syncAll(s.fixture, USER_DIRECTORY_DB_ID);
    s.alice1.tenant.noteUserDirectoryFetched!();
    await s.alice1.tenant.reconcileUserKeys!();
    const pending = (await s.alice1.tenant.listPendingUserKeyDevices!()).find((p) => p.label === "phone");
    await s.alice1.tenant.approveUserKeyDevice!(pending!.fingerprint);
    await syncAll(s.fixture, USER_DIRECTORY_DB_ID);

    phone.tenant.noteUserDirectoryFetched!();
    await phone.tenant.reconcileUserKeys!();
    expect(await phone.tenant.getDeviceSelfGrantPublicKey!()).toBe(
      s.alice1.user.deviceSelfGrantKeyPair!.publicKey,
    );

    s.planted.tenant.noteUserDirectoryFetched!();
    await s.planted.tenant.reconcileUserKeys!().catch(() => undefined);
    // The planted device generated no key of its own on reconcile and was
    // given none: it never held Alice's User-Key.
    const plantedKey = await s.planted.tenant.getDeviceSelfGrantPublicKey!();
    expect(plantedKey).not.toBe(s.alice1.user.deviceSelfGrantKeyPair!.publicKey);
  });
});
