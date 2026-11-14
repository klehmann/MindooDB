import {
  addDevice,
  addPerson,
  IsolatedInMemoryStoreFactory,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, USER_DIRECTORY_DB_ID } from "../core/types";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";
import { fingerprintPublicKeyPem } from "../core/userkeys/fingerprint";
import { generateSelfGrantKeyPair, ed25519FromPkcs8 } from "../core/userkeys/generationSignature";
import { signDeviceCertificate, deviceCertificateDocId } from "../core/userkeys/deviceCertificate";

/**
 * docs/userkeys.md §9.6: a person with device self-grant certifies further
 * devices themselves; everybody resolves those devices to the person.
 */

async function hostDirectory(fixture: MultiDeviceFixture): Promise<BaseMindooTenantDirectory> {
  return (await fixture.host.tenant.openDirectory()) as BaseMindooTenantDirectory;
}

/** A device of `existing`'s person that is NOT on the grant. */
async function newUncertifiedDevice(
  fixture: MultiDeviceFixture,
  existing: DeviceHandle,
  label: string,
): Promise<DeviceHandle> {
  const storeFactory = new IsolatedInMemoryStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, fixture.crypto);
  const password = `${label}-pass-123`;
  const user = await factory.createUserId(existing.user.username, password);
  const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, password, fixture.crypto);
  for (const keyId of [PUBLIC_INFOS_KEY_ID, DEFAULT_TENANT_KEY_ID]) {
    await keyBag.set("doc", fixture.tenantId, keyId, (await fixture.host.keyBag.get("doc", fixture.tenantId, keyId))!);
  }
  const tenant = await factory.openTenant(
    fixture.tenantId,
    fixture.adminUser.userSigningKeyPair.publicKey,
    fixture.adminUser.userEncryptionKeyPair.publicKey,
    user,
    password,
    keyBag,
  );
  const handle: DeviceHandle = {
    label,
    username: existing.username,
    user,
    password,
    tenant,
    factory,
    storeFactory,
    keyBag,
  };
  fixture.devices.push(handle);
  return handle;
}

function keysOf(device: DeviceHandle) {
  return {
    signingPublicKey: device.user.userSigningKeyPair.publicKey,
    encryptionPublicKey: device.user.userEncryptionKeyPair.publicKey,
  };
}

async function setup(tenantId: string, opts?: { selfGrant?: boolean }) {
  const fixture = await makeTenant({ tenantId });
  const alice1 = await addPerson(fixture, "alice", "laptop");
  await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
  await syncAll(fixture, "directory");
  alice1.tenant.noteUserDirectoryFetched!();
  await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: true });
  await syncAll(fixture, USER_DIRECTORY_DB_ID);
  const directory = await hostDirectory(fixture);
  if (opts?.selfGrant !== false) {
    await directory.setDeviceSelfGrant(
      alice1.username,
      await alice1.tenant.getDeviceSelfGrantPublicKey!(),
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    await syncAll(fixture, "directory");
  }
  return { fixture, alice1, directory };
}

