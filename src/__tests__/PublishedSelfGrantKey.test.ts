import { addPerson, makeTenant, syncAll } from "./_helpers/multiDevice";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import { generateSelfGrantKeyPair, ed25519FromPkcs8 } from "../core/userkeys/generationSignature";
import { publishSelfGrantKeyRecord } from "../core/userkeys/selfGrantKeyRecord";
import { evaluateBuiltinWrite, isPersonalUserdirectoryDocId } from "../core/builtinDbInvariants";

/**
 * docs/userkeys.md §9.4 "Published self-grant keys": a person's device
 * publishes its self-grant key, so the admin allows device self-grant without
 * the key being copied over by hand.
 */

async function setup(tenantId: string) {
  const fixture = await makeTenant({ tenantId });
  const alice = await addPerson(fixture, "alice", "laptop");
  const bob = await addPerson(fixture, "bob", "phone");
  for (const device of [alice, bob]) {
    await device.factory.ensureUserKeyPair!(device.user, device.password);
  }
  await syncAll(fixture, "directory");
  return { fixture, alice, bob };
}

async function reconcile(device: { tenant: { noteUserDirectoryFetched?: () => void; reconcileUserKeys?: (o?: { allowSelfCreate?: boolean }) => Promise<unknown> } }) {
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

describe("published self-grant keys", () => {
  jest.setTimeout(240000);

  it("is a personal userdirectory document", () => {
    expect(isPersonalUserdirectoryDocId("sgk_abc")).toBe(true);
    // A member (no admin) may create their own sgk_ document.
    expect(
      evaluateBuiltinWrite({
        dbId: USER_DIRECTORY_DB_ID,
        op: "doc_create",
        signerKey: "member",
        adminPublicKey: "admin",
        docId: "sgk_abc",
        signerUsernameHash: "h1",
        creatorUsernameHash: "h1",
      }).allowed,
    ).toBe(true);
  });

  it("publishes on reconcile and lets the admin grant it in one step", async () => {
    const { fixture, alice } = await setup("tenant-sgk-basic");
    await reconcile(alice);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const aliceKey = await alice.tenant.getDeviceSelfGrantPublicKey!();
    expect(aliceKey).toBeTruthy();
    const found = await fixture.host.tenant.findPublishedDeviceSelfGrantKey!(alice.username);
    expect(found?.selfGrantPublicKey).toBe(aliceKey);
    expect(found?.deviceSigningPublicKey).toBe(alice.user.userSigningKeyPair.publicKey);

    const directory = (await fixture.host.tenant.openDirectory()) as BaseMindooTenantDirectory;
    await directory.setDeviceSelfGrant(
      alice.username,
      found!.selfGrantPublicKey,
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    await syncAll(fixture, "directory");
    expect((await directory.getDeviceSelfGrant(alice.username))?.signingPublicKey).toBe(aliceKey);

    // Granted: the device does not publish again, and can certify devices.
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const before = (await db.getAllDocumentIds()).length;
    await reconcile(alice);
    expect((await db.getAllDocumentIds()).length).toBe(before);
  });

  it("is idempotent across reconciles", async () => {
    const { alice } = await setup("tenant-sgk-idempotent");
    await reconcile(alice);
    const db = await alice.tenant.openDB(USER_DIRECTORY_DB_ID);
    const sgkIds = async () => (await db.getAllDocumentIds({ idPrefix: "sgk" })).filter((id) => id.startsWith("sgk_"));
    expect(await sgkIds()).toHaveLength(1);
    await reconcile(alice);
    await reconcile(alice);
    expect(await sgkIds()).toHaveLength(1);
  });

  it("ignores a record that names another person's device or a key it does not hold", async () => {
    const { fixture, alice, bob } = await setup("tenant-sgk-forged");
    const bobDb = await bob.tenant.openDB(USER_DIRECTORY_DB_ID);

    // Bob writes a record that claims Alice's device key.
    const stranger = await ed25519FromPkcs8(
      fixture.crypto,
      (await generateSelfGrantKeyPair(fixture.crypto)).privateKeyBytes,
    );
    await bobDb.createDocument({
      idPrefix: "sgk",
      decryptionKeyId: "$publicinfos",
      initialValues: {
        form: "userdirectory",
        type: "selfgrantkey",
        schemaVersion: 1,
        deviceSigningPublicKey: alice.user.userSigningKeyPair.publicKey,
        selfGrantPublicKey: stranger.publicKeyPem,
        publishedAt: Date.now() + 60_000,
        signature: "AAAA",
      },
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    // Alice's own device may have published its honest record already; the
    // forged key must never come out either way.
    const forAlice = await fixture.host.tenant.findPublishedDeviceSelfGrantKey!(alice.username);
    expect(forAlice?.selfGrantPublicKey).not.toBe(stranger.publicKeyPem);

    // A record whose proof of possession was made with a different key.
    const other = await ed25519FromPkcs8(
      fixture.crypto,
      (await generateSelfGrantKeyPair(fixture.crypto)).privateKeyBytes,
    );
    const { docId } = await publishSelfGrantKeyRecord({
      db: bobDb,
      crypto: fixture.crypto,
      tenantId: fixture.tenantId,
      deviceSigningPublicKey: bob.user.userSigningKeyPair.publicKey,
      selfGrant: { privateKey: other.privateKey, publicKeyPem: stranger.publicKeyPem },
    });
    expect(docId.startsWith("sgk_")).toBe(true);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    expect(
      (await fixture.host.tenant.findPublishedDeviceSelfGrantKey!(bob.username))?.selfGrantPublicKey,
    ).not.toBe(stranger.publicKeyPem);

    // Bob's own, honest record still verifies.
    await reconcile(bob);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const honest = await fixture.host.tenant.findPublishedDeviceSelfGrantKey!(bob.username);
    expect(honest?.selfGrantPublicKey).toBe(await bob.tenant.getDeviceSelfGrantPublicKey!());
  });
});