describe("device certificates", () => {
  jest.setTimeout(240000);

  it("lets a certified device act, read and sync for its person", async () => {
    const { fixture, alice1, directory } = await setup("tenant-dcert-basic");
    const tablet = await newUncertifiedDevice(fixture, alice1, "tablet");
    const tabletKey = tablet.user.userSigningKeyPair.publicKey;
    expect(await directory.resolveSignerToGrant(tabletKey, Number.MAX_SAFE_INTEGER)).toBeNull();

    const issued = await alice1.tenant.issueDeviceCertificate!(keysOf(tablet), "tablet");
    const fp = await fingerprintPublicKeyPem(tabletKey, fixture.crypto.getSubtle());
    expect(issued.docId).toBe(deviceCertificateDocId(fp));
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const resolved = await directory.resolveSignerToGrant(tabletKey, Number.MAX_SAFE_INTEGER);
    expect(resolved?.via).toBe("certificate");
    const aliceHash = await directory.resolveUsernameHashForSigningKey(
      alice1.user.userSigningKeyPair.publicKey,
      Number.MAX_SAFE_INTEGER,
    );
    expect(resolved?.grant.usernameHash).toBe(aliceHash);
    expect(await directory.validatePublicSigningKey(tabletKey)).toBe(true);
    expect((await directory.getUserBySigningPublicKey(tabletKey))?.username).toBe(alice1.username);
    expect((await directory.getUserSigningKeyUniverse(alice1.username)).active).toContain(tabletKey);
    expect(
      await directory.isSamePerson({
        creatorSigningKey: alice1.user.userSigningKeyPair.publicKey,
        signerSigningKey: tabletKey,
        creatorTrustedTime: Number.MAX_SAFE_INTEGER,
        signerTrustedTime: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);

    // The tablet received Alice's User-Key and self-grant key with the certificate.
    tablet.tenant.noteUserDirectoryFetched!();
    await tablet.tenant.reconcileUserKeys!();
    const published = await fixture.host.tenant.getUserKeyManager().publishedUserKeyFor(alice1.username);
    expect(tablet.user.userKeyPair?.publicKey).toBe(published?.publicKey);
    expect(await tablet.tenant.getDeviceSelfGrantPublicKey!()).toBe(
      await alice1.tenant.getDeviceSelfGrantPublicKey!(),
    );

    // It writes, and everybody accepts the entry.
    const tabletDb = await tablet.tenant.openDB("notes");
    const note = await tabletDb.createDocument({ initialValues: { title: "from the tablet" } });
    await syncAll(fixture, "notes");
    const hostDb = await fixture.host.tenant.openDB("notes");
    expect((await hostDb.getDocument(note.getId())).getData().title).toBe("from the tablet");

    // Its own personal mailbox database counts as the owner's.
    const grantDocId = (await directory.findGrantAccessDocuments(alice1.username))[0].getId();
    const access = await directory.evaluatePersonalDatabaseAccess({
      dbid: `mmail_${grantDocId}`,
      signingKey: tabletKey,
    });
    expect(access?.mode).toBe("read");
  });

  it("refuses to certify without a granted self-grant key and ignores forged certificates", async () => {
    const { fixture, alice1, directory } = await setup("tenant-dcert-forged", { selfGrant: false });
    const tablet = await newUncertifiedDevice(fixture, alice1, "tablet");
    await expect(alice1.tenant.issueDeviceCertificate!(keysOf(tablet), "tablet")).rejects.toThrow(
      /not granted device self-grant/,
    );

    // The admin grants self-grant afterwards. A device on Alice's grant that
    // never received her self-grant key signs a certificate with its own key.
    await directory.setDeviceSelfGrant(
      alice1.username,
      await alice1.tenant.getDeviceSelfGrantPublicKey!(),
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    const planted = await addDevice(fixture, alice1, "planted");
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const ownKey = await generateSelfGrantKeyPair(fixture.crypto);
    const signer = await ed25519FromPkcs8(fixture.crypto, ownKey.privateKeyBytes);
    const aliceHash = (await directory.resolveUsernameHashForSigningKey(
      alice1.user.userSigningKeyPair.publicKey,
      Number.MAX_SAFE_INTEGER,
    ))!;
    const forged = await signDeviceCertificate(fixture.crypto, signer.privateKey, {
      username_hash: aliceHash,
      ...{ deviceSigningPublicKey: tablet.user.userSigningKeyPair.publicKey },
      deviceEncryptionPublicKey: tablet.user.userEncryptionKeyPair.publicKey,
      issuedAt: Date.now(),
      issuedBySigningPublicKey: planted.user.userSigningKeyPair.publicKey,
      selfGrantPublicKey: signer.publicKeyPem,
    });
    const plantedDb = await planted.tenant.openDB(USER_DIRECTORY_DB_ID);
    await plantedDb.createDocument({
      id: "dcert_forged",
      assumeUniqueId: true,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: forged as unknown as Record<string, unknown>,
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect(
      await directory.resolveSignerToGrant(tablet.user.userSigningKeyPair.publicKey, Number.MAX_SAFE_INTEGER),
    ).toBeNull();
    expect(await directory.validatePublicSigningKey(tablet.user.userSigningKeyPair.publicKey)).toBe(false);
  });

  it("stops counting a certified device the admin revokes, and can wipe it", async () => {
    const { fixture, alice1, directory } = await setup("tenant-dcert-revoke");
    const tablet = await newUncertifiedDevice(fixture, alice1, "tablet");
    const tabletKey = tablet.user.userSigningKeyPair.publicKey;
    await alice1.tenant.issueDeviceCertificate!(keysOf(tablet), "tablet");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect(await directory.resolveSignerToGrant(tabletKey, Number.MAX_SAFE_INTEGER)).not.toBeNull();

    await directory.updateUserGrant(
      alice1.username,
      { revokeSigningKeys: [tabletKey], wipeSigningKeys: [tabletKey] },
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    expect(await directory.resolveSignerToGrant(tabletKey, Number.MAX_SAFE_INTEGER)).toBeNull();
    const universe = await directory.getUserSigningKeyUniverse(alice1.username);
    expect(universe.active).not.toContain(tabletKey);
    expect(universe.wipeRequested).toContain(tabletKey);
    expect(await directory.getWipeGrantDocId(tabletKey)).not.toBeNull();
    // The person is still known for the key, so the device can be told to wipe.
    expect((await directory.getUserBySigningPublicKey(tabletKey))?.username).toBe(alice1.username);
    // The grant itself still lists only Alice's real device.
    const overview = await directory.getUserGrantOverview(alice1.username);
    expect(overview.activeDevices.map((d) => d.signingPublicKey)).toEqual([
      alice1.user.userSigningKeyPair.publicKey,
    ]);
  });

  it("keeps certificates issued before the self-grant was revoked, and stops new ones", async () => {
    const { fixture, alice1, directory } = await setup("tenant-dcert-selfgrant-revoke");
    const tablet = await newUncertifiedDevice(fixture, alice1, "tablet");
    const { docId } = await alice1.tenant.issueDeviceCertificate!(keysOf(tablet), "tablet");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    // A server witnesses the certificate before the revocation. Unwitnessed,
    // its trusted time would float to "now", after the revocation.
    const hostStore = (await fixture.host.tenant.openDB(USER_DIRECTORY_DB_ID)).getStore();
    const [create] = (await hostStore.findNewEntriesForDoc([], docId)).filter(
      (m) => m.entryType === "doc_create",
    );
    await hostStore.applyWitnessReceipts!([
      { ...create, receivedAt: Date.now() - 1000, receivedByPublicKey: "test-witness" },
    ]);

    await directory.setDeviceSelfGrant(
      alice1.username,
      null,
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    await syncAll(fixture, "directory");
    expect(
      await directory.resolveSignerToGrant(tablet.user.userSigningKeyPair.publicKey, Number.MAX_SAFE_INTEGER),
    ).not.toBeNull();

    const phone = await newUncertifiedDevice(fixture, alice1, "phone");
    await expect(alice1.tenant.issueDeviceCertificate!(keysOf(phone), "phone")).rejects.toThrow();
  });

  it("lets the person withdraw a certificate", async () => {
    const { fixture, alice1, directory } = await setup("tenant-dcert-withdraw");
    const tablet = await newUncertifiedDevice(fixture, alice1, "tablet");
    const tabletKey = tablet.user.userSigningKeyPair.publicKey;
    await alice1.tenant.issueDeviceCertificate!(keysOf(tablet), "tablet");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const certs = await alice1.tenant.listOwnDeviceCertificates!();
    expect(certs).toHaveLength(1);

    await alice1.tenant.revokeOwnDeviceCertificate!(certs[0].fingerprint);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect(await directory.resolveSignerToGrant(tabletKey, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(await alice1.tenant.listOwnDeviceCertificates!()).toHaveLength(0);
  });
});
